 // ===== API CALLS =====
async function apiFetch(url, opts = {}, retries = RETRY_ATTEMPTS) {
  // Attach API key via BOTH header and URL query param for maximum compatibility.
  // CapacitorHttp plugin intercepts fetch() and may strip custom headers,
  // so the query param ensures auth works in all environments.
  if (apiKey) {
    // Add as query param (most reliable with CapacitorHttp)
    const sep = url.includes('?') ? '&' : '?';
    url = `${url}${sep}apiKey=${encodeURIComponent(apiKey)}`;
    // Also try header as fallback for standard browser environments
    if (!opts.headers) opts.headers = {};
    if (typeof opts.headers === 'object' && !opts.headers['X-API-Key']) {
      opts.headers['X-API-Key'] = apiKey;
    }
  }
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, opts);
      // CapacitorHttp may not set .ok properly — check status directly
      const isOk = res.ok || (res.status >= 200 && res.status < 300);
      if (!isOk) {
        let errBody = '';
        try { errBody = await res.text(); } catch(_) {}
        throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 200)}`);
      }
      // Pre-read body and return a plain wrapper object (NOT new Response()).
      // WKWebView/CapacitorHttp: new Response() silently fails with non-standard headers,
      // producing an empty body that makes .json() return {}. Using a plain object avoids this.
      let bodyText;
      try { bodyText = await res.text(); } catch(_) {}
      if (bodyText !== undefined && bodyText !== null) {
        return {
          ok: true,
          status: res.status || 200,
          statusText: res.statusText || 'OK',
          headers: res.headers,
          json: () => Promise.resolve(JSON.parse(bodyText)),
          text: () => Promise.resolve(bodyText)
        };
      }
      return res;
    } catch(e) {
      const msg = (e && e.message) ? e.message : String(e || 'Unknown error');
      if (i === retries - 1) throw e;
      console.warn(`[apiFetch] Attempt ${i + 1}/${retries} failed, retrying...`, msg);
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (i + 1)));
    }
  }
}

async function loadLibrary() {
  try {
    const res = await apiFetch(`${API}/api/music/library`);
    const data = await res.json();
    songs = data.songs || data || [];
    playlistNames = data.playlists || [...new Set(songs.map(s => s.playlist).filter(Boolean))];

    // Build maps
    artistMap = {};
    albumMap = {};
    songs.forEach(s => {
      if (s.artist) { artistMap[s.artist] = artistMap[s.artist] || []; artistMap[s.artist].push(s); }
      if (s.album) { albumMap[s.album] = albumMap[s.album] || []; albumMap[s.album].push(s); }
    });

    // Cache covers from offline
    const stored = await dbGetAll('covers');
    stored.forEach(c => { coverCache[c.key] = c.url; });

    renderAll();
    checkServerStatus();
  } catch(e) {
    console.error('Library load failed:', e);
    showServerError();
    // Start periodic health checks so app reconnects automatically
    checkServerStatus();
    // DON'T clear existing data — keep showing whatever we have (offline data, cached data)
    // Only render if we actually have something to show
    if (songs.length > 0 || Object.keys(artistMap).length > 0) {
      console.log('[loadLibrary] Keeping existing data for offline viewing');
      renderAll();
    } else {
      // No data at all — try loading from cache as last resort
      loadCachedLibrary();
    }
  }
}

async function loadCachedLibrary() {
  try {
    const cached = localStorage.getItem('cachedLibrary');
    if (cached) {
      const data = JSON.parse(cached);
      songs = data.songs || [];
      playlistNames = data.playlists || [];
      artistMap = data.artistMap || {};
      albumMap = data.albumMap || {};
      renderAll();
      toast('Showing cached library');
    }
  } catch(e) {}
}

function cacheLibrary() {
  try {
    localStorage.setItem('cachedLibrary', JSON.stringify({
      songs: songs.slice(0, 500), artistMap, albumMap, playlists: playlistNames
    }));
  } catch(e) {}
}

async function refreshLibrary() {
  try {
    await apiFetch(`${API}/api/music/library/refresh`, {method: 'POST'});
    await loadLibrary();
    cacheLibrary();
    toast('Library refreshed');
    hapticNotification('SUCCESS');
  } catch(e) {
    toast('Refresh failed');
    hapticNotification('ERROR');
  }
}

// Check server connectivity and auto-reconnect if needed
// Runs periodically every 30s when offline
let _healthCheckInterval = null;

function checkServerStatus() {
  const banner = document.getElementById('offlineBanner');
  fetch(`${API}/api/health`)
    .then(res => res.ok ? res.json().then(data => ({ok: true, data})) : Promise.reject('not ok'))
    .then(({ok, data}) => {
      if (banner) banner.style.display = 'none';
      offlineMode = false;
      // Refresh API key in case it changed after server restart
      if (data && data.apiKey) {
        apiKey = data.apiKey;
        localStorage.setItem('apiKey', apiKey);
      }
      // If we were offline and now reconnected, reload library
      if (_healthCheckInterval) {
        clearInterval(_healthCheckInterval);
        _healthCheckInterval = null;
        console.log('[health] ✅ Server reconnected — reloading library');
        toast('Server connected!');
        loadLibrary().then(cacheLibrary);
      }
    })
    .catch(() => {
      if (banner) banner.style.display = 'flex';
      offlineMode = true;
      // Start periodic health check if not already running
      if (!_healthCheckInterval) {
        console.log('[health] ❌ Server unreachable — will retry every 30s');
        _healthCheckInterval = setInterval(() => {
          console.log('[health] Retrying...');
          checkServerStatus();
        }, 30000);
      }
    });
}

function showServerError() {
  const banner = document.getElementById('offlineBanner');
  if (banner) { banner.style.display = 'flex'; offlineMode = true; }
}

async function downloadFromURL(url, playlist) {
  toast('Starting download...');
  try {
    const res = await apiFetch(`${API}/api/music/download`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({url, playlist: playlist || 'Library'})
    });
    if (!res.ok) throw new Error('Download failed');
    toast('Download complete!');
    hapticNotification('SUCCESS');
    await refreshLibrary();
    return true;
  } catch(e) {
    toast('Download failed');
    hapticNotification('ERROR');
    return false;
  }
}
