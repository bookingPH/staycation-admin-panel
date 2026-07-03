/**
 * check-trials — auto-suspends T4 clients whose trial period has ended.
 * Called once daily via cron-job.org.
 *
 * A client is "on trial" when metaClients.trialEndsAt is set and trialConverted
 * is not true. If trialEndsAt has passed, this function:
 *   - Sets metaClients.active = false (same kill-switch field the master
 *     dashboard's Active/Suspended toggle uses)
 *   - Mirrors clients/{clientId}/settings/public.suspended = true (this is
 *     what actually takes their booking site offline, blocks new bookings
 *     server-side in create-booking.js, and blocks their own admin login)
 *
 * Converting a trial (via the "Convert" button on the master dashboard, which
 * sets trialConverted = true) permanently exempts a client from this check —
 * it will never re-suspend a converted trial even if trialEndsAt is in the past.
 *
 * Env var required: EXPIRE_SECRET (same secret already used by expire-holds.js)
 * URL params:
 *   ?secret=SECRET   required
 *   ?dryRun=true     logs what would happen without writing anything
 */

const { db } = require('./_shared');

exports.handler = async (event) => {
  const secret = (event.queryStringParameters || {}).secret;
  const EXPIRE_SECRET = process.env.EXPIRE_SECRET;

  if (!EXPIRE_SECRET || secret !== EXPIRE_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const dryRun = (event.queryStringParameters || {}).dryRun === 'true';
  const now = Date.now();

  let snap;
  try {
    snap = await db.collection('metaClients')
      .where('template', '==', 'T4')
      .get();
  } catch (err) {
    console.error('metaClients query failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }

  const expired = snap.docs.filter(d => {
    const c = d.data();
    if (!c.trialEndsAt || c.trialConverted === true) return false;
    if (c.active === false) return false; // already suspended — nothing to do
    return new Date(c.trialEndsAt).getTime() < now;
  });

  if (expired.length === 0) {
    console.log('check-trials: no expired trials found');
    return { statusCode: 200, body: JSON.stringify({ suspended: 0 }) };
  }

  console.log(`check-trials: found ${expired.length} expired trial(s) — dryRun=${dryRun}`);

  let suspended = 0;
  const errors = [];

  for (const metaDoc of expired) {
    const c = metaDoc.data();
    try {
      if (!dryRun) {
        const batch = db.batch();
        batch.update(metaDoc.ref, { active: false, status: 'Suspended' });
        if (c.clientId) {
          batch.set(db.doc(`clients/${c.clientId}/settings/public`), { suspended: true }, { merge: true });
        }
        await batch.commit();
      }
      suspended++;
      console.log(`  trial ended, auto-suspended: ${c.name || metaDoc.id} (clientId: ${c.clientId || 'n/a'})`);
    } catch (err) {
      console.error(`  failed to suspend ${metaDoc.id}:`, err.message);
      errors.push({ id: metaDoc.id, error: err.message });
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ suspended, dryRun, errors: errors.length ? errors : undefined }),
  };
};
