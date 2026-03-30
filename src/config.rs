use std::env;

#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    pub redis_url: String,
    pub listen_addr: String,
    pub github_client_id: String,
    pub github_client_secret: String,
    pub github_redirect_uri: String,
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            database_url: env::var("DATABASE_URL")
                .unwrap_or_else(|_| "postgres://cernere:cernere@localhost:5432/cernere".into()),
            redis_url: env::var("REDIS_URL")
                .unwrap_or_else(|_| "redis://127.0.0.1:6379".into()),
            listen_addr: env::var("LISTEN_ADDR")
                .unwrap_or_else(|_| "0.0.0.0:8080".into()),
            github_client_id: env::var("GITHUB_CLIENT_ID")
                .expect("GITHUB_CLIENT_ID must be set"),
            github_client_secret: env::var("GITHUB_CLIENT_SECRET")
                .expect("GITHUB_CLIENT_SECRET must be set"),
            github_redirect_uri: env::var("GITHUB_REDIRECT_URI")
                .unwrap_or_else(|_| "http://localhost:5173/auth/github/callback".into()),
        }
    }

    pub fn is_https(&self) -> bool {
        self.github_redirect_uri.starts_with("https://")
    }
}
