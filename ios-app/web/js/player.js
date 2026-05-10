// ===== PLAYER =====
let _streamLoading = false; // Guard against double-click during stream resolve
let _retryCount = 0;        // Automatic retry counter (max 1)
let _targetVideoId = null;  // Track which song we're trying to play (filters stale errors)
const MAX_RETRY = 1;

// Stream token state for diagnostics and recovery
const _streamState = {
  tokenIssuedAt: null,    // Date.now() when token was received
  tokenExpiresAt: null,   // expiresAt from play response
  streamUrl: null,        // current signed stream URL
  videoId: null,          // current video ID
  wasBackgrounded: false, // whether app was backgrounded during this session
  lastSafeTime: 0,        // last known safe currentTime (updated periodically)
};

// ===== REMOTE ERROR LOGGING =====
function _logPlaybackError(errorCode, errorMessage) {
  try {
    const payload = {
      videoId: _streamState.videoId || (currentSong && currentSong.id),
      errorCode,
      errorMessage,
      currentSrc: audio.currentSrc || '',
      networkState: audio.networkState,
      readyState: audio.readyState,
      tokenAge: _streamState.tokenIssuedAt ? Math.round((Date.now() - _streamState.tokenIssuedAt) / 1000) : null,
      tokenExpiresAt: _streamState.tokenExpiresAt,
      wasBackgrounded: _streamState.wasBackgrounded,
      playbackState: audio.paused ? 'paused' : 'playing',
      userAgent: navigator.userAgent,
    };

    // Fire-and-forget to server
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API}/api/events/playback-error`, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.timeout = 5000;
    xhr.send(JSON.stringify(payload));
  } catch (e) {
    // Silently ignore — we don't want logging to cause more errors
  }
}

function togglePlay() {
  // Don't try to play while a stream is still resolving
  if (_streamLoading) {
    console.log('[player] Ignoring play toggle — stream is loading');
    return;
  }
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

  // Immediately stop current playback when switching to a new song.
  // This prevents the old song from continuing to play while the new one resolves.
  const isSwitchingSongs = currentSong && currentSong !== song;
  if (isSwitchingSongs) {
    console.log('[player] Switching from', currentSong.title, '→', song.title);
    audio.pause();
  }

  currentSong = song;
  _targetVideoId = song.id || null; // Track target for error filtering
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

// Stream a YouTube song via the new architecture:
//   1. POST /api/play → server resolves with yt-dlp (cached or fresh), returns signed stream URL
//   2. Set audio.src to the signed stream URL and play
//   3. Server proxies upstream audio with full HTTP Range support
//
// Uses XMLHttpRequest instead of fetch() because CapacitorHttp intercepts fetch()
// and applies a short native timeout (~10s). XHR is NOT intercepted by CapacitorHttp
// and gives us explicit timeout control for potentially slow yt-dlp resolves.
async function playStreamSong(song) {
  const videoId = song.id;
  console.log('[player] Streaming', videoId, song.title);

  // Set loading guard — prevents double-click and togglePlay interference
  _streamLoading = true;

  // Show loading state in player UI
  updatePlayerUI(false);
  const fpSvg = document.getElementById('fpPlayIcon');
  if (fpSvg) { const u = fpSvg.querySelector('use') || fpSvg; u.setAttribute('href', '#icon-pause'); }
  const mpSvg = document.getElementById('miniPlayIcon');
  if (mpSvg) { const u = mpSvg.querySelector('use') || mpSvg; u.setAttribute('href', '#icon-pause'); }

  // Phase 1: Call POST /api/play to resolve and get a signed stream URL
  // Uses XHR to bypass CapacitorHttp's short timeout
  let playResponse = null;
  try {
    toast('Loading...');
    console.log('[player] Resolving via POST /play (XHR)', videoId);

    playResponse = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API}/api/play`, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.timeout = 60000; // 60s — yt-dlp can be slow for uncached songs

      xhr.onload = function() {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const data = JSON.parse(xhr.responseText);
            console.log('[player] Resolved ✅', videoId, data.title);
            resolve(data);
          } catch(e) {
            reject(new Error('Invalid response from server'));
          }
        } else {
          let errMsg = 'Resolve failed';
          try { errMsg = JSON.parse(xhr.responseText).error || errMsg; } catch(_) {}
          console.error('[player] Resolve HTTP error', videoId, xhr.status, errMsg);
          reject(new Error(errMsg));
        }
      };
      xhr.onerror = function() {
        console.error('[player] Resolve network error', videoId);
        reject(new Error('Network error'));
      };
      xhr.ontimeout = function() {
        console.error('[player] Resolve timed out (60s)', videoId);
        reject(new Error('Server timed out resolving song'));
      };

      const body = JSON.stringify({ videoId });
      xhr.send(body);
    });
  } catch(err) {
    console.error('[player] Resolve failed for', videoId, err.message);
    _streamLoading = false;
    toast('Could not load song: ' + err.message);
    audio.src = '';
    return;
  }

  if (!playResponse || !playResponse.streamUrl) {
    console.error('[player] No stream URL in response', videoId);
    _streamLoading = false;
    toast('Could not get stream URL');
    audio.src = '';
    return;
  }

  // Update song metadata from resolver response (may have better title/artist/duration)
  if (playResponse.title) song.title = playResponse.title;
  if (playResponse.artist) song.artist = playResponse.artist;
  if (playResponse.durationMs) song.duration = playResponse.durationMs / 1000;
  if (playResponse.artworkUrl) song.coverUrl = playResponse.artworkUrl;
  updatePlayerUI(false);

  // Track stream token state for diagnostics and recovery
  _streamState.tokenIssuedAt = Date.now();
  _streamState.tokenExpiresAt = playResponse.streamExpiresAt || null;
  _streamState.streamUrl = playResponse.streamUrl;
  _streamState.videoId = videoId;
  _streamState.wasBackgrounded = false;
  _streamState.lastSafeTime = 0;
  _retryCount = 0; // Reset retry counter for new song

  // Phase 2: Set audio.src to the signed stream URL and play
  _streamLoading = false;

  // Skip if user already switched to a different song while we were resolving
  if (_targetVideoId !== videoId) {
    console.log('[player] Stale resolve for', videoId, '— user switched to', _targetVideoId);
    return;
  }

  audio.src = playResponse.streamUrl;

  try {
    await audio.play();
    updatePlayerUI(false);
    showMiniPlayer();
    updateFpLikeBtn();
    prebufferNext();
    updateNowPlayingInfo();
    console.log('[player] ✅ Playing', videoId, playResponse.title);

    // Send listen event
    sendPlayEvent(videoId, 'start', 0, song);
  } catch(err) {
    if (err.name === 'AbortError') {
      console.log('[player] Playback aborted (user likely switched songs)');
      // Try one more play — iOS sometimes aborts when switching src mid-playback
      try { await audio.play(); } catch(_) {}
      return;
    }
    console.error('[player] ❌ Stream failed for', videoId, err.name, err.message);
    toast('Could not play this song');
    audio.src = '';
  }
}

// ===== AUTOMATIC PLAYBACK RECOVERY =====
// On MEDIA_ERR_NETWORK (2) or MEDIA_ERR_SRC_NOT_SUPPORTED (4), attempt one
// automatic retry: fetch a fresh token and resume from last known position.
async function _attemptPlaybackRecovery(errorCode) {
  if (_retryCount >= MAX_RETRY) {
    console.log('[player] Recovery: max retries reached, giving up');
    return false;
  }

  const videoId = _streamState.videoId || (currentSong && currentSong.id);
  if (!videoId) return false;

  _retryCount++;
  console.log(`[player] Recovery: attempt ${_retryCount}/${MAX_RETRY} for ${videoId} (error code ${errorCode})`);

  // Save last known position
  const resumeTime = _streamState.lastSafeTime || audio.currentTime || 0;
  audio.pause();

  try {
    // Fetch a fresh token
    const freshResponse = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API}/api/play`, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.timeout = 30000;
      xhr.onload = function() {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); } catch(e) { reject(e); }
        } else { reject(new Error('HTTP ' + xhr.status)); }
      };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.ontimeout = () => reject(new Error('Timeout'));
      xhr.send(JSON.stringify({ videoId }));
    });

    if (!freshResponse || !freshResponse.streamUrl) {
      console.error('[player] Recovery: no fresh stream URL');
      return false;
    }

    // Update stream state
    _streamState.tokenIssuedAt = Date.now();
    _streamState.tokenExpiresAt = freshResponse.streamExpiresAt || null;
    _streamState.streamUrl = freshResponse.streamUrl;

    // Swap source and attempt play
    audio.src = freshResponse.streamUrl;

    // Seek back to last safe position after metadata loads
    const seekOnReady = () => {
      if (resumeTime > 0 && audio.duration) {
        audio.currentTime = Math.min(resumeTime, audio.duration - 0.5);
      }
      audio.removeEventListener('loadedmetadata', seekOnReady);
    };
    audio.addEventListener('loadedmetadata', seekOnReady);

    await audio.play();
    console.log('[player] Recovery: ✅ playback resumed for', videoId, 'at', resumeTime + 's');
    return true;
  } catch (recoveryErr) {
    console.error('[player] Recovery: failed —', recoveryErr.message);
    return false;
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

// Pre-resolve the next queue item so playback starts faster when the user skips
function prebufferNext() {
  if (queue.length === 0) return;
  const nextIdx = (queueIndex + 1) % queue.length;
  if (nextIdx !== queueIndex && queue[nextIdx] && !offlineMode) {
    const nextSong = queue[nextIdx];
    // YouTube streams: pre-resolve via POST /play so the resolver cache is warm
    if (nextSong.isStream && nextSong.id) {
      console.log(`[prebuffer] Pre-resolving ${nextSong.id} via POST /play`);
      fetch(`${API}/api/play`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId: nextSong.id }),
      }).catch(() => {});
      return;
    }
    try { const a = new Audio(); a.src = audioUrl(nextSong); a.preload = 'auto'; prebufferedSong = nextSong; } catch(e) {}
  }
}

// Send a listen event to the server for analytics/recommendations
function sendPlayEvent(videoId, eventType, positionMs, song) {
  try {
    fetch(`${API}/api/events/listen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId,
        eventType,         // start, progress, skip, complete, replay, like
        positionMs: Math.round(positionMs || 0),
        playedMs: Math.round((audio.currentTime || 0) * 1000),
        title: song?.title || '',
        artist: song?.artist || '',
      }),
    }).catch(() => {}); // fire-and-forget
  } catch(e) {}
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

audio.addEventListener('error', async () => {
  const code = audio.error?.code;
  const msg = audio.error?.message;
  const codeNames = { 1: 'ABORTED', 2: 'NETWORK', 3: 'DECODE', 4: 'SRC_NOT_SUPPORTED' };
  const errName = codeNames[code] || 'UNKNOWN';
  console.warn(`[player] Audio error: ${errName} (code=${code})`, msg || '');

  // Ignore ABORTED errors — these are expected when switching songs (src changes mid-playback)
  if (code === 1) {
    console.log('[player] Ignoring ABORTED error — likely from song switch');
    return;
  }

  // Ignore errors for stale songs (user already switched to a different song)
  const errorVideoId = _streamState.videoId || (currentSong && currentSong.id);
  if (errorVideoId && _targetVideoId && errorVideoId !== _targetVideoId) {
    console.log('[player] Ignoring error for stale song', errorVideoId, '— current target is', _targetVideoId);
    return;
  }

  // Log to server for diagnostics
  _logPlaybackError(code, msg);

  // Auto-recovery for NETWORK and SRC_NOT_SUPPORTED errors
  if (code === 2 || code === 4) {
    const recovered = await _attemptPlaybackRecovery(code);
    if (recovered) {
      console.log('[player] ✅ Auto-recovery succeeded');
      return;
    }
  }

  if (currentSong && offlineMode) toast('Stream unavailable offline');
  else if (currentSong) toast('Playback error: ' + errName);
});

// ===== COMPREHENSIVE EVENT INSTRUMENTATION =====
// Track all media events for diagnostics
const _mediaEvents = ['loadstart', 'loadedmetadata', 'canplay', 'canplaythrough',
  'waiting', 'stalled', 'suspend', 'seeking', 'seeked', 'emptied', 'abort'];
_mediaEvents.forEach(eventName => {
  audio.addEventListener(eventName, () => {
    console.log(`[audio] ${eventName} (readyState=${audio.readyState}, networkState=${audio.networkState})`);
  });
});

// Track last safe playback position for recovery (every 5 seconds)
setInterval(() => {
  if (audio && !audio.paused && audio.currentTime > 0) {
    _streamState.lastSafeTime = audio.currentTime;
  }
}, 5000);

// ===== NATIVE EVENT RECEIVER =====
// Receives events from AppDelegate (audio interruptions) via evaluateJavaScript
window._nativeEventReceiver = function(event) {
  console.log('[player] Native event:', event);

  switch (event) {
    case 'audioInterruptionBegan':
      // Audio was interrupted (phone call, alarm, etc.) — pause to avoid broken state
      _streamState.wasBackgrounded = true;
      if (!audio.paused) {
        console.log('[player] Pausing due to audio interruption');
        audio.pause();
      }
      break;

    case 'audioInterruptionEndedShouldResume':
      // Interruption ended and iOS says we should resume
      console.log('[player] Interruption ended — resuming playback');
      if (audio.paused && currentSong) {
        audio.play().catch(e => console.warn('[player] Resume after interruption failed:', e.message));
      }
      _streamState.wasBackgrounded = false;
      break;

    case 'audioInterruptionEnded':
      // Interruption ended but we shouldn't auto-resume (user should tap play)
      console.log('[player] Interruption ended — not auto-resuming');
      _streamState.wasBackgrounded = false;
      break;
  }
};

// ===== APP LIFECYCLE HANDLING =====
// Detect background/foreground transitions in the WebView
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // App going to background
    _streamState.wasBackgrounded = true;
    console.log('[player] App backgrounded — current time:', audio.currentTime,
      'token age:', _streamState.tokenIssuedAt ? Math.round((Date.now() - _streamState.tokenIssuedAt) / 1000) + 's' : 'n/a');
  } else {
    // App returning to foreground — check token health
    console.log('[player] App foregrounded — checking token health');
    _checkTokenHealthOnForeground();
  }
});

// Also listen for Capacitor-specific lifecycle events if available
if (window.Capacitor) {
  window.Capacitor.addListener?.('appStateChange', (state) => {
    if (!state.isActive) {
      _streamState.wasBackgrounded = true;
    } else {
      _checkTokenHealthOnForeground();
    }
  });
}

/**
 * On foreground resume, check if the current stream token is still valid.
 * If nearly expired or expired, proactively refresh it before the user hits play again.
 */
async function _checkTokenHealthOnForeground() {
  const { tokenIssuedAt, tokenExpiresAt, videoId } = _streamState;

  // No active stream — nothing to check
  if (!tokenIssuedAt || !videoId) return;

  const now = Date.now();
  const tokenAge = Math.round((now - tokenIssuedAt) / 1000);
  const expiresAt = tokenExpiresAt ? new Date(tokenExpiresAt).getTime() : 0;
  const remainingMs = expiresAt - now;

  console.log(`[player] Token health: age=${tokenAge}s, remaining=${Math.round(remainingMs / 1000)}s, videoId=${videoId}`);

  // If token has more than 2 minutes left, it's fine
  if (remainingMs > 120000) {
    console.log('[player] Token still healthy — no action needed');
    return;
  }

  // Token is expired or nearly expired — proactively refresh
  console.log('[player] Token expired or nearly expired — proactively refreshing...');

  // If playback is active, we need to swap the source
  const wasPlaying = !audio.paused;
  const resumeTime = audio.currentTime || _streamState.lastSafeTime || 0;

  try {
    const freshResponse = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API}/api/play`, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.timeout = 30000;
      xhr.onload = function() {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); } catch(e) { reject(e); }
        } else { reject(new Error('HTTP ' + xhr.status)); }
      };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.ontimeout = () => reject(new Error('Timeout'));
      xhr.send(JSON.stringify({ videoId }));
    });

    if (freshResponse && freshResponse.streamUrl) {
      console.log('[player] Proactive token refresh succeeded for', videoId);
      _streamState.tokenIssuedAt = Date.now();
      _streamState.tokenExpiresAt = freshResponse.streamExpiresAt || null;
      _streamState.streamUrl = freshResponse.streamUrl;

      // Swap source silently
      audio.src = freshResponse.streamUrl;

      // Restore position
      if (resumeTime > 0) {
        const seekOnReady = () => {
          if (audio.duration && resumeTime < audio.duration) {
            audio.currentTime = resumeTime;
          }
          audio.removeEventListener('loadedmetadata', seekOnReady);
        };
        audio.addEventListener('loadedmetadata', seekOnReady);
      }

      // Resume playback if it was active before
      if (wasPlaying) {
        audio.play().catch(e => console.warn('[player] Resume after token refresh failed:', e.message));
      }
    }
  } catch (err) {
    console.warn('[player] Proactive token refresh failed:', err.message);
    // Don't show error to user — they haven't pressed anything yet
  }
}

function updatePlayerUI(isOffline) {
  if (!currentSong) return;
  const s = currentSong;
  // Full player
  const art = document.getElementById('fpArt');
  if (art) { art.src = coverUrl(s); art.onerror = () => onImageError(art); art.style.display = ''; }
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
  if (mart) { mart.src = coverUrl(s); mart.onerror = () => onImageError(mart); }
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
