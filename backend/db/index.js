/**
 * db/index.js
 * SQLite database initialiser using better-sqlite3.
 * Creates tables on first run, exports the db instance.
 */

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'scraper.db'));

// Enable WAL for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ─────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project      TEXT    NOT NULL DEFAULT 'default',
    source       TEXT    NOT NULL DEFAULT 'google_maps',
    scraped_at   TEXT    NOT NULL,
    listing_count INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS listings (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    uid          TEXT,
    name         TEXT,
    category     TEXT,
    rating       TEXT,
    review_count TEXT,
    address      TEXT,
    phone        TEXT,
    website      TEXT,
    hours        TEXT,
    place_id        TEXT,
    google_maps_url TEXT,
    business_status TEXT,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(session_id, uid)
  );

  CREATE INDEX IF NOT EXISTS idx_listings_session ON listings(session_id);
  CREATE INDEX IF NOT EXISTS idx_listings_name    ON listings(name);
  CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
`);

// ── Migration: add new columns to pre-existing DBs ──────────────────
const existingColumns = new Set(db.prepare(`PRAGMA table_info(listings)`).all().map(c => c.name));
for (const [name, def] of Object.entries({
  place_id:        'TEXT',
  google_maps_url: 'TEXT',
  business_status: 'TEXT',
  plus_code:       'TEXT',
  has_phone:       'INTEGER NOT NULL DEFAULT 0',
  has_website:     'INTEGER NOT NULL DEFAULT 0',
})) {
  if (!existingColumns.has(name)) {
    db.exec(`ALTER TABLE listings ADD COLUMN ${name} ${def}`);
  }
}

// Backfill the booleans for rows saved before these columns existed.
db.exec(`
  UPDATE listings SET
    has_phone   = CASE WHEN phone   IS NOT NULL AND phone   != '' THEN 1 ELSE 0 END,
    has_website = CASE WHEN website IS NOT NULL AND website != '' THEN 1 ELSE 0 END
`);

// ── Repair: a restart-timing gap during earlier development meant some
// rows were inserted after the extension started sending place-ID-based
// uids but before this backend picked up the code that saves them into
// place_id. Since uid IS the place ID for those rows, it's recoverable
// without re-scraping.
db.exec(`
  UPDATE listings
  SET place_id = uid
  WHERE (place_id IS NULL OR place_id = '')
    AND uid LIKE '0x%:0x%'
`);

// ── Global dedup: a business re-scraped across multiple sessions should
// only ever have one row, otherwise exports show it repeated. Drop older
// duplicates (keep the earliest row per uid), then enforce it going forward
// with a unique index — INSERT OR IGNORE in routes/listings.js already
// silently skips any insert that would violate it.
db.exec(`
  DELETE FROM listings
  WHERE uid IS NOT NULL
    AND id NOT IN (SELECT MIN(id) FROM listings WHERE uid IS NOT NULL GROUP BY uid)
`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_uid_unique ON listings(uid) WHERE uid IS NOT NULL`);

module.exports = db;
