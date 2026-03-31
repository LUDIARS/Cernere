use sqlx::PgPool;
use std::sync::Arc;

use crate::config::Config;
use crate::redis_session::RedisClient;
use crate::relay::SessionRegistry;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub redis: RedisClient,
    pub config: Config,
    pub sessions: Arc<SessionRegistry>,
}
