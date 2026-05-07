// ===== OFFLINE STORAGE =====
async function loadOfflineKeys() {
  const all = await dbGetAll('songs');
  offlineKeys = new Set(all.map(s => s.key));
}

async function downloadSongOffline(key) {
  if (offlineKeys.has(key)) { toast('Already downloaded'); return; }
  const s = songs.find(x => songKey(x) === key);
  if (!s) return;
  toast('Downloading for offline...');
  try {
    const audioRes = await fetch(audioUrl(s));
    const audioBlob = await audioRes.blob();
    let coverBlob = null;
    try { const cr = await fetch(coverUrl(s)); if (cr.ok) coverBlob = await cr.blob(); } catch(e) {}
    await dbPut('songs', {key, blob: audioBlob, coverBlob, data: s, playlist: s.playlist});
    offlineKeys.add(key);
    toast('Saved offline: ' + s.title);
    hapticNotification('SUCCESS');
    renderLibDownloaded();
    renderAll();
  } catch(e) {
    if (e.name === 'QuotaExceededError' || e.message?.includes('quota')) {
      toast('Storage full — delete some downloads first');
    } else { toast('Failed to save offline'); }
    hapticNotification('ERROR');
    console.error(e);
  }
}

async function removeOffline(key) {
  try {
    await dbDelete('songs', key);
    offlineKeys.delete(key);
    delete coverCache[key];
    toast('Removed from offline');
    renderLibDownloaded();
    renderAll();
  } catch(e) { toast('Failed to remove'); }
}

async function toggleOfflineForCurrent() {
  if (!currentSong) return;
  const key = songKey(currentSong);
  if (offlineKeys.has(key)) await removeOffline(key);
  else await downloadSongOffline(key);
}

async function batchDownload(playlist) {
  const list = playlist ? songs.filter(s => s.playlist === playlist) : songs;
  const toDownload = list.filter(s => !offlineKeys.has(songKey(s)));
  if (toDownload.length === 0) { toast('All songs already downloaded'); return; }
  toast(`Downloading ${toDownload.length} songs...`);
  let done = 0, failed = 0;
  for (const s of toDownload) {
    try {
      const k = songKey(s);
      const ar = await fetch(audioUrl(s));
      const ab = await ar.blob();
      let cb = null;
      try { const cr = await fetch(coverUrl(s)); if (cr.ok) cb = await cr.blob(); } catch(e) {}
      await dbPut('songs', {key: k, blob: ab, coverBlob: cb, data: s, playlist: s.playlist});
      offlineKeys.add(k);
      done++;
    } catch(e) { failed++; }
  }
  toast(`Downloaded ${done}${failed ? `, ${failed} failed` : ''}`);
  hapticNotification(done > 0 ? 'SUCCESS' : 'ERROR');
  renderLibDownloaded();
  renderAll();
}

async function getStorageUsage() {
  let total = 0;
  const all = await dbGetAll('songs');
  all.forEach(s => { if (s.blob) total += s.blob.size; });
  return total;
}

function renderDownloadSheet() {
  const el = document.getElementById('downloadContent');
  if (!el) return;
  const q = songs.filter(s => !offlineKeys.has(songKey(s)));
  el.innerHTML = `
    <div class="dl-progress">Downloaded: ${offlineKeys.size} / ${songs.length} songs</div>
    <button class="ctx-btn" onclick="batchDownload()" style="margin:12px 0"><svg class="icon-ctx"><use href="#icon-download"/></svg> Download All (${q.length})</button>
    ${playlistNames.map(p => {
      const ps = songs.filter(s => s.playlist === p);
      const dl = ps.filter(s => offlineKeys.has(songKey(s))).length;
      return `<button class="ctx-btn" onclick="batchDownload('${p}')"><svg class="icon-ctx"><use href="#icon-download"/></svg> ${p} (${dl}/${ps.length})</button>`;
    }).join('')}
  `;
}
