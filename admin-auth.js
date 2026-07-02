/**
 * admin-auth.js — shared authentication guard for all admin pages.
 *
 * Usage on every protected (per-client) page:
 *   import { requireAuth, adminSignOut } from './admin-auth.js';
 *   const { user, clientId, isMaster } = await requireAuth();
 *
 * Usage on master-only pages (master-dashboard.html, client-select.html):
 *   import { requireMasterAuth, adminSignOut } from './admin-auth.js';
 *   const { user } = await requireMasterAuth();
 *
 * For a normal client admin, clientId ALWAYS comes from Firestore
 * admins/{email}.clientId — never from URL params, localStorage, or
 * caller-supplied values.
 *
 * For the master admin (admins/{email}.role === 'master'), clientId comes
 * from sessionStorage 'masterViewClientId', set by client-select.html when
 * master clicks "Enter Panel" on a T4 client. If unset, requireAuth() sends
 * master back to master-dashboard.html rather than erroring.
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

const MASTER_VIEW_KEY = 'masterViewClientId';

/**
 * Waits for Firebase Auth to settle, then verifies the user has an
 * admins/{email} doc in Firestore. Redirects to /index.html if not.
 *
 * Normal client admin: returns { user, clientId, isMaster: false }.
 * Master admin: reads sessionStorage[masterViewClientId] (set by
 * client-select.html) and returns { user, clientId, isMaster: true }.
 * If master has not picked a client yet, redirects to master-dashboard.html.
 * Also injects a "Switch Client" button into the sidebar for master.
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
        const data = snap.data();

        if (data.role === 'master') {
          const clientId = sessionStorage.getItem(MASTER_VIEW_KEY);
          if (!clientId) {
            window.location.replace('/master-dashboard.html');
            return;
          }
          injectSwitchClientButton();
          resolve({ user, clientId, isMaster: true });
          return;
        }

        const clientId = data.clientId;
        if (!clientId) {
          await fbSignOut(auth);
          window.location.replace('/index.html');
          return;
        }

        // Kill switch: if master has suspended this client, block their own admin login.
        try {
          const pubSnap = await getDoc(doc(db, 'clients', clientId, 'settings', 'public'));
          if (pubSnap.exists() && pubSnap.data().suspended === true) {
            await fbSignOut(auth);
            window.location.replace('/index.html?suspended=1');
            return;
          }
        } catch (_) {
          // If this check fails, fail open rather than lock out a paying client
          // over a transient read error — master can still suspend via the dashboard.
        }

        resolve({ user, clientId, isMaster: false });
      } catch (err) {
        console.error('requireAuth failed:', err.message);
        window.location.replace('/index.html');
      }
    });
  });
}

/**
 * Waits for Firebase Auth to settle, then verifies the user is the master
 * admin (admins/{email}.role === 'master'). Redirects non-master admins to
 * their own dashboard, and signed-out users to /index.html.
 * Returns { user } on success.
 */
export function requireMasterAuth() {
  const { auth, db } = getFirebaseInstances();
  return new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      unsub();
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
        const data = snap.data();
        if (data.role !== 'master') {
          window.location.replace('/dashboard.html');
          return;
        }
        resolve({ user });
      } catch (err) {
        console.error('requireMasterAuth failed:', err.message);
        window.location.replace('/index.html');
      }
    });
  });
}

/** Clears the master's selected client and sends them to the client picker. */
export function switchClient() {
  sessionStorage.removeItem(MASTER_VIEW_KEY);
  window.location.href = '/client-select.html';
}

/** Adds a "Switch Client" button above Sign Out, only for master admins browsing a client panel. */
function injectSwitchClientButton() {
  const footer = document.querySelector('.sidebar-footer');
  if (!footer || document.getElementById('switch-client-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'switch-client-btn';
  btn.className = 'btn-signout';
  btn.style.marginBottom = '8px';
  btn.innerHTML = '<i class="fa-solid fa-right-left"></i> Switch Client';
  btn.addEventListener('click', switchClient);
  footer.insertBefore(btn, footer.firstChild);
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
