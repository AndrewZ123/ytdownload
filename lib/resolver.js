/**
 * Resolver Service — Isolated yt-dlp wrapper
 *
 * Responsibilities:
 *  - Resolve best-audio upstream URL + metadata for a YouTube videoId
 *  - Short-lived in-memory cache with aggressive TTL (upstream URLs expire)
 *  - Request deduplication (concurrent resolves for same videoId share one yt-dlp call)
 *  - Automatic retry on transient failures
 *  - Re-resolve expired entries on demand
 *
 * Contract matches the architecture doc's "Resolver layer".
 */

const { spawn } = require('child_process');
const { getProxyArgs, isWarpAvailable } = require('./utils');

// ==================== Resolver Cache ====================
// YouTube stream URLs expire after ~6 hours. Cache for 4 hours to be safe.
const resolverCache = new Map();
const RESOLVER_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

// In-flight request deduplication
const pendingResolves = new Map();

// ==================== Cache Operations ====================

function getCachedResolution(videoId) {
  const cached = resolverCache.get(videoId);
  if (cached && Date.now() - cached.resolvedAt < RESOLVER_CACHE_TTL) {
    return cached;
  }
  if (cached) resolverCache.delete(videoId);
  return null;
}

function setCachedResolution(videoId, data) {
  resolverCache.set(videoId, {
    ...data,
    resolvedAt: Date.now(),
  });
  // Prune old entries periodically
  if (resolverCache.size > 500) {
    const now = Date.now();
    for (const [key, val] of resolverCache) {
      if (now - val.resolvedAt > RESOLVER_CACHE_TTL) resolverCache.delete(key);
    }
  }
}

/**
 * Check if a cached resolution is still fresh enough to use.
 * Returns the cached data or null.
 */
function getFreshResolution(videoId) {
  return getCachedResolution(videoId);
}

// ==================== yt-dlp Resolution ====================

/**
 * Run yt-dlp to extract the best audio stream URL and metadata.
 *
 * @param {string} videoId - YouTube video ID (11 chars)
 * @param {{ retries?: number }} options
 * @returns {Promise<{ sourceId: string, upstreamUrl: string, audioMime: string, bitrate: number, contentLength: number|null, expiresAt: string, resolvedAt: string }>}
 */
function resolve(videoId, options = {}) {
  const retries = options.retries ?? 1;

  // 1. Check memory cache
  const cached = getCachedResolution(videoId);
  if (cached) {
    console.log(`[resolver] Cache hit for ${videoId}`);
    return Promise.resolve(cached);
  }

  // 2. Deduplicate in-flight requests
  const pending = pendingResolves.get(videoId);
  if (pending) {
    console.log(`[resolver] Dedup: reusing pending resolve for ${videoId}`);
    return pending;
  }

  // 3. Start new resolution with retry logic
  const promise = _resolveWithRetry(videoId, retries);
  pendingResolves.set(videoId, promise);
  return promise.finally(() => pendingResolves.delete(videoId));
}

function _resolveWithRetry(videoId, retriesLeft) {
  return _runYtDlp(videoId).catch(err => {
    if (retriesLeft > 0) {
      // Exponential backoff: 1.5s, 3s, 6s (capped at 10s)
      const backoffDelay = Math.min(1500 * Math.pow(2, 3 - retriesLeft), 10000);
      console.warn(`[resolver] Retrying ${videoId} in ${backoffDelay}ms (${retriesLeft} left)`);
      return new Promise(resolve => setTimeout(resolve, backoffDelay)).then(() => _resolveWithRetry(videoId, retriesLeft - 1));
    }
    throw err;
  });
}

function _runYtDlp(videoId) {
  return new Promise((resolve, reject) => {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    console.log(`[resolver] Resolving ${videoId} via yt-dlp...`);

    // STRICT iOS format preference: Only accept m4a/AAC, not WebM/Opus
    // This prevents SRC_NOT_SUPPORTED errors on iOS
    const args = [
      ...getProxyArgs(),
      '-f', 'bestaudio[ext=m4a]/bestaudio[acodec=aac]/bestaudio[ext=m4a]/bestaudio[acodec!=opus]/bestaudio',
      '--no-check-certificates',
      '--no-warnings',
      '--socket-timeout', '15',
      '--retries', '3',
      '--fragment-retries', '3',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      '--dump-json',
      '--no-download',
      '--no-playlist',
      '--extract-flat',  // Performance improvement #10: Don't extract additional metadata
      url,
    ];

    const ytdlp = spawn('yt-dlp', args);
    let stdout = '';
    let stderr = '';
    ytdlp.stdout.on('data', d => { stdout += d.toString(); });
    ytdlp.stderr.on('data', d => { stderr += d.toString(); });

    const timeout = setTimeout(() => {
      try { ytdlp.kill('SIGKILL'); } catch (_) {}
      reject(new Error('yt-dlp timed out after 60s'));
    }, 60000);

    ytdlp.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0 || !stdout.trim()) {
        console.error(`[resolver] yt-dlp failed for ${videoId}: code=${code} err=${stderr.slice(0, 300)}`);
        return reject(new Error(stderr || 'yt-dlp returned no data'));
      }

      try {
        const info = JSON.parse(stdout);

        // Extract the direct audio URL from yt-dlp's output
        const upstreamUrl = info.url;
        if (!upstreamUrl) {
          return reject(new Error('No stream URL in yt-dlp output'));
        }

        // Determine MIME type
        let audioMime = 'audio/mp4'; // default for m4a/aac
        const ext = (info.ext || '').toLowerCase();
        if (ext === 'webm' || ext === 'opus') audioMime = 'audio/webm';
        else if (ext === 'mp3') audioMime = 'audio/mpeg';
        else if (ext === 'ogg') audioMime = 'audio/ogg';
        else if (ext === 'wav') audioMime = 'audio/wav';

        // Also check the format note / acodec
        if (info.acodec === 'opus' || info.acodec === 'vorbis') audioMime = 'audio/webm';

        const contentLength = info.filesize || info.content_length || null;
        const bitrate = info.abr ? Math.round(info.abr * 1000) : (info.tbr ? Math.round(info.tbr * 1000) : 128000);
        const now = Date.now();
        const expiresAt = new Date(now + RESOLVER_CACHE_TTL).toISOString();

        const result = {
          sourceId: videoId,
          upstreamUrl,
          audioMime,
          bitrate,
          contentLength,
          expiresAt,
          resolvedAt: new Date(now).toISOString(),
          // Also store metadata for play endpoint
          title: info.title || info.track || 'Unknown',
          artist: info.artist || info.channel || info.uploader || '',
          album: info.album || '',
          thumbnail: info.thumbnail || `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
          duration: info.duration || 0,
        };

        // Diagnostic logging for format selection
        console.log(`[resolver] ✅ Resolved ${videoId}`);
        console.log(`[resolver]   Format: ${ext} (${info.acodec || 'unknown'}) → audioMime=${audioMime}`);
        console.log(`[resolver]   Bitrate: ${bitrate}bps, Size: ${contentLength ? Math.round(contentLength/1024/1024) + 'MB' : 'unknown'}`);
        console.log(`[resolver]   iOS-compatible: ${audioMime !== 'audio/webm' ? '✅' : '❌'}`);
        
        setCachedResolution(videoId, result);
        resolve(result);
      } catch (parseErr) {
        console.error(`[resolver] JSON parse error for ${videoId}:`, parseErr.message);
        reject(new Error('Could not parse yt-dlp output'));
      }
    });

    ytdlp.on('error', err => {
      clearTimeout(timeout);
      console.error(`[resolver] yt-dlp spawn error for ${videoId}:`, err.message);
      reject(new Error('yt-dlp not available: ' + err.message));
    });
  });
}

/**
 * Force re-resolve a videoId (clears cache entry first).
 * Used when the upstream URL has expired mid-session.
 */
function reResolve(videoId) {
  resolverCache.delete(videoId);
  return resolve(videoId, { retries: 1 });
}

/**
 * Get resolver stats for monitoring.
 */
function getStats() {
  return {
    cacheSize: resolverCache.size,
    pendingResolves: pendingResolves.size,
    ttl: Math.round(RESOLVER_CACHE_TTL / 1000),
    entries: Array.from(resolverCache.entries()).map(([id, v]) => ({
      videoId: id,
      age: Math.round((Date.now() - v.resolvedAt) / 1000),
      expired: Date.now() - v.resolvedAt > RESOLVER_CACHE_TTL,
    })),
  };
}

module.exports = {
  resolve,
  reResolve,
  getFreshResolution,
  getStats,
  RESOLVER_CACHE_TTL,
};