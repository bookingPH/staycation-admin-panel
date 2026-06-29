/**
 * expire-holds — releases abandoned inventory holds.
 * Called every 15 minutes via cron-job.org.
 *
 * A hold is "abandoned" when:
 *   - inventory status = 'held' AND expiresAt < now
 *   - The booking's receiptSentAt = null (guest never completed the flow)
 *
 * A hold is "legitimate" when receiptSentAt is set (guest paid, admin reviewing).
 * In that case we extend expiresAt 72hrs so the cron doesn't touch it again
 * while the admin decides.
 *
 * Env var required: EXPIRE_SECRET (set in Netlify — used to authenticate cron calls)
 * URL params:
 *   ?secret=SECRET   required
 *   ?dryRun=true     logs what would happen without writing anything
 */

const { db, FieldValue, Timestamp } = require('./_shared');

exports.handler = async (event) => {
  const secret = (event.queryStringParameters || {}).secret;
  const EXPIRE_SECRET = process.env.EXPIRE_SECRET;

  if (!EXPIRE_SECRET || secret !== EXPIRE_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const dryRun = (event.queryStringParameters || {}).dryRun === 'true';
  const now = Timestamp.now();

  let expiredSnaps;
  try {
    expiredSnaps = await db.collection('inventory')
      .where('status', '==', 'held')
      .where('expiresAt', '<', now)
      .get();
  } catch (err) {
    // Composite index not yet created — log the URL from the error to create it
    console.error('inventory query failed (may need a composite index):', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }

  if (expiredSnaps.empty) {
    console.log('expire-holds: no expired holds found');
    return { statusCode: 200, body: JSON.stringify({ released: 0, extended: 0 }) };
  }

  console.log(`expire-holds: found ${expiredSnaps.size} expired hold(s) — dryRun=${dryRun}`);

  let released = 0;
  let extended = 0;
  const errors = [];

  for (const invDoc of expiredSnaps.docs) {
    const { bookingId, clientId } = invDoc.data();

    try {
      const bookingRef = db.doc(`clients/${clientId}/bookings/${bookingId}`);
      const bookingSnap = await bookingRef.get();

      // No booking doc — orphaned inventory slot, just remove it
      if (!bookingSnap.exists) {
        if (!dryRun) await invDoc.ref.delete();
        released++;
        console.log(`  deleted orphaned hold: ${invDoc.id}`);
        continue;
      }

      const booking = bookingSnap.data();

      // Safety guard: never touch a confirmed or already-rejected booking's inventory
      if (['confirmed', 'rejected', 'cancelled', 'expired'].includes(booking.status)) {
        if (!dryRun) await invDoc.ref.delete();
        released++;
        console.log(`  cleaned up stale hold for ${booking.status} booking: ${bookingId}`);
        continue;
      }

      if (booking.receiptSentAt) {
        // Guest completed the booking — admin hasn't confirmed yet.
        // Extend hold by 72 hours so we don't accidentally release a real booking.
        if (!dryRun) {
          await invDoc.ref.update({
            expiresAt: Timestamp.fromMillis(now.toMillis() + 72 * 60 * 60 * 1000),
          });
        }
        extended++;
        console.log(`  extended hold for legitimate booking: ${bookingId}`);
      } else {
        // Guest abandoned — release the hold and clean up
        if (!dryRun) {
          const batch = db.batch();

          // Remove inventory slot so the night becomes bookable again
          batch.delete(invDoc.ref);

          // Mark availability as expired so the calendar stops blocking the dates
          const availRef = db.doc(`clients/${clientId}/availability/${bookingId}`);
          const availSnap = await availRef.get();
          if (availSnap.exists) {
            batch.update(availRef, { status: 'expired' });
          }

          // Mark booking as expired
          batch.update(bookingRef, {
            status: 'expired',
            expiredAt: FieldValue.serverTimestamp(),
          });

          await batch.commit();
        }
        released++;
        console.log(`  released abandoned hold: ${invDoc.id} (booking: ${bookingId})`);
      }
    } catch (err) {
      console.error(`  error processing ${invDoc.id}:`, err.message);
      errors.push({ id: invDoc.id, error: err.message });
    }
  }

  const result = { dryRun, released, extended, errors: errors.length ? errors : undefined };
  console.log('expire-holds result:', result);
  return { statusCode: 200, body: JSON.stringify(result) };
};
