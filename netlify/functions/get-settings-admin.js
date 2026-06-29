/**
 * get-settings-admin — returns both public and private settings to an authenticated admin.
 * Private fields (smtpPassword, telegramToken) are returned masked.
 *
 * Requires Authorization: Bearer <firebase-id-token> header.
 * Verifies the token, then checks admins/{email}.clientId matches the requested clientId.
 */

const admin = require('firebase-admin');

if (!admin.apps.length) {
  const raw = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
}

const db = admin.firestore();
const MASK = '••••••••';
const CORS = {
  'Access-Control-Allow-Origin': 'https://staycation-admin-ph.netlify.app',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(status, body) {
  return { statusCode: status, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  // Verify Firebase ID token
  const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return json(401, { error: 'Missing authorization token' });

  let decodedToken;
  try {
    decodedToken = await admin.auth().verifyIdToken(token);
  } catch (err) {
    return json(401, { error: 'Invalid or expired token' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

  const { clientId } = body;
  if (!clientId) return json(400, { error: 'clientId is required' });

  // Verify the admin owns this clientId
  try {
    const adminSnap = await db.doc(`admins/${decodedToken.email}`).get();
    if (!adminSnap.exists || adminSnap.data().clientId !== clientId) {
      return json(403, { error: 'Access denied' });
    }
  } catch (err) {
    return json(500, { error: 'Authorization check failed' });
  }

  // Fetch both settings docs
  try {
    const [pubSnap, privSnap] = await Promise.all([
      db.doc(`clients/${clientId}/settings/public`).get(),
      db.doc(`clients/${clientId}/settings/private`).get(),
    ]);

    const pub  = pubSnap.exists  ? pubSnap.data()  : {};
    const priv = privSnap.exists ? privSnap.data() : {};

    // Mask secret values — return whether they're SET, but not their actual values
    return json(200, {
      public: pub,
      private: {
        smtpEmail:         priv.smtpEmail         || '',
        smtpPassword:      priv.smtpPassword       ? MASK : '',
        notificationEmail: priv.notificationEmail  || '',
        telegramToken:     priv.telegramToken      ? MASK : '',
        telegramChatId:    priv.telegramChatId     || '',
      },
    });
  } catch (err) {
    console.error('get-settings-admin Firestore error:', err.message);
    return json(500, { error: 'Failed to load settings' });
  }
};
