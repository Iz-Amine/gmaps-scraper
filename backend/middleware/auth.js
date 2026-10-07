/**
 * middleware/auth.js
 * Simple API key check shared by the listings and sessions routers.
 */
function authCheck(req, res, next) {
  const requiredKey = process.env.API_KEY;
  if (!requiredKey) return next(); // auth disabled if no key set

  const provided = req.headers['x-api-key'] || req.query.apiKey;
  if (provided !== requiredKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

module.exports = authCheck;
