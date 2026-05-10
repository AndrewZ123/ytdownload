// ===== UI HELPERS =====
function toast(msg, dur = 2500) {
  const t = document.createElement('div');
  t.className = 'toast-msg';
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, dur);
}

function songItemHTML(s, listId) {
  const k = songKey(s);
  const liked = likedKeys.has(k);
  const downloaded = offlineKeys.has(k);
  const dur = s.duration ? formatTime(s.duration) : '';
  const esc = k.replace(/'/g, "\\'");
  return `<div class="song-item" data-key="${k}" data-list="${listId}" onclick="playSongFromList('${esc}','${listId}')" role="button" aria-label="Play ${s.title||''}">
    <div class="song-art"><img src="${coverUrl(s)}" alt="" loading="lazy" onerror="onImageError(this)"></div>
    <div class="song-info"><div class="song-title">${s.title||''}</div><div class="song-meta">${s.artist||'Unknown'}${s.album?' · '+s.album:''}</div></div>
    ${dur?`<span class="song-dur">${dur}</span>`:''}
    ${liked?'<span class="song-liked-badge" aria-label="Liked"><svg class="icon-xs" style="color:#fc3c44"><use href="#icon-heart-filled"/></svg></span>':''}
    ${downloaded?'<span class="song-dl-badge" aria-label="Downloaded"><svg class="icon-xs" style="color:#32d74b"><use href="#icon-download"/></svg></span>':''}
    <button class="song-menu" onclick="event.stopPropagation();showContextMenu('${esc}')" aria-label="More options"><svg class="icon-sm"><use href="#icon-more"/></svg></button>
  </div>`;
}

function showSheet(id) {
  document.getElementById(id + 'Overlay')?.classList.add('show');
  document.getElementById(id + 'Sheet')?.classList.add('show');
}
function hideSheet(id) {
  document.getElementById(id + 'Overlay')?.classList.remove('show');
  document.getElementById(id + 'Sheet')?.classList.remove('show');
}

function showDownloadSheet() { showSheet('download'); renderDownloadSheet(); }
function hideDownloadSheet() { hideSheet('download'); }
function showQueueSheet() { showSheet('queue'); renderQueueSheet(); }
function hideQueueSheet() { hideSheet('queue'); }

function showContextMenu(key) {
  state_contextKey = key;
  const s = songs.find(x => songKey(x) === key);
  if (!s) return;
  const liked = likedKeys.has(key);
  const downloaded = offlineKeys.has(key);
  document.getElementById('ctxTitle').textContent = s.title;
  document.getElementById('ctxArtist').textContent = s.artist || 'Unknown';
  const art = document.getElementById('ctxArt');
  art.src = coverUrl(s); art.onerror = () => onImageError(art); art.style.display = '';
  document.getElementById('ctxLikeBtn').innerHTML = liked
    ? '<svg class="icon-ctx"><use href="#icon-heart-filled"/></svg> Unlike'
    : '<svg class="icon-ctx"><use href="#icon-heart"/></svg> Like';
  document.getElementById('ctxDlBtn').innerHTML = downloaded
    ? '<svg class="icon-ctx"><use href="#icon-x"/></svg> Remove Download'
    : '<svg class="icon-ctx"><use href="#icon-download"/></svg> Download';
  document.getElementById('ctxArtistBtn').style.display = s.artist ? 'flex' : 'none';
  document.getElementById('ctxAlbumBtn').style.display = s.album ? 'flex' : 'none';
  showSheet('context');
}
function hideContextMenu() { hideSheet('context'); }
let state_contextKey = '';

function showSettings() {
  showSheet('settings');
  const theme = localStorage.getItem('theme') || 'dark';
  document.getElementById('themeDark')?.classList.toggle('active', theme === 'dark');
  document.getElementById('themeLight')?.classList.toggle('active', theme === 'light');
}
function hideSettings() { hideSheet('settings'); }

// ===== HAPTIC FEEDBACK =====
async function hapticImpact(style = 'LIGHT') {
  try { if (window.Capacitor?.Plugins?.Haptics) await Capacitor.Plugins.Haptics.impact({ style }); } catch(e) {}
}
async function hapticNotification(type = 'SUCCESS') {
  try { if (window.Capacitor?.Plugins?.Haptics) await Capacitor.Plugins.Haptics.notification({ type }); } catch(e) {}
}

// ===== SHARE =====
async function shareSong(song) {
  try {
    if (window.Capacitor?.Plugins?.Share) {
      await Capacitor.Plugins.Share.share({ title: song.title, text: `${song.title} by ${song.artist || 'Unknown'}` });
    }
  } catch(e) { if (!e.message?.includes('cancelled')) toast('Share failed'); }
}

// ===== KEYBOARD SHORTCUTS =====
function initKeyboard() {
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); hapticImpact('LIGHT'); }
    else if (e.code === 'ArrowRight' && e.metaKey) { e.preventDefault(); playNext(); }
    else if (e.code === 'ArrowLeft' && e.metaKey) { e.preventDefault(); playPrev(); }
  });
}

// ===== SLEEP TIMER =====
function setSleepTimer(minutes) {
  if (sleepTimerInterval) clearInterval(sleepTimerInterval);
  if (minutes <= 0) { sleepTimerEnd = null; toast('Sleep timer cancelled'); hideSheet('sleepTimer'); return; }
  sleepTimerEnd = Date.now() + minutes * 60000;
  toast(`Sleep timer: ${minutes} min`);
  hideSheet('sleepTimer');
  sleepTimerInterval = setInterval(() => {
    if (Date.now() >= sleepTimerEnd) { audio.pause(); sleepTimerEnd = null; clearInterval(sleepTimerInterval); toast('Sleep timer ended'); updatePlayerUI(offlineKeys.has(songKey(currentSong))); }
  }, 5000);
}
function getSleepTimerRemaining() {
  if (!sleepTimerEnd) return null;
  return Math.max(0, Math.ceil((sleepTimerEnd - Date.now()) / 60000));
}