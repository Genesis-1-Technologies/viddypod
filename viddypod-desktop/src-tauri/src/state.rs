use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Default)]
pub struct AppState {
    pub token: Option<String>,
    pub email: Option<String>,
    pub processing: bool,
    pub recent_downloads: Vec<RecentDownload>,
    pub pair_token: String,
    pub cookie_count: usize,
    pub last_cookie_sync: Option<DateTime<Utc>>,
    /// Last authenticated request from the extension (ping *or* cookie push).
    /// Liveness must not be inferred from cookie pushes alone — those only
    /// happen when cookies actually change.
    pub last_extension_seen: Option<DateTime<Utc>>,
}

/// How long after the last authenticated extension request we still consider it
/// connected. Must stay comfortably above the extension's heartbeat period
/// (1 min) so a single missed alarm doesn't flap the UI.
const EXTENSION_STALE_AFTER_SECS: i64 = 180;

#[derive(Clone, Serialize, Deserialize)]
pub struct RecentDownload {
    pub title: String,
    pub status: String,
    pub completed_at: String,
}

#[derive(Serialize)]
pub struct Status {
    pub signed_in: bool,
    pub email: Option<String>,
    pub processing: bool,
    pub recent_downloads: Vec<RecentDownload>,
    pub pair_token: String,
    pub extension_connected: bool,
    pub last_cookie_sync: Option<String>,
    pub cookie_count: usize,
}

impl AppState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn to_status(&self) -> Status {
        let extension_connected = self
            .last_extension_seen
            .map(|t| (Utc::now() - t).num_seconds() < EXTENSION_STALE_AFTER_SECS)
            .unwrap_or(false);
        Status {
            signed_in: self.token.is_some(),
            email: self.email.clone(),
            processing: self.processing,
            recent_downloads: self.recent_downloads.clone(),
            pair_token: self.pair_token.clone(),
            extension_connected,
            last_cookie_sync: self.last_cookie_sync.map(|t| t.to_rfc3339()),
            cookie_count: self.cookie_count,
        }
    }

    pub fn add_download(&mut self, title: String, status: String) {
        self.recent_downloads.insert(
            0,
            RecentDownload {
                title,
                status,
                completed_at: Utc::now().to_rfc3339(),
            },
        );
        if self.recent_downloads.len() > 10 {
            self.recent_downloads.truncate(10);
        }
    }
}
