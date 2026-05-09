// ===== SEARCH =====

let searchDebounce = null;
let searchHistory = JSON.parse(localStorage.getItem('searchHistory') || '[]');

// Client-side search cache (30 min) — avoids hitting server for repeated queries
const _searchCache = new Map();
const SEARCH_CACHE_TTL = 30 * 60 * 1000;

function onSearchInput(el) {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => doSearch(el.value), 300);
}

async function doSearch(q) {
  q = q.trim();
  const el = document.getElementById('searchPageResults');
  if (!el) return;
  if (!q) { renderSearchHistory(el); return; }

  // Check client-side cache first (saves server round-trip + API credits)
  const cacheKey = q.toLowerCase();
  const cached = _searchCache.get(cacheKey);
  if (cached && Date.now() - cached.time < SEARCH_CACHE_TTL) {
    console.log('[search] Client cache hit for:', q);
    renderSearchResults(el, cached.results, q);
    return;
  }

  el.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Searching YouTube...</p></div>';
  try {
    const res = await apiFetch(`${API}/api/music/search?q=${encodeURIComponent(q)}`);
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 200)}`);
    }
    const data = await res.json();
    const results = data.results || data || [];

    // Store in client-side cache
    _searchCache.set(cacheKey, { results, time: Date.now() });

    renderSearchResults(el, results, q);
  } catch(e) {
    const errMsg = (e && e.message) ? e.message : String(e || 'Unknown error');
    console.error('[search] Search failed:', errMsg);
    el.innerHTML = '<div class="empty-state"><h3>Search Failed</h3><p>' + errMsg + '</p></div>';
  }
}

// Render search results into a container element
function renderSearchResults(el, results, query) {
  if (!Array.isArray(results) || results.length === 0) {
    el.innerHTML = '<div class="empty-state"><h3>No Results</h3><p>Try a different search term</p></div>';
    return;
  }
  // Store results for play/download actions
  window._searchResults = results;

  el.innerHTML = results.map((r, i) => {
    const videoId = r.id || '';
    const rawThumb = r.thumbnail || (videoId ? `https://img.youtube.com/vi/${videoId}/mqdefault.jpg` : '');
    const thumbUrl = rawThumb || '';
    const duration = r.durationFormatted || (r.duration ? `${Math.floor(r.duration / 60)}:${(r.duration % 60).toString().padStart(2, '0')}` : '');

    return `<div class="search-result-item" onclick="playSearchResult(${i})" role="button" aria-label="Play ${r.title || 'Untitled'}">
      <div class="search-result-thumb"${thumbUrl ? ` style="background-image:url('${thumbUrl}')"` : ''}>
        ${duration ? `<span class="search-result-duration">${duration}</span>` : ''}
        <button class="search-play-btn" onclick="event.stopPropagation();playSearchResult(${i})" aria-label="Play">
          <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
      </div>
      <div class="search-result-info">
        <div class="search-result-title">${r.title || 'Untitled'}</div>
        <div class="search-result-channel">${r.channel || ''}</div>
      </div>
      <button class="search-dl-btn" onclick="event.stopPropagation();downloadResult(${i})" aria-label="Download to library" title="Download">
        <svg class="icon-sm"><use href="#icon-download"/></svg>
      </button>
    </div>`;
  }).join('');

  // Save search history
  if (query && !searchHistory.includes(query)) {
    searchHistory.unshift(query);
    searchHistory = searchHistory.slice(0, 10);
    localStorage.setItem('searchHistory', JSON.stringify(searchHistory));
  }

  // Pre-cache stream URLs for top results (background, non-blocking)
  results.slice(0, 3).forEach(r => {
    if (r.id) preCacheStreamUrl(r.id);
  });
}

function renderSearchHistory(el) {
  if (searchHistory.length === 0) {
    el.innerHTML = '<div class="empty-state"><svg class="icon-empty"><use href="#icon-tab-search"/></svg><h3>Search</h3><p>Find any song on YouTube</p></div>';
    return;
  }
  el.innerHTML = '<div class="search-history"><h3>Recent Searches</h3>' +
    searchHistory.map(q => `<div class="search-history-item" onclick="document.getElementById('searchPageInput').value='${q.replace(/'/g, "\\'")}';doSearch('${q.replace(/'/g, "\\'")}')">${q}</div>`).join('') +
    '<button class="ctx-btn" onclick="clearSearchHistory()" style="margin-top:12px">Clear History</button></div>';
}

// --- Instant Stream Playback ---
function playSearchResult(idx) {
  const r = window._searchResults?.[idx];
  if (!r) return;

  // Guard: if a stream is already loading, ignore additional clicks
  if (typeof _streamLoading !== 'undefined' && _streamLoading) {
    console.log('[search] Ignoring click — stream already loading');
    return;
  }

  const videoId = r.id || '';

  // Create a temporary song object for streaming
  const tempSong = {
    id: videoId,
    title: r.title || 'Streaming...',
    artist: r.channel || '',
    coverUrl: r.thumbnail || (videoId ? `https://img.youtube.com/vi/${videoId}/mqdefault.jpg` : ''),
    isStream: true
  };

  // Play it directly
  if (typeof playSong === 'function') {
    queue = [tempSong];
    queueIndex = 0;
    playSong(tempSong);
    hapticImpact('MEDIUM');
  }

  // Add all results to queue for auto-play next
  if (window._searchResults && window._searchResults.length > 1) {
    const searchQueue = window._searchResults.map(sr => ({
      id: sr.id || '',
      title: sr.title || 'Streaming...',
      artist: sr.channel || '',
      coverUrl: sr.thumbnail || (sr.id ? `https://img.youtube.com/vi/${sr.id}/mqdefault.jpg` : ''),
      isStream: true
    }));
    queue = searchQueue;
    queueIndex = idx;
  }

  // Fetch richer metadata in background
  if (videoId && typeof apiFetch === 'function') {
    apiFetch(`${API}/api/youtube/info/${videoId}`)
      .then(r => r.ok ? r.json() : null)
      .then(info => {
        if (!info) return;
        if (currentSong && currentSong.id === videoId && currentSong.isStream) {
          currentSong.title = info.title || currentSong.title;
          currentSong.artist = info.artist || currentSong.artist;
          if (info.thumbnail) currentSong.coverUrl = info.thumbnail;
          if (queue[queueIndex]) {
            queue[queueIndex].title = currentSong.title;
            queue[queueIndex].artist = currentSong.artist;
          }
          if (typeof updateNowPlayingInfo === 'function') updateNowPlayingInfo();
        }
      })
      .catch(() => {});
  }
}

// --- Download to Library ---
async function downloadResult(idx) {
  const r = window._searchResults?.[idx];
  if (!r) return;
  const videoId = r.id || '';
  if (!videoId) return;

  // Show toast immediately
  toast(`Downloading "${r.title || 'song'}"...`);
  hapticNotification('SUCCESS');

  try {
    const res = await apiFetch(`${API}/api/music/add`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${videoId}` })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Download failed');
    }

    const result = await res.json();
    toast(`Added "${result.song?.title || r.title || 'song'}" to library`);
    hapticNotification('SUCCESS');

    // Refresh library in background
    if (typeof loadLibrary === 'function') loadLibrary();
  } catch(e) {
    console.error('Download failed:', e);
    toast('Download failed: ' + (e.message || 'Unknown error'));
    hapticNotification('ERROR');
  }
}

// Client-side stream URL cache for instant playback
const _streamUrlCache = new Map();

// Fetch and cache a stream URL for a video (used for pre-caching and playback)
async function fetchStreamUrl(videoId) {
  if (!videoId) return null;
  if (_streamUrlCache.has(videoId)) return _streamUrlCache.get(videoId);
  try {
    const res = await apiFetch(`${API}/api/youtube/stream-url/${videoId}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.streamUrl) {
      _streamUrlCache.set(videoId, data.streamUrl);
      return data.streamUrl;
    }
  } catch(e) {}
  return null;
}

// --- Pre-cache stream URL for faster playback ---
function preCacheStreamUrl(videoId) {
  if (!videoId) return;
  fetchStreamUrl(videoId).catch(() => {}); // silent - this is just a prefetch
}

function clearSearch() {
  const input = document.getElementById('searchPageInput');
  if (input) input.value = '';
  const el = document.getElementById('searchPageResults');
  if (el) renderSearchHistory(el);
}

function clearSearchHistory() {
  searchHistory = [];
  localStorage.removeItem('searchHistory');
  const el = document.getElementById('searchPageResults');
  if (el) renderSearchHistory(el);
}