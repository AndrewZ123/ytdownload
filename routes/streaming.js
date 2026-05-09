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

const resolver = require('../lib/resolver');
const streamProxy = require('../lib/stream-proxy');
const playTokens = require('../lib/play-tokens');
const events = require('../lib/events');

/**
 * Determine the base URL for stream URLs based on the request.
 */
function getHost(req) {
  const protocol = req.protocol || 'http';
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
  // Resolve a track and return a signed stream URL
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
        return res.status(403).json({ error: 'Invalid or expired play token' });
      }

      const { videoId } = session;

      // Step 2: Get a fresh resolution (from cache or re-resolve)
      let resolution = resolver.getFreshResolution(videoId);
      if (!resolution) {
        console.log(`[stream] Re-resolving expired cache for ${videoId}`);
        try {
          resolution = await resolver.reResolve(videoId);
        } catch (err) {
          console.error(`[stream] Re-resolve failed for ${videoId}:`, err.message);
          return res.status(502).json({ error: 'Stream source expired and could not be refreshed' });
        }
      }

      if (!resolution || !resolution.upstreamUrl) {
        return res.status(502).json({ error: 'No upstream URL available' });
      }

      // Step 3: Proxy the stream with Range support
      console.log(`[stream] Proxying ${videoId} (Range: ${req.headers.range || 'none'})`);
      await streamProxy.proxyStream(resolution, req, res);

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

  console.log('[streaming] ✅ Routes registered: POST /play, GET /stream/:token, events, stats');
};