/* ===== GESTURES ===== */
// Swipe-down to dismiss full player
// Edge-swipe to close playlist view

(function() {
  'use strict';

  // ===== FULL PLAYER SWIPE-DOWN =====
  const player = document.getElementById('fullPlayer');
  let py0 = 0, pDy = 0, pDragging = false;

  if (player) {
    // Helper: check if touch is on/near the seek bar (exclude from swipe)
    function isNearSeekBar(e) {
      var bar = document.getElementById('fpProgressBar');
      if (!bar) return false;
      var rect = bar.getBoundingClientRect();
      // Add 30px padding around the bar as a dead zone
      var pad = 30;
      var tx = e.touches[0].clientX;
      var ty = e.touches[0].clientY;
      return (tx >= rect.left - pad && tx <= rect.right + pad &&
              ty >= rect.top - pad && ty <= rect.bottom + pad);
    }

    // Track if the touch started in the seek bar zone
    var pTouchOnSeekBar = false;

    player.addEventListener('touchstart', function(e) {
      if (!player.classList.contains('show')) return;
      pTouchOnSeekBar = isNearSeekBar(e);
      if (pTouchOnSeekBar) return; // don't initiate gesture
      py0 = e.touches[0].clientY;
      pDy = 0;
      pDragging = false;
    }, { passive: true });

    player.addEventListener('touchmove', function(e) {
      if (!player.classList.contains('show')) return;
      if (pTouchOnSeekBar) return; // don't swipe if touch started on seek bar
      const dy = e.touches[0].clientY - py0;
      // Only allow downward swipe
      if (dy > 10 && !pDragging) {
        pDragging = true;
        player.classList.add('dragging');
      }
      if (pDragging) {
        pDy = dy;
        // Apply rubber-band effect: slowdown as you drag more
        const damped = dy < 0 ? 0 : dy * 0.7;
        player.style.transform = 'translateY(' + damped + 'px)';
        // Fade out slightly
        const opacity = Math.max(0.5, 1 - (damped / 600));
        player.style.opacity = opacity;
      }
    }, { passive: true });

    player.addEventListener('touchend', function() {
      if (pTouchOnSeekBar) { pTouchOnSeekBar = false; return; }
      if (!pDragging) return;
      pDragging = false;
      player.classList.remove('dragging');
      player.style.opacity = '';

      const threshold = 120;
      if (pDy > threshold) {
        // Dismiss: animate down then hide
        player.classList.add('dismissing');
        player.style.transform = 'translateY(100%)';
        setTimeout(function() {
          player.classList.remove('dismissing');
          player.style.transform = '';
          player.classList.remove('show');
          if (typeof hideFullPlayer === 'function') hideFullPlayer();
          else if (typeof closeFullPlayer === 'function') closeFullPlayer();
        }, 300);
      } else {
        // Snap back
        player.style.transform = '';
      }
    }, { passive: true });

    player.addEventListener('touchcancel', function() {
      if (!pDragging) return;
      pDragging = false;
      player.classList.remove('dragging');
      player.style.opacity = '';
      player.style.transform = '';
    }, { passive: true });
  }

  // ===== PLAYLIST VIEW EDGE SWIPE =====
  const playlist = document.getElementById('playlistView');
  let sx0 = 0, sDx = 0, sDragging = false, sStartEdge = false;

  if (playlist) {
    playlist.addEventListener('touchstart', function(e) {
      if (!playlist.classList.contains('active')) return;
      sx0 = e.touches[0].clientX;
      sDx = 0;
      sDragging = false;
      // Only trigger from left 30px edge
      sStartEdge = sx0 < 30;
    }, { passive: true });

    playlist.addEventListener('touchmove', function(e) {
      if (!playlist.classList.contains('active') || !sStartEdge) return;
      const dx = e.touches[0].clientX - sx0;
      // Only allow rightward swipe from edge
      if (dx > 10 && !sDragging) {
        sDragging = true;
        playlist.classList.add('dragging');
      }
      if (sDragging) {
        sDx = dx;
        const damped = dx < 0 ? 0 : dx * 0.8;
        playlist.style.transform = 'translateX(' + damped + 'px)';
      }
    }, { passive: true });

    playlist.addEventListener('touchend', function() {
      if (!sDragging) return;
      sDragging = false;
      sStartEdge = false;
      playlist.classList.remove('dragging');

      const threshold = 80;
      if (sDx > threshold) {
        // Close: animate right then hide
        playlist.style.transform = 'translateX(100%)';
        setTimeout(function() {
          playlist.style.transform = '';
          if (typeof closePlaylistView === 'function') closePlaylistView();
        }, 350);
      } else {
        // Snap back
        playlist.style.transform = '';
      }
    }, { passive: true });

    playlist.addEventListener('touchcancel', function() {
      if (!sDragging) return;
      sDragging = false;
      sStartEdge = false;
      playlist.classList.remove('dragging');
      playlist.style.transform = '';
    }, { passive: true });
  }
})();