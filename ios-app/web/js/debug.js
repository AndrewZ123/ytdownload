/**
 * Debug Diagnostics Panel
 *
 * Hidden diagnostics page showing real-time audio state, token info,
 * media events, and playback health for troubleshooting iOS issues.
 *
 * Access: Tap the "Server" text in Settings 5 times, or call showDebugPanel()
 */

(function() {
  'use strict';

  // Event log buffer (last 50 events)
  const eventLog = [];
  const MAX_EVENTS = 50;

  // Track if debug panel is visible
  let debugVisible = false;

  // ==================== Event Capture ====================

  // Capture audio events for diagnostics
  const AUDIO_EVENTS = [
    'loadstart', 'loadedmetadata', 'canplay', 'canplaythrough',
    'play', 'playing', 'pause', 'waiting', 'stalled', 'suspend',
    'seeking', 'seeked', 'ended', 'error', 'abort', 'emptied',
    'ratechange', 'volumechange', 'durationchange', 'progress',
    'timeupdate',
  ];

  function initDebugCapture() {
    // Wait for audio element to exist
    const check = setInterval(() => {
      const audio = window._audio;
      if (!audio) return;
      clearInterval(check);

      AUDIO_EVENTS.forEach(evtName => {
        audio.addEventListener(evtName, (e) => {
          const entry = {
            time: new Date().toISOString().slice(11, 23),
            event: evtName,
            readyState: audio.readyState,
            networkState: audio.networkState,
            currentTime: audio.currentTime ? audio.currentTime.toFixed(2) : 0,
            duration: audio.duration ? audio.duration.toFixed(1) : '∞',
            buffered: _getBufferedInfo(audio),
            error: audio.error ? { code: audio.error.code, message: audio.error.message } : null,
            src: audio.currentSrc ? audio.currentSrc.split('/').pop().slice(0, 16) : '',
          };

          eventLog.push(entry);
          if (eventLog.length > MAX_EVENTS) eventLog.shift();

          // Log errors prominently
          if (evtName === 'error') {
            console.error('[debug] Audio error:', JSON.stringify(entry));
          }
        });
      });
    }, 500);
  }

  function _getBufferedInfo(audio) {
    if (!audio.buffered || audio.buffered.length === 0) return '0%';
    const end = audio.buffered.end(audio.buffered.length - 1);
    const dur = audio.duration || 1;
    return Math.round((end / dur) * 100) + '%';
  }

  // ==================== Panel Rendering ====================

  function getAudioState() {
    const audio = window._audio;
    if (!audio) return { exists: false };

    const src = audio.currentSrc || '';
    const tokenMatch = src.match(/\/api\/stream\/([a-f0-9]+)/);

    return {
      exists: true,
      currentSrc: src ? src.split('/').slice(-2).join('/') : 'none',
      tokenPrefix: tokenMatch ? tokenMatch[1].slice(0, 12) : '',
      networkState: ['EMPTY', 'IDLE', 'LOADING', 'NO_SOURCE'][audio.networkState] || audio.networkState,
      readyState: ['HAVE_NOTHING', 'HAVE_METADATA', 'HAVE_CURRENT_DATA', 'HAVE_FUTURE_DATA', 'HAVE_ENOUGH_DATA'][audio.readyState] || audio.readyState,
      currentTime: audio.currentTime ? audio.currentTime.toFixed(2) : 0,
      duration: audio.duration ? audio.duration.toFixed(1) : 'unknown',
      paused: audio.paused,
      ended: audio.ended,
      playbackRate: audio.playbackRate,
      volume: audio.volume,
      muted: audio.muted,
      error: audio.error ? {
        code: audio.error.code,
        message: audio.error.message,
        codeName: ['MEDIA_ERR_CUSTOM', 'MEDIA_ERR_ABORTED', 'MEDIA_ERR_NETWORK', 'MEDIA_ERR_DECODE', 'MEDIA_ERR_SRC_NOT_SUPPORTED'][audio.error.code] || 'UNKNOWN',
      } : null,
      buffered: _getBufferedInfo(audio),
    };
  }

  function getPlaybackContext() {
    const ctx = window._playbackContext || {};
    return {
      videoId: ctx.videoId || 'none',
      title: ctx.title || '',
      artist: ctx.artist || '',
      tokenCreatedAt: ctx.tokenCreatedAt || null,
      tokenExpiresAt: ctx.tokenExpiresAt || null,
      tokenAge: ctx.tokenCreatedAt ? Math.round((Date.now() - ctx.tokenCreatedAt) / 1000) + 's' : 'n/a',
      tokenRemaining: ctx.tokenExpiresAt ? Math.round((ctx.tokenExpiresAt - Date.now()) / 1000) + 's' : 'n/a',
      tokenExpired: ctx.tokenExpiresAt ? Date.now() > ctx.tokenExpiresAt : 'n/a',
      wasBackgrounded: ctx.wasBackgrounded || false,
      lastPlayTime: ctx.lastPlayTime || null,
      retryCount: ctx.retryCount || 0,
    };
  }

  function getAppInfo() {
    return {
      userAgent: navigator.userAgent.slice(0, 80),
      onLine: navigator.onLine,
      standalone: window.navigator.standalone || false,
      displayMode: window.matchMedia('(display-mode: standalone)').matches ? 'standalone' : 'browser',
      screen: `${screen.width}x${screen.height}`,
      dpr: window.devicePixelRatio,
      memory: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) + 'MB' : 'n/a',
      visibilityState: document.visibilityState,
    };
  }

  function renderDebugPanel() {
    const container = document.getElementById('debugContent');
    if (!container) return;

    const audioState = getAudioState();
    const playbackCtx = getPlaybackContext();
    const appInfo = getAppInfo();

    let html = '';

    // App & Environment
    html += '<div class="dbg-section">';
    html += '<div class="dbg-title">Environment</div>';
    html += `<div class="dbg-row"><span>Display Mode</span><span>${appInfo.displayMode}</span></div>`;
    html += `<div class="dbg-row"><span>Online</span><span style="color:${appInfo.onLine ? '#4cd964' : '#ff3b30'}">${appInfo.onLine}</span></div>`;
    html += `<div class="dbg-row"><span>Visibility</span><span>${appInfo.visibilityState}</span></div>`;
    html += `<div class="dbg-row"><span>Screen</span><span>${appInfo.screen} @${appInfo.dpr}x</span></div>`;
    html += `<div class="dbg-row"><span>UA</span><span style="font-size:10px;word-break:break-all">${appInfo.userAgent}</span></div>`;
    html += '</div>';

    // Audio State
    html += '<div class="dbg-section">';
    html += '<div class="dbg-title">Audio Element</div>';
    if (!audioState.exists) {
      html += '<div class="dbg-row"><span style="color:#ff3b30">No audio element found</span></div>';
    } else {
      html += `<div class="dbg-row"><span>readyState</span><span>${audioState.readyState}</span></div>`;
      html += `<div class="dbg-row"><span>networkState</span><span>${audioState.networkState}</span></div>`;
      html += `<div class="dbg-row"><span>paused</span><span>${audioState.paused}</span></div>`;
      html += `<div class="dbg-row"><span>currentTime</span><span>${audioState.currentTime}s</span></div>`;
      html += `<div class="dbg-row"><span>duration</span><span>${audioState.duration}s</span></div>`;
      html += `<div class="dbg-row"><span>buffered</span><span>${audioState.buffered}</span></div>`;
      html += `<div class="dbg-row"><span>src</span><span style="font-size:10px">${audioState.currentSrc}</span></div>`;
      if (audioState.error) {
        html += `<div class="dbg-row"><span style="color:#ff3b30">ERROR</span><span style="color:#ff3b30">${audioState.error.codeName} (${audioState.error.code})</span></div>`;
        html += `<div class="dbg-row"><span></span><span style="font-size:10px;color:#ff3b30">${audioState.error.message || 'no message'}</span></div>`;
      }
    }
    html += '</div>';

    // Token & Playback Context
    html += '<div class="dbg-section">';
    html += '<div class="dbg-title">Playback Context</div>';
    html += `<div class="dbg-row"><span>videoId</span><span>${playbackCtx.videoId}</span></div>`;
    html += `<div class="dbg-row"><span>title</span><span>${playbackCtx.title}</span></div>`;
    html += `<div class="dbg-row"><span>tokenAge</span><span>${playbackCtx.tokenAge}</span></div>`;
    html += `<div class="dbg-row"><span>tokenRemaining</span><span style="color:${playbackCtx.tokenRemaining === 'n/a' || parseInt(playbackCtx.tokenRemaining) < 300 ? '#ff9500' : '#4cd964'}">${playbackCtx.tokenRemaining}</span></div>`;
    html += `<div class="dbg-row"><span>tokenExpired</span><span style="color:${playbackCtx.tokenExpired === true ? '#ff3b30' : '#4cd964'}">${playbackCtx.tokenExpired}</span></div>`;
    html += `<div class="dbg-row"><span>wasBackgrounded</span><span>${playbackCtx.wasBackgrounded}</span></div>`;
    html += `<div class="dbg-row"><span>retryCount</span><span>${playbackCtx.retryCount}</span></div>`;
    html += '</div>';

    // Recent Events
    html += '<div class="dbg-section">';
    html += '<div class="dbg-title">Recent Events (' + eventLog.length + ')</div>';
    html += '<div class="dbg-events">';
    const recentEvents = eventLog.slice(-20).reverse();
    if (recentEvents.length === 0) {
      html += '<div style="color:var(--text3);font-size:11px;padding:4px 0">No events captured yet</div>';
    } else {
      recentEvents.forEach(e => {
        const isError = e.event === 'error';
        const color = isError ? '#ff3b30' : (e.event === 'playing' || e.event === 'canplay' ? '#4cd964' : 'var(--text2)');
        html += `<div class="dbg-event" style="color:${color}">`;
        html += `<span class="dbg-time">${e.time}</span> `;
        html += `<span class="dbg-evt">${e.event}</span> `;
        html += `<span class="dbg-detail">rs=${e.readyState} ns=${e.networkState} t=${e.currentTime}${e.error ? ' ERR=' + e.error.code : ''}</span>`;
        html += '</div>';
      });
    }
    html += '</div></div>';

    // Actions
    html += '<div class="dbg-section">';
    html += '<div class="dbg-title">Actions</div>';
    html += '<div class="dbg-actions">';
    html += '<button class="dbg-btn" onclick="window._debugProbeStream()">Probe Stream</button>';
    html += '<button class="dbg-btn" onclick="window._debugRefreshToken()">Refresh Token</button>';
    html += '<button class="dbg-btn" onclick="window._debugCopyState()">Copy State</button>';
    html += '<button class="dbg-btn dbg-btn-danger" onclick="window._debugClearEvents()">Clear Events</button>';
    html += '</div></div>';

    container.innerHTML = html;
  }

  // ==================== Debug Actions ====================

  window._debugProbeStream = async function() {
    const audio = window._audio;
    const ctx = window._playbackContext || {};
    if (!ctx.videoId) {
      _debugToast('No track playing');
      return;
    }

    try {
      _debugToast('Probing stream...');
      const resp = await fetch(`${window.getApiBase ? window.getApiBase() : ''}/api/youtube/stream-url/${ctx.videoId}`);
      const data = await resp.json();
      console.log('[debug] Stream probe result:', JSON.stringify(data, null, 2));
      _debugToast(`Stream OK: ${data.streamUrl ? 'URL available' : 'No URL'} (expires ${data.streamExpiresAt || 'n/a'})`);
    } catch (err) {
      console.error('[debug] Stream probe failed:', err);
      _debugToast('Probe failed: ' + err.message);
    }
  };

  window._debugRefreshToken = async function() {
    const ctx = window._playbackContext || {};
    if (!ctx.videoId) {
      _debugToast('No track playing');
      return;
    }

    try {
      _debugToast('Refreshing token...');
      const resp = await fetch(`${window.getApiBase ? window.getApiBase() : ''}/api/play`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId: ctx.videoId }),
      });
      const data = await resp.json();
      if (data.streamUrl) {
        // Update context
        if (window._playbackContext) {
          window._playbackContext.tokenCreatedAt = Date.now();
          window._playbackContext.tokenExpiresAt = data.streamExpiresAt ? new Date(data.streamExpiresAt).getTime() : Date.now() + 2700000;
        }
        console.log('[debug] Token refreshed:', data.streamUrl.split('/').pop().slice(0, 12));
        _debugToast('Token refreshed!');
        renderDebugPanel();
      } else {
        _debugToast('Token refresh failed: ' + (data.error || 'unknown'));
      }
    } catch (err) {
      _debugToast('Refresh failed: ' + err.message);
    }
  };

  window._debugCopyState = function() {
    const state = {
      audio: getAudioState(),
      context: getPlaybackContext(),
      app: getAppInfo(),
      recentEvents: eventLog.slice(-10),
    };
    const text = JSON.stringify(state, null, 2);

    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => _debugToast('State copied to clipboard'));
    } else {
      console.log('[debug] State:', text);
      _debugToast('State logged to console');
    }
  };

  window._debugClearEvents = function() {
    eventLog.length = 0;
    _debugToast('Events cleared');
    renderDebugPanel();
  };

  function _debugToast(msg) {
    const el = document.createElement('div');
    el.className = 'dbg-toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  // ==================== Panel Show/Hide ====================

  window.showDebugPanel = function() {
    const overlay = document.getElementById('debugOverlay');
    const sheet = document.getElementById('debugSheet');
    if (overlay && sheet) {
      overlay.style.display = 'block';
      sheet.style.display = 'block';
      sheet.classList.add('sheet-up');
      debugVisible = true;
      renderDebugPanel();
      // Auto-refresh every 2 seconds while visible
      window._debugInterval = setInterval(renderDebugPanel, 2000);
    }
  };

  window.hideDebugPanel = function() {
    const overlay = document.getElementById('debugOverlay');
    const sheet = document.getElementById('debugSheet');
    if (overlay && sheet) {
      overlay.style.display = 'none';
      sheet.style.display = 'none';
      sheet.classList.remove('sheet-up');
      debugVisible = false;
      if (window._debugInterval) {
        clearInterval(window._debugInterval);
        window._debugInterval = null;
      }
    }
  };

  // ==================== Settings Secret Access ====================
  // Tap "Server" label 5 times to open debug panel

  let tapCount = 0;
  let tapTimer = null;

  window._debugTapHandler = function() {
    tapCount++;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => { tapCount = 0; }, 2000);
    if (tapCount >= 5) {
      tapCount = 0;
      showDebugPanel();
    }
  };

  // ==================== Init ====================

  // Start capturing events as soon as possible
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDebugCapture);
  } else {
    initDebugCapture();
  }

  console.log('[debug] Diagnostics panel initialized. Call showDebugPanel() or tap Settings → Server 5x.');
})();