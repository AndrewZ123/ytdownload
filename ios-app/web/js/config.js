// ===== CONFIG =====
const API = 'http://157.151.254.26:3000';
const APP_NAME = 'Melodia';
const HISTORY_LIMIT = 50;
const DB_NAME = 'MelodiaDB';
const DB_VERSION = 3;
const SEARCH_DEBOUNCE_MS = 300;
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;
const CROSSFADE_MS = 2000;

// API key for server authentication (fetched from server on startup)
let apiKey = localStorage.getItem('apiKey') || '';

// Fetch API key from server settings
async function fetchApiKey() {
  // First try cached key
  if (apiKey) return;
  try {
    // /api/settings works without auth on local/private networks
    const res = await fetch(`${API}/api/settings`);
    if (res.ok) {
      const data = await res.json();
      if (data.apiKey) {
        apiKey = data.apiKey;
        localStorage.setItem('apiKey', apiKey);
        console.log('API key fetched successfully');
      }
    }
  } catch(e) { console.warn('Could not fetch API key:', e); }
}

// Append apiKey to a direct URL (for images, audio streams that can't use apiFetch)
function urlWithKey(url) {
  if (!apiKey) return url;
  const sep = url.includes('?') ? '&' : '?';
  return url + sep + 'apiKey=' + encodeURIComponent(apiKey);
}

// Fetch API key immediately
fetchApiKey();