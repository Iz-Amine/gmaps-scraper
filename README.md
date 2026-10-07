# 🗺 GMaps Scraper

A cross-browser extension (Chrome / Edge / Firefox) that scrapes Google Maps search results and sends them to a local Node.js API with SQLite storage.

---

## Project Structure

```
gmaps-scraper/
├── extension/          ← Browser extension (WebExtension MV3)
│   ├── manifest.json
│   ├── content_script.js   ← DOM scraper + auto-scroll engine
│   ├── background.js       ← Service worker, API caller
│   ├── popup.html          ← Extension UI
│   └── popup.js
│
└── backend/            ← Node.js + Express + SQLite API
    ├── server.js
    ├── db/index.js         ← SQLite schema init
    ├── routes/listings.js  ← All API routes
    ├── .env.example
    └── package.json
```

---

## Quick Start

### 1. Backend

```bash
cd backend
cp .env.example .env   # optionally set API_KEY and PORT
npm install
npm start
# API runs at http://localhost:3000
```

### 2. Extension — Chrome / Edge

1. Go to `chrome://extensions` (or `edge://extensions`)
2. Enable **Developer Mode**
3. Click **Load unpacked**
4. Select the `extension/` folder

### 3. Extension — Firefox

1. Go to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Select `extension/manifest.json`

> **Firefox note:** Firefox supports MV3 but has minor differences. If you encounter issues, rename `manifest.json` to `manifest_v3.json` and create a `manifest.json` that uses MV2 with `background.scripts` instead of `service_worker`.

### 4. Configure the Extension

1. Click the extension icon
2. Click ⚙ Settings
3. Enter your API URL: `http://localhost:3000/api/listings`
4. (Optional) Enter an API Key if you set one in `.env`
5. Enter a Project/Campaign name (e.g. `avocats-kenitra`)
6. Save

---

## Usage

1. Go to **Google Maps** and search for anything (e.g. "avocat Kénitra")
2. Click the extension icon
3. Click **▶ Start Scraping**
4. The extension will auto-scroll through all results and collect data
5. When done, data is automatically POSTed to your API

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/listings` | Receive a scrape session |
| `GET` | `/api/listings` | Query listings (supports `?project=`, `?search=`, `?limit=`, `?offset=`) |
| `GET` | `/api/listings/export` | Download CSV |
| `GET` | `/api/sessions` | List all scrape sessions |
| `DELETE` | `/api/sessions/:id` | Delete a session |
| `GET` | `/health` | Health check |

### Example POST body

```json
{
  "project": "avocats-kenitra",
  "source": "google_maps",
  "scraped_at": "2025-01-01T10:00:00Z",
  "count": 42,
  "listings": [
    {
      "uid": "abc123",
      "name": "Cabinet Maître Arroub",
      "category": "Avocat",
      "rating": "5.0",
      "reviewCount": "44",
      "address": "7C33+JHJ, Av. Said Daoudi",
      "phone": "06 13 43 43 37",
      "website": null,
      "hours": "Ouvre à 09:00 lun."
    }
  ]
}
```

---

## Data Extracted Per Listing

| Field | Example |
|-------|---------|
| `name` | Cabinet Maître Arroub |
| `category` | Avocat |
| `rating` | 5.0 |
| `reviewCount` | 44 |
| `address` | Av. Said Daoudi, Kénitra |
| `phone` | 06 13 43 43 37 |
| `website` | https://example.com |
| `hours` | Ouvre à 09:00 lun. |

---

## Architecture

```
  [Google Maps Page]
        │
        │  DOM scraping + MutationObserver scroll loop
        ▼
  [content_script.js]
        │
        │  chrome.runtime.sendMessage (batches)
        ▼
  [background.js (service worker)]
        │
        │  fetch() POST
        ▼
  [Express API :3000]
        │
        │  better-sqlite3 transaction
        ▼
  [SQLite DB  data/scraper.db]
```

---

## Notes & Limitations

- Google Maps **does not have a public API** for this data — selectors may change when Google updates their UI. If scraping breaks, inspect the page and update `SELECTORS` in `content_script.js`.
- Auto-scroll captures up to ~200 results per search (Google Maps limit).
- The extension must be used with care and in compliance with Google's Terms of Service.
