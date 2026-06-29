/**
 * admin-auth.js — shared authentication guard for all admin pages.
 *
 * Usage on every protected page:
 *   import { requireAuth, adminSignOut } from './admin-auth.js';
 *   const { user, clientId } = await requireAuth();
 *
 * clientId ALWAYS comes from Firestore admins/{email}.clientId — never from
 * URL params, localStorage, or caller-supplied values.
 */

import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getAuth,
  onAuthStateChanged,
  signOut as fbSignOut,
  sendPasswordResetEmail,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  getFirestore,
  doc,
  getDoc,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { FIREBASE_CONFIG } from './firebase-config.js';

// Initialize Firebase once — safe to call multiple times across pages
function getFirebaseInstances() {
  const app = getApps().length ? getApps()[0] : initializeApp(FIREBASE_CONFIG);
  return { app, auth: getAuth(app), db: getFirestore(app) };
}

export function getAdminFirebase() {
  return getFirebaseInstances();
}

/**
 * Waits for Firebase Auth to settle, then verifies the user has an
 * admins/{email} doc in Firestore. Redirects to /index.html if not.
 * Returns { user, clientId } on success.
 */
export function requireAuth() {
  const { auth, db } = getFirebaseInstances();
  return new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      unsub(); // only need the first state event
      if (!user) {
        window.location.replace('/index.html');
        return;
      }
      try {
        const snap = await getDoc(doc(db, 'admins', user.email));
        if (!snap.exists()) {
          await fbSignOut(auth);
          window.location.replace('/index.html');
          return;
        }
        const clientId = snap.data().clientId;
        if (!clientId) {
          await fbSignOut(auth);
          window.location.replace('/index.html');
          return;
        }
        resolve({ user, clientId });
      } catch (err) {
        console.error('requireAuth failed:', err.message);
        window.location.replace('/index.html');
      }
    });
  });
}

/** Signs out and redirects to login. */
export async function adminSignOut() {
  const { auth } = getFirebaseInstances();
  try { await fbSignOut(auth); } catch (_) {}
  window.location.replace('/index.html');
}

/** Sends a password-reset email. Throws on failure. */
export async function sendReset(email) {
  const { auth } = getFirebaseInstances();
  await sendPasswordResetEmail(auth, email);
}
