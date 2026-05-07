const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

module.exports = function(app, deps) {
const { config, downloadsDir, buildDownloadArgs, getAudioFiles, sanitize, AUDIO_EXTS, saveConfig, hashStr, getLibraryCache, setLibraryCache, clearLibraryCache, isLibraryCacheValid } = deps;

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

};
