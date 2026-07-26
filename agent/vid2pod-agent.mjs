#!/usr/bin/env node

/**
 * Vid2Pod Local Agent
 *
 * Runs on your machine, polls the server for pending YouTube downloads,
 * uses yt-dlp with your browser's cookies to download audio locally,
 * then uploads the result to the server for processing.
 *
 * Usage:
 *   node agent/vid2pod-agent.mjs --server https://vid2pod.g1tech.cloud --email you@email.com --password yourpass
 *
 *   Or set environment variables:
 *     VID2POD_SERVER=https://vid2pod.g1tech.cloud
 *     VID2POD_EMAIL=you@email.com
 *     VID2POD_PASSWORD=yourpass
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, readdir, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { randomUUID } from 'crypto';

const execFileAsync = promisify(execFile);

// Load saved config from ~/.vid2pod/config.json
let savedConfig = {};
try {
  const configPath = join(homedir(), '.vid2pod', 'config.json');
  savedConfig = JSON.parse(await readFile(configPath, 'utf-8'));
} catch { /* no saved config */ }

// Parse args (CLI > env > saved config > defaults)
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const SERVER = getArg('server') || process.env.VID2POD_SERVER || savedConfig.server || 'https://vid2pod.g1tech.cloud';
const EMAIL = getArg('email') || process.env.VID2POD_EMAIL || savedConfig.email;
const PASSWORD = getArg('password') || process.env.VID2POD_PASSWORD || savedConfig.password;
const POLL_INTERVAL = parseInt(getArg('interval') || process.env.VID2POD_POLL_INTERVAL || savedConfig.interval || '30', 10) * 1000;
const BROWSER = getArg('browser') || process.env.VID2POD_BROWSER || savedConfig.browser || 'chrome';
// Explicit Netscape cookies.txt. Preferred over --cookies-from-browser, which
// cannot read Chrome cookies on Windows since Chrome 127 introduced App-Bound
// encryption (yt-dlp#10927). Export one with a cookies.txt browser extension.
const COOKIES_FILE = getArg('cookies') || process.env.VID2POD_COOKIES || savedConfig.cookies || null;

if (!EMAIL || !PASSWORD) {
  console.error('Usage: vid2pod-agent --server URL --email EMAIL --password PASSWORD');
  console.error('  Or set VID2POD_SERVER, VID2POD_EMAIL, VID2POD_PASSWORD environment variables');
  process.exit(1);
}

let token = null;

function log(msg, data) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`, data ? JSON.stringify(data) : '');
}

async function login() {
  const res = await fetch(`${SERVER}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status}`);
  const data = await res.json();
  token = data.accessToken;
  log('Logged in', { email: EMAIL });
}

async function apiFetch(path, options = {}, retryOnAuthFail = true) {
  const res = await fetch(`${SERVER}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      'Authorization': `Bearer ${token}`,
    },
  });
  // Re-login once on 401. Without the flag a permanently-rejected credential
  // (revoked user, clock skew) recurses forever, hammering /auth/login.
  if (res.status === 401 && retryOnAuthFail) {
    await login();
    return apiFetch(path, options, false);
  }
  return res;
}

async function getPendingDownloads() {
  const res = await apiFetch('/api/v1/agent/pending');
  // Don't mask server errors as "nothing to do" — the poll loop logs these.
  if (!res.ok) throw new Error(`Cannot fetch pending downloads: HTTP ${res.status}`);
  return res.json();
}

/// Tell the server a download can never succeed, so it stops being handed back
/// on every poll. Best-effort: a failure here just means we retry next cycle.
async function reportFailure(assetId, message) {
  try {
    const res = await apiFetch(`/api/v1/agent/failed/${assetId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: String(message).slice(0, 500) }),
    });
    if (!res.ok) log('Could not report failure', { assetId, status: res.status });
  } catch (err) {
    log('Could not report failure', { assetId, error: err.message });
  }
}

async function downloadAudio(videoId) {
  const workDir = join(tmpdir(), `vid2pod-local-${randomUUID()}`);
  await mkdir(workDir, { recursive: true });

  const outputTemplate = join(workDir, '%(id)s.%(ext)s');

  log('Downloading', { videoId });

  await execFileAsync('yt-dlp', [
    '--extract-audio',
    '--audio-format', 'mp3',
    '--audio-quality', '0',
    '--output', outputTemplate,
    '--write-info-json',
    '--no-playlist',
    '--no-overwrites',
    '--no-update',
    '--js-runtimes', 'deno',
    '--js-runtimes', 'node',
    '--remote-components', 'ejs:github',
    ...(COOKIES_FILE ? ['--cookies', COOKIES_FILE] : ['--cookies-from-browser', BROWSER]),
    `https://www.youtube.com/watch?v=${videoId}`,
  ], {
    cwd: workDir,
    timeout: 600_000, // 10 min
  });

  const files = await readdir(workDir);
  const audioFile = files.find(f => f.endsWith('.mp3'));
  const infoFile = files.find(f => f.endsWith('.info.json'));

  if (!audioFile) throw new Error('yt-dlp did not produce an mp3 file');

  let metadata = { title: videoId, description: '', duration: 0, thumbnail: null };
  if (infoFile) {
    const raw = JSON.parse(await readFile(join(workDir, infoFile), 'utf-8'));
    metadata = {
      title: raw.title || videoId,
      description: raw.description || '',
      duration: raw.duration || 0,
      thumbnail: raw.thumbnail || null,
    };
  }

  const audioPath = join(workDir, audioFile);
  log('Downloaded', { videoId, title: metadata.title, duration: metadata.duration });

  return { audioPath, workDir, metadata };
}

async function uploadAudio(assetId, audioPath, metadata) {
  const audioBuffer = await readFile(audioPath);
  const filename = audioPath.split('/').pop();

  // Build multipart form data
  const formData = new FormData();
  formData.append('file', new Blob([audioBuffer], { type: 'audio/mpeg' }), filename);
  formData.append('title', metadata.title);
  formData.append('description', metadata.description || metadata.title);
  formData.append('duration', String(metadata.duration || 0));
  if (metadata.thumbnail) {
    formData.append('thumbnail', metadata.thumbnail);
  }

  log('Uploading', { assetId, title: metadata.title, size: audioBuffer.length });

  const res = await apiFetch(`/api/v1/agent/upload/${assetId}`, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Upload failed: ${res.status} ${err.message || ''}`);
  }

  const result = await res.json();
  log('Uploaded', { assetId, status: result.status });
  return result;
}

// Per-asset attempt counter. Transient failures (network blip, YouTube hiccup)
// deserve a retry; a video that fails MAX_ATTEMPTS times in a row is reported
// failed so the server stops handing it back forever. In-memory on purpose —
// a restart is a reasonable "try again".
const attempts = new Map();
const MAX_ATTEMPTS = 3;

async function processOne(asset) {
  const videoId = asset.youtubeVideoId;
  if (!videoId) {
    log('Skipping asset without videoId', { assetId: asset.id });
    return;
  }

  try {
    const { audioPath, workDir, metadata } = await downloadAudio(videoId);
    await uploadAudio(asset.id, audioPath, metadata);
    // Cleanup temp dir
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    attempts.delete(asset.id);
  } catch (err) {
    const n = (attempts.get(asset.id) || 0) + 1;
    attempts.set(asset.id, n);
    log('Failed', { videoId, attempt: `${n}/${MAX_ATTEMPTS}`, error: err.message });
    if (n >= MAX_ATTEMPTS) {
      log('Giving up, marking failed', { videoId });
      await reportFailure(asset.id, err.message);
      attempts.delete(asset.id);
    }
  }
}

async function poll() {
  try {
    const pending = await getPendingDownloads();
    if (pending.length > 0) {
      log(`Found ${pending.length} pending download(s)`);
      for (const asset of pending) {
        await processOne(asset);
      }
    }
  } catch (err) {
    log('Poll error', { error: err.message });
  }
}

// Main
async function main() {
  console.log('');
  console.log('  Vid2Pod Local Agent');
  console.log(`  Server:   ${SERVER}`);
  console.log(`  Cookies:  ${COOKIES_FILE ? COOKIES_FILE : `${BROWSER} (browser)`}`);
  console.log(`  Interval: ${POLL_INTERVAL / 1000}s`);
  console.log('');

  await login();

  // Initial poll
  await poll();

  // Continue polling
  setInterval(poll, POLL_INTERVAL);
  log(`Polling every ${POLL_INTERVAL / 1000}s — keep this running`);
}

main().catch((err) => {
  console.error('Agent failed to start:', err.message);
  process.exit(1);
});
