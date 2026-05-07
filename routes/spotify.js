const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

module.exports = function(app, deps) {
const { config, downloadsDir, buildDownloadArgs, getAudioFiles, sanitize, AUDIO_EXTS, saveConfig, hashStr, getLibraryCache, setLibraryCache, clearLibraryCache, isLibraryCacheValid } = deps;

// ==================== FEATURE 2: Spotify Playlist Import ====================

// Spotify Access Token Manager - captures token via Puppeteer
const spotifyToken = { value: null, expires: 0, fetching: null };

function spotifyApiRequest(apiPath, retries = 3) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const url = `https://api.spotify.com${apiPath}`;
      https.get(url, { headers: { 'Authorization': 'Bearer ' + spotifyToken.value } }, (resp) => {
        let data = '';
        resp.on('data', chunk => data += chunk);
        resp.on('end', () => {
          if (resp.statusCode === 429 && retries > 0) {
            const retryAfter = parseInt(resp.headers['retry-after'] || '5') * 1000;
            console.log(`Spotify rate limited, retrying in ${retryAfter / 1000}s...`);
            setTimeout(() => spotifyApiRequest(apiPath, retries - 1).then(resolve).catch(reject), retryAfter);
          } else if (resp.statusCode === 429) {
            reject(new Error('Rate limited. Please try again in a minute.'));
          } else if (resp.statusCode === 401) {
            spotifyToken.value = null;
            reject(new Error('Token expired'));
          } else if (resp.statusCode !== 200) {
            try { reject(new Error(JSON.parse(data).error.message)); } catch (_) { reject(new Error(`HTTP ${resp.statusCode}`)); }
          } else {
            resolve(JSON.parse(data));
          }
        });
      }).on('error', reject);
    };
    attempt();
  });
}

async function getSpotifyAccessToken() {
  if (spotifyToken.value && Date.now() < spotifyToken.expires) return spotifyToken.value;
  if (spotifyToken.fetching) return spotifyToken.fetching;

  spotifyToken.fetching = (async () => {
    try {
      // Cross-platform Chrome path: macOS local, Linux cloud (Docker), or env override
      const chromePath = process.env.PUPPETEER_EXECUTABLE_PATH ||
        (process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : '/usr/bin/chromium');

      const browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
      });
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

      const tokenPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Token capture timeout')), 20000);
        page.on('response', async (response) => {
          if (response.url().includes('/api/token')) {
            try {
              const json = await response.json();
              const token = json.accessToken || json.access_token;
              clearTimeout(timeout);
              resolve(token);
            } catch (_) {}
          }
        });
      });

      await page.goto('https://open.spotify.com/', { waitUntil: 'networkidle2', timeout: 25000 });
      const token = await tokenPromise;
      await browser.close();

      spotifyToken.value = token;
      spotifyToken.expires = Date.now() + 50 * 60 * 1000; // Cache for 50 min
      console.log('Spotify token captured, length:', token.length);
      return token;
    } catch (e) {
      console.error('Spotify token capture failed:', e.message);
      throw e;
    } finally {
      spotifyToken.fetching = null;
    }
  })();

  return spotifyToken.fetching;
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchSpotifyPlaylist(playlistId) {
  // Get a fresh access token via Puppeteer
  await getSpotifyAccessToken();

  // Get playlist name and total track count
  const info = await spotifyApiRequest(`/v1/playlists/${playlistId}?fields=name,tracks.total`);
  const title = info.name || 'Spotify Playlist';
  const totalTracks = info.tracks ? info.tracks.total : 0;

  // Delay between requests to avoid rate limiting
  await delay(500);

  // Fetch all tracks with pagination (100 per page)
  const allTracks = [];
  let offset = 0;
  const limit = 100;

  while (offset < totalTracks) {
    const page = await spotifyApiRequest(
      `/v1/playlists/${playlistId}/tracks?offset=${offset}&limit=${limit}&fields=items(track(name,artists(name),duration_ms,uri))`
    );
    const items = page.items || [];
    for (const item of items) {
      if (item.track) {
        allTracks.push({
          title: item.track.name || 'Unknown',
          artist: (item.track.artists || []).map(a => a.name).join(', '),
          duration: item.track.duration_ms ? Math.round(item.track.duration_ms / 1000) : null,
          uri: item.track.uri || ''
        });
      }
    }
    offset += limit;
    if (items.length < limit) break;
    // Small delay between pages to avoid rate limiting
    await delay(300);
  }

  return {
    title,
    tracks: allTracks.map((t, i) => ({
      index: i + 1,
      title: t.title,
      artist: t.artist,
      spotifyUri: t.uri,
      duration: t.duration,
      searchQuery: `${t.title} ${t.artist}`.trim()
    }))
  };
}

app.get('/api/spotify-playlist', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing Spotify URL' });

  const match = url.match(/playlist\/([a-zA-Z0-9]+)/);
  if (!match) return res.status(400).json({ error: 'Invalid Spotify playlist URL' });

  try {
    const { title, tracks } = await fetchSpotifyPlaylist(match[1]);
    res.json({ title, count: tracks.length, tracks });
  } catch (e) {
    console.error('Spotify error:', e.message);
    res.status(500).json({ error: 'Failed to fetch Spotify playlist: ' + e.message });
  }
});

// Spotify Playlist Download (SSE) - search YouTube for each track and download
app.get('/api/spotify-download', (req, res) => {
  const { url, format, quality } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing Spotify URL' });

  const match = url.match(/playlist\/([a-zA-Z0-9]+)/);
  if (!match) return res.status(400).json({ error: 'Invalid Spotify playlist URL' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  fetchSpotifyPlaylist(match[1]).then(({ title, tracks }) => {
    const playlistName = sanitize(title);
    const playlistDir = path.join(downloadsDir, playlistName);
    fs.mkdirSync(playlistDir, { recursive: true });
    send('playlist', { total: tracks.length, playlistTitle: playlistName });

    let current = 0;
    let downloaded = 0;
    let errors = 0;

    const dlNext = () => {
      if (current >= tracks.length) {
        send('done', { message: `Downloaded ${downloaded}/${tracks.length} tracks from "${title}"${errors ? ` (${errors} failed)` : ''}`, playlistTitle: playlistName, downloaded, errors, total: tracks.length });
        return res.end();
      }
      const track = tracks[current++];
      send('progress', { current, total: tracks.length, title: `${track.title} - ${track.artist}`, status: 'searching' });

      // Search YouTube for the track
      const searchQuery = `ytsearch1:${track.searchQuery}`;
      execFile('yt-dlp', ['--no-warnings', '-J', '--flat-playlist', searchQuery], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        if (err) {
          errors++;
          send('progress', { current, total: tracks.length, title: `${track.title} - ${track.artist}`, status: 'error', error: 'Search failed' });
          return dlNext();
        }
        try {
          const searchData = JSON.parse(stdout);
          const entries = searchData.entries || [];
          if (!entries.length) {
            errors++;
            send('progress', { current, total: tracks.length, title: `${track.title} - ${track.artist}`, status: 'error', error: 'No results' });
            return dlNext();
          }
          const videoId = entries[0].id || entries[0].url;
          const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
          send('progress', { current, total: tracks.length, title: `${track.title} - ${track.artist}`, status: 'downloading' });

          const dlArgs = [...buildDownloadArgs(playlistDir, format, quality), videoUrl];
          execFile('yt-dlp', dlArgs, { maxBuffer: 10 * 1024 * 1024 }, (err) => {
            if (err) {
              errors++;
              send('progress', { current, total: tracks.length, title: `${track.title} - ${track.artist}`, status: 'error', error: 'Download failed' });
            } else {
              downloaded++;
              send('progress', { current, total: tracks.length, title: `${track.title} - ${track.artist}`, status: 'done' });
            }
            dlNext();
          });
        } catch (e) {
          errors++;
          send('progress', { current, total: tracks.length, title: `${track.title} - ${track.artist}`, status: 'error', error: 'Parse error' });
          dlNext();
        }
      });
    };
    dlNext();
  }).catch(e => {
    send('error', { message: 'Failed to fetch Spotify playlist: ' + e.message });
    res.end();
  });
});

};
