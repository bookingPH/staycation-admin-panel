/**
 * get-availability — public endpoint for AI chatbot availability checks.
 * Returns all blocked date ranges per room (confirmed + pending_review only).
 * Also returns room names so AI can say "Standard Room" not "unit abc123".
 *
 * GET /.netlify/functions/get-availability?clientId=lester-domain-staycation
 * No auth required — only returns dates and room names, no personal info.
 */

const admin = require('firebase-admin');

if (!admin.apps.length) {
  const raw = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8').replace(/^﻿/, '');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
}

const db = admin.firestore();

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

function json(status, body) {
  return { statusCode: status, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });

  const clientId = (event.queryStringParameters || {}).clientId;
  if (!clientId) return json(400, { error: 'clientId is required' });

  try {
    // Fetch availability + units in parallel
    const [availSnap, unitsSnap] = await Promise.all([
      db.collection(`clients/${clientId}/availability`).get(),
      db.collection(`clients/${clientId}/units`).get(),
    ]);

    // Build unitId → room name map
    const unitNames = {};
    unitsSnap.forEach(doc => {
      unitNames[doc.id] = doc.data().name || doc.id;
    });

    // Filter to active bookings only — skip expired, cancelled, rejected
    const activeStatuses = ['confirmed', 'pending_review'];
    const blockedDates = [];

    availSnap.forEach(doc => {
      const { unitId, checkIn, checkOut, status } = doc.data();
      if (!activeStatuses.includes(status)) return;
      if (!checkIn || !checkOut) return;
      blockedDates.push({
        roomName: unitNames[unitId] || unitId,
        unitId,
        checkIn,
        checkOut,
        status,
      });
    });

    // Sort by check-in date
    blockedDates.sort((a, b) => a.checkIn.localeCompare(b.checkIn));

    // Build list of all active rooms
    const rooms = unitsSnap.docs
      .filter(doc => doc.data().status !== 'inactive')
      .map(doc => ({
        unitId: doc.id,
        name: doc.data().name || doc.id,
        weekdayRate: doc.data().weekdayRate,
        weekendRate: doc.data().weekendRate,
        maxGuests: doc.data().maxGuests,
      }));

    return json(200, { clientId, rooms, blockedDates });

  } catch (err) {
    console.error('get-availability error:', err.message);
    return json(500, { error: 'Failed to fetch availability' });
  }
};
