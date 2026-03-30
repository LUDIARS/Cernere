use sqlx::PgPool;

use crate::config::Config;
use crate::redis_session::RedisClient;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub redis: RedisClient,
    pub config: Config,
}
