// Protection against forged form submissions from other websites.

/**
 * Any request that changes data must come from this site.
 * Browsers send an Origin (or Referer) header with form posts; we check it matches our own host.
 */
function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const source = req.get('origin') || req.get('referer');
  let ok = false;
  if (source) {
    try {
      ok = new URL(source).host === req.get('host');
    } catch {
      ok = false;
    }
  }
  if (ok) return next();
  res.status(403).render('error', { title: 'Request blocked', message: 'This form was not sent from this site. Reload the page and try again.' });
}

module.exports = { sameOrigin };
