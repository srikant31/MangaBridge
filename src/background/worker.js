const MAPPINGS_URL =
  "https://raw.githubusercontent.com/srikant31/mangabridge/main/src/data/mappings.json"

async function syncMappings() {
  try {
    const res = await fetch(MAPPINGS_URL)
    if (!res.ok) return
    const data = await res.json()
    await chrome.storage.local.set({
      mappings: data,
      synced_at: Date.now()
    })
    console.log("[MangaBridge] Mappings synced")
  } catch (e) {
    console.warn("[MangaBridge] Sync failed, using cached data")
  }
}

// Sync on install
chrome.runtime.onInstalled.addListener(syncMappings)

// Sync every 24 hours
chrome.alarms.create("sync", { periodInMinutes: 1440 })
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "sync") syncMappings()
})

// Inject content script manually into any tab when popup opens
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg.type === 'INJECT') {
    chrome.scripting.executeScript({
      target: { tabId: msg.tabId },
      files: ['content/detector.js']
    }).then(() => respond({ ok: true }))
      .catch(e => respond({ ok: false, error: e.message }));
    return true;
  }
});
