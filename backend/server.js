/**
 * GMaps Scraper - Express API Server
 * Run: npm start  (or npm run dev with nodemon)
 */

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const morgan   = require('morgan');
const path     = require('path');

const listingsRouter = require('./routes/listings');
const sessionsRouter = require('./routes/sessions');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ─────────────────────────────────────────────────────
app.use(cors({
  // In production: restrict to your extension's origin
  origin: process.env.CORS_ORIGIN || '*',
}));
app.use(express.json({ limit: '10mb' })); // listings can be large
app.use(morgan('dev'));
app.use(express.static(path.join(__dirname, 'public'))); // dashboard UI

// ── Routes ─────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.use('/api/listings', listingsRouter);
app.use('/api/sessions', sessionsRouter);

// ── 404 & Error handlers ───────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, _req, res, _next) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message });
});

// ── Start ──────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════╗
  ║   GMaps Scraper API              ║
  ║   http://localhost:${PORT}         ║
  ╚══════════════════════════════════╝

  Endpoints:
    POST   /api/listings          ← receive scrape data
    GET    /api/listings          ← query all listings
    GET    /api/listings/export   ← download CSV
    GET    /api/sessions          ← list sessions
    DELETE /api/sessions/:id      ← delete session
    GET    /health                ← health check
  `);
});

module.exports = app;