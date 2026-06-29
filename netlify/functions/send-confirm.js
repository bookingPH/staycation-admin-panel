/**
 * send-confirm — called by admin panel when admin clicks "Confirm".
 * Accepts ONLY { clientId, bookingId, adminNote? }.
 * Uses a Firestore transaction to atomically verify status + update to confirmed.
 * Inventory stays claimed (confirmed = permanently blocked).
 */

const {
  db, FieldValue,
  json, getSettings, logNotification, updateAvailability,
  formatDate, formatCurrency,
  createTransport,
  emailHeader, emailFooter, refBox, detailTable, noticeBanner,
} = require('./_shared');

function buildHtml(settings, booking, adminNote) {
  const { companyName = 'Property', address, phone, email: contactEmail } = settings.public;
  const { referenceNo, guestName, unitName, checkIn, checkOut, nights, grandTotal, paymentMethod } = booking;
  const checkInTime = booking.checkInTime || settings.public.checkInTime || '2:00 PM';
  const checkOutTime = booking.checkOutTime || settings.public.checkOutTime || '12:00 PM';
  const contactLine = [phone, contactEmail].filter(Boolean).join(' | ');

  return emailHeader(companyName, '✅ Booking Confirmed', '#2e7d32', '#a5d6a7')
    + `<p style="margin:0 0 8px;font-size:16px;color:#333;">Hi <strong>${guestName}</strong>,</p>
       <p style="margin:0 0 24px;font-size:15px;color:#555;line-height:1.6;">
         Great news! Your booking has been <strong>confirmed</strong>. We look forward to hosting you!
       </p>`
    + refBox(referenceNo, '#f1f8f1', '#2e7d32', '#2e7d32')
    + detailTable([
        ['Property', unitName, 'font-weight:600;'],
        ['Check-in', `${formatDate(checkIn)} at ${checkInTime}`],
        ['Check-out', `${formatDate(checkOut)} at ${checkOutTime}`],
        ['Nights', `${nights} night${Number(nights) !== 1 ? 's' : ''}`],
        ['Payment Method', paymentMethod],
        ...(address ? [['Address', address]] : []),
        ['Grand Total', `<span style="font-size:18px;color:#2e7d32;font-weight:700;">${formatCurrency(grandTotal)}</span>`, 'border-top:1px solid #eee;padding-top:12px;'],
      ])
    + noticeBanner(`✅ <strong>Status: Confirmed</strong><br>See you on <strong>${formatDate(checkIn)}</strong>! Please be ready at check-in time.`, '#e8f5e9', '#2e7d32')
    + (adminNote ? noticeBanner(`<strong>Note from us:</strong><br>${adminNote}`, '#f0f7f0', '#2e7d32') : '')
    + `<p style="margin:0 0 8px;font-size:14px;color:#555;">Need to cancel or reschedule? Please contact us early:</p>`
    + (contactLine ? `<p style="margin:0 0 16px;font-size:14px;color:#333;font-weight:600;">${contactLine}</p>` : '')
    + `<p style="margin:0;font-size:14px;color:#555;">Thank you for choosing <strong>${companyName}</strong>!</p>`
    + emailFooter(companyName);
}

function buildText(settings, booking, adminNote) {
  const { companyName = 'Property', phone, email: contactEmail } = settings.public;
  const { referenceNo, guestName, unitName, checkIn, checkOut, nights, grandTotal, paymentMethod } = booking;
  const checkInTime = booking.checkInTime || settings.public.checkInTime || '2:00 PM';
  const checkOutTime = booking.checkOutTime || settings.public.checkOutTime || '12:00 PM';
  const contactLine = [phone, contactEmail].filter(Boolean).join(' | ');
  return `Hi ${guestName},\n\nYour booking at ${companyName} is CONFIRMED!\n\nRef: ${referenceNo}\nProperty: ${unitName}\nCheck-in: ${formatDate(checkIn)} at ${checkInTime}\nCheck-out: ${formatDate(checkOut)} at ${checkOutTime}\nNights: ${nights}\nPayment: ${paymentMethod}\nTotal: PHP ${Number(grandTotal).toFixed(2)}\n${adminNote ? `\nNote: ${adminNote}\n` : ''}\nContact us: ${contactLine || companyName}\n\nSee you on ${formatDate(checkIn)}!\n${companyName}\n`;
}

exports.handler = async (event) => {
  const origin = event.headers && (event.headers.origin || event.headers.Origin);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' }, origin);

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }, origin); }

  const { clientId, bookingId, adminNote } = body;
  if (!clientId || !bookingId) return json(400, { error: 'clientId and bookingId are required' }, origin);

  let settings;
  try { settings = await getSettings(clientId); }
  catch (err) { return json(500, { error: err.message }, origin); }

  // Atomic status transition: pending_review → confirmed
  const bookingRef = db.doc(`clients/${clientId}/bookings/${bookingId}`);
  let booking;
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(bookingRef);
      if (!snap.exists) throw new Error('Booking not found');
      const data = snap.data();
      if (data.status !== 'pending_review') throw new Error(`Cannot confirm booking in status: ${data.status}`);
      booking = data;
      tx.update(bookingRef, {
        status: 'confirmed',
        confirmedAt: FieldValue.serverTimestamp(),
        ...(adminNote ? { adminNote } : {}),
      });
    });
  } catch (err) {
    return json(err.message.includes('Cannot confirm') ? 422 : 404, { error: err.message }, origin);
  }

  // Update public availability record
  await updateAvailability(clientId, bookingId, 'confirmed').catch(err => console.error('Availability update error (non-fatal):', err.message));

  const { smtpEmail, smtpPassword } = settings.private;
  if (!smtpEmail || !smtpPassword) return json(500, { error: 'SMTP not configured' }, origin);

  try {
    const transporter = createTransport(smtpEmail, smtpPassword);
    await transporter.sendMail({
      from: `"${settings.public.companyName || clientId}" <${smtpEmail}>`,
      to: booking.guestEmail,
      subject: `✅ Booking Confirmed — ${booking.referenceNo}`,
      text: buildText(settings, booking, adminNote),
      html: buildHtml(settings, booking, adminNote),
    });
  } catch (err) {
    console.error('Email send error:', err.message);
    await logNotification(clientId, { type: 'confirm', bookingId, recipient: booking.guestEmail, success: false, error: err.message, retryCount: 0 });
    return json(500, { error: `Email failed: ${err.message}` }, origin);
  }

  await logNotification(clientId, { type: 'confirm', bookingId, recipient: booking.guestEmail, success: true, error: null, retryCount: 0 });
  return json(200, { success: true }, origin);
};
