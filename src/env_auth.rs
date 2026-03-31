//! 環境ベース認証設定
//!
//! 各環境のログインインタラクト情報を事前設定し、
//! 環境に応じた認証形式を提示する。
//!
//! 認証形式:
//! - WebBrowser: ブラウザベース OAuth (GitHub, Google)
//! - Native: パスワード / JWT 認証
//!
//! 接続形式:
//! - Http: ワンタイム HTTP リクエスト
//! - WebSocket: セッション接続（推奨）

use serde::{Deserialize, Serialize};

use crate::app_state::AppState;

/// 認証方式
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthMethod {
    /// ブラウザ OAuth 認証 (GitHub / Google)
    WebBrowser {
        provider: String,
        login_url: String,
    },
    /// 独自認証 (email/password)
    Native,
}

/// 接続方式
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransportMode {
    /// ワンタイム HTTP リクエスト
    Http,
    /// セッション持続 WebSocket（推奨）
    WebSocket { endpoint: String },
}

/// MFA の利用可能な方式
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MfaConfig {
    /// TOTP (Authenticator アプリ) が利用可能
    pub totp_available: bool,
    /// SMS MFA が利用可能 (AWS SNS)
    pub sms_available: bool,
    /// Email MFA が利用可能 (AWS SES)
    pub email_available: bool,
}

/// 環境ごとの認証設定
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentAuthConfig {
    /// 利用可能な認証方式一覧
    pub auth_methods: Vec<AuthMethod>,
    /// 利用可能な接続方式一覧
    pub transports: Vec<TransportMode>,
    /// 推奨接続方式
    pub recommended_transport: String,
    /// セッション TTL (秒)
    pub session_ttl_secs: i64,
    /// ping 間隔 (秒)
    pub ping_interval_secs: u64,
    /// MFA 設定
    pub mfa: MfaConfig,
}

/// 現在の環境設定から認証コンフィグを生成
pub fn build_auth_config(state: &AppState) -> EnvironmentAuthConfig {
    let mut auth_methods = Vec::new();

    // パスワード認証は常に有効
    auth_methods.push(AuthMethod::Native);

    // GitHub OAuth が設定されていれば有効
    if !state.config.github_client_id.is_empty() {
        auth_methods.push(AuthMethod::WebBrowser {
            provider: "github".into(),
            login_url: "/auth/github/login".into(),
        });
    }

    // Google OAuth が設定されていれば有効
    if !state.config.google_client_id.is_empty() {
        auth_methods.push(AuthMethod::WebBrowser {
            provider: "google".into(),
            login_url: "/auth/google/login".into(),
        });
    }

    let transports = vec![
        TransportMode::Http,
        TransportMode::WebSocket {
            endpoint: "/ws".into(),
        },
    ];

    let mfa = MfaConfig {
        totp_available: true, // TOTP は常に利用可能 (サーバー側のみで完結)
        sms_available: state.config.aws_sns_enabled,
        email_available: state.config.aws_ses_enabled,
    };

    EnvironmentAuthConfig {
        auth_methods,
        transports,
        recommended_transport: "websocket".into(),
        session_ttl_secs: crate::SESSION_TTL_SECS,
        ping_interval_secs: 30,
        mfa,
    }
}
