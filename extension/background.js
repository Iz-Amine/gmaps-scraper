/**
 * GMaps Scraper - Background Service Worker
 * Relays messages between content_script ↔ popup,
 * and handles the actual HTTP POST to the backend API.
 */

// ─────────────────────────────────────────
// STATE
// ─────────────────────────────────────────
let popupPort = null; // live connection to popup if open
let stopRequested = false; // set by TRIGGER_STOP, checked between detail reads
let enriching = false;
const REQUIRED_CONTENT_VERSION = 3; // must match SCRAPER_VERSION in content_script.js

// ─────────────────────────────────────────
// POPUP PORT (long-lived connection for progress updates)
// ─────────────────────────────────────────
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'popup') {
    popupPort = port;
    port.onDisconnect.addListener(() => { popupPort = null; });
  }
});

function notifyPopup(msg) {
  if (popupPort) {
    try { popupPort.postMessage(msg); } catch (_) {}
  }
}

// ─────────────────────────────────────────
// MESSAGE ROUTER
// ─────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  // Progress update from content_script → forward to popup
  if (msg.action === 'SCRAPE_PROGRESS') {
    notifyPopup(msg);
    return;
  }

  // Result list fully scrolled → read phone/website of every listing, then finish
  if (msg.action === 'SCRAPE_LIST_DONE') {
    stopRequested = false;
    enriching = true;
    enrichListings(msg.data, (done, total) => {
      notifyPopup({ action: 'SCRAPE_PROGRESS', count: total, batch: [], message: `Reading details ${done}/${total}…` });
    }).then(() => {
      enriching = false;
      finishScrape({ ...msg, stopped: stopRequested });
    });
    return;
  }

  // Scraping done → send data to API
  if (msg.action === 'SCRAPE_DONE') {
    finishScrape(msg);
    return;
  }

  // Popup asking background to trigger scrape on active tab
  if (msg.action === 'TRIGGER_SCRAPE') {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (!tab || !tab.url?.includes('google.com/maps')) {
        sendResponse({ ok: false, error: 'Not on Google Maps' });
        return;
      }

      // ── KEY FIX ──────────────────────────────────────────────────
      // Always inject the content script programmatically.
      // This handles the case where the tab was open before the
      // extension was installed/reloaded (MV3 content scripts only
      // auto-inject on fresh page loads).
      // ─────────────────────────────────────────────────────────────
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files:  ['content_script.js'],
        });
      } catch (e) {
        // Script may already be injected — that's fine, ignore the error.
        // e.g. "Cannot access a chrome:// URL" only matters for non-Maps pages.
      }

      // Small delay to let the injected script register its message listener
      setTimeout(() => {
        // A tab opened before the extension was updated keeps running the OLD content
        // script (it can't be replaced in place), which would scrape without phone/website.
        chrome.tabs.sendMessage(tab.id, { action: 'GET_STATUS' }, (status) => {
          if (chrome.runtime.lastError || !status || status.version !== REQUIRED_CONTENT_VERSION) {
            sendResponse({ ok: false, error: 'This Maps tab runs an outdated scraper script. Refresh the page (F5) and try again.' });
            return;
          }
          chrome.tabs.sendMessage(tab.id, { action: 'START_SCRAPE', maxResults: msg.maxResults }, (resp) => {
            if (chrome.runtime.lastError) {
              sendResponse({ ok: false, error: chrome.runtime.lastError.message });
            } else {
              sendResponse(resp || { ok: false, error: 'No response from content script' });
            }
          });
        });
      }, 300);
    });
    return true;
  }

  if (msg.action === 'TRIGGER_STOP') {
    stopRequested = true; // also ends a detail-reading phase (data read so far is kept)
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'STOP_SCRAPE' });
      }
    });
    return;
  }

  return true;
});

function finishScrape(msg) {
  notifyPopup({ ...msg, action: 'SCRAPE_DONE' });

  if (msg.data && msg.data.length > 0) {
    // Load API config from storage then POST
    chrome.storage.local.get(['apiUrl', 'apiKey', 'projectName'], (cfg) => {
      postToApi(msg.data, cfg).then((result) => {
        notifyPopup({ action: 'API_RESULT', ...result });
      });
    });
  }
}

// ─────────────────────────────────────────
// DETAIL READING
// Phone number / website / plus code are not on the result cards, only on the place's
// own page. Each listing is opened in a background tab (its card URL), read, and closed.
// This avoids clicking through the results list, which Maps rebuilds from scratch
// (6 cards at a time) every time you navigate back.
// ─────────────────────────────────────────
const DETAIL_CONCURRENCY = 3;
const DETAIL_TIMEOUT_MS = 25000;

// Runs INSIDE the place page (must be self-contained). Returns null until the panel is loaded.
function readPlacePage() {
  if (!document.querySelector('h1.DUwDvf')) return null;
  if (!document.querySelector('button[data-item-id="address"], button[data-item-id^="phone"], a[data-item-id="authority"], button[data-item-id="oloc"]')) return null;

  const labelValue = (el) => {
    const label = el?.getAttribute('aria-label') || el?.textContent || '';
    return label.replace(/^[^:：]*[:：]\s*/, '').trim() || null;
  };
  const phoneBtn = document.querySelector('button[data-item-id^="phone:tel:"]');
  return {
    phone:    phoneBtn ? (phoneBtn.getAttribute('data-item-id').replace('phone:tel:', '').trim() || labelValue(phoneBtn)) : null,
    website:  document.querySelector('a[data-item-id="authority"]')?.getAttribute('href') || null,
    address:  labelValue(document.querySelector('button[data-item-id="address"]')),
    plusCode: labelValue(document.querySelector('button[data-item-id="oloc"]')),
  };
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function readListingDetails(listing) {
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url: listing.mapsUrl, active: false });
    tabId = tab.id;
    const end = Date.now() + DETAIL_TIMEOUT_MS;
    while (Date.now() < end) {
      await wait(800);
      try {
        const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: readPlacePage });
        if (res?.result) return res.result;
      } catch (_) { /* page still loading / navigating — retry */ }
    }
    return null;
  } catch (e) {
    return null;
  } finally {
    if (tabId !== null) { try { await chrome.tabs.remove(tabId); } catch (_) {} }
  }
}

async function enrichListings(listings, onProgress) {
  let next = 0, done = 0;
  const worker = async () => {
    while (!stopRequested && next < listings.length) {
      const listing = listings[next++];
      if (listing.mapsUrl) {
        const d = await readListingDetails(listing);
        if (d) {
          if (d.phone)    listing.phone = d.phone;
          if (d.website)  listing.website = d.website;
          if (d.address)  listing.address = d.address;
          if (d.plusCode) listing.plusCode = d.plusCode;
        } else {
          listing.detailsError = true; // page never loaded; phone/website unknown, not "absent"
        }
      }
      listing.hasPhone = !!listing.phone;
      listing.hasWebsite = !!listing.website;
      onProgress(++done, listings.length);
    }
  };
  await Promise.all(Array.from({ length: DETAIL_CONCURRENCY }, worker));
}

// ─────────────────────────────────────────
// API CALL
// ─────────────────────────────────────────
async function postToApi(data, cfg) {
  const url = cfg.apiUrl || 'http://localhost:3000/api/listings';

  const body = {
    project:  cfg.projectName || 'default',
    scraped_at: new Date().toISOString(),
    source: 'google_maps',
    count: data.length,
    listings: data,
  };

  const headers = {
    'Content-Type': 'application/json',
  };
  if (cfg.apiKey) {
    headers['X-API-Key'] = cfg.apiKey;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      return { ok: false, status: res.status, error: text };
    }

    const json = await res.json();
    return { ok: true, status: res.status, response: json };

  } catch (err) {
    return { ok: false, error: err.message };
  }
}