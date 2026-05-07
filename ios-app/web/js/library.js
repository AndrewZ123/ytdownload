// ===== LIBRARY RENDERING =====
function renderAll() {
  renderListenNow();
  if (typeof renderBrowse === 'function') renderBrowse();
  renderLibPlaylists();
  renderLibArtists();
  renderLibAlbums();
  renderLibSongs();
  renderLibDownloaded();
}

function renderListenNow() {
  const el = document.getElementById('recentGrid');
  if (!el) return;
  const recent = songs.slice(-6).reverse();
  el.innerHTML = recent.map(s => `<div class="card" onclick="playSongFromList('${songKey(s)}','recent')">
    <div class="card-art"><img src="${coverUrl(s)}" alt="" loading="lazy" onerror="this.style.display='none'"></div>
    <div class="card-title">${s.title||''}</div>
    <div class="card-sub">${s.artist||''}</div>
  </div>`).join('');

  renderHistoryCards();
  renderLikedCard();
}

function renderHistoryCards() {
  const el = document.getElementById('historyGrid');
  if (!el) return;
  const recent = historyItems.slice(0, 8).map(h => h.data).filter(Boolean);
  if (recent.length === 0) { el.innerHTML = ''; return; }
  el.innerHTML = recent.map(s => `<div class="card" onclick="playSongFromList('${songKey(s)}','history')">
    <div class="card-art"><img src="${coverUrl(s)}" alt="" loading="lazy" onerror="this.style.display='none'"></div>
    <div class="card-title">${s.title||''}</div>
    <div class="card-sub">${s.artist||''}</div>
  </div>`).join('');
}

function renderLikedCard() {
  const el = document.getElementById('likedCard');
  if (!el) return;
  if (likedKeys.size === 0) { el.style.display = 'none'; return; }
  el.style.display = '';
}

function renderLibPlaylists() {
  const el = document.getElementById('libPlaylistsGrid');
  if (!el) return;
  if (playlistNames.length === 0) { el.innerHTML = '<div class="empty-state"><h3>No Playlists</h3><p>Download music to create playlists</p></div>'; return; }
  el.innerHTML = playlistNames.map(name => {
    const pSongs = songs.filter(s => s.playlist === name);
    const first = pSongs[0];
    return `<div class="card" onclick="openPlaylist('${name.replace(/'/g, "\\'")}')">
      <div class="card-art"><img src="${first ? coverUrl(first) : ''}" alt="" loading="lazy" onerror="this.style.display='none'"></div>
      <div class="card-title">${name}</div>
      <div class="card-sub">${pSongs.length} song${pSongs.length!==1?'s':''}</div>
    </div>`;
  }).join('');
}

function renderLibArtists() {
  const el = document.getElementById('libArtistsGrid');
  if (!el) return;
  const artists = Object.keys(artistMap).sort();
  if (artists.length === 0) { el.innerHTML = '<div class="empty-state"><h3>No Artists</h3></div>'; return; }
  el.innerHTML = artists.map(name => {
    const count = artistMap[name].length;
    return `<div class="card" onclick="openArtist('${name.replace(/'/g, "\\'")}')">
      <div class="card-art artist-icon">${name.charAt(0).toUpperCase()}</div>
      <div class="card-title">${name}</div>
      <div class="card-sub">${count} song${count!==1?'s':''}</div>
    </div>`;
  }).join('');
}

function renderLibAlbums() {
  const el = document.getElementById('libAlbumsGrid');
  if (!el) return;
  const albums = Object.keys(albumMap).sort();
  if (albums.length === 0) { el.innerHTML = '<div class="empty-state"><h3>No Albums</h3></div>'; return; }
  el.innerHTML = albums.map(name => {
    const aSongs = albumMap[name];
    const first = aSongs[0];
    return `<div class="card" onclick="openAlbum('${name.replace(/'/g, "\\'")}')">
      <div class="card-art"><img src="${first ? coverUrl(first) : ''}" alt="" loading="lazy" onerror="this.style.display='none'"></div>
      <div class="card-title">${name}</div>
      <div class="card-sub">${aSongs.length} song${aSongs.length!==1?'s':''}</div>
    </div>`;
  }).join('');
}

function getSortedSongs() {
  let list = [...songs];
  if (songFilterBy === 'downloaded') list = list.filter(s => offlineKeys.has(songKey(s)));
  else if (songFilterBy === 'liked') list = list.filter(s => likedKeys.has(songKey(s)));
  switch (songSortBy) {
    case 'title': list.sort((a,b) => (a.title||'').localeCompare(b.title||'')); break;
    case 'artist': list.sort((a,b) => (a.artist||'').localeCompare(b.artist||'')); break;
    case 'duration': list.sort((a,b) => (a.duration||0) - (b.duration||0)); break;
    case 'recent': list.sort((a,b) => (b.addedAt||0) - (a.addedAt||0)); break;
  }
  return list;
}

function renderLibSongs() {
  const el = document.getElementById('libSongsList');
  if (!el) return;
  const list = getSortedSongs();
  if (list.length === 0) {
    el.innerHTML = '<div class="empty-state"><h3>No Songs</h3><p>Download music to get started</p></div>';
    return;
  }
  el.innerHTML = list.map(s => songItemHTML(s, 'libSearch')).join('');
}

function renderLibDownloaded() {
  const el = document.getElementById('libDownloadedList');
  if (!el) return;
  const dlSongs = songs.filter(s => offlineKeys.has(songKey(s)));
  if (dlSongs.length === 0) {
    el.innerHTML = '<div class="empty-state"><h3>No Downloads</h3><p>Download songs for offline listening</p><button class="action-btn" onclick="showDownloadSheet()">Download Music</button></div>';
    return;
  }
  el.innerHTML = dlSongs.map(s => songItemHTML(s, 'downloaded')).join('');
}

// ===== PLAYLIST VIEW =====
function openPlaylist(name) {
  currentPlaylist = name;
  const pSongs = songs.filter(s => s.playlist === name);
  const first = pSongs[0];
  document.getElementById('pvTitle').textContent = name;
  document.getElementById('pvName').textContent = name;
  document.getElementById('pvCount').textContent = pSongs.length + ' song' + (pSongs.length !== 1 ? 's' : '');
  const artEl = document.getElementById('pvArt');
  if (artEl) { artEl.src = first ? coverUrl(first) : ''; artEl.onerror = () => artEl.style.display = 'none'; }
  document.getElementById('pvSongs').innerHTML = pSongs.map(s => songItemHTML(s, 'playlist')).join('');
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('playlistView')?.classList.add('active');
}

function openLikedSongs() {
  const likedSongs = songs.filter(s => likedKeys.has(songKey(s)));
  currentPlaylist = '__liked__';
  queue = [...likedSongs];
  document.getElementById('pvTitle').textContent = 'Liked Songs';
  document.getElementById('pvName').textContent = 'Liked Songs';
  document.getElementById('pvCount').textContent = likedSongs.length + ' song' + (likedSongs.length !== 1 ? 's' : '');
  const hero = document.querySelector('.playlist-hero .art');
  if (hero) hero.innerHTML = '<div style="width:120px;height:120px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#fc3c44,#ff6b6b);border-radius:16px"><svg width="48" height="48" viewBox="0 0 24 24" fill="#fff" style="opacity:.9"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg></div>';
  document.getElementById('pvSongs').innerHTML = likedSongs.map(s => songItemHTML(s, 'playlist')).join('');
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('playlistView')?.classList.add('active');
}

function openArtist(name) {
  const aSongs = artistMap[name] || [];
  currentPlaylist = '__artist__'; queue = [...aSongs];
  document.getElementById('pvTitle').textContent = name;
  document.getElementById('pvName').textContent = name;
  document.getElementById('pvCount').textContent = aSongs.length + ' song' + (aSongs.length !== 1 ? 's' : '');
  const hero = document.querySelector('.playlist-hero .art');
  if (hero) hero.innerHTML = `<div class="card-art artist-icon" style="width:120px;height:120px;font-size:48px;border-radius:16px">${name.charAt(0).toUpperCase()}</div>`;
  document.getElementById('pvSongs').innerHTML = aSongs.map(s => songItemHTML(s, 'playlist')).join('');
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('playlistView')?.classList.add('active');
}

function openAlbum(name) {
  const aSongs = albumMap[name] || [];
  currentPlaylist = '__album__'; queue = [...aSongs];
  document.getElementById('pvTitle').textContent = name;
  document.getElementById('pvName').textContent = name;
  document.getElementById('pvCount').textContent = aSongs.length + ' song' + (aSongs.length !== 1 ? 's' : '');
  const hero = document.querySelector('.playlist-hero .art');
  const first = aSongs[0];
  if (hero) hero.innerHTML = `<img id="pvArt" src="${first ? coverUrl(first) : ''}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:16px">`;
  document.getElementById('pvSongs').innerHTML = aSongs.map(s => songItemHTML(s, 'playlist')).join('');
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('playlistView')?.classList.add('active');
}

function closePlaylistView() {
  document.getElementById('playlistView')?.classList.remove('active');
  const activeTab = document.querySelector('.tab-item.active');
  if (activeTab) document.getElementById(activeTab.dataset.page)?.classList.add('active');
  const hero = document.querySelector('.playlist-hero .art');
  if (hero) hero.innerHTML = '<img id="pvArt" src="" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:16px">';
}

function playAllPlaylist() {
  const items = document.querySelectorAll('#pvSongs .song-item');
  if (!items.length) return;
  queue = [];
  document.querySelectorAll('#pvSongs .song-item').forEach(el => {
    const s = songs.find(x => songKey(x) === el.dataset.key);
    if (s) queue.push(s);
  });
  if (shuffleMode) shuffleQueue();
  queueIndex = 0;
  playSong(queue[0]);
}

// ===== LIKED / HISTORY =====
async function loadLikedKeys() {
  const all = await dbGetAll('liked');
  likedKeys = new Set(all.map(l => l.key));
}

async function toggleLiked(key) {
  if (likedKeys.has(key)) {
    likedKeys.delete(key);
    await dbDelete('liked', key);
  } else {
    likedKeys.add(key);
    await dbPut('liked', {key, ts: Date.now()});
  }
  renderAll();
}

async function loadHistory() {
  const all = await dbGetAll('history');
  historyItems = all.sort((a,b) => (b.timestamp||0) - (a.timestamp||0)).slice(0, HISTORY_LIMIT);
}

async function addToHistory(song) {
  const key = 'hist_' + Date.now() + '_' + songKey(song);
  const entry = {key, data: song, timestamp: Date.now()};
  await dbPut('history', entry);
  historyItems.unshift(entry);
  if (historyItems.length > HISTORY_LIMIT) {
    const removed = historyItems.splice(HISTORY_LIMIT);
    for (const r of removed) await dbDelete('history', r.key);
  }
}