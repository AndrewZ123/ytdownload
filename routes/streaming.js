const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

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
// Resolve CDN URL, then proxy it with Range support for seeking

// Fetch a URL following redirects, with timeout. Returns {response, bodyBuffer}
function fetchWithRedirects(url, headers = {}, maxRedirects = 5, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    function attempt(currentUrl, remaining) {
      const parsed = new URL(currentUrl);
      const isHttps = parsed.protocol === 'https:';
      const lib = isHttps ? https : http;
      const opts = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: { ...headers, 'Host': parsed.host },
        timeout: timeoutMs
      };
      const req = lib.request(opts, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (remaining <= 0) return reject(new Error('Too many redirects'));
          const next = new URL(res.headers.location, currentUrl).href;
          return attempt(next, remaining - 1);
        }
        resolve(res);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('fetch timeout')); });
      req.end();
    }
    attempt(url, maxRedirects);
  });
}

app.get('/api/youtube/stream/:videoId', async (req, res) => {
  const { videoId } = req.params;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'Invalid video ID' });
  }

  try {
    const cdnUrl = await resolveStreamUrl(videoId);
    console.log(`[stream] Proxying CDN for ${videoId}`);

    const reqHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*',
      'Accept-Encoding': 'identity',
    };
    if (req.headers.range) reqHeaders['Range'] = req.headers.range;

    const cdnRes = await fetchWithRedirects(cdnUrl, reqHeaders);

    if (cdnRes.statusCode >= 400) {
      cdnRes.resume();
      console.error(`[stream] CDN ${cdnRes.statusCode} for ${videoId}`);
      if (!res.headersSent) res.status(cdnRes.statusCode).json({ error: 'CDN error' });
      return;
    }

    const resHeaders = {
      'Content-Type': cdnRes.headers['content-type'] || 'audio/mp4',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes',
    };
    if (cdnRes.headers['content-range']) resHeaders['Content-Range'] = cdnRes.headers['content-range'];
    if (cdnRes.headers['content-length']) resHeaders['Content-Length'] = cdnRes.headers['content-length'];

    res.writeHead(cdnRes.statusCode, resHeaders);
    cdnRes.pipe(res);
    req.on('close', () => cdnRes.destroy());
  } catch(e) {
    console.error(`[stream] Failed for ${videoId}:`, e.message);
    if (!res.headersSent) res.status(502).json({ error: 'Stream failed: ' + e.message });
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

    execFile('yt-dlp', [...buildDownloadArgs(targetDir, 'm4a', '0'), videoUrl],
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
    execFile('yt-dlp', ['--no-warnings', '-J', '--flat-playlist', `ytsearch1:${query}`],
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

// ==================== YouTube Music Search for iOS App ====================
// Search cache: 5-minute TTL to avoid repeated yt-dlp calls for same query
const searchCache = new Map();
const SEARCH_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

app.get('/api/music/search', (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Missing search query' });

  // Check cache first
  const cacheKey = query.toLowerCase().trim();
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.time < SEARCH_CACHE_TTL) {
    return res.json({ results: cached.results, cached: true });
  }

  // Use YouTube MUSIC search — only returns songs/albums (no videos/podcasts)
  const searchUrl = `ytmsearch10:${query}`;
  execFile('yt-dlp', ['--no-warnings', '--no-check-certificates', '-J', '--flat-playlist', searchUrl],
    { maxBuffer: 10 * 1024 * 1024, timeout: 30000 }, (err, stdout) => {
      if (err) return res.status(500).json({ error: 'Search failed' });
      try {
        const data = JSON.parse(stdout);
        const results = (data.entries || [])
          .filter(e => {
            // Filter out results longer than 10 minutes (not songs)
            const dur = e.duration || 0;
            return dur === 0 || dur <= 600;
          })
          .map((e, i) => {
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

        // Cache the results
        searchCache.set(cacheKey, { results, time: Date.now() });

        // Prune old cache entries periodically
        if (searchCache.size > 100) {
          const now = Date.now();
          for (const [key, val] of searchCache) {
            if (now - val.time > SEARCH_CACHE_TTL) searchCache.delete(key);
          }
        }

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
