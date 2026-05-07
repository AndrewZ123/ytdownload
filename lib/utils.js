const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ==================== Shared Utility Functions ====================

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
  LIBRARY_CACHE_TTL
};
