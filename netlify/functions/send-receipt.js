/**
 * send-receipt — called by booking site after screenshot upload + booking save.
 * Accepts ONLY { clientId, bookingId }. Fetches all data from Firestore server-side.
 * Idempotent: a second call for the same booking returns success without re-sending.
 * CORS restricted to the booking site origin.
 */

const {
  db, FieldValue,
  json, getSettings, getBooking, logNotification,
  formatDate, formatCurrency,
  createTransport, sendTelegram,
  emailHeader, emailFooter, refBox, detailTable, noticeBanner,
} = require('./_shared');

const CORS_ORIGIN = 'https://bookingph.github.io';

function cors(origin) {
  const allow = origin === CORS_ORIGIN ? CORS_ORIGIN : CORS_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function j(status, body, origin) {
  return { statusCode: status, headers: { ...cors(origin), 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function buildHtml(settings, booking) {
  const { companyName = 'Property' } = settings.public;
  const { referenceNo, guestName, unitName, checkIn, checkOut, nights, grandTotal, paymentMethod } = booking;

  return emailHeader(companyName, 'Booking Request Received')
    + `<p style="margin:0 0 8px;font-size:16px;color:#333;">Hi <strong>${guestName}</strong>,</p>
       <p style="margin:0 0 24px;font-size:15px;color:#555;line-height:1.6;">
         Thank you for your booking request! We received your payment screenshot and will verify it shortly.
         We'll send a confirmation within <strong>1–2 hours</strong>.
       </p>`
    + refBox(referenceNo)
    + detailTable([
        ['Property', unitName, 'font-weight:600;'],
        ['Check-in', formatDate(checkIn)],
        ['Check-out', formatDate(checkOut)],
        ['Nights', `${nights} night${Number(nights) !== 1 ? 's' : ''}`],
        ['Payment Method', paymentMethod],
        ['Grand Total', `<span style="font-size:18px;color:#C8623A;font-weight:700;">${formatCurrency(grandTotal)}</span>`, 'border-top:1px solid #eee;padding-top:12px;'],
      ])
    + noticeBanner('⏳ <strong>Status: Pending Review</strong><br>Our team will verify your payment and confirm within 1–2 hours. You\'ll receive another email once it\'s confirmed.')
    + `<p style="margin:0;font-size:14px;color:#555;">Thank you for choosing <strong>${companyName}</strong>. We look forward to hosting you!</p>`
    + emailFooter(companyName);
}

function buildText(settings, booking) {
  const { companyName = 'Property' } = settings.public;
  const { referenceNo, guestName, unitName, checkIn, checkOut, nights, grandTotal, paymentMethod } = booking;
  return `Hi ${guestName},\n\nThank you for your booking request at ${companyName}!\n\nBOOKING REFERENCE: ${referenceNo}\n\nProperty: ${unitName}\nCheck-in: ${formatDate(checkIn)}\nCheck-out: ${formatDate(checkOut)}\nNights: ${nights}\nPayment: ${paymentMethod}\nTotal: PHP ${Number(grandTotal).toFixed(2)}\n\nSTATUS: Pending Review\nWe will confirm within 1–2 hours.\n\nThank you,\n${companyName}\n`;
}

function buildAdminHtml(settings, booking) {
  const { companyName = 'Property' } = settings.public;
  const { referenceNo, guestName, guestEmail, guestPhone, unitName, checkIn, checkOut, nights, grandTotal, paymentMethod, screenshotUrl } = booking;
  return emailHeader(companyName, '🔔 New Booking Request', '#1a237e', '#3949ab')
    + `<p style="margin:0 0 20px;font-size:15px;color:#555;">A new booking request has been submitted and is waiting for your review.</p>`
    + refBox(referenceNo, '#e8eaf6', '#3949ab', '#1a237e')
    + detailTable([
        ['Room', unitName, 'font-weight:600;'],
        ['Guest Name', guestName],
        ['Email', guestEmail],
        ['Phone', guestPhone || '—'],
        ['Check-in', formatDate(checkIn)],
        ['Check-out', formatDate(checkOut)],
        ['Nights', `${nights} night${Number(nights) !== 1 ? 's' : ''}`],
        ['Payment', paymentMethod],
        ['Grand Total', `<span style="font-size:18px;color:#C8623A;font-weight:700;">${formatCurrency(grandTotal)}</span>`, 'border-top:1px solid #eee;padding-top:12px;'],
      ])
    + (screenshotUrl ? `<p style="margin:0 0 12px;"><a href="${screenshotUrl}" style="background:#1a237e;color:#fff;padding:10px 20px;border-radius:4px;text-decoration:none;font-size:14px;font-weight:600;display:inline-block;">View Payment Screenshot</a></p>` : '')
    + `<p style="margin:12px 0 0;"><a href="https://staycation-admin-ph.netlify.app" style="background:#C8623A;color:#fff;padding:10px 20px;border-radius:4px;text-decoration:none;font-size:14px;font-weight:600;display:inline-block;">Open Admin Panel</a></p>`
    + emailFooter(companyName);
}

function buildAdminText(settings, booking) {
  const { referenceNo, guestName, guestEmail, guestPhone, unitName, checkIn, checkOut, nights, grandTotal, paymentMethod, screenshotUrl } = booking;
  return `NEW BOOKING REQUEST\n\nRef: ${referenceNo}\nRoom: ${unitName}\nGuest: ${guestName}\nEmail: ${guestEmail}\nPhone: ${guestPhone || '—'}\nCheck-in: ${formatDate(checkIn)}\nCheck-out: ${formatDate(checkOut)}\nNights: ${nights}\nPayment: ${paymentMethod}\nTotal: PHP ${Number(grandTotal).toFixed(2)}\n${screenshotUrl ? `\nScreenshot: ${screenshotUrl}` : ''}\n\nAdmin Panel: https://staycation-admin-ph.netlify.app\n`;
}

exports.handler = async (event) => {
  const origin = event.headers && (event.headers.origin || event.headers.Origin);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(origin), body: '' };
  if (event.httpMethod !== 'POST') return j(405, { error: 'Method not allowed' }, origin);

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return j(400, { error: 'Invalid JSON' }, origin); }

  const { clientId, bookingId } = body;
  if (!clientId || !bookingId) return j(400, { error: 'clientId and bookingId are required' }, origin);

  // Fetch booking and settings from Firestore — never trust caller data
  let booking, settings;
  try {
    [booking, settings] = await Promise.all([
      getBooking(clientId, bookingId),
      getSettings(clientId),
    ]);
  } catch (err) {
    console.error('Firestore fetch error:', err.message);
    return j(404, { error: err.message }, origin);
  }

  // Validate booking state
  if (!['pending_review', 'pending_payment'].includes(booking.status)) {
    return j(422, { error: `Cannot send receipt for booking in status: ${booking.status}` }, origin);
  }

  // Idempotency — use a transaction to atomically check + set receiptSentAt
  const bookingRef = db.doc(`clients/${clientId}/bookings/${bookingId}`);
  let alreadySent = false;
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(bookingRef);
      if (snap.data().receiptSentAt) {
        alreadySent = true;
        return; // Don't throw — just flag
      }
      tx.update(bookingRef, { receiptSentAt: FieldValue.serverTimestamp() });
    });
  } catch (err) {
    console.error('Idempotency transaction error:', err.message);
    return j(500, { error: 'Failed to check idempotency' }, origin);
  }

  if (alreadySent) {
    console.log(`Receipt already sent for ${bookingId} — returning success without re-sending`);
    return j(200, { success: true, alreadySent: true }, origin);
  }

  const { smtpEmail, smtpPassword } = settings.private;
  if (!smtpEmail || !smtpPassword) return j(500, { error: 'SMTP not configured for this client' }, origin);

  // Send guest receipt email
  try {
    const transporter = createTransport(smtpEmail, smtpPassword);
    await transporter.sendMail({
      from: `"${settings.public.companyName || clientId}" <${smtpEmail}>`,
      to: booking.guestEmail,
      subject: `Booking Request Received — ${booking.referenceNo}`,
      text: buildText(settings, booking),
      html: buildHtml(settings, booking),
    });
  } catch (err) {
    // Roll back the idempotency flag so they can retry
    await bookingRef.update({ receiptSentAt: FieldValue.delete() }).catch(() => {});
    console.error('Email send error:', err.message);
    await logNotification(clientId, { type: 'receipt', bookingId, recipient: booking.guestEmail, success: false, error: err.message, retryCount: 0 });
    return j(500, { error: `Email send failed: ${err.message}` }, origin);
  }

  await logNotification(clientId, { type: 'receipt', bookingId, recipient: booking.guestEmail, success: true, error: null, retryCount: 0 });

  // Admin email notification — fire-and-forget (never blocks guest response)
  try {
    const transporter = createTransport(smtpEmail, smtpPassword);
    await transporter.sendMail({
      from: `"${settings.public.companyName || clientId}" <${smtpEmail}>`,
      to: settings.private.notificationEmail || smtpEmail,
      subject: `🔔 New Booking Request — ${booking.referenceNo}`,
      text: buildAdminText(settings, booking),
      html: buildAdminHtml(settings, booking),
    });
  } catch (err) {
    console.error('Admin notification email error (non-fatal):', err.message);
  }

  // Telegram alert to admin (optional — fire-and-forget)
  const { telegramToken, telegramChatId } = settings.private;
  if (telegramToken && telegramChatId) {
    const msg = [
      `🔔 <b>New Booking Alert</b>`,
      ``,
      `<b>Ref:</b> ${booking.referenceNo}`,
      `<b>Guest:</b> ${booking.guestName}`,
      `<b>Room:</b> ${booking.unitName}`,
      `<b>Dates:</b> ${booking.checkIn} → ${booking.checkOut} (${booking.nights} night${Number(booking.nights) !== 1 ? 's' : ''})`,
      `<b>Total:</b> ${formatCurrency(booking.grandTotal)}`,
      `<b>Payment:</b> ${booking.paymentMethod}`,
      booking.screenshotUrl ? `<b>Screenshot:</b> <a href="${booking.screenshotUrl}">View</a>` : null,
      `<b>Admin Panel:</b> <a href="https://staycation-admin-ph.netlify.app">Open</a>`,
    ].filter(Boolean).join('\n');
    sendTelegram(telegramToken, telegramChatId, msg).catch(err => console.error('Telegram error (non-fatal):', err.message));
  }

  return j(200, { success: true }, origin);
};
