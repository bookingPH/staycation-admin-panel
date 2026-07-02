/**
 * get-client-info — public endpoint for AI chatbot knowledge base.
 * Returns business info, rooms with pricing, amenities, add-ons, and policies.
 * Called before every AI response so the chatbot always has up-to-date info.
 *
 * GET /.netlify/functions/get-client-info?clientId=lester-domain-staycation
 * No auth required — only returns public business info, no personal/booking data.
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

function formatCurrency(amount) {
  if (!amount) return '';
  return '₱' + Number(amount).toLocaleString('en-PH');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });

  const clientId = (event.queryStringParameters || {}).clientId;
  if (!clientId) return json(400, { error: 'clientId is required' });

  try {
    // Fetch all data in parallel
    const [settingsSnap, unitsSnap, amenitiesSnap, addonsSnap] = await Promise.all([
      db.doc(`clients/${clientId}/settings/public`).get(),
      db.collection(`clients/${clientId}/units`).get(),
      db.collection(`clients/${clientId}/amenities`).get(),
      db.collection(`clients/${clientId}/addons`).get(),
    ]);

    if (!settingsSnap.exists) return json(404, { error: `No settings found for clientId: ${clientId}` });

    const s = settingsSnap.data();

    // Rooms — skip inactive
    const rooms = unitsSnap.docs
      .filter(doc => doc.data().status !== 'inactive')
      .map(doc => {
        const d = doc.data();
        return {
          name: d.name || doc.id,
          weekdayRate: d.weekdayRate || 0,
          weekendRate: d.weekendRate || 0,
          maxGuests: d.maxGuests || 0,
          description: d.description || '',
        };
      });

    // Amenities
    const amenities = amenitiesSnap.docs
      .map(doc => doc.data().name || '')
      .filter(Boolean);

    // Add-ons
    const addons = addonsSnap.docs
      .map(doc => ({ name: doc.data().name || '', price: doc.data().price || 0 }))
      .filter(a => a.name);

    // Build formatted text for AI injection
    const lines = [];

    lines.push(`BUSINESS NAME: ${s.companyName || clientId}`);
    if (s.description) lines.push(`DESCRIPTION: ${s.description}`);
    if (s.address) lines.push(`ADDRESS: ${s.address}`);
    if (s.phone) lines.push(`CONTACT PHONE: ${s.phone}`);
    if (s.email) lines.push(`CONTACT EMAIL: ${s.email}`);
    lines.push(`CHECK-IN TIME: ${s.checkInTime || '2:00 PM'}`);
    lines.push(`CHECK-OUT TIME: ${s.checkOutTime || '12:00 PM'}`);
    lines.push(`BOOKING URL: https://bookingph.github.io/${clientId}/`);

    if (rooms.length > 0) {
      lines.push('');
      lines.push('ROOMS & RATES:');
      rooms.forEach(r => {
        lines.push(`- ${r.name}: ${formatCurrency(r.weekdayRate)}/night weekday | ${formatCurrency(r.weekendRate)}/night weekend | Max ${r.maxGuests} guests${r.description ? ' | ' + r.description : ''}`);
      });
    }

    if (amenities.length > 0) {
      lines.push('');
      lines.push(`AMENITIES: ${amenities.join(', ')}`);
    }

    if (addons.length > 0) {
      lines.push('');
      lines.push('ADD-ONS:');
      addons.forEach(a => lines.push(`- ${a.name}: ${formatCurrency(a.price)}`));
    }

    if (s.policyHouseRules) {
      lines.push('');
      lines.push('HOUSE RULES:');
      lines.push(s.policyHouseRules);
    }

    if (s.policyBooking) {
      lines.push('');
      lines.push('BOOKING POLICY:');
      lines.push(s.policyBooking);
    }

    if (s.policyCancellation) {
      lines.push('');
      lines.push('CANCELLATION POLICY:');
      lines.push(s.policyCancellation);
    }

    if (s.policyCheckinOut) {
      lines.push('');
      lines.push('CHECK-IN / CHECK-OUT POLICY:');
      lines.push(s.policyCheckinOut);
    }

    return json(200, {
      clientId,
      formatted: lines.join('\n'),
    });

  } catch (err) {
    console.error('get-client-info error:', err.message);
    return json(500, { error: 'Failed to fetch client info' });
  }
};
