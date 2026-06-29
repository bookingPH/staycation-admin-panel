/**
 * send-reject — called by admin panel when admin clicks "Reject".
 * Accepts ONLY { clientId, bookingId, adminNote }.
 * adminNote is required (enforced server-side — admin must give a reason).
 * Atomically transitions pending_review → rejected and releases inventory.
 */

const {
  db, FieldValue,
  json, getSettings, releaseInventory, updateAvailability, logNotification,
  formatDate, formatCurrency,
  createTransport,
  emailHeader, emailFooter, refBox, detailTable, noticeBanner,
} = require('./_shared');

function buildHtml(settings, booking) {
  const { companyName = 'Property', phone, email: contactEmail, bookingWebsiteUrl } = settings.public;
  const { referenceNo, guestName, unitName, checkIn, checkOut, adminNote } = booking;
  const contactLine = [phone, contactEmail].filter(Boolean).join(' | ');

  return emailHeader(companyName, 'Booking Update')
    + `<p style="margin:0 0 8px;font-size:16px;color:#333;">Hi <strong>${guestName}</strong>,</p>
       <p style="margin:0 0 24px;font-size:15px;color:#555;line-height:1.6;">
         We're sorry to inform you that we were unable to confirm your booking request. Please see the reason below.
       </p>`
    + refBox(referenceNo)
    + detailTable([
        ['Property', unitName, 'font-weight:600;'],
        ['Check-in', formatDate(checkIn)],
        ['Check-out', formatDate(checkOut)],
      ])
    + `<div style="background:#fff3e0;border-left:4px solid #e65100;padding:14px 18px;border-radius:4px;margin-bottom:28px;">
         <p style="margin:0 0 6px;font-size:13px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Reason</p>
         <p style="margin:0;font-size:14px;color:#555;line-height:1.6;">${adminNote}</p>
       </div>`
    + `<p style="margin:0 0 12px;font-size:14px;color:#555;line-height:1.6;">
         We apologize for the inconvenience. You're welcome to submit a new booking request.
       </p>`
    + (bookingWebsiteUrl ? `<p style="margin:0 0 20px;"><a href="${bookingWebsiteUrl}" style="background:#C8623A;color:#fff;padding:12px 24px;border-radius:4px;text-decoration:none;font-size:14px;font-weight:600;display:inline-block;">Book Again</a></p>` : '')
    + (contactLine ? `<p style="margin:0;font-size:14px;color:#555;">For questions, contact us: <strong>${contactLine}</strong></p>` : '')
    + emailFooter(companyName);
}

function buildText(settings, booking) {
  const { companyName = 'Property', phone, email: contactEmail, bookingWebsiteUrl } = settings.public;
  const { referenceNo, guestName, unitName, checkIn, checkOut, adminNote } = booking;
  const contactLine = [phone, contactEmail].filter(Boolean).join(' | ');
  return `Hi ${guestName},\n\nWe're sorry — your booking request at ${companyName} could not be confirmed.\n\nRef: ${referenceNo}\nProperty: ${unitName}\nCheck-in: ${formatDate(checkIn)}\nCheck-out: ${formatDate(checkOut)}\n\nReason: ${adminNote}\n\nYou're welcome to submit a new booking request.${bookingWebsiteUrl ? `\nBook again: ${bookingWebsiteUrl}` : ''}${contactLine ? `\nContact us: ${contactLine}` : ''}\n\nWe apologize for the inconvenience,\n${companyName}\n`;
}

exports.handler = async (event) => {
  const origin = event.headers && (event.headers.origin || event.headers.Origin);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' }, origin);

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }, origin); }

  const { clientId, bookingId, adminNote } = body;
  if (!clientId || !bookingId) return json(400, { error: 'clientId and bookingId are required' }, origin);
  if (!adminNote || !adminNote.trim()) return json(400, { error: 'adminNote is required for rejection — give the guest a reason' }, origin);

  let settings;
  try { settings = await getSettings(clientId); }
  catch (err) { return json(500, { error: err.message }, origin); }

  // Atomic status transition: pending_review → rejected
  const bookingRef = db.doc(`clients/${clientId}/bookings/${bookingId}`);
  let booking;
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(bookingRef);
      if (!snap.exists) throw new Error('Booking not found');
      const data = snap.data();
      if (data.status !== 'pending_review') throw new Error(`Cannot reject booking in status: ${data.status}`);
      booking = data;
      tx.update(bookingRef, {
        status: 'rejected',
        adminNote: adminNote.trim(),
        rejectedAt: FieldValue.serverTimestamp(),
      });
    });
  } catch (err) {
    return json(err.message.includes('Cannot reject') ? 422 : 404, { error: err.message }, origin);
  }

  // Store adminNote on booking object for email builder
  booking = { ...booking, adminNote: adminNote.trim() };

  // Release inventory so dates become available again
  await releaseInventory(booking.unitId, booking.checkIn, booking.checkOut)
    .catch(err => console.error('Inventory release error (non-fatal):', err.message));

  // Update public availability record
  await updateAvailability(clientId, bookingId, 'rejected')
    .catch(err => console.error('Availability update error (non-fatal):', err.message));

  const { smtpEmail, smtpPassword } = settings.private;
  if (!smtpEmail || !smtpPassword) return json(500, { error: 'SMTP not configured' }, origin);

  try {
    const transporter = createTransport(smtpEmail, smtpPassword);
    await transporter.sendMail({
      from: `"${settings.public.companyName || clientId}" <${smtpEmail}>`,
      to: booking.guestEmail,
      subject: `Booking Update — ${booking.referenceNo}`,
      text: buildText(settings, booking),
      html: buildHtml(settings, booking),
    });
  } catch (err) {
    console.error('Email send error:', err.message);
    await logNotification(clientId, { type: 'reject', bookingId, recipient: booking.guestEmail, success: false, error: err.message, retryCount: 0 });
    return json(500, { error: `Email failed: ${err.message}` }, origin);
  }

  await logNotification(clientId, { type: 'reject', bookingId, recipient: booking.guestEmail, success: true, error: null, retryCount: 0 });
  return json(200, { success: true }, origin);
};
