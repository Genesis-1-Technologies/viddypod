// Local HTTP server that receives YouTube cookies pushed by the ViddyPod
// browser extension and writes them to a Netscape-format cookies.txt file
// for yt-dlp to consume.
//
// Security model:
//  - Binds to 127.0.0.1 only (not reachable from the network)
//  - Requires `Authorization: Bearer <pair_token>` on every endpoint — this is
//    the actual access control
//  - If an Origin header is present it must be a browser-extension scheme, so a
//    malicious web page can never reach us (a page fetch always carries its web
//    origin). An *absent* Origin is allowed: Chrome omits it on privileged
//    extension GETs, and forging one buys an attacker nothing they couldn't do
//    with plain curl — which still needs the token.
//  - cookies.txt is written atomically (write tmp → rename) and lives under
//    the user's local app data dir, inheriting OS-level user-only permissions

use axum::{
    extract::{Request, State},
    http::{header, Method, StatusCode},
    middleware::{self, Next},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
};
use subtle::ConstantTimeEq;
use tokio::sync::Mutex;
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::state::AppState;

pub const DEFAULT_PORT: u16 = 17421;

#[derive(Clone)]
struct ServerState {
    app_state: Arc<Mutex<AppState>>,
    pair_token: String,
    cookies_path: PathBuf,
}

#[derive(Deserialize, Debug)]
pub struct CookiesPayload {
    pub cookies: Vec<BrowserCookie>,
}

#[derive(Deserialize, Debug)]
#[allow(dead_code)] // http_only / session are parsed but not part of Netscape output
pub struct BrowserCookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    #[serde(rename = "expirationDate", default)]
    pub expiration: Option<f64>,
    #[serde(default)]
    pub secure: bool,
    #[serde(rename = "httpOnly", default)]
    pub http_only: bool,
    #[serde(default)]
    pub session: bool,
}

#[derive(Serialize)]
struct PingResponse {
    ok: bool,
    version: &'static str,
}

#[derive(Serialize)]
struct CookiesResponse {
    ok: bool,
    count: usize,
}

/// Load an existing pair token from disk, or generate a new one and persist it.
pub fn load_or_generate_pair_token(dir: &Path) -> anyhow::Result<String> {
    let path = dir.join("pair_token.txt");
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if trimmed.len() == 32 && trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
            return Ok(trimmed.to_string());
        }
    }
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
    std::fs::create_dir_all(dir)?;
    std::fs::write(&path, &token)?;
    log::info!("Generated new pair token at {:?}", path);
    Ok(token)
}

/// Run the cookie-bridge HTTP server forever. Intended to be spawned on a
/// tokio task from Tauri's setup hook.
pub async fn run_cookie_server(
    app_state: Arc<Mutex<AppState>>,
    port: u16,
    pair_token: String,
    cookies_path: PathBuf,
) -> anyhow::Result<()> {
    let state = ServerState {
        app_state,
        pair_token,
        cookies_path,
    };

    let cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE, header::ORIGIN])
        .allow_origin(AllowOrigin::predicate(|origin, _| {
            let bytes = origin.as_bytes();
            bytes.starts_with(b"chrome-extension://")
                || bytes.starts_with(b"moz-extension://")
                || bytes.starts_with(b"edge-extension://")
        }));

    let app = Router::new()
        .route("/ping", get(handle_ping))
        .route("/cookies", post(handle_cookies))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth_and_origin_middleware,
        ))
        .layer(cors)
        .with_state(state);

    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let listener = tokio::net::TcpListener::bind(addr).await?;
    log::info!("[cookie_server] listening on {}", addr);
    axum::serve(listener, app).await?;
    Ok(())
}

async fn auth_and_origin_middleware(
    State(state): State<ServerState>,
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    // Allow CORS preflight through unauthenticated (CorsLayer handles it)
    if req.method() == Method::OPTIONS {
        return Ok(next.run(req).await);
    }

    let origin = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok());
    if !origin_allowed(origin) {
        log::warn!("[cookie_server] rejected: non-extension Origin {:?}", origin);
        return Err(StatusCode::FORBIDDEN);
    }

    // Bearer token must match (constant-time)
    let provided = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .unwrap_or("");
    if provided.as_bytes().ct_eq(state.pair_token.as_bytes()).unwrap_u8() != 1 {
        log::warn!("[cookie_server] rejected: bad pair token");
        return Err(StatusCode::UNAUTHORIZED);
    }

    // Any authenticated request proves the extension is alive — record it here
    // rather than in a handler so /ping counts too.
    state.app_state.lock().await.last_extension_seen = Some(chrono::Utc::now());

    Ok(next.run(req).await)
}

/// An absent Origin is allowed (privileged extension GETs omit it); a present
/// one must be a browser extension, which keeps web pages out.
fn origin_allowed(origin: Option<&str>) -> bool {
    match origin {
        None => true,
        Some(o) => {
            o.starts_with("chrome-extension://")
                || o.starts_with("moz-extension://")
                || o.starts_with("edge-extension://")
        }
    }
}

async fn handle_ping() -> Json<PingResponse> {
    Json(PingResponse {
        ok: true,
        version: env!("CARGO_PKG_VERSION"),
    })
}

async fn handle_cookies(
    State(state): State<ServerState>,
    Json(payload): Json<CookiesPayload>,
) -> Result<Json<CookiesResponse>, StatusCode> {
    let count = payload.cookies.len();
    let netscape = to_netscape(&payload.cookies);
    if let Err(e) = write_cookies_atomic(&state.cookies_path, &netscape) {
        log::error!("[cookie_server] failed to write cookies: {}", e);
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }
    {
        let mut app_state = state.app_state.lock().await;
        app_state.cookie_count = count;
        app_state.last_cookie_sync = Some(chrono::Utc::now());
    }
    log::info!("[cookie_server] received {} cookies", count);
    Ok(Json(CookiesResponse { ok: true, count }))
}

/// Convert browser-extension cookies to Netscape cookies.txt format.
pub fn to_netscape(cookies: &[BrowserCookie]) -> String {
    let mut out = String::from("# Netscape HTTP Cookie File\n");
    out.push_str("# Generated by ViddyPod Agent\n\n");
    for c in cookies {
        let domain_flag = if c.domain.starts_with('.') { "TRUE" } else { "FALSE" };
        let secure_flag = if c.secure { "TRUE" } else { "FALSE" };
        let expiration = c.expiration.map(|e| e as i64).unwrap_or(0);
        // Tab-separated: domain, include_subdomains, path, secure, expiration, name, value
        out.push_str(&format!(
            "{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
            c.domain, domain_flag, c.path, secure_flag, expiration, c.name, c.value
        ));
    }
    out
}

fn write_cookies_atomic(path: &Path, contents: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("txt.tmp");
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn netscape_formats_basic_cookie() {
        let cookies = vec![BrowserCookie {
            name: "SID".into(),
            value: "abc123".into(),
            domain: ".youtube.com".into(),
            path: "/".into(),
            expiration: Some(1_800_000_000.0),
            secure: true,
            http_only: true,
            session: false,
        }];
        let out = to_netscape(&cookies);
        assert!(out.contains(".youtube.com\tTRUE\t/\tTRUE\t1800000000\tSID\tabc123"));
    }

    #[test]
    fn netscape_handles_session_cookie_without_expiration() {
        let cookies = vec![BrowserCookie {
            name: "x".into(),
            value: "y".into(),
            domain: "youtube.com".into(),
            path: "/".into(),
            expiration: None,
            secure: false,
            http_only: false,
            session: true,
        }];
        let out = to_netscape(&cookies);
        assert!(out.contains("youtube.com\tFALSE\t/\tFALSE\t0\tx\ty"));
    }

    #[test]
    fn origin_policy_keeps_pages_out_but_allows_absent_origin() {
        // Chrome omits Origin on privileged extension GETs (e.g. /ping)
        assert!(origin_allowed(None));
        assert!(origin_allowed(Some("chrome-extension://abcdef")));
        assert!(origin_allowed(Some("moz-extension://abcdef")));
        // A web page fetch always carries its own origin — reject it
        assert!(!origin_allowed(Some("https://evil.example")));
        assert!(!origin_allowed(Some("http://127.0.0.1:3000")));
        assert!(!origin_allowed(Some("null")));
    }
}
