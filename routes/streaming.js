const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { SocksProxyAgent } = require('socks-proxy-agent');

// WARP SOCKS proxy agent for routing audio streams through WARP
const socksAgent = new SocksProxyAgent('socks5://127.0.0.1:40000');

module.exports = function(app, deps) {
const { config, downloadsDir, buildDownloadArgs, getAudioFiles, sanitize, AUDIO_EXTS, saveConfig, hashStr, getLibraryCache, setLibraryCache, clearLibraryCache, isLibraryCacheValid } = deps;

// ==================== Stream URL Cache ====================
// YouTube stream URLs expire after ~6 hours. Cache for 4 hours to avoid re-running yt-dlp.
const streamUrlCache = new Map();
const STREAM_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

function getCachedStreamUrl(videoId) {
  const cached = streamUrlCache.get(videoId);
  if (cached && Date.now() - cached.time < STREAM_CACHE_TTL) {
    return cached.url;
  }
  streamUrlCache.delete(videoId);
  return null;
}

function setCachedStreamUrl(videoId, url) {
  streamUrlCache.set(videoId, { url, time: Date.now() });
  // Prune old entries periodically
  if (streamUrlCache.size > 500) {
    const now = Date.now();
    for (const [key, val] of streamUrlCache) {
      if (now - val.time > STREAM_CACHE_TTL) streamUrlCache.delete(key);
    }
  }
}

// Resolve a YouTube stream URL (with caching)
function resolveStreamUrl(videoId) {
  return new Promise((resolve, reject) => {
    const cached = getCachedStreamUrl(videoId);
    if (cached) return resolve(cached);

    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const ytdlp = spawn('yt-dlp', [
      '--proxy', 'http://127.0.0.1:40000',
      '-f', 'bestaudio[ext=m4a]/bestaudio/best',
      '--no-check-certificates', '--no-warnings',
      '--prefer-free-formats', '--get-url', url
    ]);
    let streamUrl = '';
    let errMsg = '';
    ytdlp.stdout.on('data', d => { streamUrl += d.toString(); });
    ytdlp.stderr.on('data', d => { errMsg += d.toString(); });
    ytdlp.on('close', code => {
      if (code !== 0 || !streamUrl.trim()) {
        return reject(new Error(errMsg || 'Could not get stream URL'));
      }
      const finalUrl = streamUrl.trim().split('\n')[0];
      setCachedStreamUrl(videoId, finalUrl);
      resolve(finalUrl);
    });
  });
}

// ==================== YouTube Proxy Streaming ====================
// Stream audio directly from YouTube without downloading (instant playback)
app.get('/api/youtube/stream/:videoId', async (req, res) => {
  const { videoId } = req.params;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'Invalid video ID' });
  }
  try {
    const targetUrl = await resolveStreamUrl(videoId);
    // Proxy the audio stream with range support (follows redirects)
    const range = req.headers.range;
    const fetchOpts = { headers: { 'User-Agent': 'Mozilla/5.0' } };
    if (range) fetchOpts.headers.Range = range;

    function fetchWithRedirects(url, redirectsLeft) {
      if (redirectsLeft <= 0) return res.status(502).json({ error: 'Too many redirects' });
      const mod = url.startsWith('https') ? https : http;
      const opts = { ...fetchOpts, agent: socksAgent };
      mod.get(url, opts, streamRes => {
        // Follow redirects
        if ([301, 302, 303, 307, 308].includes(streamRes.statusCode) && streamRes.headers.location) {
          return fetchWithRedirects(streamRes.headers.location, redirectsLeft - 1);
        }
        if (streamRes.statusCode >= 400) {
          return res.status(streamRes.statusCode).json({ error: 'Upstream error' });
        }
        const headers = {
          'Content-Type': streamRes.headers['content-type'] || 'audio/mp4',
          'Accept-Ranges': 'bytes'
        };
        if (streamRes.headers['content-length']) headers['Content-Length'] = streamRes.headers['content-length'];
        if (streamRes.headers['content-range']) headers['Content-Range'] = streamRes.headers['content-range'];
        res.writeHead(streamRes.statusCode, headers);
        streamRes.pipe(res);
      }).on('error', err => {
        console.error('Stream proxy error:', err.message);
        if (!res.headersSent) res.status(502).json({ error: 'Stream proxy failed' });
      });
    }
    fetchWithRedirects(targetUrl, 5);
  } catch(e) {
    console.error('Stream resolve error:', e.message);
    if (!res.headersSent) res.status(502).json({ error: 'Could not get stream URL' });
  }
});

// Pre-cache stream URL for instant playback (called when user taps play)
app.get('/api/youtube/stream-url/:videoId', async (req, res) => {
  const { videoId } = req.params;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'Invalid video ID' });
  }
  try {
    const url = await resolveStreamUrl(videoId);
    res.json({ videoId, streamUrl: url, cached: true });
  } catch(e) {
    res.status(502).json({ error: 'Could not resolve stream URL' });
  }
});

// ==================== YouTube Metadata ====================
// Get metadata for a YouTube video (title, artist, thumbnail, duration)
app.get('/api/youtube/info/:videoId', async (req, res) => {
  const { videoId } = req.params;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'Invalid video ID' });
  }
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  try {
    const ytdlp = spawn('yt-dlp', [
      '--proxy', 'http://127.0.0.1:40000',
      '--dump-json', '--no-download', '--no-warnings',
      '--no-check-certificates', url
    ]);
    let data = '';
    ytdlp.stdout.on('data', d => { data += d.toString(); });
    let errMsg = '';
    ytdlp.stderr.on('data', d => { errMsg += d.toString(); });
    ytdlp.on('close', code => {
      if (code !== 0 || !data.trim()) {
        return res.status(502).json({ error: 'Could not get video info' });
      }
      try {
        const info = JSON.parse(data);
        res.json({
          id: videoId,
          title: info.title || info.track || 'Unknown',
          artist: info.artist || info.channel || info.uploader || '',
          album: info.album || '',
          thumbnail: info.thumbnail || `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
          duration: info.duration || 0
        });
      } catch(e) {
        res.status(502).json({ error: 'Could not parse video info' });
      }
    });
  } catch(e) {
    res.status(500).json({ error: 'Info fetch failed' });
  }
});

// Add song to library (download from YouTube)
app.post('/api/music/add', (req, res) => {
  const { url, query } = req.body;

  const targetDir = path.join(downloadsDir, 'Library');
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  const doDownload = (videoUrl) => {
    // Snapshot files before download
    const before = new Set(getAudioFiles(targetDir));

    execFile('yt-dlp', ['--proxy', 'http://127.0.0.1:40000', ...buildDownloadArgs(targetDir, 'm4a', '0'), videoUrl],
      { maxBuffer: 10 * 1024 * 1024, timeout: 120000 }, (err) => {
        if (err) return res.status(500).json({ error: 'Download failed: ' + err.message });

        // Find the new file
        const after = getAudioFiles(targetDir);
        const newFiles = after.filter(f => !before.has(f));
        const newFile = newFiles[0] || after[after.length - 1];

        if (!newFile) return res.status(500).json({ error: 'File not found after download' });

        // Get metadata
        const filePath = path.join(targetDir, newFile);
        execFile('ffprobe', ['-hide_banner', '-print_format', 'json', '-show_format', filePath],
          { maxBuffer: 2 * 1024 * 1024, timeout: 5000 }, (err2, stdout2) => {
            let title = path.parse(newFile).name;
            let artist = 'Library';

            if (!err2) {
              try {
                const data = JSON.parse(stdout2);
                const tags = (data.format || {}).tags || {};
                title = tags.title || tags.TITLE || title;
                artist = tags.artist || tags.ARTIST || artist;
              } catch (_) {}
            }

            clearLibraryCache();
            res.json({
              success: true,
              message: 'Song added to library',
              song: {
                title,
                artist,
                file: newFile,
                playlist: 'Library',
                coverUrl: `/api/music/cover/Library/${encodeURIComponent(newFile)}`,
                duration: 0
              }
            });
          });
      });
  };

  if (url) {
    doDownload(url);
  } else if (query) {
    // Search and download first result
    execFile('yt-dlp', ['--proxy', 'http://127.0.0.1:40000', '--no-warnings', '-J', '--flat-playlist', `ytsearch1:${query}`],
      { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        if (err) return res.status(500).json({ error: 'Search failed' });
        try {
          const data = JSON.parse(stdout);
          const entries = data.entries || [];
          if (!entries.length) return res.status(404).json({ error: 'No results found' });
          const videoId = entries[0].id || entries[0].url;
          doDownload(`https://www.youtube.com/watch?v=${videoId}`);
        } catch (_) {
          res.status(500).json({ error: 'Parse error' });
        }
      });
  } else {
    res.status(400).json({ error: 'Missing url or query' });
  }
});

// ==================== YouTube Search for iOS App ====================
// Returns results with streaming URLs for instant playback
app.get('/api/music/search', (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Missing search query' });

  const searchUrl = `ytsearch15:${query}`;
  execFile('yt-dlp', ['--proxy', 'http://127.0.0.1:40000', '--no-warnings', '-J', '--flat-playlist', searchUrl],
    { maxBuffer: 10 * 1024 * 1024, timeout: 30000 }, (err, stdout) => {
      if (err) return res.status(500).json({ error: 'Search failed' });
      try {
        const data = JSON.parse(stdout);
        const results = (data.entries || []).map((e, i) => {
          const id = e.id || e.url || '';
          return {
            index: i + 1,
            title: e.title || 'Unknown',
            id,
            url: id ? `https://www.youtube.com/watch?v=${id}` : '',
            duration: e.duration || null,
            durationFormatted: e.duration ? `${Math.floor(e.duration / 60)}:${(e.duration % 60).toString().padStart(2, '0')}` : '',
            channel: e.channel || e.uploader || '',
            thumbnail: (e.thumbnails && e.thumbnails.length > 0)
              ? (e.thumbnails.find(t => t.width >= 200 && t.width <= 400) || e.thumbnails[e.thumbnails.length - 1]).url
              : (id ? `https://img.youtube.com/vi/${id}/mqdefault.jpg` : ''),
            streamUrl: id ? `/api/youtube/stream/${id}` : ''
          };
        });
        res.json({ results });
      } catch (_) { res.status(500).json({ error: 'Parse error' }); }
    });
});

// ==================== Thumbnail/Image Proxy ====================
// Proxy external images to avoid CORS/ATS issues in iOS WKWebView
app.get('/api/proxy/image', (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl) return res.status(400).json({ error: 'Missing image URL' });
  
  try {
    const parsedUrl = new URL(imageUrl);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;
    protocol.get(imageUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (imgRes) => {
      if (imgRes.statusCode >= 300 && imgRes.statusCode < 400 && imgRes.headers.location) {
        // Follow redirect
        return res.redirect(`/api/proxy/image?url=${encodeURIComponent(imgRes.headers.location)}`);
      }
      if (imgRes.statusCode >= 400) {
        return res.status(imgRes.statusCode).json({ error: 'Image fetch failed' });
      }
      const headers = {
        'Content-Type': imgRes.headers['content-type'] || 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*'
      };
      if (imgRes.headers['content-length']) headers['Content-Length'] = imgRes.headers['content-length'];
      res.writeHead(200, headers);
      imgRes.pipe(res);
    }).on('error', () => {
      if (!res.headersSent) res.status(502).json({ error: 'Image proxy failed' });
    });
  } catch(e) {
    res.status(400).json({ error: 'Invalid image URL' });
  }
});

// ==================== Physical File Download (for offline saving) ====================
app.get('/api/music/download/:playlist/:file', (req, res) => {
  const { playlist, file } = req.params;
  if (!playlist || !file) return res.status(400).json({ error: 'Missing playlist or file' });

  const filePath = path.join(downloadsDir, playlist, file);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
  res.sendFile(filePath);
});

// Serve the music player PWA
app.get('/player', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'music', 'index.html'));
});
};
