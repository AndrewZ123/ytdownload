/**
 * Events Service — Listen event logging for analytics and recommendations
 *
 * Stores implicit-feedback signals (start, progress, skip, complete, replay, like)
 * to a JSONL file for MVP. Can be migrated to SQLite/Postgres later.
 *
 * Events are written to data/listen_events.jsonl — one JSON object per line.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const EVENTS_FILE = path.join(DATA_DIR, 'listen_events.jsonl');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/**
 * Log a listen event.
 *
 * @param {object} event
 * @param {string} event.videoId - YouTube video ID
 * @param {string} event.eventType - 'start' | 'progress' | 'skip' | 'complete' | 'replay' | 'like'
 * @param {number} [event.positionMs] - Current playback position in ms
 * @param {number} [event.playedMs] - Total ms played so far
 * @param {string} [event.sessionId] - Playback session ID
 * @param {string} [event.title] - Track title
 * @param {string} [event.artist] - Track artist
 */
function logEvent(event) {
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    timestamp: new Date().toISOString(),
    videoId: event.videoId || '',
    eventType: event.eventType || 'start',
    positionMs: event.positionMs || 0,
    playedMs: event.playedMs || 0,
    sessionId: event.sessionId || '',
    title: event.title || '',
    artist: event.artist || '',
  };

  // Append as JSONL (one JSON object per line)
  try {
    fs.appendFileSync(EVENTS_FILE, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error('[events] Failed to write event:', err.message);
  }

  return entry;
}

/**
 * Get recent events, optionally filtered by type or videoId.
 *
 * @param {object} options
 * @param {number} [options.limit=50] - Max events to return
 * @param {string} [options.eventType] - Filter by event type
 * @param {string} [options.videoId] - Filter by video ID
 * @returns {object[]}
 */
function getRecentEvents(options = {}) {
  const limit = options.limit || 50;

  if (!fs.existsSync(EVENTS_FILE)) return [];

  try {
    const lines = fs.readFileSync(EVENTS_FILE, 'utf8')
      .split('\n')
      .filter(l => l.trim())
      .slice(-limit * 5); // Read more than needed for filtering

    let events = lines.map(line => {
      try { return JSON.parse(line); }
      catch (_) { return null; }
    }).filter(Boolean);

    if (options.eventType) {
      events = events.filter(e => e.eventType === options.eventType);
    }
    if (options.videoId) {
      events = events.filter(e => e.videoId === options.videoId);
    }

    return events.slice(-limit);
  } catch (err) {
    console.error('[events] Failed to read events:', err.message);
    return [];
  }
}

/**
 * Get aggregated listen stats for recommendations.
 * Returns top-played tracks/artists based on complete+start events.
 */
function getListenStats() {
  if (!fs.existsSync(EVENTS_FILE)) {
    return { totalEvents: 0, uniqueTracks: 0, topTracks: [], topArtists: [] };
  }

  try {
    const lines = fs.readFileSync(EVENTS_FILE, 'utf8').split('\n').filter(l => l.trim());
    const trackCounts = {};
    const artistCounts = {};
    let totalEvents = 0;

    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        totalEvents++;

        // Weight completions and starts more heavily
        if (e.eventType === 'complete' || e.eventType === 'start' || e.eventType === 'replay') {
          const key = e.videoId;
          if (!trackCounts[key]) {
            trackCounts[key] = { videoId: e.videoId, title: e.title, artist: e.artist, count: 0 };
          }
          trackCounts[key].count += (e.eventType === 'complete' ? 3 : 1);
        }

        if (e.eventType === 'complete' && e.artist) {
          artistCounts[e.artist] = (artistCounts[e.artist] || 0) + 3;
        }
      } catch (_) {}
    }

    const topTracks = Object.values(trackCounts)
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    const topArtists = Object.entries(artistCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }));

    return {
      totalEvents,
      uniqueTracks: Object.keys(trackCounts).length,
      topTracks,
      topArtists,
    };
  } catch (err) {
    console.error('[events] Failed to compute stats:', err.message);
    return { totalEvents: 0, uniqueTracks: 0, topTracks: [], topArtists: [] };
  }
}

module.exports = {
  logEvent,
  getRecentEvents,
  getListenStats,
};