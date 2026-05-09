// ===== CONFIG =====
// For development: use HTTP with direct IP and port
// For production: use HTTPS domain after running ./setup-https.sh your-domain.com
//   Format: https://your-domain.com (NO trailing slash, NO port)
//
// NOTE: iOS release builds REQUIRE HTTPS. To enable:
//   1. Point your domain DNS to 157.151.254.26 (Oracle server IP)
//   2. Open ports 80/443 in Oracle Cloud Security List (ingress rules)
//   3. Run: ./setup-https.sh your-domain.com
//   4. Update this constant to https://your-domain.com
//   5. Rebuild the iOS app
const API = 'http://157.151.254.26:3000';

const APP_NAME = 'Melodia';
const HISTORY_LIMIT = 50;
const DB_NAME = 'MelodiaDB';
const DB_VERSION = 3;
const SEARCH_DEBOUNCE_MS = 300;
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;
const CROSSFADE_MS = 2000;

// API key for server authentication — fetched dynamically from server
let apiKey = localStorage.getItem('apiKey') || '';

// Fetch API key from server's public health endpoint (no auth required)
// Retries up to 3 times with exponential backoff for resilience
async function fetchApiKey() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      console.log(`[fetchApiKey] Attempt ${attempt + 1}/3 → ${API}/api/health`);
      const res = await fetch(`${API}/api/health`);
      console.log('[fetchApiKey] Response status:', res.status);
      if (res.ok) {
        const data = await res.json();
        if (data.apiKey) {
          apiKey = data.apiKey;
          localStorage.setItem('apiKey', apiKey);
          console.log('[fetchApiKey] ✅ API key fetched successfully');
          return true;
        }
      }
    } catch(e) {
      console.warn(`[fetchApiKey] Attempt ${attempt + 1} failed:`, e.message || e);
    }
    if (attempt < 2) {
      const delay = 2000 * (attempt + 1);
      console.log(`[fetchApiKey] Retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  console.error('[fetchApiKey] ❌ All attempts failed');
  return false;
}

// Append apiKey to a direct URL (for images, audio streams that can't use apiFetch)
function urlWithKey(url) {
  if (!apiKey) return url;
  const sep = url.includes('?') ? '&' : '?';
  return url + sep + 'apiKey=' + encodeURIComponent(apiKey);
}