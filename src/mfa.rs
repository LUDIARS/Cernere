//! 多要素認証 (MFA) モジュール
//!
//! - TOTP: Google Authenticator / Microsoft Authenticator 対応
//! - SMS: AWS SNS 経由の OTP 送信
//! - Email: AWS SES 経由のコード送信

use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Json;
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use rand::Rng;
use serde::Deserialize;
use totp_rs::{Algorithm, Secret, TOTP};
use uuid::Uuid;

use crate::app_state::AppState;
use crate::auth::extract_user_from_jwt;
use crate::error::{AppError, Result};
use crate::models::{MfaChallengeResponse, MfaClaims, TokenResponse, UserResponse};
use crate::db;

const OTP_LENGTH: usize = 6;
const OTP_EXPIRY_MINUTES: i64 = 5;
const MFA_TOKEN_MINUTES: i64 = 10;

// ── OTP 生成 ────────────────────────────────────────

fn generate_otp() -> String {
    let mut rng = rand::thread_rng();
    let code: u32 = rng.gen_range(0..1_000_000);
    format!("{:06}", code)
}

// ── TOTP ヘルパー ───────────────────────────────────

fn create_totp(secret: &str, app_name: &str, account: &str) -> Result<TOTP> {
    let secret_bytes = Secret::Encoded(secret.to_string())
        .to_bytes()
        .map_err(|e| AppError::Internal(format!("Invalid TOTP secret: {}", e)))?;
    TOTP::new(
        Algorithm::SHA1,
        6,
        1,
        30,
        secret_bytes,
        Some(app_name.to_string()),
        account.to_string(),
    )
    .map_err(|e| AppError::Internal(format!("TOTP creation failed: {}", e)))
}

fn generate_totp_secret() -> String {
    Secret::generate_secret().to_encoded().to_string()
}

// ── MFA トークン (一時的な認証チャレンジ用) ─────────

fn generate_mfa_token(user_id: &Uuid, secret: &str) -> Result<String> {
    let now = Utc::now();
    let claims = MfaClaims {
        sub: user_id.to_string(),
        purpose: "mfa_challenge".into(),
        iat: now.timestamp() as usize,
        exp: (now + Duration::minutes(MFA_TOKEN_MINUTES)).timestamp() as usize,
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| AppError::Internal(format!("MFA token encode failed: {}", e)))
}

pub fn verify_mfa_token(token: &str, secret: &str) -> Result<Uuid> {
    let mut validation = Validation::default();
    validation.set_required_spec_claims(&["sub", "exp", "iat"]);
    let data = decode::<MfaClaims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .map_err(|e| AppError::Unauthorized(format!("Invalid MFA token: {}", e)))?;

    if data.claims.purpose != "mfa_challenge" {
        return Err(AppError::Unauthorized("Invalid token purpose".into()));
    }

    data.claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid user ID in MFA token".into()))
}

// ── SMS 送信 (AWS SNS) ─────────────────────────────

async fn send_sms(state: &AppState, phone_number: &str, message: &str) -> Result<()> {
    let client = state
        .sns_client
        .as_ref()
        .ok_or_else(|| AppError::BadRequest("SMS is not configured".into()))?;

    client
        .publish()
        .phone_number(phone_number)
        .message(message)
        .send()
        .await
        .map_err(|e| AppError::External(format!("SMS send failed: {}", e)))?;

    Ok(())
}

// ── メール送信 (AWS SES) ───────────────────────────

async fn send_email(
    state: &AppState,
    to: &str,
    subject: &str,
    body: &str,
) -> Result<()> {
    let client = state
        .ses_client
        .as_ref()
        .ok_or_else(|| AppError::BadRequest("Email sending is not configured".into()))?;

    use aws_sdk_sesv2::types::{Body, Content, Destination, EmailContent, Message};

    let dest = Destination::builder().to_addresses(to).build();
    let subject_content = Content::builder().data(subject).charset("UTF-8").build()
        .map_err(|e| AppError::Internal(format!("SES content build failed: {}", e)))?;
    let body_content = Content::builder().data(body).charset("UTF-8").build()
        .map_err(|e| AppError::Internal(format!("SES content build failed: {}", e)))?;
    let message = Message::builder()
        .subject(subject_content)
        .body(Body::builder().text(body_content).build())
        .build();
    let email_content = EmailContent::builder().simple(message).build();

    client
        .send_email()
        .from_email_address(&state.config.aws_ses_from_email)
        .destination(dest)
        .content(email_content)
        .send()
        .await
        .map_err(|e| AppError::External(format!("Email send failed: {}", e)))?;

    Ok(())
}

// ── MFA チャレンジ生成 (ログイン時に呼ばれる) ──────

pub async fn create_mfa_challenge(
    state: &AppState,
    user_id: &Uuid,
    mfa_methods: &[String],
) -> Result<MfaChallengeResponse> {
    let mfa_token = generate_mfa_token(user_id, &state.config.jwt_secret)?;

    Ok(MfaChallengeResponse {
        mfa_required: true,
        mfa_token,
        mfa_methods: mfa_methods.to_vec(),
    })
}

// ── API ハンドラー ──────────────────────────────────

// -- TOTP セットアップ

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TotpSetupResponse {
    pub secret: String,
    pub provisioning_uri: String,
}

/// POST /api/auth/mfa/totp/setup — TOTP シークレット生成
pub async fn totp_setup(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<TotpSetupResponse>> {
    let user = extract_user_from_jwt(&state, &headers).await?;

    if user.totp_enabled {
        return Err(AppError::BadRequest("TOTP is already enabled".into()));
    }

    let secret = generate_totp_secret();
    let account = user.email.as_deref().unwrap_or(&user.login);
    let totp = create_totp(&secret, &state.config.app_name, account)?;
    let uri = totp
        .get_url()
        .to_string();

    // シークレットを仮保存 (まだ有効化しない)
    let mfa_methods: Vec<String> = serde_json::from_value(user.mfa_methods.clone())
        .unwrap_or_default();
    db::update_user_mfa(
        &state.db,
        user.id,
        Some(&secret),
        false,
        user.phone_number.as_deref(),
        user.phone_verified,
        user.mfa_enabled,
        &serde_json::to_value(&mfa_methods).unwrap(),
    )
    .await?;

    Ok(Json(TotpSetupResponse {
        secret,
        provisioning_uri: uri,
    }))
}

// -- TOTP 有効化

#[derive(Debug, Deserialize)]
pub struct TotpEnableRequest {
    pub code: String,
}

/// POST /api/auth/mfa/totp/enable — TOTP コード検証して有効化
pub async fn totp_enable(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<TotpEnableRequest>,
) -> Result<Json<serde_json::Value>> {
    let user = extract_user_from_jwt(&state, &headers).await?;

    let secret = user
        .totp_secret
        .as_ref()
        .ok_or_else(|| AppError::BadRequest("TOTP not set up yet. Call /mfa/totp/setup first".into()))?;

    let account = user.email.as_deref().unwrap_or(&user.login);
    let totp = create_totp(secret, &state.config.app_name, account)?;

    if !totp.check_current(&req.code).map_err(|e| AppError::Internal(format!("TOTP check failed: {}", e)))? {
        return Err(AppError::BadRequest("Invalid TOTP code".into()));
    }

    let mut mfa_methods: Vec<String> = serde_json::from_value(user.mfa_methods.clone())
        .unwrap_or_default();
    if !mfa_methods.contains(&"totp".to_string()) {
        mfa_methods.push("totp".to_string());
    }

    db::update_user_mfa(
        &state.db,
        user.id,
        Some(secret),
        true,
        user.phone_number.as_deref(),
        user.phone_verified,
        true,
        &serde_json::to_value(&mfa_methods).unwrap(),
    )
    .await?;

    Ok(Json(serde_json::json!({ "message": "TOTP enabled" })))
}

/// POST /api/auth/mfa/totp/disable — TOTP 無効化
pub async fn totp_disable(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<TotpEnableRequest>,
) -> Result<Json<serde_json::Value>> {
    let user = extract_user_from_jwt(&state, &headers).await?;

    if !user.totp_enabled {
        return Err(AppError::BadRequest("TOTP is not enabled".into()));
    }

    // コード検証して無効化
    let secret = user.totp_secret.as_ref().unwrap();
    let account = user.email.as_deref().unwrap_or(&user.login);
    let totp = create_totp(secret, &state.config.app_name, account)?;

    if !totp.check_current(&req.code).map_err(|e| AppError::Internal(format!("TOTP check failed: {}", e)))? {
        return Err(AppError::BadRequest("Invalid TOTP code".into()));
    }

    let mut mfa_methods: Vec<String> = serde_json::from_value(user.mfa_methods.clone())
        .unwrap_or_default();
    mfa_methods.retain(|m| m != "totp");

    let mfa_enabled = !mfa_methods.is_empty();

    db::update_user_mfa(
        &state.db,
        user.id,
        None,     // シークレット削除
        false,
        user.phone_number.as_deref(),
        user.phone_verified,
        mfa_enabled,
        &serde_json::to_value(&mfa_methods).unwrap(),
    )
    .await?;

    Ok(Json(serde_json::json!({ "message": "TOTP disabled" })))
}

// -- SMS MFA

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmsSetupRequest {
    pub phone_number: String,
}

/// POST /api/auth/mfa/sms/setup — 電話番号を登録して検証コードを送信
pub async fn sms_setup(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<SmsSetupRequest>,
) -> Result<Json<serde_json::Value>> {
    let user = extract_user_from_jwt(&state, &headers).await?;

    // 電話番号を保存
    let mfa_methods: Vec<String> = serde_json::from_value(user.mfa_methods.clone())
        .unwrap_or_default();
    db::update_user_mfa(
        &state.db,
        user.id,
        user.totp_secret.as_deref(),
        user.totp_enabled,
        Some(&req.phone_number),
        false,
        user.mfa_enabled,
        &serde_json::to_value(&mfa_methods).unwrap(),
    )
    .await?;

    // OTP 生成・送信
    let code = generate_otp();
    let expires_at = Utc::now() + Duration::minutes(OTP_EXPIRY_MINUTES);
    db::create_verification_code(&state.db, user.id, &code, "sms_setup", expires_at).await?;

    let message = format!("[{}] Your verification code is: {}", state.config.app_name, code);
    send_sms(&state, &req.phone_number, &message).await?;

    Ok(Json(serde_json::json!({ "message": "Verification code sent" })))
}

#[derive(Debug, Deserialize)]
pub struct VerifyCodeRequest {
    pub code: String,
}

/// POST /api/auth/mfa/sms/verify-phone — 電話番号の検証
pub async fn sms_verify_phone(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<VerifyCodeRequest>,
) -> Result<Json<serde_json::Value>> {
    let user = extract_user_from_jwt(&state, &headers).await?;

    if user.phone_number.is_none() {
        return Err(AppError::BadRequest("Phone number not set".into()));
    }

    let valid = db::verify_code(&state.db, user.id, &req.code, "sms_setup").await?;
    if !valid {
        return Err(AppError::BadRequest("Invalid or expired code".into()));
    }

    let mfa_methods: Vec<String> = serde_json::from_value(user.mfa_methods.clone())
        .unwrap_or_default();
    db::update_user_mfa(
        &state.db,
        user.id,
        user.totp_secret.as_deref(),
        user.totp_enabled,
        user.phone_number.as_deref(),
        true,
        user.mfa_enabled,
        &serde_json::to_value(&mfa_methods).unwrap(),
    )
    .await?;

    Ok(Json(serde_json::json!({ "message": "Phone verified" })))
}

/// POST /api/auth/mfa/sms/enable — SMS MFA 有効化
pub async fn sms_enable(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>> {
    let user = extract_user_from_jwt(&state, &headers).await?;

    if !user.phone_verified {
        return Err(AppError::BadRequest("Phone not verified".into()));
    }

    let mut mfa_methods: Vec<String> = serde_json::from_value(user.mfa_methods.clone())
        .unwrap_or_default();
    if !mfa_methods.contains(&"sms".to_string()) {
        mfa_methods.push("sms".to_string());
    }

    db::update_user_mfa(
        &state.db,
        user.id,
        user.totp_secret.as_deref(),
        user.totp_enabled,
        user.phone_number.as_deref(),
        user.phone_verified,
        true,
        &serde_json::to_value(&mfa_methods).unwrap(),
    )
    .await?;

    Ok(Json(serde_json::json!({ "message": "SMS MFA enabled" })))
}

/// POST /api/auth/mfa/sms/disable — SMS MFA 無効化
pub async fn sms_disable(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>> {
    let user = extract_user_from_jwt(&state, &headers).await?;

    let mut mfa_methods: Vec<String> = serde_json::from_value(user.mfa_methods.clone())
        .unwrap_or_default();
    mfa_methods.retain(|m| m != "sms");
    let mfa_enabled = !mfa_methods.is_empty();

    db::update_user_mfa(
        &state.db,
        user.id,
        user.totp_secret.as_deref(),
        user.totp_enabled,
        user.phone_number.as_deref(),
        user.phone_verified,
        mfa_enabled,
        &serde_json::to_value(&mfa_methods).unwrap(),
    )
    .await?;

    Ok(Json(serde_json::json!({ "message": "SMS MFA disabled" })))
}

// -- Email MFA

/// POST /api/auth/mfa/email/enable — メール MFA 有効化
pub async fn email_mfa_enable(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>> {
    let user = extract_user_from_jwt(&state, &headers).await?;

    if user.email.is_none() {
        return Err(AppError::BadRequest("Email not set".into()));
    }

    let mut mfa_methods: Vec<String> = serde_json::from_value(user.mfa_methods.clone())
        .unwrap_or_default();
    if !mfa_methods.contains(&"email".to_string()) {
        mfa_methods.push("email".to_string());
    }

    db::update_user_mfa(
        &state.db,
        user.id,
        user.totp_secret.as_deref(),
        user.totp_enabled,
        user.phone_number.as_deref(),
        user.phone_verified,
        true,
        &serde_json::to_value(&mfa_methods).unwrap(),
    )
    .await?;

    Ok(Json(serde_json::json!({ "message": "Email MFA enabled" })))
}

/// POST /api/auth/mfa/email/disable — メール MFA 無効化
pub async fn email_mfa_disable(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>> {
    let user = extract_user_from_jwt(&state, &headers).await?;

    let mut mfa_methods: Vec<String> = serde_json::from_value(user.mfa_methods.clone())
        .unwrap_or_default();
    mfa_methods.retain(|m| m != "email");
    let mfa_enabled = !mfa_methods.is_empty();

    db::update_user_mfa(
        &state.db,
        user.id,
        user.totp_secret.as_deref(),
        user.totp_enabled,
        user.phone_number.as_deref(),
        user.phone_verified,
        mfa_enabled,
        &serde_json::to_value(&mfa_methods).unwrap(),
    )
    .await?;

    Ok(Json(serde_json::json!({ "message": "Email MFA disabled" })))
}

// -- MFA ログイン検証

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MfaSendCodeRequest {
    pub mfa_token: String,
    pub method: String, // "sms" or "email"
}

/// POST /api/auth/mfa/send-code — ログイン時に SMS / メールでコード送信
pub async fn mfa_send_code(
    State(state): State<AppState>,
    Json(req): Json<MfaSendCodeRequest>,
) -> Result<Json<serde_json::Value>> {
    let user_id = verify_mfa_token(&req.mfa_token, &state.config.jwt_secret)?;
    let user = db::get_user(&state.db, user_id)
        .await?
        .ok_or_else(|| AppError::Unauthorized("User not found".into()))?;

    let code = generate_otp();
    let expires_at = Utc::now() + Duration::minutes(OTP_EXPIRY_MINUTES);
    db::create_verification_code(&state.db, user.id, &code, &req.method, expires_at).await?;

    match req.method.as_str() {
        "sms" => {
            let phone = user
                .phone_number
                .as_ref()
                .ok_or_else(|| AppError::BadRequest("No phone number".into()))?;
            let message = format!("[{}] Your login code is: {}", state.config.app_name, code);
            send_sms(&state, phone, &message).await?;
        }
        "email" => {
            let email = user
                .email
                .as_ref()
                .ok_or_else(|| AppError::BadRequest("No email".into()))?;
            let subject = format!("[{}] Login verification code", state.config.app_name);
            let body = format!(
                "Your login verification code is: {}\n\nThis code expires in {} minutes.",
                code, OTP_EXPIRY_MINUTES
            );
            send_email(&state, email, &subject, &body).await?;
        }
        _ => return Err(AppError::BadRequest("Invalid method".into())),
    }

    Ok(Json(serde_json::json!({ "message": "Code sent" })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MfaVerifyRequest {
    pub mfa_token: String,
    pub method: String,  // "totp", "sms", "email"
    pub code: String,
}

/// POST /api/auth/mfa/verify — MFA コード検証してトークン発行
pub async fn mfa_verify(
    State(state): State<AppState>,
    Json(req): Json<MfaVerifyRequest>,
) -> Result<Json<TokenResponse>> {
    let user_id = verify_mfa_token(&req.mfa_token, &state.config.jwt_secret)?;
    let user = db::get_user(&state.db, user_id)
        .await?
        .ok_or_else(|| AppError::Unauthorized("User not found".into()))?;

    let mfa_methods: Vec<String> = serde_json::from_value(user.mfa_methods.clone())
        .unwrap_or_default();
    if !mfa_methods.contains(&req.method) {
        return Err(AppError::BadRequest("MFA method not enabled".into()));
    }

    // メソッド別の検証
    match req.method.as_str() {
        "totp" => {
            let secret = user
                .totp_secret
                .as_ref()
                .ok_or_else(|| AppError::Internal("TOTP secret missing".into()))?;
            let account = user.email.as_deref().unwrap_or(&user.login);
            let totp = create_totp(secret, &state.config.app_name, account)?;
            if !totp.check_current(&req.code).map_err(|e| AppError::Internal(format!("TOTP check failed: {}", e)))? {
                return Err(AppError::Unauthorized("Invalid TOTP code".into()));
            }
        }
        "sms" | "email" => {
            let valid = db::verify_code(&state.db, user.id, &req.code, &req.method).await?;
            if !valid {
                return Err(AppError::Unauthorized("Invalid or expired code".into()));
            }
        }
        _ => return Err(AppError::BadRequest("Invalid method".into())),
    }

    // MFA 検証成功 → JWT トークン発行
    let now = Utc::now();
    let access_token = crate::auth::generate_access_token_pub(&user, &state.config.jwt_secret)?;
    let refresh_token = Uuid::new_v4().to_string();
    let expires_at = now + Duration::days(30);
    db::create_refresh_session(&state.db, user.id, &refresh_token, expires_at).await?;

    // last_login_at 更新
    let mut updated = user.clone();
    updated.last_login_at = Some(now);
    updated.updated_at = now;
    db::upsert_user(&state.db, &updated).await?;

    Ok(Json(TokenResponse {
        user: UserResponse::from(user),
        access_token,
        refresh_token,
    }))
}

/// GET /api/auth/mfa/status — 現在の MFA 設定状態
pub async fn mfa_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>> {
    let user = extract_user_from_jwt(&state, &headers).await?;
    let mfa_methods: Vec<String> = serde_json::from_value(user.mfa_methods.clone())
        .unwrap_or_default();

    Ok(Json(serde_json::json!({
        "mfaEnabled": user.mfa_enabled,
        "methods": mfa_methods,
        "totpEnabled": user.totp_enabled,
        "hasPhone": user.phone_number.is_some(),
        "phoneVerified": user.phone_verified,
        "hasEmail": user.email.is_some(),
        "smsAvailable": state.config.aws_sns_enabled,
        "emailMfaAvailable": state.config.aws_ses_enabled,
    })))
}
