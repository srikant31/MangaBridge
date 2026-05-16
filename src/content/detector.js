const CRUNCHYROLL_SELECTORS = {
  title: 'h4.show-title, .show-title-link, [data-test="show-title"]',
  episode: 'h1.title, [data-test="episode-title"]'
};

function detectAnime() {
  const isCrunchyroll = window.location.hostname.includes('crunchyroll.com');
  if (!isCrunchyroll) return;

  const titleEl = document.querySelector(CRUNCHYROLL_SELECTORS.title);
  const epEl = document.querySelector(CRUNCHYROLL_SELECTORS.episode);

  if (titleEl && epEl) {
    const title = titleEl.innerText.trim();
    const epMatch = epEl.innerText.match(/E(\d+)/i) || epEl.innerText.match(/Episode\s+(\d+)/i);
    const episode = epMatch ? parseInt(epMatch[1]) : null;

    if (title && episode) {
      console.log(`[MangaBridge] Detected: ${title} Ep ${episode}`);
      chrome.storage.local.set({
        detected: {
          title,
          episode,
          timestamp: Date.now()
        }
      });
    }
  }
}

// Handle SPA navigation
let lastUrl = location.href;
const observer = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    setTimeout(detectAnime, 2000); // Wait for DOM to settle
  }
});

observer.observe(document, { subtree: true, childList: true });
detectAnime();

