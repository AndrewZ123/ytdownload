const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

module.exports = function(app, deps) {
const { config, downloadsDir, buildDownloadArgs, getAudioFiles, sanitize, AUDIO_EXTS, saveConfig, hashStr, getLibraryCache, setLibraryCache, clearLibraryCache, isLibraryCacheValid } = deps;

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

};
