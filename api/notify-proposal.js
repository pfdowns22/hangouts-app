// Notifies group members when an event is proposed to their group: email via
// Resend + web push via FCM (tokens read from member profiles server-side).
// Non-fatal by design — the proposal already succeeded client-side; a failure
// here just means no notification went out.
import { getAdmin } from './_admin.js';

// Best-effort push to every member's registered FCM tokens. Silently skips
// when FIREBASE_SERVICE_ACCOUNT is absent or no one has tokens yet.
const sendPush = async ({ memberIds = [], proposerName, eventTitle, groupName, appUrl }) => {
  try {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT || !memberIds.length) return 0;
    const admin = getAdmin();
    const appId = process.env.APP_ID || 'hangouts-app';
    const snaps = await Promise.all(
      memberIds
        .slice(0, 50)
        .map((uid) => admin.firestore().doc(`artifacts/${appId}/users/${uid}/profiles/myProfile`).get().catch(() => null))
    );
    const tokens = [...new Set(snaps.flatMap((s) => (s?.exists ? s.data()?.fcmTokens || [] : [])))].slice(0, 200);
    if (!tokens.length) return 0;
    const resp = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: {
        title: `${groupName}: new plan proposed`,
        body: `${proposerName} proposed “${eventTitle}” — tap to RSVP.`,
      },
      webpush: { fcmOptions: { link: appUrl || '/' }, notification: { icon: '/icon-192.png' } },
    });
    return resp.successCount || 0;
  } catch (e) {
    console.warn('push send failed:', e.message);
    return 0;
  }
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }
  const { emails = [], memberIds = [], proposerName = 'Someone', eventTitle = 'an event', groupName = 'your group', appUrl = '' } = req.body || {};
  const pushed = await sendPush({ memberIds, proposerName, eventTitle, groupName, appUrl });
  const list = (Array.isArray(emails) ? emails : []).filter((e) => /\S+@\S+\.\S+/.test(e)).slice(0, 50);
  if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM || !list.length) {
    res.status(200).json({ sent: 0, pushed, skipped: true });
    return;
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.RESEND_FROM,
        to: process.env.RESEND_FROM, // bcc the recipients to keep addresses private
        bcc: list,
        subject: `${proposerName} proposed "${eventTitle}" to ${groupName}`,
        html: `<p><strong>${proposerName}</strong> proposed <strong>${eventTitle}</strong> to your group <strong>${groupName}</strong> on Hangouts.</p><p><a href="${appUrl}">Open Hangouts</a> to RSVP.</p>`,
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      res.status(200).json({ sent: 0, error: t.slice(0, 200) });
      return;
    }
    res.status(200).json({ sent: list.length });
  } catch (e) {
    res.status(200).json({ sent: 0, error: e.message });
  }
}
