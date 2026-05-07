const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

module.exports = function(app, deps) {
const { config, downloadsDir, buildDownloadArgs, getAudioFiles, sanitize, AUDIO_EXTS, saveConfig, hashStr, getLibraryCache, setLibraryCache, clearLibraryCache, isLibraryCacheValid } = deps;

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

};
