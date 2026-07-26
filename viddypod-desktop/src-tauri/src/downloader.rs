use anyhow::{anyhow, Result};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

#[derive(Deserialize, Debug)]
pub struct VideoMetadata {
    pub title: Option<String>,
    pub description: Option<String>,
    pub duration: Option<f64>,
    pub thumbnail: Option<String>,
}

pub struct DownloadResult {
    pub audio_path: PathBuf,
    pub work_dir: PathBuf,
    pub metadata: VideoMetadata,
}

/// Locate the bundled node binary (if present).
/// On Windows, node is bundled as an externalBin sidecar. It lives in the same
/// directory as the main executable. Returns the exe directory so it can be
/// added to PATH for yt-dlp to find node.
fn get_bundled_node_dir(app: &AppHandle) -> Option<String> {
    if let Ok(exe_dir) = app.path().resource_dir() {
        let node_candidates = ["node.exe", "node"];
        for name in &node_candidates {
            if exe_dir.join(name).exists() {
                return exe_dir.to_str().map(|s| s.to_string());
            }
        }
    }
    None
}

/// Build a PATH env value with platform-appropriate locations prepended so
/// yt-dlp can always find a node binary for the JS challenge solver.
fn build_enriched_path(app: &AppHandle) -> String {
    let mut components: Vec<String> = Vec::new();

    // Bundled node.exe directory (Windows sidecar)
    if let Some(p) = get_bundled_node_dir(app) {
        components.push(p);
    }

    // Common Unix locations for node (macOS Homebrew + system)
    if cfg!(unix) {
        components.push("/opt/homebrew/bin".to_string());
        components.push("/usr/local/bin".to_string());
        components.push("/usr/bin".to_string());
        components.push("/bin".to_string());
    }

    // Existing PATH at the end
    if let Ok(p) = std::env::var("PATH") {
        components.push(p);
    }

    let separator = if cfg!(windows) { ";" } else { ":" };
    components.join(separator)
}

/// Path to the Netscape cookies.txt written by the cookie-bridge server.
/// Lives in the user's local app data dir, shared between the cookie server
/// (writer) and the downloader (reader).
pub fn get_cookies_txt_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("cookies.txt")
}

/// Heuristic: does this yt-dlp error indicate cookies / a fresher binary may help?
fn is_cookie_retryable_error(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("sign in to confirm")
        || lower.contains("age-restricted")
        || lower.contains("login required")
        || lower.contains("requires authentication")
        || lower.contains("members-only")
        || lower.contains("private video")
        || lower.contains("this video is available to this channel's members")
        || lower.contains("confirm your age")
        || lower.contains("inappropriate for some users")
        // YouTube frequently returns 403 on media URLs when the extractor is
        // stale or when SABR/PO-token gates kick in; cookies often unlock
        // working formats.
        || lower.contains("http error 403")
        || lower.contains("403: forbidden")
}

/// Produce a friendly error message from yt-dlp's stderr when we've exhausted
/// all download paths.
fn humanize_final_error(stderr: &str) -> String {
    let lower = stderr.to_lowercase();
    if is_cookie_retryable_error(&lower) {
        return "YouTube blocked the download. Install the ViddyPod browser extension and pair it to sync cookies, then retry. If cookies are already synced, update the desktop agent (bundled yt-dlp must stay current).".to_string();
    }
    if lower.contains("video unavailable") || lower.contains("removed by the uploader") {
        return "This video is unavailable (removed, region-blocked, or made private).".to_string();
    }
    if lower.contains("n challenge solving failed")
        || lower.contains("requested format is not available")
    {
        return "YouTube's JavaScript challenge could not be solved. Make sure node is installed and accessible.".to_string();
    }
    format!("yt-dlp failed: {}", stderr.trim())
}

/// Download audio for a YouTube video. Tries cookieless first; if yt-dlp
/// reports an auth/403 failure, retries with a cookies.txt file if one
/// has been written by the cookie-bridge server.
///
/// This supersedes the old `--cookies-from-browser` flow which became
/// unreliable on Windows after Chrome 127+ introduced AppBound cookie
/// encryption (see yt-dlp#10927). The cookie-bridge browser extension pushes
/// cookies here via localhost HTTP, avoiding the AppBound lock entirely.
pub async fn download_audio(app: &AppHandle, video_id: &str) -> Result<DownloadResult> {
    match run_yt_dlp(app, video_id, None).await {
        Ok(result) => Ok(result),
        Err(e) => {
            let msg = e.to_string();
            if is_cookie_retryable_error(&msg) {
                log::info!("Cookieless download blocked, retrying with cookies.txt");
                let cookies_path = get_cookies_txt_path(app);
                if cookies_path.exists() {
                    return run_yt_dlp(app, video_id, Some(&cookies_path)).await;
                }
                return Err(anyhow!(
                    "YouTube blocked the download. Install the ViddyPod browser extension and pair it to sync cookies, then retry."
                ));
            }
            Err(e)
        }
    }
}

/// Run a single yt-dlp invocation with optional cookies file. Does all the
/// workdir management, stderr capture, and info.json parsing.
async fn run_yt_dlp(
    app: &AppHandle,
    video_id: &str,
    cookies_file: Option<&Path>,
) -> Result<DownloadResult> {
    let work_dir = std::env::temp_dir().join(format!("viddypod-{}", unique_id()));
    std::fs::create_dir_all(&work_dir)?;

    // The caller only cleans up on success, so every failure path in here would
    // otherwise orphan the temp dir — one per attempt, forever, for any video
    // YouTube keeps refusing.
    match run_yt_dlp_in(app, video_id, cookies_file, &work_dir).await {
        Ok(result) => Ok(result),
        Err(e) => {
            let _ = std::fs::remove_dir_all(&work_dir);
            Err(e)
        }
    }
}

async fn run_yt_dlp_in(
    app: &AppHandle,
    video_id: &str,
    cookies_file: Option<&Path>,
    work_dir: &Path,
) -> Result<DownloadResult> {
    let output_template = work_dir
        .join("%(id)s.%(ext)s")
        .to_string_lossy()
        .to_string();
    let url = format!("https://www.youtube.com/watch?v={}", video_id);

    log::info!(
        "Downloading {} (cookies: {})",
        video_id,
        if cookies_file.is_some() { "yes" } else { "no" }
    );

    let enriched_path = build_enriched_path(app);
    log::debug!("yt-dlp PATH: {}", enriched_path);

    let mut args: Vec<String> = vec![
        "--extract-audio".into(),
        "--audio-format".into(),
        "mp3".into(),
        "--audio-quality".into(),
        "0".into(),
        "--output".into(),
        output_template.clone(),
        "--write-info-json".into(),
        "--no-playlist".into(),
        "--no-overwrites".into(),
        // Bundled binary can't self-update; suppress the 90-day age warning
        // that otherwise pollutes user-facing errors.
        "--no-update".into(),
        // Required for YouTube JS n-sig challenges. Prefer deno when present
        // (Homebrew installs it alongside yt-dlp); fall back to node (bundled
        // on Windows, system node on macOS/Linux via enriched PATH).
        "--js-runtimes".into(),
        "deno".into(),
        "--js-runtimes".into(),
        "node".into(),
        "--remote-components".into(),
        "ejs:github".into(),
    ];
    if let Some(path) = cookies_file {
        args.push("--cookies".into());
        args.push(path.to_string_lossy().to_string());
    }
    args.push(url);

    let shell = app.shell();
    let (mut rx, _child) = shell
        .sidecar("yt-dlp")?
        .env("PATH", enriched_path)
        .args(args)
        .spawn()?;

    let mut stderr_buf = String::new();
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                log::debug!("[yt-dlp stdout] {}", String::from_utf8_lossy(&line));
            }
            CommandEvent::Stderr(line) => {
                let s = String::from_utf8_lossy(&line);
                log::debug!("[yt-dlp stderr] {}", s);
                stderr_buf.push_str(&s);
                stderr_buf.push('\n');
            }
            CommandEvent::Terminated(payload) => {
                if payload.code.unwrap_or(-1) != 0 {
                    return Err(anyhow!("{}", humanize_final_error(&stderr_buf)));
                }
                break;
            }
            _ => {}
        }
    }

    // Find the output mp3 and info.json
    let mut audio_path = None;
    let mut info_path = None;
    for entry in std::fs::read_dir(work_dir)? {
        let entry = entry?;
        let path = entry.path();
        if let Some(ext) = path.extension() {
            if ext == "mp3" {
                audio_path = Some(path.clone());
            } else if path.to_string_lossy().ends_with(".info.json") {
                info_path = Some(path.clone());
            }
        }
    }

    let audio_path = audio_path.ok_or_else(|| anyhow!("yt-dlp did not produce an mp3 file"))?;

    let metadata = if let Some(info_path) = info_path {
        let raw = std::fs::read_to_string(&info_path)?;
        let json: serde_json::Value = serde_json::from_str(&raw)?;
        VideoMetadata {
            title: json.get("title").and_then(|v| v.as_str()).map(String::from),
            description: json
                .get("description")
                .and_then(|v| v.as_str())
                .map(String::from),
            duration: json.get("duration").and_then(|v| v.as_f64()),
            thumbnail: json.get("thumbnail").and_then(|v| v.as_str()).map(String::from),
        }
    } else {
        VideoMetadata {
            title: Some(video_id.to_string()),
            description: None,
            duration: None,
            thumbnail: None,
        }
    };

    log::info!("Download complete: {:?}", metadata.title);

    Ok(DownloadResult {
        audio_path,
        work_dir: work_dir.to_path_buf(),
        metadata,
    })
}

fn unique_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}", nanos)
}
