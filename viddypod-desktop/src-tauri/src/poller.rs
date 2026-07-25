use crate::downloader;
use crate::state::AppState;
use crate::uploader;
use crate::SERVER_URL;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

#[derive(Deserialize, Debug)]
struct PendingAsset {
    id: String,
    #[serde(rename = "youtubeVideoId")]
    youtube_video_id: Option<String>,
}

const POLL_INTERVAL: Duration = Duration::from_secs(15);
/// Consecutive failures before we tell the server to stop handing an asset
/// back. Transient errors deserve a retry; a permanently-broken video would
/// otherwise be re-downloaded every 15s forever.
const MAX_ATTEMPTS: u32 = 3;

pub async fn run_poller(app: AppHandle, state: Arc<Mutex<AppState>>) {
    log::info!("Poller started");

    // Consecutive failures per asset id. In-memory on purpose — restarting the
    // app is a reasonable "try again".
    let mut attempts: HashMap<String, u32> = HashMap::new();

    loop {
        let token = {
            let s = state.lock().await;
            s.token.clone()
        };

        let Some(token) = token else {
            // No token yet — wait briefly before checking again so a fresh
            // sign-in is picked up within 1 second instead of 30.
            tokio::time::sleep(Duration::from_secs(1)).await;
            continue;
        };

        match fetch_pending(&token).await {
            Ok(pending) => {
                if !pending.is_empty() {
                    log::info!("Found {} pending download(s)", pending.len());
                    for asset in pending {
                        if let Some(video_id) = asset.youtube_video_id.clone() {
                            // Mark as processing
                            {
                                let mut s = state.lock().await;
                                s.processing = true;
                            }
                            app.emit("status-updated", ()).ok();

                            match process_one(&app, &token, &asset.id, &video_id).await {
                                Ok(title) => {
                                    attempts.remove(&asset.id);
                                    let mut s = state.lock().await;
                                    s.add_download(title, "Uploaded".to_string());
                                    s.processing = false;
                                }
                                Err(e) => {
                                    let n = attempts.entry(asset.id.clone()).or_insert(0);
                                    *n += 1;
                                    let n = *n;
                                    log::error!(
                                        "Failed to process {} (attempt {}/{}): {}",
                                        video_id, n, MAX_ATTEMPTS, e
                                    );
                                    if n >= MAX_ATTEMPTS {
                                        report_failure(&token, &asset.id, &e.to_string()).await;
                                        attempts.remove(&asset.id);
                                    }
                                    let mut s = state.lock().await;
                                    s.add_download(video_id.clone(), format!("Failed: {}", e));
                                    s.processing = false;
                                }
                            }
                            app.emit("status-updated", ()).ok();
                        }
                    }
                }
            }
            Err(e) => {
                log::warn!("Poll failed: {}", e);
            }
        }

        // Sleep until the next poll interval
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

async fn fetch_pending(token: &str) -> anyhow::Result<Vec<PendingAsset>> {
    let url = format!("{}/api/v1/agent/pending", SERVER_URL);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()?;
    let res = match client.get(&url).bearer_auth(token).send().await {
        Ok(res) => res,
        Err(e) => anyhow::bail!("Cannot reach ViddyPod server: {}", e),
    };
    if !res.status().is_success() {
        let code = res.status().as_u16();
        if code == 502 || code == 503 || code == 504 {
            anyhow::bail!("ViddyPod server is temporarily unavailable (HTTP {})", code);
        }
        anyhow::bail!("HTTP {}", code);
    }
    let assets: Vec<PendingAsset> = res.json().await?;
    Ok(assets)
}

/// Tell the server this asset can't be downloaded so it stops being returned by
/// /agent/pending. Best-effort — on error we just retry next cycle.
async fn report_failure(token: &str, asset_id: &str, error: &str) {
    let url = format!("{}/api/v1/agent/failed/{}", SERVER_URL, asset_id);
    let truncated: String = error.chars().take(500).collect();
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            log::warn!("Could not build client to report failure: {}", e);
            return;
        }
    };
    match client
        .post(&url)
        .bearer_auth(token)
        .json(&serde_json::json!({ "error": truncated }))
        .send()
        .await
    {
        Ok(res) if res.status().is_success() => {
            log::info!("Reported {} as failed", asset_id);
        }
        Ok(res) => log::warn!("Failed to report {}: HTTP {}", asset_id, res.status()),
        Err(e) => log::warn!("Failed to report {}: {}", asset_id, e),
    }
}

async fn process_one(
    app: &AppHandle,
    token: &str,
    asset_id: &str,
    video_id: &str,
) -> anyhow::Result<String> {
    let download = downloader::download_audio(app, video_id).await?;
    let title = download
        .metadata
        .title
        .clone()
        .unwrap_or_else(|| video_id.to_string());

    uploader::upload_audio(SERVER_URL, token, asset_id, &download).await?;

    // Cleanup temp dir
    let _ = std::fs::remove_dir_all(&download.work_dir);

    Ok(title)
}
