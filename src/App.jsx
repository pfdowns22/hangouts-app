import React, { useState, useEffect, createContext, useContext, useCallback, useRef, useMemo } from 'react';
import {
  signInAnonymously,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  OAuthProvider,
  signOut,
} from 'firebase/auth';
import {
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  onSnapshot,
  collection,
  query,
  where,
  addDoc,
  arrayUnion,
  arrayRemove,
  deleteDoc,
  writeBatch,
  runTransaction,
  increment,
  serverTimestamp,
  Timestamp,
  orderBy,
  limit,
} from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';

import { createPortal } from 'react-dom';

import { auth, db, storage, appId, geminiApiKey } from './firebase.js';
import { fetchRealEvents, verifyVenue } from './events.js';

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL_FOR_KEY = (key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;
const GEMINI_URL = GEMINI_URL_FOR_KEY(geminiApiKey); // legacy alias

// --- Multi-provider AI dispatcher ---
// `aiProvider` lives on the user's profile (synced via Firestore).
// User-provided API keys live in localStorage only — NEVER synced — so
// they stay on the user's device. Default ("gemini") uses the app's shared
// Gemini key, which has a free-tier quota and is the right thing for
// quick demos. For sustained use, users pick their own provider/key.
const AI_PROVIDERS = [
  { id: 'gemini', label: 'Gemini (shared app key — default)', needsKey: false },
  { id: 'gemini-own', label: 'Gemini (use my own API key)', needsKey: true, keyHint: 'aistudio.google.com/app/apikey' },
  { id: 'claude', label: 'Claude (use my own Anthropic key)', needsKey: true, keyHint: 'console.anthropic.com → API keys' },
  { id: 'openai', label: 'OpenAI / ChatGPT (use my own key)', needsKey: true, keyHint: 'platform.openai.com/api-keys' },
];

const getStoredKey = (provider) => {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem(`hangouts_ai_key_${provider}`) || '';
};

const storeKey = (provider, key) => {
  if (typeof window === 'undefined') return;
  if (key) window.localStorage.setItem(`hangouts_ai_key_${provider}`, key);
  else window.localStorage.removeItem(`hangouts_ai_key_${provider}`);
};

// Call a Gemini model. Used for both the shared key and user-supplied
// Gemini keys. Returns the raw text from the first candidate.
const callGemini = async (prompt, key, useWebSearch) => {
  if (!key) throw new Error('Missing Gemini API key.');
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    // Give output room and disable "thinking": gemini-2.5-flash otherwise
    // spends the output budget on hidden reasoning and can return
    // finishReason MAX_TOKENS with no text (the intermittent "couldn't fetch").
    // Event discovery/ranking needs no deep reasoning.
    generationConfig: { maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } },
  };
  if (useWebSearch) body.tools = [{ google_search: {} }];
  const res = await fetch(GEMINI_URL_FOR_KEY(key), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const code = data?.error?.code || res.status;
    const message = data?.error?.message || res.statusText || 'Unknown error';
    throw new Error(`Gemini ${code}: ${message}`);
  }
  const cand = data.candidates?.[0];
  if (!cand) throw new Error('Gemini returned no candidates.');
  // Grounded (google_search) responses split the answer across multiple
  // parts, so join them all — reading only parts[0] silently drops the JSON.
  const text = (cand.content?.parts || []).map((p) => p.text || '').join('');
  if (!text) {
    // gemini-2.5-flash is a thinking model: thinking tokens can exhaust the
    // output budget, returning finishReason MAX_TOKENS with no visible text.
    // Surface it so callers don't fail later as an opaque "can't parse JSON".
    throw new Error(`Gemini returned no text (finishReason: ${cand.finishReason || 'unknown'}).`);
  }
  return text;
};

// Call Claude (Anthropic Messages API). Browser calls require the
// `anthropic-dangerous-direct-browser-access` header. The key lives only
// in the user's browser, so the "danger" warning is the right tradeoff
// for our friends-and-family setup.
const callClaude = async (prompt, key, useWebSearch) => {
  if (!key) throw new Error('Missing Claude API key — paste it in Profile → AI Provider.');
  const body = {
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  };
  if (useWebSearch) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const message = data?.error?.message || res.statusText || 'Unknown error';
    throw new Error(`Claude ${res.status}: ${message}`);
  }
  const text = (data.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  if (!text) throw new Error('Claude returned no text content.');
  return text;
};

// Call OpenAI (Responses API — supports web search via tools). The
// `dangerouslyAllowBrowser` SDK flag is unnecessary when calling the REST
// endpoint directly; the key is just sent in the Authorization header.
const callOpenAI = async (prompt, key, useWebSearch) => {
  if (!key) throw new Error('Missing OpenAI API key — paste it in Profile → AI Provider.');
  const body = {
    model: useWebSearch ? 'gpt-4o-mini-search-preview' : 'gpt-4o-mini',
    input: prompt,
  };
  if (useWebSearch) body.tools = [{ type: 'web_search_preview' }];
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const message = data?.error?.message || res.statusText || 'Unknown error';
    throw new Error(`OpenAI ${res.status}: ${message}`);
  }
  // Prefer the convenience output_text if present; fall back to walking the output array.
  if (typeof data.output_text === 'string' && data.output_text) return data.output_text;
  const piece = (data.output || []).find((o) => Array.isArray(o.content));
  const text = (piece?.content || []).filter((c) => c.type === 'output_text' || c.type === 'text').map((c) => c.text).join('\n');
  if (!text) throw new Error('OpenAI returned no text content.');
  return text;
};

// Dispatcher used by every AI call site in the app. The caller passes
// the provider object directly (we don't read from React state here so
// it stays as a pure function callable from class-free helpers).
const callAI = async ({ prompt, useWebSearch = false, provider = 'gemini' }) => {
  if (provider === 'gemini') return callGemini(prompt, geminiApiKey, useWebSearch);
  if (provider === 'gemini-own') return callGemini(prompt, getStoredKey('gemini-own'), useWebSearch);
  if (provider === 'claude') return callClaude(prompt, getStoredKey('claude'), useWebSearch);
  if (provider === 'openai') return callOpenAI(prompt, getStoredKey('openai'), useWebSearch);
  throw new Error(`Unknown AI provider: ${provider}`);
};

// --- Free-tier grounding budget ---------------------------------------
// Google gives 1,500 free Google-Search-grounded prompts per day even with
// billing enabled; beyond that it's $35/1,000. To keep the shared key always
// within the free allowance, we meter grounded searches against a per-day
// counter in Firestore and stop calling Gemini once the cap is reached — the
// feed then leans entirely on the partner-event APIs (Ticketmaster/PredictHQ),
// which don't consume Gemini quota.
const GROUNDING_DAILY_CAP = 1400; // margin under Google's 1,500/day free limit

// Atomically reserve one grounded search for today. Returns true if allowed
// (and records the use), false once the daily cap is hit. Fails OPEN on any
// metering error so a Firestore hiccup never breaks event discovery.
const reserveGroundedSearch = async () => {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const ref = doc(db, `artifacts/${appId}/public/data/meta`, `grounding-${day}`);
    return await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const count = snap.exists() ? snap.data().count || 0 : 0;
      if (count >= GROUNDING_DAILY_CAP) return false;
      tx.set(ref, { count: count + 1, day }, { merge: true });
      return true;
    });
  } catch (e) {
    console.warn('Grounding budget check failed; allowing the call.', e);
    return true;
  }
};

// Small inline pills shown on every event card: pricing tier ($-$$$$) and
// a ticketed indicator. Both render only when the field is populated, so
// older feed items without these fields stay quiet.
const PriceTierBadge = ({ tier }) => {
  if (!tier) return null;
  const isFree = tier === 'Free';
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-bold ${
        isFree ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'
      }`}
      title={
        isFree
          ? 'Free event'
          : `Typical cost: ${tier} (${{ '$': 'under $20', '$$': '$20–$50', '$$$': '$50–$100', '$$$$': '$100+' }[tier] || ''})`
      }
    >
      {tier}
    </span>
  );
};

const TicketedBadge = ({ isTicketed }) => {
  if (!isTicketed) return null;
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-purple-50 text-purple-700 text-xs font-medium">
      🎟️ Ticketed
    </span>
  );
};

// Badge shown for events sourced from a named partner API. The AI ('ai')
// source is intentionally omitted so users never see "suggested by AI" — those
// events simply show no source badge.
const SOURCE_LABELS = {
  ticketmaster: 'Ticketmaster',
  seatgeek: 'SeatGeek',
  predicthq: 'PredictHQ',
  google: 'Google',
  nyc: 'NYC',
};

// Detect a NYC borough in a free-text address so we can query NYC Open Data
// (NYC-only). Returns the canonical borough name or null.
const nycBorough = (addr) => {
  const s = (addr || '').toLowerCase();
  if (/staten island/.test(s)) return 'Staten Island';
  if (/manhattan|new york, ny|nyc/.test(s)) return 'Manhattan';
  if (/brooklyn/.test(s)) return 'Brooklyn';
  if (/queens|astoria|long island city|flushing/.test(s)) return 'Queens';
  if (/bronx/.test(s)) return 'Bronx';
  return null;
};
const SourceBadge = ({ source }) => {
  const label = SOURCE_LABELS[source];
  if (!label) return null;
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-gray-100 text-gray-600 text-xs font-medium">
      {label}
    </span>
  );
};

// The activity type (Music, Food & Drink, Outdoors, …) — also what the feed's
// "filter by type" control filters on.
const TypeBadge = ({ type }) => {
  if (!type || type === 'Other') return null;
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-700 text-xs font-medium">
      {type}
    </span>
  );
};

// Clear "Sponsored" label for paid placements (disclosure).
const SponsoredBadge = () => (
  <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-amber-100 text-amber-800 text-[11px] font-bold uppercase tracking-wide">
    Sponsored
  </span>
);

// A single paid placement shown atop the feed, clearly labeled. The whole card
// is the affiliate-wrapped outbound link; clicks are counted by the caller.
const SponsoredCard = ({ item, onClick }) => {
  const img = useEventImage(item);
  return (
    <a
      href={affiliateUrl(item.url || '#')}
      target="_blank"
      rel="noopener noreferrer sponsored"
      onClick={onClick}
      className="block bg-white rounded-2xl border border-amber-200 shadow-sm overflow-hidden hover:shadow-md transition"
    >
      <div className="flex gap-3 p-3 items-center">
        {img && <img src={img} alt={item.title} className="w-20 h-20 rounded-xl object-cover flex-shrink-0" />}
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <SponsoredBadge />
            {item.sponsorName && <span className="text-xs text-gray-400 truncate">{item.sponsorName}</span>}
          </div>
          <h3 className="font-bold text-gray-800 truncate">{item.title}</h3>
          <p className="text-sm text-gray-500 line-clamp-2">{item.description}</p>
        </div>
      </div>
    </a>
  );
};

// Validate a candidate event URL. A loose `^https?://` test is NOT enough —
// AI results frequently contain placeholders like "https://[venue website]" or
// a bare "https://", which pass that test but produce dead links that do
// nothing when clicked. Require a parseable URL with a real host (a dot, no
// spaces/brackets). Returns the normalized href, or null.
const validHttpUrl = (str) => {
  const s = (str || '').trim();
  if (!s || /[\s\[\]<>]/.test(s)) return null;
  try {
    const u = new URL(s);
    if ((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.includes('.')) return u.href;
  } catch {
    /* not a valid URL */
  }
  return null;
};

// A Google search built from everything on the listing card (quoted title +
// location + date) so even without a direct link the user lands on accurate,
// specific results for that exact event.
const searchUrl = (event, extra = '') => {
  const title = event?.title ? `"${event.title}"` : '';
  const q = [extra, title, event?.location, event?.date ? String(event.date).slice(0, 10) : '']
    .filter(Boolean)
    .join(' ');
  return `https://www.google.com/search?q=${encodeURIComponent(q || 'local events')}`;
};

// Only partner APIs give real, event-specific URLs we should link to directly.
// AI ('ai') and PredictHQ URLs are unreliable (homepage, fabricated, or
// absent), so for those we send users to a search of the card's details, which
// surfaces the actual event listing rather than a no-info landing page.
const TRUSTED_URL_SOURCES = new Set(['ticketmaster', 'seatgeek', 'google']);

// --- Affiliate link wrapping (monetization) ---------------------------
// When an outbound link goes to a partner we're enrolled with, wrap it with our
// affiliate tracking so we earn referral commission on what users already do.
// Each env value is EITHER a deeplink template containing "{url}" (e.g.
// Partnerize/Impact: "https://prf.hn/click/camref:XXX/destination:{url}") OR a
// "key=value" query param to append. Empty/unset → URL returned unchanged, so
// this is completely inert until you enroll and set the id in Vercel.
const wrapAffiliate = (rawUrl, tmpl) => {
  const u = (rawUrl || '').trim();
  if (!u || !tmpl) return u;
  if (tmpl.includes('{url}')) return tmpl.replace('{url}', encodeURIComponent(u));
  try {
    const url = new URL(u);
    const eq = tmpl.indexOf('=');
    if (eq > 0) url.searchParams.set(tmpl.slice(0, eq), tmpl.slice(eq + 1));
    return url.toString();
  } catch {
    return u;
  }
};
// Host → affiliate-template map. Each entry tests the (www-stripped) hostname
// and carries the env template to wrap with. tmpl uses LITERAL import.meta.env
// access (Vite only statically inlines literal reads, not dynamic keys), read
// once at module load. Add a partner by enrolling, dropping its host pattern
// here, and setting the VITE_AFFILIATE_* id in Vercel — until then tmpl is ''
// and wrapAffiliate returns the URL unchanged (completely inert).
const AFFILIATE_PARTNERS = [
  { test: /(^|\.)ticketmaster\.com$|(^|\.)livenation\.com$/, tmpl: import.meta.env.VITE_AFFILIATE_TICKETMASTER || '' },
  { test: /(^|\.)seatgeek\.com$/, tmpl: import.meta.env.VITE_AFFILIATE_SEATGEEK || '' },
  { test: /(^|\.)stubhub\.com$/, tmpl: import.meta.env.VITE_AFFILIATE_STUBHUB || '' },
  { test: /(^|\.)vividseats\.com$/, tmpl: import.meta.env.VITE_AFFILIATE_VIVIDSEATS || '' },
  { test: /(^|\.)viator\.com$|(^|\.)getyourguide\.com$/, tmpl: import.meta.env.VITE_AFFILIATE_VIATOR || '' },
  { test: /(^|\.)opentable\.com$|(^|\.)resy\.com$/, tmpl: import.meta.env.VITE_AFFILIATE_OPENTABLE || '' },
  { test: /(^|\.)uber\.com$/, tmpl: import.meta.env.VITE_AFFILIATE_UBER || '' },
  { test: /(^|\.)lyft\.com$/, tmpl: import.meta.env.VITE_AFFILIATE_LYFT || '' },
  { test: /(^|\.)booking\.com$|(^|\.)expedia\.com$/, tmpl: import.meta.env.VITE_AFFILIATE_BOOKING || '' },
];
const affiliateUrl = (rawUrl) => {
  let host = '';
  try {
    host = new URL(rawUrl).hostname.replace(/^www\./, '');
  } catch {
    return rawUrl;
  }
  const partner = AFFILIATE_PARTNERS.find((p) => p.test.test(host));
  return partner ? wrapAffiliate(rawUrl, partner.tmpl) : rawUrl;
};

// "More Info" target: the event's own URL only when it comes from a trusted
// source and is valid (affiliate-wrapped); otherwise a rich search of the card.
const moreInfoUrl = (event) => {
  if (TRUSTED_URL_SOURCES.has(event?.source)) {
    const direct = validHttpUrl(event?.url);
    if (direct) return affiliateUrl(direct);
  }
  return searchUrl(event);
};

// Tickets action for an event card. Returns null for non-ticketed events.
// Resolution order — designed to land on a REAL ticket page, never a wrong
// vendor (the old code always sent unmatched events to a Ticketmaster search,
// which is wrong for e.g. a Colosseum tour that's sold on GetYourGuide):
//   1. A valid, event-specific ticket/official URL — from a trusted partner OR
//      provided by the AI (validHttpUrl strips placeholders/junk). This is the
//      actual page; affiliateUrl() wraps it only when it's a partner we earn on.
//   2. No usable URL → pick the ticket VENDOR that actually sells THIS kind of
//      event: concerts/sports/nightlife → Ticketmaster; tours/attractions/arts/
//      outdoors/markets → GetYourGuide (affiliate-covered via the Viator/GYG id).
//   3. Anything ambiguous → a targeted "<title> … tickets" web search, which
//      reliably surfaces the real ticket page instead of guessing a vendor.
const ticketAction = (event) => {
  if (!event?.isTicketed) return null;
  // 1. Prefer a real, specific link (ticket URL first, else the official page).
  const direct = validHttpUrl(event?.ticketsUrl) || validHttpUrl(event?.url);
  if (direct) return { href: affiliateUrl(direct), label: '🎟️ Buy Tickets' };

  // 2/3. No usable link → vendor by event type, else a targeted ticket search.
  const q = [event?.title, event?.location].filter(Boolean).join(' ');
  const enc = encodeURIComponent(q || 'tickets');
  const type = event?.type;
  if (type === 'Music' || type === 'Sports' || type === 'Nightlife') {
    return { href: affiliateUrl(`https://www.ticketmaster.com/search?q=${enc}`), label: '🎟️ Find Tickets' };
  }
  if (type === 'Arts & Culture' || type === 'Outdoors' || type === 'Community' || type === 'Markets') {
    return { href: affiliateUrl(`https://www.getyourguide.com/s/?q=${enc}`), label: '🎟️ Find Tickets' };
  }
  // Ambiguous ('Other', 'Food & Drink', or missing) → real-page web search.
  return { href: searchUrl(event, 'tickets'), label: '🎟️ Find Tickets' };
};

// A best-effort destination string for maps/ride deep-links. Events only persist
// a free-text `location` (lat/lng are transient during verification), so we
// combine the venue title + location for an unambiguous place query, dropping
// the title when it's already contained in the location to avoid duplication.
const eventDestination = (event) => {
  const loc = (event?.location || '').trim();
  const title = (event?.title || '').trim();
  if (loc && title && !loc.toLowerCase().includes(title.toLowerCase())) return `${title}, ${loc}`;
  return loc || title;
};

// "Get directions" target — a Google Maps directions universal link with the
// venue prefilled. Opens the Maps app on mobile, maps.google.com on desktop.
// Pure UX win (no affiliate); returns null when we have no destination.
const directionsUrl = (event) => {
  const dest = eventDestination(event);
  if (!dest) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`;
};

// "Get a ride" target — an Uber universal deep-link with the venue as dropoff
// (pickup left to the user's current location). Affiliate-wrapped so rides
// booked through us earn commission once VITE_AFFILIATE_UBER is set; otherwise
// it's just a convenient deep-link. Returns null when we have no destination.
const rideUrl = (event) => {
  const dest = eventDestination(event);
  if (!dest) return null;
  const url = `https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff[formatted_address]=${encodeURIComponent(dest)}`;
  return affiliateUrl(url);
};

// Broad interests worth drilling into specifics for, so recommendations (and
// especially place picks) match real taste. Maps a broad label →
// { key (where specifics are stored in profile.preferenceDetails), question,
// options }. The `match` list lets a free-typed interest map to a bucket.
const INTEREST_TAXONOMY = {
  'Food & Drink': {
    key: 'food',
    question: 'What kinds of food are you into?',
    options: ['Italian', 'Mexican', 'Japanese / Sushi', 'Thai', 'Indian', 'Chinese', 'BBQ', 'Vegan / Vegetarian', 'Brunch', 'Seafood', 'Pizza', 'Steakhouse', 'Mediterranean'],
    match: ['food', 'foodie', 'dining', 'restaurant', 'restaurants', 'eat', 'cuisine'],
  },
  'Drinks / Nightlife': {
    key: 'drinks',
    question: "What's your drinks / nightlife scene?",
    options: ['Craft cocktails', 'Wine bars', 'Breweries / Beer', 'Speakeasies', 'Rooftop bars', 'Dive bars', 'Dancing / Clubs'],
    match: ['drinks', 'drink', 'nightlife', 'bars', 'bar', 'cocktails', 'wine', 'beer'],
  },
  'Live Music': {
    key: 'music',
    question: 'What music do you love?',
    options: ['Indie / Rock', 'Hip-hop', 'Electronic / DJ', 'Jazz / Blues', 'Classical', 'Pop', 'Country', 'Latin', 'Metal'],
    match: ['music', 'live music', 'concerts', 'concert', 'gigs', 'shows'],
  },
};

// Find the taxonomy bucket a broad label/typed interest belongs to (or null).
const taxonomyBucketFor = (label) => {
  const l = (label || '').trim().toLowerCase();
  if (!l) return null;
  for (const [broad, def] of Object.entries(INTEREST_TAXONOMY)) {
    if (broad.toLowerCase() === l || def.match.includes(l)) return { broad, ...def };
  }
  return null;
};

// One-tap interest chips for low-lift onboarding — a fast alternative to (and
// coexisting with) the AI survey and free-text add. Labels that line up with
// INTEREST_TAXONOMY broad buckets (Food & Drink, Drinks / Nightlife, Live Music)
// open the same specifics drill-down when tapped.
const QUICK_INTEREST_CHIPS = [
  'Live Music', 'Food & Drink', 'Drinks / Nightlife', 'Fine Dining', 'Dancing',
  'Comedy', 'Sports', 'Art / Museums', 'Theater', 'Outdoors', 'Coffee',
  'Fitness', 'Festivals', 'Markets / Shopping',
];

// Image fallback chain when Gemini's imageUrl is null or 404s.
// Priority order:
// 1. Unsplash API (real photos, fast CDN) — used if VITE_UNSPLASH_KEY is set
// 2. pollinations.ai turbo (AI-generated, no key) — slower but works without setup
// 3. placehold.co text card — final fallback, always loads
const UNSPLASH_KEY = import.meta.env.VITE_UNSPLASH_KEY || '';

const pollinationsImage = (keywords) => {
  const q = (keywords || 'social event').slice(0, 100);
  // model=turbo is ~3x faster than flux; smaller dims generate quicker too.
  return `https://image.pollinations.ai/prompt/${encodeURIComponent(q)}?width=600&height=300&nologo=true&model=turbo`;
};

const textPlaceholder = (title) => {
  const t = (title || 'Event').slice(0, 50);
  return `https://placehold.co/800x400/6366f1/ffffff/png?text=${encodeURIComponent(t)}`;
};

// Cache Unsplash search results per-query within the page session so we
// don't burn the free-tier 50/hr quota on repeat renders of the same event.
const unsplashCache = new Map();

// React hook: returns the best image URL for an event.
// When VITE_UNSPLASH_KEY is configured, Unsplash is *always* the primary
// source — Gemini's claimed imageUrls are notoriously unreliable (often
// pointing at images that 404 or aren't really images at all). We only
// fall back to Gemini's URL or pollinations if Unsplash has no results.
const useEventImage = (data) => {
  // Optimistic starting state: when no Unsplash key, fall back immediately
  // to pollinations so users see *something* before any async work.
  const [src, setSrc] = useState(
    UNSPLASH_KEY ? null : (data?.imageUrl || pollinationsImage(data?.imageKeywords || data?.title))
  );

  useEffect(() => {
    const query = (data?.imageKeywords || data?.title || 'event').slice(0, 80);

    // No Unsplash key: defer to Gemini's URL (if any) or pollinations.
    if (!UNSPLASH_KEY) {
      setSrc(data?.imageUrl || pollinationsImage(query));
      return;
    }

    // With Unsplash configured, always try Unsplash first.
    if (unsplashCache.has(query)) {
      setSrc(unsplashCache.get(query));
      return;
    }
    let cancelled = false;
    fetch(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape&client_id=${UNSPLASH_KEY}`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        const url = j?.results?.[0]?.urls?.regular;
        if (url) {
          unsplashCache.set(query, url);
          setSrc(url);
        } else {
          // Unsplash returned no results — try Gemini's URL, then pollinations.
          setSrc(data?.imageUrl || pollinationsImage(query));
        }
      })
      .catch(() => {
        if (!cancelled) setSrc(data?.imageUrl || pollinationsImage(query));
      });
    return () => { cancelled = true; };
  }, [data?.imageUrl, data?.title, data?.imageKeywords]);

  return src;
};

// Gemini doesn't allow `tools: [{google_search:{}}]` together with
// `responseSchema: application/json`. For grounded calls we parse JSON
// out of the model's text output instead of relying on schema enforcement.
const extractJsonArray = (text) => {
  if (!text) return null;
  // Try fenced code block first
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  // Find first '[' and last ']' to isolate the array
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
};

// Defensive parse of a single JSON OBJECT from model output (the Plan tab's
// planning turn returns `{reply, needInfo, suggestions}`, not an array). Same
// approach as extractJsonArray: strip ``` fences, isolate first '{'…last '}',
// try/catch → null so a malformed reply never throws.
const extractJsonObject = (text) => {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
};

// --- Multi-source event helpers ---------------------------------------
// The feed and group suggestions gather events from two kinds of source in
// parallel: (A) the existing Gemini grounded web search, and (B) structured
// partner APIs via /api/events. These helpers handle the partner side and the
// merge.

// Local calendar date as YYYY-MM-DD. Must NOT use toISOString() (that's UTC):
// for a user west of UTC in the evening, the UTC date is already "tomorrow",
// which would make the Today tab query the wrong day.
const ymdLocal = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// YYYY-MM-DD date window for the partner-events proxy. Today = just today;
// otherwise tomorrow → +14 days (kept tight so Upcoming stays specific/relevant
// rather than vague far-future picks).
const dateWindow = (forToday) => {
  if (forToday) {
    const t = ymdLocal(new Date());
    return { startDate: t, endDate: t };
  }
  return {
    startDate: ymdLocal(new Date(Date.now() + 864e5)),
    endDate: ymdLocal(new Date(Date.now() + 14 * 864e5)),
  };
};

// The fixed, filterable event types. Keep in sync with normalizeType in
// api/events.js. Used for the "filter by type" control and to constrain the
// AI's category output.
const EVENT_TYPES = ['Music', 'Food & Drink', 'Outdoors', 'Arts & Culture', 'Sports', 'Nightlife', 'Markets', 'Community', 'Other'];

const normalizeType = (raw) => {
  const s = (raw || '').toString().toLowerCase();
  if (EVENT_TYPES.map((t) => t.toLowerCase()).includes(s)) return EVENT_TYPES.find((t) => t.toLowerCase() === s);
  if (/(music|concert|gig|dj|band|jazz|hip.?hop)/.test(s)) return 'Music';
  if (/(restaurant|food|dining|culinary|brunch|eat|cuisine|tasting)/.test(s)) return 'Food & Drink';
  if (/(bar|nightlife|club|cocktail|brewery|wine|pub|lounge)/.test(s)) return 'Nightlife';
  if (/(outdoor|park|hike|nature|trail|beach|garden|bike|run)/.test(s)) return 'Outdoors';
  if (/(art|museum|theat|performing|culture|comedy|film|gallery|dance|exhibit)/.test(s)) return 'Arts & Culture';
  if (/(sport|game|fitness|yoga|workout|athletic|match)/.test(s)) return 'Sports';
  if (/(market|shopping|flea|bazaar|pop.?up)/.test(s)) return 'Markets';
  if (/(community|fair|expo|parade|festival|meetup|workshop|class|craft)/.test(s)) return 'Community';
  return 'Other';
};

// Normalize a title for de-duplication: lowercase, drop a trailing date/edition
// (e.g. "— July 4", "2026", "Night 3"), strip punctuation, collapse whitespace.
// This collapses a multi-night series ("Celebrate Brooklyn! · Jul 5/6/7") to a
// single key so it can't appear several times.
const normalizeTitle = (title) =>
  (title || '')
    .toLowerCase()
    .replace(/\s*[•·]\s*.*$/, '') // bullet separator + everything after (usually the date/edition)
    .replace(/\s+[–—|]\s+.*$/, '') // en/em dash or pipe used as a separator (spaced)
    .replace(/\s+-\s+.*$/, '') // spaced hyphen separator (NOT internal hyphens like "pop-up")
    .replace(/\b(night|day|part|vol\.?|edition)\s*#?\d+\b/g, '')
    .replace(/\b(19|20)\d{2}\b/g, '') // years
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

// Merge several event lists, collapsing duplicates by normalized title (ignoring
// date) so the same event/series surfaces once, even across providers and dates.
const mergeEvents = (...lists) => {
  const seen = new Map();
  for (const ev of [].concat(...lists)) {
    if (!ev?.title) continue;
    const key = normalizeTitle(ev.title) || (ev.title || '').toLowerCase();
    if (!seen.has(key)) seen.set(key, ev);
  }
  return [...seen.values()];
};

// Ask the AI to rank/personalize a list of REAL partner-API events. It may
// reorder, drop weak matches, and rewrite each description, but we only ever
// copy back the chosen description — every other (factual) field comes from the
// original event object, so dates/links/prices can't be altered or invented.
// Falls back to the raw events if the ranking call fails.
const rankAndPersonalizeEvents = async ({ events, contextText, provider, max = 6 }) => {
  if (!events.length) return [];
  const slim = events.slice(0, 20).map((e, i) => ({
    i,
    title: e.title,
    description: (e.description || '').slice(0, 280),
    location: e.location,
    date: e.date,
    category: e.category,
    priceTier: e.priceTier,
  }));
  const prompt = `${contextText}

Below is a JSON array of REAL events (already verified via partner APIs). Choose the ${max} best matches, ordered best first, and for each write a warm, specific 1-2 sentence description of why it fits. Do NOT invent events and do NOT change any field other than the description.

Return ONLY a JSON array of objects: {"i": <original index>, "description": "<personalized blurb>"}. Include only the events you selected.

EVENTS:
${JSON.stringify(slim)}`;
  try {
    const text = await callAI({ prompt, useWebSearch: false, provider });
    const picks = extractJsonArray(text);
    if (!Array.isArray(picks)) return events.slice(0, max);
    const out = [];
    for (const p of picks) {
      const orig = events[p?.i];
      if (orig) out.push({ ...orig, description: p?.description || orig.description });
    }
    return out.length ? out : events.slice(0, max);
  } catch (e) {
    console.warn('Event ranking failed; using raw partner events:', e);
    return events.slice(0, max);
  }
};

// Gather interests shared across the members of the user's groups — the
// "overlapping interests" used to seed a few group-oriented suggestions in the
// personal feed. Returns interests held by 2+ members, most common first.
// Bounded (≤5 groups, ≤25 members) to keep the read burst small.
const gatherGroupInterests = async (profile) => {
  const groupIds = (profile?.groupIds || []).slice(0, 5);
  if (!groupIds.length) return [];
  try {
    const groups = await Promise.all(
      groupIds.map(async (gid) => {
        try {
          const s = await getDoc(doc(db, `artifacts/${appId}/public/data/groups`, gid));
          return s.exists() ? s.data() : null;
        } catch {
          return null;
        }
      })
    );
    const memberIds = [...new Set(groups.filter(Boolean).flatMap((g) => g.members || []))].slice(0, 25);
    if (!memberIds.length) return [];
    const profiles = await Promise.all(
      memberIds.map(async (uid) => {
        try {
          const s = await getDoc(doc(db, `artifacts/${appId}/users/${uid}/profiles`, 'myProfile'));
          return s.exists() ? s.data() : null;
        } catch {
          return null;
        }
      })
    );
    const freq = {};
    profiles.filter(Boolean).forEach((p) => (p.preferences || []).forEach((pref) => { if (pref) freq[pref] = (freq[pref] || 0) + 1; }));
    return Object.entries(freq)
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k)
      .slice(0, 8);
  } catch {
    return [];
  }
};

// Read a group's recent chat and ask the AI for 2-4 concrete things the group
// seems to want to do together (activities/places/outings) — used to seed
// chat-aware suggestions. Returns short phrases (e.g. ["golf","sushi dinner"]).
const extractChatTopics = async (groupId, provider = 'gemini') => {
  try {
    const q = query(
      collection(db, `artifacts/${appId}/public/data/groups/${groupId}/messages`),
      orderBy('timestamp', 'desc'),
      limit(30)
    );
    const snap = await getDocs(q);
    const transcript = snap.docs
      .map((d) => d.data())
      .reverse()
      .map((m) => `${m.senderName || '?'}: ${m.text || ''}`)
      .filter((l) => l.trim())
      .join('\n')
      .slice(0, 4000);
    if (!transcript.trim()) return [];
    const prompt = `From this group chat, list 2-4 concrete things the group seems interested in doing together (activities, places, outings). Ignore greetings and logistics. Short phrases only.\n\nCHAT:\n${transcript}\n\nReturn ONLY a JSON array of short strings.`;
    const text = await callAI({ prompt, useWebSearch: false, provider });
    const arr = extractJsonArray(text);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x.trim()).slice(0, 4) : [];
  } catch (e) {
    console.warn('extractChatTopics failed:', e);
    return [];
  }
};

// Email the other group members when an event is proposed (via /api/notify-proposal
// → Resend). Reads member emails from their profiles (readable per rules).
// Fire-and-forget; never blocks or fails the proposal.
const sendProposalEmails = async (group, eventTitle, proposerName, selfId) => {
  try {
    const ids = (group?.members || []).filter((id) => id !== selfId).slice(0, 30);
    if (!ids.length) return;
    const emails = (
      await Promise.all(
        ids.map(async (uid) => {
          try {
            const s = await getDoc(doc(db, `artifacts/${appId}/users/${uid}/profiles`, 'myProfile'));
            return s.exists() ? s.data().email || '' : '';
          } catch {
            return '';
          }
        })
      )
    ).filter((e) => /\S+@\S+\.\S+/.test(e));
    if (!emails.length) return;
    await fetch('/api/notify-proposal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        emails,
        proposerName,
        eventTitle,
        groupName: group.name,
        appUrl: typeof window !== 'undefined' ? window.location.origin : '',
      }),
    });
  } catch (e) {
    console.warn('Proposal email failed:', e);
  }
};

// --- Context ---
const AppContext = createContext(null);

// --- Icons ---
const Icon = ({ path, className = 'w-6 h-6' }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d={path}></path>
  </svg>
);
const MenuIcon = () => <Icon path="M4 6h16M4 12h16M4 18h16" />;
const UserIcon = () => <Icon path="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />;
const SettingsIcon = () => <Icon path="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />;
const InfoIcon = () => <Icon path="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />;
const CloseIcon = ({ className = 'w-6 h-6' }) => <Icon path="M6 18L18 6M6 6l12 12" className={className} />;
const PlusIcon = ({ className = 'w-6 h-6' }) => <Icon path="M12 4v16m8-8H4" className={className} />;
const TrashIcon = ({ className = 'w-6 h-6' }) => <Icon path="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" className={className} />;
const SparklesIcon = ({ className = 'w-6 h-6' }) => <Icon path="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.293 2.293a1 1 0 010 1.414L15 12l-1.293 1.293a1 1 0 01-1.414 0L10 10.414l-1.293 1.293a1 1 0 01-1.414 0L5 9.414l-1.293 1.293a1 1 0 01-1.414-1.414L4.586 7.707a1 1 0 011.414 0L7.293 9l1.293-1.293a1 1 0 011.414 0L12 10.414l1.293-1.293a1 1 0 011.414 0L17 11.414l1.293-1.293a1 1 0 011.414 0L21 11.414" className={className} />;
const LightbulbIcon = ({ className = 'w-6 h-6' }) => <Icon path="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 017.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" className={className} />;
const UsersIcon = ({ className = 'w-6 h-6' }) => <Icon path="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" className={className} />;
const CalendarIcon = ({ className = 'w-6 h-6' }) => <Icon path="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" className={className} />;
const HeartIcon = ({ className = 'w-6 h-6' }) => <Icon path="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" className={className} />;
const SendIcon = ({ className = 'w-6 h-6' }) => <Icon path="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" className={className} />;
const LogoutIcon = () => <Icon path="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />;
const GoogleIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 48 48">
    <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8c-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4C12.955 4 4 12.955 4 24s8.955 20 20 20s20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"></path>
    <path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4C16.318 4 9.656 8.337 6.306 14.691z"></path>
    <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.222 0-9.519-3.534-11.082-8.192l-6.823 5.34C9.042 39.572 15.846 44 24 44z"></path>
    <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571l6.19 5.238C42.021 35.596 44 30.138 44 24c0-1.341-.138-2.65-.389-3.917z"></path>
  </svg>
);
const AppleIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24">
    <path fill="currentColor" d="M19.3,4.24a5.12,5.12,0,0,0-4.43,2.25,5.33,5.33,0,0,0-4.39-2.25C8.09,4.24,5.5,6.1,5.5,9.26A6,6,0,0,0,7,12.55a5.87,5.87,0,0,0,1.63,3.35,6.56,6.56,0,0,0,4,2.15,6.38,6.38,0,0,0,4.88-2.58,1.36,1.36,0,0,1,1-.58,1.14,1.14,0,0,1,.8.4,1.4,1.4,0,0,0,1,.58,1.54,1.54,0,0,0,1.5-1.55A5.73,5.73,0,0,0,19.3,4.24ZM12.15,2.75a3.13,3.13,0,0,1,2.23.9,3.33,3.33,0,0,1,1.1,2.4,3.58,3.58,0,0,1-2.2,3.23,3.21,3.21,0,0,1-3.46-2.1A3.35,3.35,0,0,1,12.15,2.75Z"></path>
  </svg>
);
const CameraIcon = ({ className = 'w-6 h-6' }) => <Icon path="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" className={className} />;
const LeaveIcon = () => <Icon path="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />;
const SyncIcon = ({ className = 'w-6 h-6' }) => <Icon path="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" className={className} />;
const SearchIcon = ({ className = 'w-6 h-6' }) => <Icon path="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" className={className} />;
const ChatIcon = ({ className = 'w-6 h-6' }) => <Icon path="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" className={className} />;
const CopyIcon = ({ className = 'w-6 h-6' }) => <Icon path="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" className={className} />;
const MailIcon = ({ className = 'w-6 h-6' }) => <Icon path="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" className={className} />;
const InviteIcon = ({ className = 'w-6 h-6' }) => <Icon path="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" className={className} />;
const ShareIcon = ({ className = 'w-6 h-6' }) => <Icon path="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8m-4-6l-4-4-4 4m4-4v12" className={className} />;
const FunnelIcon = ({ className = 'w-6 h-6' }) => <Icon path="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" className={className} />;

// --- Calendar Utilities ---
const generateICSFile = (suggestion) => {
  const { title, description, location, date } = suggestion;
  const startDate = new Date(date);
  const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
  const toICSDate = (d) => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const icsContent = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//HangoutsApp//NONSGML v1.0//EN',
    'BEGIN:VEVENT',
    `UID:${Date.now()}@hangouts.app`,
    `DTSTAMP:${toICSDate(new Date())}`,
    `DTSTART:${toICSDate(startDate)}`,
    `DTEND:${toICSDate(endDate)}`,
    `SUMMARY:${title}`,
    `DESCRIPTION:${description.replace(/\n/g, '\\n')}`,
    `LOCATION:${location}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${title.replace(/ /g, '_')}.ics`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

const addToGoogleCalendar = async (suggestion, token, showMsg) => {
  try {
    const { title, description, location, date } = suggestion;
    const startDate = new Date(date);
    const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
    const event = {
      summary: title,
      location,
      description,
      start: { dateTime: startDate.toISOString() },
      end: { dateTime: endDate.toISOString() },
    };
    const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
    if (!res.ok) throw new Error('API Error');
    showMsg('Event saved securely to your Google Calendar!', 'success');
    return true;
  } catch (error) {
    console.error(error);
    showMsg('Failed to add to Google Calendar.', 'error');
    return false;
  }
};

// --- Avatar ---
const Avatar = ({ src, alt, size = 'md', className = '' }) => {
  const sizeClasses = { xs: 'w-6 h-6', sm: 'w-8 h-8', md: 'w-10 h-10', lg: 'w-24 h-24', xl: 'w-32 h-32' };
  const initial = alt ? alt.charAt(0).toUpperCase() : '?';
  return (
    <div className={`${sizeClasses[size]} ${className} rounded-full overflow-hidden flex-shrink-0 bg-indigo-100 flex items-center justify-center border-2 border-white shadow-sm`}>
      {src ? (
        <img src={src} alt={alt} className="w-full h-full object-cover" />
      ) : (
        <span className="text-indigo-500 font-bold text-xs">{initial}</span>
      )}
    </div>
  );
};

// --- UI Components ---
const Modal = ({ children, onClose, title }) => (
  <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex justify-center items-center p-4 transition-all" onClick={onClose}>
    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto flex flex-col" onClick={(e) => e.stopPropagation()}>
      <header className="flex justify-between items-center p-5 border-b border-gray-100 bg-white sticky top-0 z-10">
        <h2 className="text-xl font-bold text-gray-800">{title}</h2>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-700 p-2 rounded-full hover:bg-gray-100 transition">
          <CloseIcon />
        </button>
      </header>
      <div className="p-6">{children}</div>
    </div>
  </div>
);

const UserProfileDropdown = () => {
  const { userId, userProfile, setShowProfileModal, setShowSettingsModal, setShowAboutModal } = useContext(AppContext);
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) setIsOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  if (!userId) return null;

  return (
    <div className="relative" ref={dropdownRef}>
      <button onClick={() => setIsOpen(!isOpen)} className="flex items-center gap-3 bg-white/60 backdrop-blur-md hover:bg-white/80 py-1 pl-1 pr-4 rounded-full shadow-sm border border-white/20 transition-all">
        <Avatar src={userProfile?.photoURL} alt={userProfile?.name} size="sm" />
        <span className="text-sm font-medium text-gray-700 hidden sm:block">{userProfile?.name?.split(' ')[0] || 'User'}</span>
        <MenuIcon />
      </button>
      {isOpen && (
        <div className="absolute right-0 mt-2 w-64 bg-white rounded-xl shadow-xl py-2 z-40 border border-gray-100 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 bg-gray-50/50">
            <p className="text-sm font-bold text-gray-900">{userProfile?.name || 'User'}</p>
            <p className="text-xs text-gray-500 truncate">{userId}</p>
          </div>
          <button onClick={() => { setShowProfileModal(true); setIsOpen(false); }} className="flex w-full items-center gap-3 px-4 py-3 text-sm text-gray-700 hover:bg-indigo-50 transition-colors">
            <UserIcon /> My Profile
          </button>
          <button onClick={() => { setShowSettingsModal(true); setIsOpen(false); }} className="flex w-full items-center gap-3 px-4 py-3 text-sm text-gray-700 hover:bg-indigo-50 transition-colors">
            <SettingsIcon /> Settings
          </button>
          <button onClick={() => { setShowAboutModal(true); setIsOpen(false); }} className="flex w-full items-center gap-3 px-4 py-3 text-sm text-gray-700 hover:bg-indigo-50 transition-colors">
            <InfoIcon /> About Hangouts
          </button>
          <div className="border-t border-gray-100 my-1"></div>
          <button onClick={() => signOut(auth)} className="flex w-full items-center gap-3 px-4 py-3 text-sm text-red-600 hover:bg-red-50 transition-colors">
            <LogoutIcon /> Sign Out
          </button>
        </div>
      )}
    </div>
  );
};

const Header = () => (
  <header className="relative z-30 mb-8 flex justify-between items-center">
    <h1 className="text-3xl font-extrabold text-indigo-900 tracking-tight">Hangouts</h1>
    <UserProfileDropdown />
  </header>
);

const TabButton = ({ label, tabName, activeTab, setActiveTab, badge }) => (
  <button
    className={`relative px-6 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200 whitespace-nowrap ${
      activeTab === tabName ? 'bg-white text-indigo-600 shadow-sm transform scale-105' : 'text-gray-600 hover:bg-white/50'
    }`}
    onClick={() => setActiveTab(tabName)}
  >
    {label}
    {badge > 0 && (
      <span className="absolute -top-1 -right-1 min-w-5 h-5 px-1.5 bg-red-500 text-white text-xs font-bold rounded-full flex items-center justify-center shadow">
        {badge > 9 ? '9+' : badge}
      </span>
    )}
  </button>
);

const MainContent = () => {
  const [activeTab, setActiveTab] = useState('myFeed');
  const { unreadFeedCount, markFeedRead } = useContext(AppContext);

  // When the user lands on (or returns to) the My Feed tab, clear the unread badge.
  useEffect(() => {
    if (activeTab === 'myFeed' && unreadFeedCount > 0) markFeedRead();
  }, [activeTab, unreadFeedCount, markFeedRead]);

  return (
    <div className="max-w-6xl mx-auto">
      <nav className="mb-8 flex justify-center">
        <div className="bg-white/40 backdrop-blur-lg p-1.5 rounded-2xl shadow-sm inline-flex overflow-x-auto max-w-full">
          <TabButton label="My Feed" tabName="myFeed" activeTab={activeTab} setActiveTab={setActiveTab} badge={unreadFeedCount} />
          <TabButton label="My Groups" tabName="groups" activeTab={activeTab} setActiveTab={setActiveTab} />
          <TabButton label="Suggestions" tabName="suggestions" activeTab={activeTab} setActiveTab={setActiveTab} />
          <TabButton label="Plan" tabName="plan" activeTab={activeTab} setActiveTab={setActiveTab} />
        </div>
      </nav>
      <div className="bg-white/60 backdrop-blur-xl rounded-3xl shadow-xl border border-white/40 p-4 md:p-6 min-h-[60vh]">
        {activeTab === 'myFeed' && <MyFeedSection />}
        {activeTab === 'groups' && <GroupSection />}
        {activeTab === 'suggestions' && <SuggestionSection />}
        {activeTab === 'plan' && <PlanSection />}
      </div>
    </div>
  );
};

// --- Modals ---
const ProfileModal = ({ onClose }) => (
  <Modal onClose={onClose} title="Edit Profile">
    <ProfileSection onClose={onClose} />
  </Modal>
);
const SettingsModal = ({ onClose }) => (
  <Modal onClose={onClose} title="Settings">
    <SettingsSection onClose={onClose} />
  </Modal>
);
const AboutModal = ({ onClose }) => (
  <Modal onClose={onClose} title="About Hangouts">
    <div className="space-y-4 text-gray-600 leading-relaxed">
      <p className="text-lg text-gray-800 font-medium">Simplify your social life.</p>
      <p>Hangouts uses advanced AI with live Search Grounding to find the perfect real activity for any group, taking into account everyone's schedule, location, and preferences.</p>
      <div className="bg-indigo-50 p-4 rounded-xl border border-indigo-100">
        <h4 className="font-bold text-indigo-900 mb-2">What's in here</h4>
        <ul className="list-disc list-inside space-y-1 text-sm">
          <li>Live Google Search grounded event discovery</li>
          <li>Real Unsplash images for every event</li>
          <li>Group invites via shareable link or email</li>
          <li>Group proposals with Accept / Decline RSVPs</li>
          <li>Calendar mining — Gemini turns your Google Calendar into free-time blocks</li>
          <li>Infinite scroll on your feed</li>
        </ul>
      </div>
      <div className="bg-amber-50 p-4 rounded-xl border border-amber-100">
        <h4 className="font-bold text-amber-900 mb-2">Using iPhone / iCloud Calendar?</h4>
        <p className="text-sm mb-2">Hangouts reads from Google Calendar, but you can sync your iCloud calendar into Google in two minutes:</p>
        <ol className="list-decimal list-inside space-y-1 text-sm">
          <li>On your iPhone: <em>Settings → Calendar → Accounts → Add Account → Google</em>. Sign in.</li>
          <li>Make sure "Calendars" is toggled on for that Google account.</li>
          <li>Open the Calendar app, hit "Calendars" at the bottom, and check every Google calendar you want Hangouts to see.</li>
          <li>(Optional) From iCloud.com → Calendar → click the radio-tower icon next to a calendar → Public Calendar → copy the link → in Google Calendar (web) → Other calendars → From URL.</li>
        </ol>
        <p className="text-xs text-gray-500 mt-2">After syncing, hit "Analyze with Gemini" in your profile to mine the combined view.</p>
      </div>
      <div className="bg-rose-50 p-4 rounded-xl border border-rose-100 text-sm">
        <h4 className="font-bold text-rose-900 mb-1">Private preview</h4>
        <p>This is a friends-and-family build. Please don't share the passcode or the URL outside the group.</p>
      </div>
    </div>
  </Modal>
);

const SettingsSection = ({ onClose }) => {
  const { userId, userProfile, setUserProfile, showGlobalMessage } = useContext(AppContext);
  const [allowLocation, setAllowLocation] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (userProfile) setAllowLocation(userProfile.allowLocationTracking || false);
  }, [userProfile]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await updateDoc(doc(db, `artifacts/${appId}/users/${userId}/profiles`, 'myProfile'), { allowLocationTracking: allowLocation });
      setUserProfile((prev) => ({ ...prev, allowLocationTracking: allowLocation }));
      showGlobalMessage('Settings updated.');
      onClose();
    } catch (error) {
      showGlobalMessage('Failed to save settings.', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between p-4 bg-gray-50 rounded-xl">
        <div>
          <h3 className="font-medium text-gray-900">Location Services</h3>
          <p className="text-sm text-gray-500">Enable specifically for localized suggestions.</p>
        </div>
        <input
          type="checkbox"
          checked={allowLocation}
          onChange={(e) => setAllowLocation(e.target.checked)}
          className="w-6 h-6 text-indigo-600 rounded focus:ring-indigo-500 border-gray-300"
        />
      </div>
      <div className="flex justify-end">
        <button onClick={handleSave} disabled={isSaving} className="bg-indigo-600 text-white font-medium py-2 px-6 rounded-xl hover:bg-indigo-700 transition">
          {isSaving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
};

const ProfileSection = ({ onClose }) => {
  const { userId, userProfile, setUserProfile, showGlobalMessage, googleAccessToken, triggerFeedRefresh } = useContext(AppContext);
  const [name, setName] = useState(userProfile?.name || '');
  const [address, setAddress] = useState(userProfile?.address || '');
  const [kids, setKids] = useState(userProfile?.kids || []);
  const [newKidName, setNewKidName] = useState('');
  const [newKidAge, setNewKidAge] = useState('');
  const [preferences, setPreferences] = useState(userProfile?.preferences || []);
  const [preferenceDetails, setPreferenceDetails] = useState(userProfile?.preferenceDetails || {});
  // Budget preferences: a free/paid lean + an optional per-person price cap.
  const [budgetLean, setBudgetLean] = useState(userProfile?.budgetLean || 'any'); // any | free | paid
  const [maxPricePerPerson, setMaxPricePerPerson] = useState(userProfile?.maxPricePerPerson || '');
  const [refineBucket, setRefineBucket] = useState(null); // taxonomy bucket to drill into after a broad add
  const [currentPreference, setCurrentPreference] = useState('');
  const [availableDates, setAvailableDates] = useState(userProfile?.availability || []);
  // Per-date slot picker. Map of "YYYY-MM-DD" -> ["morning"|"afternoon"|"evening"].
  // Migration: if a date is in availability but missing from slots, treat as all-day.
  const [availabilitySlots, setAvailabilitySlots] = useState(() => {
    const existing = userProfile?.availabilitySlots || {};
    const migrated = { ...existing };
    (userProfile?.availability || []).forEach((d) => {
      if (!migrated[d]) migrated[d] = ['morning', 'afternoon', 'evening'];
    });
    return migrated;
  });
  // weeklyAvailability is the canonical recurring-availability field:
  // { Mon: ['morning','evening'], Sat: ['afternoon','evening'], ... }
  // Migration from the old separate pickers: cross-product the old
  // dayOfWeekPrefs × timeOfDayPrefs values to backfill.
  const [weeklyAvailability, setWeeklyAvailability] = useState(() => {
    if (userProfile?.weeklyAvailability && typeof userProfile.weeklyAvailability === 'object') {
      return userProfile.weeklyAvailability;
    }
    const days = userProfile?.dayOfWeekPrefs || [];
    const times = userProfile?.timeOfDayPrefs || [];
    if (!days.length || !times.length) return {};
    const slotMap = { Mornings: 'morning', Afternoons: 'afternoon', Evenings: 'evening' };
    const slots = times.map((t) => slotMap[t]).filter(Boolean);
    return Object.fromEntries(days.map((d) => [d, slots]));
  });
  const [freeSlots, setFreeSlots] = useState(userProfile?.freeSlots || []);
  const [isSaving, setIsSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [analyzingCalendar, setAnalyzingCalendar] = useState(false);
  const [showSurvey, setShowSurvey] = useState(false);
  const [currentLocation, setCurrentLocation] = useState(userProfile?.currentLocation || null);
  const [locationPreference, setLocationPreference] = useState(userProfile?.locationPreference || 'home');
  const [locatingNow, setLocatingNow] = useState(false);
  // AI provider preference + user-supplied key. Provider syncs to profile;
  // the key lives only in localStorage so it never leaves the device.
  const [aiProvider, setAiProvider] = useState(userProfile?.aiProvider || 'gemini');
  const [aiKeyInput, setAiKeyInput] = useState('');
  const [aiKeySaved, setAiKeySaved] = useState(false);
  // Collapsed by default — only expand the BYO-key picker if the user is
  // already off the shared Gemini default.
  const [showOwnAI, setShowOwnAI] = useState(
    !!(userProfile?.aiProvider && userProfile.aiProvider !== 'gemini')
  );

  // Load any stored key for the currently-selected provider when it changes
  // so the field shows the user's existing value.
  useEffect(() => {
    if (aiProvider === 'gemini') {
      setAiKeyInput('');
      setAiKeySaved(false);
      return;
    }
    const existing = getStoredKey(aiProvider);
    setAiKeyInput(existing);
    setAiKeySaved(!!existing);
  }, [aiProvider]);

  const handleAiKeyChange = (val) => {
    setAiKeyInput(val);
    storeKey(aiProvider, val.trim());
    setAiKeySaved(!!val.trim());
  };

  const collapseToDefault = () => {
    setShowOwnAI(false);
    setAiProvider('gemini');
  };

  const refreshCurrentLocation = async () => {
    if (!navigator.geolocation) {
      showGlobalMessage('Your browser does not support geolocation.', 'error');
      return;
    }
    setLocatingNow(true);
    try {
      // Wrap the callback-style API in a promise.
      const pos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 12000, maximumAge: 60000 });
      });
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      // Reverse-geocode via BigDataCloud's keyless client endpoint.
      let label = `${lat.toFixed(3)}, ${lng.toFixed(3)}`;
      try {
        const res = await fetch(
          `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`
        );
        if (res.ok) {
          const data = await res.json();
          const parts = [data.city || data.locality, data.principalSubdivision, data.countryCode].filter(Boolean);
          if (parts.length) label = parts.join(', ');
        }
      } catch {
        /* keep coord-only label */
      }
      const loc = { lat, lng, label, capturedAt: new Date().toISOString() };
      setCurrentLocation(loc);
      showGlobalMessage(`Current location set: ${label}`);
    } catch (e) {
      console.error(e);
      const msg =
        e?.code === 1
          ? 'Permission denied. Allow location access in your browser settings.'
          : 'Could not get your current location.';
      showGlobalMessage(msg, 'error');
    } finally {
      setLocatingNow(false);
    }
  };

  const handleImageUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    try {
      const storageRef = ref(storage, `users/${userId}/profile_${Date.now()}`);
      await uploadBytes(storageRef, file);
      const url = await getDownloadURL(storageRef);
      await updateDoc(doc(db, `artifacts/${appId}/users/${userId}/profiles`, 'myProfile'), { photoURL: url });
      setUserProfile((prev) => ({ ...prev, photoURL: url }));
      showGlobalMessage('Profile picture updated!');
    } catch (error) {
      console.error(error);
      showGlobalMessage('Failed to upload image.', 'error');
    } finally {
      setUploading(false);
    }
  };

  const handleSaveProfile = async () => {
    setIsSaving(true);
    try {
      // Derive legacy timeOfDayPrefs / dayOfWeekPrefs from the new
      // weeklyAvailability matrix so any older code paths (and the
      // group-suggestion fallback prompt) keep working.
      const slotToLabel = { morning: 'Mornings', afternoon: 'Afternoons', evening: 'Evenings' };
      const derivedDayOfWeek = Object.entries(weeklyAvailability)
        .filter(([, s]) => Array.isArray(s) && s.length)
        .map(([d]) => d);
      const derivedTimeOfDay = [
        ...new Set(Object.values(weeklyAvailability).flat().map((s) => slotToLabel[s]).filter(Boolean)),
      ];
      const update = {
        name,
        address,
        kids,
        preferences,
        preferenceDetails,
        budgetLean,
        // Store the cap as a number (or null when cleared) so the feed prompt
        // and any filtering can use it numerically.
        maxPricePerPerson: maxPricePerPerson === '' ? null : Number(maxPricePerPerson) || null,
        availability: availableDates,
        availabilitySlots,
        weeklyAvailability,
        timeOfDayPrefs: derivedTimeOfDay,
        dayOfWeekPrefs: derivedDayOfWeek,
        freeSlots,
        currentLocation,
        locationPreference,
        aiProvider,
        // Mark profile as completed (used by the onboarding banner).
        profileCompletedAt: serverTimestamp(),
      };
      await updateDoc(doc(db, `artifacts/${appId}/users/${userId}/profiles`, 'myProfile'), update);
      setUserProfile((prev) => ({ ...prev, ...update }));
      showGlobalMessage('Profile saved successfully!');
      // Kick the feed to generate fresh ideas based on the new profile.
      if (triggerFeedRefresh) triggerFeedRefresh();
      onClose();
    } catch (e) {
      showGlobalMessage('Error saving profile.', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const togglePref = (list, setter, value) =>
    setter(list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);

  const toggleWeeklySlot = (day, slot) => {
    setWeeklyAvailability((prev) => {
      const current = prev[day] || [];
      const next = current.includes(slot) ? current.filter((s) => s !== slot) : [...current, slot];
      if (next.length === 0) {
        const { [day]: _drop, ...rest } = prev;
        return rest;
      }
      return { ...prev, [day]: next };
    });
  };

  const analyzeCalendarWithGemini = async () => {
    if (!googleAccessToken) {
      showGlobalMessage('Google Calendar access required. Please sign out and sign back in to grant permission.', 'error');
      return;
    }
    if (!geminiApiKey) {
      showGlobalMessage('Gemini API key missing. Set VITE_GEMINI_API_KEY in your environment.', 'error');
      return;
    }
    setAnalyzingCalendar(true);
    try {
      const now = new Date();
      const nextMonth = new Date();
      nextMonth.setDate(now.getDate() + 30);
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${now.toISOString()}&timeMax=${nextMonth.toISOString()}&singleEvents=true&orderBy=startTime`,
        { headers: { Authorization: `Bearer ${googleAccessToken}` } }
      );
      if (!res.ok) throw new Error('Failed to fetch calendar data.');
      const calendarData = await res.json();
      const events = calendarData.items
        ? calendarData.items.map((e) => ({ start: e.start.dateTime || e.start.date, end: e.end.dateTime || e.end.date, summary: e.summary }))
        : [];

      const prompt = `Here is a list of my calendar events for the next 30 days: ${JSON.stringify(events)}.
Analyze my schedule and identify SPECIFIC FREE TIME BLOCKS where I could realistically attend a 1-3 hour social hangout.
Rules:
- Assume my "social hours" are roughly 9:00 to 22:00 local time (not overnight).
- A free block must be at least 90 minutes long with no conflicting events.
- Prefer evenings (after 17:00) and weekend afternoons; only suggest weekday daytime blocks if I have a clearly open calendar.
- Skip any block that ends less than 30 minutes before the next event (need transit/buffer time).
- Cap at the 25 best blocks.
Return ONLY a JSON array (no prose, no markdown fences) of objects with shape:
{ "date": "YYYY-MM-DD", "start": "HH:MM", "end": "HH:MM", "label": "short human label like 'Tue evening' or 'Sat afternoon'" }`;

      const provider = userProfile?.aiProvider || 'gemini';
      const text = await callAI({ prompt, useWebSearch: false, provider });
      const slots = extractJsonArray(text);
      if (!slots) throw new Error('Could not parse calendar analysis JSON.');
      setFreeSlots(slots);
      // Keep the day-level checked state in sync so the calendar reflects which days have any availability
      const days = [...new Set(slots.map((s) => s.date))].sort();
      setAvailableDates((prev) => [...new Set([...prev, ...days])].sort());
      showGlobalMessage(`Synced! Found ${slots.length} free time blocks across ${days.length} days.`);
    } catch (error) {
      console.error(error);
      showGlobalMessage('Could not sync calendar.', 'error');
    } finally {
      setAnalyzingCalendar(false);
    }
  };

  const addKid = () => {
    if (newKidName && newKidAge) {
      setKids([...kids, { name: newKidName, age: parseInt(newKidAge, 10) }]);
      setNewKidName('');
      setNewKidAge('');
    }
  };
  const removeKid = (i) => setKids(kids.filter((_, idx) => idx !== i));
  const addPreference = () => {
    const val = currentPreference.trim();
    if (val && !preferences.includes(val)) {
      setPreferences([...preferences, val]);
    }
    setCurrentPreference('');
    // If they added a broad interest (food/drinks/music), prompt for specifics.
    const bucket = taxonomyBucketFor(val);
    if (bucket) setRefineBucket(bucket);
  };
  const removePreference = (p) => setPreferences(preferences.filter((pref) => pref !== p));
  // One-tap chip: toggle a broad interest in/out of preferences. Adding a chip
  // that maps to a taxonomy bucket opens the specifics drill-down, mirroring
  // the free-text add path.
  const toggleQuickInterest = (label) => {
    if (preferences.includes(label)) {
      removePreference(label);
      return;
    }
    setPreferences((prev) => [...prev, label]);
    const bucket = taxonomyBucketFor(label);
    if (bucket) setRefineBucket(bucket);
  };
  // Add a specific (e.g. "Italian") to both the flat list and the structured
  // preferenceDetails bucket so place recommendations can use it.
  const addSpecific = (bucket, opt) => {
    setPreferences((prev) => (prev.includes(opt) ? prev : [...prev, opt]));
    setPreferenceDetails((prev) => {
      const existing = prev[bucket.key] || [];
      if (existing.includes(opt)) return prev;
      return { ...prev, [bucket.key]: [...existing, opt] };
    });
  };
  const handleDateToggle = (d) => {
    setAvailableDates((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort()));
    setAvailabilitySlots((prev) => {
      if (prev[d]) {
        // Toggling off — drop the entry entirely
        const { [d]: _drop, ...rest } = prev;
        return rest;
      }
      // Toggling on — default to all-day available
      return { ...prev, [d]: ['morning', 'afternoon', 'evening'] };
    });
  };
  const handleSlotToggle = (date, slot) => {
    setAvailabilitySlots((prev) => {
      const current = prev[date] || ['morning', 'afternoon', 'evening'];
      const next = current.includes(slot) ? current.filter((s) => s !== slot) : [...current, slot];
      // If the user clears every slot, drop the date from availability too
      if (next.length === 0) {
        const { [date]: _drop, ...rest } = prev;
        setAvailableDates((d) => d.filter((x) => x !== date));
        return rest;
      }
      return { ...prev, [date]: next };
    });
  };

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-6">
        <div className="relative group">
          <Avatar src={userProfile?.photoURL} alt={name} size="xl" />
          <label className="absolute inset-0 bg-black/30 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer text-white">
            <CameraIcon className="w-8 h-8" />
            <input type="file" accept="image/*" className="hidden" onChange={handleImageUpload} disabled={uploading} />
          </label>
          {uploading && (
            <div className="absolute inset-0 bg-white/50 flex items-center justify-center rounded-full">
              <div className="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
            </div>
          )}
        </div>
        <div className="flex-1 space-y-4">
          <div>
            <label className="block text-xs font-semibold uppercase text-gray-500 mb-1">Display Name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} className="w-full p-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:bg-white transition" />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase text-gray-500 mb-1">Home Base (City/Zip)</label>
            <input type="text" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="e.g. New York, NY" className="w-full p-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:bg-white transition" />
          </div>
        </div>
      </div>

      <div className="space-y-3 bg-gray-50 border border-gray-200 rounded-2xl p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="font-bold text-gray-800">Current location</h3>
            <p className="text-xs text-gray-500">Use this when traveling so suggestions reflect where you actually are right now.</p>
          </div>
          <button
            type="button"
            onClick={refreshCurrentLocation}
            disabled={locatingNow}
            className="text-xs bg-indigo-50 text-indigo-700 px-3 py-1.5 rounded-lg font-bold flex items-center gap-1 hover:bg-indigo-100 transition disabled:opacity-50 whitespace-nowrap"
          >
            {locatingNow ? (
              <div className="w-3 h-3 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
            ) : (
              <Icon path="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" className="w-4 h-4" />
            )}
            {currentLocation ? 'Update' : 'Get current location'}
          </button>
        </div>
        {currentLocation && (
          <p className="text-sm text-gray-700">
            <span className="font-semibold">Last captured:</span> {currentLocation.label}
            {currentLocation.capturedAt && (
              <span className="text-gray-400 text-xs ml-2">({new Date(currentLocation.capturedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })})</span>
            )}
          </p>
        )}
        {/* moved to AI provider section below */}
        <div>
          <label className="block text-xs font-semibold uppercase text-gray-500 mb-2">When suggesting events, use…</label>
          <div className="flex flex-wrap gap-2">
            {[
              { id: 'home', label: 'Home only' },
              { id: 'current', label: 'Current location only', disabled: !currentLocation },
              { id: 'both', label: 'Both (mix)', disabled: !currentLocation },
            ].map((opt) => {
              const active = locationPreference === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  disabled={opt.disabled}
                  onClick={() => setLocationPreference(opt.id)}
                  className={`px-3 py-1.5 rounded-full text-sm font-medium border transition ${
                    active ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-700 border-gray-200 hover:border-indigo-300'
                  } ${opt.disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                  title={opt.disabled ? 'Get your current location first' : ''}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="space-y-3 bg-gray-50 border border-gray-200 rounded-2xl p-4">
        {!showOwnAI ? (
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h3 className="font-bold text-gray-800">AI Provider</h3>
              <p className="text-xs text-gray-500">Using the shared Gemini key (free, may hit a rate limit on heavy days).</p>
            </div>
            <button
              type="button"
              onClick={() => setShowOwnAI(true)}
              className="text-xs bg-indigo-50 text-indigo-700 px-3 py-1.5 rounded-lg font-bold hover:bg-indigo-100 transition whitespace-nowrap"
            >
              Use my own AI →
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-bold text-gray-800">Use my own AI</h3>
                <p className="text-xs text-gray-500 leading-relaxed">
                  Heads up: this needs a developer API key from one of the providers below — your ChatGPT/Claude/Gemini subscription does <span className="font-semibold">not</span> include API access (they're separate products). The key stays only on this device.
                </p>
              </div>
              <button
                type="button"
                onClick={collapseToDefault}
                className="text-xs text-gray-500 hover:text-gray-800 underline whitespace-nowrap"
              >
                Back to default
              </button>
            </div>
            <div className="space-y-2">
              {AI_PROVIDERS.filter((p) => p.id !== 'gemini').map((p) => {
                const active = aiProvider === p.id;
                return (
                  <label
                    key={p.id}
                    className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition ${
                      active ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 bg-white hover:border-indigo-300'
                    }`}
                  >
                    <input
                      type="radio"
                      name="aiProvider"
                      checked={active}
                      onChange={() => setAiProvider(p.id)}
                      className="mt-1"
                    />
                    <div className="flex-1">
                      <p className="text-sm font-medium text-gray-800">{p.label.replace(' (use my own API key)', '').replace(' (use my own Anthropic key)', '').replace(' (use my own key)', '')}</p>
                      {p.keyHint && active && (
                        <p className="text-xs text-gray-500 mt-1">Get a key at <span className="font-mono">{p.keyHint}</span></p>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>
            {AI_PROVIDERS.find((p) => p.id === aiProvider)?.needsKey && (
              <div>
                <label className="block text-xs font-semibold uppercase text-gray-500 mb-1">Your API key</label>
                <input
                  type="password"
                  value={aiKeyInput}
                  onChange={(e) => handleAiKeyChange(e.target.value)}
                  placeholder="Paste your key here"
                  className="w-full p-3 bg-white border border-gray-200 rounded-xl focus:ring-2 focus:ring-indigo-500 text-sm font-mono"
                />
                <p className="text-xs text-gray-400 mt-1">
                  {aiKeySaved ? '✓ Saved on this device. Never synced.' : 'Key is stored locally only.'}
                </p>
              </div>
            )}
          </>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-bold text-gray-800 flex items-center gap-2">
              <HeartIcon className="w-5 h-5 text-pink-500" /> Preferences
            </h3>
            <button
              type="button"
              onClick={() => setShowSurvey(true)}
              className="text-xs bg-pink-50 text-pink-700 px-3 py-1.5 rounded-lg font-bold flex items-center gap-1 hover:bg-pink-100 transition"
              title="Take a 1-minute AI-tailored interest survey"
            >
              <SparklesIcon className="w-4 h-4" /> Take Survey
            </button>
          </div>
          <p className="text-xs text-gray-400 mb-2">Tap to add — or use the survey / type your own below.</p>
          <div className="flex flex-wrap gap-2 mb-3">
            {QUICK_INTEREST_CHIPS.map((chip) => {
              const on = preferences.includes(chip);
              return (
                <button
                  key={chip}
                  type="button"
                  onClick={() => toggleQuickInterest(chip)}
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition ${
                    on ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-700 border-gray-200 hover:border-indigo-300'
                  }`}
                >
                  {chip}
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap gap-2 mb-3">
            {preferences.map((pref) => (
              <span key={pref} className="flex items-center bg-indigo-50 text-indigo-700 px-3 py-1 rounded-full text-sm font-medium border border-indigo-100">
                {pref}
                <button onClick={() => removePreference(pref)} className="ml-2 hover:text-indigo-900">
                  <CloseIcon className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={currentPreference}
              onChange={(e) => setCurrentPreference(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addPreference()}
              className="flex-1 p-2 bg-gray-50 border border-gray-200 rounded-lg text-sm"
              placeholder="e.g. Hiking, Live Music"
            />
            <button onClick={addPreference} className="p-2 bg-indigo-100 text-indigo-600 rounded-lg hover:bg-indigo-200">
              <PlusIcon />
            </button>
          </div>
          {refineBucket && (
            <div className="mt-3 bg-pink-50 border border-pink-100 rounded-xl p-3">
              <div className="flex justify-between items-center mb-2">
                <p className="text-xs font-bold text-pink-800">{refineBucket.question}</p>
                <button type="button" onClick={() => setRefineBucket(null)} className="text-pink-400 hover:text-pink-700" title="Done">
                  <CloseIcon className="w-4 h-4" />
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {refineBucket.options.map((opt) => {
                  const on = preferences.includes(opt);
                  return (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => addSpecific(refineBucket, opt)}
                      disabled={on}
                      className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition ${
                        on ? 'bg-pink-600 text-white border-pink-600' : 'bg-white text-gray-700 border-gray-200 hover:border-pink-300'
                      }`}
                    >
                      {opt}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {showSurvey && (
            <SurveyModal
              onClose={() => setShowSurvey(false)}
              onPreferencesUpdate={(newPrefs, details) => {
                setPreferences(newPrefs);
                if (details) setPreferenceDetails(details);
              }}
            />
          )}
        </div>
        <div>
          <h3 className="font-bold text-gray-800 mb-3 flex items-center gap-2">
            <UsersIcon className="w-5 h-5 text-blue-500" /> Family
          </h3>
          <div className="space-y-2 mb-3">
            {kids.map((kid, i) => (
              <div key={i} className="flex justify-between items-center bg-gray-50 p-2 rounded-lg text-sm">
                <span>
                  {kid.name} <span className="text-gray-400">({kid.age}y)</span>
                </span>
                <button onClick={() => removeKid(i)} className="text-red-400 hover:text-red-600">
                  <TrashIcon className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input type="text" value={newKidName} onChange={(e) => setNewKidName(e.target.value)} className="flex-1 p-2 bg-gray-50 border border-gray-200 rounded-lg text-sm" placeholder="Name" />
            <input type="number" value={newKidAge} onChange={(e) => setNewKidAge(e.target.value)} className="w-16 p-2 bg-gray-50 border border-gray-200 rounded-lg text-sm" placeholder="Age" />
            <button onClick={addKid} className="p-2 bg-blue-100 text-blue-600 rounded-lg hover:bg-blue-200">
              <PlusIcon />
            </button>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <h3 className="font-bold text-gray-800 flex items-center gap-2">
          <Icon path="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1" className="w-5 h-5 text-emerald-500" />
          Budget
        </h3>
        <p className="text-xs text-gray-500">Used to tailor and filter your feed. Leave as “Any” for no preference.</p>
        <div className="flex flex-wrap gap-2">
          {[
            { id: 'any', label: 'Any' },
            { id: 'free', label: 'Free / cheap' },
            { id: 'paid', label: 'Happy to pay' },
          ].map((opt) => {
            const on = budgetLean === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => setBudgetLean(opt.id)}
                className={`px-4 py-2 rounded-full text-sm font-semibold border transition ${
                  on ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-gray-700 border-gray-200 hover:border-emerald-300'
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600">Max per person</label>
          <div className="flex items-center bg-gray-50 border border-gray-200 rounded-lg px-2">
            <span className="text-gray-400 text-sm">$</span>
            <input
              type="number"
              min="0"
              value={maxPricePerPerson}
              onChange={(e) => setMaxPricePerPerson(e.target.value)}
              className="w-20 p-2 bg-transparent text-sm focus:outline-none"
              placeholder="No cap"
            />
          </div>
          {maxPricePerPerson !== '' && (
            <button type="button" onClick={() => setMaxPricePerPerson('')} className="text-xs text-gray-400 hover:text-gray-600">
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="space-y-3">
        <h3 className="font-bold text-gray-800">When are you usually free?</h3>
        <p className="text-xs text-gray-500">Tap the times you're typically open for each day. Each row is independent.</p>
        <div className="space-y-1.5">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => {
            const daySlots = weeklyAvailability[day] || [];
            return (
              <div key={day} className="flex items-center justify-between gap-2 bg-gray-50 rounded-xl p-2.5">
                <span className="text-sm font-semibold text-gray-800 w-12 shrink-0">{day}</span>
                <div className="flex gap-1 flex-1 justify-end">
                  {[
                    { id: 'morning', short: 'AM' },
                    { id: 'afternoon', short: 'PM' },
                    { id: 'evening', short: 'Eve' },
                  ].map(({ id, short }) => {
                    const on = daySlots.includes(id);
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => toggleWeeklySlot(day, id)}
                        className={`px-3 py-1 rounded-md text-xs font-semibold border transition ${
                          on ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-500 border-gray-200 hover:border-indigo-300'
                        }`}
                      >
                        {short}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <div className="flex justify-between items-center mb-3">
          <h3 className="font-bold text-gray-800">Availability Calendar</h3>
          <button onClick={analyzeCalendarWithGemini} disabled={analyzingCalendar} className="text-xs bg-indigo-50 text-indigo-700 px-3 py-1.5 rounded-lg font-bold flex items-center gap-1 hover:bg-indigo-100 transition disabled:opacity-50">
            {analyzingCalendar ? (
              <div className="w-3 h-3 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
            ) : (
              <SyncIcon className="w-4 h-4" />
            )}
            Analyze with Gemini
          </button>
        </div>
        <CalendarPicker selectedDates={availableDates} onDateToggle={handleDateToggle} />

        {availableDates.length > 0 && (
          <div className="mt-4 space-y-2 max-h-72 overflow-y-auto pr-1">
            <p className="text-xs font-semibold uppercase text-gray-500 px-1">Times of day for each date</p>
            {availableDates.map((d) => {
              const slots = availabilitySlots[d] || ['morning', 'afternoon', 'evening'];
              const labelDate = new Date(d + 'T12:00');
              const label = labelDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
              return (
                <div key={d} className="flex items-center justify-between gap-2 bg-gray-50 rounded-xl p-2.5">
                  <span className="text-sm font-medium text-gray-800 w-32 shrink-0">{label}</span>
                  <div className="flex gap-1 flex-1 justify-end flex-wrap">
                    {[
                      { id: 'morning', short: 'AM' },
                      { id: 'afternoon', short: 'PM' },
                      { id: 'evening', short: 'Eve' },
                    ].map(({ id, short }) => {
                      const on = slots.includes(id);
                      return (
                        <button
                          key={id}
                          type="button"
                          onClick={() => handleSlotToggle(d, id)}
                          className={`px-2.5 py-1 rounded-md text-xs font-semibold border transition ${
                            on ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-500 border-gray-200 hover:border-indigo-300'
                          }`}
                        >
                          {short}
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      onClick={() => handleDateToggle(d)}
                      className="ml-1 p-1 text-gray-400 hover:text-red-500 transition"
                      title="Remove date"
                    >
                      <CloseIcon className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {freeSlots.length > 0 && (
          <div className="mt-4 bg-indigo-50 border border-indigo-100 rounded-xl p-4">
            <h4 className="text-sm font-bold text-indigo-900 mb-2">Free time blocks ({freeSlots.length})</h4>
            <div className="max-h-48 overflow-y-auto space-y-1 text-sm text-indigo-800">
              {freeSlots.map((s, i) => (
                <div key={i} className="flex justify-between gap-2 py-1 border-b border-indigo-100 last:border-0">
                  <span className="font-medium">{s.label || s.date}</span>
                  <span className="font-mono text-xs">{s.date} · {s.start}–{s.end}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="flex justify-end pt-4 border-t">
        <button onClick={handleSaveProfile} disabled={isSaving} className="bg-indigo-600 text-white font-bold py-3 px-8 rounded-xl hover:bg-indigo-700 transition shadow-lg shadow-indigo-200">
          {isSaving ? 'Saving...' : 'Save Profile'}
        </button>
      </div>
    </div>
  );
};

const CalendarPicker = ({ selectedDates, onDateToggle }) => {
  const [date, setDate] = useState(new Date());
  const changeMonth = (offset) =>
    setDate((prev) => {
      const newDate = new Date(prev);
      newDate.setMonth(newDate.getMonth() + offset);
      return newDate;
    });
  const month = date.getMonth();
  const year = date.getFullYear();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDay = new Date(year, month, 1).getDay();
  const dayNames = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const renderDays = () => {
    const days = [];
    for (let i = 0; i < firstDay; i++) days.push(<div key={`empty-${i}`} className="w-8 h-8"></div>);
    for (let day = 1; day <= daysInMonth; day++) {
      const dateString = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const isSelected = selectedDates.includes(dateString);
      const isToday = new Date().toDateString() === new Date(year, month, day).toDateString();
      days.push(
        <div
          key={dateString}
          onClick={() => onDateToggle(dateString)}
          className={`w-8 h-8 sm:w-10 sm:h-10 flex items-center justify-center rounded-full cursor-pointer transition-all ${
            isSelected ? 'bg-indigo-600 text-white shadow-md' : 'hover:bg-gray-100 text-gray-700'
          } ${isToday && !isSelected ? 'ring-2 ring-indigo-200 font-bold' : ''}`}
        >
          {day}
        </div>
      );
    }
    return days;
  };
  return (
    <div className="bg-white border border-gray-200 p-4 rounded-xl">
      <div className="flex justify-between items-center mb-4">
        <button onClick={() => changeMonth(-1)} className="p-1 hover:bg-gray-100 rounded">&lt;</button>
        <h4 className="font-bold text-gray-800">
          {date.toLocaleString('default', { month: 'long' })} {year}
        </h4>
        <button onClick={() => changeMonth(1)} className="p-1 hover:bg-gray-100 rounded">&gt;</button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-xs font-bold text-gray-400 mb-2">
        {dayNames.map((d, i) => (
          <div key={`header-${i}`}>{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1 place-items-center text-sm">{renderDays()}</div>
    </div>
  );
};

const PATIENCE_MESSAGES = [
  'Searching the web for events near you…',
  'Checking which ones are still on…',
  'Filtering by your interests and availability…',
  'Looking for things you haven\'t seen yet…',
  'Pulling images and final details…',
  'Almost there — polishing the results…',
];

// Scope expansion as the user scrolls. Each "load more" jumps to the
// next tier so we keep finding fresh content instead of repeating the
// same local venues. Refresh resets the user to tier 0.
const SCOPE_TIERS = [
  { label: 'your immediate neighborhood (~3 miles)', radius: '3 miles', radiusMiles: 3 },
  { label: 'adjacent neighborhoods (~10 miles)', radius: '10 miles', radiusMiles: 10 },
  { label: 'your full city / borough (~25 miles)', radius: '25 miles', radiusMiles: 25 },
  { label: 'the wider metro region (~60 miles)', radius: '60 miles', radiusMiles: 60 },
];

// Map priceTier strings to a numeric sort weight; events without a tier
// land at the bottom of price-sorted lists.
const PRICE_WEIGHT = { Free: 0, '$': 1, '$$': 2, '$$$': 3, '$$$$': 4 };
const priceWeight = (tier) => (PRICE_WEIGHT[tier] !== undefined ? PRICE_WEIGHT[tier] : 99);

// A reference timestamp far in the past. Items written with timestamps
// less than ~year 2010 will always sort below items written with
// serverTimestamp() in desc order. We decrement from this base for each
// infinite-scroll-triggered write so later scrolls appear below earlier
// ones, all of them below any refreshed/proposed items.
const SCROLL_TIMESTAMP_BASE = new Date('2005-01-01').getTime();

// Classify a feed item by its event date relative to now, for the
// Today / Upcoming tab split:
//   'today'    — the event is happening today
//   'upcoming' — the event is on a future day
//   'past'     — the event already happened (hidden from both tabs)
//   'undated'  — no parseable date; surfaced under Upcoming so nothing
//                silently disappears from the feed.
const eventDateBucket = (item) => {
  const raw = item?.data?.date;
  const t = raw ? new Date(raw).getTime() : NaN;
  if (!raw || Number.isNaN(t)) return 'undated';
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const tomorrow = new Date(start);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (t < start.getTime()) return 'past';
  if (t < tomorrow.getTime()) return 'today';
  return 'upcoming';
};

const MyFeedSection = () => {
  const { userId, userProfile, showGlobalMessage, setShowProfileModal, feedRefreshTick } = useContext(AppContext);
  const [feedItems, setFeedItems] = useState([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [patienceIdx, setPatienceIdx] = useState(0);
  const [feedTab, setFeedTab] = useState('today'); // today | upcoming
  const [filterMode, setFilterMode] = useState('all'); // all | free | cheap | expensive | ticketed
  const [typeFilter, setTypeFilter] = useState('all'); // all | one of EVENT_TYPES
  const [sponsored, setSponsored] = useState(null); // one active sponsored placement, if any
  const sponsoredSeenRef = useRef(null); // guards one impression count per placement
  const [sortMode, setSortMode] = useState('feed'); // feed | dateAsc | dateDesc | priceAsc | priceDesc
  const [showFilterPanel, setShowFilterPanel] = useState(false);
  const [filterAnchorRect, setFilterAnchorRect] = useState(null);
  const filterBtnRef = useRef(null);
  const filterActive = filterMode !== 'all' || sortMode !== 'feed' || typeFilter !== 'all';

  const openFilterPanel = () => {
    if (filterBtnRef.current) {
      const r = filterBtnRef.current.getBoundingClientRect();
      setFilterAnchorRect({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
    }
    setShowFilterPanel(true);
  };

  // Compute a popover style anchored just below the funnel button, with
  // sensible clamps so it never escapes the viewport. Memoized so we don't
  // re-run the layout math on every parent re-render.
  const filterPanelStyle = useMemo(() => {
    if (typeof window === 'undefined') return null;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(380, vw - 32);
    const estimatedHeight = 540;
    if (!filterAnchorRect) {
      return { top: '16px', right: '50%', width: `${width}px`, transform: 'translateX(50%)' };
    }
    // Default to dropping the panel below the button; flip above if there
    // isn't enough room below.
    let top = filterAnchorRect.bottom + 8;
    if (top + estimatedHeight > vh - 16) {
      top = Math.max(16, filterAnchorRect.top - estimatedHeight - 8);
    }
    // Right-align to the button, clamped so the panel's left edge stays
    // visible on small screens.
    let right = vw - filterAnchorRect.right;
    right = Math.min(right, vw - width - 16);
    right = Math.max(16, right);
    return { top: `${top}px`, right: `${right}px`, width: `${width}px`, maxHeight: `${vh - 32}px` };
  }, [filterAnchorRect]);
  const sentinelRef = useRef(null);
  const generatingRef = useRef(false);
  const scopeRef = useRef(0); // expanding scope tier; reset on refresh
  const scrollCounterRef = useRef(0); // decrements scroll timestamps so later items sink lower

  // How many items fall under each tab (drives the tab labels). Past-dated
  // items are counted in neither — they're hidden from both tabs.
  const tabCounts = useMemo(() => {
    let today = 0;
    let upcoming = 0;
    for (const it of feedItems) {
      const b = eventDateBucket(it);
      if (b === 'today') today += 1;
      else if (b === 'upcoming' || b === 'undated') upcoming += 1;
    }
    return { today, upcoming };
  }, [feedItems]);

  // Compute the filtered/sorted view of feedItems for rendering. Items are
  // first partitioned by the active Today/Upcoming tab, then narrowed by the
  // funnel filter, then sorted.
  const displayItems = useMemo(() => {
    const inTab = (item) => {
      const b = eventDateBucket(item);
      return feedTab === 'today' ? b === 'today' : b === 'upcoming' || b === 'undated';
    };
    const matchesFilter = (item) => {
      const d = item.data || {};
      switch (filterMode) {
        case 'free':
          return d.priceTier === 'Free';
        case 'cheap':
          return d.priceTier === '$' || d.priceTier === '$$';
        case 'expensive':
          return d.priceTier === '$$$' || d.priceTier === '$$$$';
        case 'ticketed':
          return d.isTicketed === true;
        default:
          return true;
      }
    };
    const matchesType = (item) => typeFilter === 'all' || (item.data?.type || 'Other') === typeFilter;
    const arr = feedItems.filter((it) => inTab(it) && matchesFilter(it) && matchesType(it));
    if (sortMode === 'feed') return arr;
    const sorted = [...arr];
    const dateOf = (it) => new Date(it.data?.date || 0).getTime() || 0;
    if (sortMode === 'dateAsc') sorted.sort((a, b) => dateOf(a) - dateOf(b));
    if (sortMode === 'dateDesc') sorted.sort((a, b) => dateOf(b) - dateOf(a));
    if (sortMode === 'priceAsc') sorted.sort((a, b) => priceWeight(a.data?.priceTier) - priceWeight(b.data?.priceTier));
    if (sortMode === 'priceDesc') sorted.sort((a, b) => priceWeight(b.data?.priceTier) - priceWeight(a.data?.priceTier));
    return sorted;
  }, [feedItems, filterMode, sortMode, typeFilter, feedTab]);

  // Distinct event types present in the active tab — drives the type filter
  // chips so we only offer types that actually have results.
  const availableTypes = useMemo(() => {
    const inTab = (item) => {
      const b = eventDateBucket(item);
      return feedTab === 'today' ? b === 'today' : b === 'upcoming' || b === 'undated';
    };
    const set = new Set();
    feedItems.forEach((it) => { if (inTab(it)) set.add(it.data?.type || 'Other'); });
    return EVENT_TYPES.filter((t) => set.has(t));
  }, [feedItems, feedTab]);

  // Onboarding banner appears for users who haven't set an address yet.
  const needsOnboarding =
    !!userProfile && !userProfile.profileCompletedAt && (!userProfile.address || !userProfile.address.trim());

  useEffect(() => {
    if (!userId) return;
    // Desc ordering: newest at top. Infinite-scroll items are written
    // with synthetic old timestamps (see SCROLL_TIMESTAMP_BASE) so they
    // always sit below freshly-refreshed/proposed items.
    const q = query(collection(db, `artifacts/${appId}/users/${userId}/feed`), orderBy('timestamp', 'desc'), limit(200));
    return onSnapshot(q, (snapshot) => setFeedItems(snapshot.docs.map((d) => ({ id: d.id, ...d.data() }))));
  }, [userId]);

  // Auto-clear events that have already happened. Runs whenever the feed
  // changes; self-terminating (once no past items remain, it's a no-op).
  useEffect(() => {
    if (!userId || !feedItems.length) return;
    const stale = feedItems.filter((it) => eventDateBucket(it) === 'past');
    if (!stale.length) return;
    const batch = writeBatch(db);
    stale.slice(0, 400).forEach((it) => batch.delete(doc(db, `artifacts/${appId}/users/${userId}/feed/${it.id}`)));
    batch.commit().catch((e) => console.warn('Past-event prune failed:', e));
  }, [feedItems, userId]);

  // Sponsored placement: pick one active, area/type-matched paid item to show
  // atop the feed. Counts one impression per distinct placement shown.
  useEffect(() => {
    if (!userId) return;
    const borough = nycBorough(userProfile?.address) || '';
    const unsub = onSnapshot(collection(db, `artifacts/${appId}/public/data/sponsored`), (snap) => {
      const now = Date.now();
      const ms = (v) => (v?.toMillis ? v.toMillis() : v ? new Date(v).getTime() : null);
      const active = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((s) => {
          const from = ms(s.activeFrom);
          const to = ms(s.activeTo);
          if (from && now < from) return false;
          if (to && now > to) return false;
          if (s.targetBorough && borough && s.targetBorough !== borough) return false;
          return true;
        });
      const pick = active[0] || null;
      setSponsored(pick);
      if (pick && sponsoredSeenRef.current !== pick.id) {
        sponsoredSeenRef.current = pick.id;
        updateDoc(doc(db, `artifacts/${appId}/public/data/sponsored/${pick.id}`), { impressions: increment(1) }).catch(() => {});
      }
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, userProfile?.address]);

  const sponsoredClick = () => {
    if (!sponsored) return;
    updateDoc(doc(db, `artifacts/${appId}/public/data/sponsored/${sponsored.id}`), { clicks: increment(1) }).catch(() => {});
  };

  // Cycle patience messages while a generation is in-flight so the user
  // sees forward motion instead of a static spinner.
  useEffect(() => {
    if (!isGenerating) {
      setPatienceIdx(0);
      return;
    }
    const interval = setInterval(() => {
      setPatienceIdx((i) => Math.min(i + 1, PATIENCE_MESSAGES.length - 1));
    }, 3500);
    return () => clearInterval(interval);
  }, [isGenerating]);

  // External refresh trigger — fired from ProfileSection on save (and
  // any other entry point we add later). Resets scope and refreshes BOTH
  // tabs so today and upcoming reflect the updated profile.
  useEffect(() => {
    if (feedRefreshTick === 0 || !userId || !userProfile) return;
    scopeRef.current = 0;
    generateForActiveTab();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedRefreshTick]);

  // Infinite scroll: when sentinel becomes visible and we already have content,
  // auto-fetch another batch for the active tab. Guarded by generatingRef so we
  // never fire concurrent fetches.
  useEffect(() => {
    if (!sentinelRef.current || feedItems.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !generatingRef.current) {
          generatingRef.current = true;
          // Generate for whichever tab the user is viewing: Today fetches
          // more events happening today, Upcoming fetches more future days.
          generatePersonalSuggestions(feedTab === 'today', { fromScroll: true }).finally(() => {
            // brief cooldown so a single scroll-to-bottom doesn't spam requests
            setTimeout(() => { generatingRef.current = false; }, 800);
          });
        }
      },
      // Trigger well before the sentinel hits the viewport so the fetch
      // starts while the user is still scrolling through existing cards.
      { rootMargin: '1200px' }
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
    // feedTab is included so the observer re-attaches when the sentinel
    // (re)mounts on switching to the Upcoming tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedItems.length, userProfile, feedTab]);

  const deleteFeedItem = async (itemId) => {
    try {
      await deleteDoc(doc(db, `artifacts/${appId}/users/${userId}/feed/${itemId}`));
      showGlobalMessage('Item dismissed from feed.');
    } catch (e) {
      console.error(e);
      showGlobalMessage('Could not delete item.', 'error');
    }
  };

  // Clear every event currently in the feed (both tabs). Confirmed first since
  // it's destructive; only affects the user's own feed.
  const clearAllFeed = async () => {
    if (!feedItems.length) return;
    if (typeof window !== 'undefined' && !window.confirm('Clear all events from your feed? This removes every card from both Today and Upcoming.')) return;
    try {
      const batch = writeBatch(db);
      feedItems.forEach((it) => batch.delete(doc(db, `artifacts/${appId}/users/${userId}/feed/${it.id}`)));
      await batch.commit();
      setShowFilterPanel(false);
      showGlobalMessage('Cleared all events from your feed.');
    } catch (e) {
      console.error(e);
      showGlobalMessage('Could not clear the feed.', 'error');
    }
  };

  const generatePersonalSuggestions = async (forToday = false, opts = {}) => {
    const { fromScroll = false } = opts;
    const provider = userProfile?.aiProvider || 'gemini';
    if (provider === 'gemini' && !geminiApiKey) {
      showGlobalMessage('Gemini API key missing. Set VITE_GEMINI_API_KEY in your environment.', 'error');
      return;
    }
    // Refresh (button or context tick) resets scope to immediate area.
    // Scroll-triggered generation expands to the next scope tier so we
    // surface fresh content instead of repeating local venues.
    if (!fromScroll) scopeRef.current = 0;
    else scopeRef.current = Math.min(scopeRef.current + 1, SCOPE_TIERS.length - 1);
    const scope = SCOPE_TIERS[scopeRef.current];

    setIsGenerating(forToday ? 'today' : 'upcoming');
    try {
      const home = userProfile?.address || 'New York, NY';
      const current = userProfile?.currentLocation?.label || '';
      const locPref = userProfile?.locationPreference || 'home';
      // Location context — incorporates the current scope tier so the
      // radius expands as the user scrolls for more.
      let locationBlock;
      if (locPref === 'current' && current) {
        locationBlock = `User is currently at: ${current}. Scope tier: ${scope.label}. Suggest events within ~${scope.radius} of this location.`;
      } else if (locPref === 'both' && current) {
        locationBlock = `User has TWO relevant locations: HOME=${home}, CURRENT=${current}. Scope tier: ${scope.label}.
HARD RULE: of 5 returned events, at least 2 MUST be tagged locationSource="home" and at least 2 MUST be tagged locationSource="current". Mix them.`;
      } else {
        locationBlock = `User's home base is ${home}. Scope tier: ${scope.label}. Suggest events within ~${scope.radius} of home. Tag each event's "locationSource" as "home".`;
      }
      const prefs = userProfile?.preferences?.join(', ') || 'general fun';
      const prefDetails = userProfile?.preferenceDetails || {};
      const detailLines = Object.entries(prefDetails)
        .filter(([, arr]) => Array.isArray(arr) && arr.length)
        .map(([k, arr]) => `  • ${k}: ${arr.join(', ')}`)
        .join('\n');
      // Some suggestions should reflect what the user's groups enjoy together.
      // Only computed on a full refresh (not on every scroll fetch) to keep
      // infinite scroll snappy and the Firestore reads bounded.
      const groupInterests = fromScroll ? [] : await gatherGroupInterests(userProfile);
      const kidsText = userProfile?.kids?.length ? `Kids ages: ${userProfile.kids.map((k) => k.age).join(',')}` : 'No kids';
      // Budget preference → a guidance line for the model. priceTier dollar guide:
      // $≈<$20, $$≈$20-50, $$$≈$50-100, $$$$≈$100+ per person.
      const budgetLean = userProfile?.budgetLean || 'any';
      const maxPP = Number(userProfile?.maxPricePerPerson) || 0;
      const budgetParts = [];
      if (budgetLean === 'free') budgetParts.push('strongly prefers FREE or cheap activities (priceTier "Free" or "$")');
      else if (budgetLean === 'paid') budgetParts.push('is happy to pay for premium experiences');
      if (maxPP > 0) budgetParts.push(`will not spend more than about $${maxPP} per person`);
      const budgetLine = budgetParts.length
        ? `${budgetParts.join('; ')} (guide: $≈under $20, $$≈$20-50, $$$≈$50-100, $$$$≈$100+ per person)`
        : '';
      const todsPrefs = userProfile?.timeOfDayPrefs?.length ? userProfile.timeOfDayPrefs.join(', ') : 'any time';
      const dowPrefs = userProfile?.dayOfWeekPrefs?.length ? userProfile.dayOfWeekPrefs.join(', ') : 'any day';
      const weekly = userProfile?.weeklyAvailability || {};
      const weeklyStr = Object.keys(weekly).length
        ? Object.entries(weekly)
            .filter(([, s]) => Array.isArray(s) && s.length)
            .map(([d, s]) => `${d}=${s.join('/')}`)
            .join(', ')
        : '(none specified)';
      const slotsByDate = userProfile?.availabilitySlots || {};
      const datesWithSlots = Object.entries(slotsByDate)
        .filter(([, slots]) => Array.isArray(slots) && slots.length)
        .slice(0, 30)
        .map(([d, slots]) => `${d} (${slots.join('/')})`)
        .join('; ');
      const today = new Date().toDateString();
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toDateString();

      const timeframePrompt = forToday
        ? `happening strictly TODAY (${today}) or tonight.`
        : `happening between tomorrow and ~14 days out. STRICTLY EXCLUDE today (${today}) and the past.`;

      // Unique titles already in the feed (any tab), so we can tell the AI what
      // NOT to repeat. The real guard is the client-side write-time dedupe below.
      const seenTitles = [...new Set(feedItems.map((i) => i.data?.title).filter(Boolean))];
      const seenList = seenTitles.slice(0, 100).join(' | ');

      const prompt = `Today is ${today}. Find 5 hyper-local, PERSONALLY-TAILORED things for ONE person to do, ${timeframePrompt}

WHO THIS IS FOR — tailor every single pick to THIS person:
- Interests: ${prefs}
${detailLines ? `- Specific tastes:\n${detailLines}` : ''}
${groupInterests.length ? `- Their friend groups enjoy together: ${groupInterests.join(', ')} — make 1 pick a great fit for these shared interests.` : ''}
- Family: ${kidsText}
${budgetLine ? `- Budget: ${budgetLine}. Respect this — set each pick's priceTier accordingly and skip options that clearly exceed it.` : ''}

LOCATION — HARD CONSTRAINT:
${locationBlock}
- Suggest ONLY things in this neighborhood and immediately adjacent areas within ~${scope.radius}. NEVER suggest another state, a far-away borough, or a different city. If you can't find enough truly local options, return FEWER — do not reach far.

WHAT TO FIND (specific & niche beats generic):
- For EACH interest above, hunt for a CONCRETE real happening that matches it — INCLUDING small, recurring, niche things: a bar's weekly craft/knit night, a run club, a board-game or trivia night, an open mic, a maker workshop, a neighborhood pop-up. These niche interest-matches are MORE valuable than big generic events.
- FOOD & DRINK rule: do NOT recommend a restaurant just for being good or popular. Only include a food/drink spot if EITHER (a) it newly opened and matches their tastes above, OR (b) it's hosting something special on a specific day (trivia, live music, tasting, themed night) — say what and when. Otherwise skip food.
- Favor things that fit their preferred days/times below.
- SOURCES (a help, NOT a filter): interest-fit ALWAYS comes first. For broader/curated picks, mine editorial "things to do" coverage — Time Out, The New Yorker "Goings On", The Skint, Brooklyn Magazine, Eater, Curbed, local NYT culture, neighborhood blogs. BUT a niche match to one of their interests (a venue's weekly craft night, run club, trivia, open mic) is worth surfacing even if it's only on the venue's own site or social — surface it. Only skip generic listings that don't actually match an interest.

AVAILABILITY:
- Recurring weekly availability (day=times-of-day): ${weeklyStr}
- Preferred times of day: ${todsPrefs}; preferred days: ${dowPrefs}
- Specific free dates (date → times-of-day): ${datesWithSlots || '(none — use the weekly availability)'}
- If specific dates exist, every pick's date+time MUST fall on one of them and match a listed time-of-day (morning<12:00, afternoon 12:00–17:00, evening 17:00+).

DO NOT REPEAT — these were already shown; return NONE of them and no near-duplicates or other nights of the same series:
${seenList || '(none yet)'}
- If something recurs, return it ONCE noting the pattern (e.g. "every Thursday 7pm"), never multiple nights.

ACCURACY:
- Only real, verifiable things (web search). No made-up events. Dates must fall in the timeframe above.
- url: the OFFICIAL event/venue page only if you're confident it's correct; otherwise null (the app will search). Never guess a URL.
- imageUrl: a real reachable public image URL, else null. imageKeywords: 3-6 visual scene words.
- locationSource: "home" or "current" per the LOCATION CONTEXT.
- type: classify each pick as EXACTLY ONE of: ${EVENT_TYPES.join(', ')}.
- priceTier: one of "Free","$","$$","$$$","$$$$" or null. isTicketed: true/false. ticketsUrl: direct ticket URL if ticketed, else null.

Return ONLY a JSON array (no prose, no markdown fences) of objects with keys: title, description, location, date (YYYY-MM-DD HH:MM), url, imageUrl, imageKeywords, locationSource, type, priceTier, isTicketed, ticketsUrl.`;

      // Source A — existing Gemini grounded web search (behavior unchanged).
      let aiError = null;
      const aiSearch = (async () => {
        // Stay within the shared key's free grounding budget; once the daily
        // cap is hit, skip AI search and let the partner APIs carry the feed.
        // BYO providers use the user's own quota, so they aren't metered.
        if (provider === 'gemini' && !(await reserveGroundedSearch())) {
          console.info('Daily free grounding cap reached — using partner events only.');
          return [];
        }
        try {
          const text = await callAI({ prompt, useWebSearch: true, provider });
          return (extractJsonArray(text) || []).map((e) => ({ ...e, source: e.source || 'ai', type: normalizeType(e.type || e.category) }));
        } catch (err) {
          aiError = err;
          console.warn('AI-search source failed:', err);
          return [];
        }
      })();

      // Source B — structured partner-event APIs via the proxy, AI-ranked.
      const partnerSearch = (async () => {
        const { startDate, endDate } = dateWindow(forToday);
        const useCurrent = locPref !== 'home' && userProfile?.currentLocation?.lat != null;
        const raw = await fetchRealEvents({
          lat: useCurrent ? userProfile.currentLocation.lat : undefined,
          lng: useCurrent ? userProfile.currentLocation.lng : undefined,
          location: useCurrent ? undefined : home,
          startDate,
          endDate,
          radius: scope.radiusMiles,
          keywords: (userProfile?.preferences || []).slice(0, 4).join(' '),
          size: 12,
          borough: nycBorough(home) || nycBorough(current),
        });
        if (!raw.length) return [];
        const ctx = `Recommend events for someone interested in: ${prefs}. Home area: ${home}. ${kidsText}.`;
        return rankAndPersonalizeEvents({ events: raw, contextText: ctx, provider, max: 6 });
      })();

      // Run both sources in parallel and merge + de-dupe by normalized title.
      const [aEvents, bEvents] = await Promise.all([aiSearch, partnerSearch]);
      let suggestions = mergeEvents(aEvents, bEvents);
      // Hard de-dupe against what's ALREADY in the feed (both tabs) — never trust
      // the AI to fully obey the "already shown" list. This is what stops the
      // same event reappearing across presses.
      const seenKeys = new Set(feedItems.map((i) => normalizeTitle(i.data?.title)).filter(Boolean));
      suggestions = suggestions.filter((s) => !seenKeys.has(normalizeTitle(s.title)));

      // Verify AI food/drink picks against Google Places (real & within radius):
      // enrich with a Maps link + rating, and DROP any Places can't place
      // locally. Non-food items pass through untouched; fail-open on errors.
      {
        const useCur = locPref !== 'home' && userProfile?.currentLocation?.lat != null;
        const vlat = useCur ? userProfile.currentLocation.lat : undefined;
        const vlng = useCur ? userProfile.currentLocation.lng : undefined;
        const vloc = vlat != null ? undefined : home;
        const isFood = (t) => t === 'Food & Drink' || t === 'Nightlife';
        suggestions = (
          await Promise.all(
            suggestions.map(async (s) => {
              if (!isFood(s.type) || s.source === 'google') return s;
              try {
                const v = await verifyVenue({ name: s.title, lat: vlat, lng: vlng, location: vloc, radius: scope.radiusMiles });
                if (v.found) {
                  return { ...s, url: v.url || s.url, source: v.url ? 'google' : s.source, priceTier: s.priceTier || v.priceTier, location: v.address || s.location };
                }
                if (v.verified) return null; // checked and not local → drop
                return s; // couldn't verify → keep as-is
              } catch {
                return s;
              }
            })
          )
        ).filter(Boolean);
      }

      if (!suggestions.length) {
        throw new Error(
          aiError ? `AI search failed — ${aiError.message}` : 'No new ideas right now — try again later or widen your interests.'
        );
      }
      const batch = writeBatch(db);
      suggestions.forEach((s) => {
        // Refresh writes use serverTimestamp() (real now) so they sort at
        // the top. Scroll writes use a deeply-past timestamp that
        // monotonically decreases per item so each new scroll batch lands
        // below the previous scroll batch (which is below the refreshed
        // items).
        let ts;
        if (fromScroll) {
          scrollCounterRef.current += 1;
          ts = Timestamp.fromMillis(SCROLL_TIMESTAMP_BASE - scrollCounterRef.current);
        } else {
          ts = serverTimestamp();
        }
        batch.set(doc(collection(db, `artifacts/${appId}/users/${userId}/feed`)), {
          type: 'personalSuggestion',
          data: s,
          timestamp: ts,
        });
      });
      await batch.commit();
    } catch (e) {
      console.error(e);
      showGlobalMessage(e?.message || 'Could not fetch real events. Try again.', 'error');
    } finally {
      setIsGenerating(false);
    }
  };

  // Generate for the ACTIVE tab only (Today vs Upcoming) — one timeframe per
  // press, which halves AI calls vs. doing both. Re-entrancy guarded so it
  // can't overlap a scroll-triggered fetch.
  const generateForActiveTab = async () => {
    if (generatingRef.current) return;
    generatingRef.current = true;
    try {
      await generatePersonalSuggestions(feedTab === 'today');
    } finally {
      generatingRef.current = false;
    }
  };

  return (
    <div className="space-y-6">
      {sponsored && <SponsoredCard item={sponsored} onClick={sponsoredClick} />}
      {needsOnboarding && (
        <div className="bg-gradient-to-r from-indigo-500 to-purple-500 text-white rounded-2xl p-5 flex flex-col md:flex-row items-start md:items-center justify-between gap-3 shadow-md">
          <div>
            <h3 className="font-bold text-lg">Welcome to Hangouts 👋</h3>
            <p className="text-sm text-indigo-50 mt-1">
              Set up your profile in 60 seconds — home location, interests, and when you're usually free — so we can find events you'll actually want to go to.
            </p>
          </div>
          <button
            onClick={() => setShowProfileModal(true)}
            className="bg-white text-indigo-700 px-4 py-2.5 rounded-xl font-bold hover:bg-indigo-50 transition whitespace-nowrap shadow-sm"
          >
            Set up profile →
          </button>
        </div>
      )}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h2 className="text-xl font-bold text-gray-800">Your Feed</h2>
          {isGenerating && (
            <p className="text-xs text-indigo-600 mt-1 animate-pulse">{PATIENCE_MESSAGES[patienceIdx]}</p>
          )}
        </div>
        <div className="flex gap-2 w-full md:w-auto">
          <button onClick={generateForActiveTab} disabled={isGenerating !== false} className="flex-1 md:flex-none flex items-center justify-center gap-2 px-5 py-2 bg-gradient-to-r from-indigo-500 to-purple-600 text-white rounded-lg shadow-md hover:shadow-lg transition disabled:opacity-50 font-bold">
            {isGenerating !== false ? <SearchIcon className="w-4 h-4 animate-spin" /> : <SparklesIcon className="w-4 h-4" />}
            {isGenerating !== false ? 'Generating…' : feedTab === 'today' ? "Find today's ideas" : 'Find upcoming ideas'}
          </button>
        </div>
      </div>

      {feedItems.length === 0 ? (
        <div className="text-center py-16 bg-white/50 rounded-2xl border border-dashed border-gray-300">
          <SparklesIcon className="w-12 h-12 mx-auto text-gray-300 mb-3" />
          <h3 className="text-lg font-bold text-gray-600">Your feed is empty</h3>
          <p className="text-sm text-gray-500 max-w-sm mx-auto mt-2">Click <strong>Generate Ideas</strong> above to let AI find real-world events happening around you.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Today / Upcoming tabs — Today shows only events happening today;
              Upcoming shows future days (past-dated items are hidden). */}
          <div className="flex gap-1 border-b border-gray-200">
            {[
              { id: 'today', label: 'Today', count: tabCounts.today },
              { id: 'upcoming', label: 'Upcoming', count: tabCounts.upcoming },
            ].map((t) => {
              const on = feedTab === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setFeedTab(t.id)}
                  className={`relative px-4 py-2.5 text-sm font-bold transition -mb-px border-b-2 ${
                    on ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {t.label}
                  <span className={`ml-1.5 text-xs font-semibold ${on ? 'text-indigo-400' : 'text-gray-400'}`}>{t.count}</span>
                </button>
              );
            })}
          </div>

          {/* Filter & Sort icon (single button, opens modal) */}
          <div className="flex justify-end items-center gap-3 px-1">
            <span className="text-xs text-gray-400">
              {displayItems.length} of {tabCounts[feedTab]} {tabCounts[feedTab] === 1 ? 'event' : 'events'}
            </span>
            <button
              ref={filterBtnRef}
              onClick={openFilterPanel}
              className="relative w-10 h-10 flex items-center justify-center rounded-full bg-white border border-gray-200 hover:border-indigo-400 hover:text-indigo-600 text-gray-600 shadow-sm transition"
              title="Filter & sort"
              aria-label="Filter and sort feed"
            >
              <FunnelIcon className="w-5 h-5" />
              {filterActive && (
                <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-indigo-600 rounded-full ring-2 ring-white" />
              )}
            </button>
          </div>

          {displayItems.length === 0 ? (
            <div className="text-center py-8 text-gray-500 text-sm bg-white/40 rounded-2xl border border-dashed border-gray-200">
              {tabCounts[feedTab] === 0
                ? feedTab === 'today'
                  ? 'Nothing on for today yet. Tap “Generate Ideas” above to find events happening today.'
                  : 'No upcoming events yet. Tap “Generate Ideas” above to find events for the days ahead.'
                : 'No events match this filter. Clear it to see your full feed.'}
            </div>
          ) : (
            displayItems.map((item) => (
              <FeedCard key={item.id} item={item} onDelete={() => deleteFeedItem(item.id)} />
            ))
          )}
          {/* Infinite scroll sentinel (both tabs): when visible, fetch more
              events for the active tab — more of today on Today, more future
              days on Upcoming. Only rendered once the tab already has cards, so
              an empty tab doesn't auto-trigger generation (use the button). */}
          {displayItems.length > 0 && (
            <div ref={sentinelRef} className="h-12 flex items-center justify-center text-sm text-gray-400">
              {isGenerating !== false ? (
                <span className="flex items-center gap-2">
                  <SearchIcon className="w-4 h-4 animate-spin" /> Finding more events…
                </span>
              ) : (
                'Scroll for more'
              )}
            </div>
          )}
        </div>
      )}
      {showFilterPanel && (
        <div className="fixed inset-0 z-50" onClick={() => setShowFilterPanel(false)}>
          <div
            className="absolute bg-white rounded-2xl shadow-2xl border border-gray-200 overflow-y-auto"
            style={filterPanelStyle || { top: '16px', right: '16px', width: '380px' }}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex justify-between items-center p-4 border-b border-gray-100 sticky top-0 bg-white z-10">
              <h3 className="text-base font-bold text-gray-800">Filter & Sort</h3>
              <button onClick={() => setShowFilterPanel(false)} className="text-gray-400 hover:text-gray-700 p-1 rounded-full hover:bg-gray-100 transition">
                <CloseIcon className="w-5 h-5" />
              </button>
            </header>
            <div className="p-4 space-y-6">
              <section>
                <h4 className="text-xs font-bold uppercase text-gray-500 mb-2">Filter by</h4>
                <div className="flex flex-wrap gap-2">
                  {[
                    { id: 'all', label: 'All events' },
                    { id: 'free', label: 'Free' },
                    { id: 'cheap', label: '$ – $$' },
                    { id: 'expensive', label: '$$$ – $$$$' },
                    { id: 'ticketed', label: '🎟️ Ticketed' },
                  ].map((opt) => {
                    const on = filterMode === opt.id;
                    return (
                      <button
                        key={opt.id}
                        onClick={() => setFilterMode(opt.id)}
                        className={`px-3.5 py-1.5 rounded-full text-sm font-semibold border transition ${
                          on ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-700 border-gray-200 hover:border-indigo-300'
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </section>

              {availableTypes.length > 0 && (
                <section>
                  <h4 className="text-xs font-bold uppercase text-gray-500 mb-2">Type of activity</h4>
                  <div className="flex flex-wrap gap-2">
                    {['all', ...availableTypes].map((t) => {
                      const on = typeFilter === t;
                      return (
                        <button
                          key={t}
                          onClick={() => setTypeFilter(t)}
                          className={`px-3.5 py-1.5 rounded-full text-sm font-semibold border transition ${
                            on ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-700 border-gray-200 hover:border-indigo-300'
                          }`}
                        >
                          {t === 'all' ? 'All types' : t}
                        </button>
                      );
                    })}
                  </div>
                </section>
              )}

              <section>
                <h4 className="text-xs font-bold uppercase text-gray-500 mb-2">Sort by</h4>
                <div className="space-y-1.5">
                  {[
                    { id: 'feed', label: 'Newly added (default)' },
                    { id: 'dateAsc', label: 'Event date · earliest first' },
                    { id: 'dateDesc', label: 'Event date · latest first' },
                    { id: 'priceAsc', label: 'Price · low to high' },
                    { id: 'priceDesc', label: 'Price · high to low' },
                  ].map((opt) => {
                    const on = sortMode === opt.id;
                    return (
                      <label
                        key={opt.id}
                        className={`flex items-center gap-3 p-2.5 rounded-xl border cursor-pointer transition ${
                          on ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 bg-white hover:border-indigo-300'
                        }`}
                      >
                        <input
                          type="radio"
                          name="sortMode"
                          checked={on}
                          onChange={() => setSortMode(opt.id)}
                        />
                        <span className="text-sm text-gray-700">{opt.label}</span>
                      </label>
                    );
                  })}
                </div>
              </section>

              <div className="flex gap-2 pt-2 border-t border-gray-100">
                <button
                  onClick={() => { setFilterMode('all'); setSortMode('feed'); setTypeFilter('all'); }}
                  disabled={!filterActive}
                  className="flex-1 py-2.5 rounded-xl text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 disabled:opacity-50 transition"
                >
                  Reset
                </button>
                <button
                  onClick={() => setShowFilterPanel(false)}
                  className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 transition"
                >
                  Done
                </button>
              </div>

              <button
                onClick={clearAllFeed}
                disabled={feedItems.length === 0}
                className="w-full py-2.5 rounded-xl text-sm font-bold text-red-600 bg-red-50 hover:bg-red-100 disabled:opacity-40 transition flex items-center justify-center gap-2"
              >
                <TrashIcon className="w-4 h-4" /> Clear all events
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const FeedCard = ({ item, onDelete }) => {
  const { googleAccessToken, showGlobalMessage, userProfile } = useContext(AppContext);
  const { data, type } = item;
  const isInvite = type === 'groupProposal';
  const bgColor = isInvite ? 'bg-amber-50 border-amber-100' : 'bg-white border-gray-100';
  const imageSrc = useEventImage(data);
  const [showSend, setShowSend] = useState(false);
  const [sendAnchorRect, setSendAnchorRect] = useState(null);
  const sendBtnRef = useRef(null);
  const isEvent = type === 'personalSuggestion' || type === 'groupProposal';
  const hasGroups = (userProfile?.groupIds?.length || 0) > 0;

  const openSendModal = () => {
    if (sendBtnRef.current) {
      const r = sendBtnRef.current.getBoundingClientRect();
      setSendAnchorRect({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
    }
    setShowSend(true);
  };

  if (type === 'groupJoin')
    return (
      <div className="p-4 rounded-xl bg-purple-50 text-purple-900 flex items-center gap-3 border border-purple-100 shadow-sm relative group">
        <UsersIcon className="w-5 h-5" /> You joined <strong>{data.groupName}</strong>
        <button onClick={onDelete} className="absolute right-4 opacity-0 group-hover:opacity-100 text-purple-300 hover:text-purple-600 transition">
          <CloseIcon className="w-4 h-4" />
        </button>
      </div>
    );

  if (type === 'groupSuggestion')
    return (
      <div className="p-4 rounded-xl bg-green-50 text-green-900 flex items-center gap-3 border border-green-100 shadow-sm relative group">
        <LightbulbIcon className="w-5 h-5" /> New ideas available for <strong>{data.groupName}</strong>
        <button onClick={onDelete} className="absolute right-4 opacity-0 group-hover:opacity-100 text-green-300 hover:text-green-600 transition">
          <CloseIcon className="w-4 h-4" />
        </button>
      </div>
    );

  const handleCalendarClick = async () => {
    if (googleAccessToken) {
      await addToGoogleCalendar(data, googleAccessToken, showGlobalMessage);
    } else {
      generateICSFile(data);
    }
  };

  return (
    <div className={`p-5 rounded-xl border ${bgColor} shadow-sm transition hover:shadow-md relative group overflow-hidden`}>
      <button onClick={onDelete} className="absolute top-4 right-4 z-10 opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-500 bg-white/80 p-1 rounded-full transition" title="Dismiss">
        <TrashIcon className="w-5 h-5" />
      </button>

      <div className="w-full h-48 mb-4 rounded-xl overflow-hidden bg-gray-100 -mt-2">
        {imageSrc ? (
          <img
            src={imageSrc}
            alt={data.title}
            className="w-full h-full object-cover"
            onError={(e) => {
              const stage = e.target.dataset.fallbackStage || '0';
              if (stage === '0') {
                e.target.dataset.fallbackStage = '1';
                e.target.src = pollinationsImage(data.imageKeywords || data.title);
              } else if (stage === '1') {
                e.target.dataset.fallbackStage = '2';
                e.target.src = textPlaceholder(data.title);
              }
            }}
          />
        ) : (
          <div className="w-full h-full animate-pulse bg-gradient-to-br from-indigo-100 to-purple-100" />
        )}
      </div>

      <div className="flex justify-between items-start pr-8">
        <div className="w-full">
          {isInvite ? (
            <span className="text-xs font-bold text-amber-600 uppercase tracking-wide mb-1 block">
              Based on friend group{data.groupName ? ` · ${data.groupName}` : ''} · proposed by {data.proposerName}
            </span>
          ) : data.locationSource === 'current' ? (
            <span className="text-xs font-bold text-emerald-600 uppercase tracking-wide mb-1 block">Based on current location</span>
          ) : data.locationSource === 'home' ? (
            <span className="text-xs font-bold text-indigo-600 uppercase tracking-wide mb-1 block">Based on home</span>
          ) : null}
          <h3 className="font-bold text-gray-900 text-xl">{data.title}</h3>
          <p className="text-gray-600 text-sm mt-1 leading-relaxed">{data.description}</p>
          <div className="flex flex-wrap gap-4 mt-3 text-sm text-gray-500 font-medium">
            <span className="flex items-center gap-1">
              <CalendarIcon className="w-4 h-4" /> {new Date(data.date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
            </span>
            <span className="flex items-center gap-1">
              <Icon path="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" className="w-4 h-4" /> {data.location}
            </span>
            {(data.priceTier || data.isTicketed || SOURCE_LABELS[data.source] || (data.type && data.type !== 'Other')) && (
              <span className="flex items-center gap-2 flex-wrap">
                <TypeBadge type={data.type} />
                <PriceTierBadge tier={data.priceTier} />
                <TicketedBadge isTicketed={data.isTicketed} />
                <SourceBadge source={data.source} />
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-2 border-t border-gray-100 pt-4 items-stretch">
        <a
          href={moreInfoUrl(data)}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-1 text-center text-sm font-bold text-blue-600 bg-blue-50 hover:bg-blue-100 py-2.5 rounded-lg transition flex items-center justify-center gap-1"
          title={data.url ? 'Open the event website' : 'Search the web for this event'}
        >
          <Icon path="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" className="w-4 h-4" />
          More Info
        </a>
        {(() => {
          const t = ticketAction(data);
          return t ? (
            <a
              href={t.href}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 text-center text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-700 py-2.5 rounded-lg transition flex items-center justify-center gap-1"
              title={t.label}
            >
              {t.label}
            </a>
          ) : null;
        })()}
        {isEvent && directionsUrl(data) && (
          <a
            href={directionsUrl(data)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 text-center text-sm font-bold text-gray-700 bg-gray-100 hover:bg-gray-200 py-2.5 rounded-lg transition flex items-center justify-center gap-1"
            title="Get directions to the venue"
          >
            <Icon path="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" className="w-4 h-4" />
            Directions
          </a>
        )}
        {isEvent && rideUrl(data) && (
          <a
            href={rideUrl(data)}
            target="_blank"
            rel="noopener noreferrer sponsored"
            className="flex-1 text-center text-sm font-bold text-gray-900 bg-gray-900/5 hover:bg-gray-900/10 py-2.5 rounded-lg transition flex items-center justify-center gap-1"
            title="Get a ride to the venue"
          >
            🚗 Get a ride
          </a>
        )}
        <button onClick={handleCalendarClick} className="flex-1 text-sm font-bold text-indigo-600 bg-indigo-50 hover:bg-indigo-100 py-2.5 rounded-lg transition flex items-center justify-center gap-1">
          <PlusIcon className="w-4 h-4" /> Add to my calendar
        </button>
        {isEvent && hasGroups && (
          <button
            ref={sendBtnRef}
            onClick={openSendModal}
            className="w-11 flex items-center justify-center text-amber-600 bg-amber-50 hover:bg-amber-100 rounded-lg transition"
            title="Send to a group"
            aria-label="Send to a group"
          >
            <SendIcon className="w-5 h-5" />
          </button>
        )}
      </div>
      {showSend && (
        <SendToGroupModal
          event={data}
          anchorRect={sendAnchorRect}
          onClose={() => setShowSend(false)}
        />
      )}
    </div>
  );
};

const GroupSection = () => {
  const { userProfile, userId } = useContext(AppContext);
  const [groups, setGroups] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [viewGroup, setViewGroup] = useState(null);

  const groupIdsKey = userProfile?.groupIds?.join(',') || '';

  useEffect(() => {
    if (!userProfile?.groupIds?.length) {
      setGroups([]);
      return;
    }
    const q = query(collection(db, `artifacts/${appId}/public/data/groups`), where('__name__', 'in', userProfile.groupIds));
    return onSnapshot(q, (snap) => setGroups(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
  }, [groupIdsKey]);

  if (viewGroup) return <GroupDetailView group={viewGroup} onBack={() => setViewGroup(null)} />;

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-xl font-bold text-gray-800">Your Groups</h2>
        <button onClick={() => setShowCreate(true)} className="bg-indigo-600 text-white px-4 py-2 rounded-lg font-medium shadow-sm hover:bg-indigo-700 transition flex items-center gap-2">
          <PlusIcon /> New Group
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {groups.length === 0 ? (
          <p className="text-gray-500">No groups yet.</p>
        ) : (
          groups.map((g) => {
            const lastMsg = g.lastMessageAt?.toMillis?.() || 0;
            const lastRead = g.reads?.[userId]?.toMillis?.() || 0;
            const unread = lastMsg > lastRead;
            return (
            <div key={g.id} onClick={() => setViewGroup(g)} className="bg-white p-5 rounded-2xl border border-gray-100 shadow-sm hover:shadow-md transition cursor-pointer group">
              <div className="flex justify-between items-start">
                <div>
                  <h3 className="font-bold text-lg text-gray-900 group-hover:text-indigo-600 transition-colors flex items-center gap-2">
                    {g.name}
                    {unread && <span className="w-2.5 h-2.5 bg-indigo-500 rounded-full" title="New messages" />}
                  </h3>
                  <p className="text-sm text-gray-500 mt-1">{g.members?.length || 0} members{unread ? ' · new messages' : ''}</p>
                </div>
                <div className="w-10 h-10 bg-gray-50 rounded-full flex items-center justify-center text-gray-400 group-hover:bg-indigo-50 group-hover:text-indigo-500 transition">
                  <Icon path="M9 5l7 7-7 7" className="w-5 h-5" />
                </div>
              </div>
            </div>
            );
          })
        )}
      </div>
      {showCreate && <CreateGroupModal onClose={() => setShowCreate(false)} />}
    </div>
  );
};

const CreateGroupModal = ({ onClose }) => {
  const { userId, showGlobalMessage } = useContext(AppContext);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const refDoc = await addDoc(collection(db, `artifacts/${appId}/public/data/groups`), {
        name,
        members: [userId],
        adminId: userId,
        createdAt: serverTimestamp(),
      });
      await updateDoc(doc(db, `artifacts/${appId}/users/${userId}/profiles`, 'myProfile'), { groupIds: arrayUnion(refDoc.id) });
      showGlobalMessage('Group created!');
      onClose();
    } catch (e) {
      showGlobalMessage('Error creating group', 'error');
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal onClose={onClose} title="New Group">
      <div className="space-y-4">
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Group Name (e.g. Hiking Buddies)" className="w-full p-3 border rounded-xl" />
        <button onClick={handleCreate} disabled={creating || !name.trim()} className="w-full bg-indigo-600 text-white py-3 rounded-xl font-bold disabled:opacity-50">
          {creating ? 'Creating...' : 'Create Group'}
        </button>
      </div>
    </Modal>
  );
};

// "Ideas from this chat": reads the group's recent conversation, derives topics,
// and surfaces hyper-local suggestions matched to them (golf talk → nearby
// courses, etc.) that the user can propose to the group.
const ChatIdeasModal = ({ group, onClose }) => {
  const { userId, userProfile, showGlobalMessage, googleAccessToken } = useContext(AppContext);
  const [loading, setLoading] = useState(true);
  const [topics, setTopics] = useState([]);
  const [ideas, setIdeas] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const provider = userProfile?.aiProvider || 'gemini';
      const anchor = userProfile?.address || 'New York, NY';
      try {
        const t = await extractChatTopics(group.id, provider);
        if (cancelled) return;
        setTopics(t);
        if (!t.length) {
          setError('Not enough in the chat yet to suggest from — keep the conversation going.');
          setLoading(false);
          return;
        }
        const { startDate, endDate } = dateWindow(false);
        const prompt = `Today is ${new Date().toDateString()}. A group of friends has been chatting and is interested in: ${t.join(', ')}. Find 5 specific, real, HYPER-LOCAL things they could do together near ${anchor} between tomorrow and ~14 days out that match those interests (e.g. golf → a nearby course/driving range; sushi → a specific spot doing something special). Only real, verifiable places/events within ~10 miles of ${anchor} — never another city/state. For each: title, description, location, date (YYYY-MM-DD HH:MM), url (official, else null), imageUrl (or null), imageKeywords, type (EXACTLY one of ${EVENT_TYPES.join(', ')}), priceTier ("Free"/"$"/"$$"/"$$$"/"$$$$" or null), isTicketed (bool), ticketsUrl (or null). Return ONLY a JSON array.`;
        const aiList = (async () => {
          try {
            const text = await callAI({ prompt, useWebSearch: true, provider });
            return (extractJsonArray(text) || []).map((e) => ({ ...e, source: e.source || 'ai', type: normalizeType(e.type || e.category) }));
          } catch {
            return [];
          }
        })();
        const partnerList = (async () => {
          const raw = await fetchRealEvents({ location: anchor, startDate, endDate, radius: 10, keywords: t.join(' '), size: 10, borough: nycBorough(anchor) });
          if (!raw.length) return [];
          return rankAndPersonalizeEvents({ events: raw, contextText: `Group interested in: ${t.join(', ')}. Near ${anchor}.`, provider, max: 5 });
        })();
        const [a, b] = await Promise.all([aiList, partnerList]);
        if (cancelled) return;
        const merged = mergeEvents(a, b).slice(0, 6);
        setIdeas(merged);
        if (!merged.length) setError('Couldn\'t find local matches for those topics right now.');
      } catch (e) {
        if (!cancelled) setError(e?.message || 'Could not generate ideas.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group.id]);

  const propose = async (idea) => {
    try {
      const safe = {
        title: idea.title || '', description: idea.description || '', location: idea.location || '',
        date: idea.date || '', url: idea.url || '', imageUrl: idea.imageUrl || null,
        imageKeywords: idea.imageKeywords || '', priceTier: idea.priceTier || null,
        isTicketed: typeof idea.isTicketed === 'boolean' ? idea.isTicketed : false,
        ticketsUrl: idea.ticketsUrl || null, source: idea.source || null, type: idea.type || null,
      };
      const proposerName = userProfile?.name || 'User';
      const ref = await addDoc(collection(db, `artifacts/${appId}/public/data/groups/${group.id}/proposals`), {
        ...safe, proposerId: userId, proposerName, groupId: group.id, groupName: group.name,
        rsvps: { [userId]: 'yes' }, createdAt: serverTimestamp(),
      });
      const batch = writeBatch(db);
      (group.members || []).forEach((mid) => {
        if (mid === userId) return;
        batch.set(doc(collection(db, `artifacts/${appId}/users/${mid}/feed`)), {
          type: 'groupProposal',
          data: { ...safe, proposerName, groupId: group.id, groupName: group.name, proposalId: ref.id },
          timestamp: serverTimestamp(),
        });
      });
      await batch.commit();
      sendProposalEmails(group, safe.title, proposerName, userId);
      showGlobalMessage(`Proposed to ${group.name}!`);
    } catch (e) {
      console.error(e);
      showGlobalMessage('Could not propose.', 'error');
    }
  };

  return createPortal(
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[60] flex justify-center items-start p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl my-8" onClick={(e) => e.stopPropagation()}>
        <header className="flex justify-between items-center p-4 border-b border-gray-100">
          <h2 className="text-base font-bold text-gray-800">💡 Ideas from your chat</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 p-1 rounded-full hover:bg-gray-100"><CloseIcon className="w-5 h-5" /></button>
        </header>
        <div className="p-4">
          {topics.length > 0 && (
            <p className="text-xs text-gray-500 mb-3">Picked up on: {topics.map((t) => <span key={t} className="inline-block bg-indigo-50 text-indigo-700 rounded-full px-2 py-0.5 mr-1 font-medium">{t}</span>)}</p>
          )}
          {loading ? (
            <div className="flex justify-center py-12"><div className="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" /></div>
          ) : error ? (
            <p className="text-sm text-gray-500 py-6 text-center">{error}</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {ideas.map((idea, i) => (
                <SuggestionCard key={i} idea={idea} onPropose={propose} googleAccessToken={googleAccessToken} showGlobalMessage={showGlobalMessage} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};

const GroupDetailView = ({ group, onBack }) => {
  const { userId, showGlobalMessage, getUserNameById } = useContext(AppContext);
  const [members, setMembers] = useState([]);
  const [showInvite, setShowInvite] = useState(false);
  const [showChatIdeas, setShowChatIdeas] = useState(false);
  const [groupTab, setGroupTab] = useState('proposals');

  useEffect(() => {
    Promise.all(group.members.map((id) => getUserNameById(id))).then(setMembers);
  }, [group]);

  const handleLeave = async () => {
    if (!window.confirm('Leave this group?')) return;
    try {
      await updateDoc(doc(db, `artifacts/${appId}/public/data/groups`, group.id), { members: arrayRemove(userId) });
      await updateDoc(doc(db, `artifacts/${appId}/users/${userId}/profiles`, 'myProfile'), { groupIds: arrayRemove(group.id) });
      onBack();
    } catch (e) {
      showGlobalMessage('Failed to leave group', 'error');
    }
  };

  return (
    <div className="flex flex-col h-[70vh]">
      <div className="flex items-center justify-between mb-4 pb-4 border-b">
        <button onClick={onBack} className="text-gray-500 hover:text-indigo-600 font-medium flex items-center gap-1">
          <Icon path="M15 19l-7-7 7-7" /> Back
        </button>
        <h2 className="text-xl font-bold">{group.name}</h2>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowChatIdeas(true)}
            className="text-amber-500 hover:text-amber-700 p-2 rounded-full hover:bg-amber-50 flex items-center gap-1"
            title="Ideas from this chat"
          >
            <LightbulbIcon className="w-5 h-5" />
          </button>
          <button
            onClick={() => setShowInvite(true)}
            className="text-indigo-500 hover:text-indigo-700 p-2 rounded-full hover:bg-indigo-50 flex items-center gap-1"
            title="Invite people"
          >
            <InviteIcon className="w-5 h-5" />
          </button>
          <button onClick={handleLeave} className="text-red-400 hover:text-red-600 p-2 rounded-full hover:bg-red-50" title="Leave group">
            <LeaveIcon />
          </button>
        </div>
      </div>
      {showInvite && <InviteModal group={group} onClose={() => setShowInvite(false)} />}
      {showChatIdeas && <ChatIdeasModal group={group} onClose={() => setShowChatIdeas(false)} />}
      <div className="flex-1 overflow-hidden flex flex-col md:flex-row gap-4">
        <div className="flex-1 flex flex-col min-h-0 bg-white rounded-2xl border shadow-sm overflow-hidden">
          <div className="flex border-b border-gray-100 px-2">
            <button
              onClick={() => setGroupTab('proposals')}
              className={`px-4 py-3 text-sm font-semibold transition border-b-2 ${
                groupTab === 'proposals' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-800'
              }`}
            >
              Proposed Events
            </button>
            <button
              onClick={() => setGroupTab('chat')}
              className={`px-4 py-3 text-sm font-semibold transition border-b-2 ${
                groupTab === 'chat' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-800'
              }`}
            >
              Chat
            </button>
          </div>
          {groupTab === 'proposals' ? (
            <GroupProposals groupId={group.id} />
          ) : (
            <ChatRoom groupId={group.id} />
          )}
        </div>
        <div className="w-full md:w-64 space-y-4 overflow-y-auto">
          <div className="bg-gray-50 p-4 rounded-xl">
            <h4 className="font-bold text-gray-700 mb-2 text-sm uppercase">Members</h4>
            <div className="space-y-2">
              {members.map((m, i) => (
                <div key={i} className="flex items-center gap-2 text-sm text-gray-600">
                  <div className="w-2 h-2 rounded-full bg-green-400"></div>
                  {m}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const GroupProposals = ({ groupId }) => {
  const [proposals, setProposals] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = query(
      collection(db, `artifacts/${appId}/public/data/groups/${groupId}/proposals`),
      orderBy('createdAt', 'desc'),
      limit(50)
    );
    return onSnapshot(q, (snap) => {
      setProposals(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setLoading(false);
    });
  }, [groupId]);

  if (loading) {
    return (
      <div className="flex-1 flex justify-center items-center bg-slate-50">
        <div className="w-8 h-8 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (proposals.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center p-8 bg-slate-50">
        <SparklesIcon className="w-12 h-12 text-gray-300 mb-3" />
        <h3 className="text-lg font-bold text-gray-600">No proposals yet</h3>
        <p className="text-sm text-gray-500 max-w-sm mt-2">
          Head to the <span className="font-semibold">Suggestions</span> tab, pick this group, then "Propose" any event you find.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-50">
      {proposals.map((p) => <ProposalCard key={p.id} proposal={p} groupId={groupId} />)}
    </div>
  );
};

const ProposalCard = ({ proposal, groupId }) => {
  const { userId, showGlobalMessage } = useContext(AppContext);
  const [updating, setUpdating] = useState(false);
  const rsvps = proposal.rsvps || {};
  const myRsvp = rsvps[userId];
  const yes = Object.values(rsvps).filter((v) => v === 'yes');
  const no = Object.values(rsvps).filter((v) => v === 'no');
  const imageSrc = useEventImage(proposal);

  const setRsvp = async (value) => {
    setUpdating(true);
    try {
      await updateDoc(
        doc(db, `artifacts/${appId}/public/data/groups/${groupId}/proposals`, proposal.id),
        { [`rsvps.${userId}`]: value }
      );
    } catch (e) {
      console.error(e);
      showGlobalMessage('Could not save your RSVP.', 'error');
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="w-full h-32 bg-gray-100">
        {imageSrc ? (
          <img src={imageSrc} alt={proposal.title} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full animate-pulse bg-gradient-to-br from-indigo-100 to-purple-100" />
        )}
      </div>
      <div className="p-4">
        <p className="text-xs font-bold text-amber-600 uppercase tracking-wide">Proposed by {proposal.proposerName || 'a member'}</p>
        <h3 className="font-bold text-gray-900 text-lg mt-1">{proposal.title}</h3>
        {proposal.description && (
          <p className="text-gray-600 text-sm mt-1 leading-relaxed line-clamp-3">{proposal.description}</p>
        )}
        <div className="flex flex-wrap gap-3 mt-2 text-xs text-gray-500 font-medium items-center">
          {proposal.date && (
            <span className="flex items-center gap-1">
              <CalendarIcon className="w-3 h-3" /> {new Date(proposal.date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
            </span>
          )}
          {proposal.location && (
            <span className="flex items-center gap-1">
              <Icon path="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" className="w-3 h-3" /> {proposal.location}
            </span>
          )}
          <TypeBadge type={proposal.type} />
          <PriceTierBadge tier={proposal.priceTier} />
          <TicketedBadge isTicketed={proposal.isTicketed} />
          <SourceBadge source={proposal.source} />
        </div>

        <div className="mt-4 flex flex-col gap-2">
          <div className="flex gap-2">
            <button
              onClick={() => setRsvp('yes')}
              disabled={updating}
              className={`flex-1 py-2 rounded-lg text-sm font-bold transition disabled:opacity-50 ${
                myRsvp === 'yes' ? 'bg-emerald-500 text-white shadow' : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
              }`}
            >
              {myRsvp === 'yes' ? '✓ Going' : 'Accept'} ({yes.length})
            </button>
            <button
              onClick={() => setRsvp('no')}
              disabled={updating}
              className={`flex-1 py-2 rounded-lg text-sm font-bold transition disabled:opacity-50 ${
                myRsvp === 'no' ? 'bg-red-400 text-white shadow' : 'bg-red-50 text-red-600 hover:bg-red-100'
              }`}
            >
              {myRsvp === 'no' ? '✗ Declined' : 'Decline'} ({no.length})
            </button>
          </div>
          <a
            href={moreInfoUrl(proposal)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-center text-xs font-bold text-blue-600 bg-blue-50 hover:bg-blue-100 py-2 rounded-lg transition"
          >
            {proposal.url ? 'More Info' : 'Search the web'}
          </a>
          {(() => {
            const t = ticketAction(proposal);
            return t ? (
              <a
                href={t.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-center text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 py-2 rounded-lg transition"
              >
                {t.label}
              </a>
            ) : null;
          })()}
        </div>
      </div>
    </div>
  );
};

const REACTION_EMOJIS = ['👍', '❤️', '😂', '🎉', '🔥'];

const ChatRoom = ({ groupId }) => {
  const { userId, userProfile } = useContext(AppContext);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState('');
  const [typingNames, setTypingNames] = useState([]);
  const [reactingId, setReactingId] = useState(null);
  const [uploading, setUploading] = useState(false);
  const bottomRef = useRef(null);
  const fileRef = useRef(null);
  const lastTypingRef = useRef(0);

  const groupDoc = doc(db, `artifacts/${appId}/public/data/groups`, groupId);
  const markRead = () => updateDoc(groupDoc, { [`reads.${userId}`]: serverTimestamp() }).catch(() => {});

  useEffect(() => {
    const q = query(collection(db, `artifacts/${appId}/public/data/groups/${groupId}/messages`), orderBy('timestamp', 'asc'), limit(100));
    return onSnapshot(q, (snap) => {
      setMessages(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      markRead();
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId]);

  // Live typing indicator from the group doc (entries < 6s old, excluding self).
  useEffect(() => {
    return onSnapshot(groupDoc, (snap) => {
      const t = snap.data()?.typing || {};
      const now = Date.now();
      setTypingNames(
        Object.entries(t)
          .filter(([uid, v]) => uid !== userId && v?.at?.toMillis && now - v.at.toMillis() < 6000)
          .map(([, v]) => v.name)
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId]);

  const onType = (val) => {
    setText(val);
    const now = Date.now();
    if (now - lastTypingRef.current > 3000) {
      lastTypingRef.current = now;
      updateDoc(groupDoc, { [`typing.${userId}`]: { name: userProfile?.name || 'Someone', at: serverTimestamp() } }).catch(() => {});
    }
  };

  const send = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    const body = text;
    setText('');
    await addDoc(collection(db, `artifacts/${appId}/public/data/groups/${groupId}/messages`), {
      text: body, senderId: userId, senderName: userProfile.name, photoURL: userProfile.photoURL || null, timestamp: serverTimestamp(),
    });
    updateDoc(groupDoc, { lastMessageAt: serverTimestamp(), [`typing.${userId}`]: { name: userProfile?.name || '', at: Timestamp.fromMillis(0) } }).catch(() => {});
  };

  const sendImage = async (file) => {
    if (!file) return;
    setUploading(true);
    try {
      const storageRef = ref(storage, `users/${userId}/chat/${groupId}/${Date.now()}_${file.name}`);
      await uploadBytes(storageRef, file);
      const url = await getDownloadURL(storageRef);
      await addDoc(collection(db, `artifacts/${appId}/public/data/groups/${groupId}/messages`), {
        imageUrl: url, senderId: userId, senderName: userProfile.name, photoURL: userProfile.photoURL || null, timestamp: serverTimestamp(),
      });
      updateDoc(groupDoc, { lastMessageAt: serverTimestamp() }).catch(() => {});
    } catch (e) {
      console.error('Chat image upload failed:', e);
    } finally {
      setUploading(false);
    }
  };

  const toggleReaction = async (m, emoji) => {
    const has = (m.reactions?.[emoji] || []).includes(userId);
    await updateDoc(doc(db, `artifacts/${appId}/public/data/groups/${groupId}/messages/${m.id}`), {
      [`reactions.${emoji}`]: has ? arrayRemove(userId) : arrayUnion(userId),
    }).catch(() => {});
    setReactingId(null);
  };

  const saveEdit = async (m) => {
    if (editText.trim() && editText !== m.text) {
      await updateDoc(doc(db, `artifacts/${appId}/public/data/groups/${groupId}/messages/${m.id}`), { text: editText, editedAt: serverTimestamp() }).catch(() => {});
    }
    setEditingId(null);
  };

  return (
    <>
      <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-50">
        {messages.map((m, i) => {
          const isMe = m.senderId === userId;
          const showHeader = i === 0 || messages[i - 1].senderId !== m.senderId;
          const reactions = Object.entries(m.reactions || {}).filter(([, arr]) => (arr || []).length);
          return (
            <div key={m.id} className={`flex ${isMe ? 'justify-end' : 'justify-start'} ${showHeader ? 'mt-4' : 'mt-1'} group/msg`}>
              {!isMe && showHeader && <Avatar src={m.photoURL} alt={m.senderName} size="xs" className="w-8 h-8 mr-2 self-end mb-1" />}
              <div className="max-w-[78%] relative">
                <div className={`px-4 py-2 rounded-2xl text-sm ${isMe ? 'bg-indigo-600 text-white rounded-br-none' : 'bg-white text-gray-800 shadow-sm rounded-bl-none border border-gray-100'}`}>
                  {!isMe && showHeader && <p className="text-xs font-bold text-gray-400 mb-1">{m.senderName}</p>}
                  {m.imageUrl && <img src={m.imageUrl} alt="shared" className="rounded-lg max-h-60 mb-1" />}
                  {editingId === m.id ? (
                    <input
                      autoFocus value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(m); if (e.key === 'Escape') setEditingId(null); }}
                      onBlur={() => saveEdit(m)}
                      className="bg-white/20 rounded px-2 py-0.5 text-sm w-full outline-none"
                    />
                  ) : (
                    m.text && <span>{m.text}</span>
                  )}
                  {m.editedAt && <span className="text-[10px] opacity-60 ml-1">(edited)</span>}
                </div>
                {reactions.length > 0 && (
                  <div className={`flex gap-1 mt-1 flex-wrap ${isMe ? 'justify-end' : ''}`}>
                    {reactions.map(([emoji, arr]) => (
                      <button key={emoji} onClick={() => toggleReaction(m, emoji)} className={`text-xs px-1.5 py-0.5 rounded-full border ${(arr || []).includes(userId) ? 'bg-indigo-50 border-indigo-300' : 'bg-white border-gray-200'}`}>
                        {emoji} {arr.length}
                      </button>
                    ))}
                  </div>
                )}
                {/* hover actions */}
                <div className={`absolute top-0 ${isMe ? 'left-0 -translate-x-full pr-1' : 'right-0 translate-x-full pl-1'} opacity-0 group-hover/msg:opacity-100 transition flex items-center gap-1`}>
                  <button onClick={() => setReactingId(reactingId === m.id ? null : m.id)} className="text-gray-400 hover:text-indigo-600 text-sm" title="React">😊</button>
                  {isMe && !m.imageUrl && (
                    <button onClick={() => { setEditingId(m.id); setEditText(m.text || ''); }} className="text-gray-400 hover:text-indigo-600" title="Edit"><Icon path="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" className="w-4 h-4" /></button>
                  )}
                  {isMe && (
                    <button onClick={() => deleteDoc(doc(db, `artifacts/${appId}/public/data/groups/${groupId}/messages/${m.id}`)).catch(() => {})} className="text-gray-400 hover:text-red-500" title="Delete"><TrashIcon className="w-4 h-4" /></button>
                  )}
                </div>
                {reactingId === m.id && (
                  <div className={`absolute z-10 -top-9 ${isMe ? 'right-0' : 'left-0'} bg-white rounded-full shadow-lg border border-gray-100 flex px-1 py-0.5`}>
                    {REACTION_EMOJIS.map((emoji) => (
                      <button key={emoji} onClick={() => toggleReaction(m, emoji)} className="text-lg px-1 hover:scale-125 transition">{emoji}</button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {typingNames.length > 0 && (
          <p className="text-xs text-gray-400 italic">{typingNames.join(', ')} {typingNames.length === 1 ? 'is' : 'are'} typing…</p>
        )}
        <div ref={bottomRef} />
      </div>
      <form onSubmit={send} className="p-3 bg-white border-t flex gap-2 items-center">
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { sendImage(e.target.files?.[0]); e.target.value = ''; }} />
        <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading} className="p-2 text-gray-400 hover:text-indigo-600 disabled:opacity-50" title="Send a photo">
          {uploading ? <SearchIcon className="w-5 h-5 animate-spin" /> : <CameraIcon className="w-5 h-5" />}
        </button>
        <input className="flex-1 bg-gray-100 border-0 rounded-full px-4 focus:ring-2 focus:ring-indigo-500" value={text} onChange={(e) => onType(e.target.value)} placeholder="Message..." />
        <button type="submit" className="p-2 bg-indigo-600 text-white rounded-full hover:bg-indigo-700 disabled:opacity-50" disabled={!text.trim()}>
          <SendIcon className="w-5 h-5" />
        </button>
      </form>
    </>
  );
};

const SuggestionSection = () => {
  const { userId, userProfile, showGlobalMessage, googleAccessToken } = useContext(AppContext);
  const [groups, setGroups] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [generating, setGenerating] = useState(false);
  const [ideas, setIdeas] = useState([]);
  const [memberSummary, setMemberSummary] = useState(null);
  const [generateError, setGenerateError] = useState('');

  const groupIdsKey = userProfile?.groupIds?.join(',') || '';

  useEffect(() => {
    if (!userProfile?.groupIds?.length) {
      setGroups([]);
      return;
    }
    const q = query(collection(db, `artifacts/${appId}/public/data/groups`), where('__name__', 'in', userProfile.groupIds));
    return onSnapshot(q, (snap) => setGroups(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
  }, [groupIdsKey]);

  // When the user picks a group, pre-load a small summary of members so they
  // can see what data will be mined before clicking "Find Real Events".
  useEffect(() => {
    if (!selectedId) {
      setMemberSummary(null);
      return;
    }
    const group = groups.find((g) => g.id === selectedId);
    if (!group?.members) return;
    let cancelled = false;
    (async () => {
      try {
        const profiles = await Promise.all(
          group.members.map(async (uid) => {
            try {
              const snap = await getDoc(doc(db, `artifacts/${appId}/users/${uid}/profiles`, 'myProfile'));
              return snap.exists() ? { uid, ...snap.data() } : { uid, name: 'User' };
            } catch {
              return { uid, name: 'User' };
            }
          })
        );
        if (cancelled) return;
        setMemberSummary({
          count: profiles.length,
          names: profiles.map((p) => p.name?.split(' ')[0] || 'User'),
          hasAvailability: profiles.some((p) => p.freeSlots?.length),
          prefs: [...new Set(profiles.flatMap((p) => p.preferences || []))].slice(0, 12),
        });
      } catch (e) {
        if (!cancelled) setMemberSummary(null);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedId, groups]);

  const generate = async () => {
    if (!geminiApiKey) {
      showGlobalMessage('Gemini API key missing. Set VITE_GEMINI_API_KEY in your environment.', 'error');
      return;
    }
    setGenerating(true);
    setGenerateError('');
    try {
      const group = groups.find((g) => g.id === selectedId);

      // Fetch every member's profile to aggregate the group's collective
      // interests, availability, and constraints. Suggester's profile acts
      // as the location anchor since we don't yet have a group-level locale.
      const memberProfiles = await Promise.all(
        group.members.map(async (uid) => {
          try {
            const snap = await getDoc(doc(db, `artifacts/${appId}/users/${uid}/profiles`, 'myProfile'));
            return snap.exists() ? { uid, ...snap.data() } : { uid };
          } catch {
            return { uid };
          }
        })
      );

      // Aggregate
      const allPrefs = [...new Set(memberProfiles.flatMap((p) => p.preferences || []))];
      const allTimeOfDay = [...new Set(memberProfiles.flatMap((p) => p.timeOfDayPrefs || []))];
      const allDayOfWeek = [...new Set(memberProfiles.flatMap((p) => p.dayOfWeekPrefs || []))];
      const allKids = memberProfiles.flatMap((p) => p.kids || []);
      // Per-member weekly availability (day -> [slots])
      const memberWeekly = memberProfiles
        .filter((p) => p.weeklyAvailability && Object.keys(p.weeklyAvailability).length)
        .map((p) => ({
          name: p.name?.split(' ')[0] || 'Member',
          entries: Object.entries(p.weeklyAvailability)
            .filter(([, s]) => Array.isArray(s) && s.length)
            .map(([d, s]) => `${d}=${s.join('/')}`),
        }));
      const loc = userProfile?.address || memberProfiles.find((p) => p.address)?.address || 'New York';

      // Each member's free time blocks (from Gemini calendar analysis),
      // capped to 14 entries each so we don't blow the prompt budget.
      const availability = memberProfiles
        .filter((p) => p.freeSlots?.length)
        .map((p) => ({
          name: p.name?.split(' ')[0] || 'Member',
          slots: p.freeSlots.slice(0, 14),
        }));

      // Each member's hand-picked date + slot-of-day availability.
      const pickedAvailability = memberProfiles
        .filter((p) => p.availabilitySlots && Object.keys(p.availabilitySlots).length)
        .map((p) => ({
          name: p.name?.split(' ')[0] || 'Member',
          entries: Object.entries(p.availabilitySlots)
            .filter(([, s]) => Array.isArray(s) && s.length)
            .slice(0, 30)
            .map(([d, s]) => `${d} (${s.join('/')})`),
        }));

      const today = new Date().toDateString();

      const prompt = `Today is ${today}. You're recommending events for a group of ${memberProfiles.length} friends called "${group.name}" who want to hang out together.

GROUP CONTEXT:
- Combined interests across all members: ${allPrefs.length ? allPrefs.join(', ') : 'general fun'}
- Family situation: ${allKids.length ? `Group includes children ages ${allKids.map((k) => k.age).join(', ')} — prefer family-friendly options.` : 'No children — adult-friendly options are fine.'}
- Anchor location: ${loc} (events must be within ~15 miles / 25 km of here)
- Preferred times of day (union across members): ${allTimeOfDay.length ? allTimeOfDay.join(', ') : 'any time'}
- Preferred days of week (union across members): ${allDayOfWeek.length ? allDayOfWeek.join(', ') : 'any day'}

MEMBER RECURRING WEEKLY AVAILABILITY (day=times-of-day each member is usually free):
${
  memberWeekly.length
    ? memberWeekly.map((m) => `- ${m.name}: ${m.entries.join(', ')}`).join('\n')
    : '(No members have set a recurring weekly schedule.)'
}

MEMBER AVAILABILITY (free time blocks from Gemini calendar analysis, next 30 days):
${
  availability.length
    ? availability.map((m) => `- ${m.name}: ${m.slots.map((s) => `${s.date} ${s.start}-${s.end}`).join('; ')}`).join('\n')
    : '(No members have synced calendars.)'
}

MEMBER HAND-PICKED AVAILABILITY (dates members manually marked as free, with which times-of-day):
${
  pickedAvailability.length
    ? pickedAvailability.map((m) => `- ${m.name}: ${m.entries.join('; ')}`).join('\n')
    : '(No members have hand-picked dates.)'
}

If neither source above has data, fall back to Friday/Saturday evenings and weekend afternoons.
When you do have hand-picked availability, weight it MORE than the auto-analyzed blocks — those are the times the user explicitly said they want to socialize. Suggest events that align with the largest overlap of members' hand-picked slots first, then their Gemini-analyzed free blocks.

YOUR TASK:
Search the web for 6 ACTUAL, REAL-WORLD events happening near ${loc} in the next 30 days. PRIORITIZE events whose date/time overlaps with the most members' free blocks above. If no member availability is provided, prioritize Friday/Saturday evenings and weekend afternoons.

IMPORTANT:
- Do NOT make up events. Only suggest real events you can verify via web search.
- Ensure event dates are strictly today or in the future.
- Include the OFFICIAL event/venue URL.
- For imageUrl, find a real public image URL from the event's website, venue, or a major publication. If you can't find one, set imageUrl to null.
- For imageKeywords, provide 3-6 specific visual scene words (e.g. "WNBA basketball arena game"). Not the event name.

PRICING & TICKETS:
- For priceTier, return one of "Free", "$", "$$", "$$$", "$$$$" ($=under $20, $$=$20-$50, $$$=$50-$100, $$$$=$100+). If pricing isn't determinable, return null.
- For isTicketed, return true if attendance requires buying a ticket, false for free/walk-in events.
- For ticketsUrl, if isTicketed=true return the DIRECT ticket purchase URL (Ticketmaster/AXS/SeatGeek/Eventbrite/venue site). Otherwise null.

SOURCES (PREFER quality editorial / curated picks over generic listings):
- Mine event coverage from publications like Time Out (timeout.com), The New Yorker (newyorker.com/goings-on, /culture), Brooklyn Magazine (bkmag.com), The Skint (theskint.com), Eater (eater.com), Brokelyn, Curbed, the local NYT culture section, and similar editorial outlets.
- Avoid generic Eventbrite / Meetup / Facebook listings unless the event is also covered by editorial sources.
- Prefer events with a distinctive angle (rooftop concert, neighborhood-specific pop-up, artist talk) over generic categories.

Also classify each as "type": EXACTLY ONE of ${EVENT_TYPES.join(', ')}.

Return ONLY a JSON array (no prose, no markdown fences) of objects with keys: title, description, location, date (YYYY-MM-DD HH:MM), url, imageUrl, imageKeywords, type, priceTier, isTicketed, ticketsUrl.`;

      const provider = userProfile?.aiProvider || 'gemini';

      // Source A — existing Gemini grounded web search (behavior unchanged).
      let aiError = null;
      const aiSearch = (async () => {
        // Stay within the shared key's free grounding budget; once the daily
        // cap is hit, skip AI search and let the partner APIs carry the feed.
        // BYO providers use the user's own quota, so they aren't metered.
        if (provider === 'gemini' && !(await reserveGroundedSearch())) {
          console.info('Daily free grounding cap reached — using partner events only.');
          return [];
        }
        try {
          const text = await callAI({ prompt, useWebSearch: true, provider });
          return (extractJsonArray(text) || []).map((e) => ({ ...e, source: e.source || 'ai', type: normalizeType(e.type || e.category) }));
        } catch (err) {
          aiError = err;
          console.warn('AI-search source failed:', err);
          return [];
        }
      })();

      // Source B — structured partner-event APIs via the proxy, AI-ranked
      // against the group's combined interests.
      const partnerSearch = (async () => {
        const raw = await fetchRealEvents({
          location: loc,
          startDate: ymdLocal(new Date()),
          endDate: ymdLocal(new Date(Date.now() + 30 * 864e5)),
          radius: 25,
          keywords: allPrefs.slice(0, 4).join(' '),
          size: 12,
        });
        if (!raw.length) return [];
        const ctx = `Recommend events for a group of ${memberProfiles.length} friends ("${group.name}") interested in: ${allPrefs.length ? allPrefs.join(', ') : 'general fun'}. Anchor location: ${loc}.`;
        return rankAndPersonalizeEvents({ events: raw, contextText: ctx, provider, max: 6 });
      })();

      const [aEvents, bEvents] = await Promise.all([aiSearch, partnerSearch]);
      const parsed = mergeEvents(aEvents, bEvents);
      if (!parsed.length) {
        throw new Error(
          aiError ? `AI search failed — ${aiError.message}` : 'No events found. Try again, or add a partner-events key.'
        );
      }
      setIdeas(parsed);
    } catch (e) {
      console.error('Group suggestions failed:', e);
      const detail = e?.message || String(e);
      setGenerateError(detail);
      showGlobalMessage('Could not fetch real events. See details in the panel.', 'error');
    } finally {
      setGenerating(false);
    }
  };

  const handleProposeSuggestion = async (suggestion) => {
    try {
      const group = groups.find((g) => g.id === selectedId);
      const proposalData = {
        ...suggestion,
        proposerId: userId,
        proposerName: userProfile.name,
        groupId: group.id,
        groupName: group.name,
        // Proposer is implicitly attending — they suggested it.
        rsvps: { [userId]: 'yes' },
        createdAt: serverTimestamp(),
      };

      // Canonical proposal lives in the group's subcollection so everyone
      // sees the same record and can RSVP against it.
      const proposalRef = await addDoc(
        collection(db, `artifacts/${appId}/public/data/groups/${group.id}/proposals`),
        proposalData
      );

      // Also drop a lightweight ping into each *other* member's feed so the
      // top-level listener fires a toast notification + bumps the badge.
      const batch = writeBatch(db);
      group.members.forEach((memberId) => {
        if (memberId === userId) return;
        batch.set(doc(collection(db, `artifacts/${appId}/users/${memberId}/feed`)), {
          type: 'groupProposal',
          data: { ...suggestion, proposerName: userProfile.name, groupId: group.id, groupName: group.name, proposalId: proposalRef.id },
          timestamp: serverTimestamp(),
        });
      });
      await batch.commit();
      sendProposalEmails(group, suggestion.title, userProfile.name, userId);
      showGlobalMessage(`Proposed to ${group.name}!`, 'success');
    } catch (error) {
      console.error(error);
      showGlobalMessage('Failed to propose suggestion.', 'error');
    }
  };

  return (
    <div>
      <div className="flex flex-col md:flex-row gap-4 mb-4 bg-indigo-50 p-6 rounded-2xl items-end">
        <div className="flex-1 w-full">
          <label className="block text-sm font-bold text-indigo-900 mb-2">Select a Group</label>
          <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)} className="w-full p-3 rounded-xl border-indigo-200 focus:ring-indigo-500 bg-white">
            <option value="">Choose a group...</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </div>
        <button onClick={generate} disabled={!selectedId || generating} className="w-full md:w-auto bg-indigo-600 text-white px-8 py-3 rounded-xl font-bold shadow-lg hover:shadow-xl transition disabled:opacity-50 flex items-center justify-center gap-2">
          {generating ? <SearchIcon className="w-5 h-5 animate-spin" /> : <SparklesIcon className="w-5 h-5" />}
          {generating ? 'Searching web...' : 'Find Real Events'}
        </button>
      </div>

      {generateError && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-2xl p-4 text-sm text-red-700 break-words">
          <p className="font-bold mb-1">Couldn't get group suggestions</p>
          <p className="text-xs font-mono">{generateError}</p>
        </div>
      )}
      {memberSummary && (
        <div className="mb-8 bg-white border border-indigo-100 rounded-2xl p-4 text-sm text-gray-700">
          <p className="font-semibold text-gray-800 mb-1 flex items-center gap-2">
            <UsersIcon className="w-4 h-4 text-indigo-500" />
            Finding events for {memberSummary.count} member{memberSummary.count === 1 ? '' : 's'}: {memberSummary.names.join(', ')}
          </p>
          {memberSummary.prefs.length > 0 ? (
            <p className="text-xs text-gray-500 mt-1">
              <span className="font-medium">Combined interests:</span> {memberSummary.prefs.join(', ')}
            </p>
          ) : (
            <p className="text-xs text-gray-400 mt-1 italic">No interests captured yet — ideas will be more relevant once members fill in their profiles.</p>
          )}
          <p className="text-xs text-gray-500 mt-0.5">
            <span className="font-medium">Calendar mining:</span>{' '}
            {memberSummary.hasAvailability ? 'At least one member has synced free time — we\'ll prefer slots that overlap.' : 'No members have synced calendars yet.'}
          </p>
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {ideas.map((idea, i) => (
          <SuggestionCard key={i} idea={idea} onPropose={handleProposeSuggestion} googleAccessToken={googleAccessToken} showGlobalMessage={showGlobalMessage} />
        ))}
      </div>
    </div>
  );
};

const SuggestionCard = ({ idea, onPropose, googleAccessToken, showGlobalMessage, proposeLabel = 'Propose' }) => {
  const imageSrc = useEventImage(idea);
  return (
    <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 flex flex-col hover:-translate-y-1 transition duration-300">
      <div className="w-full h-32 mb-4 rounded-xl overflow-hidden bg-gray-100 -mt-2">
        {imageSrc ? (
          <img
            src={imageSrc}
            alt={idea.title}
            className="w-full h-full object-cover"
            onError={(e) => {
              const stage = e.target.dataset.fallbackStage || '0';
              if (stage === '0') {
                e.target.dataset.fallbackStage = '1';
                e.target.src = pollinationsImage(idea.imageKeywords || idea.title);
              } else if (stage === '1') {
                e.target.dataset.fallbackStage = '2';
                e.target.src = textPlaceholder(idea.title);
              }
            }}
          />
        ) : (
          <div className="w-full h-full animate-pulse bg-gradient-to-br from-indigo-100 to-purple-100" />
        )}
      </div>
      <h3 className="font-bold text-lg text-gray-800 mb-2">{idea.title}</h3>
      <p className="text-gray-600 text-sm mb-4 flex-1">{idea.description}</p>
      <div className="text-xs text-gray-500 mb-4 space-y-1">
        <p className="flex items-center gap-1">
          <CalendarIcon className="w-3 h-3" /> {new Date(idea.date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
        </p>
        <p className="flex items-center gap-1">
          <Icon path="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" className="w-3 h-3" /> {idea.location}
        </p>
        {(idea.priceTier || idea.isTicketed || SOURCE_LABELS[idea.source] || (idea.type && idea.type !== 'Other')) && (
          <div className="flex items-center gap-2 pt-1 flex-wrap">
            <TypeBadge type={idea.type} />
            <PriceTierBadge tier={idea.priceTier} />
            <TicketedBadge isTicketed={idea.isTicketed} />
            <SourceBadge source={idea.source} />
          </div>
        )}
      </div>
      <div className="flex flex-col gap-2 border-t pt-4 mt-auto">
        <a
          href={moreInfoUrl(idea)}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center bg-blue-50 text-blue-600 text-sm font-bold p-2.5 rounded-lg hover:bg-blue-100 transition"
          title={idea.url ? 'Open the event website' : 'Search the web for this event'}
        >
          <Icon path="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" className="w-4 h-4 mr-1" /> More Info
        </a>
        {(() => {
          const t = ticketAction(idea);
          return t ? (
            <a
              href={t.href}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold p-2.5 rounded-lg transition"
            >
              {t.label}
            </a>
          ) : null;
        })()}
        {(directionsUrl(idea) || rideUrl(idea)) && (
          <div className="flex gap-2">
            {directionsUrl(idea) && (
              <a
                href={directionsUrl(idea)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 text-center bg-gray-100 text-gray-700 text-sm font-bold py-2.5 rounded-lg hover:bg-gray-200 transition flex items-center justify-center gap-1"
                title="Get directions to the venue"
              >
                <Icon path="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" className="w-4 h-4" />
                Directions
              </a>
            )}
            {rideUrl(idea) && (
              <a
                href={rideUrl(idea)}
                target="_blank"
                rel="noopener noreferrer sponsored"
                className="flex-1 text-center bg-gray-900/5 text-gray-900 text-sm font-bold py-2.5 rounded-lg hover:bg-gray-900/10 transition flex items-center justify-center gap-1"
                title="Get a ride to the venue"
              >
                🚗 Get a ride
              </a>
            )}
          </div>
        )}
        <div className="flex gap-2">
          <button onClick={() => onPropose(idea)} className="flex-1 bg-indigo-50 text-indigo-600 text-sm font-bold py-2.5 rounded-lg hover:bg-indigo-100 transition">
            {proposeLabel}
          </button>
          <button
            onClick={async () => {
              if (googleAccessToken) await addToGoogleCalendar(idea, googleAccessToken, showGlobalMessage);
              else generateICSFile(idea);
            }}
            className="flex-1 bg-gray-50 text-gray-700 text-sm font-bold py-2.5 rounded-lg hover:bg-gray-100 transition"
          >
            Add to my calendar
          </button>
        </div>
      </div>
    </div>
  );
};

// --- Plan tab: conversational outing planner -------------------------------
// A chat surface where the user describes an outing in plain language and the
// AI replies with tailored, real, verifiable suggestions — asking a follow-up
// when the destination/date/companions are unclear. Reuses the AI layer,
// grounding budget, verifyVenue, SuggestionCard, and chat/Firestore patterns.

// Coerce one AI-returned suggestion into the canonical event shape with safe
// fallbacks (Firestore rejects undefined; JSON gives null which is fine).
const sanitizePlanEvent = (s) => ({
  title: s.title || 'Idea',
  description: s.description || '',
  location: s.location || '',
  date: s.date || '',
  url: s.url || null,
  imageUrl: s.imageUrl || null,
  imageKeywords: s.imageKeywords || '',
  type: normalizeType(s.type || s.category),
  priceTier: s.priceTier || null,
  isTicketed: !!s.isTicketed,
  ticketsUrl: s.ticketsUrl || null,
  source: s.source || 'ai',
});

// Build the single planning prompt from the conversation + the user's profile
// (interests, specific tastes, kids, budget) + recent activity + today's date.
const buildPlanningPrompt = ({ history, userProfile, recentTitles }) => {
  const prefs = userProfile?.preferences?.join(', ') || 'general fun';
  const prefDetails = userProfile?.preferenceDetails || {};
  const detailLines = Object.entries(prefDetails)
    .filter(([, a]) => Array.isArray(a) && a.length)
    .map(([k, a]) => `  • ${k}: ${a.join(', ')}`)
    .join('\n');
  const kidsText = userProfile?.kids?.length ? `Kids ages: ${userProfile.kids.map((k) => k.age).join(', ')}` : 'No kids';
  // Budget line — mirrors the Phase-1 feed logic so picks respect the cap.
  const budgetLean = userProfile?.budgetLean || 'any';
  const maxPP = Number(userProfile?.maxPricePerPerson) || 0;
  const bp = [];
  if (budgetLean === 'free') bp.push('strongly prefers FREE or cheap options (priceTier "Free" or "$")');
  else if (budgetLean === 'paid') bp.push('is happy to pay for premium experiences');
  if (maxPP > 0) bp.push(`will not spend more than about $${maxPP} per person`);
  const budgetLine = bp.length
    ? `${bp.join('; ')} (guide: $≈under $20, $$≈$20-50, $$$≈$50-100, $$$$≈$100+ per person)`
    : 'no specific budget';
  const recent = recentTitles?.length ? recentTitles.join(' | ') : '(none yet)';
  const today = new Date().toDateString();
  const convo = history.map((m) => `${m.role === 'user' ? 'USER' : 'PLANNER'}: ${m.text}`).join('\n');

  return `You are a concise local outing planner inside a social-planning app. Today is ${today}. Help the user plan a specific outing through a short back-and-forth.

CONVERSATION SO FAR:
${convo}

WHO THE USER IS (personalize every suggestion):
- Interests: ${prefs}
${detailLines ? `- Specific tastes:\n${detailLines}` : ''}
- Family: ${kidsText}
- Budget: ${budgetLine}
- Recently shown interest in: ${recent}

YOUR JOB:
- If you do NOT yet know the DESTINATION (where), the DATE/timeframe (when), or WHO is going, ask ONE short clarifying question for the single most important missing piece — set "needInfo": true and return an empty "suggestions" array. Ask only one thing at a time, and never re-ask something the user already told you.
- Once you know enough, return 3-5 SPECIFIC, REAL, verifiable suggestions for that destination & date: places to eat, things to do, activities — tailored to the interests, family, and budget above. Use web search; never invent places. Favor concrete named spots/events over generic advice. Resolve relative dates ("today", "tomorrow", "June 24th") against today's date.

For EACH suggestion use these keys: title, description (1-2 sentences saying why it fits THEM), location (specific venue + area), date ("YYYY-MM-DD HH:MM", or the outing date if no set time), url (official page if confident, else null), imageUrl (real public image URL or null), imageKeywords (3-6 visual words), type (EXACTLY one of ${EVENT_TYPES.join(', ')}), priceTier ("Free"/"$"/"$$"/"$$$"/"$$$$" or null), isTicketed (bool), ticketsUrl (direct ticket URL or null).

Return ONLY a JSON object (no prose, no markdown fences) of shape:
{ "reply": string (your short conversational message to the user), "needInfo": boolean, "suggestions": [ ...objects as above ] }`;
};

// Run one planning turn: meter the shared key, call the grounded model, parse
// the object, then verify food/nightlife venues are real & nearby (drop the
// ones Google Places can't place). Returns { reply, needInfo, suggestions }.
const runPlanningTurn = async ({ history, userProfile, recentTitles }) => {
  const provider = userProfile?.aiProvider || 'gemini';
  if (provider === 'gemini') {
    const ok = await reserveGroundedSearch();
    if (!ok) {
      return { reply: "I've hit today's shared AI-search limit. Try again tomorrow, or add your own AI key in Settings to keep going.", needInfo: false, suggestions: [] };
    }
  }
  const prompt = buildPlanningPrompt({ history, userProfile, recentTitles });
  const text = await callAI({ prompt, useWebSearch: true, provider });
  const parsed = extractJsonObject(text) || {};
  let suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions.map(sanitizePlanEvent) : [];
  suggestions = (
    await Promise.all(
      suggestions.map(async (s) => {
        if (s.type !== 'Food & Drink' && s.type !== 'Nightlife') return s;
        if (s.source === 'google') return s;
        try {
          const v = await verifyVenue({ name: s.title, location: s.location, radius: 15 });
          if (v.found) return { ...s, url: v.url || s.url, source: v.url ? 'google' : s.source, priceTier: s.priceTier || v.priceTier, location: v.address || s.location };
          if (v.verified) return null; // checked and not real/local → drop
          return s; // couldn't verify → keep
        } catch {
          return s;
        }
      })
    )
  ).filter(Boolean);
  return { reply: parsed.reply || '', needInfo: !!parsed.needInfo, suggestions };
};

// A single plan's conversation. Real-time message stream + the AI turn loop.
const PlanChat = ({ plan, groupName, onBack }) => {
  const { userId, userProfile, showGlobalMessage, googleAccessToken } = useContext(AppContext);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [thinking, setThinking] = useState(false);
  const [recentTitles, setRecentTitles] = useState([]);
  const [groupData, setGroupData] = useState(null);
  const [sendEvent, setSendEvent] = useState(null);
  const bottomRef = useRef(null);

  const planDocPath = plan.scope === 'group'
    ? `artifacts/${appId}/public/data/groups/${plan.groupId}/plans/${plan.id}`
    : `artifacts/${appId}/users/${userId}/plans/${plan.id}`;

  const scrollSoon = () => setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);

  // Live message stream for this plan.
  useEffect(() => {
    const qy = query(collection(db, `${planDocPath}/messages`), orderBy('timestamp', 'asc'), limit(200));
    return onSnapshot(qy, (snap) => {
      setMessages(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      scrollSoon();
    }, () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planDocPath]);

  // Recent feed titles as a taste signal (fetched once).
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDocs(query(collection(db, `artifacts/${appId}/users/${userId}/feed`), orderBy('timestamp', 'desc'), limit(20)));
        const titles = [...new Set(snap.docs.map((d) => d.data()?.data?.title).filter(Boolean))].slice(0, 15);
        if (!cancelled) setRecentTitles(titles);
      } catch {
        /* taste signal is optional */
      }
    })();
    return () => { cancelled = true; };
  }, [userId]);

  // Group members/name for the Propose action (group plans only).
  useEffect(() => {
    if (plan.scope !== 'group') return;
    getDoc(doc(db, `artifacts/${appId}/public/data/groups`, plan.groupId))
      .then((s) => { if (s.exists()) setGroupData({ id: s.id, ...s.data() }); })
      .catch(() => {});
  }, [plan.scope, plan.groupId]);

  const send = async (e) => {
    e.preventDefault();
    const body = text.trim();
    if (!body || thinking) return;
    setText('');
    const isFirst = messages.length === 0;
    const planRef = doc(db, planDocPath);
    const msgsCol = collection(db, `${planDocPath}/messages`);
    try {
      await addDoc(msgsCol, { role: 'user', text: body, senderId: userId, senderName: userProfile?.name || 'You', suggestions: null, timestamp: serverTimestamp() });
      const planUpdate = { lastMessageAt: serverTimestamp(), updatedAt: serverTimestamp() };
      if (isFirst) planUpdate.title = body.slice(0, 60);
      await updateDoc(planRef, planUpdate).catch(() => {});
    } catch (err) {
      console.error('Failed to send plan message:', err);
      showGlobalMessage('Could not send. Check your connection.', 'error');
      return;
    }
    setThinking(true);
    scrollSoon();
    try {
      const history = [...messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', text: m.text })), { role: 'user', text: body }];
      const { reply, suggestions } = await runPlanningTurn({ history, userProfile, recentTitles });
      const fallback = suggestions.length ? 'Here are a few ideas:' : "Tell me a bit more and I'll find some options.";
      await addDoc(msgsCol, {
        role: 'assistant',
        text: reply || fallback,
        senderId: 'assistant',
        senderName: 'Planner',
        suggestions: suggestions.length ? suggestions : null,
        timestamp: serverTimestamp(),
      });
      await updateDoc(planRef, { lastMessageAt: serverTimestamp(), updatedAt: serverTimestamp() }).catch(() => {});
    } catch (err) {
      console.error('Planning turn failed:', err);
      await addDoc(msgsCol, { role: 'assistant', text: 'Something went wrong reaching the planner — try again in a moment.', senderId: 'assistant', senderName: 'Planner', suggestions: null, timestamp: serverTimestamp() }).catch(() => {});
    } finally {
      setThinking(false);
      scrollSoon();
    }
  };

  const proposeToGroup = async (idea) => {
    if (!groupData) { showGlobalMessage('Group still loading — try again.', 'error'); return; }
    try {
      const ref = await addDoc(collection(db, `artifacts/${appId}/public/data/groups/${plan.groupId}/proposals`), {
        ...idea, proposerId: userId, proposerName: userProfile.name, groupId: plan.groupId, groupName: groupData.name, rsvps: { [userId]: 'yes' }, createdAt: serverTimestamp(),
      });
      const batch = writeBatch(db);
      (groupData.members || []).forEach((mid) => {
        if (mid === userId) return;
        batch.set(doc(collection(db, `artifacts/${appId}/users/${mid}/feed`)), { type: 'groupProposal', data: { ...idea, proposerName: userProfile.name, groupId: plan.groupId, groupName: groupData.name, proposalId: ref.id }, timestamp: serverTimestamp() });
      });
      await batch.commit();
      showGlobalMessage(`Proposed to ${groupData.name}!`);
    } catch (err) {
      console.error(err);
      showGlobalMessage('Failed to propose.', 'error');
    }
  };

  const onPropose = (idea) => { if (plan.scope === 'group') proposeToGroup(idea); else setSendEvent(idea); };

  return (
    <div className="flex flex-col h-[70vh] -m-4 md:-m-6">
      <header className="flex items-center gap-3 p-4 border-b border-gray-100 bg-white/70">
        <button onClick={onBack} className="p-2 rounded-full hover:bg-gray-100 text-gray-500" title="Back to plans" aria-label="Back to plans">
          <Icon path="M15 19l-7-7 7-7" className="w-5 h-5" />
        </button>
        <div className="min-w-0">
          <p className="font-bold text-gray-900 truncate">{plan.title || 'New plan'}</p>
          <p className="text-xs text-gray-400">{plan.scope === 'group' ? `👥 ${groupName || 'Group'}` : '🧍 Just you'}</p>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-50">
        {messages.length === 0 && !thinking && (
          <div className="text-center text-gray-400 py-10">
            <p className="font-medium">Where are you headed?</p>
            <p className="text-sm">Try “I'm going to Soho with my two kids tomorrow” or “Bear Mountain on June 24th.”</p>
          </div>
        )}
        {messages.map((m) => {
          const isAssistant = m.role === 'assistant';
          const isMine = !isAssistant && m.senderId === userId;
          const sugg = Array.isArray(m.suggestions) ? m.suggestions : [];
          return (
            <div key={m.id} className={`flex ${isMine ? 'justify-end' : 'justify-start'}`}>
              <div className={sugg.length ? 'max-w-[92%] w-full' : 'max-w-[85%]'}>
                <div className={`px-4 py-2 rounded-2xl text-sm ${isMine ? 'bg-indigo-600 text-white rounded-br-none' : 'bg-white text-gray-800 shadow-sm border border-gray-100 rounded-bl-none'}`}>
                  {!isMine && <p className="text-xs font-bold text-gray-400 mb-1">{isAssistant ? '✨ Planner' : m.senderName || 'Member'}</p>}
                  {m.text && <span className="whitespace-pre-wrap">{m.text}</span>}
                </div>
                {sugg.length > 0 && (
                  <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {sugg.map((idea, i) => (
                      <SuggestionCard
                        key={i}
                        idea={idea}
                        onPropose={onPropose}
                        googleAccessToken={googleAccessToken}
                        showGlobalMessage={showGlobalMessage}
                        proposeLabel={plan.scope === 'group' ? 'Propose' : 'Send to group'}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {thinking && (
          <div className="flex justify-start">
            <div className="px-4 py-2 rounded-2xl bg-white border border-gray-100 shadow-sm rounded-bl-none flex items-center gap-2 text-sm text-gray-500">
              <div className="w-4 h-4 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" /> Planner is thinking…
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={send} className="p-3 bg-white border-t flex gap-2 items-center">
        <input className="flex-1 bg-gray-100 border-0 rounded-full px-4 py-2.5 focus:ring-2 focus:ring-indigo-500" value={text} onChange={(e) => setText(e.target.value)} placeholder="Describe your outing…" disabled={thinking} />
        <button type="submit" className="p-2.5 bg-indigo-600 text-white rounded-full hover:bg-indigo-700 disabled:opacity-50" disabled={!text.trim() || thinking}>
          <SendIcon className="w-5 h-5" />
        </button>
      </form>

      {sendEvent && <SendToGroupModal event={sendEvent} onClose={() => setSendEvent(null)} />}
    </div>
  );
};

// The Plan tab body: a history list of saved plans (personal + group) plus the
// New-plan flow; selecting a plan opens its PlanChat conversation.
const PlanSection = () => {
  const { userId, userProfile, showGlobalMessage } = useContext(AppContext);
  const [personalPlans, setPersonalPlans] = useState([]);
  const [groupPlansMap, setGroupPlansMap] = useState({});
  const [myGroups, setMyGroups] = useState([]);
  const [selectedPlan, setSelectedPlan] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [newScope, setNewScope] = useState('personal');
  const [newGroupId, setNewGroupId] = useState('');
  const groupIdsKey = userProfile?.groupIds?.join(',') || '';

  // Personal plans (live).
  useEffect(() => {
    if (!userId) return;
    const qy = query(collection(db, `artifacts/${appId}/users/${userId}/plans`), orderBy('lastMessageAt', 'desc'));
    return onSnapshot(qy, (snap) => setPersonalPlans(snap.docs.map((d) => ({ id: d.id, scope: 'personal', ...d.data() }))), () => {});
  }, [userId]);

  // Group plans (one live listener per group; errors ignored so an
  // unpublished rule doesn't spam the console).
  useEffect(() => {
    const gids = userProfile?.groupIds || [];
    if (!gids.length) { setGroupPlansMap({}); return; }
    const unsubs = gids.map((gid) =>
      onSnapshot(
        query(collection(db, `artifacts/${appId}/public/data/groups/${gid}/plans`), orderBy('lastMessageAt', 'desc')),
        (snap) => setGroupPlansMap((prev) => ({ ...prev, [gid]: snap.docs.map((d) => ({ id: d.id, scope: 'group', groupId: gid, ...d.data() })) })),
        () => {}
      )
    );
    return () => unsubs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupIdsKey]);

  // Group names for the picker + list labels.
  useEffect(() => {
    const gids = userProfile?.groupIds || [];
    if (!gids.length) { setMyGroups([]); return; }
    let cancelled = false;
    Promise.all(
      gids.map(async (gid) => {
        try { const s = await getDoc(doc(db, `artifacts/${appId}/public/data/groups`, gid)); return s.exists() ? { id: s.id, name: s.data().name } : null; } catch { return null; }
      })
    ).then((arr) => { if (!cancelled) setMyGroups(arr.filter(Boolean)); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupIdsKey]);

  const groupNameById = (gid) => myGroups.find((g) => g.id === gid)?.name || 'Group';

  const allPlans = useMemo(() => {
    const merged = [...personalPlans, ...Object.values(groupPlansMap).flat()];
    return merged.sort((a, b) => (b.lastMessageAt?.toMillis?.() || 0) - (a.lastMessageAt?.toMillis?.() || 0));
  }, [personalPlans, groupPlansMap]);

  const createPlan = async () => {
    if (newScope === 'group' && !newGroupId) { showGlobalMessage('Pick a group first.', 'error'); return; }
    const base = {
      title: 'New plan', destination: '', dateText: '', companions: '',
      scope: newScope, createdBy: userId, createdByName: userProfile?.name || 'Someone',
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(), lastMessageAt: serverTimestamp(),
    };
    try {
      let ref;
      if (newScope === 'group') {
        base.groupId = newGroupId;
        ref = await addDoc(collection(db, `artifacts/${appId}/public/data/groups/${newGroupId}/plans`), base);
      } else {
        ref = await addDoc(collection(db, `artifacts/${appId}/users/${userId}/plans`), base);
      }
      setShowNew(false); setNewScope('personal'); setNewGroupId('');
      setSelectedPlan({ id: ref.id, ...base });
    } catch (err) {
      console.error(err);
      showGlobalMessage('Could not start a plan.', 'error');
    }
  };

  if (selectedPlan) {
    return (
      <PlanChat
        plan={selectedPlan}
        groupName={selectedPlan.scope === 'group' ? groupNameById(selectedPlan.groupId) : ''}
        onBack={() => setSelectedPlan(null)}
      />
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-5 gap-3">
        <div className="min-w-0">
          <h2 className="text-2xl font-bold text-gray-900">Plan an outing</h2>
          <p className="text-sm text-gray-500">Tell me where you're headed and I'll suggest places to eat &amp; things to do.</p>
        </div>
        <button onClick={() => setShowNew((v) => !v)} className="bg-indigo-600 text-white px-4 py-2.5 rounded-xl font-bold shadow hover:bg-indigo-700 transition flex items-center gap-1 flex-shrink-0">
          <PlusIcon className="w-5 h-5" /> New plan
        </button>
      </div>

      {showNew && (
        <div className="mb-6 bg-indigo-50 border border-indigo-100 rounded-2xl p-4">
          <p className="text-sm font-bold text-indigo-900 mb-3">Who's this plan for?</p>
          <div className="flex flex-wrap gap-2 mb-3">
            <button onClick={() => setNewScope('personal')} className={`px-4 py-2 rounded-full text-sm font-semibold border transition ${newScope === 'personal' ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-700 border-gray-200'}`}>Just me</button>
            <button onClick={() => setNewScope('group')} disabled={!myGroups.length} className={`px-4 py-2 rounded-full text-sm font-semibold border transition disabled:opacity-40 ${newScope === 'group' ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-700 border-gray-200'}`}>A group</button>
          </div>
          {newScope === 'group' && (
            <select value={newGroupId} onChange={(e) => setNewGroupId(e.target.value)} className="w-full p-2.5 rounded-xl border border-indigo-200 bg-white text-sm mb-3">
              <option value="">Choose a group…</option>
              {myGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          )}
          <div className="flex gap-2">
            <button onClick={createPlan} className="bg-indigo-600 text-white px-5 py-2 rounded-xl font-bold hover:bg-indigo-700 transition">Start planning</button>
            <button onClick={() => setShowNew(false)} className="px-4 py-2 rounded-xl font-medium text-gray-500 hover:bg-gray-100 transition">Cancel</button>
          </div>
        </div>
      )}

      {allPlans.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <SparklesIcon className="w-10 h-10 mx-auto mb-3 text-indigo-200" />
          <p className="font-medium">No plans yet.</p>
          <p className="text-sm">Tap “New plan” and describe an outing — like “I'm going to Soho with my two kids.”</p>
        </div>
      ) : (
        <div className="space-y-2">
          {allPlans.map((p) => (
            <button key={`${p.scope}-${p.id}`} onClick={() => setSelectedPlan(p)} className="w-full text-left bg-white border border-gray-100 rounded-2xl p-4 shadow-sm hover:shadow-md transition flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-bold text-gray-900 truncate">{p.title || 'New plan'}</p>
                <p className="text-xs text-gray-400 truncate">
                  {p.scope === 'group' ? `👥 ${groupNameById(p.groupId)}` : '🧍 Just you'}
                  {p.destination ? ` · ${p.destination}` : ''}
                  {p.dateText ? ` · ${p.dateText}` : ''}
                </p>
              </div>
              <Icon path="M9 5l7 7-7 7" className="w-5 h-5 text-gray-300 flex-shrink-0" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// --- Auth Screen ---
const AuthScreen = () => {
  const { setGoogleAccessToken } = useContext(AppContext);

  const handleGoogleSignIn = async () => {
    try {
      const provider = new GoogleAuthProvider();
      provider.addScope('https://www.googleapis.com/auth/calendar.events');
      const result = await signInWithPopup(auth, provider);
      const credential = GoogleAuthProvider.credentialFromResult(result);
      if (credential?.accessToken) setGoogleAccessToken(credential.accessToken);
    } catch (error) {
      console.error('Google sign-in failed:', error);
    }
  };

  // Apple sign-in is disabled until we complete Apple Developer setup
  // (Services ID, signing key, domain verification). The button remains
  // visible but disabled so the UI shows the future option without
  // surprising users with an error when they click.
  const handleAppleSignIn = () => {};

  const handleAnonSignIn = async () => {
    try {
      await signInAnonymously(auth);
    } catch (error) {
      console.error('Anonymous sign-in failed:', error);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 p-4">
      <div className="bg-white/90 backdrop-blur-xl p-8 rounded-3xl shadow-2xl w-full max-w-md text-center">
        <div className="w-20 h-20 bg-indigo-100 rounded-full flex items-center justify-center mx-auto mb-6 text-indigo-600">
          <UsersIcon className="w-10 h-10" />
        </div>
        <h1 className="text-4xl font-black text-gray-900 mb-2">Hangouts</h1>
        <p className="text-gray-500 mb-4">Effortless social planning powered by AI &amp; Live Search.</p>
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-6 text-left">
          <p className="text-xs font-bold text-amber-800 mb-1">⚠️ A note on Google sign-in</p>
          <p className="text-xs text-amber-700 leading-relaxed">
            Because this is a private beta, Google will show a "Google hasn't verified this app" warning. That's expected.
            Click <span className="font-semibold">Advanced</span> → <span className="font-semibold">Go to Hangouts Planner (unsafe)</span> to continue.
            It's safe — the app is the one you got the passcode for.
          </p>
        </div>
        <div className="space-y-3">
          <button onClick={handleGoogleSignIn} className="w-full py-3 px-4 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 font-bold text-gray-700 flex items-center justify-center gap-3 transition">
            <GoogleIcon /> Continue with Google
          </button>
          <button
            onClick={handleAppleSignIn}
            disabled
            title="Apple sign-in coming soon"
            className="w-full py-3 px-4 bg-gray-100 text-gray-400 rounded-xl font-bold flex items-center justify-center gap-3 cursor-not-allowed border border-gray-200"
          >
            <AppleIcon /> Continue with Apple
            <span className="text-xs font-medium ml-1 px-2 py-0.5 bg-gray-200 text-gray-500 rounded-full">Soon</span>
          </button>
          <button onClick={handleAnonSignIn} className="text-sm text-gray-400 hover:text-indigo-600 font-medium mt-4">
            Skip for now (Anonymous)
          </button>
        </div>
      </div>
    </div>
  );
};

// --- Group Invites ---
const buildInviteUrl = (groupId) => {
  if (typeof window === 'undefined') return '';
  return `${window.location.origin}/?join=${encodeURIComponent(groupId)}`;
};

const InviteModal = ({ group, onClose }) => {
  const { showGlobalMessage } = useContext(AppContext);
  const inviteUrl = buildInviteUrl(group.id);
  const [emails, setEmails] = useState('');
  const [sending, setSending] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      showGlobalMessage('Link copied to clipboard!');
    } catch {
      showGlobalMessage('Copy failed — select the link and copy manually.', 'error');
    }
  };

  const share = async () => {
    if (!navigator.share) return copy();
    try {
      await navigator.share({
        title: `Join "${group.name}" on Hangouts`,
        text: `Join "${group.name}" on Hangouts — passcode is hangouts2026`,
        url: inviteUrl,
      });
    } catch {
      // user cancelled — no-op
    }
  };

  const sendEmails = async () => {
    const list = emails
      .split(/[,\s\n]+/)
      .map((s) => s.trim())
      .filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
    if (list.length === 0) {
      showGlobalMessage('No valid email addresses to send.', 'error');
      return;
    }
    if (!FEEDBACK_KEY) {
      showGlobalMessage('Email sending not configured (missing VITE_FEEDBACK_KEY).', 'error');
      return;
    }
    setSending(true);
    let ok = 0;
    for (const addr of list) {
      try {
        await fetch('https://api.web3forms.com/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            access_key: FEEDBACK_KEY,
            subject: `You're invited to join "${group.name}" on Hangouts`,
            from_name: 'Hangouts',
            email: addr,
            message: `You've been invited to join the group "${group.name}" on Hangouts.\n\nClick to join: ${inviteUrl}\n\nFirst time? You'll be asked for a passcode — it's: hangouts2026`,
          }),
        });
        ok += 1;
      } catch (e) {
        console.warn('Invite email failed for', addr, e);
      }
    }
    setSending(false);
    setEmails('');
    showGlobalMessage(`Sent ${ok} of ${list.length} invites.`, ok === list.length ? 'success' : 'error');
  };

  return (
    <Modal onClose={onClose} title={`Invite to "${group.name}"`}>
      <div className="space-y-6">
        <div>
          <label className="block text-xs font-semibold uppercase text-gray-500 mb-2">Shareable link</label>
          <div className="flex gap-2">
            <input
              type="text"
              readOnly
              value={inviteUrl}
              onFocus={(e) => e.target.select()}
              className="flex-1 p-3 bg-gray-50 border border-gray-200 rounded-xl text-sm font-mono"
            />
            <button
              onClick={copy}
              className="px-4 py-3 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 font-medium text-sm flex items-center gap-2 transition"
            >
              <CopyIcon className="w-4 h-4" /> Copy
            </button>
          </div>
          {typeof navigator !== 'undefined' && navigator.share && (
            <button
              onClick={share}
              className="mt-3 w-full bg-gray-100 hover:bg-gray-200 text-gray-700 py-2.5 rounded-xl font-medium text-sm flex items-center justify-center gap-2 transition"
            >
              <ShareIcon className="w-4 h-4" /> Share via…
            </button>
          )}
          <p className="text-xs text-gray-400 mt-2">Anyone with this link who can get past the passcode can join.</p>
        </div>

        <div>
          <label className="block text-xs font-semibold uppercase text-gray-500 mb-2 flex items-center gap-2">
            <MailIcon className="w-4 h-4" /> Or email it directly
          </label>
          <textarea
            value={emails}
            onChange={(e) => setEmails(e.target.value)}
            placeholder="alice@example.com, bob@example.com"
            className="w-full p-3 bg-gray-50 border border-gray-200 rounded-xl text-sm min-h-20 focus:ring-2 focus:ring-indigo-500"
          />
          <button
            onClick={sendEmails}
            disabled={sending || !emails.trim()}
            className="mt-3 w-full bg-indigo-600 text-white py-2.5 rounded-xl font-bold disabled:opacity-50 hover:bg-indigo-700 transition"
          >
            {sending ? 'Sending…' : 'Send invites'}
          </button>
        </div>
      </div>
    </Modal>
  );
};

const JoinGroupModal = ({ groupId, onClose }) => {
  const { userId, userProfile, setUserProfile, showGlobalMessage } = useContext(AppContext);
  const [group, setGroup] = useState(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDoc(doc(db, `artifacts/${appId}/public/data/groups`, groupId));
        if (cancelled) return;
        if (!snap.exists()) {
          showGlobalMessage("That group doesn't exist.", 'error');
          onClose();
          return;
        }
        setGroup({ id: snap.id, ...snap.data() });
      } catch (e) {
        showGlobalMessage('Could not load group.', 'error');
        onClose();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [groupId]);

  const join = async () => {
    setJoining(true);
    try {
      await updateDoc(doc(db, `artifacts/${appId}/public/data/groups`, groupId), { members: arrayUnion(userId) });
      await updateDoc(doc(db, `artifacts/${appId}/users/${userId}/profiles`, 'myProfile'), { groupIds: arrayUnion(groupId) });
      // Log it in the user's feed so they see it next time they open the app
      await addDoc(collection(db, `artifacts/${appId}/users/${userId}/feed`), {
        type: 'groupJoin',
        data: { groupName: group.name, groupId },
        timestamp: serverTimestamp(),
      });
      setUserProfile((prev) => ({ ...prev, groupIds: [...(prev?.groupIds || []), groupId] }));
      showGlobalMessage(`Joined "${group.name}"!`);
      onClose();
    } catch (e) {
      console.error(e);
      showGlobalMessage('Could not join group. The invite may be invalid.', 'error');
    } finally {
      setJoining(false);
    }
  };

  const alreadyMember = group?.members?.includes(userId);

  return (
    <Modal onClose={onClose} title="Group invitation">
      {loading ? (
        <div className="flex justify-center py-10">
          <div className="w-8 h-8 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : !group ? null : (
        <div className="space-y-5">
          <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-5 text-center">
            <UsersIcon className="w-10 h-10 mx-auto text-indigo-500 mb-2" />
            <h3 className="text-xl font-bold text-gray-900">{group.name}</h3>
            <p className="text-sm text-gray-500 mt-1">{group.members?.length || 0} member{group.members?.length === 1 ? '' : 's'}</p>
          </div>
          {alreadyMember ? (
            <>
              <p className="text-sm text-gray-600 text-center">You're already a member of this group.</p>
              <button onClick={onClose} className="w-full bg-gray-100 hover:bg-gray-200 text-gray-700 py-3 rounded-xl font-bold transition">
                Close
              </button>
            </>
          ) : (
            <>
              <p className="text-sm text-gray-600 text-center">
                You've been invited to join <strong>{group.name}</strong> on Hangouts.
              </p>
              <div className="flex gap-3">
                <button onClick={onClose} className="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 py-3 rounded-xl font-bold transition">
                  Not now
                </button>
                <button onClick={join} disabled={joining} className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white py-3 rounded-xl font-bold disabled:opacity-50 transition">
                  {joining ? 'Joining…' : 'Join group'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
};

// --- Interest Survey (AI-tailored follow-ups) ---
// Three broad starter questions, then Gemini generates 3 follow-ups
// based on the user's answers. Selected options get unioned into the
// user's profile.preferences so they flow into all the event prompts.
const INITIAL_SURVEY_QUESTIONS = [
  {
    question: 'What kind of activities energize you?',
    type: 'multi',
    options: ['Outdoor', 'Indoor', 'Active', 'Chill', 'Social', 'Solo time', 'Spontaneous', 'Planned ahead'],
  },
  {
    question: 'Pick your favorite categories',
    type: 'multi',
    options: ['Live Music', 'Sports', 'Food & Drink', 'Drinks / Nightlife', 'Art / Museums', 'Theater / Comedy', 'Outdoor activities', 'Markets / Shopping', 'Festivals', 'Workshops / Classes'],
  },
  {
    question: 'How adventurous are you about trying new things?',
    type: 'single',
    options: ['Try anything once', 'Mostly stick to familiar', 'A healthy mix'],
  },
];

const SurveyModal = ({ onClose, onPreferencesUpdate }) => {
  const { userId, userProfile, setUserProfile, showGlobalMessage } = useContext(AppContext);
  const [stage, setStage] = useState(0);
  const [answers, setAnswers] = useState({});
  const [currentSelected, setCurrentSelected] = useState([]);
  const [followUps, setFollowUps] = useState([]);
  const [loadingFollowUps, setLoadingFollowUps] = useState(false);
  const [saving, setSaving] = useState(false);

  const allQuestions = [...INITIAL_SURVEY_QUESTIONS, ...followUps];
  const currentQuestion = allQuestions[stage];
  const isInitialDone = stage === INITIAL_SURVEY_QUESTIONS.length - 1;
  const isFinalStage = stage === allQuestions.length - 1 && followUps.length > 0;

  const handleToggleOption = (opt) => {
    if (currentQuestion.type === 'single') {
      setCurrentSelected([opt]);
    } else {
      setCurrentSelected((prev) => (prev.includes(opt) ? prev.filter((o) => o !== opt) : [...prev, opt]));
    }
  };

  const generateFollowUps = async (answersSoFar) => {
    if (!geminiApiKey) {
      showGlobalMessage('Survey needs the Gemini API key.', 'error');
      return null;
    }
    const summary = INITIAL_SURVEY_QUESTIONS
      .map((q, i) => `Q: ${q.question}\nA: ${(answersSoFar[i] || []).join(', ') || '(no answer)'}`)
      .join('\n\n');
    const prompt = `A user is filling out an interest survey for a social events recommendation app. So far they've answered:

${summary}

Generate exactly 3 follow-up questions that drill into their stated interests. Each question must have 4-6 specific, concrete options the user could realistically pick from. Avoid duplicating what they already answered. Mix single-select and multi-select where it makes sense.

Return ONLY a JSON array (no prose, no markdown) of objects with keys: question (string), type ("single" or "multi"), options (array of strings).`;

    try {
      const provider = userProfile?.aiProvider || 'gemini';
      const text = await callAI({ prompt, useWebSearch: false, provider });
      const generated = extractJsonArray(text);
      return Array.isArray(generated) ? generated.slice(0, 3) : null;
    } catch (e) {
      console.error('Survey follow-up generation failed:', e);
      return null;
    }
  };

  const goNext = async () => {
    const next = { ...answers, [stage]: currentSelected };
    setAnswers(next);
    setCurrentSelected([]);

    // After the last initial question, build the follow-up questions:
    // deterministic drill-downs for the broad buckets they picked (food, drinks,
    // music — so we capture specific tastes), then Gemini's AI follow-ups.
    if (isInitialDone && followUps.length === 0) {
      // The "favorite categories" question is index 1.
      const chosenCategories = next[1] || [];
      const drillDowns = chosenCategories
        .map((c) => INTEREST_TAXONOMY[c])
        .filter(Boolean)
        .map((def) => ({ question: def.question, type: 'multi', options: def.options, _detailKey: def.key }));

      setLoadingFollowUps(true);
      const generated = await generateFollowUps(next);
      setLoadingFollowUps(false);

      const combined = [...drillDowns, ...(generated || [])];
      if (combined.length === 0) {
        // Nothing to ask — save what we have and exit.
        await save(next);
        return;
      }
      setFollowUps(combined);
    }
    setStage((s) => s + 1);
  };

  const goBack = () => {
    setStage((s) => Math.max(0, s - 1));
    setCurrentSelected(answers[Math.max(0, stage - 1)] || []);
  };

  const save = async (finalAnswers) => {
    setSaving(true);
    try {
      const allOptions = Object.values(finalAnswers).flat().filter(Boolean);
      const newPrefs = [...new Set([...(userProfile?.preferences || []), ...allOptions])];

      // Route drill-down answers into structured preferenceDetails (food /
      // drinks / music specifics) so place picks + ranking can use them precisely.
      const questions = [...INITIAL_SURVEY_QUESTIONS, ...followUps];
      const details = { ...(userProfile?.preferenceDetails || {}) };
      questions.forEach((q, i) => {
        if (!q._detailKey) return;
        const picked = (finalAnswers[i] || []).filter(Boolean);
        if (picked.length) details[q._detailKey] = [...new Set([...(details[q._detailKey] || []), ...picked])];
      });

      await updateDoc(doc(db, `artifacts/${appId}/users/${userId}/profiles`, 'myProfile'), {
        preferences: newPrefs,
        preferenceDetails: details,
      });
      setUserProfile((p) => ({ ...(p || {}), preferences: newPrefs, preferenceDetails: details }));
      if (onPreferencesUpdate) onPreferencesUpdate(newPrefs, details);
      showGlobalMessage(`Added ${allOptions.length} interests to your profile.`);
      onClose();
    } catch (e) {
      console.error(e);
      showGlobalMessage('Could not save survey results.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleFinish = async () => {
    const finalAnswers = { ...answers, [stage]: currentSelected };
    await save(finalAnswers);
  };

  // Render: loading screen for Gemini follow-up generation
  if (loadingFollowUps) {
    return (
      <Modal onClose={onClose} title="Tailoring questions for you…">
        <div className="flex flex-col items-center py-10 gap-3">
          <div className="w-10 h-10 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-gray-500">Asking Gemini for follow-up questions based on your answers…</p>
        </div>
      </Modal>
    );
  }

  if (!currentQuestion) return null;

  const total = allQuestions.length || INITIAL_SURVEY_QUESTIONS.length;

  return (
    <Modal onClose={onClose} title={`Interest survey · ${stage + 1} of ${total}`}>
      <div className="space-y-5">
        <div>
          <h3 className="text-lg font-bold text-gray-900">{currentQuestion.question}</h3>
          <p className="text-xs text-gray-500 mt-1">
            {currentQuestion.type === 'multi' ? 'Pick as many as apply.' : 'Pick one.'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {currentQuestion.options.map((opt) => {
            const on = currentSelected.includes(opt);
            return (
              <button
                key={opt}
                type="button"
                onClick={() => handleToggleOption(opt)}
                className={`px-3 py-2 rounded-full text-sm font-medium border transition ${
                  on ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-700 border-gray-200 hover:border-indigo-300'
                }`}
              >
                {opt}
              </button>
            );
          })}
        </div>
        <div className="flex gap-2 pt-2">
          {stage > 0 && (
            <button
              onClick={goBack}
              disabled={saving}
              className="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 py-3 rounded-xl font-medium transition disabled:opacity-50"
            >
              Back
            </button>
          )}
          {isFinalStage ? (
            <button
              onClick={handleFinish}
              disabled={currentSelected.length === 0 || saving}
              className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white py-3 rounded-xl font-bold disabled:opacity-50 transition"
            >
              {saving ? 'Saving…' : 'Finish'}
            </button>
          ) : (
            <button
              onClick={goNext}
              disabled={currentSelected.length === 0}
              className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white py-3 rounded-xl font-bold disabled:opacity-50 transition"
            >
              Next
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
};

// --- Legal Acceptance (TOS + NDA gate) ---
// Required acceptance before using the private beta. Stores
// profile.legalAcceptedAt timestamp; while missing, the modal blocks
// the rest of the app. The two documents are template boilerplate
// drafted for NY law; for production use the owner should have an
// actual attorney review them.
const TOS_VERSION = '2026-05-25';
const NDA_VERSION = '2026-05-25';

const TOS_TEXT = `Terms of Service
Last updated: ${TOS_VERSION}

By accessing Hangouts ("the Service"), you agree to these Terms of Service. If you do not agree, do not use the Service.

1. The Service. Hangouts is a private-beta social planning application provided by Paul Downs ("Owner") for testing and feedback purposes only. The Service is not generally available and may be modified, suspended, or terminated at any time without notice.

2. Eligibility. You must be at least 18 years old to use the Service.

3. Acceptable Use. You agree to use the Service only for lawful purposes and not to:
   • Reverse engineer, copy, or extract the underlying technology or business concept;
   • Use the Service to harass, harm, or impersonate others;
   • Upload illegal or infringing content.

4. Account & Data. You are responsible for activity on your account. The Owner stores the data you provide (display name, location, calendar information you sync, group activity) solely to operate the Service. The Owner will not sell your data to third parties during this private beta.

5. No Warranties. THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT.

6. Limitation of Liability. To the maximum extent permitted by law, the Owner shall not be liable for any indirect, incidental, special, consequential, or punitive damages arising from your use of, or inability to use, the Service.

7. Changes. The Owner may update these Terms at any time. Continued use after changes constitutes acceptance of the updated Terms.

8. Governing Law. These Terms are governed by the laws of the State of New York, without regard to conflict-of-law principles.

9. Disputes. Any dispute arising out of or relating to these Terms shall be resolved in the state or federal courts located in the State of New York, and you consent to the exclusive jurisdiction and venue of such courts.`;

const NDA_TEXT = `Non-Disclosure Agreement
Last updated: ${NDA_VERSION}

This Non-Disclosure Agreement ("Agreement") is entered into between you ("Recipient") and Paul Downs ("Discloser"), and governs your access to confidential information about Hangouts ("the Service") during its private-beta period.

1. Confidential Information. "Confidential Information" means all non-public information about the Service that you observe or that is disclosed to you, including without limitation: the application's concept and design, features and roadmap, user-interface, source code and architecture, business plans and strategies, marketing approach, user data, screenshots, recordings, and any feedback or analysis that incorporates the foregoing.

2. Recipient Obligations. Recipient agrees, during the term of this Agreement and thereafter:
   (a) Not to disclose Confidential Information to any third party (including without limitation friends, colleagues, employers, investors, journalists, competitors, or potential users) without the prior written consent of Discloser;
   (b) Not to use Confidential Information for any purpose other than evaluating and providing feedback on the Service, and specifically not to build, fund, advise, or assist any product or service that competes with or copies the Service;
   (c) Not to copy, reproduce, screenshot, record, or create derivative works based on Confidential Information, except as necessary to use the Service as intended;
   (d) To use the same degree of care to protect Confidential Information as Recipient uses for its own confidential information of like importance, and in any event no less than a reasonable standard of care;
   (e) To promptly notify Discloser in writing of any unauthorized disclosure, access, or use of Confidential Information.

3. Exclusions. Confidential Information does not include information that:
   (a) Was lawfully and demonstrably in Recipient's possession prior to disclosure by Discloser;
   (b) Was or becomes publicly known through no fault, act, or omission of Recipient;
   (c) Is independently developed by Recipient without any use of or reference to Confidential Information;
   (d) Is disclosed to Recipient by a third party rightfully in possession of such information and not under any obligation of confidentiality.

4. Term. This Agreement is effective from the moment Recipient first accesses the Service and continues for two (2) years from Recipient's last access, or until the Confidential Information becomes publicly known through Discloser's own authorized disclosure, whichever occurs first.

5. Return or Destruction. Upon Discloser's written request, Recipient shall promptly return or destroy all Confidential Information in its possession and, if requested, certify such destruction in writing.

6. Equitable Remedies. Recipient acknowledges that any breach of this Agreement may cause irreparable harm to Discloser for which monetary damages may be inadequate. Accordingly, Discloser shall be entitled to seek equitable relief, including without limitation a temporary restraining order, preliminary injunction, and specific performance, in addition to any other remedies available at law or in equity, and without the requirement to post a bond.

7. No License. Nothing in this Agreement grants Recipient any license, title, or interest in or to the Confidential Information, except the limited right to evaluate the Service in accordance with these terms.

8. Governing Law. This Agreement is governed by the laws of the State of New York, without regard to conflict-of-law principles.

9. Venue. The parties consent to exclusive personal jurisdiction and venue in the state and federal courts located in the State of New York.

10. Entire Agreement. This Agreement constitutes the entire agreement between the parties concerning Confidential Information and supersedes all prior or contemporaneous understandings, communications, or agreements on the subject matter. No modification of this Agreement is effective unless in writing and signed by both parties.

By checking the box and clicking "I Accept" below, you acknowledge that you have read, understood, and agree to be legally bound by this Agreement.`;

const LegalAcceptanceModal = () => {
  const { userId, userProfile, setUserProfile, showGlobalMessage } = useContext(AppContext);
  const [tosAgreed, setTosAgreed] = useState(false);
  const [ndaAgreed, setNdaAgreed] = useState(false);
  const [saving, setSaving] = useState(false);

  // Anonymous users have no email from Firebase Auth, so we capture
  // both name and email here. Google users already have both.
  const isAnon = !!auth?.currentUser?.isAnonymous;
  const [legalName, setLegalName] = useState(userProfile?.name && userProfile.name !== 'User' ? userProfile.name : '');
  const [legalEmail, setLegalEmail] = useState(userProfile?.email || '');

  const emailLooksValid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(legalEmail.trim());
  const nameLooksValid = legalName.trim().length >= 2;
  const identityOk = !isAnon || (nameLooksValid && emailLooksValid);

  const accept = async () => {
    if (!tosAgreed || !ndaAgreed || !identityOk) return;
    setSaving(true);
    try {
      const stamp = {
        legalAcceptedAt: serverTimestamp(),
        tosVersion: TOS_VERSION,
        ndaVersion: NDA_VERSION,
      };
      // For anonymous users we also persist the name + email they
      // entered, so we have a stable contact record for every accept.
      if (isAnon) {
        stamp.name = legalName.trim();
        stamp.email = legalEmail.trim().toLowerCase();
      }
      await updateDoc(doc(db, `artifacts/${appId}/users/${userId}/profiles`, 'myProfile'), stamp);
      setUserProfile((p) => ({
        ...(p || {}),
        ...stamp,
        legalAcceptedAt: new Date().toISOString(),
      }));

      // Who just signed (for the audit record + owner notification).
      const signerName = isAnon ? legalName.trim() : (userProfile?.name || 'User');
      const signerEmail = isAnon ? legalEmail.trim().toLowerCase() : (userProfile?.email || '(no email on file)');

      // Append-only audit record, separate from the per-user profile stamp,
      // so the owner has one queryable list of every acceptance. Non-fatal:
      // the binding acceptance is already recorded on the profile above.
      try {
        await addDoc(collection(db, `artifacts/${appId}/public/data/legalAcceptances`), {
          userId,
          name: signerName,
          email: signerEmail,
          tosVersion: TOS_VERSION,
          ndaVersion: NDA_VERSION,
          acceptedAt: serverTimestamp(),
          userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
        });
      } catch (e) {
        console.warn('Could not write legal acceptance audit record:', e);
      }

      // Notify the owner by email (same Web3Forms channel as feedback).
      // Also non-fatal — failing to email never blocks the user from entering.
      if (FEEDBACK_KEY) {
        try {
          await fetch('https://api.web3forms.com/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
              access_key: FEEDBACK_KEY,
              subject: 'Hangouts — Terms & NDA accepted',
              from_name: signerName,
              message:
                `${signerName} (${signerEmail}) accepted the Terms of Service and Non-Disclosure Agreement.\n\n` +
                `uid: ${userId}\n` +
                `ToS version: ${TOS_VERSION}\n` +
                `NDA version: ${NDA_VERSION}\n` +
                `When: ${new Date().toISOString()}`,
            }),
          });
        } catch (e) {
          console.warn('Web3Forms legal-acceptance email failed:', e);
        }
      }

      showGlobalMessage('Welcome aboard.');
    } catch (e) {
      console.error(e);
      showGlobalMessage('Could not record acceptance. Please try again.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const decline = async () => {
    try {
      await signOut(auth);
      if (typeof window !== 'undefined') window.localStorage.removeItem(UNLOCK_KEY);
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] flex justify-center items-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] flex flex-col">
        <header className="p-5 border-b border-gray-100">
          <h2 className="text-xl font-bold text-gray-800">Before you continue</h2>
          <p className="text-xs text-gray-500 mt-1">
            Hangouts is in private beta. Please read and accept the Terms of Service and Non-Disclosure Agreement below.
          </p>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6 text-sm text-gray-700">
          {isAnon && (
            <section className="bg-indigo-50 border border-indigo-100 rounded-xl p-4 space-y-3">
              <div>
                <h3 className="font-bold text-gray-900 mb-1">Who's signing?</h3>
                <p className="text-xs text-gray-600">
                  Because you signed in anonymously, we need your real name and email so the acceptance is legally meaningful and so we can contact you if needed.
                </p>
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase text-gray-500 mb-1">Full name</label>
                <input
                  type="text"
                  value={legalName}
                  onChange={(e) => setLegalName(e.target.value)}
                  placeholder="e.g. Jane Doe"
                  className="w-full p-2.5 bg-white border border-gray-200 rounded-xl focus:ring-2 focus:ring-indigo-500 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase text-gray-500 mb-1">Email</label>
                <input
                  type="email"
                  value={legalEmail}
                  onChange={(e) => setLegalEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full p-2.5 bg-white border border-gray-200 rounded-xl focus:ring-2 focus:ring-indigo-500 text-sm"
                />
              </div>
            </section>
          )}
          <section>
            <h3 className="font-bold text-gray-900 mb-2">Terms of Service</h3>
            <pre className="whitespace-pre-wrap font-sans text-sm bg-gray-50 border border-gray-200 rounded-xl p-4 leading-relaxed">{TOS_TEXT}</pre>
            <label className="flex items-start gap-2 mt-3 cursor-pointer">
              <input
                type="checkbox"
                checked={tosAgreed}
                onChange={(e) => setTosAgreed(e.target.checked)}
                className="mt-1 w-4 h-4 text-indigo-600 rounded focus:ring-indigo-500"
              />
              <span className="text-sm text-gray-700">I have read and agree to the <strong>Terms of Service</strong>.</span>
            </label>
          </section>

          <section>
            <h3 className="font-bold text-gray-900 mb-2">Non-Disclosure Agreement</h3>
            <pre className="whitespace-pre-wrap font-sans text-sm bg-gray-50 border border-gray-200 rounded-xl p-4 leading-relaxed">{NDA_TEXT}</pre>
            <label className="flex items-start gap-2 mt-3 cursor-pointer">
              <input
                type="checkbox"
                checked={ndaAgreed}
                onChange={(e) => setNdaAgreed(e.target.checked)}
                className="mt-1 w-4 h-4 text-indigo-600 rounded focus:ring-indigo-500"
              />
              <span className="text-sm text-gray-700">I have read and agree to the <strong>Non-Disclosure Agreement</strong>, and understand that violating it could lead to legal action.</span>
            </label>
          </section>
        </div>
        <footer className="p-5 border-t border-gray-100 flex gap-3">
          <button
            onClick={decline}
            disabled={saving}
            className="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 py-3 rounded-xl font-medium transition disabled:opacity-50"
          >
            Decline &amp; Sign Out
          </button>
          <button
            onClick={accept}
            disabled={!tosAgreed || !ndaAgreed || !identityOk || saving}
            className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white py-3 rounded-xl font-bold disabled:opacity-50 transition"
            title={!identityOk ? 'Enter your name and a valid email to continue' : ''}
          >
            {saving ? 'Recording…' : 'I Accept'}
          </button>
        </footer>
      </div>
    </div>
  );
};

// --- Name Setting (for anonymous + new users) ---
// Anonymous Firebase Auth users come in with no displayName, so their
// profile defaults to "User". When that's the case (or the name is
// missing/blank), prompt the user to pick a display name so group
// members can tell them apart.
const NameSettingModal = ({ onClose }) => {
  const { userId, userProfile, setUserProfile, showGlobalMessage } = useContext(AppContext);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      await updateDoc(doc(db, `artifacts/${appId}/users/${userId}/profiles`, 'myProfile'), { name: trimmed });
      setUserProfile((p) => ({ ...(p || {}), name: trimmed }));
      showGlobalMessage(`Welcome, ${trimmed}!`);
      onClose();
    } catch (e) {
      console.error(e);
      showGlobalMessage('Could not save your name.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    // No outer onClose handler — user must enter a name (or skip explicitly).
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex justify-center items-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md flex flex-col">
        <header className="p-5 border-b border-gray-100">
          <h2 className="text-xl font-bold text-gray-800">What should we call you?</h2>
        </header>
        <div className="p-6 space-y-4">
          <p className="text-sm text-gray-500">
            Your group members will see this name when you chat or propose events. You can change it later in your profile.
          </p>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()}
            placeholder="Your first name"
            className="w-full p-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:bg-white transition"
          />
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="flex-1 py-3 rounded-xl font-medium text-gray-500 hover:bg-gray-100 transition"
            >
              Skip
            </button>
            <button
              onClick={save}
              disabled={!name.trim() || saving}
              className="flex-1 bg-indigo-600 text-white py-3 rounded-xl font-bold disabled:opacity-50 hover:bg-indigo-700 transition"
            >
              {saving ? 'Saving…' : 'Continue'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// --- Send-to-Group ---
// Lets the user propose an event from their personal feed to any group
// they're a member of. Mirrors the SuggestionSection propose flow:
// canonical proposal lives in the group's /proposals subcollection;
// lightweight pings go into other members' feeds for toast + badge.
const SendToGroupModal = ({ event, anchorRect, onClose }) => {
  const { userId, userProfile, showGlobalMessage } = useContext(AppContext);
  const [groups, setGroups] = useState([]);
  const [loadingGroups, setLoadingGroups] = useState(true);
  const [sendingTo, setSendingTo] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');

  // Position the floating panel right at the button that opened it: drop it
  // just below the button, and flip above only when there isn't room below.
  // Coordinates are viewport-relative (getBoundingClientRect), matching the
  // panel's absolute-in-fixed positioning, so it lands where you clicked
  // regardless of how far down a long feed you've scrolled. Memoized.
  const panelStyle = useMemo(() => {
    if (typeof window === 'undefined') return null;
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const panelH = Math.min(480, vh - 32);
    const panelW = Math.min(448, vw - 32);
    if (!anchorRect || (!anchorRect.top && !anchorRect.bottom)) {
      return { top: `${Math.max(16, (vh - panelH) / 2)}px`, left: `${(vw - panelW) / 2}px`, width: `${panelW}px`, maxHeight: `${panelH}px` };
    }
    // Prefer dropping below the button; flip above if it would overflow.
    let top = anchorRect.bottom + 8;
    if (top + panelH > vh - 16) top = anchorRect.top - panelH - 8;
    top = Math.max(16, Math.min(top, vh - panelH - 16));
    // Right-align the panel to the button, clamped to the viewport.
    let left = Math.min(anchorRect.right, vw) - panelW;
    left = Math.max(16, Math.min(left, vw - panelW - 16));
    return { top: `${top}px`, left: `${left}px`, width: `${panelW}px`, maxHeight: `${panelH}px` };
  }, [anchorRect]);

  const groupIdsKey = userProfile?.groupIds?.join(',') || '';

  useEffect(() => {
    if (!userProfile?.groupIds?.length) {
      setGroups([]);
      setLoadingGroups(false);
      return;
    }
    let cancelled = false;
    Promise.all(
      userProfile.groupIds.map(async (gid) => {
        try {
          const snap = await getDoc(doc(db, `artifacts/${appId}/public/data/groups`, gid));
          return snap.exists() ? { id: snap.id, ...snap.data() } : null;
        } catch {
          return null;
        }
      })
    ).then((arr) => {
      if (cancelled) return;
      setGroups(arr.filter(Boolean));
      setLoadingGroups(false);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupIdsKey]);

  const send = async (group) => {
    setSendingTo(group.id);
    setErrorMsg('');
    try {
      // Sanitize every field — Firestore rejects undefined values, and
      // Gemini's event payloads often omit imageUrl / imageKeywords / url.
      const safe = {
        title: event?.title || '',
        description: event?.description || '',
        location: event?.location || '',
        date: event?.date || '',
        url: event?.url || '',
        imageUrl: event?.imageUrl || null,
        imageKeywords: event?.imageKeywords || '',
        priceTier: event?.priceTier || null,
        isTicketed: typeof event?.isTicketed === 'boolean' ? event.isTicketed : false,
        ticketsUrl: event?.ticketsUrl || null,
        source: event?.source || null,
        type: event?.type || null,
      };
      const proposerName = userProfile?.name || 'User';

      const proposalData = {
        ...safe,
        proposerId: userId,
        proposerName,
        groupId: group.id,
        groupName: group.name,
        rsvps: { [userId]: 'yes' },
        createdAt: serverTimestamp(),
      };
      const proposalRef = await addDoc(
        collection(db, `artifacts/${appId}/public/data/groups/${group.id}/proposals`),
        proposalData
      );

      const batch = writeBatch(db);
      (group.members || []).forEach((memberId) => {
        if (memberId === userId) return;
        batch.set(doc(collection(db, `artifacts/${appId}/users/${memberId}/feed`)), {
          type: 'groupProposal',
          data: {
            ...safe,
            proposerName,
            groupId: group.id,
            groupName: group.name,
            proposalId: proposalRef.id,
          },
          timestamp: serverTimestamp(),
        });
      });
      await batch.commit();
      sendProposalEmails(group, safe.title, proposerName, userId);
      showGlobalMessage(`Sent "${safe.title}" to ${group.name}!`);
      onClose();
    } catch (e) {
      console.error('Send-to-group failed:', e);
      const detail = e?.code ? `${e.code}: ${e.message || ''}` : (e?.message || String(e));
      setErrorMsg(`Could not send. ${detail}`);
      showGlobalMessage('Could not send to that group.', 'error');
    } finally {
      setSendingTo(null);
    }
  };

  // Render via a portal to <body> so the fixed overlay and its positioned
  // panel are relative to the viewport, not trapped inside the FeedCard's
  // `overflow-hidden`/positioned container (which pinned it to the top).
  return createPortal(
    <div
      className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50"
      onClick={onClose}
    >
      <div
        className="absolute bg-white rounded-2xl shadow-2xl overflow-y-auto flex flex-col"
        style={panelStyle || { top: '10vh', left: '50%', transform: 'translateX(-50%)', width: '90%', maxWidth: '448px' }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex justify-between items-center p-4 border-b border-gray-100 sticky top-0 bg-white z-10">
          <h2 className="text-base font-bold text-gray-800">Send to a group</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 p-1 rounded-full hover:bg-gray-100 transition">
            <CloseIcon className="w-5 h-5" />
          </button>
        </header>
        <div className="p-4 space-y-3">
        <p className="text-sm text-gray-500">
          Propose <span className="font-semibold text-gray-700">"{event.title}"</span> to one of your groups. Members will see it on the group's Proposed Events tab.
        </p>
        {loadingGroups ? (
          <div className="flex justify-center py-8">
            <div className="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : groups.length === 0 ? (
          <div className="text-center py-8 text-gray-500 text-sm">
            You're not in any groups yet. Create one from the "My Groups" tab first.
          </div>
        ) : (
          <div className="space-y-2 max-h-80 overflow-y-auto">
            {errorMsg && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-700 break-words">
                {errorMsg}
              </div>
            )}
            {groups.map((g) => (
              <button
                key={g.id}
                onClick={() => send(g)}
                disabled={sendingTo !== null}
                className="w-full text-left p-4 bg-gray-50 hover:bg-indigo-50 rounded-xl flex items-center justify-between transition disabled:opacity-50"
              >
                <div>
                  <p className="font-bold text-gray-900">{g.name}</p>
                  <p className="text-xs text-gray-500">{g.members?.length || 0} member{g.members?.length === 1 ? '' : 's'}</p>
                </div>
                {sendingTo === g.id ? (
                  <div className="w-5 h-5 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
                ) : (
                  <SendIcon className="w-5 h-5 text-indigo-500" />
                )}
              </button>
            ))}
          </div>
        )}
        </div>
      </div>
    </div>,
    document.body
  );
};

// --- Feedback Widget ---
// Floating "Feedback" button in the bottom-right. Submitted feedback is
// stored in Firestore (artifacts/{appId}/public/data/feedback) and, when
// VITE_FEEDBACK_KEY is configured, also emailed to the project owner via
// Web3Forms.
const FEEDBACK_KEY = import.meta.env.VITE_FEEDBACK_KEY || '';

const FeedbackButton = () => {
  const { userId } = useContext(AppContext);
  const [open, setOpen] = useState(false);
  if (!userId) return null;
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 bg-indigo-600 text-white pl-4 pr-5 py-3 rounded-full shadow-2xl hover:bg-indigo-700 z-40 flex items-center gap-2 font-medium text-sm transition-transform hover:scale-105"
        title="Send feedback"
      >
        <ChatIcon className="w-5 h-5" />
        Feedback
      </button>
      {open && <FeedbackModal onClose={() => setOpen(false)} />}
    </>
  );
};

const FeedbackModal = ({ onClose }) => {
  const { userId, userProfile, showGlobalMessage } = useContext(AppContext);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSubmitting(true);
    const payload = {
      text: trimmed,
      userId,
      userName: userProfile?.name || 'Anonymous',
      url: typeof window !== 'undefined' ? window.location.pathname : '',
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      timestamp: serverTimestamp(),
    };
    try {
      // 1) Persist to Firestore so the owner has a permanent record.
      await addDoc(collection(db, `artifacts/${appId}/public/data/feedback`), payload);

      // 2) Optionally email the owner via Web3Forms (no signup required to send,
      //    just an access key from the owner's Web3Forms account).
      if (FEEDBACK_KEY) {
        try {
          await fetch('https://api.web3forms.com/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
              access_key: FEEDBACK_KEY,
              subject: 'Hangouts feedback',
              from_name: payload.userName,
              message: `${trimmed}\n\n— from ${payload.userName} (uid: ${userId})\nURL: ${payload.url}\nUA: ${payload.userAgent}`,
            }),
          });
        } catch (e) {
          // Email failure is non-fatal — feedback is still saved to Firestore.
          console.warn('Web3Forms email failed:', e);
        }
      }

      showGlobalMessage('Thanks — feedback sent!');
      onClose();
    } catch (e) {
      console.error(e);
      showGlobalMessage('Could not send feedback. Please try again.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal onClose={onClose} title="Share Feedback">
      <div className="space-y-4">
        <p className="text-sm text-gray-500">
          Notice something broken, an idea for an improvement, or just want to say something nice? Drop it here — it goes straight to the maintainer.
        </p>
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="What's working? What's broken? What's missing?"
          className="w-full p-3 border border-gray-200 rounded-xl min-h-32 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition resize-y"
        />
        <button
          onClick={submit}
          disabled={!text.trim() || submitting}
          className="w-full bg-indigo-600 text-white py-3 rounded-xl font-bold disabled:opacity-50 hover:bg-indigo-700 transition"
        >
          {submitting ? 'Sending…' : 'Send feedback'}
        </button>
      </div>
    </Modal>
  );
};

// --- Password Gate ---
// A simple shared-passcode wall that fronts the entire app. Useful for
// friends-and-family demos that shouldn't be world-accessible.
// VITE_PASSCODE_HASH should be the lowercase hex SHA-256 of the chosen
// passcode. If the env var is not set, the gate is bypassed (handy for
// local dev). Once unlocked, the result is cached in localStorage so
// returning users skip the prompt.
const PASSCODE_HASH = import.meta.env.VITE_PASSCODE_HASH || '';
const UNLOCK_KEY = 'hangouts_unlocked_v1';

const sha256Hex = async (text) => {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};

const PasscodeGate = ({ children }) => {
  // No hash configured -> bypass entirely (treat as dev/preview env).
  const [unlocked, setUnlocked] = useState(
    !PASSCODE_HASH || (typeof window !== 'undefined' && window.localStorage.getItem(UNLOCK_KEY) === 'true')
  );
  const [input, setInput] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');

  if (unlocked) return children;

  const tryUnlock = async (e) => {
    e.preventDefault();
    if (!input.trim()) return;
    setChecking(true);
    setError('');
    try {
      const entered = await sha256Hex(input.trim());
      if (entered === PASSCODE_HASH.toLowerCase()) {
        window.localStorage.setItem(UNLOCK_KEY, 'true');
        setUnlocked(true);
      } else {
        setError('Incorrect passcode.');
        setInput('');
      }
    } catch {
      setError('Could not verify passcode.');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 p-4">
      <div className="bg-white/95 backdrop-blur-xl p-8 rounded-3xl shadow-2xl w-full max-w-md text-center">
        <div className="w-20 h-20 bg-indigo-100 rounded-full flex items-center justify-center mx-auto mb-6 text-indigo-600">
          <Icon path="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" className="w-10 h-10" />
        </div>
        <h1 className="text-3xl font-black text-gray-900 mb-2">Hangouts</h1>
        <p className="text-gray-500 mb-6">Private preview. Enter the passcode to continue.</p>
        <form onSubmit={tryUnlock} className="space-y-3">
          <input
            autoFocus
            type="password"
            value={input}
            onChange={(e) => { setInput(e.target.value); setError(''); }}
            placeholder="Passcode"
            className="w-full p-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:bg-white text-center transition"
          />
          {error && <p className="text-sm text-red-500 font-medium">{error}</p>}
          <button
            type="submit"
            disabled={!input.trim() || checking}
            className="w-full py-3 px-4 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 font-bold transition disabled:opacity-50"
          >
            {checking ? 'Checking…' : 'Unlock'}
          </button>
        </form>
        <p className="text-xs text-gray-400 mt-6">Don't have the passcode? Ask Paul.</p>
      </div>
    </div>
  );
};

// --- Public self-serve sponsor page (no login) at /sponsor ---
const SPONSOR_PACKAGES = [
  { id: '7day', label: '7 days', price: '$29' },
  { id: '30day', label: '30 days', price: '$79' },
];
const SponsorLanding = () => {
  const [form, setForm] = useState({ title: '', description: '', url: '', imageUrl: '', location: '', borough: '', type: 'Other', sponsorName: '', package: '7day' });
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');
  const status = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('status') : null;
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    if (!form.title.trim() || !form.sponsorName.trim()) {
      setErr('Event title and your name/business are required.');
      return;
    }
    setSubmitting(true);
    setErr('');
    try {
      const res = await fetch('/api/sponsor-checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, appId }) });
      const data = await res.json().catch(() => ({}));
      if (data.url) {
        window.location.href = data.url;
        return;
      }
      setErr(data.error || 'Could not start checkout.');
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#F3F4F6] p-4 md:p-8 overflow-x-hidden">
      <div className="max-w-xl mx-auto">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">Promote your event on Hangouts</h1>
        <p className="text-sm text-gray-500 mb-6">Feature your event at the top of local feeds. Pick a package, pay securely, and it goes live automatically.</p>
        {status === 'success' && <div className="mb-4 p-3 rounded-xl bg-emerald-50 text-emerald-800 text-sm">Payment received — your placement will appear shortly. Thank you!</div>}
        {status === 'cancel' && <div className="mb-4 p-3 rounded-xl bg-amber-50 text-amber-800 text-sm">Checkout canceled — no charge was made.</div>}
        <form onSubmit={submit} className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 space-y-3">
          {[
            ['sponsorName', 'Your name or business *', 'e.g. Joe\'s Bar'],
            ['title', 'Event title *', 'e.g. Trivia Night at Joe\'s'],
            ['description', 'Short description', 'What is it?'],
            ['location', 'Location / address', 'e.g. 123 5th Ave, Brooklyn'],
            ['url', 'Link (tickets or info)', 'https://…'],
            ['imageUrl', 'Image URL (optional)', 'https://…'],
          ].map(([k, label, ph]) => (
            <div key={k}>
              <label className="block text-xs font-semibold uppercase text-gray-500 mb-1">{label}</label>
              <input value={form[k]} onChange={(e) => set(k, e.target.value)} placeholder={ph} className="w-full p-2.5 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500" />
            </div>
          ))}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold uppercase text-gray-500 mb-1">Type</label>
              <select value={form.type} onChange={(e) => set('type', e.target.value)} className="w-full p-2.5 border border-gray-200 rounded-xl text-sm bg-white">
                {EVENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase text-gray-500 mb-1">NYC borough (optional)</label>
              <input value={form.borough} onChange={(e) => set('borough', e.target.value)} placeholder="Brooklyn" className="w-full p-2.5 border border-gray-200 rounded-xl text-sm" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase text-gray-500 mb-2">Package</label>
            <div className="flex gap-2">
              {SPONSOR_PACKAGES.map((p) => (
                <button type="button" key={p.id} onClick={() => set('package', p.id)} className={`flex-1 py-3 rounded-xl border font-bold text-sm transition ${form.package === p.id ? 'border-indigo-600 bg-indigo-50 text-indigo-700' : 'border-gray-200 text-gray-600'}`}>
                  {p.label} · {p.price}
                </button>
              ))}
            </div>
          </div>
          {err && <p className="text-sm text-red-600">{err}</p>}
          <button type="submit" disabled={submitting} className="w-full bg-indigo-600 text-white py-3 rounded-xl font-bold hover:bg-indigo-700 disabled:opacity-50 transition">
            {submitting ? 'Starting checkout…' : 'Continue to secure payment'}
          </button>
          <p className="text-[11px] text-gray-400 text-center">Payments handled by Stripe. Placements are clearly labeled "Sponsored."</p>
        </form>
      </div>
    </div>
  );
};

// --- Main App ---
export default function App() {
  if (typeof window !== 'undefined' && window.location.pathname === '/sponsor') return <SponsorLanding />;
  const [userId, setUserId] = useState(null);
  const [userProfile, setUserProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState(null);
  const [googleAccessToken, setGoogleAccessToken] = useState(null);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showAboutModal, setShowAboutModal] = useState(false);
  const [pendingJoinGroupId, setPendingJoinGroupId] = useState(null);
  const [unreadFeedCount, setUnreadFeedCount] = useState(0);
  const [nameSkipped, setNameSkipped] = useState(false);
  const [feedRefreshTick, setFeedRefreshTick] = useState(0);
  const seenFeedIdsRef = useRef(null); // null until first snapshot lands

  // Once we have a userId + a loaded profile, decide whether the name
  // prompt should appear (anonymous user, or somehow no name set).
  const needsName =
    !!userId &&
    !!userProfile &&
    !nameSkipped &&
    (!userProfile.name || userProfile.name === 'User' || userProfile.name.trim() === '');

  // Block all app interaction until the user has accepted the current TOS
  // and NDA versions. We check the stored version so a future doc revision
  // can force re-acceptance by bumping TOS_VERSION/NDA_VERSION.
  const needsLegal =
    !!userId &&
    !!userProfile &&
    (
      !userProfile.legalAcceptedAt ||
      userProfile.tosVersion !== TOS_VERSION ||
      userProfile.ndaVersion !== NDA_VERSION
    );

  const showGlobalMessage = useCallback((text, type = 'success') => {
    setMsg({ text, type });
    setTimeout(() => setMsg(null), 3000);
  }, []);

  const getUserNameById = useCallback(async (uid) => {
    try {
      const snap = await getDoc(doc(db, `artifacts/${appId}/users/${uid}/profiles`, 'myProfile'));
      return snap.exists() ? snap.data().name : 'User';
    } catch {
      return 'User';
    }
  }, []);

  // Subscribe to the current user's feed at the top level so we can show
  // a toast when a new group proposal arrives even if the user is on a
  // different tab. The MyFeed tab still has its own subscription for
  // rendering; that's a small duplication but Firestore deduplicates the
  // wire traffic.
  // NOTE: This effect must be declared AFTER `showGlobalMessage` because
  // it appears in the deps array — `const` symbols are in TDZ before
  // their initializer, and an earlier version of this code blanked the
  // whole app with a ReferenceError on first render.
  useEffect(() => {
    if (!userId) {
      seenFeedIdsRef.current = null;
      setUnreadFeedCount(0);
      return;
    }
    const q = query(
      collection(db, `artifacts/${appId}/users/${userId}/feed`),
      orderBy('timestamp', 'desc'),
      limit(30)
    );
    return onSnapshot(q, (snap) => {
      const currentIds = new Set();
      const fresh = [];
      snap.docs.forEach((d) => {
        currentIds.add(d.id);
        if (seenFeedIdsRef.current && !seenFeedIdsRef.current.has(d.id)) {
          fresh.push({ id: d.id, ...d.data() });
        }
      });
      if (seenFeedIdsRef.current === null) {
        seenFeedIdsRef.current = currentIds;
        return;
      }
      seenFeedIdsRef.current = currentIds;
      fresh
        .filter((i) => i.type === 'groupProposal' || i.type === 'groupSuggestion')
        .forEach((i) => {
          const who = i.data?.proposerName || 'Someone';
          const title = i.data?.title || 'a new event';
          const group = i.data?.groupName ? ` (${i.data.groupName})` : '';
          showGlobalMessage(`${who} proposed: "${title}"${group}`);
        });
      if (fresh.length) setUnreadFeedCount((n) => n + fresh.length);
    });
  }, [userId, showGlobalMessage]);

  // Parse `?join={groupId}` once on first load. Stash the group id; we'll
  // surface the join modal as soon as the user is signed in.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const join = params.get('join');
    if (join) {
      setPendingJoinGroupId(join);
      params.delete('join');
      const query = params.toString();
      const newUrl = window.location.pathname + (query ? `?${query}` : '') + window.location.hash;
      window.history.replaceState({}, '', newUrl);
    }
  }, []);

  useEffect(() => {
    // Track the profile snapshot listener so we can detach it on sign-out
    // (or on each auth-state change) — otherwise every token refresh stacked
    // another listener and old listeners kept firing forever.
    let profileUnsub = null;
    const detachProfile = () => {
      if (profileUnsub) {
        profileUnsub();
        profileUnsub = null;
      }
    };

    const unsub = onAuthStateChanged(auth, async (u) => {
      detachProfile();
      if (u) {
        setUserId(u.uid);
        const profileRef = doc(db, `artifacts/${appId}/users/${u.uid}/profiles`, 'myProfile');
        profileUnsub = onSnapshot(profileRef, (s) => {
          if (s.exists()) {
            const existing = s.data();
            setUserProfile(existing);
            // Backfill missing email/isAnonymous for accounts created
            // before we started capturing them. Google-account users have
            // u.email available straight from Firebase Auth.
            const patch = {};
            if (!existing.email && u.email) patch.email = u.email;
            if (typeof existing.isAnonymous !== 'boolean') patch.isAnonymous = !!u.isAnonymous;
            if (Object.keys(patch).length) updateDoc(profileRef, patch).catch(() => {});
          } else {
            const newProfile = {
              name: u.displayName || 'User',
              email: u.email || '',
              isAnonymous: !!u.isAnonymous,
              createdAt: serverTimestamp(),
              photoURL: u.photoURL,
            };
            setDoc(profileRef, newProfile);
            setUserProfile(newProfile);
          }
          setLoading(false);
        });
      } else {
        setUserId(null);
        setUserProfile(null);
        setLoading(false);
      }
    });
    const timer = setTimeout(() => setLoading(false), 3000);
    return () => {
      detachProfile();
      unsub();
      clearTimeout(timer);
    };
  }, []);

  if (loading)
    return (
      <div className="min-h-screen flex items-center justify-center bg-indigo-50">
        <div className="animate-spin w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full"></div>
      </div>
    );

  return (
    <PasscodeGate>
      <AppContext.Provider
        value={{
          userId,
          userProfile,
          setUserProfile,
          showGlobalMessage,
          setShowProfileModal,
          setShowSettingsModal,
          setShowAboutModal,
          getUserNameById,
          googleAccessToken,
          setGoogleAccessToken,
          unreadFeedCount,
          markFeedRead: () => setUnreadFeedCount(0),
          feedRefreshTick,
          triggerFeedRefresh: () => setFeedRefreshTick((t) => t + 1),
        }}
      >
        {!userId ? (
          <AuthScreen />
        ) : (
        <div className="min-h-screen bg-[#F3F4F6] text-gray-900 font-sans p-4 md:p-8 overflow-x-hidden">
          <Header />
          {msg && (
            <div className={`fixed top-6 right-6 px-6 py-3 rounded-xl shadow-2xl text-white font-bold z-[100] animate-fade-in ${msg.type === 'error' ? 'bg-red-500' : 'bg-emerald-500'}`}>
              {msg.text}
            </div>
          )}
          <MainContent />
          {showProfileModal && <ProfileModal onClose={() => setShowProfileModal(false)} />}
          {showSettingsModal && <SettingsModal onClose={() => setShowSettingsModal(false)} />}
          {showAboutModal && <AboutModal onClose={() => setShowAboutModal(false)} />}
          {pendingJoinGroupId && (
            <JoinGroupModal groupId={pendingJoinGroupId} onClose={() => setPendingJoinGroupId(null)} />
          )}
          {needsName && <NameSettingModal onClose={() => setNameSkipped(true)} />}
          {needsLegal && <LegalAcceptanceModal />}
          <FeedbackButton />
        </div>
        )}
      </AppContext.Provider>
    </PasscodeGate>
  );
}
