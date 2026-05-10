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

// YouTube stream URL — always proxied through server for iOS CORS/ATS compatibility
// Server handles yt-dlp resolution, caching, and deduplication
function ytStreamUrl(videoId) { return urlWithKey(`${API}/api/youtube/stream/${videoId}`); }
// SVG data-URI placeholder shown when no cover art is available
const _placeholderSvg = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><rect fill='%232c2c2e' width='200' height='200'/><text x='100' y='120' text-anchor='middle' font-size='64' font-family='sans-serif'>🎵</text></svg>`)}`;

function coverUrl(s) {
  if (!s) return _placeholderSvg;
  
  // PRIORITY 1: Use server-provided coverUrl if available (already correct format)
  if (s.coverUrl && !s.isStream) return urlWithKey(`${API}${s.coverUrl}`);
  
  // PRIORITY 2: For ANY song with a YouTube video ID, use YouTube thumbnail
  // This works for both stream songs and library songs that originated from YouTube
  const ytId = s.videoId || s.ytId || (s.isStream ? s.id : '');
  if (ytId && /^[a-zA-Z0-9_-]{11}$/.test(ytId)) {
    return urlWithKey(`${API}/api/proxy/image?url=${encodeURIComponent(`https://img.youtube.com/vi/${ytId}/mqdefault.jpg`)}`);
  }
  
  // PRIORITY 3: Stream songs with coverUrl (custom artwork)
  if (s.isStream && s.coverUrl) return urlWithKey(`${API}/api/proxy/image?url=${encodeURIComponent(s.coverUrl)}`);
  
  // PRIORITY 4: Library songs: check cache, then try server cover extraction
  const k = songKey(s);
  if (coverCache[k]) return coverCache[k];
  const f = s.file || s.filename || '';
  if (!f) return _placeholderSvg;
  return urlWithKey(`${API}/api/music/cover/${encodeURIComponent(s.playlist)}/${encodeURIComponent(f)}`);
}

// Global image error handler — replaces broken images with a visible placeholder
// instead of hiding them (which leaves empty gaps in the UI)
function onImageError(el) {
  if (el.dataset._errored) return; // prevent infinite loop
  el.dataset._errored = '1';
  el.src = _placeholderSvg;
  el.style.display = '';
  el.style.opacity = '1';
}
function formatTime(sec) {
  if (!sec || isNaN(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ':' + (s < 10 ? '0' : '') + s;
}
