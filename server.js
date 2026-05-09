const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== Config ====================
const CONFIG_PATH = path.join(__dirname, 'config.json');
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (_) { return { apiKey: crypto.randomBytes(16).toString('hex'), format: 'mp3', quality: '0', smartPlaylists: [] }; }
}
function saveConfig(cfg) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); }

let config = loadConfig();
if (!config.apiKey) { config.apiKey = crypto.randomBytes(16).toString('hex'); saveConfig(config); }

// ==================== Directories ====================
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

// ==================== Middleware ====================
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));

// CORS - allow iOS app and other clients to connect
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Range');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// API key middleware for external access
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.apiKey;
  if (key === config.apiKey) return next();
  const rawIp = req.ip || req.connection.remoteAddress || '';
  const remoteIp = rawIp.replace(/^::ffff:/, '');
  const isPrivate = remoteIp === '127.0.0.1' || remoteIp === '::1' || rawIp === '::1' ||
    remoteIp.startsWith('192.168.') || remoteIp.startsWith('10.') || remoteIp.startsWith('172.') ||
    remoteIp.startsWith('::ffff:10.') || remoteIp.startsWith('::ffff:192.168.') || remoteIp.startsWith('::ffff:172.');
  if (isPrivate) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Invalid API key. Pass ?apiKey= or X-API-Key header.' });
  next();
}

// Public health endpoint — must be BEFORE requireApiKey so it's accessible without auth
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', apiKey: config.apiKey });
});

app.use('/api/', requireApiKey);

// ==================== Shared Dependencies ====================
const utils = require('./lib/utils');

// Bind buildDownloadArgs so routes can call buildDownloadArgs(dir, format, quality)
const buildDownloadArgs = (dir, format, quality) => utils.buildDownloadArgs(config, dir, format, quality);

const deps = {
  config,
  downloadsDir,
  buildDownloadArgs,
  getAudioFiles: utils.getAudioFiles,
  sanitize: utils.sanitize,
  AUDIO_EXTS: utils.AUDIO_EXTS,
  saveConfig,
  hashStr: utils.hashStr,
  getLibraryCache: utils.getLibraryCache,
  setLibraryCache: utils.setLibraryCache,
  clearLibraryCache: utils.clearLibraryCache,
  isLibraryCacheValid: utils.isLibraryCacheValid,
  getProxyArgs: utils.getProxyArgs,
};

// ==================== Load Route Modules ====================
require('./routes/download')(app, deps);
require('./routes/spotify')(app, deps);
require('./routes/settings')(app, deps);
require('./routes/playlists')(app, deps);
require('./routes/library')(app, deps);
require('./routes/discovery')(app, deps);
require('./routes/music-api')(app, deps);
require('./routes/streaming')(app, deps);

// ==================== Start Server ====================
app.listen(PORT, () => {
  console.log(`🎵 YouTube Music Downloader`);
  console.log(`   Open http://localhost:${PORT}`);
  console.log(`   🎧 Music Player: http://localhost:${PORT}/player`);
  console.log(`   API Key: ${config.apiKey}`);
});