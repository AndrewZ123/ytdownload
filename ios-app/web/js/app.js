// ===== APP INITIALIZATION =====
document.addEventListener('DOMContentLoaded', async () => {
  // Init UI FIRST so tabs always work even if loading fails
  // Tab navigation
  document.querySelectorAll('.tab-item').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab-item').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      const page = document.getElementById(tab.dataset.page);
      if (page) page.classList.add('active');
      hapticImpact('LIGHT');
    });
  });

  // Library segment control
  document.querySelectorAll('.seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const track = btn.closest('.seg-track');
      track.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const target = btn.dataset.tab;
      const container = btn.closest('.lib-segments').parentElement;
      container.querySelectorAll('.sub-panel').forEach(p => p.classList.remove('active'));
      container.querySelector(`#${target}`)?.classList.add('active');
      hapticImpact('LIGHT');
    });
  });

  // Theme buttons
  document.getElementById('themeDark')?.addEventListener('click', () => setTheme('dark'));
  document.getElementById('themeLight')?.addEventListener('click', () => setTheme('light'));

  // Volume slider
  document.getElementById('fpVolumeSlider')?.addEventListener('input', e => setVolume(parseFloat(e.target.value)));

  // Sort/filter
  document.getElementById('sortSelect')?.addEventListener('change', e => { songSortBy = e.target.value; renderLibSongs(); });
  document.getElementById('filterSelect')?.addEventListener('change', e => { songFilterBy = e.target.value || null; renderLibSongs(); });

  // Pull to refresh
  initPullToRefresh();

  // Online/offline events
  window.addEventListener('online', async () => {
    offlineMode = false;
    document.getElementById('offlineBanner').style.display = 'none';
    await fetchApiKey();
    loadLibrary().then(cacheLibrary);
    toast('Back online');
  });
  window.addEventListener('offline', () => {
    offlineMode = true;
    document.getElementById('offlineBanner').style.display = 'flex';
    toast('You are offline');
  });

  // ===== APP LIFECYCLE: Background/Foreground handling =====
  // Track background state for playback diagnostics and recovery
  function _onAppBackground() {
    console.log('[lifecycle] App backgrounded');
    if (typeof _streamState !== 'undefined') {
      _streamState.wasBackgrounded = true;
      _streamState.lastSafeTime = audio.currentTime || _streamState.lastSafeTime || 0;
    }
    // Persist playback context for recovery
    try {
      localStorage.setItem('_playbackCtx', JSON.stringify({
        videoId: _streamState?.videoId || (currentSong && currentSong.id),
        currentTime: audio.currentTime || 0,
        wasPlaying: !audio.paused,
        tokenIssuedAt: _streamState?.tokenIssuedAt,
        tokenExpiresAt: _streamState?.tokenExpiresAt,
        backgroundedAt: Date.now(),
      }));
    } catch(e) {}
  }

  function _onAppForeground() {
    console.log('[lifecycle] App foregrounded');
    // Check if we need to refresh an expired/nearly-expired token
    try {
      const ctx = JSON.parse(localStorage.getItem('_playbackCtx') || 'null');
      if (!ctx || !ctx.videoId) return;

      const now = Date.now();
      const backgroundedDuration = ctx.backgroundedAt ? (now - ctx.backgroundedAt) / 1000 : 0;
      const tokenAge = ctx.tokenIssuedAt ? (now - ctx.tokenIssuedAt) / 1000 : Infinity;
      const tokenExpiresIn = ctx.tokenExpiresAt ? (ctx.tokenExpiresAt - now) / 1000 : 0;

      console.log(`[lifecycle] Background for ${backgroundedDuration.toFixed(0)}s, token age ${tokenAge.toFixed(0)}s, expires in ${tokenExpiresIn.toFixed(0)}s`);

      // If token is expired or expiring within 2 minutes, and audio was playing, silently refresh
      if (tokenExpiresIn < 120 && ctx.wasPlaying && audio.paused && currentSong) {
        console.log('[lifecycle] Token nearly expired, refreshing before user interaction');
        _retryCount = 0; // Allow one retry
        _attemptPlaybackRecovery(4).then(recovered => {
          if (recovered) {
            console.log('[lifecycle] ✅ Silent token refresh succeeded');
          } else {
            console.log('[lifecycle] Silent token refresh failed — will retry on next user action');
          }
        });
      }

      localStorage.removeItem('_playbackCtx');
    } catch(e) {
      console.error('[lifecycle] Foreground recovery error:', e);
    }
  }

  // Standard Page Visibility API (works in WebView)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) _onAppBackground();
    else _onAppForeground();
  });

  // Capacitor lifecycle events (more reliable on iOS)
  if (window.Capacitor) {
    Capacitor.Plugins.App?.addListener('appStateChange', (state) => {
      if (!state.isActive) _onAppBackground();
      else _onAppForeground();
    });
  }

  // Context menu actions
  document.getElementById('ctxLikeBtn')?.addEventListener('click', () => {
    const key = state_contextKey;
    toggleLiked(key);
    hapticImpact('LIGHT');
    hideContextMenu();
  });
  document.getElementById('ctxDlBtn')?.addEventListener('click', () => {
    const key = state_contextKey;
    if (offlineKeys.has(key)) removeOffline(key);
    else downloadSongOffline(key);
    hideContextMenu();
  });
  document.getElementById('ctxPlayNextBtn')?.addEventListener('click', () => playNextKey(state_contextKey));
  document.getElementById('ctxQueueBtn')?.addEventListener('click', () => addToQueueEnd(state_contextKey));
  document.getElementById('ctxArtistBtn')?.addEventListener('click', () => {
    const s = songs.find(x => songKey(x) === state_contextKey);
    if (s?.artist) { hideContextMenu(); openArtist(s.artist); }
  });
  document.getElementById('ctxAlbumBtn')?.addEventListener('click', () => {
    const s = songs.find(x => songKey(x) === state_contextKey);
    if (s?.album) { hideContextMenu(); openAlbum(s.album); }
  });
  document.getElementById('ctxShareBtn')?.addEventListener('click', () => {
    const s = songs.find(x => songKey(x) === state_contextKey);
    if (s) shareSong(s);
    hideContextMenu();
  });

  // Speed selector
  document.getElementById('fpSpeedBtn')?.addEventListener('click', () => {
    const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2];
    const idx = speeds.indexOf(playbackSpeed);
    setPlaybackSpeed(speeds[(idx + 1) % speeds.length]);
  });

  // Sleep timer button
  document.getElementById('fpSleepBtn')?.addEventListener('click', () => {
    showSheet('sleepTimer');
  });

  // Progress bar seek (click)
  document.getElementById('fpProgressBar')?.addEventListener('click', e => {
    const rect = e.currentTarget.getBoundingClientRect();
    seekTo((e.clientX - rect.left) / rect.width);
  });
  // Progress bar drag
  initSeekBarDrag('fpProgressBar');

  // Download sheet
  document.getElementById('downloadSheetBtn')?.addEventListener('click', showDownloadSheet);

  // Render initial search history
  const srEl = document.getElementById('searchPageResults');
  if (srEl) renderSearchHistory(srEl);

  // Queue button
  document.getElementById('fpQueueBtn')?.addEventListener('click', showQueueSheet);

  // Search input focus
  document.getElementById('searchPageInput')?.addEventListener('focus', () => {
    const el = document.getElementById('searchPageResults');
    const input = document.getElementById('searchPageInput');
    if (el && input && !input.value.trim()) renderSearchHistory(el);
  });

  // Init keyboard shortcuts
  initKeyboard();

  // Load data — non-blocking, resilient to server being unreachable
  (async () => {
    try { await initDB(); } catch(e) { console.error('initDB failed:', e); }
    // Load offline/local data FIRST (always available regardless of server)
    try { await Promise.all([loadOfflineKeys(), loadLikedKeys(), loadHistory()]); } catch(e) { console.error('loadKeys failed:', e); }

    // Use cached API key immediately so existing requests work
    const hadCachedKey = !!apiKey;
    console.log(`[init] Cached API key: ${hadCachedKey ? 'yes' : 'no'}`);

    // Show cached library immediately if available (instant UI)
    if (hadCachedKey) {
      loadCachedLibrary();
    }

    // Try to fetch fresh API key in background (non-blocking)
    // Even if this fails, the cached key might still work
    const keyFetched = await fetchApiKey();
    if (!keyFetched && !hadCachedKey) {
      console.warn('[init] No API key available — server may be unreachable');
    }

    // Load fresh library from server
    try {
      await loadLibrary();
      // Cache successful library load for next time
      cacheLibrary();
    } catch(e) {
      console.error('loadLibrary failed:', e);
      // If we didn't already show cached data, try now
      if (!hadCachedKey) loadCachedLibrary();
    }
  })();
});

// ===== PULL TO REFRESH =====
function initPullToRefresh() {
  let startY = 0, pulling = false;
  const ptr = document.getElementById('pullToRefresh');
  if (!ptr) return;

  document.querySelectorAll('.scroll-content').forEach(sc => {
    sc.addEventListener('touchstart', e => {
      if (sc.scrollTop <= 0) { startY = e.touches[0].clientY; pulling = true; }
    });
    sc.addEventListener('touchmove', e => {
      if (!pulling) return;
      const dy = e.touches[0].clientY - startY;
      if (dy > 60) { ptr.classList.add('show'); ptr.querySelector('.ptr-text').textContent = 'Release to refresh'; }
    });
    sc.addEventListener('touchend', () => {
      if (ptr.classList.contains('show')) {
        ptr.classList.remove('show');
        ptr.querySelector('.ptr-text').textContent = 'Pull to refresh';
        refreshLibrary();
        hapticImpact('MEDIUM');
      }
      pulling = false;
    });
  });
}

// ===== SEEK BAR DRAG =====
function initSeekBarDrag(id) {
  const bar = document.getElementById(id);
  if (!bar) return;
  let dragging = false;

  const getPct = (clientX) => {
    const rect = bar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };

  const updateVisual = (pct) => {
    const fill = bar.querySelector('.progress-fill');
    const thumb = bar.querySelector('.progress-thumb');
    const preview = bar.querySelector('.seek-preview');
    if (fill) fill.style.width = (pct * 100) + '%';
    if (thumb) { thumb.style.left = (pct * 100) + '%'; thumb.style.opacity = '1'; }
    if (preview && audio.duration) {
      preview.textContent = formatTime(audio.duration * pct);
      preview.style.display = 'block';
      preview.style.left = (pct * 100) + '%';
    }
  };

  const onStart = (clientX) => {
    dragging = true;
    bar.classList.add('dragging');
    const pct = getPct(clientX);
    updateVisual(pct);
    seekTo(pct);
  };

  const onMove = (clientX) => {
    if (!dragging) return;
    const pct = getPct(clientX);
    updateVisual(pct);
    seekTo(pct);
  };

  const onEnd = () => {
    if (!dragging) return;
    dragging = false;
    bar.classList.remove('dragging');
    const thumb = bar.querySelector('.progress-thumb');
    if (thumb) thumb.style.opacity = '';
    const preview = bar.querySelector('.seek-preview');
    if (preview) preview.style.display = 'none';
  };

  bar.addEventListener('mousedown', e => { e.preventDefault(); onStart(e.clientX); });
  bar.addEventListener('touchstart', e => { onStart(e.touches[0].clientX); }, {passive: true});
  document.addEventListener('mousemove', e => onMove(e.clientX));
  document.addEventListener('touchmove', e => { if (dragging) onMove(e.touches[0].clientX); }, {passive: true});
  document.addEventListener('mouseup', onEnd);
  document.addEventListener('touchend', onEnd);
}

