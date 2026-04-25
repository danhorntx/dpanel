'use strict';

function requireLogin(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
    return res.status(401).json({ success: false, error: 'Not authenticated' });
  }
  res.redirect('/');
}

module.exports = { requireLogin };
