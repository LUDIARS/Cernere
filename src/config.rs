use std::env;

#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    pub redis_url: String,
    pub listen_addr: String,
    pub frontend_url: String,

    // GitHub OAuth
    pub github_client_id: String,
    pub github_client_secret: String,
    pub github_redirect_uri: String,

    // Google OAuth
    pub google_client_id: String,
    pub google_client_secret: String,
    pub google_redirect_uri: String,

    // JWT
    pub jwt_secret: String,
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
            frontend_url: env::var("FRONTEND_URL")
                .unwrap_or_else(|_| "http://localhost:5173".into()),

            github_client_id: env::var("GITHUB_CLIENT_ID").unwrap_or_default(),
            github_client_secret: env::var("GITHUB_CLIENT_SECRET").unwrap_or_default(),
            github_redirect_uri: env::var("GITHUB_REDIRECT_URI")
                .unwrap_or_else(|_| "http://localhost:8080/auth/github/callback".into()),

            google_client_id: env::var("GOOGLE_CLIENT_ID").unwrap_or_default(),
            google_client_secret: env::var("GOOGLE_CLIENT_SECRET").unwrap_or_default(),
            google_redirect_uri: env::var("GOOGLE_REDIRECT_URI")
                .unwrap_or_else(|_| "http://localhost:8080/auth/google/callback".into()),

            jwt_secret: env::var("JWT_SECRET")
                .unwrap_or_else(|_| "cernere-dev-secret-change-in-production".into()),
        }
    }

    pub fn is_https(&self) -> bool {
        self.frontend_url.starts_with("https://")
    }
}
