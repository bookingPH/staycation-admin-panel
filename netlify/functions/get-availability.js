/**
 * get-availability — public endpoint for AI chatbot availability checks.
 *
 * With checkIn + checkOut params: returns pre-computed per-room availability.
 * Without date params: returns raw blocked dates (backward compat).
 *
 * GET /.netlify/functions/get-availability?clientId=X&checkIn=2026-07-30&checkOut=2026-07-31
 * No auth required.
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

  const params = event.queryStringParameters || {};
  const clientId = params.clientId;
  if (!clientId) return json(400, { error: 'clientId is required' });

  const checkIn  = params.checkIn  || null;  // YYYY-MM-DD, optional
  const checkOut = params.checkOut || null;  // YYYY-MM-DD, optional

  try {
    // Fetch bookings + units + owner blocks in parallel
    const [availSnap, unitsSnap, blockedSnap] = await Promise.all([
      db.collection(`clients/${clientId}/availability`).get(),
      db.collection(`clients/${clientId}/units`).get(),
      db.collection(`clients/${clientId}/blocked_dates`).get(),
    ]);

    // Build unitId → name map
    const unitNames = {};
    unitsSnap.forEach(doc => {
      unitNames[doc.id] = doc.data().name || doc.id;
    });

    // All active rooms
    const rooms = unitsSnap.docs
      .filter(doc => doc.data().status !== 'inactive')
      .map(doc => ({
        unitId: doc.id,
        name: doc.data().name || doc.id,
        weekdayRate: doc.data().weekdayRate,
        weekendRate: doc.data().weekendRate,
        maxGuests: doc.data().maxGuests,
      }));

    // Build a unified list of all blocked ranges (bookings + owner blocks)
    const allBlocked = [];

    // Confirmed and pending bookings
    const activeStatuses = ['confirmed', 'pending_review'];
    availSnap.forEach(doc => {
      const { unitId, checkIn: bIn, checkOut: bOut, status } = doc.data();
      if (!activeStatuses.includes(status) || !bIn || !bOut) return;
      allBlocked.push({ unitId, checkIn: bIn, checkOut: bOut, status: 'booked' });
    });

    // Owner blocks — expand 'all' to every active room
    blockedSnap.forEach(doc => {
      const { unitId, startDate, endDate } = doc.data();
      if (!startDate || !endDate) return;
      const targets = unitId === 'all'
        ? rooms.map(r => r.unitId)
        : [unitId];
      for (const uid of targets) {
        allBlocked.push({ unitId: uid, checkIn: startDate, checkOut: endDate, status: 'blocked' });
      }
    });

    // ── Date-specific mode ──────────────────────────────────────────────────
    if (checkIn && checkOut) {
      const roomResults = rooms.map(room => {
        const conflict = allBlocked.find(b =>
          b.unitId === room.unitId &&
          b.checkIn < checkOut &&   // overlap: entry starts before requested checkout
          b.checkOut > checkIn      //          entry ends after requested checkin
        );
        return {
          name: room.name,
          unitId: room.unitId,
          weekdayRate: room.weekdayRate,
          weekendRate: room.weekendRate,
          maxGuests: room.maxGuests,
          available: !conflict,
          reason: conflict ? conflict.status : 'available',
        };
      });

      const availableRooms   = roomResults.filter(r =>  r.available).map(r => r.name);
      const unavailableRooms = roomResults.filter(r => !r.available).map(r => ({
        name: r.name,
        reason: r.reason === 'booked' ? 'guest booking' : 'owner block',
      }));

      return json(200, {
        clientId,
        requestedDates: { checkIn, checkOut },
        allAvailable:  unavailableRooms.length === 0,
        fullyBooked:   availableRooms.length === 0,
        availableRooms,
        unavailableRooms,
        rooms: roomResults,
      });
    }

    // ── No dates provided ───────────────────────────────────────────────────
    return json(200, { dateCheckSkipped: true });

  } catch (err) {
    console.error('get-availability error:', err.message);
    return json(500, { error: 'Failed to fetch availability' });
  }
};
