/**
 * send-cancel — called by admin panel when admin cancels a confirmed booking.
 * Accepts ONLY { clientId, bookingId, adminNote? }.
 * Atomically transitions confirmed → cancelled and releases inventory.
 */

const {
  db, FieldValue,
  json, getSettings, releaseInventory, updateAvailability, logNotification,
  formatDate, formatCurrency,
  createTransport,
  emailHeader, emailFooter, refBox, detailTable, noticeBanner,
} = require('./_shared');

function buildHtml(settings, booking) {
  const { companyName = 'Property', phone, email: contactEmail } = settings.public;
  const { referenceNo, guestName, unitName, checkIn, checkOut, adminNote } = booking;
  const contactLine = [phone, contactEmail].filter(Boolean).join(' | ');

  return emailHeader(companyName, 'Booking Cancellation Notice', '#555555', '#cccccc')
    + `<p style="margin:0 0 8px;font-size:16px;color:#333;">Hi <strong>${guestName}</strong>,</p>
       <p style="margin:0 0 24px;font-size:15px;color:#555;line-height:1.6;">
         We regret to inform you that your confirmed booking has been <strong>cancelled</strong>. We sincerely apologize for any inconvenience.
       </p>`
    + refBox(referenceNo, '#f5f5f5', '#999999', '#555555')
    + detailTable([
        ['Property', unitName, 'font-weight:600;'],
        ['Check-in', formatDate(checkIn)],
        ['Check-out', formatDate(checkOut)],
        ['Status', '<span style="color:#c62828;font-weight:600;">Cancelled</span>'],
      ])
    + (adminNote ? `<div style="background:#fce4ec;border-left:4px solid #c62828;padding:14px 18px;border-radius:4px;margin-bottom:28px;">
         <p style="margin:0 0 6px;font-size:13px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Reason</p>
         <p style="margin:0;font-size:14px;color:#555;line-height:1.6;">${adminNote}</p>
       </div>` : '')
    + noticeBanner('💬 For questions about your reservation fee or deposit, please contact us directly.', '#fff8e1', '#f9a825')
    + (contactLine ? `<p style="margin:0 0 8px;font-size:14px;color:#555;">Reach us at:</p><p style="margin:0 0 16px;font-size:14px;color:#333;font-weight:600;">${contactLine}</p>` : '')
    + `<p style="margin:0;font-size:14px;color:#555;line-height:1.6;">We hope to have the opportunity to host you in the future. Thank you for your understanding.</p>`
    + emailFooter(companyName);
}

function buildText(settings, booking) {
  const { companyName = 'Property', phone, email: contactEmail } = settings.public;
  const { referenceNo, guestName, unitName, checkIn, checkOut, adminNote } = booking;
  const contactLine = [phone, contactEmail].filter(Boolean).join(' | ');
  return `Hi ${guestName},\n\nWe regret to inform you that your booking at ${companyName} has been CANCELLED.\n\nRef: ${referenceNo}\nProperty: ${unitName}\nCheck-in: ${formatDate(checkIn)}\nCheck-out: ${formatDate(checkOut)}\nStatus: Cancelled\n${adminNote ? `\nReason: ${adminNote}\n` : ''}\nFor questions about your reservation fee or deposit, contact us:\n${contactLine || companyName}\n\nWe apologize for the inconvenience,\n${companyName}\n`;
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

  // Atomic status transition: confirmed → cancelled
  const bookingRef = db.doc(`clients/${clientId}/bookings/${bookingId}`);
  let booking;
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(bookingRef);
      if (!snap.exists) throw new Error('Booking not found');
      const data = snap.data();
      if (data.status !== 'confirmed') throw new Error(`Cannot cancel booking in status: ${data.status}`);
      booking = data;
      tx.update(bookingRef, {
        status: 'cancelled',
        cancelledAt: FieldValue.serverTimestamp(),
        ...(adminNote ? { adminNote } : {}),
      });
    });
  } catch (err) {
    return json(err.message.includes('Cannot cancel') ? 422 : 404, { error: err.message }, origin);
  }

  booking = { ...booking, ...(adminNote ? { adminNote } : {}) };

  // Release inventory so dates can be re-booked
  await releaseInventory(booking.unitId, booking.checkIn, booking.checkOut)
    .catch(err => console.error('Inventory release error (non-fatal):', err.message));

  // Update public availability record
  await updateAvailability(clientId, bookingId, 'cancelled')
    .catch(err => console.error('Availability update error (non-fatal):', err.message));

  const { smtpEmail, smtpPassword } = settings.private;
  if (!smtpEmail || !smtpPassword) return json(500, { error: 'SMTP not configured' }, origin);

  try {
    const transporter = createTransport(smtpEmail, smtpPassword);
    await transporter.sendMail({
      from: `"${settings.public.companyName || clientId}" <${smtpEmail}>`,
      to: booking.guestEmail,
      subject: `Booking Cancellation Notice — ${booking.referenceNo}`,
      text: buildText(settings, booking),
      html: buildHtml(settings, booking),
    });
  } catch (err) {
    console.error('Email send error:', err.message);
    await logNotification(clientId, { type: 'cancel', bookingId, recipient: booking.guestEmail, success: false, error: err.message, retryCount: 0 });
    return json(500, { error: `Email failed: ${err.message}` }, origin);
  }

  await logNotification(clientId, { type: 'cancel', bookingId, recipient: booking.guestEmail, success: true, error: null, retryCount: 0 });
  return json(200, { success: true }, origin);
};
