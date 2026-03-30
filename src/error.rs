use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Unauthorized: {0}")]
    Unauthorized(String),

    #[error("Bad request: {0}")]
    BadRequest(String),

    #[error("Database error: {0}")]
    Db(#[from] sqlx::Error),

    #[error("Redis error: {0}")]
    Redis(String),

    #[error("External service error: {0}")]
    External(String),

    #[error("Internal error: {0}")]
    Internal(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = match &self {
            AppError::NotFound(_) => StatusCode::NOT_FOUND,
            AppError::Unauthorized(_) => StatusCode::UNAUTHORIZED,
            AppError::BadRequest(_) => StatusCode::BAD_REQUEST,
            AppError::Db(_) | AppError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
            AppError::Redis(_) => StatusCode::INTERNAL_SERVER_ERROR,
            AppError::External(_) => StatusCode::BAD_GATEWAY,
        };
        (status, self.to_string()).into_response()
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
