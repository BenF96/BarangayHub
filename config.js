// Reads and checks settings from the environment (.env). Stops the app early if something required is missing.
require('dotenv').config();

// Dates ("today", overdue, timestamps) follow Philippine time even if the server runs in UTC
process.env.TZ = process.env.TZ || 'Asia/Manila';

const env = process.env.NODE_ENV || 'development';
const isProd = env === 'production';

const config = {
  env,
  isProd,
  port: Number(process.env.PORT) || 3000,
  mongoUri: process.env.MONGODB_URI || (isProd ? '' : 'mongodb://127.0.0.1:27017/barangay_rental'),
  // Set to 1 (or the number of proxies) when running behind Nginx, Render, Railway, etc. so client IPs are detected
  trustProxy: process.env.TRUST_PROXY ? (isNaN(process.env.TRUST_PROXY) ? process.env.TRUST_PROXY : Number(process.env.TRUST_PROXY)) : 0,
  // Set HTTPS=true when the site is served over HTTPS: browsers are then told to always use HTTPS (HSTS)
  https: process.env.HTTPS === 'true',
};

if (!config.mongoUri) {
  console.error('Configuration error: MONGODB_URI is not set. Set it in .env (see .env.example).');
  process.exit(1);
}

module.exports = config;
