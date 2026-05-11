/**
 * Streaming Routes — POST /play, GET /stream/:token, Events, Stats
 *
 * This is the heart of the new architecture:
 *
 * 1. POST /api/play — Resolve a track and return a signed stream URL
 *    (calls resolver, creates play token, returns metadata)
 *
 * 2. GET /api/stream/:token — Proxy audio from upstream to client
 *    (validates token, resolves if needed, proxies with Range support)
 *
 * 3. POST /api/events/* — Log listen events for analytics
 *
 * 4. GET /api/stats — Monitoring/debug endpoint
 *
 * The old approach returned raw YouTube URLs to the client.
 * The new approach proxies through our backend with signed tokens.
 */

const http = require('http');
const https = require('https');
const resolver = require('../lib/resolver');
const streamProxy = require('../lib/stream-proxy');
const playTokens = require('../lib/play-tokens');
const events = require('../lib/events');

/**
 * Determine the base URL for stream URLs based on the request.
 * Handles nginx reverse proxy (X-Forwarded-Proto, X-Forwarded-Host).
 */
function getHost(req) {
  // When behind nginx with proxy_set_header X-Forwarded-Proto $scheme,
  // use the forwarded protocol (https) instead of the internal http
  const protocol = req.get('x-forwarded-proto') || req.protocol || 'http';
  // When behind nginx with proxy_set_header Host $host,
  // the Host header is already the public domain
  const host = req.get('host') || req.headers.host || 'localhost:3000';
  return `${protocol}://${host}`;
}

/**
 * Extract videoId from a trackId (which may be a ytId or a prefixed id).
 * For now, trackId IS the YouTube videoId.
 */
function normalizeTrackId(trackId) {
  if (!trackId) return null;
  return trackId.replace(/^(trk_|yt_)/, '');
}

module.exports = function(app, deps) {

  // ==================== POST /api/play ====================
  // Resolve a track and return a signed stream URL (blocks until resolved)
  //
  // Request body: { "videoId": "...", "trackId": "..." }
  // Response: { streamUrl, expiresAt, track: { videoId, title, artist, ... } }
  //
  app.post('/api/play', async (req, res) => {
    try {
      const videoId = req.body.videoId || normalizeTrackId(req.body.trackId);

      if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
        return res.status(400).json({ error: 'Valid videoId or trackId required (11 chars)' });
      }

      console.log(`[play] Request for ${videoId}`);

      // Step 1: Resolve (from cache or fresh yt-dlp)
      let resolution;
      try {
        resolution = await resolver.resolve(videoId);
      } catch (resolveErr) {
        console.error(`[play] Resolver failed for ${videoId}:`, resolveErr.message);
        return res.status(502).json({
          error: 'Could not resolve audio source',
          details: resolveErr.message,
          videoId,
        });
      }

      if (!resolution || !resolution.upstreamUrl) {
        return res.status(502).json({
          error: 'No audio stream found',
          videoId,
        });
      }

      // Step 2: Create a signed play token
      const host = getHost(req);
      const tokenData = playTokens.createToken({
        videoId: resolution.sourceId,
        title: resolution.title,
        artist: resolution.artist,
        artworkUrl: resolution.thumbnail,
        durationMs: (resolution.duration || 0) * 1000,
        audioMime: resolution.audioMime,
        contentLength: resolution.contentLength,
      }, host);

      // Step 3: Log the play start event
      events.logEvent({
        videoId,
        eventType: 'start',
        sessionId: tokenData.token.slice(0, 12),
        title: resolution.title,
        artist: resolution.artist,
      });

      // Step 4: Return the play response
      res.json({
        trackId: videoId,
        title: resolution.title,
        artist: resolution.artist,
        album: resolution.album || '',
        artworkUrl: resolution.thumbnail,
        durationMs: (resolution.duration || 0) * 1000,
        streamUrl: tokenData.streamUrl,
        streamExpiresAt: tokenData.expiresAt,
        audioMime: resolution.audioMime,
        bitrate: resolution.bitrate,
      });

      console.log(`[play] ✅ ${videoId} → ${resolution.title} by ${resolution.artist}`);
    } catch (err) {
      console.error('[play] Unexpected error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ==================== POST /api/play-quick ====================
  // Performance improvement #2: Parallel Resolution & Response
  // Returns immediately if cached, otherwise starts resolution in background
  //
  // Request body: { "videoId": "...", "trackId": "..." }
  // Response: { streamUrl, expiresAt, status: 'ready'|'resolving', track: {...} }
  //
  // If cached: Returns streamUrl immediately (status: 'ready')
  // If not cached: Returns quick response (status: 'resolving'), then client
  //                should poll /api/youtube/stream-url/:videoId or use WebSocket
  //
  app.post('/api/play-quick', async (req, res) => {
    try {
      const videoId = req.body.videoId || normalizeTrackId(req.body.trackId);

      if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
        return res.status(400).json({ error: 'Valid videoId or trackId required (11 chars)' });
      }

      console.log(`[play-quick] Request for ${videoId}`);

      // Check cache first (fast path)
      const cached = resolver.getFreshResolution(videoId);
      if (cached && cached.upstreamUrl) {
        // Cache hit - return immediately
        const host = getHost(req);
        const tokenData = playTokens.createToken({
          videoId: cached.sourceId,
          title: cached.title,
          artist: cached.artist,
          artworkUrl: cached.thumbnail,
          durationMs: (cached.duration || 0) * 1000,
          audioMime: cached.audioMime,
          contentLength: cached.contentLength,
        }, host);

        events.logEvent({
          videoId,
          eventType: 'start',
          sessionId: tokenData.token.slice(0, 12),
          title: cached.title,
          artist: cached.artist,
        });

        console.log(`[play-quick] ✅ Cache hit for ${videoId}`);
        return res.json({
          trackId: videoId,
          title: cached.title,
          artist: cached.artist,
          album: cached.album || '',
          artworkUrl: cached.thumbnail,
          durationMs: (cached.duration || 0) * 1000,
          streamUrl: tokenData.streamUrl,
          streamExpiresAt: tokenData.expiresAt,
          audioMime: cached.audioMime,
          bitrate: cached.bitrate,
          status: 'ready',
          cached: true,
        });
      }

      // Cache miss - start resolution in background
      console.log(`[play-quick] Cache miss for ${videoId}, starting background resolution`);
      
      // Fire-and-forget resolution
      resolver.resolve(videoId)
        .then(resolution => {
          console.log(`[play-quick] Background resolution complete for ${videoId}`);
          // In a real implementation, we would notify client via WebSocket
          // For now, client can poll /api/youtube/stream-url/:videoId
        })
        .catch(err => {
          console.error(`[play-quick] Background resolution failed for ${videoId}:`, err.message);
        });

      // Return quick response to keep UI responsive
      res.json({
        trackId: videoId,
        status: 'resolving',
        cached: false,
        // Client should poll /api/youtube/stream-url/:videoId to get the stream URL
      });
    } catch (err) {
      console.error('[play-quick] Unexpected error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ==================== GET /api/stream/:token ====================
  // Proxy audio from upstream to client with full Range support
  //
  // Headers: Range (optional) — forwarded to upstream
  // Response: 200 (full) or 206 (partial) with audio bytes
  //
  app.get('/api/stream/:token', async (req, res) => {
    try {
      const { token } = req.params;

      // Step 1: Validate the play token
      const session = playTokens.validateToken(token);
      if (!session) {
        // Distinguish expired token from never-valid token
        const expired = playTokens.isTokenExpired(token);
        const age = playTokens.getTokenAge(token);
        console.log(JSON.stringify({
          type: 'token_validation_failed',
          tokenPrefix: token.slice(0, 12),
          expired,
          ageSeconds: age,
          clientRange: req.headers.range || null,
        }));
        if (expired) {
          return res.status(419).json({ error: 'Play token expired', code: 'TOKEN_EXPIRED' });
        }
        return res.status(403).json({ error: 'Invalid play token', code: 'TOKEN_INVALID' });
      }

      const { videoId } = session;
      const tokenAge = Math.round((Date.now() - session.createdAt) / 1000);

      // Step 2: Get a fresh resolution (from cache or re-resolve)
      console.log(`[stream] Getting fresh resolution for ${videoId} (token age: ${tokenAge}s)`);
      let resolution = resolver.getFreshResolution(videoId);
      console.log(`[stream] getFreshResolution returned:`, resolution ? `found with upstreamUrl=${!!resolution.upstreamUrl}` : 'null');
      
      if (!resolution) {
        console.log(`[stream] Re-resolving expired cache for ${videoId} (token age: ${tokenAge}s)`);
        try {
          resolution = await resolver.reResolve(videoId);
          console.log(`[stream] Re-resolve succeeded, upstreamUrl=${!!resolution.upstreamUrl}`);
        } catch (err) {
          console.error(`[stream] Re-resolve failed for ${videoId}:`, err.message);
          return res.status(502).json({ error: 'Stream source expired and could not be refreshed', code: 'UPSTREAM_EXPIRED' });
        }
      }

      if (!resolution || !resolution.upstreamUrl) {
        console.error(`[stream] No upstream URL available. Resolution exists: ${!!resolution}, Has upstreamUrl: ${resolution?.upstreamUrl}`);
        if (resolution) {
          console.error(`[stream] Resolution keys:`, Object.keys(resolution));
        }
        return res.status(502).json({ error: 'No upstream URL available', code: 'NO_UPSTREAM' });
      }

      // Step 3: Proxy the stream with Range support
      console.log(`[stream] Proxying ${videoId} (Range: ${req.headers.range || 'none'}, token age: ${tokenAge}s)`);
      await streamProxy.proxyStream(resolution, req, res, tokenAge);

    } catch (err) {
      console.error('[stream] Unexpected error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Stream error' });
      }
    }
  });

  // ==================== POST /api/events/listen ====================
  // Log a listen event (progress update during playback)
  //
  // Request body: { videoId, eventType, positionMs, playedMs, sessionId, title, artist }
  //
  app.post('/api/events/listen', (req, res) => {
    try {
      const event = req.body;
      if (!event.videoId) {
        return res.status(400).json({ error: 'videoId required' });
      }

      const validTypes = ['start', 'progress', 'skip', 'complete', 'replay', 'like'];
      if (!validTypes.includes(event.eventType)) {
        return res.status(400).json({ error: `eventType must be one of: ${validTypes.join(', ')}` });
      }

      const logged = events.logEvent(event);

      // If completed, mark the play token as completed too
      if (event.eventType === 'complete' && event.sessionId) {
        // SessionId is the first 12 chars of the token — not enough to look up
        // Instead, we track completions purely via events
      }

      res.json({ ok: true, event: logged });
    } catch (err) {
      console.error('[events/listen] Error:', err.message);
      res.status(500).json({ error: 'Failed to log event' });
    }
  });

  // ==================== POST /api/events/skip ====================
  app.post('/api/events/skip', (req, res) => {
    try {
      const event = {
        ...req.body,
        eventType: 'skip',
      };
      if (!event.videoId) return res.status(400).json({ error: 'videoId required' });
      const logged = events.logEvent(event);
      res.json({ ok: true, event: logged });
    } catch (err) {
      res.status(500).json({ error: 'Failed to log event' });
    }
  });

  // ==================== POST /api/events/complete ====================
  app.post('/api/events/complete', (req, res) => {
    try {
      const event = {
        ...req.body,
        eventType: 'complete',
      };
      if (!event.videoId) return res.status(400).json({ error: 'videoId required' });
      const logged = events.logEvent(event);
      res.json({ ok: true, event: logged });
    } catch (err) {
      res.status(500).json({ error: 'Failed to log event' });
    }
  });

  // ==================== GET /api/events/history ====================
  // Return recent listen events for the client's history view
  app.get('/api/events/history', (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      const history = events.getRecentEvents({
        limit,
        eventType: req.query.eventType || undefined,
        videoId: req.query.videoId || undefined,
      });
      res.json({ events: history });
    } catch (err) {
      console.error('[events/history] Error:', err.message);
      res.status(500).json({ error: 'Failed to get history' });
    }
  });

  // ==================== GET /api/stats ====================
  // Monitoring endpoint — resolver cache, active tokens, listen stats
  app.get('/api/stats', (req, res) => {
    try {
      res.json({
        resolver: resolver.getStats(),
        tokens: playTokens.getStats(),
        events: events.getListenStats(),
      });
    } catch (err) {
      res.status(500).json({ error: 'Stats error' });
    }
  });

  // ==================== GET /api/recommendations ====================
  // Simple recommendation endpoint based on listen history
  app.get('/api/recommendations', (req, res) => {
    try {
      const stats = events.getListenStats();
      res.json({
        topTracks: stats.topTracks.slice(0, 10),
        topArtists: stats.topArtists.slice(0, 5),
      });
    } catch (err) {
      res.status(500).json({ error: 'Recommendations error' });
    }
  });

  // ==================== SEARCH ====================
  // Lightweight YouTube search using yt-dlp flat-playlist (metadata only, no audio resolve).
  // This keeps search fast — audio is resolved later when the user taps play.

  const { execFile } = require('child_process');

  app.get('/api/music/search', (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'q parameter required' });

    const maxResults = Math.min(parseInt(req.query.max) || 10, 30);
    const searchUrl = `ytsearch${maxResults}:${q}`;

    execFile('yt-dlp', ['--no-warnings', '-J', '--flat-playlist', searchUrl],
      { maxBuffer: 10 * 1024 * 1024, timeout: 30000 }, (err, stdout) => {
        if (err) {
          console.error('[search] yt-dlp search error:', err.message);
          return res.status(502).json({ error: 'Search failed', details: err.message });
        }
        try {
          const data = JSON.parse(stdout);
          const entries = (data.entries || []).filter(e => e && e.title).map(e => ({
            id: e.id || e.url || '',
            title: e.title || 'Unknown',
            channel: e.uploader || e.channel || '',
            duration: e.duration || null,
            durationFormatted: e.duration ? `${Math.floor(e.duration / 60)}:${(e.duration % 60).toString().padStart(2, '0')}` : null,
            thumbnail: (e.thumbnails && e.thumbnails.length > 0)
              ? (e.thumbnails.find(t => t.width >= 200 && t.width <= 400) || e.thumbnails[e.thumbnails.length - 1]).url
              : (e.id ? `https://img.youtube.com/vi/${e.id}/mqdefault.jpg` : ''),
          }));
          
          // Performance improvement #1: Predictive Pre-Resolution
          // Fire-and-forget pre-resolution for top 5 results (don't await)
          const topResults = entries.slice(0, 5);
          topResults.forEach(track => {
            if (track.id && /^[a-zA-Z0-9_-]{11}$/.test(track.id)) {
              resolver.resolve(track.id).catch(err => {
                // Silently fail - this is just pre-warming the cache
                console.log(`[pre-resolve] Failed for ${track.id}:`, err.message);
              });
            }
          });
          
          console.log(`[search] Returned ${entries.length} results, pre-resolving top ${Math.min(5, entries.length)}`);
          res.json({ results: entries, query: q, count: entries.length });
        } catch (parseErr) {
          console.error('[search] JSON parse error:', parseErr.message);
          res.status(502).json({ error: 'Failed to parse search results' });
        }
      });
  });

  // ==================== YOUTUBE INFO ====================
  // Lightweight metadata lookup for a single video (no audio resolve).
  // Used by the client for background metadata enrichment after search.

  app.get('/api/youtube/info/:videoId', (req, res) => {
    const { videoId } = req.params;
    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      return res.status(400).json({ error: 'Valid videoId required' });
    }

    // Check resolver cache first
    const cached = resolver.getFreshResolution(videoId);
    if (cached) {
      return res.json({
        videoId,
        title: cached.title,
        artist: cached.artist,
        duration: cached.duration,
        thumbnail: cached.thumbnail,
        cached: true,
      });
    }

    // Not cached — do a lightweight yt-dlp info extraction (no download)
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    execFile('yt-dlp', ['--no-warnings', '-J', '--flat-playlist', url],
      { maxBuffer: 10 * 1024 * 1024, timeout: 15000 }, (err, stdout) => {
        if (err) {
          return res.status(502).json({ error: 'Could not fetch video info', details: err.message });
        }
        try {
          const data = JSON.parse(stdout);
          const entry = data.entries ? data.entries[0] : data;
          res.json({
            videoId,
            title: entry.title || '',
            artist: entry.uploader || entry.channel || '',
            duration: entry.duration || null,
            thumbnail: (entry.thumbnails && entry.thumbnails.length > 0)
              ? (entry.thumbnails.find(t => t.width >= 200 && t.width <= 400) || entry.thumbnails[entry.thumbnails.length - 1]).url
              : `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
            cached: false,
          });
        } catch (parseErr) {
          res.status(502).json({ error: 'Failed to parse video info' });
        }
      });
  });

  // ==================== STREAM URL (pre-cache helper) ====================
  // Resolves a stream URL for pre-caching purposes.
  // Returns a POST /play-compatible signed stream URL without logging a start event.

  app.get('/api/youtube/stream-url/:videoId', async (req, res) => {
    const { videoId } = req.params;
    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      return res.status(400).json({ error: 'Valid videoId required' });
    }

    try {
      const resolution = await resolver.resolve(videoId);
      if (!resolution || !resolution.upstreamUrl) {
        return res.status(502).json({ error: 'No audio stream found', videoId });
      }

      const host = getHost(req);
      const tokenData = playTokens.createToken({
        videoId: resolution.sourceId,
        title: resolution.title,
        artist: resolution.artist,
        artworkUrl: resolution.thumbnail,
        durationMs: (resolution.duration || 0) * 1000,
        audioMime: resolution.audioMime,
        contentLength: resolution.contentLength,
      }, host);

      res.json({
        videoId,
        streamUrl: tokenData.streamUrl,
        streamExpiresAt: tokenData.expiresAt,
        title: resolution.title,
        artist: resolution.artist,
        duration: resolution.duration,
        thumbnail: resolution.thumbnail,
      });
    } catch (err) {
      console.error(`[stream-url] Resolve failed for ${videoId}:`, err.message);
      res.status(502).json({ error: 'Could not resolve stream URL', details: err.message });
    }
  });

  // ==================== POST /api/events/playback-error ====================
  // Remote error logging from the client for diagnostics
  // Body: { videoId, errorCode, errorMesage, currentSrc, networkState, readyState,
  //         tokenAge, tokenExpiry, wasBackgrounded, userAgent, appVersion }
  app.post('/api/events/playback-error', (req, res) => {
    try {
      const {
        videoId, errorCode, errorMessage, currentSrc,
        networkState, readyState, tokenAge, tokenExpiresAt,
        wasBackgrounded, userAgent, playbackState,
      } = req.body;

      const logEntry = {
        type: 'playback_error',
        timestamp: new Date().toISOString(),
        videoId: videoId || null,
        errorCode: errorCode || null,
        errorMessage: errorMessage || null,
        currentSrc: currentSrc ? currentSrc.split('/').slice(-2).join('/') : null, // only token part
        networkState: networkState ?? null,
        readyState: readyState ?? null,
        tokenAge: tokenAge ?? null,
        tokenExpiresAt: tokenExpiresAt || null,
        wasBackgrounded: wasBackgrounded || false,
        playbackState: playbackState || null,
        userAgent: userAgent || req.headers['user-agent'] || null,
        ip: req.ip || req.connection?.remoteAddress || null,
      };

      console.log(JSON.stringify(logEntry));

      // Also log as a listen event for correlation
      if (videoId) {
        events.logEvent({
          videoId,
          eventType: 'error',
          sessionId: currentSrc ? currentSrc.split('/').pop()?.slice(0, 12) : undefined,
          errorCode,
          errorMessage,
          wasBackgrounded,
        });
      }

      res.json({ ok: true, logged: true });
    } catch (err) {
      console.error('[playback-error] Error:', err.message);
      res.status(500).json({ error: 'Failed to log playback error' });
    }
  });

  // ==================== GET /api/debug/play-session/:token ====================
  // Debug endpoint for introspecting a play session
  app.get('/api/debug/play-session/:token', (req, res) => {
    try {
      const { token } = req.params;
      const session = playTokens.getSession(token);

      if (!session) {
        return res.status(404).json({ error: 'Session not found (token never existed or was pruned)' });
      }

      const now = Date.now();
      const age = Math.round((now - session.createdAt) / 1000);
      const expiresInSeconds = Math.round((session.expiresAt - now) / 1000);

      // Check if upstream resolution is still available
      const resolution = resolver.getFreshResolution(session.videoId);

      res.json({
        session: {
          token: session.token.slice(0, 12) + '...',
          videoId: session.videoId,
          title: session.title,
          artist: session.artist,
          status: session.status,
          audioMime: session.audioMime,
          contentLength: session.contentLength,
          createdAt: new Date(session.createdAt).toISOString(),
          completedAt: session.completedAt ? new Date(session.completedAt).toISOString() : null,
          ageSeconds: age,
          expiresInSeconds,
          isExpired: now > session.expiresAt,
        },
        upstream: resolution ? {
          hasUpstream: true,
          sourceId: resolution.sourceId,
          audioMime: resolution.audioMime,
          contentLength: resolution.contentLength,
          cached: true,
        } : {
          hasUpstream: false,
          cached: false,
          note: 'Upstream URL expired from resolver cache',
        },
      });
    } catch (err) {
      console.error('[debug/play-session] Error:', err.message);
      res.status(500).json({ error: 'Debug endpoint error' });
    }
  });

  // ==================== LEGACY COMPATIBILITY ====================
  // These endpoints are kept so the existing music-api.js search results
  // and other parts of the app don't break during the transition.

  // Legacy: GET /api/stream/info/:ytId — returns cached resolution info (no stream)
  // Used by the old search results to get duration before play
  app.get('/api/stream/info/:ytId', async (req, res) => {
    try {
      const { ytId } = req.params;
      const cached = resolver.getFreshResolution(ytId);

      if (cached) {
        return res.json({
          ytId,
          title: cached.title,
          artist: cached.artist,
          duration: cached.duration,
          thumbnail: cached.thumbnail,
          cached: true,
        });
      }

      // Not cached — resolve on demand
      try {
        const resolution = await resolver.resolve(ytId);
        return res.json({
          ytId,
          title: resolution.title,
          artist: resolution.artist,
          duration: resolution.duration,
          thumbnail: resolution.thumbnail,
          cached: false,
        });
      } catch (err) {
        return res.status(502).json({ error: 'Could not resolve: ' + err.message });
      }
    } catch (err) {
      res.status(500).json({ error: 'Info error' });
    }
  });

  // ==================== IMAGE PROXY ====================
  // Proxies external images so the iOS app can load them without CORS/ATS issues.
  // Used by browse.js discovery cards and as a general image proxy.
  app.get('/api/proxy/image', async (req, res) => {
    try {
      const imageUrl = req.query.url;
      if (!imageUrl) return res.status(400).send('Missing url parameter');

      // Only allow http(s) URLs
      if (!/^https?:\/\//i.test(imageUrl)) return res.status(400).send('Invalid URL');

      const httpMod = imageUrl.startsWith('https') ? https : http;

      httpMod.get(imageUrl, { timeout: 10000 }, (imgRes) => {
        if (imgRes.statusCode >= 300 && imgRes.statusCode < 400 && imgRes.headers.location) {
          // Follow redirect
          const redirectUrl = new URL(imgRes.headers.location, imageUrl).href;
          const redirMod = redirectUrl.startsWith('https') ? https : http;
          redirMod.get(redirectUrl, { timeout: 10000 }, (redirRes) => {
            res.set('Content-Type', redirRes.headers['content-type'] || 'image/jpeg');
            res.set('Cache-Control', 'public, max-age=86400');
            redirRes.pipe(res);
          }).on('error', () => res.status(502).send('Image fetch failed'));
          return;
        }

        res.set('Content-Type', imgRes.headers['content-type'] || 'image/jpeg');
        res.set('Cache-Control', 'public, max-age=86400');
        imgRes.pipe(res);
      }).on('error', () => {
        if (!res.headersSent) res.status(502).send('Image fetch failed');
      });
    } catch (err) {
      if (!res.headersSent) res.status(500).send('Proxy error');
    }
  });

  console.log('[streaming] ✅ Routes registered: POST /play, GET /stream/:token, events, stats, proxy/image');
};
