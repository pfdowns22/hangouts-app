// Shared Firebase Admin initializer (underscore-prefixed → not routed as an
// endpoint by Vercel, only imported). Requires FIREBASE_SERVICE_ACCOUNT to be
// the service-account JSON (as a single env string).
import admin from 'firebase-admin';

export function getAdmin() {
  if (!admin.apps.length) {
    const creds = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    admin.initializeApp({ credential: admin.credential.cert(creds) });
  }
  return admin;
}
