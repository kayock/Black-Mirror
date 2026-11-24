'use strict';
/** Small shared helpers. Plain Node, no Electron imports. */
const path = require('path');
const os = require('os');

const isWindows = () => process.platform === 'win32';

/** Home directory for user data: %APPDATA%/BlackMirror on Windows. */
function defaultAppDataDir() {
  if (isWindows()) {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'BlackMirror');
  }
  // Non-Windows (development): keep it isolated and predictable.
  return process.env.BLACK_MIRROR_DATA_DIR || path.join(os.homedir(), '.black-mirror');
}

function formatBytes(bytes) {
  if (bytes === undefined || bytes === null || isNaN(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

function withTimeout(promise, ms, label = 'operation') {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms))
  ]);
}

/** Best-effort executable existence check that works for both absolute paths and PATH lookup. */
function findExecutable(filePath, isWin = isWindows()) {
  const fs = require('fs');
  if (!filePath) return null;
  if (path.isAbsolute(filePath) || filePath.includes(isWin ? '\\' : '/')) {
    return fs.existsSync(filePath) ? filePath : null;
  }
  const exts = isWin ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const cand = path.join(dir, filePath + ext);
      try { fs.accessSync(cand, fs.constants.X_OK); return cand; } catch (_) { /* keep looking */ }
    }
  }
  return null;
}

module.exports = { isWindows, defaultAppDataDir, formatBytes, sleep, withTimeout, findExecutable };
