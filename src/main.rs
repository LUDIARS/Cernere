use sqlx::postgres::PgPoolOptions;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};
use tracing_subscriber::EnvFilter;

mod app_state;
mod auth;
mod config;
mod db;
mod env_auth;
mod error;
mod mfa;
mod models;
mod redis_session;
mod relay;
mod routes;
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

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = routes::router(state).layer(cors);

    let listener = tokio::net::TcpListener::bind(&listen_addr)
        .await
        .expect("Failed to bind");

    tracing::info!("Cernere listening on {}", listen_addr);
    axum::serve(listener, app).await.unwrap();
}
