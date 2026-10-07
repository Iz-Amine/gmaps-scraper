# 🗺 GMaps Scraper

A Chrome (Manifest V3) extension that scrapes business listings straight out of Google Maps search results and saves them into a local database you control.

## What it does

You search Google Maps for something (e.g. "avocat Kénitra"), click **Start Scraping** in the extension popup, and it auto-scrolls through the results panel, pulling out each listing's name, category, rating, review count, address, phone, website, and opening hours as they render. When the list is exhausted, the extension batches everything up and POSTs it to a small local API, which stores it in SQLite under a project/campaign name you choose.

## What it's for

Google Maps has no public API for browsing business listings by search query. This tool is for lead generation, local-market research, and building contact lists (lawyers in a city, restaurants in a district, etc.) without manually copying data out of the map UI. Results are organized per "project" so you can run many searches (different cities, niches, campaigns) and keep them separate, then query or export them as CSV.

## How it works

1. **`content_script.js`** runs on `google.com/maps/*` pages. It reads the DOM of the results panel, extracts each listing's fields using CSS selectors, and uses a scroll-and-observe loop (`MutationObserver`) to keep loading more results until Google Maps stops returning new ones.
2. **`background.js`** (the extension's service worker) receives the scraped batches from the content script and `fetch()`-POSTs them to the backend API, using the URL/API key/project name you configured in the popup settings.
3. **The Express API** (`backend/`) validates the payload, opens a SQLite transaction (`better-sqlite3`), and upserts the listings, tagged with the project name and session they belong to.
4. From there you can query listings, filter by project, search, or download everything as a CSV straight from the API.

---

## Project Structure

```
gmaps-scraper/
├── extension/          ← Chrome extension (Manifest V3)
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

### 3. Configure the Extension

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
