// ===== PLAYER =====
function togglePlay() {
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
  hapticImpact('LIGHT');
  updatePlayerUI(offlineKeys.has(songKey(currentSong)));
}

function playNext() {
  if (queue.length === 0) return;
  if (shuffleMode) { queueIndex = Math.floor(Math.random() * queue.length); }
  else { queueIndex = (queueIndex + 1) % queue.length; }
  playSong(queue[queueIndex]);
}

function playPrev() {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (queue.length === 0) return;
  queueIndex = (queueIndex - 1 + queue.length) % queue.length;
  playSong(queue[queueIndex]);
}

function toggleShuffle() {
  shuffleMode = !shuffleMode;
  if (shuffleMode) shuffleQueue();
  hapticImpact('LIGHT');
  updatePlayerUI(offlineKeys.has(songKey(currentSong)));
}

function shuffleQueue() {
  for (let i = queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [queue[i], queue[j]] = [queue[j], queue[i]];
  }
}

function toggleRepeat() {
  const modes = ['none','all','one'];
  repeatMode = modes[(modes.indexOf(repeatMode) + 1) % 3];
  hapticImpact('LIGHT');
  updatePlayerUI(offlineKeys.has(songKey(currentSong)));
}

function seekTo(pct) {
  if (audio.duration) audio.currentTime = audio.duration * pct;
}

function setVolume(v) {
  audio.volume = v;
  localStorage.setItem('volume', v);
}

function setPlaybackSpeed(speed) {
  playbackSpeed = speed;
  audio.playbackRate = speed;
  localStorage.setItem('playbackSpeed', speed);
  updatePlayerUI(offlineKeys.has(songKey(currentSong)));
}

async function playSong(song) {
  if (!song) return;
  currentSong = song;
  addToHistory(song);
  updatePlayerUI(false);
  showMiniPlayer();
  updateFpLikeBtn();
  updateNowPlayingInfo();

  const key = songKey(song);

  // 1. Try offline first if available
  if (offlineKeys.has(key)) {
    try {
      const stored = await dbGet('songs', key);
      if (stored?.blob) {
        audio.src = URL.createObjectURL(stored.blob);
        await audio.play();
        updatePlayerUI(true);
        updateNowPlayingInfo();
        return;
      }
    } catch(e) { console.warn('[player] Offline play failed:', e); }
  }

  // 2. Online streaming
  if (!offlineMode) {
    // YouTube stream: use server proxy (reliable, CORS-safe for iOS WKWebView)
    if (song.isStream && song.id) {
      return await playStreamSong(song);
    }

    // Library song: stream directly from server
    try {
      audio.src = audioUrl(song);
      await audio.play();
      updatePlayerUI(false);
      showMiniPlayer();
      updateFpLikeBtn();
      prebufferNext();
      updateNowPlayingInfo();
      return;
    } catch(e) {
      console.warn('[player] Library stream failed:', e.name, e.message);
      toast('Playback error');
      return;
    }
  }

  // 3. Offline mode and not available locally
  toast('Song not available offline');
}

// Stream a YouTube song via server proxy.
// Simple flow: audio.src = server proxy URL. The server resolves the CDN URL (yt-dlp),
// fetches audio, and pipes it back with proper headers. No CORS issues, no raw CDN URLs.
// The server caches CDN URLs so subsequent plays of the same song are instant.
async function playStreamSong(song) {
  const videoId = song.id;
  console.log('[player] Streaming', videoId, song.title);

  // Point audio element directly at the server proxy endpoint.
  // The server handles: yt-dlp resolve → CDN fetch → pipe audio back with proper Content-Type.
  // First play of a song takes ~5-15s (yt-dlp resolve). Cached songs start instantly.
  const proxyUrl = `${API}/api/youtube/stream/${videoId}${apiKey ? '?apiKey=' + encodeURIComponent(apiKey) : ''}`;
  audio.src = proxyUrl;

  try {
    await audio.play();
    updatePlayerUI(false);
    showMiniPlayer();
    updateFpLikeBtn();
    prebufferNext();
    updateNowPlayingInfo();
    console.log('[player] ✅ Playing', videoId);
  } catch(err) {
    // AbortError is normal if user switched songs before playback started
    if (err.name === 'AbortError') {
      console.log('[player] Playback aborted (user likely switched songs)');
      return;
    }
    console.error('[player] ❌ Stream failed for', videoId, err.name, err.message);
    toast('Could not play this song');
    audio.src = '';
  }
}

function playSongFromList(key, listId) {
  let list;
  if (listId === 'playlist') list = queue.length > 0 && currentPlaylist ? queue : songs.filter(s => s.playlist === currentPlaylist);
  else if (listId === 'recent') list = songs.slice(-10).reverse();
  else if (listId === 'history') list = historyItems.slice(0, 20).map(h => h.data).filter(Boolean);
  else if (listId === 'liked') list = songs.filter(s => likedKeys.has(songKey(s)));
  else list = [...songs];
  const idx = list.findIndex(s => songKey(s) === key);
  if (idx === -1) { const s = songs.find(s => songKey(s) === key); if (s) { queue = [s]; queueIndex = 0; playSong(s); } return; }
  queue = list; queueIndex = idx;
  playSong(queue[queueIndex]);
}

async function playOfflineSong(key) {
  try {
    const stored = await dbGet('songs', key);
    if (!stored?.blob) { toast('Not available offline'); return; }
    const allStored = await dbGetAll('songs');
    queue = allStored.map(d => d.data);
    queueIndex = queue.findIndex(s => songKey(s) === key);
    if (queueIndex === -1) queueIndex = 0;
    audio.src = URL.createObjectURL(stored.blob);
    currentSong = stored.data;
  audio.play().catch(() => {});
  updatePlayerUI(true);
  showMiniPlayer();
  updateFpLikeBtn();
  updateNowPlayingInfo();
  } catch(e) { toast('Playback failed'); }
}

function prebufferNext() {
  if (queue.length === 0) return;
  const nextIdx = (queueIndex + 1) % queue.length;
  if (nextIdx !== queueIndex && queue[nextIdx] && !offlineMode) {
    const nextSong = queue[nextIdx];
    // YouTube streams: warm the server's CDN cache so next playback starts instantly
    if (nextSong.isStream && nextSong.id) {
      const warmUrl = `${API}/api/youtube/stream/${nextSong.id}${apiKey ? '?apiKey=' + encodeURIComponent(apiKey) : ''}`;
      // Just fetch a small range to trigger yt-dlp resolve + CDN cache on server
      fetch(warmUrl, { headers: { Range: 'bytes=0-0' } }).catch(() => {});
      console.log(`[prebuffer] Warming cache for ${nextSong.id}`);
      return;
    }
    try { const a = new Audio(); a.src = audioUrl(nextSong); a.preload = 'auto'; prebufferedSong = nextSong; } catch(e) {}
  }
}

// Audio event listeners
audio.addEventListener('timeupdate', () => {
  if (!currentSong || !audio.duration) return;
  const pct = audio.currentTime / audio.duration * 100;
  const mp = document.getElementById('miniProgress');
  if (mp) mp.style.width = pct + '%';
  const fp = document.getElementById('fpProgressFill');
  if (fp) fp.style.width = pct + '%';
  const thumb = document.getElementById('fpProgressThumb');
  if (thumb) thumb.style.left = pct + '%';
  const ct = document.getElementById('fpTimeCurrent');
  if (ct) ct.textContent = formatTime(audio.currentTime);
  const tt = document.getElementById('fpTimeTotal');
  if (tt) tt.textContent = formatTime(audio.duration);
  updateNowPlayingInfo();
});

audio.addEventListener('ended', () => {
  if (repeatMode === 'one') { audio.currentTime = 0; audio.play(); return; }
  if (repeatMode === 'all' || queueIndex < queue.length - 1) playNext();
  else { currentSong = null; updatePlayerUI(false); }
});

audio.addEventListener('play', () => {
  const fpSvg = document.getElementById('fpPlayIcon');
  if (fpSvg) { const u = fpSvg.querySelector('use') || fpSvg; u.setAttribute('href', '#icon-pause'); }
  const mpSvg = document.getElementById('miniPlayIcon');
  if (mpSvg) { const u = mpSvg.querySelector('use') || mpSvg; u.setAttribute('href', '#icon-pause'); }
});

audio.addEventListener('pause', () => {
  const fpSvg = document.getElementById('fpPlayIcon');
  if (fpSvg) { const u = fpSvg.querySelector('use') || fpSvg; u.setAttribute('href', '#icon-play'); }
  const mpSvg = document.getElementById('miniPlayIcon');
  if (mpSvg) { const u = mpSvg.querySelector('use') || mpSvg; u.setAttribute('href', '#icon-play'); }
});

audio.addEventListener('error', () => {
  const code = audio.error?.code;
  const msg = audio.error?.message;
  const codeNames = { 1: 'ABORTED', 2: 'NETWORK', 3: 'DECODE', 4: 'SRC_NOT_SUPPORTED' };
  const errName = codeNames[code] || 'UNKNOWN';
  console.warn(`[player] Audio error: ${errName} (code=${code})`, msg || '');
  if (currentSong && offlineMode) toast('Stream unavailable offline');
  else if (currentSong) toast('Playback error: ' + errName);
});

function updatePlayerUI(isOffline) {
  if (!currentSong) return;
  const s = currentSong;
  // Full player
  const art = document.getElementById('fpArt');
  if (art) { art.src = coverUrl(s); art.onerror = () => art.style.display = 'none'; art.style.display = ''; }
  const title = document.getElementById('fpTitle');
  if (title) title.textContent = s.title;
  const artist = document.getElementById('fpArtist');
  if (artist) { artist.textContent = s.artist || 'Unknown Artist'; artist.dataset.artist = s.artist || ''; }
  // Shuffle
  const sb = document.getElementById('fpShuffleBtn');
  if (sb) sb.classList.toggle('active', shuffleMode);
  // Repeat - use SVG icons
  const rb = document.getElementById('fpRepeatBtn');
  if (rb) {
    rb.classList.toggle('active', repeatMode !== 'none');
    if (repeatMode === 'one') {
      rb.innerHTML = '<svg class="icon-ctrl"><use href="#icon-repeat-one"/></svg>';
    } else {
      rb.innerHTML = '<svg class="icon-ctrl"><use href="#icon-repeat"/></svg>';
    }
  }
  // Offline badge
  const ob = document.getElementById('fpOfflineBadge');
  if (ob) ob.style.display = isOffline ? 'block' : 'none';
  // Volume
  const vol = document.getElementById('fpVolumeSlider');
  if (vol) vol.value = audio.volume;
  // Speed
  const spd = document.getElementById('fpSpeedLabel');
  if (spd) spd.textContent = playbackSpeed + 'x';
  // Mini player
  const mt = document.getElementById('miniTitle');
  if (mt) mt.textContent = s.title;
  const ma = document.getElementById('miniArtist');
  if (ma) ma.textContent = s.artist || 'Unknown';
  const mart = document.getElementById('miniArt');
  if (mart) { mart.src = coverUrl(s); mart.onerror = () => mart.style.display = 'none'; }
}

function updateFpLikeBtn() {
  if (!currentSong) return;
  const btn = document.getElementById('fpLikeBtn');
  if (!btn) return;
  const liked = likedKeys.has(songKey(currentSong));
  btn.classList.toggle('liked', liked);
  btn.innerHTML = liked
    ? '<svg class="icon-extra"><use href="#icon-heart-filled"/></svg>'
    : '<svg class="icon-extra"><use href="#icon-heart"/></svg>';
}

function toggleLikeCurrent() {
  if (!currentSong) return;
  toggleLiked(songKey(currentSong));
  updateFpLikeBtn();
  hapticImpact('LIGHT');
}

function renderQueueSheet() {
  const el = document.getElementById('queueContent');
  if (!el) return;
  if (queue.length === 0) { el.innerHTML = '<div class="empty-state"><p>Queue is empty</p></div>'; return; }
  let html = '';
  if (currentSong) html += `<div class="queue-current"><div class="queue-label">Now Playing</div>${songItemHTML(currentSong, 'queue')}</div>`;
  const upNext = queue.slice(queueIndex + 1, queueIndex + 21);
  if (upNext.length) {
    html += '<div class="queue-label" style="padding:12px 0 4px;font-size:13px;font-weight:600;color:var(--text2)">Up Next</div>';
    upNext.forEach((s, i) => {
      html += `<div class="queue-row" style="display:flex;align-items:center;gap:8px">${songItemHTML(s, 'queue')}<button class="song-menu" onclick="queueRemove(${queueIndex+1+i})" aria-label="Remove"><svg class="icon-sm"><use href="#icon-x"/></svg></button></div>`;
    });
  }
  el.innerHTML = html;
}

function queueRemove(idx) {
  if (idx < 0 || idx >= queue.length) return;
  queue.splice(idx, 1);
  if (idx < queueIndex) queueIndex--;
  renderQueueSheet();
}

function playNextKey(key) {
  const s = songs.find(x => songKey(x) === key);
  if (!s) return;
  queue.splice(queueIndex + 1, 0, s);
  toast('Play next: ' + s.title);
  hideContextMenu();
}

function addToQueueEnd(key) {
  const s = songs.find(x => songKey(x) === key);
  if (!s) return;
  queue.push(s);
  toast('Added to queue: ' + s.title);
  hideContextMenu();
}

// ===== NOW PLAYING INFO (Lock Screen) =====
function updateNowPlayingInfo() {
  if (!currentSong) return;
  try {
    // Capacitor native plugin
    if (window.Capacitor?.Plugins?.NowPlaying) {
      window.Capacitor.Plugins.NowPlaying.updateNowPlaying({
        title: currentSong.title,
        artist: currentSong.artist || 'Unknown',
        album: currentSong.album || '',
        duration: audio.duration || 0,
        elapsed: audio.currentTime || 0,
        isPlaying: !audio.paused,
        artworkUrl: coverUrl(currentSong)
      }).catch(() => {});
    }
    // Web MediaSession API (works in WebView too)
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: currentSong.title,
        artist: currentSong.artist || 'Unknown',
        album: currentSong.album || '',
        artwork: [{ src: coverUrl(currentSong), sizes: '512x512', type: 'image/jpeg' }]
      });
      navigator.mediaSession.setActionHandler('play', () => audio.play());
      navigator.mediaSession.setActionHandler('pause', () => audio.pause());
      navigator.mediaSession.setActionHandler('previoustrack', playPrev);
      navigator.mediaSession.setActionHandler('nexttrack', playNext);
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime !== undefined) audio.currentTime = details.seekTime;
      });
      navigator.mediaSession.setActionHandler('seekbackward', (details) => {
        audio.currentTime = Math.max(0, audio.currentTime - (details.seekOffset || 15));
      });
      navigator.mediaSession.setActionHandler('seekforward', (details) => {
        audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (details.seekOffset || 15));
      });
    }
  } catch(e) {}
}

// ===== FULL PLAYER SHOW/HIDE =====
function showMiniPlayer() {
  const mp = document.getElementById('miniPlayer');
  if (mp) { mp.style.display = ''; mp.classList.remove('hidden'); }
}
function hideMiniPlayer() {
  const mp = document.getElementById('miniPlayer');
  if (mp) mp.classList.add('hidden');
}

function openFullPlayer() {
  document.getElementById('fullPlayer')?.classList.add('show');
  hideMiniPlayer();
  updatePlayerUI(offlineKeys.has(songKey(currentSong)));
  document.body.style.overflow = 'hidden';
}
function closeFullPlayer() {
  document.getElementById('fullPlayer')?.classList.remove('show');
  if (currentSong) showMiniPlayer();
  document.body.style.overflow = '';
}
function showFullPlayer() { openFullPlayer(); }
function hideFullPlayer() { closeFullPlayer(); }

// ===== VOLUME SLIDER TOGGLE =====
function toggleVolumeSlider() {
  const wrap = document.getElementById('volumeSliderWrap');
  if (wrap) wrap.style.display = wrap.style.display === 'none' ? 'flex' : 'none';
}

// ===== TOGGLE CURRENT LIKED =====
function toggleCurrentLiked() { toggleLikeCurrent(); }

// ===== SHUFFLE PLAY ALL (Playlist View) =====
function fpArtistTapped() {
  const el = document.getElementById('fpArtist');
  if (!el || !el.dataset.artist) return;
  const artistName = el.dataset.artist;
  closeFullPlayer();
  openArtist(artistName);
}

function shufflePlayAll() {
  if (queue.length === 0 && songs.length === 0) return;
  const list = queue.length > 0 ? [...queue] : [...songs];
  shuffleMode = true;
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  queue = list;
  queueIndex = 0;
  playSong(queue[0]);
  hapticImpact('MEDIUM');
}
