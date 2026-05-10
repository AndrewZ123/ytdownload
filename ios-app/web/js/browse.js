// ===== BROWSE TAB RENDERING =====
// Sections: local data (instant) + discovery suggestions (from server API)

// --- State ---
let discoverData = null;
let discoverLoading = false;
let discoverError = null;
let addingSongId = null; // track which song is being added

function renderBrowse() {
  // Local sections (instant, offline-capable)
  renderBrowseRecentlyPlayed();
  renderBrowseLikedPicks();
  renderBrowseTopArtists();
  renderBrowseExploreAlbums();
  renderBrowseMadeForYou();
  
  // Discovery sections (from server - suggests NEW songs)
  renderBrowseDiscovery();
}

// --- Discovery: Fetch from server ---
async function fetchDiscover() {
  if (discoverLoading || discoverData) return;
  discoverLoading = true;
  discoverError = null;
  
  try {
    const res = await apiFetch(`${API}/api/discover`);
    const data = await res.json();
    discoverData = data;
    discoverLoading = false;
    renderDiscoverySections();
  } catch(e) {
    console.error('Discover fetch failed:', e);
    discoverLoading = false;
    discoverError = e.message;
    renderDiscoverySections();
  }
}

function renderBrowseDiscovery() {
  const container = document.getElementById('browseDiscovery');
  if (!container) return;
  
  if (discoverData) {
    renderDiscoverySections();
  } else if (discoverError) {
    container.innerHTML = `<div class="discover-error">
      <p>Could not load suggestions</p>
      <button class="btn-secondary" onclick="retryDiscover()">Try Again</button>
    </div>`;
  } else {
    // Show loading skeletons
    container.innerHTML = buildDiscoverSkeletons();
    fetchDiscover();
  }
}

function retryDiscover() {
  discoverData = null;
  discoverError = null;
  discoverLoading = false;
  renderBrowseDiscovery();
}

function buildDiscoverSkeletons() {
  let html = '';
  // Skeleton for 3 sections
  for (let s = 0; s < 3; s++) {
    html += `<section class="section discover-section">
      <div class="section-header">
        <h2><span class="skeleton-text" style="width:180px;height:20px;display:inline-block"></span></h2>
      </div>
      <div class="card-grid">`;
    for (let i = 0; i < 6; i++) {
      html += `<div class="card discover-card skeleton-card">
        <div class="card-art skeleton-pulse"></div>
        <div class="card-title skeleton-text" style="height:14px"></div>
        <div class="card-sub skeleton-text" style="height:12px;width:60%"></div>
      </div>`;
    }
    html += `</div></section>`;
  }
  return html;
}

function renderDiscoverySections() {
  const container = document.getElementById('browseDiscovery');
  if (!container || !discoverData) return;
  
  const d = discoverData;
  let html = '';
  
  // Section 1: "Because You Listened To..." - Artist-based recommendations
  if (d.becauseYouListened && d.becauseYouListened.length > 0) {
    html += buildDiscoverSection(
      'discoverBecause',
      d.becauseYouListenedSource ? `Because You Listened to ${escapeHtml(d.becauseYouListenedSource)}` : 'Based on Your Listening',
      d.becauseYouListened
    );
  }
  
  // Section 2: New Releases For You
  if (d.newReleases && d.newReleases.length > 0) {
    html += buildDiscoverSection(
      'discoverNewReleases', 
      'New Releases For You',
      d.newReleases
    );
  }
  
  // Section 3: Trending in Your Taste
  if (d.trendingInYourTaste && d.trendingInYourTaste.length > 0) {
    html += buildDiscoverSection(
      'discoverTrending',
      d.detectedGenre ? `Trending ${formatGenreName(d.detectedGenre)}` : 'Trending For You',
      d.trendingInYourTaste
    );
  }
  
  // Section 4: Artists You Might Like
  if (d.artistRecommendations && d.artistRecommendations.length > 0) {
    html += buildDiscoverSection(
      'discoverArtists',
      'Artists You Might Like',
      d.artistRecommendations
    );
  }
  
  // Section 5: Hidden Gems
  if (d.hiddenGems && d.hiddenGems.length > 0) {
    html += buildDiscoverSection(
      'discoverGems',
      'Hidden Gems & Deep Cuts',
      d.hiddenGems
    );
  }
  
  // Section 6: Similar to your favorites (YouTube Radio-based)
  if (d.radioRecommendations && d.radioRecommendations.length > 0) {
    html += buildDiscoverSection(
      'discoverRadio',
      d.radioSource ? `Songs Like ${escapeHtml(d.radioSource)}` : 'More Like Your Favorites',
      d.radioRecommendations
    );
  }
  
  // Section 7: Cross-Genre Discovery
  if (d.crossGenre && d.crossGenre.length > 0) {
    html += buildDiscoverSection(
      'discoverCrossGenre',
      d.crossGenreLabel || 'Expand Your Horizons',
      d.crossGenre,
      'Based on your listening patterns'
    );
  }
  
  // Section 8: Mood Picks
  if (d.moodPicks && d.moodPicks.length > 0) {
    html += buildDiscoverSection(
      'discoverMood',
      d.moodLabel || 'Mood Picks',
      d.moodPicks,
      d.moodDescription || ''
    );
  }
  
  if (!html) {
    html = `<div class="discover-empty">
      <div class="discover-empty-icon">🎵</div>
      <p>Add more songs to your library to get personalized recommendations</p>
      <button class="btn-secondary" onclick="retryDiscover()">Refresh</button>
    </div>`;
  }
  
  // Add refresh button
  html += `<div class="discover-refresh">
    <button class="btn-secondary" onclick="refreshDiscover()">
      <svg style="width:16px;height:16px;margin-right:6px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
      Refresh Suggestions
    </button>
  </div>`;
  
  container.innerHTML = html;
}

function buildDiscoverSection(id, title, items, subtitle) {
  const cards = items.slice(0, 10).map(item => buildDiscoverCard(item)).join('');
  const subtitleHtml = subtitle ? `<span class="disc-subtitle">${escapeHtml(subtitle)}</span>` : '';
  return `<section class="section discovery-section">
    <div class="discovery-section-header"><h2>${title}</h2>${subtitleHtml}</div>
    <div id="${id}" class="discovery-scroll">${cards}</div>
  </section>`;
}

function buildDiscoverCard(item) {
  const thumbUrl = item.thumbnail || '';
  const title = escapeHtml(item.title || 'Unknown');
  const channel = escapeHtml(item.channel || item.artist || '');
  const videoId = item.id || '';
  const duration = item.duration ? formatDuration(item.duration) : '';
  
  return `<div class="card discover-card" data-video-id="${videoId}">
    <div class="card-art discover-card-art">
      ${thumbUrl ? `<img src="${urlWithKey(API + '/api/proxy/image?url=' + encodeURIComponent(thumbUrl))}" alt="" loading="lazy" onerror="onImageError(this)">` : `<div class="discover-placeholder-art">🎵</div>`}
      ${duration ? `<span class="discover-duration">${duration}</span>` : ''}
      <button class="discover-play-btn" onclick="event.stopPropagation();playDiscoverSong('${videoId}','${title.replace(/'/g, "\\'")}')">
        <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      </button>
    </div>
    <div class="card-title discover-title">${title}</div>
    <div class="card-sub discover-sub">${channel}</div>
    <button class="discover-add-btn" onclick="event.stopPropagation();addToLibraryFromDiscover('${videoId}',this)" title="Add to Library">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>
  </div>`;
}

function formatDuration(sec) {
  if (!sec) return '';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatGenreName(genre) {
  const names = {
    worship: 'Worship & Christian',
    hiphop: 'Hip-Hop',
    rock: 'Rock',
    pop: 'Pop',
    edm: 'Electronic',
    rnb: 'R&B & Soul',
    country: 'Country',
    jazz: 'Jazz & Blues',
    classical: 'Classical',
    latin: 'Latin',
    metal: 'Metal',
    indie: 'Indie',
    folk: 'Folk & Acoustic'
  };
  return names[genre] || genre.charAt(0).toUpperCase() + genre.slice(1);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Add to Library from Discover ---
async function addToLibraryFromDiscover(videoId, btnEl) {
  if (!videoId || addingSongId === videoId) return;
  addingSongId = videoId;
  
  const card = btnEl.closest('.discover-card');
  
  // Update button to loading state
  btnEl.disabled = true;
  btnEl.innerHTML = `<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>`;
  btnEl.classList.add('adding');
  
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
    
    // Success - update card UI
    btnEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
    btnEl.classList.remove('adding');
    btnEl.classList.add('added');
    btnEl.style.color = '#34c759';
    btnEl.style.borderColor = '#34c759';
    card.classList.add('discover-added');
    
    hapticNotification('SUCCESS');
    toast(`Added "${result.song?.title || 'song'}" to library`);
    
    // Refresh library in background
    loadLibrary();
    
  } catch(e) {
    console.error('Add to library failed:', e);
    btnEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
    btnEl.classList.remove('adding');
    btnEl.disabled = false;
    toast('Failed to add song');
    hapticNotification('ERROR');
  }
  
  addingSongId = null;
}

// --- Play a discovered song (stream from YouTube via server proxy) ---
function playDiscoverSong(videoId, title) {
  if (!videoId) return;
  // Create a temporary song object for instant streaming
  const tempSong = {
    id: videoId,
    title: title || 'Streaming...',
    artist: '',
    coverUrl: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
    isStream: true
  };
  
  // Play it directly via server proxy stream
  if (typeof playSong === 'function') {
    queue = [tempSong];
    queueIndex = 0;
    playSong(tempSong);
    hapticImpact('MEDIUM');
  }
  
  // Fetch metadata in background to update title/artist
  if (typeof apiFetch === 'function') {
    apiFetch(`${API}/api/youtube/info/${videoId}`)
      .then(r => r.ok ? r.json() : null)
      .then(info => {
        if (!info) return;
        // Update current song metadata if still playing this stream
        if (currentSong && currentSong.id === videoId && currentSong.isStream) {
          currentSong.title = info.title || currentSong.title;
          currentSong.artist = info.artist || '';
          if (info.thumbnail) currentSong.coverUrl = info.thumbnail;
          // Update queue entry too
          if (queue[queueIndex]) {
            queue[queueIndex].title = currentSong.title;
            queue[queueIndex].artist = currentSong.artist;
          }
          // Refresh now-playing UI
          if (typeof updateNowPlaying === 'function') updateNowPlaying();
        }
      })
      .catch(() => {}); // silent fail - metadata is optional
  }
}

// --- Refresh discovery ---
function refreshDiscover() {
  discoverData = null;
  discoverLoading = false;
  discoverError = null;
  renderBrowseDiscovery();
}

// --- Local section helpers ---
function browseCardHTML(s, context) {
  const k = songKey(s);
  return `<div class="card" onclick="playSongFromList('${k}','${context}')">
    <div class="card-art"><img src="${coverUrl(s)}" alt="" loading="lazy" onerror="onImageError(this)"></div>
    <div class="card-title">${s.title||''}</div>
    <div class="card-sub">${s.artist||''}</div>
  </div>`;
}

function browseArtistCardHTML(name) {
  const count = (artistMap[name]||[]).length;
  return `<div class="card" onclick="openArtist('${name.replace(/'/g,"\\'")}')">
    <div class="card-art artist-icon">${name.charAt(0).toUpperCase()}</div>
    <div class="card-title">${name}</div>
    <div class="card-sub">${count} song${count!==1?'s':''}</div>
  </div>`;
}

function browseAlbumCardHTML(name) {
  const aSongs = albumMap[name]||[];
  const first = aSongs[0];
  return `<div class="card" onclick="openAlbum('${name.replace(/'/g,"\\'")}')">
    <div class="card-art"><img src="${first?coverUrl(first):_placeholderSvg}" alt="" loading="lazy" onerror="onImageError(this)"></div>
    <div class="card-title">${name}</div>
    <div class="card-sub">${aSongs.length} song${aSongs.length!==1?'s':''}</div>
  </div>`;
}

// --- Local Sections ---

function renderBrowseRecentlyPlayed() {
  const el = document.getElementById('browseRecentlyPlayed');
  if (!el) return;
  const recent = historyItems.slice(0, 8).map(h => h.data).filter(Boolean);
  if (recent.length === 0) {
    const fallback = songs.slice(-8).reverse();
    if (fallback.length === 0) { el.innerHTML = ''; return; }
    el.innerHTML = fallback.map(s => browseCardHTML(s, 'browse-recent')).join('');
    return;
  }
  el.innerHTML = recent.map(s => browseCardHTML(s, 'browse-recent')).join('');
}

function renderBrowseLikedPicks() {
  const el = document.getElementById('browseLikedPicks');
  if (!el) return;
  const liked = songs.filter(s => likedKeys.has(songKey(s)));
  if (liked.length === 0) { el.innerHTML = ''; return; }
  const shuffled = [...liked].sort(() => Math.random() - 0.5).slice(0, 8);
  el.innerHTML = shuffled.map(s => browseCardHTML(s, 'browse-liked')).join('');
}

function renderBrowseTopArtists() {
  const el = document.getElementById('browseTopArtists');
  if (!el) return;
  const artistPlays = {};
  historyItems.forEach(h => {
    if (h.data && h.data.artist) {
      artistPlays[h.data.artist] = (artistPlays[h.data.artist]||0) + 1;
    }
  });
  const artists = Object.keys(artistMap).sort((a,b) => {
    const pa = artistPlays[a]||0;
    const pb = artistPlays[b]||0;
    if (pb !== pa) return pb - pa;
    return (artistMap[b]||[]).length - (artistMap[a]||[]).length;
  }).slice(0, 8);
  if (artists.length === 0) { el.innerHTML = ''; return; }
  el.innerHTML = artists.map(name => browseArtistCardHTML(name)).join('');
}

function renderBrowseExploreAlbums() {
  const el = document.getElementById('browseExploreAlbums');
  if (!el) return;
  const albums = Object.keys(albumMap).sort(() => Math.random() - 0.5).slice(0, 8);
  if (albums.length === 0) { el.innerHTML = ''; return; }
  el.innerHTML = albums.map(name => browseAlbumCardHTML(name)).join('');
}

function renderBrowseMadeForYou() {
  const el = document.getElementById('browseMadeForYou');
  if (!el) return;
  const sections = [];

  // "Your Mix"
  const mixSources = [
    ...songs.filter(s => likedKeys.has(songKey(s))),
    ...historyItems.slice(0, 10).map(h => h.data).filter(Boolean)
  ];
  const seen = new Set();
  const mix = [];
  for (const s of mixSources) {
    const k = songKey(s);
    if (!seen.has(k)) { seen.add(k); mix.push(s); }
  }
  if (mix.length >= 3) {
    sections.push(`<div class="browse-mix-card" onclick="playBrowseMix()">
      <div class="browse-mix-bg"></div>
      <div class="browse-mix-content">
        <svg class="icon-md" style="color:#fc3c44"><use href="#icon-shuffle"/></svg>
        <div>
          <div class="card-title" style="color:#fff">Your Daily Mix</div>
          <div class="card-sub" style="color:rgba(255,255,255,.7)">${mix.length} songs based on your taste</div>
        </div>
      </div>
    </div>`);
  }

  // Deep Focus
  const longSongs = songs.filter(s => (s.duration||0) > 300).sort(() => Math.random() - 0.5).slice(0, 6);
  if (longSongs.length >= 3) {
    sections.push(`<div class="browse-mix-card" onclick="playBrowseLong()">
      <div class="browse-mix-bg" style="background:linear-gradient(135deg,#34c759,#30d158)"></div>
      <div class="browse-mix-content">
        <svg class="icon-md" style="color:#fff"><use href="#icon-clock"/></svg>
        <div>
          <div class="card-title" style="color:#fff">Deep Focus</div>
          <div class="card-sub" style="color:rgba(255,255,255,.7)">${longSongs.length} long tracks for concentration</div>
        </div>
      </div>
    </div>`);
  }

  el.innerHTML = sections.join('');
}

// --- Browse Mix Play Actions ---
function playBrowseMix() {
  const mixSources = [
    ...songs.filter(s => likedKeys.has(songKey(s))),
    ...historyItems.slice(0, 10).map(h => h.data).filter(Boolean)
  ];
  const seen = new Set();
  const mix = [];
  for (const s of mixSources) {
    const k = songKey(s);
    if (!seen.has(k) && s) { seen.add(k); mix.push(s); }
  }
  if (mix.length === 0) return;
  queue = [...mix].sort(() => Math.random() - 0.5);
  queueIndex = 0;
  playSong(queue[0]);
  hapticImpact('MEDIUM');
}

function playBrowseLong() {
  const longSongs = songs.filter(s => (s.duration||0) > 300).sort(() => Math.random() - 0.5);
  if (longSongs.length === 0) return;
  queue = [...longSongs];
  queueIndex = 0;
  playSong(queue[0]);
  hapticImpact('MEDIUM');
}