const config = require('./config'); // loads .env and checks settings first
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const methodOverride = require('method-override');

const Reservation = require('./models/Reservation');
const { today } = require('./utils/availability');
const { sameOrigin } = require('./middleware/security');

mongoose.set('strictQuery', true);

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');

// ---------- Health check (for uptime monitors / hosting platforms; no login, no DB data) ----------
app.get('/healthz', (req, res) => {
  const up = mongoose.connection.readyState === 1;
  res.status(up ? 200 : 503).json({ status: up ? 'ok' : 'db-down', uptime: Math.round(process.uptime()) });
});

// ---------- Security headers (CSP allows only this site's own files; inline scripts need the per-request nonce) ----------
app.use((req, res, next) => {
  res.locals.nonce = crypto.randomBytes(16).toString('base64');
  next();
});
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`],
        styleSrc: ["'self'", "'unsafe-inline'"], // style="" attributes in templates
        imgSrc: ["'self'", 'data:'],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: config.https ? [] : null,
      },
    },
    hsts: config.https ? undefined : false,
    // Send the page address only to this same site, so the form check below can see where a form came from
    referrerPolicy: { policy: 'same-origin' },
  })
);

app.use(compression());
app.use(morgan(config.isProd ? 'combined' : 'dev'));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: config.isProd ? '7d' : 0 }));
// Material Design fonts served from this app (no outside CDN, works offline on the office network)
const fontCache = { maxAge: '30d', immutable: true };
app.use('/vendor/roboto', express.static(path.join(__dirname, 'node_modules/@fontsource/roboto/files'), fontCache));
app.use('/vendor/material-symbols', express.static(path.join(__dirname, 'node_modules/material-symbols'), { ...fontCache, index: false, extensions: false }));
// ---------- View helpers + flash messages via query string (?msg=...&type=...) ----------
app.use((req, res, next) => {
  res.locals.msg = typeof req.query.msg === 'string' ? req.query.msg.slice(0, 300) : null;
  res.locals.msgType = req.query.type === 'error' ? 'error' : 'success';
  res.locals.currentPath = req.path;
  res.locals.currentUrl = req.originalUrl;
  res.locals.fmtDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
  res.locals.longDate = (d) =>
    d ? new Date(d).toLocaleDateString('en-PH', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : '—';
  res.locals.dateTime = (d) =>
    d ? new Date(d).toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
  res.locals.peso = (n) => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 });
  res.locals.todayLabel = new Date().toLocaleDateString('en-PH', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  res.locals.navCounts = { pending: 0, released: 0, overdue: 0 };
  next();
});

// Form bodies (after the view helpers, so a rejected oversized form can still show the error page)
app.use(express.urlencoded({ extended: false, limit: '50kb', parameterLimit: 100 }));
app.use(methodOverride('_method'));

// ---------- Error pages (no internal details shown in production) ----------
function notFound(req, res) {
  res.status(404).render('error', { title: 'Not Found', message: 'Page not found.' });
}
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err.name === 'CastError') return res.status(404).render('error', { title: 'Not Found', message: 'Record not found.' });
  if (err.type === 'entity.too.large') return res.status(413).render('error', { title: 'Too large', message: 'The form sent too much data.' });
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`, err);
  const message = config.isProd ? 'Something went wrong. Please try again, and tell the administrator if it keeps happening.' : err.message;
  if (res.headersSent) return;
  res.status(500).render('error', { title: 'Error', message });
}

async function start() {
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 15000 });
  console.log(`Connected to MongoDB (${config.env})`);

  // Data-changing requests must come from this site
  app.use(sameOrigin);

  // Counts shown as badges in the sidebar
  app.use(async (req, res, next) => {
    const t = today();
    const [pending, released, overdue] = await Promise.all([
      Reservation.countDocuments({ status: 'Pending' }),
      Reservation.countDocuments({ status: 'Released' }),
      Reservation.countDocuments({ status: 'Released', endDate: { $lt: t } }),
    ]);
    res.locals.navCounts = { pending, released, overdue };
    next();
  });

  app.use('/', require('./routes/dashboard'));
  app.use('/equipment', require('./routes/equipment'));
  app.use('/reservations', require('./routes/reservations'));
  app.use('/payments', require('./routes/payments'));

  app.use(notFound);
  app.use(errorHandler);

  const server = app.listen(config.port, () => console.log(`Server running at http://localhost:${config.port}`));

  // ---------- Graceful shutdown: finish requests in progress, then close the DB ----------
  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down…`);
    server.close(async () => {
      await mongoose.disconnect().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

start().catch((err) => {
  console.error('Startup failed:', err.message);
  process.exit(1);
});
