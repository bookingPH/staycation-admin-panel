/**
 * save-settings — writes public and private settings for an authenticated admin.
 * Requires Authorization: Bearer <firebase-id-token> header.
 * Masked fields (••••••••) are never written — existing values are preserved.
 * Validates input before writing.
 */

const admin = require('firebase-admin');

if (!admin.apps.length) {
  const raw = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8').replace(/^﻿/, '');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
}

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
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
  } catch {
    return json(401, { error: 'Invalid or expired token' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

  const { clientId, public: pub, private: priv } = body;
  if (!clientId) return json(400, { error: 'clientId is required' });

  // Verify ownership
  try {
    const adminSnap = await db.doc(`admins/${decodedToken.email}`).get();
    if (!adminSnap.exists || adminSnap.data().clientId !== clientId) {
      return json(403, { error: 'Access denied' });
    }
  } catch {
    return json(500, { error: 'Authorization check failed' });
  }

  // Build public update (only safe fields)
  const pubUpdate = {};
  const allowedPublic = [
    'companyName','address','phone','email','logoUrl','heroImageUrl',
    'gcashName','gcashNumber','gcashQrUrl',
    'mayaName','mayaNumber','mayaQrUrl',
    'bankName','bankAccountName','bankAccount','bankQrUrl',
    'downPaymentAmount','securityDeposit','checkInTime','checkOutTime',
    'bookingWebsiteUrl',
    'policyBooking','policyCancellation','policyHouseRules','policyCheckinOut',
  ];

  if (pub && typeof pub === 'object') {
    for (const key of allowedPublic) {
      if (key in pub) {
        let val = pub[key];
        // Coerce numeric fields
        if (['downPaymentAmount','securityDeposit'].includes(key)) {
          val = Number(val);
          if (isNaN(val) || val < 0) return json(400, { error: `${key} must be a non-negative number` });
        }
        // Basic string trim
        if (typeof val === 'string') val = val.trim();
        pubUpdate[key] = val;
      }
    }
  }

  // Build private update — skip masked values
  const privUpdate = {};
  if (priv && typeof priv === 'object') {
    if (priv.smtpEmail !== undefined && priv.smtpEmail !== MASK) {
      privUpdate.smtpEmail = String(priv.smtpEmail).trim();
    }
    if (priv.notificationEmail !== undefined) {
      privUpdate.notificationEmail = String(priv.notificationEmail).trim();
    }
    if (priv.smtpPassword !== undefined && priv.smtpPassword !== MASK && priv.smtpPassword !== '') {
      privUpdate.smtpPassword = String(priv.smtpPassword);
    }
    if (priv.telegramToken !== undefined && priv.telegramToken !== MASK && priv.telegramToken !== '') {
      privUpdate.telegramToken = String(priv.telegramToken).trim();
    }
    if (priv.telegramChatId !== undefined) {
      privUpdate.telegramChatId = String(priv.telegramChatId).trim();
    }
    // Allow clearing Telegram by setting empty string
    if (priv.telegramToken === '' && priv.telegramChatId === '') {
      privUpdate.telegramToken  = FieldValue.delete();
      privUpdate.telegramChatId = FieldValue.delete();
    }
  }

  // Write to Firestore
  try {
    const batch = db.batch();

    if (Object.keys(pubUpdate).length > 0) {
      batch.set(db.doc(`clients/${clientId}/settings/public`), pubUpdate, { merge: true });
    }
    if (Object.keys(privUpdate).length > 0) {
      batch.set(db.doc(`clients/${clientId}/settings/private`), privUpdate, { merge: true });
    }

    await batch.commit();
    return json(200, { success: true });
  } catch (err) {
    console.error('save-settings Firestore error:', err.message);
    return json(500, { error: 'Failed to save settings' });
  }
};
