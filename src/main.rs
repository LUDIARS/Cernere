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

    let state = AppState {
        db,
        redis,
        config,
        sessions: Arc::new(SessionRegistry::new()),
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
