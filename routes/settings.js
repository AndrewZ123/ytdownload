const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

module.exports = function(app, deps) {
const { config, downloadsDir, buildDownloadArgs, getAudioFiles, sanitize, AUDIO_EXTS, saveConfig, hashStr, getLibraryCache, setLibraryCache, clearLibraryCache, isLibraryCacheValid } = deps;

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

};
