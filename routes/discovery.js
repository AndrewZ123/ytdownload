const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

module.exports = function(app, deps) {
const { config, downloadsDir, buildDownloadArgs, getAudioFiles, sanitize, AUDIO_EXTS, saveConfig, hashStr, getLibraryCache, setLibraryCache, clearLibraryCache, isLibraryCacheValid } = deps;

// ==================== Feature: Suggested for You (Library-based) ====================
// ==================== Smart Discovery API ====================

// Discover cache (short TTL to avoid hammering YouTube)
let discoverCache = null;
let discoverCacheTime = 0;
const DISCOVER_CACHE_TTL = 300000; // 5 minutes

// Genre keyword mapping for taste detection
const genreKeywords = {
  worship: ['jesus','christ','christian','worship','praise','church','god','holy','bless','faith','prayer','hymn','gospel','amen','hallelujah','cross','altar','lord','grace','mercy','spirit','psalm','sermon','choir','congregation','devotional'],
  hiphop: ['hip hop','hiphop','rap','trap','beats','bars','flow','mixtape','freestyle','drill'],
  rock: ['rock','metal','punk','grunge','indie rock','alternative','hard rock'],
  pop: ['pop','mainstream','top 40','hit','radio edit','kpop','k-pop'],
  edm: ['edm','electronic','house','techno','trance','dubstep','dj','remix','club','rave'],
  rnb: ['r&b','rnb','soul','neo soul','slow jam','afrobeat','afrobeats'],
  country: ['country','nashville','bluegrass','folk','acoustic','americana'],
  jazz: ['jazz','blues','swing','bebop','smooth jazz','funk'],
  classical: ['classical','orchestra','symphony','sonata','concerto','piano','baroque'],
  latin: ['latin','reggaeton','salsa','bachata','merengue','cumbia','bossa nova'],
  indie: ['indie','alternative','lo-fi','lofi','shoegaze','dream pop'],
  metal: ['metal','death metal','black metal','thrash','heavy metal','doom']
};

const genreSuffixMap = {
  worship: 'christian worship music',
  hiphop: 'hip hop music',
  rock: 'rock music',
  pop: 'pop music',
  edm: 'electronic dance music',
  rnb: 'r&b soul music',
  country: 'country music',
  jazz: 'jazz blues music',
  classical: 'classical music',
  latin: 'latin music reggaeton',
  indie: 'indie alternative music',
  metal: 'metal rock music'
};

// Detect genres from library text
function detectGenres(allText) {
  const detected = [];
  for (const [genre, keywords] of Object.entries(genreKeywords)) {
    const matchCount = keywords.filter(k => allText.includes(k)).length;
    if (matchCount >= 2) detected.push({ genre, matchCount });
  }
  detected.sort((a, b) => b.matchCount - a.matchCount);
  return detected;
}

// Search YouTube using yt-dlp and return entries
function ytSearch(query, maxResults = 8) {
  return new Promise((resolve) => {
    const searchUrl = `ytsearch${maxResults}:${query}`;
    execFile('yt-dlp', ['--no-warnings', '-J', '--flat-playlist', searchUrl],
      { maxBuffer: 10 * 1024 * 1024, timeout: 30000 }, (err, stdout) => {
        if (err) return resolve([]);
        try {
          const data = JSON.parse(stdout);
          resolve((data.entries || []).filter(e => e && e.title));
        } catch (_) { resolve([]); }
      });
  });
}

// Get YouTube mixes (radio) for a song
function ytRadio(videoId, maxResults = 15) {
  return new Promise((resolve) => {
    const url = `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`;
    execFile('yt-dlp', ['--no-warnings', '-J', '--flat-playlist', url],
      { maxBuffer: 30 * 1024 * 1024, timeout: 45000 }, (err, stdout) => {
        if (err) return resolve([]);
        try {
          const data = JSON.parse(stdout);
          resolve((data.entries || []).filter(e => e && e.title).slice(0, maxResults));
        } catch (_) { resolve([]); }
      });
  });
}

// Clean a name for search
function cleanName(n) {
  return n.replace(/[⧸／\/\\()（）\[\]{}|&:'""]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Normalize string for comparison
function normalizeKey(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

app.get('/api/discover', (req, res) => {
  // Check cache
  if (discoverCache && Date.now() - discoverCacheTime < DISCOVER_CACHE_TTL) {
    return res.json(discoverCache);
  }

  try {
    // 1. Scan all songs in library
    const allSongs = [];
    const dirs = fs.readdirSync(downloadsDir, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory() || dir.name.startsWith('.')) continue;
      const dirPath = path.join(downloadsDir, dir.name);
      const files = getAudioFiles(dirPath);
      for (const f of files) {
        allSongs.push({ name: path.parse(f).name, playlist: dir.name, file: f });
      }
    }

    if (allSongs.length === 0) {
      return res.json({
        becauseYouListened: [], newReleases: [], trendingInYourTaste: [],
        artistRecommendations: [], hiddenGems: [], radioRecommendations: [],
        detectedGenre: null
      });
    }

    // 2. Build library fingerprint
    const existingKeys = new Set(allSongs.map(s => normalizeKey(s.name)));
    const allText = allSongs.map(s => (s.name + ' ' + s.playlist).toLowerCase()).join(' ');
    const detectedGenres = detectGenres(allText);
    const primaryGenre = detectedGenres.length > 0 ? detectedGenres[0].genre : null;

    // Extract artist names from filenames (common patterns: "Artist - Title", "Artist_Title")
    const artistCounts = {};
    for (const s of allSongs) {
      const parts = s.name.split(/\s*[-–—]\s*/);
      if (parts.length >= 2) {
        const artist = parts[0].trim();
        if (artist.length > 1 && artist.length < 60) {
          artistCounts[artist] = (artistCounts[artist] || 0) + 1;
        }
      }
    }
    // Sort by frequency
    const topArtists = Object.entries(artistCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(e => e[0]);

    // 3. Pick seed songs (weighted toward recent + liked)
    const shuffled = [...allSongs].sort(() => Math.random() - 0.5);
    const seeds = shuffled.slice(0, Math.min(4, shuffled.length));

    // 4. Launch all strategies in parallel
    const currentYear = new Date().getFullYear();
    const currentMonth = new Date().toLocaleString('en', { month: 'long' });

    const strategies = [];

    // Strategy 1: "Because You Listened To [Artist]" - search for similar artist songs
    if (topArtists.length > 0) {
      const artist = topArtists[Math.floor(Math.random() * topArtists.length)];
      strategies.push(
        ytSearch(`${artist} similar artists music`, 10).then(entries => ({
          key: 'becauseYouListened',
          source: artist,
          entries
        }))
      );
    }

    // Strategy 2: New releases in detected genre
    if (primaryGenre) {
      const suffix = genreSuffixMap[primaryGenre] || primaryGenre;
      strategies.push(
        ytSearch(`new ${suffix} ${currentYear}`, 10).then(entries => ({
          key: 'newReleases',
          entries
        }))
      );
    } else {
      strategies.push(
        ytSearch(`new music releases ${currentMonth} ${currentYear}`, 10).then(entries => ({
          key: 'newReleases',
          entries
        }))
      );
    }

    // Strategy 3: Trending in detected genre
    if (primaryGenre) {
      const suffix = genreSuffixMap[primaryGenre] || primaryGenre;
      strategies.push(
        ytSearch(`trending ${suffix} ${currentYear}`, 10).then(entries => ({
          key: 'trendingInYourTaste',
          entries
        }))
      );
    } else {
      strategies.push(
        ytSearch('trending music 2025 hits', 10).then(entries => ({
          key: 'trendingInYourTaste',
          entries
        }))
      );
    }

    // Strategy 4: Artist recommendations - "artists like X"
    if (topArtists.length >= 1) {
      const artist = topArtists[0];
      strategies.push(
        ytSearch(`artists like ${artist} playlist`, 10).then(entries => ({
          key: 'artistRecommendations',
          entries
        }))
      );
    }

    // Strategy 5: Hidden gems / deep cuts from seed songs
    if (seeds.length > 0) {
      const seed = seeds[0];
      const searchTerm = cleanName(seed.name);
      strategies.push(
        ytSearch(`${searchTerm} deep cuts b sides rare`, 8).then(entries => ({
          key: 'hiddenGems',
          entries
        }))
      );
    }

    // Strategy 6: YouTube Radio (related videos) for a random seed song
    // We need to find a video ID first, then use the radio endpoint
    if (seeds.length > 0) {
      const seed = seeds[Math.floor(Math.random() * seeds.length)];
      strategies.push(
        ytSearch(cleanName(seed.name), 1).then(entries => {
          if (entries.length > 0 && entries[0].id) {
            return ytRadio(entries[0].id, 20).then(radioEntries => ({
              key: 'radioRecommendations',
              source: seed.name,
              entries: radioEntries
            }));
          }
          return { key: 'radioRecommendations', entries: [], source: seed.name };
        })
      );
    }

    // Strategy 7: Cross-genre exploration (if we detect a genre, suggest adjacent genres)
    const adjacentGenres = {
      worship: ['christian rock', 'gospel soul'],
      hiphop: ['r&b soul', 'afrobeats'],
      rock: ['indie alternative', 'grunge'],
      pop: ['indie pop', 'synthwave'],
      edm: ['synthwave', 'chillhop'],
      rnb: ['neo soul', 'jazz funk'],
      country: ['folk americana', 'bluegrass'],
      jazz: ['blues', 'soul funk'],
      classical: ['neoclassical', 'ambient piano'],
      latin: ['afrobeat', 'dancehall reggaeton'],
      indie: ['dream pop', 'post rock'],
      metal: ['hard rock', 'progressive rock']
    };
    if (primaryGenre && adjacentGenres[primaryGenre]) {
      const adj = adjacentGenres[primaryGenre];
      const pick = adj[Math.floor(Math.random() * adj.length)];
      strategies.push(
        ytSearch(`best ${pick} songs ${currentYear}`, 10).then(entries => ({
          key: 'crossGenre',
          entries
        }))
      );
    }

    // Strategy 8: Mood-based suggestions
    const moods = ['chill vibes', 'workout motivation', 'late night drive', 'feel good', 'study focus'];
    const mood = moods[Math.floor(Math.random() * moods.length)];
    strategies.push(
      ytSearch(`${mood} music playlist ${currentYear}`, 10).then(entries => ({
        key: 'moodPicks',
        entries
      }))
    );

    // 5. Wait for all strategies and compile results
    Promise.allSettled(strategies).then(results => {
      const response = {
        becauseYouListened: [],
        becauseYouListenedSource: null,
        newReleases: [],
        trendingInYourTaste: [],
        detectedGenre: primaryGenre,
        artistRecommendations: [],
        hiddenGems: [],
        radioRecommendations: [],
        radioSource: null,
        crossGenre: [],
        moodPicks: []
      };

      for (const result of results) {
        if (result.status !== 'fulfilled' || !result.value) continue;
        const { key, entries, source } = result.value;
        if (!entries || entries.length === 0) continue;

        // Filter out songs already in library
        const filtered = entries.filter(e => {
          const eKey = normalizeKey(e.title || '');
          return !existingKeys.has(eKey);
        }).map(e => ({
          title: e.title || 'Unknown',
          id: e.id || e.url || '',
          channel: e.uploader || e.channel || '',
          duration: e.duration || null,
          thumbnail: (e.thumbnails && e.thumbnails.length > 0)
            ? (e.thumbnails.find(t => t.width >= 200 && t.width <= 400) || e.thumbnails[e.thumbnails.length - 1]).url
            : `https://img.youtube.com/vi/${e.id || ''}/mqdefault.jpg`
        }));

        // Deduplicate
        const seen = new Set();
        const unique = filtered.filter(item => {
          const k = normalizeKey(item.title);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });

        if (key === 'becauseYouListened') {
          response.becauseYouListened = unique.slice(0, 10);
          response.becauseYouListenedSource = source || null;
        } else if (key === 'newReleases') {
          response.newReleases = unique.slice(0, 10);
        } else if (key === 'trendingInYourTaste') {
          response.trendingInYourTaste = unique.slice(0, 10);
        } else if (key === 'artistRecommendations') {
          response.artistRecommendations = unique.slice(0, 10);
        } else if (key === 'hiddenGems') {
          response.hiddenGems = unique.slice(0, 10);
        } else if (key === 'radioRecommendations') {
          response.radioRecommendations = unique.slice(0, 15);
          response.radioSource = source || null;
        } else if (key === 'crossGenre') {
          response.crossGenre = unique.slice(0, 10);
        } else if (key === 'moodPicks') {
          response.moodPicks = unique.slice(0, 10);
        }
      }

      // Cache the result
      discoverCache = response;
      discoverCacheTime = Date.now();

      res.json(response);
    });
  } catch (err) {
    console.error('Discover error:', err);
    res.status(500).json({ error: 'Failed to generate discovery' });
  }
});

// Invalidate discover cache
app.post('/api/discover/refresh', (req, res) => {
  discoverCache = null;
  res.json({ success: true });
});

app.get('/api/suggested', (req, res) => {
  try {
    // 1. Collect all song display names from library
    const allSongs = [];
    const dirs = fs.readdirSync(downloadsDir, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const dirPath = path.join(downloadsDir, dir.name);
      const files = getAudioFiles(dirPath);
      for (const f of files) {
        allSongs.push({ name: path.parse(f).name, playlist: dir.name });
      }
    }

    if (allSongs.length === 0) return res.json({ suggestions: [], sampled: [], totalLibrary: 0 });

    // 2. Detect genre from library content
    const allText = allSongs.map(s => (s.name + ' ' + s.playlist).toLowerCase()).join(' ');
    const genreKeywords = {
      worship: ['jesus','christ','christian','worship','praise','church','god','holy','bless','faith','prayer','hymn','gospel','amen','hallelujah','cross','altar','lord','grace','mercy','spirit','psalm','sermon','choir','congregation','devotional'],
      hiphop: ['hip hop','hiphop','rap','trap','beats','bars','flow','mixtape','freestyle'],
      rock: ['rock','metal','punk','grunge','indie rock','alternative'],
      pop: ['pop','mainstream','top 40','hit','radio edit'],
      edm: ['edm','electronic','house','techno','trance','dubstep','dj','remix','club'],
      rnb: ['r&b','rnb','soul','neo soul','slow jam'],
      country: ['country','nashville','bluegrass','folk','acoustic'],
      jazz: ['jazz','blues','swing','bebop','smooth jazz'],
      classical: ['classical','orchestra','symphony','sonata','concerto','piano']
    };

    const detectedGenres = [];
    for (const [genre, keywords] of Object.entries(genreKeywords)) {
      const matchCount = keywords.filter(k => allText.includes(k)).length;
      if (matchCount >= 2) detectedGenres.push({ genre, matchCount });
    }
    detectedGenres.sort((a, b) => b.matchCount - a.matchCount);
    const primaryGenre = detectedGenres.length > 0 ? detectedGenres[0].genre : null;

    // 3. Pick up to 3 random songs to use as seeds
    const shuffled = allSongs.sort(() => Math.random() - 0.5);
    const seeds = shuffled.slice(0, Math.min(3, shuffled.length));

    const cleanName = (n) => n.replace(/[⧸／\/\\()（）\[\]{}|&:'""]/g, ' ').replace(/\s+/g, ' ').trim();

    let completed = 0;
    const allSuggestions = [];
    const existingNames = new Set(allSongs.map(s => s.name.toLowerCase().replace(/[^a-z0-9]/g, '')));
    const targetCount = 20;

    // Build genre-specific search queries
    const genreSearchSuffix = {
      worship: 'worship music',
      hiphop: 'hip hop',
      rock: 'rock music',
      pop: 'pop music',
      edm: 'electronic music',
      rnb: 'r&b soul music',
      country: 'country music',
      jazz: 'jazz music',
      classical: 'classical music'
    };

    const finalize = () => {
      const seen = new Set();
      const unique = allSuggestions.filter(s => {
        const k = s.title.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }).slice(0, targetCount);

      res.json({
        suggestions: unique,
        sampled: seeds.map(s => s.name),
        totalLibrary: allSongs.length,
        detectedGenre: primaryGenre
      });
    };

    // Strategy 1: For each seed song, search YouTube Music with genre context
    seeds.forEach((seed) => {
      const suffix = primaryGenre ? (genreSearchSuffix[primaryGenre] || primaryGenre) : '';
      const searchTerm = cleanName(seed.name);
      // Search: "song title genre" to get genre-matched results
      const query = suffix ? `${searchTerm} ${suffix}` : searchTerm;
      const searchUrl = `ytsearch5:${query}`;

      execFile('yt-dlp', ['--no-warnings', '-J', '--flat-playlist', searchUrl], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        completed++;
        if (!err) {
          try {
            const data = JSON.parse(stdout);
            const entries = (data.entries || []).slice(0, 5);
            entries.forEach(e => {
              const title = e.title || 'Unknown';
              const key = title.toLowerCase().replace(/[^a-z0-9]/g, '');
              // Skip if already in library or is a very close match to the seed
              const seedKey = seed.name.toLowerCase().replace(/[^a-z0-9]/g, '');
              if (!existingNames.has(key) && key !== seedKey) {
                allSuggestions.push({
                  title,
                  id: e.id || e.url || '',
                  channel: e.uploader || e.channel || '',
                  duration: e.duration || null,
                  seededFrom: seed.name
                });
              }
            });
          } catch (_) {}
        }

        if (completed === seeds.length) finalize();
      });
    });

    // Strategy 2 (parallel): Search for a genre compilation/mix playlist for more variety
    if (primaryGenre) {
      const genreMixQuery = `${primaryGenre} music playlist 2024`;
      const mixSearchUrl = `ytsearch1:${genreMixQuery}`;
      execFile('yt-dlp', ['--no-warnings', '-J', '--flat-playlist', mixSearchUrl], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        if (!err) {
          try {
            const data = JSON.parse(stdout);
            const entries = data.entries || [];
            if (entries.length > 0) {
              // Get the first playlist result and expand it
              const playlistId = entries[0].url || entries[0].id || '';
              if (playlistId) {
                const playlistUrl = playlistId.startsWith('http') ? playlistId : `https://www.youtube.com/playlist?list=${playlistId}`;
                execFile('yt-dlp', ['--no-warnings', '-J', '--flat-playlist', playlistUrl], { maxBuffer: 30 * 1024 * 1024 }, (err2, stdout2) => {
                  if (!err2) {
                    try {
                      const pData = JSON.parse(stdout2);
                      const pEntries = (pData.entries || []).slice(0, 25);
                      pEntries.forEach(e => {
                        const title = e.title || 'Unknown';
                        const key = title.toLowerCase().replace(/[^a-z0-9]/g, '');
                        if (!existingNames.has(key)) {
                          allSuggestions.push({
                            title,
                            id: e.id || e.url || '',
                            channel: e.uploader || e.channel || '',
                            duration: e.duration || null,
                            seededFrom: `${primaryGenre} mix`
                          });
                        }
                      });
                    } catch (_) {}
                  }
                });
              }
            }
          } catch (_) {}
        }
      });
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate suggestions' });
  }
});

};
