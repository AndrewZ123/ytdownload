/**
 * Play Token Service — Signed short-lived playback tokens
 *
 * Instead of exposing raw upstream CDN URLs to the client, we issue
 * signed tokens that map to a resolved playback session. The client
 * uses the token to stream from our /stream/:token endpoint.
 *
 * Benefits:
 *  - Upstream URLs never reach the client
 *  - Tokens expire quickly (5 min by default), limiting abuse
 *  - Backend can rotate upstream URLs without client changes
 *  - Tokens are signed to prevent tampering
 */

const crypto = require('crypto');

// ==================== Token Store ====================
// In-memory store mapping tokens to session data
// For MVP this is fine; for production, use Redis
const tokenStore = new Map();

const TOKEN_TTL = 45 * 60 * 1000; // 45 minutes — long enough for normal playback sessions

/**
 * Create a signed play token for a resolved track.
 *
 * @param {object} params
 * @param {string} params.videoId - YouTube video ID
 * @param {string} params.title - Track title
 * @param {string} params.artist - Track artist
 * @param {string} params.artworkUrl - Artwork URL
 * @param {number} params.durationMs - Duration in ms
 * @param {string} params.audioMime - MIME type
 * @param {number|null} params.contentLength - File size in bytes
 * @returns {{ token: string, streamUrl: string, expiresAt: string, track: object }}
 */
function createToken(params, host) {
  // Clean expired tokens periodically
  if (tokenStore.size > 1000) {
    _pruneTokens();
  }

  const token = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  const expiresAt = new Date(now + TOKEN_TTL);

  const session = {
    token,
    videoId: params.videoId,
    title: params.title || 'Unknown',
    artist: params.artist || '',
    artworkUrl: params.artworkUrl || '',
    durationMs: params.durationMs || 0,
    audioMime: params.audioMime || 'audio/mp4',
    contentLength: params.contentLength || null,
    createdAt: now,
    expiresAt: now + TOKEN_TTL,
    status: 'active', // active | expired | completed
  };

  tokenStore.set(token, session);

  return {
    token,
    streamUrl: `${host}/api/stream/${token}`,
    expiresAt: expiresAt.toISOString(),
    track: {
      videoId: session.videoId,
      title: session.title,
      artist: session.artist,
      artworkUrl: session.artworkUrl,
      durationMs: session.durationMs,
    },
  };
}

/**
 * Validate and retrieve a play token's session data.
 * Returns the session or null if invalid/expired.
 *
 * @param {string} token
 * @returns {object|null}
 */
function validateToken(token) {
  if (!token) return null;
  const session = tokenStore.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    tokenStore.delete(token);
    return null;
  }
  return session;
}

/**
 * Get a token's session data even if expired (for debugging).
 * Returns null only if token never existed.
 */
function getSession(token) {
  if (!token) return null;
  return tokenStore.get(token) || null;
}

/**
 * Check if a token is expired (but still in store for debugging).
 */
function isTokenExpired(token) {
  const session = tokenStore.get(token);
  if (!session) return true;
  return Date.now() > session.expiresAt;
}

/**
 * Get a token's age in seconds.
 */
function getTokenAge(token) {
  const session = tokenStore.get(token);
  if (!session) return -1;
  return Math.round((Date.now() - session.createdAt) / 1000);
}

/**
 * Mark a token as completed (track finished playing).
 *
 * @param {string} token
 */
function completeToken(token) {
  const session = tokenStore.get(token);
  if (session) {
    session.status = 'completed';
    session.completedAt = Date.now();
  }
}

/**
 * Revoke a token (user skipped, error, etc).
 *
 * @param {string} token
 */
function revokeToken(token) {
  tokenStore.delete(token);
}

/**
 * Get active session count for monitoring.
 */
function getActiveCount() {
  _pruneTokens();
  return tokenStore.size;
}

/**
 * Get stats about active tokens.
 */
function getStats() {
  _pruneTokens();
  const sessions = Array.from(tokenStore.values());
  return {
    active: sessions.length,
    sessions: sessions.map(s => ({
      token: s.token.slice(0, 12) + '...',
      videoId: s.videoId,
      title: s.title,
      status: s.status,
      age: Math.round((Date.now() - s.createdAt) / 1000),
      expiresIn: Math.round((s.expiresAt - Date.now()) / 1000),
    })),
  };
}

// ==================== Internal ====================

function _pruneTokens() {
  const now = Date.now();
  for (const [token, session] of tokenStore) {
    if (now > session.expiresAt + 60000) { // Keep 1 min past expiry for stats
      tokenStore.delete(token);
    }
  }
}

module.exports = {
  createToken,
  validateToken,
  completeToken,
  revokeToken,
  getActiveCount,
  getStats,
  getSession,
  isTokenExpired,
  getTokenAge,
  TOKEN_TTL,
};
