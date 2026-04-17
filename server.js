const express = require('express');
const { execFile, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');

const app = express();
const PORT = 3000;

// Config file for settings, smart playlists, API keys
const CONFIG_PATH = path.join(__dirname, 'config.json');
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (_) { return { apiKey: crypto.randomBytes(16).toString('hex'), format: 'mp3', quality: '0', smartPlaylists: [] }; }
}
function saveConfig(cfg) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); }

let config = loadConfig();
if (!config.apiKey) { config.apiKey = crypto.randomBytes(16).toString('hex'); saveConfig(config); }

// Ensure dirs exist
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));

// API key middleware for external access
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.apiKey;
  if (key === config.apiKey) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Invalid API key. Pass ?apiKey= or X-API-Key header.' });
  next(); // Allow browser access without key
}

app.use('/api/', requireApiKey);

// Helpers
function sanitize(name) {
  return name.replace(/[/\\?%*:|"<>]/g, '').replace(/\s+/g, ' ').trim() || 'Untitled';
}

const AUDIO_EXTS = ['.mp3', '.m4a', '.flac', '.wav', '.opus', '.ogg', '.aac'];

function getAudioFiles(dir) {
  try { return fs.readdirSync(dir).filter(f => AUDIO_EXTS.includes(path.extname(f).toLowerCase())); }
  catch (_) { return []; }
}

function buildDownloadArgs(dir, format, quality) {
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

// ==================== FEATURE 1: Batch URL Download ====================
app.post('/api/batch-download', (req, res) => {
  const { urls, playlistName, format, quality } = req.body;
  if (!urls || !Array.isArray(urls) || urls.length === 0 || !playlistName) {
    return res.status(400).json({ error: 'Missing urls or playlistName' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const playlistDir = path.join(downloadsDir, sanitize(playlistName));
  fs.mkdirSync(playlistDir, { recursive: true });

  // Resolve URLs: if it's a playlist URL, expand it; otherwise treat as single video
  const resolveUrl = (url, cb) => {
    const args = ['-J', '--flat-playlist', '--no-warnings', url];
    execFile('yt-dlp', args, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout) => {
      if (err) return cb([{ url, title: url }]);
      try {
        const data = JSON.parse(stdout);
        if (data.entries && data.entries.length > 0) {
          return cb(data.entries.map(e => ({
            url: e.id ? `https://www.youtube.com/watch?v=${e.id}` : url,
            title: e.title || 'Unknown'
          })));
        }
        cb([{ url, title: data.title || url }]);
      } catch (_) { cb([{ url, title: url }]); }
    });
  };

  // Process all URLs in parallel to resolve, then flatten
  let pending = urls.length;
  const allTracks = [];

  urls.forEach(url => {
    resolveUrl(url, (tracks) => {
      allTracks.push(...tracks);
      if (--pending === 0) {
        send('playlist', { total: allTracks.length, playlistTitle: playlistName });
        let current = 0;
        const dlNext = () => {
          if (current >= allTracks.length) {
            send('done', { message: `All ${allTracks.length} tracks downloaded!`, playlistTitle: playlistName });
            return res.end();
          }
          const track = allTracks[current++];
          send('progress', { current, total: allTracks.length, title: track.title, status: 'downloading' });
          const dlArgs = [...buildDownloadArgs(playlistDir, format, quality), track.url];
          execFile('yt-dlp', dlArgs, { maxBuffer: 10 * 1024 * 1024 }, (err) => {
            send('progress', { current, total: allTracks.length, title: track.title, status: err ? 'error' : 'done' });
            dlNext();
          });
        };
        dlNext();
      }
    });
  });
});

// ==================== FEATURE 2: Spotify Playlist Import ====================
app.get('/api/spotify-playlist', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing Spotify URL' });

  // Extract playlist ID from Spotify URL
  const match = url.match(/playlist\/([a-zA-Z0-9]+)/);
  if (!match) return res.status(400).json({ error: 'Invalid Spotify playlist URL' });

  const playlistId = match[1];
  const embedUrl = `https://open.spotify.com/embed/playlist/${playlistId}`;

  // Use yt-dlp to get info from the Spotify embed (it supports Spotify)
  const args = ['-J', '--flat-playlist', '--no-warnings', embedUrl];
  execFile('yt-dlp', args, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout) => {
    if (err) {
      console.error('Spotify error:', err.message);
      return res.status(500).json({ error: 'Failed to fetch Spotify playlist. yt-dlp may need spotDL plugin.' });
    }
    try {
      const data = JSON.parse(stdout);
      const title = data.title || 'Spotify Playlist';
      const entries = data.entries || [];
      const tracks = entries.map((e, i) => ({
        index: i + 1,
        title: e.title || 'Unknown',
        id: e.id || e.url || '',
        duration: e.duration || null,
        artist: e.uploader || e.channel || ''
      }));
      res.json({ title, count: tracks.length, tracks });
    } catch (e) {
      res.status(500).json({ error: 'Failed to parse Spotify playlist data.' });
    }
  });
});

// ==================== FEATURE 3: Audio Format/Quality Settings ====================
app.get('/api/settings', (req, res) => {
  res.json({ format: config.format || 'mp3', quality: config.quality || '0', apiKey: config.apiKey });
});

app.put('/api/settings', (req, res) => {
  const { format, quality } = req.body;
  if (format) config.format = format;
  if (quality !== undefined) config.quality = quality;
  saveConfig(config);
  res.json({ success: true, format: config.format, quality: config.quality });
});

// ==================== FEATURE 4: Metadata Editor ====================
app.get('/api/file-metadata', (req, res) => {
  const { playlist, file } = req.query;
  if (!playlist || !file) return res.status(400).json({ error: 'Missing playlist or file' });

  const filePath = path.join(downloadsDir, playlist, file);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  // Use ffprobe to get metadata
  execFile('ffprobe', ['-hide_banner', '-print_format', 'json', '-show_format', filePath], { maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
    if (err) return res.status(500).json({ error: 'Failed to read metadata' });
    try {
      const data = JSON.parse(stdout);
      const fmt = data.format || {};
      const tags = fmt.tags || {};
      res.json({
        file,
        playlist,
        title: tags.title || path.parse(file).name,
        artist: tags.artist || tags.ARTIST || '',
        album: tags.album || tags.ALBUM || '',
        genre: tags.genre || tags.GENRE || '',
        date: tags.date || tags.DATE || tags.year || '',
        duration: fmt.duration ? parseFloat(fmt.duration) : 0,
        size: fmt.size ? parseInt(fmt.size) : 0
      });
    } catch (_) { res.status(500).json({ error: 'Failed to parse metadata' }); }
  });
});

app.put('/api/file-metadata', (req, res) => {
  const { playlist, file, title, artist, album, genre, date } = req.body;
  if (!playlist || !file) return res.status(400).json({ error: 'Missing playlist or file' });

  const filePath = path.join(downloadsDir, playlist, file);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  // Use ffmpeg to write metadata
  const tmpFile = filePath + '.tmp' + path.extname(filePath);
  const args = ['-i', filePath, '-metadata', `title=${title || ''}`, '-metadata', `artist=${artist || ''}`,
    '-metadata', `album=${album || ''}`, '-metadata', `genre=${genre || ''}`, '-metadata', `date=${date || ''}`,
    '-codec', 'copy', '-y', tmpFile];

  execFile('ffmpeg', args, { maxBuffer: 10 * 1024 * 1024 }, (err) => {
    if (err) return res.status(500).json({ error: 'Failed to update metadata: ' + err.message });
    try {
      fs.renameSync(tmpFile, filePath);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to save file' });
    }
  });
});

// ==================== Playlist Info (original) ====================
app.get('/api/playlist-info', (req, res) => {
  const playlistUrl = req.query.url;
  if (!playlistUrl) return res.status(400).json({ error: 'Missing playlist URL' });

  // Use --flat-playlist for speed, but also try to get richer metadata
  const args = ['-J', '--flat-playlist', '--no-warnings', '--extractor-args', 'youtube:player_client=web_music', playlistUrl];
  execFile('yt-dlp', args, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch playlist info.' });
    try {
      const data = JSON.parse(stdout);
      const entries = data.entries || [];
      res.json({
        title: data.title || 'Untitled Playlist',
        count: entries.length,
        tracks: entries.map((e, i) => ({
          index: i + 1,
          title: e.title || 'Unknown',
          id: e.id || e.url || '',
          duration: e.duration || null,
          artist: e.uploader || e.channel || e.artist || '',
          album: e.album || '',
          thumbnail: (e.thumbnails && e.thumbnails.length > 0) ? e.thumbnails[e.thumbnails.length - 1].url : ''
        }))
      });
    } catch (_) { res.status(500).json({ error: 'Failed to parse playlist data.' }); }
  });
});

// ==================== SSE Download (modified for format/quality) ====================
app.get('/api/download', (req, res) => {
  const playlistUrl = req.query.url;
  const format = req.query.format;
  const quality = req.query.quality;
  if (!playlistUrl) return res.status(400).json({ error: 'Missing playlist URL' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  execFile('yt-dlp', ['-J', '--flat-playlist', '--no-warnings', playlistUrl], { maxBuffer: 50 * 1024 * 1024 }, (err, stdout) => {
    if (err) { send('error', { message: 'Failed to fetch playlist info.' }); return res.end(); }

    let playlistTitle, tracks;
    try {
      const data = JSON.parse(stdout);
      playlistTitle = sanitize(data.title || 'Untitled Playlist');
      tracks = (data.entries || []).map((e, i) => ({ index: i + 1, title: e.title || 'Unknown', id: e.id || e.url || '' }));
    } catch (_) { send('error', { message: 'Parse error.' }); return res.end(); }

    const playlistDir = path.join(downloadsDir, playlistTitle);
    fs.mkdirSync(playlistDir, { recursive: true });
    send('playlist', { total: tracks.length, playlistTitle });

    let current = 0;
    const dlNext = () => {
      if (current >= tracks.length) { send('done', { message: `All ${tracks.length} tracks downloaded!`, playlistTitle }); return res.end(); }
      const track = tracks[current++];
      const videoUrl = track.id ? `https://www.youtube.com/watch?v=${track.id}` : playlistUrl;
      send('progress', { current, total: tracks.length, title: track.title, status: 'downloading' });
      execFile('yt-dlp', [...buildDownloadArgs(playlistDir, format, quality), videoUrl], { maxBuffer: 10 * 1024 * 1024 }, (err) => {
        send('progress', { current, total: tracks.length, title: track.title, status: err ? 'error' : 'done' });
        dlNext();
      });
    };
    dlNext();
  });
});

// ==================== Downloaded Playlists (Feature 12: enhanced) ====================
app.get('/api/downloaded-playlists', (req, res) => {
  try {
    const entries = fs.readdirSync(downloadsDir, { withFileTypes: true });
    const playlists = [];
    const allFiles = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(downloadsDir, entry.name);
      const files = getAudioFiles(dirPath);
      if (files.length > 0) {
        const trackInfo = files.map(f => {
          const fp = path.join(dirPath, f);
          let stat;
          try { stat = fs.statSync(fp); } catch (_) { stat = { size: 0, mtime: new Date() }; }
          return { name: f, displayName: path.parse(f).name, size: stat.size, modified: stat.mtime, ext: path.extname(f).toLowerCase() };
        });
        playlists.push({ name: entry.name, trackCount: files.length, tracks: trackInfo });
        trackInfo.forEach(t => allFiles.push({ ...t, playlist: entry.name }));
      }
    }

    // Feature 14: Duplicate detection
    const nameMap = {};
    allFiles.forEach(f => {
      const key = f.displayName.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!nameMap[key]) nameMap[key] = [];
      nameMap[key].push({ playlist: f.playlist, name: f.name, displayName: f.displayName });
    });
    const duplicates = Object.entries(nameMap).filter(([, v]) => v.length > 1).map(([key, files]) => ({ key, files }));

    res.json({ playlists, duplicates, totalFiles: allFiles.length, totalPlaylists: playlists.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list playlists.' });
  }
});

// ==================== Feature 6: Related Songs ====================
app.get('/api/related/:videoId', (req, res) => {
  const { videoId } = req.params;
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const args = ['-J', '--flat-playlist', '--no-warnings', '--extractor-retries', '1', `yt${url}`];

  // Get related via playlist=related
  const relArgs = ['--no-warnings', '-J', '--flat-playlist', `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`];
  execFile('yt-dlp', relArgs, { maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
    if (err) {
      // Fallback: just search with the video ID
      return res.json({ results: [] });
    }
    try {
      const data = JSON.parse(stdout);
      const entries = (data.entries || []).slice(1, 11); // Skip first (it's the same video)
      const results = entries.map((e, i) => ({
        index: i + 1, title: e.title || 'Unknown', id: e.id || e.url || '',
        duration: e.duration || null, channel: e.uploader || e.channel || '',
        thumbnail: e.thumbnails && e.thumbnails.length > 0 ? e.thumbnails[e.thumbnails.length - 1].url : ''
      }));
      res.json({ results });
    } catch (_) { res.json({ results: [] }); }
  });
});

// ==================== Feature 7: YouTube Music Charts ====================
app.get('/api/charts', (req, res) => {
  // Use YouTube Music charts playlists
  const charts = [
    { id: 'PL4fGSI1pDJn5rWitrVxi4q_iq_Ud8tMma', name: 'US Top 100' },
    { id: 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf', name: 'YouTube Top Trending' },
    { id: 'PLFgquLnL59alCl_2FQs0WlwTvZfJOC2qC', name: 'YouTube Global Top 50' },
    { id: 'PLj4R_gekO-sI0OPNBiYfsH8vi_IU19JqR', name: 'YouTube Music Daily Top' }
  ];
  res.json({ charts });
});

app.get('/api/charts/:chartId', (req, res) => {
  const { chartId } = req.params;
  const url = `https://music.youtube.com/playlist?list=${chartId}`;
  execFile('yt-dlp', ['-J', '--flat-playlist', '--no-warnings', url], { maxBuffer: 50 * 1024 * 1024 }, (err, stdout) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch chart.' });
    try {
      const data = JSON.parse(stdout);
      const entries = (data.entries || []).slice(0, 50);
      res.json({
        title: data.title || 'Chart',
        tracks: entries.map((e, i) => ({
          index: i + 1, title: e.title || 'Unknown', id: e.id || e.url || '',
          duration: e.duration || null, channel: e.uploader || e.channel || '',
          thumbnail: e.thumbnails && e.thumbnails.length > 0 ? e.thumbnails[e.thumbnails.length - 1].url : ''
        }))
      });
    } catch (_) { res.status(500).json({ error: 'Parse error.' }); }
  });
});

// ==================== Feature 8: Artist Discography ====================
app.get('/api/artist', (req, res) => {
  const { query } = req.query;
  if (!query) return res.status(400).json({ error: 'Missing artist query' });

  // Search for the artist's channel
  const searchUrl = `ytsearch5:${query} official`;
  execFile('yt-dlp', ['-J', '--flat-playlist', '--no-warnings', searchUrl], { maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
    if (err) return res.status(500).json({ error: 'Search failed' });
    try {
      const data = JSON.parse(stdout);
      const results = (data.entries || []).map((e, i) => ({
        index: i + 1, title: e.title || 'Unknown', id: e.id || e.url || '',
        duration: e.duration || null, channel: e.uploader || e.channel || '',
        thumbnail: e.thumbnails && e.thumbnails.length > 0 ? e.thumbnails[e.thumbnails.length - 1].url : ''
      }));
      res.json({ results });
    } catch (_) { res.status(500).json({ error: 'Parse error' }); }
  });
});

// ==================== Feature 9: Auto-Import Watcher ====================
let watcher = null;
let watcherDir = '';
let watcherPlaylist = '';

app.get('/api/watcher/status', (req, res) => {
  res.json({ active: !!watcher, directory: watcherDir, playlist: watcherPlaylist });
});

app.post('/api/watcher/start', (req, res) => {
  if (watcher) return res.status(400).json({ error: 'Watcher already running' });

  const { playlistName } = req.body;
  if (!playlistName) return res.status(400).json({ error: 'Missing playlist name' });

  watcherDir = path.join(downloadsDir, sanitize(playlistName));
  fs.mkdirSync(watcherDir, { recursive: true });
  watcherPlaylist = playlistName;

  const seen = new Set(getAudioFiles(watcherDir));

  watcher = fs.watch(watcherDir, (eventType, filename) => {
    if (!filename) return;
    const ext = path.extname(filename).toLowerCase();
    if (!AUDIO_EXTS.includes(ext)) return;
    if (seen.has(filename)) return;
    seen.add(filename);

    const filePath = path.join(watcherDir, filename);
    // Wait a moment for file to finish writing
    setTimeout(() => {
      if (!fs.existsSync(filePath)) { seen.delete(filename); return; }
      const addArgs = [
        '-e', 'on run argv',
        '-e', 'set theFile to POSIX file (item 1 of argv)',
        '-e', 'tell application "Music"',
        '-e', 'if not (exists user playlist (item 2 of argv)) then',
        '-e', 'make new user playlist with properties {name:(item 2 of argv)}',
        '-e', 'end if',
        '-e', 'set thePlaylist to user playlist (item 2 of argv)',
        '-e', 'add theFile to thePlaylist',
        '-e', 'end tell',
        '-e', 'end run',
        filePath,
        watcherPlaylist
      ];
      execFile('osascript', addArgs, { timeout: 15000 }, (err) => {
        if (err) console.error('Auto-import error:', err.message);
        else console.log(`Auto-imported: ${filename}`);
      });
    }, 3000);
  });

  res.json({ success: true, message: `Watching for new files in "${playlistName}"` });
});

app.post('/api/watcher/stop', (req, res) => {
  if (watcher) { watcher.close(); watcher = null; }
  res.json({ success: true, message: 'Watcher stopped' });
});

// ==================== Feature 11: Search & Single Song Download ====================
app.get('/api/search', (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Missing search query' });

  execFile('yt-dlp', ['--no-warnings', '-J', '--flat-playlist', `ytsearch10:${query}`], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
    if (err) return res.status(500).json({ error: 'Search failed.' });
    try {
      const entries = (JSON.parse(stdout).entries || []).map((e, i) => ({
        index: i + 1, title: e.title || 'Unknown', id: e.id || e.url || '',
        duration: e.duration || null, channel: e.channel || e.uploader || '',
        thumbnail: e.thumbnails && e.thumbnails.length > 0 ? e.thumbnails[e.thumbnails.length - 1].url : ''
      }));
      res.json({ results: entries });
    } catch (_) { res.status(500).json({ error: 'Parse error.' }); }
  });
});

app.post('/api/download-song', (req, res) => {
  const { videoUrl, playlistName, format, quality } = req.body;
  if (!videoUrl || !playlistName) return res.status(400).json({ error: 'Missing video URL or playlist name' });

  const playlistDir = path.join(downloadsDir, sanitize(playlistName));
  fs.mkdirSync(playlistDir, { recursive: true });

  execFile('yt-dlp', [...buildDownloadArgs(playlistDir, format, quality), videoUrl], { maxBuffer: 10 * 1024 * 1024 }, (err) => {
    if (err) return res.status(500).json({ error: `Download failed: ${err.message}` });
    res.json({ success: true, message: `Song downloaded to "${playlistName}"` });
  });
});

// ==================== Feature 12: Library Search ====================
app.get('/api/library/search', (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing search query' });
  const term = q.toLowerCase();
  const results = [];

  try {
    const dirs = fs.readdirSync(downloadsDir, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const dirPath = path.join(downloadsDir, dir.name);
      const files = getAudioFiles(dirPath);
      for (const f of files) {
        const name = path.parse(f).name.toLowerCase();
        if (name.includes(term) || dir.name.toLowerCase().includes(term)) {
          let stat; try { stat = fs.statSync(path.join(dirPath, f)); } catch (_) { stat = { size: 0, mtime: '' }; }
          results.push({ playlist: dir.name, file: f, displayName: path.parse(f).name, size: stat.size, modified: stat.mtime });
        }
      }
    }
    res.json({ results, total: results.length });
  } catch (err) { res.status(500).json({ error: 'Search failed' }); }
});

// ==================== Feature 13: Smart Playlists ====================
app.get('/api/smart-playlists', (req, res) => {
  res.json({ smartPlaylists: config.smartPlaylists || [] });
});

app.post('/api/smart-playlists', (req, res) => {
  const { name, rules } = req.body;
  if (!name || !rules) return res.status(400).json({ error: 'Missing name or rules' });

  const sp = { id: crypto.randomBytes(8).toString('hex'), name, rules, createdAt: new Date().toISOString() };
  if (!config.smartPlaylists) config.smartPlaylists = [];
  config.smartPlaylists.push(sp);
  saveConfig(config);
  res.json({ success: true, smartPlaylist: sp });
});

app.delete('/api/smart-playlists/:id', (req, res) => {
  config.smartPlaylists = (config.smartPlaylists || []).filter(sp => sp.id !== req.params.id);
  saveConfig(config);
  res.json({ success: true });
});

app.get('/api/smart-playlists/:id/resolve', (req, res) => {
  const sp = (config.smartPlaylists || []).find(s => s.id === req.params.id);
  if (!sp) return res.status(404).json({ error: 'Smart playlist not found' });

  const rules = sp.rules || {};
  const results = [];

  try {
    const dirs = fs.readdirSync(downloadsDir, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const dirPath = path.join(downloadsDir, dir.name);

      // Rule: specific playlists
      if (rules.playlists && rules.playlists.length > 0 && !rules.playlists.includes(dir.name)) continue;

      const files = getAudioFiles(dirPath);
      for (const f of files) {
        const name = path.parse(f).name;
        let stat; try { stat = fs.statSync(path.join(dirPath, f)); } catch (_) { continue; }

        // Rule: format
        if (rules.format && path.extname(f).toLowerCase() !== '.' + rules.format) continue;

        // Rule: min size (bytes)
        if (rules.minSize && stat.size < rules.minSize) continue;

        // Rule: modified after
        if (rules.modifiedAfter && new Date(stat.mtime) < new Date(rules.modifiedAfter)) continue;

        results.push({ playlist: dir.name, file: f, displayName: name, size: stat.size, modified: stat.mtime });
      }
    }

    // Rule: sort
    if (rules.sort === 'newest') results.sort((a, b) => new Date(b.modified) - new Date(a.modified));
    else if (rules.sort === 'oldest') results.sort((a, b) => new Date(a.modified) - new Date(b.modified));
    else if (rules.sort === 'largest') results.sort((a, b) => b.size - a.size);

    // Rule: limit
    const limit = rules.limit || 100;
    const limited = results.slice(0, limit);

    res.json({ name: sp.name, tracks: limited, total: limited.length });
  } catch (err) { res.status(500).json({ error: 'Resolution failed' }); }
});

// ==================== Apple Music Playlist Check ====================
app.get('/api/apple-music-check', (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'Missing name' });
  const args = [
    '-e', 'on run argv',
    '-e', 'tell application "Music"',
    '-e', 'if not (exists user playlist (item 1 of argv)) then return "NOT_FOUND"',
    '-e', 'return (count of tracks of user playlist (item 1 of argv)) as text',
    '-e', 'end tell',
    '-e', 'end run',
    name
  ];
  execFile('osascript', args, { timeout: 15000 }, (err, stdout) => {
    if (err) return res.json({ exists: false, trackCount: 0 });
    const result = (stdout || '').trim();
    if (result === 'NOT_FOUND' || !result) return res.json({ exists: false, trackCount: 0 });
    const trackCount = parseInt(result);
    res.json({ exists: !isNaN(trackCount), trackCount: isNaN(trackCount) ? 0 : trackCount });
  });
});

// ==================== Import to Apple Music (SSE - dedup) ====================
app.post('/api/import-to-apple-music', (req, res) => {
  const { playlistName } = req.body;
  if (!playlistName) return res.status(400).json({ error: 'Missing playlist name' });

  const playlistDir = path.join(downloadsDir, playlistName);
  if (!fs.existsSync(playlistDir)) return res.status(404).json({ error: 'Playlist folder not found' });

  const audioFiles = getAudioFiles(playlistDir).sort().map(f => path.join(playlistDir, f));
  if (audioFiles.length === 0) return res.status(400).json({ error: 'No audio files found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // Step 0: Get existing track file paths from Apple Music to avoid duplicates
  const checkArgs = [
    '-e', 'on run argv',
    '-e', 'tell application "Music"',
    '-e', 'if not (exists user playlist (item 1 of argv)) then return ""',
    '-e', 'set output to ""',
    '-e', 'repeat with t in every file track of user playlist (item 1 of argv)',
    '-e', 'try',
    '-e', 'set output to output & (POSIX path of (get location of t)) & linefeed',
    '-e', 'end try',
    '-e', 'end repeat',
    '-e', 'return output',
    '-e', 'end tell',
    '-e', 'end run',
    playlistName
  ];

  execFile('osascript', checkArgs, { timeout: 120000 }, (err, stdout) => {
    const existingPaths = new Set();
    if (!err && stdout) {
      stdout.split('\n').forEach(p => { const t = p.trim(); if (t) existingPaths.add(t); });
    }

    // Filter out files already in the Apple Music playlist
    const filesToImport = audioFiles.filter(f => !existingPaths.has(f));
    const skipped = audioFiles.length - filesToImport.length;

    send('start', { total: audioFiles.length, playlistName, skipped, toImport: filesToImport.length });

    if (filesToImport.length === 0) {
      send('done', {
        message: `All ${audioFiles.length} tracks already exist in "${playlistName}". Nothing new to import.`,
        playlistName, imported: 0, errors: 0, skipped, total: audioFiles.length
      });
      return res.end();
    }

    let imported = 0;
    let errors = 0;
    const errorFiles = [];

    // Step 1: Create playlist if needed
    const createArgs = [
      '-e', 'on run argv',
      '-e', 'tell application "Music"',
      '-e', 'activate',
      '-e', 'if not (exists user playlist (item 1 of argv)) then',
      '-e', 'make new user playlist with properties {name:(item 1 of argv)}',
      '-e', 'end if',
      '-e', 'end tell',
      '-e', 'end run',
      playlistName
    ];

    execFile('osascript', createArgs, { timeout: 30000 }, (err) => {
      if (err) {
        send('error', { message: 'Failed to create playlist: ' + err.message });
        return res.end();
      }

      // Step 2: Add only NEW files
      const addNext = (index) => {
        if (index >= filesToImport.length) {
          send('done', {
            message: `Imported ${imported}/${filesToImport.length} new tracks to "${playlistName}"${skipped ? ` (${skipped} already existed)` : ''}${errors > 0 ? ` (${errors} failed)` : ''}`,
            playlistName, imported, errors, skipped, total: audioFiles.length,
            errorFiles: errorFiles.slice(0, 20)
          });
          return res.end();
        }

        const filePath = filesToImport[index];
        const fileName = path.basename(filePath, path.extname(filePath));
        send('progress', { current: index + 1, total: filesToImport.length, title: fileName, status: 'importing', imported, errors, skipped });

        const addArgs = [
          '-e', 'on run argv',
          '-e', 'set theFile to POSIX file (item 1 of argv)',
          '-e', 'tell application "Music"',
          '-e', 'set thePlaylist to user playlist (item 2 of argv)',
          '-e', 'add theFile to thePlaylist',
          '-e', 'end tell',
          '-e', 'end run',
          filePath,
          playlistName
        ];

        execFile('osascript', addArgs, { timeout: 30000 }, (err) => {
          if (err) {
            errors++;
            errorFiles.push(fileName);
            send('progress', { current: index + 1, total: filesToImport.length, title: fileName, status: 'error', imported, errors, skipped });
          } else {
            imported++;
            send('progress', { current: index + 1, total: filesToImport.length, title: fileName, status: 'done', imported, errors, skipped });
          }
          setTimeout(() => addNext(index + 1), 150);
        });
      };
      addNext(0);
    });
  });
});

// ==================== Feature 14: Duplicate Check ====================
app.get('/api/duplicates', (req, res) => {
  try {
    const nameMap = {};
    const dirs = fs.readdirSync(downloadsDir, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const dirPath = path.join(downloadsDir, dir.name);
      const files = getAudioFiles(dirPath);
      for (const f of files) {
        const key = path.parse(f).name.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!nameMap[key]) nameMap[key] = [];
        nameMap[key].push({ playlist: dir.name, file: f, displayName: path.parse(f).name });
      }
    }
    const duplicates = Object.entries(nameMap).filter(([, v]) => v.length > 1).map(([key, files]) => ({ key, files }));
    res.json({ duplicates, totalDuplicates: duplicates.length });
  } catch (err) { res.status(500).json({ error: 'Failed to check duplicates' }); }
});

app.delete('/api/duplicates/remove', (req, res) => {
  const { playlist, file } = req.body;
  if (!playlist || !file) return res.status(400).json({ error: 'Missing playlist or file' });
  const filePath = path.join(downloadsDir, playlist, file);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  try {
    fs.unlinkSync(filePath);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed to delete file' }); }
});

// ==================== Feature: Suggested for You (Library-based) ====================
app.get('/api/suggested', (req, res) => {
  try {
    // 1. Collect all song display names from library
    const allSongs = [];
    const dirs = fs.readdirSync(downloadsDir, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const dirPath = path.join(downloadsDir, dir.name);
      const files = getAudioFiles(dirPath);
      for (const f of files) {
        allSongs.push({ name: path.parse(f).name, playlist: dir.name });
      }
    }

    if (allSongs.length === 0) return res.json({ suggestions: [], sampled: [], totalLibrary: 0 });

    // 2. Detect genre from library content
    const allText = allSongs.map(s => (s.name + ' ' + s.playlist).toLowerCase()).join(' ');
    const genreKeywords = {
      worship: ['jesus','christ','christian','worship','praise','church','god','holy','bless','faith','prayer','hymn','gospel','amen','hallelujah','cross','altar','lord','grace','mercy','spirit','psalm','sermon','choir','congregation','devotional'],
      hiphop: ['hip hop','hiphop','rap','trap','beats','bars','flow','mixtape','freestyle'],
      rock: ['rock','metal','punk','grunge','indie rock','alternative'],
      pop: ['pop','mainstream','top 40','hit','radio edit'],
      edm: ['edm','electronic','house','techno','trance','dubstep','dj','remix','club'],
      rnb: ['r&b','rnb','soul','neo soul','slow jam'],
      country: ['country','nashville','bluegrass','folk','acoustic'],
      jazz: ['jazz','blues','swing','bebop','smooth jazz'],
      classical: ['classical','orchestra','symphony','sonata','concerto','piano']
    };

    const detectedGenres = [];
    for (const [genre, keywords] of Object.entries(genreKeywords)) {
      const matchCount = keywords.filter(k => allText.includes(k)).length;
      if (matchCount >= 2) detectedGenres.push({ genre, matchCount });
    }
    detectedGenres.sort((a, b) => b.matchCount - a.matchCount);
    const primaryGenre = detectedGenres.length > 0 ? detectedGenres[0].genre : null;

    // 3. Pick up to 3 random songs to use as seeds
    const shuffled = allSongs.sort(() => Math.random() - 0.5);
    const seeds = shuffled.slice(0, Math.min(3, shuffled.length));

    const cleanName = (n) => n.replace(/[⧸／\/\\()（）\[\]{}|&:'""]/g, ' ').replace(/\s+/g, ' ').trim();

    let completed = 0;
    const allSuggestions = [];
    const existingNames = new Set(allSongs.map(s => s.name.toLowerCase().replace(/[^a-z0-9]/g, '')));
    const targetCount = 20;

    // Build genre-specific search queries
    const genreSearchSuffix = {
      worship: 'worship music',
      hiphop: 'hip hop',
      rock: 'rock music',
      pop: 'pop music',
      edm: 'electronic music',
      rnb: 'r&b soul music',
      country: 'country music',
      jazz: 'jazz music',
      classical: 'classical music'
    };

    const finalize = () => {
      const seen = new Set();
      const unique = allSuggestions.filter(s => {
        const k = s.title.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }).slice(0, targetCount);

      res.json({
        suggestions: unique,
        sampled: seeds.map(s => s.name),
        totalLibrary: allSongs.length,
        detectedGenre: primaryGenre
      });
    };

    // Strategy 1: For each seed song, search YouTube Music with genre context
    seeds.forEach((seed) => {
      const suffix = primaryGenre ? (genreSearchSuffix[primaryGenre] || primaryGenre) : '';
      const searchTerm = cleanName(seed.name);
      // Search: "song title genre" to get genre-matched results
      const query = suffix ? `${searchTerm} ${suffix}` : searchTerm;
      const searchUrl = `ytsearch5:${query}`;

      execFile('yt-dlp', ['--no-warnings', '-J', '--flat-playlist', searchUrl], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        completed++;
        if (!err) {
          try {
            const data = JSON.parse(stdout);
            const entries = (data.entries || []).slice(0, 5);
            entries.forEach(e => {
              const title = e.title || 'Unknown';
              const key = title.toLowerCase().replace(/[^a-z0-9]/g, '');
              // Skip if already in library or is a very close match to the seed
              const seedKey = seed.name.toLowerCase().replace(/[^a-z0-9]/g, '');
              if (!existingNames.has(key) && key !== seedKey) {
                allSuggestions.push({
                  title,
                  id: e.id || e.url || '',
                  channel: e.uploader || e.channel || '',
                  duration: e.duration || null,
                  seededFrom: seed.name
                });
              }
            });
          } catch (_) {}
        }

        if (completed === seeds.length) finalize();
      });
    });

    // Strategy 2 (parallel): Search for a genre compilation/mix playlist for more variety
    if (primaryGenre) {
      const genreMixQuery = `${primaryGenre} music playlist 2024`;
      const mixSearchUrl = `ytsearch1:${genreMixQuery}`;
      execFile('yt-dlp', ['--no-warnings', '-J', '--flat-playlist', mixSearchUrl], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        if (!err) {
          try {
            const data = JSON.parse(stdout);
            const entries = data.entries || [];
            if (entries.length > 0) {
              // Get the first playlist result and expand it
              const playlistId = entries[0].url || entries[0].id || '';
              if (playlistId) {
                const playlistUrl = playlistId.startsWith('http') ? playlistId : `https://www.youtube.com/playlist?list=${playlistId}`;
                execFile('yt-dlp', ['--no-warnings', '-J', '--flat-playlist', playlistUrl], { maxBuffer: 30 * 1024 * 1024 }, (err2, stdout2) => {
                  if (!err2) {
                    try {
                      const pData = JSON.parse(stdout2);
                      const pEntries = (pData.entries || []).slice(0, 25);
                      pEntries.forEach(e => {
                        const title = e.title || 'Unknown';
                        const key = title.toLowerCase().replace(/[^a-z0-9]/g, '');
                        if (!existingNames.has(key)) {
                          allSuggestions.push({
                            title,
                            id: e.id || e.url || '',
                            channel: e.uploader || e.channel || '',
                            duration: e.duration || null,
                            seededFrom: `${primaryGenre} mix`
                          });
                        }
                      });
                    } catch (_) {}
                  }
                });
              }
            }
          } catch (_) {}
        }
      });
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate suggestions' });
  }
});

// ==================== Start Server ====================
app.listen(PORT, () => {
  console.log(`🎵 YouTube Music Downloader`);
  console.log(`   Open http://localhost:${PORT}`);
  console.log(`   API Key: ${config.apiKey}`);
});