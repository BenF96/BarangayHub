// Protection against forged form submissions from other websites.

/**
 * Any request that changes data must come from this site.
 * Browsers send an Origin (or Referer) header with form posts; we check it matches our own host.
 */
function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const host = req.get('host');
  const sameHost = (value) => {
    if (!value || value === 'null') return false; // privacy settings can send Origin: null
    try {
      return new URL(value).host === host;
    } catch {
      return false;
    }
  };
  // Modern browsers say directly whether the request came from this site
  const fetchSite = req.get('sec-fetch-site');
  const ok =
    fetchSite === 'same-origin' ||
    (fetchSite !== 'cross-site' && fetchSite !== 'same-site' && (sameHost(req.get('origin')) || sameHost(req.get('referer'))));
  if (ok) return next();
  res.status(403).render('error', { title: 'Request blocked', message: 'This form was not sent from this site. Reload the page and try again.' });
}

module.exports = { sameOrigin };
