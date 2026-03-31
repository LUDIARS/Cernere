use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::{Json, Redirect};
use axum_extra::extract::cookie::{Cookie, CookieJar};
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::Deserialize;
use uuid::Uuid;

use crate::app_state::AppState;
use crate::error::{AppError, Result};
use crate::models::{JwtClaims, Session, TokenResponse, User, UserResponse};
use crate::{db, SESSION_TTL_SECS};

const SESSION_COOKIE: &str = "ars_session";
const CSRF_STATE_COOKIE: &str = "ars_oauth_state";
const ACCESS_TOKEN_MINUTES: i64 = 60;
const REFRESH_TOKEN_DAYS: i64 = 30;

// ── JWT ヘルパー ─────────────────────────────────────

fn generate_access_token(user: &User, secret: &str) -> Result<String> {
    let now = Utc::now();
    let claims = JwtClaims {
        sub: user.id.to_string(),
        role: user.role.clone(),
        iat: now.timestamp() as usize,
        exp: (now + Duration::minutes(ACCESS_TOKEN_MINUTES)).timestamp() as usize,
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| AppError::Internal(format!("JWT encode failed: {}", e)))
}

fn generate_tokens(user: &User, secret: &str) -> Result<(String, String)> {
    let access_token = generate_access_token(user, secret)?;
    let refresh_token = Uuid::new_v4().to_string();
    Ok((access_token, refresh_token))
}

fn verify_jwt(token: &str, secret: &str) -> Result<JwtClaims> {
    decode::<JwtClaims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )
    .map(|data| data.claims)
    .map_err(|e| AppError::Unauthorized(format!("Invalid token: {}", e)))
}

/// Bearer トークンから JWT でユーザーを取得
pub async fn extract_user_from_jwt(state: &AppState, headers: &HeaderMap) -> Result<User> {
    let auth_header = headers
        .get("Authorization")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| AppError::Unauthorized("No token provided".into()))?;
    if !auth_header.starts_with("Bearer ") {
        return Err(AppError::Unauthorized("Invalid auth header".into()));
    }
    let token = &auth_header[7..];
    let claims = verify_jwt(token, &state.config.jwt_secret)?;
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid user ID in token".into()))?;
    db::get_user(&state.db, user_id)
        .await?
        .ok_or_else(|| AppError::Unauthorized("User not found".into()))
}

// ── パスワード認証 ───────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    pub name: String,
    pub email: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct RefreshRequest {
    #[serde(rename = "refreshToken")]
    pub refresh_token: String,
}

#[derive(Debug, Deserialize)]
pub struct LogoutJwtRequest {
    #[serde(rename = "refreshToken")]
    pub refresh_token: String,
}

/// POST /api/auth/register
pub async fn register(
    State(state): State<AppState>,
    Json(req): Json<RegisterRequest>,
) -> Result<(axum::http::StatusCode, Json<TokenResponse>)> {
    if req.password.len() < 8 {
        return Err(AppError::BadRequest(
            "Password must be at least 8 characters".into(),
        ));
    }

    if db::get_user_by_email(&state.db, &req.email).await?.is_some() {
        return Err(AppError::BadRequest("Email already registered".into()));
    }

    let password_hash = bcrypt::hash(&req.password, 12)
        .map_err(|e| AppError::Internal(format!("Hash failed: {}", e)))?;

    let user_count = db::count_users(&state.db).await?;
    let role = if user_count == 0 { "admin" } else { "general" };
    let now = Utc::now();

    let user = User {
        id: Uuid::new_v4(),
        github_id: None,
        login: req.name.clone(),
        display_name: req.name,
        avatar_url: String::new(),
        email: Some(req.email),
        role: role.to_string(),
        password_hash: Some(password_hash),
        google_id: None,
        google_access_token: None,
        google_refresh_token: None,
        google_token_expires_at: None,
        google_scopes: None,
        last_login_at: Some(now),
        created_at: now,
        updated_at: now,
    };
    db::upsert_user(&state.db, &user).await?;

    let (access_token, refresh_token) = generate_tokens(&user, &state.config.jwt_secret)?;
    let expires_at = now + Duration::days(REFRESH_TOKEN_DAYS);
    db::create_refresh_session(&state.db, user.id, &refresh_token, expires_at).await?;

    Ok((
        axum::http::StatusCode::CREATED,
        Json(TokenResponse {
            user: UserResponse::from(user),
            access_token,
            refresh_token,
        }),
    ))
}

/// POST /api/auth/login
pub async fn login(
    State(state): State<AppState>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<TokenResponse>> {
    let user = db::get_user_by_email(&state.db, &req.email)
        .await?
        .ok_or_else(|| AppError::Unauthorized("Invalid email or password".into()))?;

    let hash = user
        .password_hash
        .as_ref()
        .ok_or_else(|| AppError::Unauthorized("Invalid email or password".into()))?;

    let valid = bcrypt::verify(&req.password, hash)
        .map_err(|e| AppError::Internal(format!("Verify failed: {}", e)))?;
    if !valid {
        return Err(AppError::Unauthorized("Invalid email or password".into()));
    }

    let now = Utc::now();
    let (access_token, refresh_token) = generate_tokens(&user, &state.config.jwt_secret)?;
    let expires_at = now + Duration::days(REFRESH_TOKEN_DAYS);
    db::create_refresh_session(&state.db, user.id, &refresh_token, expires_at).await?;

    // Update last_login_at
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

/// POST /api/auth/refresh
pub async fn refresh(
    State(state): State<AppState>,
    Json(req): Json<RefreshRequest>,
) -> Result<Json<serde_json::Value>> {
    let session = db::find_refresh_session(&state.db, &req.refresh_token)
        .await?
        .ok_or_else(|| AppError::Unauthorized("Invalid refresh token".into()))?;

    if Utc::now() > session.expires_at {
        db::delete_refresh_session_by_token(&state.db, &req.refresh_token).await?;
        return Err(AppError::Unauthorized("Refresh token expired".into()));
    }

    let user = db::get_user(&state.db, session.user_id)
        .await?
        .ok_or_else(|| AppError::Unauthorized("User not found".into()))?;

    let (access_token, new_refresh_token) = generate_tokens(&user, &state.config.jwt_secret)?;
    let new_expires_at = Utc::now() + Duration::days(REFRESH_TOKEN_DAYS);
    db::rotate_refresh_token(&state.db, session.id, &new_refresh_token, new_expires_at).await?;

    Ok(Json(serde_json::json!({
        "accessToken": access_token,
        "refreshToken": new_refresh_token,
    })))
}

/// POST /api/auth/logout (JWT)
pub async fn logout_jwt(
    State(state): State<AppState>,
    Json(req): Json<LogoutJwtRequest>,
) -> Result<Json<serde_json::Value>> {
    db::delete_refresh_session_by_token(&state.db, &req.refresh_token).await?;
    Ok(Json(serde_json::json!({ "message": "Logged out" })))
}

/// GET /api/auth/me (JWT)
pub async fn get_me_jwt(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<UserResponse>> {
    let user = extract_user_from_jwt(&state, &headers).await?;
    Ok(Json(UserResponse::from(user)))
}

// ── Google OAuth ─────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct GoogleCallbackQuery {
    pub code: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GoogleTokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: i64,
    scope: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GoogleUserInfo {
    id: String,
    email: String,
    name: String,
    picture: Option<String>,
}

/// GET /auth/google/login
pub async fn google_login(State(state): State<AppState>) -> Result<Redirect> {
    if state.config.google_client_id.is_empty() {
        return Err(AppError::BadRequest("Google OAuth is not configured".into()));
    }

    let scopes = [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/calendar.events.readonly",
        "https://www.googleapis.com/auth/calendar.events",
    ]
    .join(" ");

    let params = format!(
        "client_id={}&redirect_uri={}&response_type=code&scope={}&access_type=offline&prompt=consent",
        urlencoding::encode(&state.config.google_client_id),
        urlencoding::encode(&state.config.google_redirect_uri),
        urlencoding::encode(&scopes),
    );

    let url = format!("https://accounts.google.com/o/oauth2/v2/auth?{}", params);
    Ok(Redirect::temporary(&url))
}

/// GET /auth/google/callback
pub async fn google_callback(
    State(state): State<AppState>,
    Query(query): Query<GoogleCallbackQuery>,
) -> Result<Redirect> {
    let frontend = &state.config.frontend_url;

    if let Some(error) = query.error {
        let url = format!("{}?authError={}", frontend, urlencoding::encode(&error));
        return Ok(Redirect::temporary(&url));
    }

    let code = query
        .code
        .ok_or_else(|| AppError::BadRequest("Authorization code not provided".into()))?;

    // Exchange code for tokens
    let client = reqwest::Client::new();
    let token_res = client
        .post("https://oauth2.googleapis.com/token")
        .json(&serde_json::json!({
            "code": code,
            "client_id": state.config.google_client_id,
            "client_secret": state.config.google_client_secret,
            "redirect_uri": state.config.google_redirect_uri,
            "grant_type": "authorization_code",
        }))
        .send()
        .await
        .map_err(|e| AppError::External(format!("Token exchange failed: {}", e)))?;

    if !token_res.status().is_success() {
        let url = format!(
            "{}?authError={}",
            frontend,
            urlencoding::encode("Failed to exchange authorization code")
        );
        return Ok(Redirect::temporary(&url));
    }

    let token_data: GoogleTokenResponse = token_res
        .json()
        .await
        .map_err(|e| AppError::External(format!("Failed to parse token: {}", e)))?;

    // Fetch user info
    let user_info: GoogleUserInfo = client
        .get("https://www.googleapis.com/oauth2/v2/userinfo")
        .header("Authorization", format!("Bearer {}", token_data.access_token))
        .send()
        .await
        .map_err(|e| AppError::External(format!("Failed to fetch user: {}", e)))?
        .json()
        .await
        .map_err(|e| AppError::External(format!("Failed to parse user: {}", e)))?;

    let now = Utc::now();
    let token_expires_at = now.timestamp() * 1000 + token_data.expires_in * 1000;
    let scopes: Vec<String> = token_data
        .scope
        .map(|s| s.split(' ').map(String::from).collect())
        .unwrap_or_default();

    // Find or create user
    let mut user = db::get_user_by_google_id(&state.db, &user_info.id).await?;
    if user.is_none() {
        user = db::get_user_by_email(&state.db, &user_info.email).await?;
    }

    let user = match user {
        Some(mut existing) => {
            existing.google_id = Some(user_info.id.clone());
            existing.google_access_token = Some(token_data.access_token);
            if let Some(rt) = token_data.refresh_token {
                existing.google_refresh_token = Some(rt);
            }
            existing.google_token_expires_at = Some(token_expires_at);
            existing.google_scopes = Some(serde_json::to_value(&scopes).unwrap());
            existing.display_name = user_info.name;
            existing.avatar_url = user_info.picture.unwrap_or_default();
            existing.last_login_at = Some(now);
            existing.updated_at = now;
            db::upsert_user(&state.db, &existing).await?;
            existing
        }
        None => {
            let user_count = db::count_users(&state.db).await?;
            let role = if user_count == 0 { "admin" } else { "general" };
            let new_user = User {
                id: Uuid::new_v4(),
                github_id: None,
                login: user_info.email.clone(),
                display_name: user_info.name,
                avatar_url: user_info.picture.unwrap_or_default(),
                email: Some(user_info.email),
                role: role.to_string(),
                password_hash: None,
                google_id: Some(user_info.id),
                google_access_token: Some(token_data.access_token),
                google_refresh_token: token_data.refresh_token,
                google_token_expires_at: Some(token_expires_at),
                google_scopes: Some(serde_json::to_value(&scopes).unwrap()),
                last_login_at: Some(now),
                created_at: now,
                updated_at: now,
            };
            db::upsert_user(&state.db, &new_user).await?;
            new_user
        }
    };

    // Generate JWT tokens
    let (access_token, refresh_token) = generate_tokens(&user, &state.config.jwt_secret)?;
    let expires_at = now + Duration::days(REFRESH_TOKEN_DAYS);
    db::create_refresh_session(&state.db, user.id, &refresh_token, expires_at).await?;

    // Redirect to frontend with tokens
    let url = format!(
        "{}?accessToken={}&refreshToken={}",
        frontend,
        urlencoding::encode(&access_token),
        urlencoding::encode(&refresh_token),
    );
    Ok(Redirect::temporary(&url))
}

// ── GitHub OAuth (Cookie ベース、Ars BFF 用) ─────────

#[derive(Debug, Deserialize)]
pub struct OAuthCallbackQuery {
    pub code: String,
    pub state: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GitHubTokenResponse {
    access_token: String,
}

#[derive(Debug, Deserialize)]
struct GitHubUser {
    id: i64,
    login: String,
    name: Option<String>,
    avatar_url: String,
    email: Option<String>,
}

/// GET /auth/github/login
pub async fn github_login(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<(CookieJar, Redirect)> {
    if state.config.github_client_id.is_empty() {
        return Err(AppError::BadRequest("GitHub OAuth is not configured".into()));
    }

    let csrf_state = Uuid::new_v4().to_string();
    let is_https = state.config.is_https();

    let state_cookie = Cookie::build((CSRF_STATE_COOKIE, csrf_state.clone()))
        .path("/")
        .http_only(true)
        .max_age(time::Duration::minutes(10))
        .same_site(axum_extra::extract::cookie::SameSite::Lax)
        .secure(is_https);

    let url = format!(
        "https://github.com/login/oauth/authorize?client_id={}&redirect_uri={}&scope=read:user%20user:email%20repo&state={}",
        state.config.github_client_id,
        urlencoding::encode(&state.config.github_redirect_uri),
        urlencoding::encode(&csrf_state),
    );
    Ok((jar.add(state_cookie), Redirect::temporary(&url)))
}

/// GET /auth/github/callback
pub async fn github_callback(
    State(state): State<AppState>,
    Query(query): Query<OAuthCallbackQuery>,
    jar: CookieJar,
) -> Result<(CookieJar, Redirect)> {
    let expected_state = jar
        .get(CSRF_STATE_COOKIE)
        .map(|c| c.value().to_string())
        .ok_or_else(|| AppError::BadRequest("Missing OAuth state cookie".into()))?;
    let actual_state = query
        .state
        .ok_or_else(|| AppError::BadRequest("Missing state parameter".into()))?;
    if expected_state != actual_state {
        return Err(AppError::BadRequest("Invalid OAuth state".into()));
    }

    let client = reqwest::Client::new();
    let token_res = client
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .json(&serde_json::json!({
            "client_id": state.config.github_client_id,
            "client_secret": state.config.github_client_secret,
            "code": query.code,
            "redirect_uri": state.config.github_redirect_uri,
        }))
        .send()
        .await
        .map_err(|e| AppError::External(format!("Token exchange failed: {}", e)))?;

    let token_data: GitHubTokenResponse = token_res
        .json()
        .await
        .map_err(|e| AppError::External(format!("Failed to parse token: {}", e)))?;

    let gh_user: GitHubUser = client
        .get("https://api.github.com/user")
        .header("Authorization", format!("Bearer {}", token_data.access_token))
        .header("User-Agent", "Cernere")
        .send()
        .await
        .map_err(|e| AppError::External(format!("Failed to fetch user: {}", e)))?
        .json()
        .await
        .map_err(|e| AppError::External(format!("Failed to parse user: {}", e)))?;

    let now = Utc::now();

    let user = match db::get_user_by_github_id(&state.db, gh_user.id).await? {
        Some(mut existing) => {
            existing.login = gh_user.login;
            existing.display_name = gh_user.name.unwrap_or_else(|| existing.login.clone());
            existing.avatar_url = gh_user.avatar_url;
            existing.email = gh_user.email;
            existing.last_login_at = Some(now);
            existing.updated_at = now;
            db::upsert_user(&state.db, &existing).await?;
            existing
        }
        None => {
            let user_count = db::count_users(&state.db).await?;
            let role = if user_count == 0 { "admin" } else { "general" };
            let new_user = User {
                id: Uuid::new_v4(),
                github_id: Some(gh_user.id),
                login: gh_user.login.clone(),
                display_name: gh_user.name.unwrap_or(gh_user.login),
                avatar_url: gh_user.avatar_url,
                email: gh_user.email,
                role: role.to_string(),
                password_hash: None,
                google_id: None,
                google_access_token: None,
                google_refresh_token: None,
                google_token_expires_at: None,
                google_scopes: None,
                last_login_at: Some(now),
                created_at: now,
                updated_at: now,
            };
            db::upsert_user(&state.db, &new_user).await?;
            new_user
        }
    };

    // Create Redis session for Ars BFF
    let session = Session {
        id: Uuid::new_v4().to_string(),
        user_id: user.id,
        expires_at: now + Duration::seconds(SESSION_TTL_SECS),
        created_at: now,
        access_token: token_data.access_token,
    };
    state.redis.put_session(&session).await?;

    let is_https = state.config.is_https();
    let cookie = Cookie::build((SESSION_COOKIE, session.id))
        .path("/")
        .http_only(true)
        .max_age(time::Duration::seconds(SESSION_TTL_SECS))
        .same_site(axum_extra::extract::cookie::SameSite::Lax)
        .secure(is_https);

    let clear_csrf = Cookie::build((CSRF_STATE_COOKIE, ""))
        .path("/")
        .max_age(time::Duration::seconds(0));

    Ok((jar.add(cookie).remove(clear_csrf), Redirect::temporary("/")))
}

// ── Cookie ベース認証 (Ars BFF 用) ──────────────────

/// GET /auth/me (Cookie)
pub async fn get_me(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<Json<UserResponse>> {
    let user = extract_user(&state, &jar).await?;
    Ok(Json(UserResponse::from(user)))
}

/// POST /auth/logout (Cookie)
pub async fn logout(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<(CookieJar, Json<()>)> {
    if let Some(session_id) = jar.get(SESSION_COOKIE).map(|c| c.value().to_string()) {
        let _ = state.redis.delete_session(&session_id).await;
    }
    let cookie = Cookie::build((SESSION_COOKIE, ""))
        .path("/")
        .max_age(time::Duration::seconds(0));
    Ok((jar.remove(cookie), Json(())))
}

pub async fn extract_session(state: &AppState, jar: &CookieJar) -> Result<Session> {
    let session_id = jar
        .get(SESSION_COOKIE)
        .map(|c| c.value().to_string())
        .ok_or_else(|| AppError::Unauthorized("Not authenticated".into()))?;
    let session = state
        .redis
        .get_session(&session_id)
        .await?
        .ok_or_else(|| AppError::Unauthorized("Session not found".into()))?;
    if Utc::now() > session.expires_at {
        let _ = state.redis.delete_session(&session_id).await;
        return Err(AppError::Unauthorized("Session expired".into()));
    }
    Ok(session)
}

pub async fn extract_user(state: &AppState, jar: &CookieJar) -> Result<User> {
    let session = extract_session(state, jar).await?;
    db::get_user(&state.db, session.user_id)
        .await?
        .ok_or_else(|| AppError::Unauthorized("User not found".into()))
}
