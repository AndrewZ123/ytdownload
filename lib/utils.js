const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

// ==================== Shared Utility Functions ====================

// WARP SOCKS5 proxy for YouTube access from Oracle Cloud
// Auto-detects if WARP is running by checking the SOCKS5 port
// Re-checks periodically so WARP restarts are auto-detected
let _warpAvailable = null;
let _warpLastCheck = 0;
const WARP_CHECK_INTERVAL = 2 * 60 * 1000; // Re-check every 2 minutes

function isWarpAvailable() {
  const now = Date.now();
  if (_warpAvailable !== null && (now - _warpLastCheck) < WARP_CHECK_INTERVAL) return _warpAvailable;
  try {
    execSync('curl -x socks5://127.0.0.1:40000 --connect-timeout 2 -s -o /dev/null https://www.youtube.com', { timeout: 5000 });
    if (!_warpAvailable) console.log('[proxy] ✅ WARP SOCKS5 proxy available on port 40000');
    _warpAvailable = true;
  } catch(_) {
    if (_warpAvailable !== false) console.log('[proxy] ⚠️ WARP SOCKS5 proxy not available, using direct connection');
    _warpAvailable = false;
  }
  _warpLastCheck = now;
  return _warpAvailable;
}

// Re-check WARP availability (call after starting WARP)
function resetWarpCheck() { _warpAvailable = null; _warpLastCheck = 0; }

// Returns yt-dlp proxy args if WARP is available
function getProxyArgs() {
  return isWarpAvailable() ? ['--proxy', 'socks5://127.0.0.1:40000'] : [];
}

function sanitize(name) {
  return name.replace(/[/\\?%*:|"<>]/g, '').replace(/\s+/g, ' ').trim() || 'Untitled';
}

const AUDIO_EXTS = ['.mp3', '.m4a', '.flac', '.wav', '.opus', '.ogg', '.aac'];

function getAudioFiles(dir) {
  try { return fs.readdirSync(dir).filter(f => AUDIO_EXTS.includes(path.extname(f).toLowerCase())); }
  catch (_) { return []; }
}

function buildDownloadArgs(config, dir, format, quality) {
  const fmt = format || config.format || 'mp3';
  const q = quality || config.quality || '0';
  return [
    ...getProxyArgs(),
    '--no-warnings', '-x',
    '--audio-format', fmt,
    '--audio-quality', q,
    '--embed-metadata',
    '--embed-thumbnail',
    '--convert-thumbnails', 'jpg',
    '--parse-metadata', '%(artist)s:%(artist)s',
    '--parse-metadata', '%(album)s:%(album)s',
    '--parse-metadata', '%(track)s:%(track)s',
    '--parse-metadata', '%(release_date)s:%(release_date)s',
    '-o', path.join(dir, '%(title)s.%(ext)s')
  ];
}

// Library cache state (shared across modules)
let libraryCache = null;
let libraryCacheTime = 0;
const LIBRARY_CACHE_TTL = 30000;

function getLibraryCache() { return libraryCache; }
function setLibraryCache(val) { libraryCache = val; libraryCacheTime = Date.now(); }
function clearLibraryCache() { libraryCache = null; }
function isLibraryCacheValid() { return libraryCache && Date.now() - libraryCacheTime < LIBRARY_CACHE_TTL; }

function hashStr(str) {
  return crypto.createHash('md5').update(str).digest('hex').substring(0, 12);
}

module.exports = {
  AUDIO_EXTS,
  getAudioFiles,
  sanitize,
  buildDownloadArgs,
  hashStr,
  getLibraryCache,
  setLibraryCache,
  clearLibraryCache,
  isLibraryCacheValid,
  LIBRARY_CACHE_TTL,
  getProxyArgs,
  isWarpAvailable,
  resetWarpCheck
};
