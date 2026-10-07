/**
 * routes/listings.js
 * POST /api/listings  → receive a scrape session + listings
 * GET  /api/listings  → query / filter all listings
 * GET  /api/listings/export → download as CSV
 *
 * Session-level routes (list/delete) live in routes/sessions.js.
 */

const express   = require('express');
const router    = express.Router();
const db        = require('../db');
const authCheck = require('../middleware/auth');

// ══════════════════════════════════════════
// POST /api/listings
// Body: { project, source, scraped_at, count, listings: [...] }
// ══════════════════════════════════════════
router.post('/', authCheck, (req, res) => {
  const { project = 'default', source = 'google_maps', scraped_at, listings } = req.body;

  if (!Array.isArray(listings) || listings.length === 0) {
    return res.status(400).json({ error: 'listings array is required and must not be empty' });
  }

  // Insert session
  const sessionStmt = db.prepare(`
    INSERT INTO sessions (project, source, scraped_at, listing_count)
    VALUES (?, ?, ?, ?)
  `);

  const listingStmt = db.prepare(`
    INSERT OR IGNORE INTO listings
      (session_id, uid, name, category, rating, review_count, address, phone, website, hours,
       place_id, google_maps_url, business_status, plus_code, has_phone, has_website)
    VALUES
      (@session_id, @uid, @name, @category, @rating, @review_count, @address, @phone, @website, @hours,
       @place_id, @google_maps_url, @business_status, @plus_code, @has_phone, @has_website)
  `);

  // A business already stored (global unique uid) gets its missing phone/website
  // filled in by a later, richer scrape; existing values are never overwritten with empties.
  const enrichStmt = db.prepare(`
    UPDATE listings SET
      phone       = COALESCE(NULLIF(@phone, ''), phone),
      website     = COALESCE(NULLIF(@website, ''), website),
      plus_code   = COALESCE(@plus_code, plus_code),
      has_phone   = CASE WHEN COALESCE(NULLIF(@phone, ''), phone) IS NOT NULL THEN 1 ELSE 0 END,
      has_website = CASE WHEN COALESCE(NULLIF(@website, ''), website) IS NOT NULL THEN 1 ELSE 0 END
    WHERE uid = @uid
  `);

  // Run in a transaction for atomicity + speed
  const insertAll = db.transaction((sessionData, rows) => {
    const { lastInsertRowid: sessionId } = sessionStmt.run(
      sessionData.project,
      sessionData.source,
      sessionData.scraped_at || new Date().toISOString(),
      rows.length
    );

    let inserted = 0;
    for (const row of rows) {
      const result = listingStmt.run({
        session_id:   sessionId,
        uid:          row.uid          || null,
        name:         row.name         || null,
        category:     row.category     || null,
        rating:       row.rating       || null,
        review_count: row.reviewCount  || null,
        address:      row.address      || null,
        phone:        row.phone        || null,
        website:      row.website      || null,
        hours:        row.hours        || null,
        place_id:        row.placeId        || null,
        google_maps_url: row.mapsUrl        || null,
        business_status: row.businessStatus || null,
        plus_code:       row.plusCode       || null,
        has_phone:       row.phone   ? 1 : 0,
        has_website:     row.website ? 1 : 0,
      });
      inserted += result.changes;
      if (result.changes === 0 && row.uid) {
        enrichStmt.run({
          uid:       row.uid,
          phone:     row.phone     || null,
          website:   row.website   || null,
          plus_code: row.plusCode  || null,
        });
      }
    }

    return { sessionId, inserted };
  });

  try {
    const result = insertAll({ project, source, scraped_at }, listings);
    res.status(201).json({
      ok: true,
      session_id: result.sessionId,
      inserted:   result.inserted,
      skipped:    listings.length - result.inserted,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════
// GET /api/listings/categories?project=
// Distinct category values present in the data (optionally scoped to a
// project), with counts — lets the dashboard offer a checklist of the
// actual categories instead of guessing keyword groups.
// ══════════════════════════════════════════
router.get('/categories', authCheck, (req, res) => {
  const { project } = req.query;

  let sql = `
    SELECT COALESCE(l.category, '(none)') AS category, COUNT(*) AS count
    FROM listings l JOIN sessions s ON l.session_id = s.id
    WHERE 1=1
  `;
  const args = [];
  if (project) { sql += ` AND s.project = ?`; args.push(project); }
  sql += ` GROUP BY category ORDER BY count DESC`;

  try {
    const rows = db.prepare(sql).all(...args);
    res.json({ ok: true, categories: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function categoryFilterClause(categories, args) {
  if (!categories) return '';
  const list = categories.split(',').map(c => c.trim()).filter(Boolean);
  if (list.length === 0) return '';
  const placeholders = list.map(() => '?').join(',');
  args.push(...list);
  // '(none)' is the dashboard's stand-in for a NULL category
  return ` AND (l.category IN (${placeholders})${list.includes('(none)') ? ' OR l.category IS NULL' : ''})`;
}

// '1'/'0' only — anything else (absent, empty, "all") means "don't filter on this".
function boolFilterClause(column, value) {
  if (value !== '1' && value !== '0') return '';
  return ` AND l.${column} = ${value === '1' ? 1 : 0}`;
}

// ══════════════════════════════════════════
// GET /api/listings
// Query params: project, session_id, search, categories, has_phone, has_website, limit, offset
// has_phone / has_website: '1' = only with, '0' = only without, omitted = either
// ══════════════════════════════════════════
router.get('/', authCheck, (req, res) => {
  const { project, session_id, search, categories, has_phone, has_website, limit = 100, offset = 0 } = req.query;

  let whereClause = ` WHERE 1=1`;
  const filterArgs = [];

  if (project) {
    whereClause += ` AND s.project = ?`;
    filterArgs.push(project);
  }
  if (session_id) {
    whereClause += ` AND l.session_id = ?`;
    filterArgs.push(Number(session_id));
  }
  if (search) {
    whereClause += ` AND (l.name LIKE ? OR l.address LIKE ? OR l.category LIKE ?)`;
    const q = `%${search}%`;
    filterArgs.push(q, q, q);
  }
  whereClause += categoryFilterClause(categories, filterArgs);
  whereClause += boolFilterClause('has_phone', has_phone);
  whereClause += boolFilterClause('has_website', has_website);

  const sql = `SELECT l.*, s.project, s.scraped_at FROM listings l JOIN sessions s ON l.session_id = s.id${whereClause} ORDER BY l.id DESC LIMIT ? OFFSET ?`;

  try {
    const rows  = db.prepare(sql).all(...filterArgs, Number(limit), Number(offset));
    const total = db.prepare(
      `SELECT COUNT(*) as c FROM listings l JOIN sessions s ON l.session_id = s.id${whereClause}`
    ).get(...filterArgs);

    res.json({ ok: true, total: total.c, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════
// GET /api/listings/export?session_id=&project=
// Returns CSV file download
// ══════════════════════════════════════════
router.get('/export', authCheck, (req, res) => {
  const { project, session_id, search, categories, has_phone, has_website } = req.query;

  let sql  = `SELECT l.name, l.category, l.rating, l.review_count, l.address, l.phone, l.website, l.hours, l.place_id, l.google_maps_url, l.business_status, l.plus_code, l.has_phone, l.has_website, s.project, s.scraped_at FROM listings l JOIN sessions s ON l.session_id = s.id WHERE 1=1`;
  const args = [];

  if (project)    { sql += ` AND s.project = ?`;    args.push(project); }
  if (session_id) { sql += ` AND l.session_id = ?`; args.push(Number(session_id)); }
  if (search) {
    sql += ` AND (l.name LIKE ? OR l.address LIKE ? OR l.category LIKE ?)`;
    const q = `%${search}%`;
    args.push(q, q, q);
  }
  sql += categoryFilterClause(categories, args);
  sql += boolFilterClause('has_phone', has_phone);
  sql += boolFilterClause('has_website', has_website);
  sql += ` ORDER BY l.id DESC`;

  try {
    const rows = db.prepare(sql).all(...args);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'No data found for given filters' });
    }

    const header = Object.keys(rows[0]).join(',');
    const csvRows = rows.map(r =>
      Object.values(r).map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')
    );
    const csv = [header, ...csvRows].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="gmaps_export_${Date.now()}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════
// DELETE /api/listings
// Body: { ids: [1, 2, 3] } → delete specific listings
// ══════════════════════════════════════════
router.delete('/', authCheck, (req, res) => {
  const ids = (req.body?.ids || []).map(Number).filter(Number.isInteger);
  if (ids.length === 0) return res.status(400).json({ error: 'ids array is required' });

  try {
    const stmt = db.prepare(`DELETE FROM listings WHERE id = ?`);
    const deleteAll = db.transaction((list) => list.reduce((n, id) => n + stmt.run(id).changes, 0));
    const deleted = deleteAll(ids);
    // keep each session's listing_count in step with what is actually stored
    db.exec(`UPDATE sessions SET listing_count = (SELECT COUNT(*) FROM listings WHERE session_id = sessions.id)`);
    res.json({ ok: true, deleted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
