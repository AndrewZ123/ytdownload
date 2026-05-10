const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

module.exports = function(app, deps) {
const { config, downloadsDir, buildDownloadArgs, getAudioFiles, sanitize, AUDIO_EXTS, saveConfig, hashStr, getLibraryCache, setLibraryCache, clearLibraryCache, isLibraryCacheValid } = deps;

// ==================== Music Library API ====================
// NOTE: Search, proxy/image, youtube/info are handled in routes/streaming.js

// Library cache and hashStr are provided by shared utils

function scanLibrary(callback) {
  if (isLibraryCacheValid()) {
    return callback(null, getLibraryCache());
  }

  const songs = [];
  const artists = {};
  const albums = {};
  let pending = 0;
  let done = false;

  try {
    const dirs = fs.readdirSync(downloadsDir, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const dirPath = path.join(downloadsDir, dir.name);
      const files = getAudioFiles(dirPath);
      for (const f of files) {
        pending++;
        const filePath = path.join(dirPath, f);
        const stat = fs.statSync(filePath);
        const songId = hashStr(dir.name + '/' + f);

        // Use ffprobe for metadata
        execFile('ffprobe', ['-hide_banner', '-print_format', 'json', '-show_format', filePath],
          { maxBuffer: 2 * 1024 * 1024, timeout: 5000 }, (err, stdout) => {
            let title = path.parse(f).name;
            let artist = '';
            let album = '';
            let genre = '';
            let duration = 0;

            if (!err) {
              try {
                const data = JSON.parse(stdout);
                const fmt = data.format || {};
                const tags = fmt.tags || {};
                title = tags.title || tags.TITLE || title;
                artist = tags.artist || tags.ARTIST || artist;
                album = tags.album || tags.ALBUM || '';
                genre = tags.genre || tags.GENRE || '';
                duration = fmt.duration ? parseFloat(fmt.duration) : 0;
              } catch (_) {}
            }

            // Extract YouTube video ID from filename if present (yt-dlp embeds it)
            // Format: "Title [videoId].mp3" or "Title (videoId).mp3"
            let videoId = '';
            const videoIdMatch = f.match(/\[([a-zA-Z0-9_-]{11})\]|\(([a-zA-Z0-9_-]{11})\)/);
            if (videoIdMatch) {
              videoId = videoIdMatch[1] || videoIdMatch[2];
            }

            const song = {
              id: songId,
              title,
              artist,
              album,
              genre,
              duration: Math.round(duration),
              size: stat.size,
              addedAt: stat.mtime,
              playlist: dir.name,
              file: f,
              videoId, // Store YouTube video ID for thumbnail fetching
              coverUrl: `/api/music/cover/${encodeURIComponent(dir.name)}/${encodeURIComponent(f)}`
            };

            songs.push(song);

            // Group by artist
            const artKey = artist.toLowerCase();
            if (!artists[artKey]) artists[artKey] = { name: artist, songs: [] };
            artists[artKey].songs.push(song);

            // Group by album
            const albKey = (album || '__no_album__').toLowerCase();
            if (!albums[albKey]) albums[albKey] = { name: album || 'Unknown Album', artist, songs: [] };
            albums[albKey].songs.push(song);

            pending--;
            if (pending === 0 && done) {
              // Sort songs by addedAt descending
              songs.sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
              setLibraryCache({ songs, artists: Object.values(artists), albums: Object.values(albums) });
              callback(null, getLibraryCache());
            }
          });
      }
    }

    if (pending === 0) {
      setLibraryCache({ songs, artists: Object.values(artists), albums: Object.values(albums) });
      callback(null, getLibraryCache());
    } else {
      done = true;
    }
  } catch (err) {
    callback(err);
  }
}

// Get full library
app.get('/api/music/library', (req, res) => {
  scanLibrary((err, lib) => {
    if (err) return res.status(500).json({ error: 'Failed to scan library' });
    res.json(lib);
  });
});

// Invalidate library cache (call after downloads)
app.post('/api/music/library/refresh', (req, res) => {
  clearLibraryCache();
  res.json({ success: true });
});

// Stream audio with range support
app.get('/api/music/stream/:playlist/:file', (req, res) => {
  const { playlist, file } = req.params;
  const filePath = path.join(downloadsDir, playlist, file);

  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
    '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    '.opus': 'audio/opus'
  };
  const contentType = mimeTypes[ext] || 'audio/mpeg';

  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    const chunkSize = (end - start) + 1;
    const readStream = fs.createReadStream(filePath, { start, end });

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType
    });
    readStream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes'
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// Helper: stream a file as response (avoids sendFile path resolution issues)
function streamFile(res, filePath, contentType = 'image/jpeg') {
  const stat = fs.statSync(filePath);
  res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': stat.size });
  fs.createReadStream(filePath).pipe(res);
}

// Generate a visible SVG placeholder as JPEG
function generatePlaceholder(title) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" style="stop-color:#3a3a3c"/>
        <stop offset="100%" style="stop-color:#2c2c2e"/>
      </linearGradient>
    </defs>
    <rect width="480" height="480" fill="url(#bg)"/>
    <text x="240" y="220" text-anchor="middle" font-size="120" fill="#888">🎵</text>
    <text x="240" y="340" text-anchor="middle" font-size="24" fill="#999" font-family="sans-serif">${(title || '').substring(0, 20)}</text>
  </svg>`;
  return Buffer.from(svg);
}

// Extract and serve cover art
app.get('/api/music/cover/:playlist/:file', (req, res) => {
  const { playlist, file } = req.params;
  const filePath = path.join(downloadsDir, playlist, file);

  if (!fs.existsSync(filePath)) {
    console.log(`[cover] File not found: ${playlist}/${file}`);
    // Return SVG placeholder for missing files
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    return res.end(generatePlaceholder(file));
  }

  // Check for cached cover art
  const coverDir = path.join(downloadsDir, '.covers');
  if (!fs.existsSync(coverDir)) fs.mkdirSync(coverDir, { recursive: true });
  const coverHash = hashStr(playlist + '/' + file);
  const coverPath = path.join(coverDir, coverHash + '.jpg');

  if (fs.existsSync(coverPath)) {
    const stat = fs.statSync(coverPath);
    if (stat.size > 200) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': stat.size });
      return fs.createReadStream(coverPath).pipe(res);
    }
    // Cached file is too small (probably old 1x1 pixel), delete it
    console.log(`[cover] Invalid cache (too small): ${playlist}/${file}, deleting...`);
    fs.unlinkSync(coverPath);
  }

  // Also check for a sidecar thumbnail (downloaded separately)
  const parsed = path.parse(file);
  const thumbJpg = path.join(downloadsDir, playlist, parsed.name + '.jpg');
  const thumbPng = path.join(downloadsDir, playlist, parsed.name + '.png');
  const thumbWebp = path.join(downloadsDir, playlist, parsed.name + '.webp');

  // Check sidecar thumbnails first (fastest path)
  for (const thumb of [[thumbJpg, 'jpg'], [thumbPng, 'png'], [thumbWebp, 'webp']]) {
    const thumbPath = thumb[0];
    if (fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 200) {
      console.log(`[cover] Using sidecar ${thumb[1]}: ${parsed.name}.${thumb[1]}`);
      if (thumb[1] !== 'jpg') {
        // Convert non-JPG to JPG and cache it
        execFile('ffmpeg', ['-i', thumbPath, '-q:v', '2', '-y', coverPath],
          { timeout: 5000 }, (err) => {
            if (err) {
              console.log(`[cover] Failed to convert ${thumb[1]} to JPG: ${err.message}`);
              return streamFile(res, thumbPath, `image/${thumb[1]}`);
            }
            return streamFile(res, coverPath);
          });
      } else {
        fs.copyFileSync(thumbPath, coverPath);
        return streamFile(res, coverPath);
      }
    }
  }

  // Try extracting cover art using ffmpeg with re-encoding (handles non-JPG covers)
  console.log(`[cover] Extracting embedded cover from: ${playlist}/${file}`);
  execFile('ffmpeg', ['-i', filePath, '-an', '-vcodec', 'mjpeg', '-q:v', '2', '-frames:v', '1', '-update', '1', '-y', coverPath],
    { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) {
        console.log(`[cover] Failed to extract cover: ${err.message}`);
      } else if (!fs.existsSync(coverPath) || fs.statSync(coverPath).size < 200) {
        console.log(`[cover] Extracted cover too small or missing`);
      } else {
        console.log(`[cover] Successfully extracted cover (${Math.round(fs.statSync(coverPath).size / 1024)}KB)`);
        return streamFile(res, coverPath);
      }

      // Try png extraction as fallback
      console.log(`[cover] Trying PNG extraction as fallback...`);
      const pngPath = coverPath.replace('.jpg', '_tmp.png');
      execFile('ffmpeg', ['-i', filePath, '-an', '-vcodec', 'png', '-y', pngPath],
        { timeout: 5000 }, (err2) => {
          if (!err2 && fs.existsSync(pngPath) && fs.statSync(pngPath).size > 200) {
            console.log(`[cover] PNG extraction successful, converting to JPG...`);
            // Convert png to jpg
            execFile('ffmpeg', ['-i', pngPath, '-q:v', '2', '-y', coverPath],
              { timeout: 5000 }, () => {
                if (fs.existsSync(pngPath)) fs.unlinkSync(pngPath);
                if (fs.existsSync(coverPath) && fs.statSync(coverPath).size > 200) {
                  return streamFile(res, coverPath);
                }
                console.log(`[cover] PNG to JPG conversion failed, using placeholder`);
                res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
                res.end(generatePlaceholder(parsed.name));
              });
          } else {
            console.log(`[cover] All extraction methods failed, using placeholder`);
            // Clean up
            if (fs.existsSync(pngPath)) fs.unlinkSync(pngPath);
            res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
            res.end(generatePlaceholder(parsed.name));
          }
        });
    });
});

};
