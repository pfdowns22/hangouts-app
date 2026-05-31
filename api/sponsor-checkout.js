// Creates a Stripe Checkout Session for a self-serve sponsored placement. The
// submitted event details ride along in session metadata; on payment, the
// webhook (api/stripe-webhook.js) activates the placement. Returns { url } for
// the client to redirect to.
import Stripe from 'stripe';

const PACKAGES = {
  '7day': { days: 7, amount: 2900, label: '7-day featured placement' },
  '30day': { days: 30, amount: 7900, label: '30-day featured placement' },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    res.status(500).json({ error: 'Stripe not configured' });
    return;
  }
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const b = req.body || {};
    const pkg = PACKAGES[b.package] || PACKAGES['7day'];
    if (!b.title || !b.sponsorName) {
      res.status(400).json({ error: 'title and sponsorName are required' });
      return;
    }
    const origin = req.headers.origin || `https://${req.headers.host}`;
    // Stripe metadata values must be strings (<=500 chars each).
    const meta = {
      appId: (b.appId || 'hangouts-app').toString().slice(0, 100),
      title: (b.title || '').toString().slice(0, 200),
      description: (b.description || '').toString().slice(0, 480),
      url: (b.url || '').toString().slice(0, 480),
      imageUrl: (b.imageUrl || '').toString().slice(0, 480),
      location: (b.location || '').toString().slice(0, 200),
      borough: (b.borough || '').toString().slice(0, 40),
      type: (b.type || 'Other').toString().slice(0, 40),
      date: (b.date || '').toString().slice(0, 40),
      sponsorName: (b.sponsorName || '').toString().slice(0, 120),
      days: String(pkg.days),
    };
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: pkg.amount,
          product_data: { name: `Hangouts — ${pkg.label}`, description: `Featured: ${meta.title}` },
        },
      }],
      metadata: meta,
      success_url: `${origin}/sponsor?status=success`,
      cancel_url: `${origin}/sponsor?status=cancel`,
    });
    res.status(200).json({ url: session.url });
  } catch (e) {
    console.error('sponsor-checkout error:', e);
    res.status(500).json({ error: e.message });
  }
}
