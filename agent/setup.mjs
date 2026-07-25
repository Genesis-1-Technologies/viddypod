#!/usr/bin/env node

/**
 * Vid2Pod Agent Setup
 *
 * Checks system requirements, installs missing dependencies,
 * and configures the local agent for first use.
 *
 * Usage: node agent/setup.mjs
 */

import { execFile, exec } from 'child_process';
import { promisify } from 'util';
import { platform, homedir } from 'os';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { createInterface } from 'readline';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const os = platform(); // 'darwin', 'win32', 'linux'
const isWindows = os === 'win32';
const isMac = os === 'darwin';
const isLinux = os === 'linux';
const configDir = join(homedir(), '.vid2pod');
const configPath = join(configDir, 'config.json');

function log(msg) { console.log(`  ${msg}`); }
function ok(msg) { console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
function warn(msg) { console.log(`  \x1b[33m!\x1b[0m ${msg}`); }
function fail(msg) { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); }
function header(msg) { console.log(`\n\x1b[1m  ${msg}\x1b[0m\n`); }

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`  ${question} `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/// Same as prompt() but suppresses echo, so the password never lands in the
/// terminal scrollback or a screen share.
function promptSecret(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    const onData = (char) => {
      // Stop muting once the line is submitted
      if (['\n', '\r', ''].includes(char.toString())) {
        process.stdin.removeListener('data', onData);
      } else {
        process.stdout.write('\x1b[2K\x1b[200D' + `  ${question} `);
      }
    };
    process.stdin.on('data', onData);
    rl.question(`  ${question} `, (answer) => {
      process.stdin.removeListener('data', onData);
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function commandExists(cmd) {
  try {
    if (isWindows) {
      await execAsync(`where ${cmd}`);
    } else {
      await execAsync(`which ${cmd}`);
    }
    return true;
  } catch {
    return false;
  }
}

async function getVersion(cmd, versionFlag = '--version') {
  try {
    const { stdout } = await execAsync(`${cmd} ${versionFlag}`);
    return stdout.trim().split('\n')[0];
  } catch {
    return null;
  }
}

// ─── Dependency Checks ────────────────────────────

async function checkNode() {
  const version = process.version;
  const major = parseInt(version.slice(1));
  if (major >= 18) {
    ok(`Node.js ${version}`);
    return true;
  }
  fail(`Node.js ${version} — need v18+`);
  return false;
}

async function checkYtDlp() {
  if (await commandExists('yt-dlp')) {
    const version = await getVersion('yt-dlp');
    ok(`yt-dlp ${version}`);
    return true;
  }
  fail('yt-dlp not found');
  return false;
}

async function installYtDlp() {
  log('Installing yt-dlp...');
  try {
    if (isMac) {
      await execAsync('brew install yt-dlp');
    } else if (isWindows) {
      await execAsync('winget install --id yt-dlp.yt-dlp --accept-source-agreements --accept-package-agreements');
    } else {
      // Linux — try pip first, then package manager
      try {
        await execAsync('pip3 install --user yt-dlp');
      } catch {
        await execAsync('sudo apt-get install -y yt-dlp || sudo dnf install -y yt-dlp');
      }
    }
    ok('yt-dlp installed');
    return true;
  } catch (err) {
    fail(`Failed to install yt-dlp: ${err.message}`);
    log('');
    log('Install manually:');
    if (isMac) log('  brew install yt-dlp');
    if (isWindows) log('  winget install yt-dlp');
    if (isLinux) log('  pip3 install yt-dlp');
    return false;
  }
}

async function checkFfmpeg() {
  if (await commandExists('ffmpeg')) {
    const version = await getVersion('ffmpeg', '-version');
    const short = version?.match(/ffmpeg version (\S+)/)?.[1] || version?.slice(0, 40);
    ok(`ffmpeg ${short}`);
    return true;
  }
  fail('ffmpeg not found (optional — server handles transcoding, but yt-dlp may need it)');
  return false;
}

async function installFfmpeg() {
  log('Installing ffmpeg...');
  try {
    if (isMac) {
      await execAsync('brew install ffmpeg');
    } else if (isWindows) {
      await execAsync('winget install --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements');
    } else {
      await execAsync('sudo apt-get install -y ffmpeg || sudo dnf install -y ffmpeg');
    }
    ok('ffmpeg installed');
    return true;
  } catch (err) {
    fail(`Failed to install ffmpeg: ${err.message}`);
    log('');
    log('Install manually:');
    if (isMac) log('  brew install ffmpeg');
    if (isWindows) log('  winget install ffmpeg');
    if (isLinux) log('  sudo apt install ffmpeg');
    return false;
  }
}

async function checkBrowser() {
  // Check if Chrome/Chromium is available for cookie extraction
  const browsers = isWindows
    ? ['chrome', 'msedge']
    : isMac
      ? ['chrome', 'safari', 'firefox']
      : ['chrome', 'chromium', 'firefox'];

  for (const browser of browsers) {
    try {
      // yt-dlp checks browser internally — just verify a browser path exists
      if (isWindows) {
        if (browser === 'chrome') {
          await execAsync('reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe" /ve');
          ok(`Browser: Chrome (cookies will be used for YouTube auth)`);
          return browser;
        }
        if (browser === 'msedge') {
          await execAsync('reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe" /ve');
          ok(`Browser: Edge (cookies will be used for YouTube auth)`);
          return browser;
        }
      } else if (isMac && browser === 'chrome') {
        await execAsync('ls "/Applications/Google Chrome.app"');
        ok(`Browser: Chrome (cookies will be used for YouTube auth)`);
        return browser;
      } else if (isMac && browser === 'safari') {
        ok(`Browser: Safari available as fallback`);
        return browser;
      }
    } catch { /* try next */ }
  }

  warn('No supported browser found for cookie extraction');
  log('  yt-dlp needs browser cookies for YouTube downloads');
  log('  Supported: Chrome, Edge (Windows), Chrome (macOS/Linux)');
  return null;
}

// ─── Configuration ────────────────────────────────

async function loadConfig() {
  try {
    return JSON.parse(await readFile(configPath, 'utf-8'));
  } catch {
    return {};
  }
}

async function saveConfig(config) {
  // This file holds the account password in plaintext, so keep it owner-only.
  // Default umask would leave it 0644 — readable by every user on the box.
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
}

async function configureAgent(detectedBrowser) {
  header('Agent Configuration');

  const config = await loadConfig();

  const server = await prompt(`Server URL [${config.server || 'https://vid2pod.g1tech.cloud'}]:`);
  config.server = server || config.server || 'https://vid2pod.g1tech.cloud';

  const email = await prompt(`Email [${config.email || ''}]:`);
  config.email = email || config.email;

  const password = await promptSecret(`Password (hidden):`);
  if (password) config.password = password;

  const browser = await prompt(`Browser for cookies [${detectedBrowser || config.browser || 'chrome'}]:`);
  config.browser = browser || detectedBrowser || config.browser || 'chrome';

  const interval = await prompt(`Poll interval seconds [${config.interval || '30'}]:`);
  config.interval = interval || config.interval || '30';

  await saveConfig(config);
  ok(`Config saved to ${configPath}`);

  return config;
}

// ─── Verify Connection ───────────────────────────

async function verifyConnection(config) {
  header('Verifying Connection');

  try {
    const healthRes = await fetch(`${config.server}/health`);
    if (!healthRes.ok) throw new Error(`HTTP ${healthRes.status}`);
    ok(`Server reachable: ${config.server}`);
  } catch (err) {
    fail(`Cannot reach server: ${err.message}`);
    return false;
  }

  if (config.email && config.password) {
    try {
      const loginRes = await fetch(`${config.server}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: config.email, password: config.password }),
      });
      if (!loginRes.ok) throw new Error(`HTTP ${loginRes.status}`);
      const data = await loginRes.json();
      ok(`Authenticated as ${data.user.email}`);

      // Check for feed
      const feedsRes = await fetch(`${config.server}/api/v1/feeds`, {
        headers: { 'Authorization': `Bearer ${data.accessToken}` },
      });
      const feeds = await feedsRes.json();
      if (feeds.length > 0) {
        ok(`Feed: ${feeds[0].title}`);
        log(`  ${config.server}/feed/${feeds[0].ownershipToken}.xml`);
      }
    } catch (err) {
      fail(`Login failed: ${err.message}`);
      return false;
    }
  }

  return true;
}

// ─── Main ─────────────────────────────────────────

async function main() {
  console.log('');
  console.log('  \x1b[1mVid2Pod Agent Setup\x1b[0m');
  console.log(`  Platform: ${isMac ? 'macOS' : isWindows ? 'Windows' : 'Linux'}`);

  // Step 1: Check dependencies
  header('Checking Dependencies');

  const nodeOk = await checkNode();
  if (!nodeOk) {
    fail('Node.js 18+ is required. Install from https://nodejs.org');
    process.exit(1);
  }

  let ytdlpOk = await checkYtDlp();
  if (!ytdlpOk) {
    const install = await prompt('Install yt-dlp now? (Y/n):');
    if (install.toLowerCase() !== 'n') {
      ytdlpOk = await installYtDlp();
    }
  }

  let ffmpegOk = await checkFfmpeg();
  if (!ffmpegOk) {
    const install = await prompt('Install ffmpeg? Recommended but optional (Y/n):');
    if (install.toLowerCase() !== 'n') {
      ffmpegOk = await installFfmpeg();
    }
  }

  const browser = await checkBrowser();

  // Step 2: Configure
  const config = await configureAgent(browser);

  // Step 3: Verify
  await verifyConnection(config);

  // Step 4: Show how to run
  header('Setup Complete!');
  log('Your credentials are saved, so just run:\n');
  log(isWindows ? `  node agent\\vid2pod-agent.mjs` : `  node agent/vid2pod-agent.mjs`);
  log('');
  log(`Config: ${configPath} (owner-only)`);
  log('');
  warn('Avoid --password on the command line — it leaks into shell history and `ps`.');

  if (isWindows) {
    log('');
    warn('Windows + Chrome 127 or newer: yt-dlp cannot read Chrome cookies at all.');
    log('  App-Bound encryption blocks it even with Chrome closed (yt-dlp#10927).');
    log('  Export a cookies.txt with a browser extension and point the agent at it:');
    log('');
    log('    node agent\\vid2pod-agent.mjs --cookies C:\\path\\to\\cookies.txt');
    log('');
    log('  Or run the ViddyPod desktop app, which syncs cookies automatically.');
  }

  console.log('');
}

main().catch((err) => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
