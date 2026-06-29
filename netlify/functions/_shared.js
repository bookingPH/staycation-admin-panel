/**
 * Shared helpers for all Netlify booking functions.
 * All functions read data from Firestore — never trust caller-supplied booking data.
 */

const nodemailer = require('nodemailer');
const admin = require('firebase-admin');

// Initialize Firebase Admin once (survives warm Lambda invocations)
if (!admin.apps.length) {
  const raw = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8').replace(/^﻿/, '');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
}

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function corsHeaders(origin) {
  const allowed = ['https://bookingph.github.io', 'https://staycation-admin-ph.netlify.app'];
  const allowOrigin = allowed.includes(origin) ? origin : 'https://staycation-admin-ph.netlify.app';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function json(statusCode, body, origin) {
  return {
    statusCode,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// ---------------------------------------------------------------------------
// Firestore helpers
// ---------------------------------------------------------------------------

async function getSettings(clientId) {
  const [pubSnap, privSnap] = await Promise.all([
    db.doc(`clients/${clientId}/settings/public`).get(),
    db.doc(`clients/${clientId}/settings/private`).get(),
  ]);
  if (!pubSnap.exists) throw new Error(`No settings/public for clientId: ${clientId}`);
  if (!privSnap.exists) throw new Error(`No settings/private for clientId: ${clientId}`);
  return { public: pubSnap.data(), private: privSnap.data() };
}

async function getBooking(clientId, bookingId) {
  const snap = await db.doc(`clients/${clientId}/bookings/${bookingId}`).get();
  if (!snap.exists) throw new Error(`Booking not found: ${clientId}/${bookingId}`);
  return snap.data();
}

// Release per-night inventory for a booking (called on reject or cancel)
async function releaseInventory(unitId, checkIn, checkOut) {
  const nights = getDateRange(checkIn, checkOut);
  if (nights.length === 0) return;
  const batch = db.batch();
  for (const date of nights) {
    batch.delete(db.doc(`inventory/${unitId}_${date}`));
  }
  await batch.commit();
}

// Update the public availability record status
async function updateAvailability(clientId, bookingId, status) {
  const ref = db.doc(`clients/${clientId}/availability/${bookingId}`);
  const snap = await ref.get();
  if (snap.exists) await ref.update({ status, updatedAt: FieldValue.serverTimestamp() });
}

// Write to notification log (fire-and-forget — never let this block email sending)
async function logNotification(clientId, entry) {
  try {
    await db.collection(`clients/${clientId}/notification_log`).add({
      ...entry,
      timestamp: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error('Notification log write failed (non-fatal):', err.message);
  }
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function getDateRange(checkIn, checkOut) {
  const dates = [];
  const current = new Date(checkIn + 'T00:00:00');
  const end = new Date(checkOut + 'T00:00:00');
  while (current < end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-PH', { weekday: 'short', year: 'numeric', month: 'long', day: 'numeric' });
}

function formatCurrency(amount) {
  return `₱${Number(amount).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;
}

// ---------------------------------------------------------------------------
// Email transport
// ---------------------------------------------------------------------------

function createTransport(smtpEmail, smtpPassword) {
  const port = Number(process.env.SMTP_PORT) || 587;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port,
    secure: port === 465,
    auth: { user: smtpEmail, pass: smtpPassword },
  });
}

// ---------------------------------------------------------------------------
// Telegram (optional, fire-and-forget)
// ---------------------------------------------------------------------------

async function sendTelegram(token, chatId, message) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
}

// ---------------------------------------------------------------------------
// Common email header/footer fragments
// ---------------------------------------------------------------------------

function emailHeader(companyName, subtitle, headerColor = '#C8623A', subtitleColor = '#f9d9cc') {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f1ee;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ee;padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:8px;overflow:hidden;">
<tr><td style="background:${headerColor};padding:32px 40px;text-align:center;">
  <h1 style="margin:0;color:#fff;font-size:24px;letter-spacing:0.5px;">${companyName}</h1>
  <p style="margin:8px 0 0;color:${subtitleColor};font-size:14px;">${subtitle}</p>
</td></tr>
<tr><td style="padding:40px;">`;
}

function emailFooter(companyName) {
  return `</td></tr>
<tr><td style="background:#f9f6f3;padding:24px 40px;text-align:center;border-top:1px solid #ece8e3;">
  <p style="margin:0;font-size:12px;color:#999;">${companyName}</p>
  <p style="margin:4px 0 0;font-size:11px;color:#bbb;">This is an automated email. Please do not reply directly.</p>
</td></tr>
</table></td></tr></table></body></html>`;
}

function refBox(referenceNo, boxColor = '#fdf7f4', borderColor = '#C8623A', textColor = '#C8623A') {
  return `<div style="background:${boxColor};border:2px solid ${borderColor};border-radius:6px;padding:16px 24px;margin-bottom:28px;text-align:center;">
  <p style="margin:0 0 4px;font-size:12px;color:#888;text-transform:uppercase;letter-spacing:1px;">Booking Reference</p>
  <p style="margin:0;font-size:26px;font-weight:bold;color:${textColor};letter-spacing:2px;">${referenceNo}</p>
</div>`;
}

function detailTable(rows) {
  const rowsHtml = rows.map(([label, value, style = '']) =>
    `<tr>
      <td style="padding:4px 0;font-size:13px;color:#888;">${label}</td>
      <td style="padding:4px 0;font-size:14px;color:#333;text-align:right;${style}">${value}</td>
    </tr>`
  ).join('');
  return `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
  <tr><td colspan="2" style="padding-bottom:12px;border-bottom:1px solid #eee;">
    <h3 style="margin:0;font-size:14px;text-transform:uppercase;letter-spacing:1px;color:#888;">Booking Details</h3>
  </td></tr>
  ${rowsHtml}
</table>`;
}

function noticeBanner(text, bg = '#fff8e1', border = '#f9a825') {
  return `<div style="background:${bg};border-left:4px solid ${border};padding:14px 18px;border-radius:4px;margin-bottom:28px;">
  <p style="margin:0;font-size:14px;color:#555;line-height:1.6;">${text}</p>
</div>`;
}

module.exports = {
  db, FieldValue, Timestamp,
  json, corsHeaders,
  getSettings, getBooking, releaseInventory, updateAvailability, logNotification,
  getDateRange, formatDate, formatCurrency,
  createTransport, sendTelegram,
  emailHeader, emailFooter, refBox, detailTable, noticeBanner,
};
