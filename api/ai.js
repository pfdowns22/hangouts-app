// Server-side Gemini proxy. Lets the client run AI calls WITHOUT a Gemini key
// bundled into the JS (VITE_* vars ship to every browser and can be scraped to
// drain the quota). The key stays in GEMINI_API_KEY (server-only, set in
// Vercel), calls require a valid Firebase ID token, and per-user daily caps
// stop any one account from burning the budget.
//
// Rollout: set GEMINI_API_KEY in Vercel and REMOVE VITE_GEMINI_API_KEY. The
// client automatically falls back to this proxy when no bundled key exists.
// Needs FIREBASE_SERVICE_ACCOUNT (already required by the Stripe webhook).

import { getAdmin } from './_admin.js';

const GEMINI_MODEL = 'gemini-2.5-flash';

// Per-user daily caps. Grounded (web-search) calls are the metered/expensive
// kind, so they get a tighter cap than plain generation.
const DAILY_CAP_TOTAL = 80;
const DAILY_CAP_GROUNDED = 25;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  if (!process.env.GEMINI_API_KEY) {
    res.status(503).json({ error: 'AI proxy not configured (missing GEMINI_API_KEY).' });
    return;
  }

  // --- AuthN: a signed-in Firebase user is required. ----------------------
  let uid;
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) throw new Error('missing token');
    const decoded = await getAdmin().auth().verifyIdToken(token);
    uid = decoded.uid;
  } catch {
    res.status(401).json({ error: 'Sign in required.' });
    return;
  }

  const { prompt, useWebSearch = false } = req.body || {};
  if (!prompt || typeof prompt !== 'string' || prompt.length > 20000) {
    res.status(400).json({ error: 'Invalid prompt.' });
    return;
  }

  // --- Rate limit: per-user daily counters in Firestore. ------------------
  // Increment-then-read keeps this one round trip; the tiny race window at
  // the cap boundary is acceptable for abuse control.
  const appId = process.env.APP_ID || 'hangouts-app';
  const day = new Date().toISOString().slice(0, 10);
  const admin = getAdmin();
  const usageRef = admin.firestore().doc(`artifacts/${appId}/aiUsage/${uid}_${day}`);
  try {
    const inc = admin.firestore.FieldValue.increment(1);
    await usageRef.set(
      { total: inc, ...(useWebSearch ? { grounded: inc } : {}), updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    const snap = await usageRef.get();
    const { total = 0, grounded = 0 } = snap.data() || {};
    if (total > DAILY_CAP_TOTAL || (useWebSearch && grounded > DAILY_CAP_GROUNDED)) {
      res.status(429).json({ error: 'Daily AI limit reached — try again tomorrow, or add your own API key in Profile → AI Provider.' });
      return;
    }
  } catch (e) {
    // Metering failure must not take the feature down; log and continue.
    console.warn('AI usage metering failed:', e.message);
  }

  // --- The Gemini call (mirrors the client-side implementation). ----------
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    // No "thinking" budget: event discovery needs output tokens, not hidden
    // reasoning (thinking otherwise eats the budget → empty responses).
    generationConfig: { maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } },
  };
  if (useWebSearch) body.tools = [{ google_search: {} }];

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) {
      const code = data?.error?.code || r.status;
      const message = data?.error?.message || r.statusText || 'Unknown error';
      res.status(502).json({ error: `Gemini ${code}: ${message}` });
      return;
    }
    const cand = data.candidates?.[0];
    const text = (cand?.content?.parts || []).map((p) => p.text || '').join('');
    if (!text) {
      res.status(502).json({ error: `Gemini returned no text (finishReason: ${cand?.finishReason || 'unknown'}).` });
      return;
    }
    res.status(200).json({ text });
  } catch (e) {
    res.status(502).json({ error: e.message || 'AI call failed.' });
  }
}
