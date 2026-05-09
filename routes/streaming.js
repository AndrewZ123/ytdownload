const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { SocksProxyAgent } = require('socks-proxy-agent');

// WARP SOCKS5 proxy agent (reused across requests)
let _warpAgent = null;
function getWarpAgent() {
  if (!_warpAgent) {
    _warpAgent = new SocksProxyAgent('socks5://127.0.0.1:40000');
  }
  return _warpAgent;
}

module.exports = function(app, deps) {
const { config, downloadsDir, buildDownloadArgs, getAudioFiles, sanitize, AUDIO_EXTS, saveConfig, hashStr, getLibraryCache, setLibraryCache, clearLibraryCache, isLibraryCacheValid, getProxyArgs, isWarpAvailable } = deps;

// ==================== Stream URL Cache ====================
// YouTube stream URLs expire after ~6 hours. Cache for 4 hours to avoid re-running yt-dlp.
const streamUrlCache = new Map();
const STREAM_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

// In-flight request deduplication: prevents multiple yt-dlp calls for the same videoId
const pendingResolves = new Map();

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

// Resolve a YouTube stream URL (with caching + deduplication)
function resolveStreamUrl(videoId) {
  // 1. Check memory cache
  const cached = getCachedStreamUrl(videoId);
  if (cached) {
    console.log(`[stream] Cache hit for ${videoId}`);
    return Promise.resolve(cached);
  }

  // 2. Check if there's already a pending resolution for this videoId
  const pending = pendingResolves.get(videoId);
  if (pending) {
    console.log(`[stream] Dedup: reusing pending resolve for ${videoId}`);
    return pending;
  }

  // 3. Start new resolution
  const promise = new Promise((resolve, reject) => {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    console.log(`[stream] Resolving ${videoId} via yt-dlp...`);

    // Prefer m4a (AAC) for iOS compatibility, fallback to any best audio
    const args = [
      ...getProxyArgs(),
      '-f', 'bestaudio[ext=m4a]/bestaudio[acodec=aac]/bestaudio/best',
      '--no-check-certificates', '--no-warnings',
      '--socket-timeout', '15',
      '--retries', '3',
      '--fragment-retries', '3',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      '--get-url', url
    ];

    const ytdlp = spawn('yt-dlp', args);
    let streamUrl = '';
    let errMsg = '';
    ytdlp.stdout.on('data', d => { streamUrl += d.toString(); });
    ytdlp.stderr.on('data', d => { errMsg += d.toString(); });

    // Kill yt-dlp if it takes too long
    const ytdlpTimeout = setTimeout(() => {
      try { ytdlp.kill('SIGKILL'); } catch(_) {}
      reject(new Error('yt-dlp timed out after 30s'));
    }, 30000);
    ytdlp.on('close', code => {
      clearTimeout(ytdlpTimeout);
      pendingResolves.delete(videoId);
      if (code !== 0 || !streamUrl.trim()) {
        console.error(`[stream] yt-dlp failed for ${videoId}: code=${code} err=${errMsg.slice(0, 300)}`);
        return reject(new Error(errMsg || 'Could not get stream URL'));
      }
      const finalUrl = streamUrl.trim().split('\n')[0];
      console.log(`[stream] Resolved ${videoId} → ${finalUrl.slice(0, 120)}... (${finalUrl.includes('.googlevideo.com') ? 'CDN' : 'unknown'})`);
      setCachedStreamUrl(videoId, finalUrl);
      resolve(finalUrl);
    });
    ytdlp.on('error', err => {
      clearTimeout(ytdlpTimeout);
      pendingResolves.delete(videoId);
      console.error(`[stream] yt-dlp spawn error for ${videoId}:`, err.message);
      reject(new Error('yt-dlp not available: ' + err.message));
    });
  });

  pendingResolves.set(videoId, promise);
  return promise;
}

// ==================== YouTube Proxy Streaming ====================
// Resolve CDN URL, then proxy it with Range support for seeking

// Fetch a URL following redirects, with timeout. Routes through WARP SOCKS5 if available.
function fetchWithRedirects(url, headers = {}, maxRedirects = 5, timeoutMs = 15000) {
  const useWarp = isWarpAvailable();
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
      // Route through WARP SOCKS5 proxy so YouTube CDN sees the same IP as yt-dlp
      if (useWarp) {
        opts.agent = getWarpAgent();
      }
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
    console.log(`[stream] Redirecting ${videoId} → CDN`);
    // 302 redirect to YouTube CDN — client streams directly, avoiding slow WARP proxy
    res.redirect(cdnUrl);
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
      ...getProxyArgs(),
      '--dump-json', '--no-download', '--no-warnings',
      '--no-check-certificates', url
    ]);
    let data = '';
    ytdlp.stdout.on('data', d => { data += d.toString(); });
    let errMsg = '';
    ytdlp.stderr.on('data', d => { errMsg += d.toString(); });
    const infoTimeout = setTimeout(() => { try { ytdlp.kill('SIGKILL'); } catch(_) {} }, 15000);
    ytdlp.on('close', code => {
      clearTimeout(infoTimeout);
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

    execFile('yt-dlp', [...getProxyArgs(), ...buildDownloadArgs(config, targetDir, 'm4a', '0'), videoUrl],
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
    execFile('yt-dlp', [...getProxyArgs(), '--no-warnings', '-J', '--flat-playlist', `ytsearch1:${query}`],
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

// ==================== YouTube Search ====================
// Primary: yt-dlp (0 YouTube API credits). Fallback: YouTube Data API (100 credits).
const YT_API_KEY = process.env.YT_API_KEY || '';

// Search cache: 6-hour TTL
const searchCache = new Map();
const SEARCH_CACHE_TTL = 6 * 60 * 60 * 1000;

app.get('/api/music/search', (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) return res.json({ results: [] });

  // Check cache first
  const cacheKey = query.toLowerCase();
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.time < SEARCH_CACHE_TTL) {
    return res.json({ results: cached.results, cached: true });
  }

  // Primary: yt-dlp search (0 API credits)
  const maxResults = Math.min(parseInt(req.query.max) || 10, 15);
  const searchQuery = `ytsearch${maxResults}:${query}`;

  execFile('yt-dlp', [...getProxyArgs(), '--no-warnings', '--no-check-certificates', '-J', '--flat-playlist', searchQuery],
    { maxBuffer: 10 * 1024 * 1024, timeout: 30000 }, (err, stdout) => {
      if (!err && stdout) {
        try {
          const data = JSON.parse(stdout);
          const results = (data.entries || [])
            .filter(e => e && e.title && (e.duration || 0) <= 600)
            .map((e, i) => {
              const id = e.id || e.url || '';
              const thumb = (e.thumbnails && e.thumbnails.length > 0)
                ? (e.thumbnails.find(t => t.width >= 200 && t.width <= 400) || e.thumbnails[e.thumbnails.length - 1])
                : null;
              return {
                index: i + 1,
                title: e.title || 'Unknown',
                id,
                url: id ? `https://www.youtube.com/watch?v=${id}` : '',
                duration: e.duration || null,
                durationFormatted: e.duration ? `${Math.floor(e.duration / 60)}:${(e.duration % 60).toString().padStart(2, '0')}` : '',
                channel: e.uploader || e.channel || '',
                thumbnail: (thumb && thumb.url) ? thumb.url : (id ? `https://img.youtube.com/vi/${id}/mqdefault.jpg` : ''),
                streamUrl: id ? `/api/youtube/stream/${id}` : ''
              };
            });

          searchCache.set(cacheKey, { results, time: Date.now() });
          if (searchCache.size > 200) {
            const now = Date.now();
            for (const [k, v] of searchCache) { if (now - v.time > SEARCH_CACHE_TTL) searchCache.delete(k); }
          }
          return res.json({ results });
        } catch (_) {}
      }

      // Fallback: YouTube Data API if yt-dlp fails (100 credits per call)
      console.warn('[search] yt-dlp failed, trying YouTube Data API fallback');
      if (!YT_API_KEY) return res.status(500).json({ error: 'Search failed' });

      const apiUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&maxResults=10&fields=items(id/videoId,snippet(title,channelTitle,thumbnails/medium/url))&q=${encodeURIComponent(query)}&key=${YT_API_KEY}`;
      https.get(apiUrl, { headers: { 'User-Agent': 'Melodia/1.0' } }, (apiRes) => {
        let body = '';
        apiRes.on('data', d => { body += d; });
        apiRes.on('end', () => {
          try {
            const data = JSON.parse(body);
            const results = (data.items || [])
              .filter(item => item.id && item.id.videoId)
              .map((item, i) => {
                const videoId = item.id.videoId;
                const snippet = item.snippet || {};
                const thumbs = snippet.thumbnails || {};
                return {
                  index: i + 1,
                  title: snippet.title || 'Unknown',
                  id: videoId,
                  url: `https://www.youtube.com/watch?v=${videoId}`,
                  duration: null,
                  durationFormatted: '',
                  channel: snippet.channelTitle || '',
                  thumbnail: (thumbs.medium || thumbs.high || thumbs.default || {}).url || `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
                  streamUrl: `/api/youtube/stream/${videoId}`
                };
              });
            searchCache.set(cacheKey, { results, time: Date.now() });
            res.json({ results });
          } catch (_) { res.status(500).json({ error: 'Search failed' }); }
        });
      }).on('error', () => res.status(500).json({ error: 'Search failed' }));
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
