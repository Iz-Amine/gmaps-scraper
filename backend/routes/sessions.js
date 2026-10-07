/**
 * routes/sessions.js
 * GET    /api/sessions     → list all sessions
 * DELETE /api/sessions/:id → delete a session and its listings
 */

const express   = require('express');
const router    = express.Router();
const db        = require('../db');
const authCheck = require('../middleware/auth');

router.get('/', authCheck, (req, res) => {
  const rows = db.prepare(`SELECT * FROM sessions ORDER BY id DESC LIMIT 100`).all();
  res.json({ ok: true, sessions: rows });
});

router.delete('/:id', authCheck, (req, res) => {
  const { changes } = db.prepare(`DELETE FROM sessions WHERE id = ?`).run(Number(req.params.id));
  if (changes === 0) return res.status(404).json({ error: 'Session not found' });
  res.json({ ok: true, deleted: req.params.id });
});

module.exports = router;
