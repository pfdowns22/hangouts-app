// Stripe webhook: on a completed sponsor checkout, activate the paid placement
// by writing an active doc to the `sponsored` collection (Admin SDK bypasses the
// no-client-create Firestore rule). Register this URL in the Stripe dashboard:
//   https://<deploy>/api/stripe-webhook   (event: checkout.session.completed)
import Stripe from 'stripe';
import { getAdmin } from './_admin.js';

// Need the RAW body to verify the Stripe signature — do not read req.body.
export const config = { api: { bodyParser: false } };

async function rawBody(readable) {
  const chunks = [];
  for await (const chunk of readable) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let event;
  try {
    const buf = await rawBody(req);
    event = stripe.webhooks.constructEvent(buf, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    res.status(400).send(`Webhook Error: ${e.message}`);
    return;
  }

  if (event.type === 'checkout.session.completed') {
    try {
      const s = event.data.object;
      const m = s.metadata || {};
      const admin = getAdmin();
      const db = admin.firestore();
      const days = parseInt(m.days, 10) || 7;
      const appId = m.appId || 'hangouts-app';
      await db.collection(`artifacts/${appId}/public/data/sponsored`).add({
        title: m.title || '',
        description: m.description || '',
        url: m.url || '',
        imageUrl: m.imageUrl || null,
        location: m.location || '',
        borough: m.borough || '',
        type: m.type || 'Other',
        date: m.date || null,
        sponsorName: m.sponsorName || '',
        activeFrom: admin.firestore.Timestamp.now(),
        activeTo: admin.firestore.Timestamp.fromMillis(Date.now() + days * 86400000),
        impressions: 0,
        clicks: 0,
        paymentId: s.id,
        amountPaid: s.amount_total || 0,
        createdAt: admin.firestore.Timestamp.now(),
      });
    } catch (e) {
      console.error('webhook activate error:', e);
      res.status(500).json({ error: 'activation failed' });
      return;
    }
  }
  res.status(200).json({ received: true });
}
