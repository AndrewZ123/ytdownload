// ===== API CALLS =====
async function apiFetch(url, opts = {}, retries = RETRY_ATTEMPTS) {
  // Attach API key to every request for server authentication
  if (apiKey) {
    if (!opts.headers) opts.headers = {};
    if (typeof opts.headers === 'object' && !opts.headers['X-API-Key']) {
      opts.headers['X-API-Key'] = apiKey;
    }
  }
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, opts);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch(e) {
      if (i === retries - 1) throw e;
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
    // Clear stale cache so we never show outdated demo data
    localStorage.removeItem('cachedLibrary');
    songs = [];
    playlistNames = [];
    artistMap = {};
    albumMap = {};
    renderAll();
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

function checkServerStatus() {
  const banner = document.getElementById('offlineBanner');
  // Use public health endpoint (no auth required) for connectivity check
  fetch(`${API}/api/health`, {signal: AbortSignal.timeout(5000)})
    .then(res => res.json().then(data => ({ok: res.ok, data})))
    .then(({ok, data}) => {
      if (ok) {
        if (banner) banner.style.display = 'none';
        offlineMode = false;
        // Also refresh API key in case it changed after server restart
        if (data && data.apiKey) {
          apiKey = data.apiKey;
          localStorage.setItem('apiKey', apiKey);
        }
      } else {
        throw new Error('not ok');
      }
    })
    .catch(() => { if (banner) banner.style.display = 'flex'; offlineMode = true; });
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
