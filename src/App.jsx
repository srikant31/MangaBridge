import React, { useEffect, useState } from 'react';

const SOURCE_LABELS = {
  mangaepisodeguide: { label: "Verified",      color: "text-emerald-400" },
  fandom_wiki:       { label: "Wiki source",   color: "text-blue-400"    },
  reddit:            { label: "Community",     color: "text-orange-400"  },
  ai_inferred:       { label: "AI estimate",   color: "text-yellow-400"  },
};

async function fetchAniListData(title) {
  const query = `
    query ($search: String!) {
      Media(search: $search, type: ANIME) {
        id
        title { romaji english }
        episodes
        relations {
          edges {
            relationType
            node {
              type
              title { romaji english }
              chapters
            }
          }
        }
      }
    }
  `;
  const res = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { search: title } })
  });
  const data = await res.json();
  const media = data?.data?.Media;
  if (!media) return null;

  const mangaEdge = media.relations?.edges?.find(e =>
    (e.relationType === 'SOURCE' || e.relationType === 'ADAPTATION') &&
    e.node.type === 'MANGA'
  );

  return {
    animeTitle: media.title.english || media.title.romaji,
    totalEpisodes: media.episodes,
    mangaTitle: mangaEdge?.node?.title?.english || mangaEdge?.node?.title?.romaji,
    totalChapters: mangaEdge?.node?.chapters,
  };
}

function estimateChapters(episodeNum, totalEpisodes, totalChapters, fillerType) {
  if (!totalChapters || !totalEpisodes) return null;
  // For filler episodes, return null so UI shows "Filler - No manga source"
  if (fillerType === 'filler') return null;
  const chaptersPerEp = totalChapters / totalEpisodes;
  const start = Math.round((episodeNum - 1) * chaptersPerEp) + 1;
  const end = Math.round(episodeNum * chaptersPerEp);
  return {
    chapters: [start, end],
    continue_from: end + 1,
    filler_type: 'canon',
    source: 'ai_inferred',
    confidence: 'low',
    notes: ['Chapter range estimated — verify on wiki']
  };
}
async function dynamicLookup(animeTitle, episodeNum) {
  try {
    console.log('[MangaBridge] dynamicLookup called:', animeTitle, episodeNum);
    const anilist = await fetchAniListData(animeTitle);
    console.log('[MangaBridge] AniList result:', anilist);
    if (!anilist) return null;
    const estimated = estimateChapters(episodeNum, anilist.totalEpisodes, anilist.totalChapters);
    console.log('[MangaBridge] Estimated chapters:', estimated);
    return {
      animeTitle: anilist.animeTitle,
      mangaTitle: anilist.mangaTitle,
      episodeData: estimated,
      fromDynamic: true,
    };
  } catch (e) {
    console.warn('[MangaBridge] Dynamic lookup failed:', e);
    return null;
  }
}

async function fetchMangaDexLink(title, chapter) {
  const searchParams = new URLSearchParams({
    title,
    limit: '5',
    'order[relevance]': 'desc',
  });
  ['safe', 'suggestive', 'erotica'].forEach(r =>
    searchParams.append('contentRating[]', r)
  );
  const searchRes = await fetch(`https://api.mangadex.org/manga?${searchParams}`);
  const searchData = await searchRes.json();
  if (!searchData.data?.length) throw new Error('No manga found');

  const normalize = s => s?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? '';
  const needle = normalize(title);
  const best =
    searchData.data.find(m => {
      const titles = Object.values(m.attributes?.title ?? {});
      return titles.some(t => normalize(t) === needle);
    }) ?? searchData.data[0];

  const mangaId = best.id;
  const chapterRes = await fetch(
    `https://api.mangadex.org/chapter?manga=${mangaId}&chapter=${chapter}&translatedLanguage[]=en&order[chapter]=asc&limit=5`
  );
  const chapterData = await chapterRes.json();

  if (chapterData.data?.length) {
    return `https://mangadex.org/chapter/${chapterData.data[0].id}`;
  }
  return `https://mangadex.org/title/${mangaId}`;
}

function App() {
  const [mappings, setMappings]             = useState(null);
  const [currentAnime, setCurrentAnime]     = useState(undefined);
  const [episodeNum, setEpisodeNum]         = useState(1);
  const [detected, setDetected]             = useState(null);
  const [mangaDexLink, setMangaDexLink]     = useState(null);
  const [loadingLink, setLoadingLink]       = useState(false);
  const [dynamicResult, setDynamicResult]   = useState(null);
  const [dynamicLoading, setDynamicLoading] = useState(false);

  // ── Mount ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.runtime.sendMessage({ type: 'INJECT', tabId: tabs[0].id }, () => {
            setTimeout(() => {
              chrome.storage.local.get(['mappings', 'mangabridge_episode'], (result) => {
                const maps = result.mappings;
                const det  = result.mangabridge_episode;
                console.log('[MangaBridge] Storage loaded:', { det, hasMaps: !!maps });

                if (maps) {
                  setMappings(maps);

                  if (det) {
                    setDetected(det);
                    const rawTitle = (det.animeTitle || '').trim();
                    const normalize = s => s?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? '';
                    const needle = normalize(rawTitle);

                    const foundKey = Object.keys(maps)
                      .filter(k => k !== 'version' && k !== 'updated_at')
                      .find(key =>
                        normalize(maps[key].title) === needle ||
                        maps[key].aliases?.some(a => normalize(a) === needle)
                      );

                    console.log('[MangaBridge] Local match:', foundKey, 'for needle:', needle);

                    if (foundKey) {
                      setCurrentAnime(foundKey);
                      setEpisodeNum(det.episodeNumber || 1);
                    } else {
                      // null = not in local DB, triggers dynamic lookup
                      setCurrentAnime(null);
                      setEpisodeNum(det.episodeNumber || 1);
                    }
                  } else {
                    const keys = Object.keys(maps).filter(k => k !== 'version' && k !== 'updated_at');
                    if (keys.length > 0) setCurrentAnime(keys[0]);
                  }
                }
              });
            }, 1000);
          });
        }
      });

      const listener = (changes) => {
        if (changes.mangabridge_episode) {
          const det = changes.mangabridge_episode.newValue;
          setDetected(det);
        }
      };
      chrome.storage.onChanged.addListener(listener);
      return () => chrome.storage.onChanged.removeListener(listener);

    } else {
      import('./data/mappings.json').then((data) => {
        setMappings(data.default);
        const keys = Object.keys(data.default).filter(k => k !== 'version' && k !== 'updated_at');
        if (keys.length > 0) setCurrentAnime(keys[0]);
      });
    }
  }, []);

  const animeData   = mappings && currentAnime ? mappings[currentAnime] : null;
  const episodeData = animeData?.seasons?.["1"]?.episodes?.[episodeNum.toString()];

  // ── MangaDex link ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (episodeData?.continue_from) {
      setLoadingLink(true);
      fetchMangaDexLink(animeData.title, episodeData.continue_from)
        .then(link => setMangaDexLink(link))
        .catch(() => setMangaDexLink(null))
        .finally(() => setLoadingLink(false));
    } else {
      setMangaDexLink(null);
    }
  }, [episodeData]);

  // ── Dynamic lookup ────────────────────────────────────────────────────────
  useEffect(() => {
    // Wait until mappings and currentAnime are resolved (not undefined)
    if (!mappings || currentAnime === undefined) return;

    // currentAnime is null = not in local DB
    // currentAnime is a string but episodeData missing = episode gap in local DB
    const needsDynamic = currentAnime === null || (!episodeData && detected);

    console.log('[MangaBridge] Dynamic check:', { currentAnime, episodeData, needsDynamic, detected });

    if (!needsDynamic) {
      setDynamicResult(null);
      return;
    }

    if (!detected) return;

    const title = (detected.animeTitle || '').trim();
    const ep    = detected.episodeNumber || episodeNum;
    if (!title) return;

    setDynamicLoading(true);
    setDynamicResult(null);

    dynamicLookup(title, ep)
      .then(result => {
        console.log('[MangaBridge] Dynamic result:', result);
        setDynamicResult(result);
      })
      .finally(() => setDynamicLoading(false));

  }, [currentAnime, episodeNum, mappings, detected, episodeData]);

  // ── Loading ───────────────────────────────────────────────────────────────
  if (!mappings) {
    return (
      <div className="w-80 h-64 bg-slate-900 flex items-center justify-center">
        <div className="animate-pulse flex flex-col items-center gap-2">
          <div className="w-12 h-12 bg-slate-700 rounded-full"/>
          <div className="h-4 w-24 bg-slate-700 rounded"/>
        </div>
      </div>
    );
  }

  const localKeys = Object.keys(mappings).filter(k => k !== 'version' && k !== 'updated_at');

  return (
    <div className="w-80 min-h-[400px] bg-slate-900 text-slate-100 p-4 font-sans select-none">

      {/* Header */}
      <header className="flex items-center justify-between mb-6 border-b border-slate-700 pb-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-lg flex items-center justify-center shadow-lg">
            <span className="text-white font-bold text-xs">MB</span>
          </div>
          <h1 className="text-xl font-bold tracking-tight">MangaBridge</h1>
        </div>
        {detected && (
          <div className="flex items-center gap-1.5 px-2 py-0.5 bg-emerald-500/10 border border-emerald-500/20 rounded-full">
            <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse"/>
            <span className="text-[10px] font-bold text-emerald-500 uppercase tracking-tighter">Live Detect</span>
          </div>
        )}
      </header>

      <main className="space-y-6">

        {/* Series dropdown */}
        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Series</label>
          <select
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
            value={currentAnime || ''}
            onChange={(e) => { setCurrentAnime(e.target.value || null); setDynamicResult(null); }}
          >
            <option value="">-- Auto Detected --</option>
            {localKeys.map(key => (
              <option key={key} value={key}>{mappings[key].title}</option>
            ))}
          </select>
        </div>

        {/* Episode input */}
        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Anime Episode</label>
          <input
            type="number"
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
            value={episodeNum}
            onChange={(e) => setEpisodeNum(Math.max(1, parseInt(e.target.value) || 1))}
          />
        </div>

        {/* Results */}
        {episodeData ? (
          <div className="bg-gradient-to-br from-slate-800 to-slate-850 border border-slate-700 rounded-xl p-4 shadow-xl">
            <div className="flex justify-between items-start mb-4">
              <div className="space-y-1">
                <span className="text-xs font-medium text-slate-400">Chapters Covered</span>
                <div className="text-2xl font-bold text-white tracking-tight">
                  {episodeData.chapters[0] === episodeData.chapters[1]
                    ? `Ch. ${episodeData.chapters[0]}`
                    : `Ch. ${episodeData.chapters[0]} – ${episodeData.chapters[1]}`}
                </div>
              </div>
              <div className="bg-indigo-500/10 text-indigo-400 p-2 rounded-lg border border-indigo-500/20">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M9 4.804A7.905 7.905 0 002 8c0 2.502 1.153 4.736 3.162 6.187A3.335 3.335 0 005 15.193V17a1 1 0 001.555.832L9 15.555V4.804zM11 4.804v10.751l2.445 2.277A1 1 0 0015 17v-1.807a3.335 3.335 0 00-.162-.988C16.847 12.736 18 10.502 18 8a7.905 7.905 0 00-7-3.196z" />
                </svg>
              </div>
            </div>
            <div className="space-y-3 pt-3 border-t border-slate-700/50">
              <div className="flex justify-between items-center">
                <span className="text-xs text-slate-400">Read Next</span>
                {loadingLink ? (
                  <span className="text-[10px] animate-pulse text-slate-500">Fetching MangaDex...</span>
                ) : mangaDexLink ? (
                  <a href={mangaDexLink} target="_blank" rel="noreferrer" className="text-xs font-bold text-emerald-400 bg-emerald-400/10 px-2 py-1 rounded border border-emerald-400/20 hover:bg-emerald-400/20 transition-colors">
                    Read Ch. {episodeData.continue_from} →
                  </a>
                ) : (
                  <span className="text-xs font-bold text-slate-400 italic">Ch. {episodeData.continue_from}</span>
                )}
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs text-slate-400">Type</span>
                <span className={`text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded border ${
                  episodeData.filler_type === 'canon'
                    ? 'text-indigo-400 bg-indigo-400/10 border-indigo-400/20'
                    : 'text-orange-400 bg-orange-400/10 border-orange-400/20'
                }`}>
                  {episodeData.filler_type}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs text-slate-400">Source</span>
                <span className={`text-[10px] font-bold ${SOURCE_LABELS[episodeData.source]?.color || 'text-slate-400'}`}>
                  ✦ {SOURCE_LABELS[episodeData.source]?.label || episodeData.source || 'Unknown'}
                </span>
              </div>
            </div>
            {episodeData.notes?.length > 0 && (
              <div className="mt-4 pt-3 border-t border-slate-700/50">
                <p className="text-[10px] text-slate-500 italic leading-relaxed">
                  {episodeData.notes.join('. ')}
                </p>
              </div>
            )}
          </div>

        ) : dynamicLoading ? (
          <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-6 flex flex-col items-center gap-3">
            <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin"/>
            <p className="text-xs text-slate-400">Looking up on AniList...</p>
          </div>

        ) : dynamicResult?.episodeData ? (
          <div className="bg-gradient-to-br from-slate-800 to-slate-850 border border-amber-700/40 rounded-xl p-4 shadow-xl">
            <div className="flex justify-between items-start mb-4">
              <div className="space-y-1">
                <span className="text-xs font-medium text-slate-400">Chapters Covered</span>
                <div className="text-2xl font-bold text-white tracking-tight">
                  {`Ch. ${dynamicResult.episodeData.chapters[0]} – ${dynamicResult.episodeData.chapters[1]}`}
                </div>
              </div>
              <span className="text-[10px] font-bold text-amber-400 bg-amber-400/10 px-2 py-1 rounded border border-amber-400/20">
                ~ Estimated
              </span>
            </div>
            <div className="space-y-3 pt-3 border-t border-slate-700/50">
              <div className="flex justify-between items-center">
                <span className="text-xs text-slate-400">Read Next</span>
                <span className="text-xs font-bold text-slate-300">Ch. {dynamicResult.episodeData.continue_from}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs text-slate-400">Manga</span>
                <span className="text-xs text-slate-300">{dynamicResult.mangaTitle || 'Unknown'}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs text-slate-400">Detected</span>
                <span className="text-xs text-slate-300">{dynamicResult.animeTitle}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs text-slate-400">Filler Status</span>
                <span className="text-[10px] font-bold text-slate-500 italic">Unknown for estimated</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs text-slate-400">Type</span>
                <span className="text-[10px] font-bold text-slate-500 italic">May include filler</span>
              </div>
            </div>
            {dynamicResult.episodeData.notes?.length > 0 && (
              <div className="mt-3 pt-3 border-t border-slate-700/50">
                <p className="text-[10px] text-amber-500/70 italic leading-relaxed">
                  ⚠ {dynamicResult.episodeData.notes[0]}
                </p>
              </div>
            )}
          </div>

        ) : (
          <div className="bg-slate-800/50 border border-dashed border-slate-700 rounded-xl p-8 flex flex-col items-center justify-center text-center space-y-2">
            <p className="text-sm text-slate-500 font-medium">No mapping found for episode {episodeNum}</p>
            <p className="text-xs text-slate-600">Not in local DB and AniList lookup failed</p>
          </div>
        )}
      </main>

      <footer className="mt-8 pt-4 border-t border-slate-800 flex justify-center">
        <p className="text-[10px] text-slate-600 font-medium tracking-tight">
          Synced from GitHub • {new Date().toLocaleDateString()}
        </p>
      </footer>
    </div>
  );
}

export default App;