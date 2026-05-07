// ===== APP STATE =====
let songs = [];
let artistMap = {};
let albumMap = {};
let playlistNames = [];
let currentSong = null;
let queue = [];
let queueIndex = -1;
let shuffleMode = false;
let repeatMode = 'none'; // none, all, one
let currentPlaylist = null;
let offlineMode = !navigator.onLine;
let offlineKeys = new Set();
let likedKeys = new Set();
let historyItems = [];
let coverCache = {};
let songSortBy = 'default';
let songFilterBy = null;
let playbackSpeed = parseFloat(localStorage.getItem('playbackSpeed') || '1');
let sleepTimerEnd = null;
let sleepTimerInterval = null;
let crossfadeEnabled = localStorage.getItem('crossfade') === 'true';
let prebufferedSong = null;
let downloadQueue = [];
let isDownloading = false;

const audio = new Audio();
audio.preload = 'auto';
audio.playbackRate = playbackSpeed;
audio.volume = parseFloat(localStorage.getItem('volume') || '1');

function songKey(s) {
  if (s.isStream && s.id) return 'stream/' + s.id;
  return (s.playlist || '') + '/' + (s.file || s.filename || '');
}
function audioUrl(s) {
  // Library songs: stream from server
  return urlWithKey(`${API}/api/music/stream/${s.playlist}/${s.file || s.filename}`);
}

// Fetch a direct CDN playback URL for YouTube streams (bypasses server proxy)
async function fetchStreamUrl(videoId) {
  const res = await apiFetch(`${API}/api/youtube/stream-url/${videoId}`);
  if (!res.ok) throw new Error(`stream-url API returned ${res.status}`);
  const data = await res.json();
  if (!data.streamUrl) throw new Error('No streamUrl in response');
  return data.streamUrl;
}
function ytStreamUrl(videoId) { return urlWithKey(`${API}/api/youtube/stream/${videoId}`); }
function coverUrl(s) {
  // Use server-provided coverUrl if available (already correct format)
  if (s.coverUrl && !s.isStream) return urlWithKey(`${API}${s.coverUrl}`);
  // Stream songs: proxy YouTube thumbnails to avoid iOS ATS issues
  if (s.isStream && s.coverUrl) return urlWithKey(`${API}/api/proxy/image?url=${encodeURIComponent(s.coverUrl)}`);
  const k = songKey(s);
  if (coverCache[k]) return coverCache[k];
  const f = s.file || s.filename || '';
  if (!f) return '';
  // Use the actual audio filename - server extracts cover art from it
  return urlWithKey(`${API}/api/music/cover/${encodeURIComponent(s.playlist)}/${encodeURIComponent(f)}`);
}
function formatTime(sec) {
  if (!sec || isNaN(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ':' + (s < 10 ? '0' : '') + s;
}
