/**
 * GMaps Scraper - Content Script
 * Runs on Google Maps pages.
 * Handles auto-scroll, DOM extraction, and message passing to background.
 * Guard against double-injection (programmatic re-inject on already-open tabs).
 */

// Bump the version when behaviour changes; background.js checks it via GET_STATUS so a
// tab still running an older copy of this script is detected instead of silently used.
if (window.__gmapsScraper === 3) {
  console.log('[GMaps Scraper] Content script already loaded, skipping re-init.');
} else {
const SCRAPER_VERSION = 3;
window.__gmapsScraper = SCRAPER_VERSION;

let isScrapingActive = false;
let scrapedResults = [];
let observedIds = new Set();
let scrollInterval = null;

// ─────────────────────────────────────────
// SELECTORS (Google Maps DOM as of 2024-25)
// Update these if Google changes their DOM.
// ─────────────────────────────────────────
const SELECTORS = {
  resultsPanel:   'div[role="feed"]',
  listingItem:    'div.Nv2PK',           // each result card
  name:           '.qBF1Pd',             // business name
  rating:         '.MW4etd',             // star rating number
  reviewCount:    '.UY7F9',              // "(123)"
  category:       '.W4Efsd:first-child', // business type
  address:        '.W4Efsd .W4Efsd',     // address line
  phone:          '.UsdlK, [data-tooltip="Copier le numéro de téléphone"], [data-tooltip="Copy phone number"]',
  website:        'a[data-value="Website"], a[data-tooltip="Open website"]',
  hours:          '.W4Efsd span[aria-label]',
};

// ─────────────────────────────────────────
// EXTRACTION
// ─────────────────────────────────────────
function extractListing(card) {
  const getText = (sel) => card.querySelector(sel)?.textContent?.trim() || null;
  const getAttr = (sel, attr) => card.querySelector(sel)?.getAttribute(attr) || null;

  const name       = getText(SELECTORS.name);
  if (!name) return null; // skip ghost / ad cards

  const rating     = getText(SELECTORS.rating);
  const rawReviews = getText(SELECTORS.reviewCount);
  const reviewCount = rawReviews ? rawReviews.replace(/[()]/g, '').trim() : null;

  // Google (2026 DOM) nests category/address/hours/phone inside two "leaf" .W4Efsd
  // divs (no .W4Efsd children of their own), each a "·"-joined line — the old flat
  // infoSpans[0]/[1] indexing no longer isolates these correctly, so pattern-match
  // the leaf lines instead of relying on fixed positions.
  const leafTexts = [...card.querySelectorAll('.W4Efsd')]
    .filter(d => d.querySelectorAll('.W4Efsd').length === 0)
    .map(d => d.textContent.trim())
    .filter(Boolean);

  const hoursLine = leafTexts.find(t => /ouvre|ouvert|ferm|open|closed|24h/i.test(t)) || null;
  const catAddrLine = leafTexts.find(t => t !== hoursLine && !/^\d/.test(t)) || null;

  let category = null, address = null;
  if (catAddrLine) {
    const parts = catAddrLine.split('·').map(s => s.trim()).filter(Boolean);
    category = parts[0] || null;
    address  = parts.length > 1 ? parts[parts.length - 1] : null;
  }

  // Phone: dedicated class when shown on the card face, falls back to the old
  // tooltip-based selector, then a regex over the hours line as a last resort.
  const phone = card.querySelector(SELECTORS.phone)?.textContent?.trim()
    || getText(SELECTORS.phone)
    || (hoursLine && hoursLine.match(/(\+?\d[\d\s\-().]{6,}\d)/)?.[1])
    || null;

  const website = getAttr(SELECTORS.website, 'href') || null;

  const { placeId, mapsUrl } = extractPlaceInfo(card);
  const businessStatus = detectBusinessStatus(hoursLine);

  // Unique ID: prefer the stable Google place ID, fallback to name+address hash
  const uid = placeId || btoa(encodeURIComponent(`${name}||${address}`)).slice(0, 20);

  return {
    uid, name, rating, reviewCount, category, address, phone, website, hours: hoursLine,
    placeId, mapsUrl, businessStatus,
    hasPhone: !!phone, hasWebsite: !!website,
  };
}

// Card link (a.hfpxzc) href looks like:
//   https://www.google.com/maps/place/NAME/@lat,lng,z/data=!4m...!1s0xHEX:0xHEX!8m2!...
// The "!1s0xHEX:0xHEX" segment is Google's stable place ID (feature ID).
function extractPlaceInfo(card) {
  const link = card.querySelector('a.hfpxzc') || card.querySelector('a[href*="/maps/place/"]');
  const href = link?.getAttribute('href') || null;
  if (!href) return { placeId: null, mapsUrl: null };

  const mapsUrl = href.startsWith('http') ? href : `https://www.google.com${href}`;
  const match = mapsUrl.match(/!1s(0x[0-9a-fA-F]+:0x[0-9a-fA-F]+)/);
  return { placeId: match ? match[1] : null, mapsUrl };
}

function detectBusinessStatus(hoursLine) {
  if (!hoursLine) return null; // couldn't determine
  if (/ferm[ée]\s*définitivement|permanently closed/i.test(hoursLine)) return 'permanently_closed';
  if (/temporairement ferm|temporarily closed/i.test(hoursLine)) return 'temporarily_closed';
  return 'open';
}

function scrapeVisibleListings() {
  const feed = document.querySelector(SELECTORS.resultsPanel);
  if (!feed) return [];

  const cards = [...feed.querySelectorAll(SELECTORS.listingItem)];
  const fresh = [];

  cards.forEach(card => {
    const data = extractListing(card);
    if (data && !observedIds.has(data.uid)) {
      observedIds.add(data.uid);
      scrapedResults.push(data);
      fresh.push(data);
    }
  });

  return fresh;
}

// ─────────────────────────────────────────
// AUTO-SCROLL ENGINE
// ─────────────────────────────────────────
function getScrollablePanel() {
  return document.querySelector(SELECTORS.resultsPanel);
}

function isAtBottom(el) {
  return Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight) < 50;
}

function startAutoScroll(onBatch, onDone, maxResults) {
  const panel = getScrollablePanel();
  if (!panel) {
    onDone('Panel not found. Make sure you have search results visible.');
    return;
  }

  let stableCount = 0;
  // Stop only after this many consecutive ticks (~1.2s each) with no new cards. Being
  // "at the bottom" is NOT a stop signal: the first page is short and more cards
  // lazy-load only after we scroll, so the bottom is reached long before the end.
  const MAX_STABLE = 7;
  let lastCount = 0;

  scrollInterval = setInterval(() => {
    if (!isScrapingActive) {
      clearInterval(scrollInterval);
      onDone(null);
      return;
    }

    // Scrape what's now visible
    const fresh = scrapeVisibleListings();
    if (fresh.length > 0) {
      onBatch(fresh);
      stableCount = 0;
    }

    // Stop once we've hit the requested cap, trimming any overshoot from this batch
    if (maxResults && scrapedResults.length >= maxResults) {
      scrapedResults.length = maxResults;
      clearInterval(scrollInterval);
      onDone(null);
      return;
    }

    // Scroll down (jump to the very bottom when there, which is what triggers lazy-load)
    if (isAtBottom(panel)) panel.scrollTop = panel.scrollHeight;
    else panel.scrollBy({ top: 600, behavior: 'smooth' });

    // Check if we're stuck (no new results + at bottom)
    if (scrapedResults.length === lastCount) {
      stableCount++;
    } else {
      stableCount = 0;
    }
    lastCount = scrapedResults.length;

    if (stableCount >= MAX_STABLE) {
      clearInterval(scrollInterval);
      onDone(null);
    }
  }, 1200); // 1.2s between scrolls to allow lazy-load
}

// ─────────────────────────────────────────
// MESSAGE BRIDGE (Popup ↔ Content Script)
// ─────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'START_SCRAPE') {
    if (isScrapingActive) {
      sendResponse({ ok: false, error: 'Already running' });
      return;
    }

    isScrapingActive = true;
    scrapedResults   = [];
    observedIds      = new Set();

    const maxResults = Number(msg.maxResults) > 0 ? Number(msg.maxResults) : null;

    startAutoScroll(
      (batch) => {
        // Send progress batches to background → popup
        chrome.runtime.sendMessage({
          action: 'SCRAPE_PROGRESS',
          count: scrapedResults.length,
          batch,
        });
      },
      (err) => {
        // User pressed Stop: the STOP handler already reported the results.
        if (!isScrapingActive) return;
        isScrapingActive = false;
        // The background script now opens each listing in its own tab to read the phone
        // number / website (they are not on the result cards), then uploads everything.
        chrome.runtime.sendMessage({
          action: err ? 'SCRAPE_DONE' : 'SCRAPE_LIST_DONE',
          total: scrapedResults.length,
          data: scrapedResults,
          error: err,
        });
      },
      maxResults
    );

    sendResponse({ ok: true });
  }

  if (msg.action === 'STOP_SCRAPE') {
    const wasActive = isScrapingActive;
    isScrapingActive = false;
    clearInterval(scrollInterval);
    if (wasActive) chrome.runtime.sendMessage({
      action: 'SCRAPE_DONE',
      total: scrapedResults.length,
      data: scrapedResults,
      error: null,
      stopped: true,
    });
    sendResponse({ ok: true });
  }

  if (msg.action === 'GET_STATUS') {
    sendResponse({ active: isScrapingActive, count: scrapedResults.length, version: SCRAPER_VERSION });
  }

  return true; // keep channel open for async
});

} // end if(!window.__gmapsScraper)