use axum::extract::{Query, State};
use axum::response::{Json, Redirect};
use axum_extra::extract::cookie::{Cookie, CookieJar};
use chrono::Utc;
use serde::Deserialize;
use uuid::Uuid;

use crate::app_state::AppState;
use crate::error::{AppError, Result};
use crate::models::{Session, User, UserResponse};
use crate::{db, SESSION_TTL_SECS};

const SESSION_COOKIE: &str = "ars_session";
const CSRF_STATE_COOKIE: &str = "ars_oauth_state";

#[derive(Debug, Deserialize)]
pub struct OAuthCallbackQuery {
    pub code: String,
    pub state: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GitHubTokenResponse {
    access_token: String,
}

#[derive(Debug, Deserialize)]
struct GitHubUser {
    id: i64,
    login: String,
    name: Option<String>,
    avatar_url: String,
    email: Option<String>,
}

/// GET /auth/github/login
pub async fn github_login(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<(CookieJar, Redirect)> {
    let csrf_state = Uuid::new_v4().to_string();
    let is_https = state.config.is_https();

    let state_cookie = Cookie::build((CSRF_STATE_COOKIE, csrf_state.clone()))
        .path("/")
        .http_only(true)
        .max_age(time::Duration::minutes(10))
        .same_site(axum_extra::extract::cookie::SameSite::Lax)
        .secure(is_https);

    let url = format!(
        "https://github.com/login/oauth/authorize?client_id={}&redirect_uri={}&scope=read:user%20user:email%20repo&state={}",
        state.config.github_client_id,
        urlencoding::encode(&state.config.github_redirect_uri),
        urlencoding::encode(&csrf_state),
    );
    Ok((jar.add(state_cookie), Redirect::temporary(&url)))
}

/// GET /auth/github/callback
pub async fn github_callback(
    State(state): State<AppState>,
    Query(query): Query<OAuthCallbackQuery>,
    jar: CookieJar,
) -> Result<(CookieJar, Redirect)> {
    // Validate CSRF state
    let expected_state = jar
        .get(CSRF_STATE_COOKIE)
        .map(|c| c.value().to_string())
        .ok_or_else(|| AppError::BadRequest("Missing OAuth state cookie".into()))?;
    let actual_state = query
        .state
        .ok_or_else(|| AppError::BadRequest("Missing state parameter".into()))?;
    if expected_state != actual_state {
        return Err(AppError::BadRequest("Invalid OAuth state (CSRF check failed)".into()));
    }

    // Exchange code for access token
    let client = reqwest::Client::new();
    let token_res = client
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .json(&serde_json::json!({
            "client_id": state.config.github_client_id,
            "client_secret": state.config.github_client_secret,
            "code": query.code,
            "redirect_uri": state.config.github_redirect_uri,
        }))
        .send()
        .await
        .map_err(|e| AppError::External(format!("Token exchange failed: {}", e)))?;

    let token_data: GitHubTokenResponse = token_res
        .json()
        .await
        .map_err(|e| AppError::External(format!("Failed to parse token response: {}", e)))?;

    // Fetch GitHub user info
    let gh_user: GitHubUser = client
        .get("https://api.github.com/user")
        .header("Authorization", format!("Bearer {}", token_data.access_token))
        .header("User-Agent", "Cernere")
        .send()
        .await
        .map_err(|e| AppError::External(format!("Failed to fetch user: {}", e)))?
        .json()
        .await
        .map_err(|e| AppError::External(format!("Failed to parse user: {}", e)))?;

    let now = Utc::now();

    // Find or create user
    let user = match db::get_user_by_github_id(&state.db, gh_user.id).await? {
        Some(mut existing) => {
            existing.login = gh_user.login;
            existing.display_name = gh_user.name.unwrap_or_else(|| existing.login.clone());
            existing.avatar_url = gh_user.avatar_url;
            existing.email = gh_user.email;
            existing.updated_at = now;
            db::upsert_user(&state.db, &existing).await?;
            existing
        }
        None => {
            let new_user = User {
                id: Uuid::new_v4(),
                github_id: gh_user.id,
                login: gh_user.login.clone(),
                display_name: gh_user.name.unwrap_or(gh_user.login),
                avatar_url: gh_user.avatar_url,
                email: gh_user.email,
                created_at: now,
                updated_at: now,
            };
            db::upsert_user(&state.db, &new_user).await?;
            new_user
        }
    };

    // Create session
    let session = Session {
        id: Uuid::new_v4().to_string(),
        user_id: user.id,
        expires_at: now + chrono::Duration::seconds(SESSION_TTL_SECS),
        created_at: now,
        access_token: token_data.access_token,
    };
    state.redis.put_session(&session).await?;

    let is_https = state.config.is_https();
    let cookie = Cookie::build((SESSION_COOKIE, session.id))
        .path("/")
        .http_only(true)
        .max_age(time::Duration::seconds(SESSION_TTL_SECS))
        .same_site(axum_extra::extract::cookie::SameSite::Lax)
        .secure(is_https);

    let clear_csrf = Cookie::build((CSRF_STATE_COOKIE, ""))
        .path("/")
        .max_age(time::Duration::seconds(0));

    Ok((jar.add(cookie).remove(clear_csrf), Redirect::temporary("/")))
}

/// GET /auth/me
pub async fn get_me(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<Json<UserResponse>> {
    let user = extract_user(&state, &jar).await?;
    Ok(Json(UserResponse::from(user)))
}

/// POST /auth/logout
pub async fn logout(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<(CookieJar, Json<()>)> {
    if let Some(session_id) = jar.get(SESSION_COOKIE).map(|c| c.value().to_string()) {
        let _ = state.redis.delete_session(&session_id).await;
    }
    let cookie = Cookie::build((SESSION_COOKIE, ""))
        .path("/")
        .max_age(time::Duration::seconds(0));
    Ok((jar.remove(cookie), Json(())))
}

/// セッションを Cookie から取得・検証
pub async fn extract_session(state: &AppState, jar: &CookieJar) -> Result<Session> {
    let session_id = jar
        .get(SESSION_COOKIE)
        .map(|c| c.value().to_string())
        .ok_or_else(|| AppError::Unauthorized("Not authenticated".into()))?;

    let session = state
        .redis
        .get_session(&session_id)
        .await?
        .ok_or_else(|| AppError::Unauthorized("Session not found".into()))?;

    if Utc::now() > session.expires_at {
        let _ = state.redis.delete_session(&session_id).await;
        return Err(AppError::Unauthorized("Session expired".into()));
    }

    Ok(session)
}

/// セッションからユーザーを取得
pub async fn extract_user(state: &AppState, jar: &CookieJar) -> Result<User> {
    let session = extract_session(state, jar).await?;
    db::get_user(&state.db, session.user_id)
        .await?
        .ok_or_else(|| AppError::Unauthorized("User not found".into()))
}
