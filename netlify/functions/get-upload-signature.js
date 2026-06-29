/**
 * get-upload-signature — returns signed Cloudinary upload parameters.
 * Used by:
 *   - Booking site: guest payment screenshot uploads (type='payment')
 *   - Admin panel: QR codes, unit photos, hero images (type='public')
 *
 * Rate limited for guest uploads (5/10min per IP).
 * Admin uploads require a valid Firebase ID token.
 */

const crypto = require('crypto');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  const raw = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
}

const BOOKING_ORIGIN = 'https://bookingph.github.io';
const ADMIN_ORIGIN   = 'https://staycation-admin.netlify.app';

function corsHeaders(origin) {
  const allowed = [BOOKING_ORIGIN, ADMIN_ORIGIN].includes(origin) ? origin : BOOKING_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function json(status, body, origin) {
  return { statusCode: status, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

// Rate limiter — guest uploads only
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 5;

function checkRateLimit(ip) {
  const now = Date.now();
  const hits = (rateLimitMap.get(ip) || []).filter(ts => ts > now - RATE_LIMIT_WINDOW_MS);
  if (hits.length >= RATE_LIMIT_MAX) return false;
  hits.push(now);
  rateLimitMap.set(ip, hits);
  return true;
}

function generateSignature(params, apiSecret) {
  const str = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&') + apiSecret;
  return crypto.createHash('sha1').update(str).digest('hex');
}

exports.handler = async (event) => {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(origin), body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' }, origin);

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }, origin); }

  const { clientId, type = 'payment' } = body;
  if (!clientId) return json(400, { error: 'clientId is required' }, origin);

  const isAdminUpload = type === 'public';

  if (isAdminUpload) {
    // Verify Firebase ID token for admin uploads
    const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return json(401, { error: 'Admin uploads require Authorization token' }, origin);
    try {
      const decoded = await admin.auth().verifyIdToken(token);
      const adminSnap = await admin.firestore().doc(`admins/${decoded.email}`).get();
      if (!adminSnap.exists || adminSnap.data().clientId !== clientId) {
        return json(403, { error: 'Access denied' }, origin);
      }
    } catch {
      return json(401, { error: 'Invalid or expired token' }, origin);
    }
  } else {
    // Rate limit guest uploads by IP
    const ip = ((event.headers && (event.headers['x-forwarded-for'] || event.headers['client-ip'])) || 'unknown').split(',')[0].trim();
    if (!checkRateLimit(ip)) return json(429, { error: 'Too many upload requests. Please wait a few minutes.' }, origin);
  }

  const apiSecret  = process.env.CLOUDINARY_API_SECRET;
  const apiKey     = process.env.CLOUDINARY_API_KEY;
  const cloudName  = process.env.CLOUDINARY_CLOUD_NAME || 'dwqweaowd';

  if (!apiSecret || !apiKey) return json(500, { error: 'Upload service not configured' }, origin);

  const timestamp = Math.floor(Date.now() / 1000);
  const folder    = isAdminUpload ? `public-assets/${clientId}` : `payment-proofs/${clientId}`;

  const params = {
    folder,
    timestamp,
    allowed_formats: 'jpg,jpeg,png,webp',
    unique_filename: 'true',
    overwrite: 'false',
  };

  const signature = generateSignature(params, apiSecret);

  return json(200, { signature, apiKey, timestamp, folder, cloudName, allowedFormats: 'jpg,jpeg,png,webp' }, origin);
};
