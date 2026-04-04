use sqlx::PgPool;
use std::sync::Arc;

use crate::config::Config;
use crate::redis_session::RedisClient;
use crate::relay::{SessionRegistry, ServiceConnectionRegistry};

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub redis: RedisClient,
    pub config: Config,
    pub sessions: Arc<SessionRegistry>,
    pub service_connections: Arc<ServiceConnectionRegistry>,
    pub sns_client: Option<aws_sdk_sns::Client>,
    pub ses_client: Option<aws_sdk_sesv2::Client>,
}
