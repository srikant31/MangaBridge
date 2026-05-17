(function () {
  'use strict';
  window.mangabridgeLoaded = true;
  console.log('[MangaBridge] Content script running on:', location.href);

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Strip well-known streaming-site suffixes so the parser sees only the
   * meaningful "Anime Title – Episode NN" part.
   *
   * Examples that get cleaned:
   *   "Jujutsu Kaisen · Episode 12 | HiAnime"  → "Jujutsu Kaisen · Episode 12"
   *   "Watch Chainsaw Man Ep 3 - Crunchyroll"   → "Watch Chainsaw Man Ep 3"
   *   "Demon Slayer Episode 5 – AnimePahe"      → "Demon Slayer Episode 5"
   */
  const SITE_SUFFIX_RE = /\s*[|–—-]\s*(hianime|crunchyroll|animepahe|funimation|zoro|aniwatch|9anime|kickassanime|gogoanime|anime[a-z]*)\b.*/i;

  function cleanStreamingTitle(raw) {
    if (!raw) return raw;
    // Remove leading "Watch " verb (common on many sites)
    return raw
      .replace(/^watch\s+/i, '')
      .replace(SITE_SUFFIX_RE, '')
      .trim();
  }

  // ── Extractors ───────────────────────────────────────────────────────────

  function fromJsonLd() {
    // Many sites embed structured JSON-LD data
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const s of scripts) {
      try {
        const data = JSON.parse(s.textContent);
        const name = data.name || data.partOfSeries?.name;
        const ep = data.episodeNumber;
        if (name && ep) return {
          animeTitle: name.trim(),
          episodeNumber: parseInt(ep)
        };
      } catch { continue; }
    }
    return null;
  }

  function fromOgTags() {
    // og:title is on virtually every streaming site
    const og = document.querySelector('meta[property="og:title"]')?.content
      || document.querySelector('meta[name="twitter:title"]')?.content;
    if (!og) return null;
    return parseText(cleanStreamingTitle(og));
  }

  function fromDocumentTitle() {
    return parseText(cleanStreamingTitle(document.title));
  }

  function fromUrl() {
    // Parse URL slugs like /watch/jujutsu-kaisen-episode-12
    // or /anime/jujutsu-kaisen/ep-12
    const path = location.pathname + location.search;

    const epMatch = path.match(
      /[_\-/]ep(?:isode)?[_\-]?(\d+)|[_\-/]e(\d+)(?:[_\-/]|$)|\?ep=(\d+)/i
    );
    const epNum = epMatch
      ? parseInt(epMatch[1] || epMatch[2] || epMatch[3])
      : null;

    // Strip episode part and clean up slug for anime title
    const slug = path
      .split('?')[0]
      .replace(/\/(watch|anime|series|show|play|stream)\//i, '/')
      .replace(/[-_/]ep(isode)?[-_]?\d+.*/i, '')
      .replace(/[-_/]\d+$/, '')
      .split('/')
      .filter(Boolean)
      .pop() || '';

    const animeTitle = slug
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase())
      .trim();

    return epNum && animeTitle
      ? { animeTitle, episodeNumber: epNum }
      : null;
  }

  function fromPageContent() {
    // Scan visible headings / title elements on the page
    const selectors = [
      // Generic
      'h1', 'h2',
      '[class*="title"]',
      '[class*="anime-name"]',
      '[class*="film-name"]',
      '[class*="series-title"]',
      '[class*="show-title"]',
      // HiAnime / Zoro-style players
      '.film-name.dynamic-name',
      '.film-name',
      '.detail-title',
      // Crunchyroll
      '[class*="erc-title"]',
      // Generic video player overlays
      '[class*="episode-title"]',
      '[class*="ep-title"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const result = parseText(cleanStreamingTitle(el.textContent));
      if (result) return result;
    }
    return null;
  }

  // ── Core text parser — finds anime name + episode number in any string ────

  function parseText(text) {
    if (!text) return null;
    text = text.trim();

    // Match episode number — covers all common formats:
    // "Episode 12", "Ep 12", "EP12", "E12", "#12", "- 12 -"
    const epPatterns = [
      /\bepisode\s*(\d+)/i,
      /\bep\.?\s*(\d+)/i,
      /\be(\d+)\b/i,
      /#(\d+)/,
      /\s[-–—]\s*(\d+)\s*[-–—]/,
      /\s(\d+)\s*[-|]/,
    ];

    let episodeNumber = null;
    let matchIndex = -1;
    let matchLength = 0;

    for (const pattern of epPatterns) {
      const m = text.match(pattern);
      if (m) {
        episodeNumber = parseInt(m[1]);
        matchIndex = text.indexOf(m[0]);
        matchLength = m[0].length;
        break;
      }
    }

    if (!episodeNumber) return null;
    if (episodeNumber > 2000) return null; // sanity check

    // Extract anime title — everything before the episode match,
    // cleaned of separators
    let animeTitle = text
      .substring(0, matchIndex)
      .replace(/[-–—|:]\s*$/, '')  // trailing separators
      .replace(/\s+/g, ' ')
      .trim();

    // If title is too short, try taking text after separators
    if (animeTitle.length < 3) {
      const parts = text.split(/[-–—|:]/);
      for (const part of parts) {
        const cleaned = part.replace(/episode\s*\d+/i, '').trim();
        if (cleaned.length > 3) { animeTitle = cleaned; break; }
      }
    }

    if (!animeTitle || animeTitle.length < 2) return null;

    return { animeTitle, episodeNumber };
  }

  // ── Season detection ──────────────────────────────────────────────────────

  function detectSeason(text) {
    const m = (text || document.title).match(/season\s*(\d+)|s(\d+)/i);
    return m ? parseInt(m[1] || m[2]) : 1;
  }

  // ── Main — waterfall through extractors ──────────────────────────────────

  function detect() {
    const sources = [
      { name: 'jsonld',   fn: fromJsonLd        },
      { name: 'og_tag',   fn: fromOgTags        },
      { name: 'url',      fn: fromUrl           },
      { name: 'title',    fn: fromDocumentTitle },
      { name: 'content',  fn: fromPageContent   },
    ];

    for (const source of sources) {
      const result = source.fn();
      if (result?.animeTitle && result?.episodeNumber) {
        return {
          animeTitle:    result.animeTitle,
          episodeNumber: result.episodeNumber,
          season:        detectSeason(),
          site:          location.hostname,
          source:        source.name,
        };
      }
    }
    return null;
  }

  // ── Storage + listeners ───────────────────────────────────────────────────

  function save(data) {
    if (!data) return;
    chrome.storage.local.set({
      mangabridge_episode: data,
      mangabridge_ts: Date.now()
    });
    console.log('[MangaBridge] Detected:', data);
  }

  setTimeout(() => save(detect()), 2000);

  // SPA navigation — re-detect when URL changes
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(() => save(detect()), 2500);
    }
  }).observe(document.body, { childList: true, subtree: true });

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg.type === 'PING_DETECT') respond(detect());
    return true;
  });

})();