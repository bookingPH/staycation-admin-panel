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

function buildPricingBreakdown(booking) {
  const reservationFee = booking.reservationFee || 500;
  const securityDeposit = booking.securityDeposit || 0;
  const remainingBalance = Math.max(0, booking.grandTotal - reservationFee);
  const totalDueAtCheckin = remainingBalance + securityDeposit;

  let addonRows = '';
  if (Array.isArray(booking.addons) && booking.addons.length > 0) {
    addonRows = booking.addons.map(a =>
      `<tr>
        <td style="padding:4px 0;font-size:13px;color:#888;">${a.name}</td>
        <td style="padding:4px 0;font-size:14px;color:#333;text-align:right;">${formatCurrency(a.total)}</td>
      </tr>`
    ).join('');
  }
  const extraGuestRow = booking.extraGuestTotal > 0 ? `
    <tr>
      <td style="padding:4px 0;font-size:13px;color:#888;">Extra guests (${booking.extraGuests} pax)</td>
      <td style="padding:4px 0;font-size:14px;color:#333;text-align:right;">${formatCurrency(booking.extraGuestTotal)}</td>
    </tr>` : '';
  const secDepRow = securityDeposit > 0 ? `
    <tr>
      <td style="padding:4px 0;font-size:13px;color:#888;">Security deposit <em style="font-size:0.85em;">(refundable at checkout)</em></td>
      <td style="padding:4px 0;font-size:14px;color:#333;text-align:right;">${formatCurrency(securityDeposit)}</td>
    </tr>` : '';

  return `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;background:#f9f9f9;border-radius:6px;overflow:hidden;">
  <tr><td colspan="2" style="padding:12px 16px 8px;border-bottom:1px solid #eee;">
    <h3 style="margin:0;font-size:14px;text-transform:uppercase;letter-spacing:1px;color:#888;">Price Breakdown</h3>
  </td></tr>
  <tr>
    <td style="padding:8px 16px 4px;font-size:13px;color:#888;">Base rate (${booking.nights} night${Number(booking.nights) !== 1 ? 's' : ''})</td>
    <td style="padding:8px 16px 4px;font-size:14px;color:#333;text-align:right;">${formatCurrency(booking.baseTotal)}</td>
  </tr>
  ${extraGuestRow}
  ${addonRows}
  <tr><td colspan="2" style="padding:0 16px;"><hr style="border:none;border-top:1px solid #ddd;margin:6px 0;"></td></tr>
  <tr>
    <td style="padding:4px 16px;font-size:14px;font-weight:700;color:#333;">Grand Total</td>
    <td style="padding:4px 16px;font-size:16px;font-weight:700;color:#333;text-align:right;">${formatCurrency(booking.grandTotal)}</td>
  </tr>
  <tr><td colspan="2" style="padding:0 16px;"><hr style="border:none;border-top:2px solid #ddd;margin:6px 0;"></td></tr>
  <tr>
    <td style="padding:4px 16px;font-size:13px;color:#888;">Reservation fee paid ✓</td>
    <td style="padding:4px 16px;font-size:14px;color:#2e7d32;font-weight:600;text-align:right;">${formatCurrency(reservationFee)}</td>
  </tr>
  <tr>
    <td style="padding:4px 16px;font-size:13px;color:#888;">Remaining balance</td>
    <td style="padding:4px 16px;font-size:14px;color:#333;text-align:right;">${formatCurrency(remainingBalance)}</td>
  </tr>
  ${secDepRow}
  <tr>
    <td style="padding:8px 16px;font-size:14px;font-weight:700;color:#C8623A;border-top:1px solid #eee;">Total due at check-in</td>
    <td style="padding:8px 16px;font-size:16px;font-weight:700;color:#C8623A;text-align:right;border-top:1px solid #eee;">${formatCurrency(totalDueAtCheckin)}</td>
  </tr>
</table>`;
}

function buildPricingText(booking) {
  const reservationFee = booking.reservationFee || 500;
  const securityDeposit = booking.securityDeposit || 0;
  const remainingBalance = Math.max(0, booking.grandTotal - reservationFee);
  const totalDueAtCheckin = remainingBalance + securityDeposit;
  let lines = ['\n--- PRICE BREAKDOWN ---'];
  lines.push(`Base rate (${booking.nights} night${Number(booking.nights) !== 1 ? 's' : ''}): PHP ${Number(booking.baseTotal).toFixed(2)}`);
  if (booking.extraGuestTotal > 0) lines.push(`Extra guests (${booking.extraGuests} pax): PHP ${Number(booking.extraGuestTotal).toFixed(2)}`);
  if (Array.isArray(booking.addons) && booking.addons.length > 0) {
    booking.addons.forEach(a => lines.push(`${a.name}: PHP ${Number(a.total).toFixed(2)}`));
  }
  lines.push(`Grand Total: PHP ${Number(booking.grandTotal).toFixed(2)}`);
  lines.push(`\nReservation fee paid: PHP ${Number(reservationFee).toFixed(2)}`);
  lines.push(`Remaining balance: PHP ${Number(remainingBalance).toFixed(2)}`);
  if (securityDeposit > 0) lines.push(`Security deposit (refundable at checkout): PHP ${Number(securityDeposit).toFixed(2)}`);
  lines.push(`Total due at check-in: PHP ${Number(totalDueAtCheckin).toFixed(2)}`);
  lines.push('-----------------------');
  return lines.join('\n');
}

function buildHtml(settings, booking, adminNote) {
  const { companyName = 'Property', address, phone, email: contactEmail } = settings.public;
  const { referenceNo, guestName, unitName, checkIn, checkOut, nights, paymentMethod } = booking;
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
      ])
    + buildPricingBreakdown(booking)
    + noticeBanner(`✅ <strong>Status: Confirmed</strong><br>See you on <strong>${formatDate(checkIn)}</strong>! Please be ready at check-in time.`, '#e8f5e9', '#2e7d32')
    + (adminNote ? noticeBanner(`<strong>Note from us:</strong><br>${adminNote}`, '#f0f7f0', '#2e7d32') : '')
    + `<p style="margin:0 0 8px;font-size:14px;color:#555;">Need to cancel or reschedule? Please contact us early:</p>`
    + (contactLine ? `<p style="margin:0 0 16px;font-size:14px;color:#333;font-weight:600;">${contactLine}</p>` : '')
    + `<p style="margin:0;font-size:14px;color:#555;">Thank you for choosing <strong>${companyName}</strong>!</p>`
    + emailFooter(companyName);
}

function buildText(settings, booking, adminNote) {
  const { companyName = 'Property', phone, email: contactEmail } = settings.public;
  const { referenceNo, guestName, unitName, checkIn, checkOut, nights, paymentMethod } = booking;
  const checkInTime = booking.checkInTime || settings.public.checkInTime || '2:00 PM';
  const checkOutTime = booking.checkOutTime || settings.public.checkOutTime || '12:00 PM';
  const contactLine = [phone, contactEmail].filter(Boolean).join(' | ');
  return `Hi ${guestName},\n\nYour booking at ${companyName} is CONFIRMED!\n\nRef: ${referenceNo}\nProperty: ${unitName}\nCheck-in: ${formatDate(checkIn)} at ${checkInTime}\nCheck-out: ${formatDate(checkOut)} at ${checkOutTime}\nNights: ${nights}\nPayment: ${paymentMethod}\n${buildPricingText(booking)}\n${adminNote ? `\nNote: ${adminNote}\n` : ''}\nContact us: ${contactLine || companyName}\n\nSee you on ${formatDate(checkIn)}!\n${companyName}\n`;
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
