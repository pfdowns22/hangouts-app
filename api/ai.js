// Server-side AI proxy with automatic failover.
//
// Primary: Gemini (GEMINI_API_KEY). Failover: Moonshot AI / Kimi
// (MOONSHOT_API_KEY, platform.moonshot.ai) — an OpenAI-compatible API with a
// built-in `$web_search` tool, so grounded event discovery keeps working when
// Gemini's free-tier budget is exhausted. Each provider has its own daily
// budget lane; the app only degrades to cached-pool mode when BOTH are spent.
//
// Keys stay server-only; calls require a Firebase ID token; per-user daily
// caps stop any one account from draining either budget.
//
// Env (all optional except GEMINI_API_KEY):
//   GEMINI_API_KEY             primary provider key
//   MOONSHOT_API_KEY           enables the failover lane
//   MOONSHOT_MODEL             default kimi-latest
//   AI_GLOBAL_DAILY_CAP        Gemini lane daily calls (default 1500)
//   AI_GLOBAL_GROUNDED_CAP     Gemini lane grounded calls (default 300)
//   AI_MOONSHOT_DAILY_CAP      Moonshot lane daily calls (default 4000)
//   AI_MOONSHOT_GROUNDED_CAP   Moonshot lane grounded calls (default 1500)
//   AI_USER_DAILY_CAP          per-user daily calls (default 80)
//   AI_USER_GROUNDED_CAP       per-user grounded calls (default 25)

import { getAdmin } from './_admin.js';

const GEMINI_MODEL = 'gemini-2.5-flash';
const envInt = (name, dflt) => parseInt(process.env[name], 10) || dflt;

const USER_CAP_TOTAL = envInt('AI_USER_DAILY_CAP', 80);
const USER_CAP_GROUNDED = envInt('AI_USER_GROUNDED_CAP', 25);
const GEMINI_CAP_TOTAL = envInt('AI_GLOBAL_DAILY_CAP', 1500);
const GEMINI_CAP_GROUNDED = envInt('AI_GLOBAL_GROUNDED_CAP', 300);
const MOONSHOT_CAP_TOTAL = envInt('AI_MOONSHOT_DAILY_CAP', 4000);
const MOONSHOT_CAP_GROUNDED = envInt('AI_MOONSHOT_GROUNDED_CAP', 1500);

// --- Providers ---------------------------------------------------------------

async function callGemini(prompt, useWebSearch) {
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    // No "thinking" budget: event discovery needs output tokens, not hidden
    // reasoning (thinking otherwise eats the budget → empty responses).
    generationConfig: { maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } },
  };
  if (useWebSearch) body.tools = [{ google_search: {} }];
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) {
    throw new Error(`Gemini ${data?.error?.code || r.status}: ${data?.error?.message || r.statusText || 'Unknown error'}`);
  }
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || '').join('');
  if (!text) throw new Error(`Gemini returned no text (finishReason: ${cand?.finishReason || 'unknown'}).`);
  return text;
}

// Moonshot (Kimi): OpenAI-compatible chat completions. Web grounding uses the
// platform's BUILT-IN `$web_search` tool: the search itself executes on
// Moonshot's side; our job in the tool loop is just to echo the tool call's
// arguments back as the tool result and let the model continue.
async function callMoonshot(prompt, useWebSearch) {
  const key = process.env.MOONSHOT_API_KEY;
  const model = process.env.MOONSHOT_MODEL || 'kimi-latest';
  const messages = [
    { role: 'system', content: 'You are a precise assistant. When asked for JSON, return ONLY valid JSON with no prose and no markdown fences.' },
    { role: 'user', content: prompt },
  ];
  const tools = useWebSearch ? [{ type: 'builtin_function', function: { name: '$web_search' } }] : undefined;
  for (let round = 0; round < 4; round++) {
    const r = await fetch('https://api.moonshot.ai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, temperature: 0.6, max_tokens: 4096, ...(tools ? { tools } : {}) }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Moonshot ${r.status}: ${data?.error?.message || r.statusText || 'Unknown error'}`);
    const choice = data.choices?.[0];
    const msg = choice?.message || {};
    if (choice?.finish_reason === 'tool_calls' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      messages.push(msg);
      for (const tc of msg.tool_calls) {
        messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function?.name, content: tc.function?.arguments || '{}' });
      }
      continue;
    }
    const text = msg.content || '';
    if (!text) throw new Error(`Moonshot returned no text (finish: ${choice?.finish_reason || 'unknown'}).`);
    return text;
  }
  throw new Error('Moonshot web-search loop did not converge.');
}

// --- Handler -------------------------------------------------------------------

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  const hasGemini = !!process.env.GEMINI_API_KEY;
  const hasMoonshot = !!process.env.MOONSHOT_API_KEY;
  if (!hasGemini && !hasMoonshot) {
    res.status(503).json({ error: 'AI proxy not configured (missing GEMINI_API_KEY / MOONSHOT_API_KEY).' });
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

  // --- Metering: per-user combined caps + per-provider global lanes. ------
  const appId = process.env.APP_ID || 'hangouts-app';
  const day = new Date().toISOString().slice(0, 10);
  const admin = getAdmin();
  const usageRef = admin.firestore().doc(`artifacts/${appId}/aiUsage/${uid}_${day}`);
  const globalRef = admin.firestore().doc(`artifacts/${appId}/aiUsage/global_${day}`);
  let geminiSpent = { total: 0, grounded: 0 };
  let moonshotSpent = { total: 0, grounded: 0 };
  try {
    const inc = admin.firestore.FieldValue.increment(1);
    const stamp = admin.firestore.FieldValue.serverTimestamp();
    const patch = { total: inc, ...(useWebSearch ? { grounded: inc } : {}), updatedAt: stamp };
    await Promise.all([usageRef.set(patch, { merge: true }), globalRef.set(patch, { merge: true })]);
    const [snap, gsnap] = await Promise.all([usageRef.get(), globalRef.get()]);
    const u = snap.data() || {};
    const g = gsnap.data() || {};
    geminiSpent = { total: g.geminiTotal || 0, grounded: g.geminiGrounded || 0 };
    moonshotSpent = { total: g.moonshotTotal || 0, grounded: g.moonshotGrounded || 0 };
    if ((u.total || 0) > USER_CAP_TOTAL || (useWebSearch && (u.grounded || 0) > USER_CAP_GROUNDED)) {
      res.status(429).json({
        code: 'user-limit',
        error: 'Daily AI limit reached — try again tomorrow, or add your own API key in Profile → AI Provider.',
      });
      return;
    }
  } catch (e) {
    // Metering failure must not take the feature down; log and continue.
    console.warn('AI usage metering failed:', e.message);
  }

  const geminiOpen =
    hasGemini && geminiSpent.total < GEMINI_CAP_TOTAL && (!useWebSearch || geminiSpent.grounded < GEMINI_CAP_GROUNDED);
  const moonshotOpen =
    hasMoonshot && moonshotSpent.total < MOONSHOT_CAP_TOTAL && (!useWebSearch || moonshotSpent.grounded < MOONSHOT_CAP_GROUNDED);

  if (!geminiOpen && !moonshotOpen) {
    res.status(429).json({
      code: 'budget',
      error: 'Today’s shared AI budget is used up — showing cached local events instead. Add your own AI key in Profile → AI Provider for unlimited searches.',
    });
    return;
  }

  // Fire-and-forget: attribute this attempt to a provider's lane.
  const chargeLane = (lane) => {
    try {
      const inc = admin.firestore.FieldValue.increment(1);
      globalRef
        .set({ [`${lane}Total`]: inc, ...(useWebSearch ? { [`${lane}Grounded`]: inc } : {}) }, { merge: true })
        .catch(() => {});
    } catch { /* best-effort */ }
  };

  // --- Call: Gemini while its lane is open, else Moonshot; and if Gemini
  // ERRORS mid-lane (5xx/quota), fail over to Moonshot in the same request
  // so the user never sees the hiccup.
  try {
    if (geminiOpen) {
      chargeLane('gemini');
      try {
        const text = await callGemini(prompt, useWebSearch);
        res.status(200).json({ text, provider: 'gemini' });
        return;
      } catch (geminiErr) {
        if (!moonshotOpen) throw geminiErr;
        console.warn('Gemini failed; failing over to Moonshot:', geminiErr.message);
      }
    }
    chargeLane('moonshot');
    const text = await callMoonshot(prompt, useWebSearch);
    res.status(200).json({ text, provider: 'moonshot' });
  } catch (e) {
    res.status(502).json({ error: e.message || 'AI call failed.' });
  }
}
