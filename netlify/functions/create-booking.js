/**
 * create-booking — server-side booking submission.
 * Called by booking site after guest completes all 4 steps and uploads screenshot.
 *
 * What this function does:
 *  1. Validates all input fields.
 *  2. Fetches unit, addons, and settings from Firestore (server-side — never trusts caller).
 *  3. Calculates all prices server-side (nightly rate, extra guests, addons, totals).
 *  4. Runs a Firestore transaction that:
 *       a. Reads every inventory/{unitId_YYYY-MM-DD} doc for the requested nights.
 *       b. Rejects the booking if ANY night is already held (non-expired) or confirmed.
 *       c. Atomically claims all nights + creates the booking + creates the availability doc.
 *  5. Returns { bookingId, referenceNo } on success.
 *  6. Returns { error: 'DATES_NOT_AVAILABLE' } if any night is taken.
 *
 * CORS: booking site origin only.
 */

const {
  db, FieldValue, Timestamp,
  getDateRange,
} = require('./_shared');

const admin = require('firebase-admin');

const CORS = {
  'Access-Control-Allow-Origin': 'https://bookingph.github.io',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(status, body) {
  return { statusCode: status, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

// ---------------------------------------------------------------------------
// Price calculation — server-side, never from caller
// ---------------------------------------------------------------------------

// Weekend = Friday, Saturday, Sunday nights (check-in night determines rate)
function isWeekendNight(dateStr) {
  const day = new Date(dateStr + 'T00:00:00').getDay(); // 0=Sun,5=Fri,6=Sat
  return day === 0 || day === 5 || day === 6;
}

function calculatePricing({ unit, nights, numGuests, selectedAddons, settings }) {
  let baseTotal = 0;
  for (const date of nights) {
    baseTotal += isWeekendNight(date) ? (unit.weekendRate || unit.weekdayRate || 0) : (unit.weekdayRate || 0);
  }

  const baseCapacity = unit.maxGuests || 2;
  const extraGuests = Math.max(0, numGuests - baseCapacity);
  const extraGuestFee = unit.extraGuestFee || 0;
  const extraGuestTotal = extraGuests * extraGuestFee * nights.length;

  let addonsTotal = 0;
  const addonDetails = [];
  for (const addon of selectedAddons) {
    const lineTotal = addon.billingRule === 'pernight' ? addon.price * nights.length : addon.price;
    addonsTotal += lineTotal;
    addonDetails.push({ id: addon.id, name: addon.name, price: addon.price, billingRule: addon.billingRule, total: lineTotal });
  }

  const grandTotal = baseTotal + extraGuestTotal + addonsTotal;
  const reservationFee = settings.downPaymentAmount || 500;
  const securityDeposit = settings.securityDeposit || 0;
  const balanceDueAtCheckin = Math.max(0, grandTotal - reservationFee) + securityDeposit;

  return {
    nights: nights.length,
    baseTotal,
    extraGuests,
    extraGuestTotal,
    addons: addonDetails,
    addonsTotal,
    grandTotal,
    reservationFee,
    securityDeposit,
    balanceDueAtCheckin,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateDate(str) {
  return /^\d{4}-\d{2}-\d{2}$/.test(str) && !isNaN(new Date(str + 'T00:00:00').getTime());
}

function validateEmail(str) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON body' }); }

  const {
    clientId,
    unitId,
    checkIn,
    checkOut,
    guestName,
    guestEmail,
    guestPhone,
    numGuests,
    addonIds,      // string[] — IDs of selected addons
    paymentMethod,
    screenshotUrl, // Cloudinary URL from signed upload
  } = body;

  // --- Input validation ---
  if (!clientId) return json(400, { error: 'clientId is required' });
  if (!unitId) return json(400, { error: 'unitId is required' });
  if (!checkIn || !validateDate(checkIn)) return json(400, { error: 'Valid checkIn date (YYYY-MM-DD) is required' });
  if (!checkOut || !validateDate(checkOut)) return json(400, { error: 'Valid checkOut date (YYYY-MM-DD) is required' });
  if (checkIn >= checkOut) return json(400, { error: 'checkOut must be after checkIn' });
  if (!guestName || !guestName.trim()) return json(400, { error: 'guestName is required' });
  if (!guestEmail || !validateEmail(guestEmail)) return json(400, { error: 'Valid guestEmail is required' });
  if (!guestPhone || !guestPhone.trim()) return json(400, { error: 'guestPhone is required' });
  if (!numGuests || isNaN(Number(numGuests)) || Number(numGuests) < 1) return json(400, { error: 'numGuests must be a positive integer' });
  if (!paymentMethod) return json(400, { error: 'paymentMethod is required' });
  if (!screenshotUrl) return json(400, { error: 'screenshotUrl is required — upload payment proof first' });

  const nights = getDateRange(checkIn, checkOut);
  if (nights.length === 0) return json(400, { error: 'No nights selected' });
  if (nights.length > 30) return json(400, { error: 'Maximum stay is 30 nights' });

  // --- Fetch unit ---
  let unit;
  try {
    const unitSnap = await db.doc(`clients/${clientId}/units/${unitId}`).get();
    if (!unitSnap.exists) return json(404, { error: 'Unit not found' });
    unit = unitSnap.data();
    if (unit.status === 'inactive') return json(422, { error: 'This unit is not currently available for booking' });
  } catch (err) {
    console.error('Unit fetch error:', err.message);
    return json(500, { error: 'Failed to fetch unit data' });
  }

  // Validate guest count against unit capacity
  const maxTotal = (unit.maxGuests || 2) + (unit.maxExtraGuests || 0);
  if (Number(numGuests) > maxTotal) {
    return json(422, { error: `Maximum guests for this unit is ${maxTotal}` });
  }

  // --- Fetch settings/public ---
  let settings;
  try {
    const snap = await db.doc(`clients/${clientId}/settings/public`).get();
    if (!snap.exists) return json(500, { error: 'Client settings not found' });
    settings = snap.data();
  } catch (err) {
    return json(500, { error: 'Failed to fetch client settings' });
  }

  // --- Fetch selected addons ---
  let selectedAddons = [];
  if (Array.isArray(addonIds) && addonIds.length > 0) {
    try {
      const addonSnaps = await Promise.all(
        addonIds.map(id => db.doc(`clients/${clientId}/addons/${id}`).get())
      );
      selectedAddons = addonSnaps
        .filter(s => s.exists)
        .map(s => ({ id: s.id, ...s.data() }));
    } catch (err) {
      console.error('Addon fetch error:', err.message);
      // Non-fatal — proceed with no addons rather than blocking the booking
      selectedAddons = [];
    }
  }

  // --- Calculate prices server-side ---
  const pricing = calculatePricing({ unit, nights, numGuests: Number(numGuests), selectedAddons, settings });

  // --- Atomic transaction: claim inventory + create booking + create availability ---
  const inventoryRefs = nights.map(date => db.doc(`inventory/${unitId}_${date}`));
  const now = Timestamp.now();
  const expiresAt = Timestamp.fromMillis(now.toMillis() + 45 * 60 * 1000); // 45-minute hold

  // Generate bookingId and referenceNo before the transaction
  const newBookingRef = db.collection(`clients/${clientId}/bookings`).doc();
  const bookingId = newBookingRef.id;
  const referenceNo = `BK-${bookingId}`;

  try {
    await db.runTransaction(async (tx) => {
      // Read all inventory slots
      const inventorySnaps = await Promise.all(inventoryRefs.map(ref => tx.get(ref)));

      // Check availability — reject if any night is actively held or confirmed
      for (const snap of inventorySnaps) {
        if (snap.exists) {
          const inv = snap.data();
          if (inv.status === 'confirmed') {
            throw Object.assign(new Error('DATES_NOT_AVAILABLE'), { code: 'DATES_NOT_AVAILABLE' });
          }
          if (inv.status === 'held') {
            // Check if the hold has expired
            const expired = inv.expiresAt && inv.expiresAt.toMillis() < now.toMillis();
            if (!expired) {
              throw Object.assign(new Error('DATES_NOT_AVAILABLE'), { code: 'DATES_NOT_AVAILABLE' });
            }
            // Expired hold — treat as available (will be overwritten below)
          }
        }
      }

      // Claim all nights
      for (const ref of inventoryRefs) {
        tx.set(ref, {
          bookingId,
          clientId,
          unitId,
          status: 'held',
          expiresAt,
          createdAt: now,
        });
      }

      // Create booking record
      tx.set(newBookingRef, {
        referenceNo,
        clientId,
        unitId,
        unitName: unit.name || unitId,
        guestName: guestName.trim(),
        guestEmail: guestEmail.trim().toLowerCase(),
        guestPhone: guestPhone.trim(),
        numGuests: Number(numGuests),
        checkIn,
        checkOut,
        ...pricing,
        paymentMethod,
        screenshotUrl,
        status: 'pending_review',
        createdAt: FieldValue.serverTimestamp(),
        receiptSentAt: null,
      });

      // Create availability record (public calendar — no personal info)
      tx.set(db.doc(`clients/${clientId}/availability/${bookingId}`), {
        bookingId,
        unitId,
        checkIn,
        checkOut,
        status: 'pending_review',
        createdAt: now,
      });
    });
  } catch (err) {
    if (err.code === 'DATES_NOT_AVAILABLE') {
      return json(409, { error: 'DATES_NOT_AVAILABLE', message: 'Sorry, those dates are no longer available. Please choose new dates.' });
    }
    console.error('Transaction error:', err.message);
    return json(500, { error: 'Failed to create booking. Please try again.' });
  }

  return json(200, {
    success: true,
    bookingId,
    referenceNo,
    pricing,
  });
};
