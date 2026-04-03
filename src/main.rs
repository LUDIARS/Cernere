use axum::http::HeaderValue;
use sqlx::postgres::PgPoolOptions;
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tracing_subscriber::EnvFilter;

mod app_state;
mod auth;
mod commands;
mod config;
mod db;
mod env_auth;
mod error;
mod mfa;
mod models;
mod redis_session;
mod relay;
mod routes;
mod service;
mod session_state;
mod ws;

use app_state::AppState;
use config::Config;
use redis_session::RedisClient;
use relay::SessionRegistry;

/// セッション TTL（7日間）
pub const SESSION_TTL_SECS: i64 = 7 * 24 * 60 * 60;

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();

    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("cernere=info".parse().unwrap()))
        .init();

    let config = Config::from_env();

    let db = PgPoolOptions::new()
        .max_connections(10)
        .connect(&config.database_url)
        .await
        .expect("Failed to connect to PostgreSQL");

    // Run migrations
    sqlx::migrate!("./migrations")
        .run(&db)
        .await
        .expect("Failed to run migrations");

    let redis = RedisClient::new(&config.redis_url)
        .await
        .expect("Failed to connect to Redis");

    let listen_addr = config.listen_addr.clone();

    // AWS SDK 初期化 (SNS / SES)
    let (sns_client, ses_client) = if config.aws_sns_enabled || config.aws_ses_enabled {
        let aws_config = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .region(aws_config::Region::new(config.aws_region.clone()))
            .load()
            .await;
        let sns = if config.aws_sns_enabled {
            tracing::info!("AWS SNS enabled for SMS MFA");
            Some(aws_sdk_sns::Client::new(&aws_config))
        } else {
            None
        };
        let ses = if config.aws_ses_enabled {
            tracing::info!("AWS SES enabled for email MFA");
            Some(aws_sdk_sesv2::Client::new(&aws_config))
        } else {
            None
        };
        (sns, ses)
    } else {
        (None, None)
    };

    let state = AppState {
        db,
        redis,
        config,
        sessions: Arc::new(SessionRegistry::new()),
        sns_client,
        ses_client,
    };

    let allowed_origin = state.config.frontend_url.parse::<HeaderValue>()
        .expect("FRONTEND_URL must be a valid header value");
    let cors = CorsLayer::new()
        .allow_origin(allowed_origin)
        .allow_methods([
            axum::http::Method::GET,
            axum::http::Method::POST,
            axum::http::Method::PUT,
            axum::http::Method::DELETE,
            axum::http::Method::OPTIONS,
        ])
        .allow_headers([
            axum::http::header::AUTHORIZATION,
            axum::http::header::CONTENT_TYPE,
            axum::http::header::ACCEPT,
        ])
        .allow_credentials(true);

    let security_headers = tower_http::set_header::SetResponseHeaderLayer::overriding(
        axum::http::header::HeaderName::from_static("x-frame-options"),
        axum::http::HeaderValue::from_static("DENY"),
    );
    let content_type_options = tower_http::set_header::SetResponseHeaderLayer::overriding(
        axum::http::header::HeaderName::from_static("x-content-type-options"),
        axum::http::HeaderValue::from_static("nosniff"),
    );
    let referrer_policy = tower_http::set_header::SetResponseHeaderLayer::overriding(
        axum::http::header::HeaderName::from_static("referrer-policy"),
        axum::http::HeaderValue::from_static("strict-origin-when-cross-origin"),
    );

    let app = routes::router(state)
        .layer(cors)
        .layer(security_headers)
        .layer(content_type_options)
        .layer(referrer_policy);

    let listener = tokio::net::TcpListener::bind(&listen_addr)
        .await
        .expect("Failed to bind");

    tracing::info!("Cernere listening on {}", listen_addr);
    axum::serve(listener, app).await.unwrap();
}
