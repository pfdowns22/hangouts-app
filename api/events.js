// Vercel serverless proxy that aggregates real-world events from multiple
// providers and returns them in a single normalized shape. Provider API keys
// stay server-side (set in Vercel → Settings → Environment Variables); the
// browser only ever talks to this same-origin endpoint, so there's no CORS or
// key-exposure problem.
//
// Adding a new source (e.g. restaurants via Yelp or Google Places) is a matter
// of adding one entry to the PROVIDERS array below + one env var — nothing else
// in the app changes.

// --- shared helpers -------------------------------------------------------

// Map a minimum price (number, USD) to the app's existing tier buckets.
const tierFromPrice = (min) => {
  if (min == null || Number.isNaN(min)) return null;
  if (min <= 0) return 'Free';
  if (min < 20) return '$';
  if (min < 50) return '$$';
  if (min < 100) return '$$$';
  return '$$$$';
};

// Normalize any provider's raw category text into one filterable type from a
// fixed set, so the client's "filter by type" control is consistent across
// sources. Keep this list in sync with EVENT_TYPES on the client.
const normalizeType = (raw) => {
  const s = (raw || '').toString().toLowerCase();
  if (/(music|concert|gig|dj|band|jazz|hip.?hop|festival.*music)/.test(s)) return 'Music';
  if (/(restaurant|food|dining|culinary|brunch|eat|cuisine|tasting)/.test(s)) return 'Food & Drink';
  if (/(bar|nightlife|club|cocktail|brewery|wine|pub|lounge)/.test(s)) return 'Nightlife';
  if (/(outdoor|park|hike|nature|trail|beach|garden|bike|run)/.test(s)) return 'Outdoors';
  if (/(art|museum|theat|performing|culture|comedy|film|gallery|dance|exhibit)/.test(s)) return 'Arts & Culture';
  if (/(sport|game|fitness|yoga|workout|athletic|match)/.test(s)) return 'Sports';
  if (/(market|shopping|flea|bazaar|pop.?up)/.test(s)) return 'Markets';
  if (/(community|fair|expo|parade|festival|meetup|workshop|class)/.test(s)) return 'Community';
  return 'Other';
};

// Places (New) Text Search accepts only a RECTANGLE for locationRestriction
// (a circle is valid for locationBias only). Convert a center + radius (meters)
// to a bounding box so we can hard-restrict results to the local area.
const radiusRectangle = (lat, lng, meters) => {
  const dLat = meters / 111320;
  const dLng = meters / (111320 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  return {
    low: { latitude: lat - dLat, longitude: lng - dLng },
    high: { latitude: lat + dLat, longitude: lng + dLng },
  };
};

// Combine a YYYY-MM-DD date and optional HH:MM:SS time into the app's
// "YYYY-MM-DD HH:MM" event-date string. Falls back to noon when time is absent.
const toEventDate = (date, time) => {
  if (!date) return null;
  const hhmm = time ? time.slice(0, 5) : '12:00';
  return `${date} ${hhmm}`;
};

// Forward-geocode a free-text location to { lat, lng } using OpenStreetMap's
// keyless Nominatim service. Cached per warm lambda instance. Nominatim
// requires a descriptive User-Agent and is rate-limited (~1 req/s), which is
// fine at our scale because results are cached.
const geocodeCache = new Map();
const geocode = async (location) => {
  const key = location.trim().toLowerCase();
  if (geocodeCache.has(key)) return geocodeCache.get(key);
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1`;
    const res = await fetch(url, { headers: { 'User-Agent': 'hangouts-app/1.0 (event discovery)' } });
    const arr = await res.json().catch(() => []);
    const hit = Array.isArray(arr) ? arr[0] : null;
    const coords = hit ? { lat: parseFloat(hit.lat), lng: parseFloat(hit.lon) } : null;
    // Only cache successful lookups, so a transient failure can be retried.
    if (coords) geocodeCache.set(key, coords);
    return coords;
  } catch {
    return null;
  }
};

// --- providers ------------------------------------------------------------
// Each provider exposes { id, enabled, fetch(params) -> normalized[] }. Only
// enabled providers (those whose key env var is present) are queried.

const ticketmaster = {
  id: 'ticketmaster',
  get enabled() {
    return !!process.env.TICKETMASTER_API_KEY;
  },
  async fetch({ lat, lng, radius, startDate, endDate, keywords, size }) {
    const params = new URLSearchParams({
      apikey: process.env.TICKETMASTER_API_KEY,
      latlong: `${lat},${lng}`,
      radius: String(Math.round(radius)),
      unit: 'miles',
      startDateTime: `${startDate}T00:00:00Z`,
      endDateTime: `${endDate}T23:59:59Z`,
      size: String(size),
      sort: 'date,asc',
    });
    if (keywords) params.set('keyword', keywords);
    const res = await fetch(`https://app.ticketmaster.com/discovery/v2/events.json?${params}`);
    if (!res.ok) throw new Error(`ticketmaster ${res.status}`);
    const data = await res.json();
    const events = data?._embedded?.events || [];
    return events.map((e) => {
      const venue = e?._embedded?.venues?.[0];
      const img = (e.images || [])
        .filter((i) => i.ratio === '16_9')
        .sort((a, b) => (b.width || 0) - (a.width || 0))[0] || (e.images || [])[0];
      const price = e.priceRanges?.[0]?.min;
      return {
        source: 'ticketmaster',
        title: e.name,
        description: e.info || e.pleaseNote || '',
        location: venue ? [venue.name, venue.city?.name].filter(Boolean).join(', ') : '',
        date: toEventDate(e.dates?.start?.localDate, e.dates?.start?.localTime),
        url: e.url || null,
        imageUrl: img?.url || null,
        imageKeywords: [e.classifications?.[0]?.segment?.name, e.classifications?.[0]?.genre?.name].filter(Boolean).join(' '),
        priceTier: tierFromPrice(price),
        isTicketed: true,
        ticketsUrl: e.url || null,
        lat: venue?.location ? parseFloat(venue.location.latitude) : null,
        lng: venue?.location ? parseFloat(venue.location.longitude) : null,
        category: e.classifications?.[0]?.segment?.name || null,
        type: normalizeType(e.classifications?.[0]?.segment?.name),
      };
    });
  },
};

const seatgeek = {
  id: 'seatgeek',
  get enabled() {
    return !!process.env.SEATGEEK_CLIENT_ID;
  },
  async fetch({ lat, lng, radius, startDate, endDate, keywords, size }) {
    const params = new URLSearchParams({
      client_id: process.env.SEATGEEK_CLIENT_ID,
      lat: String(lat),
      lon: String(lng),
      range: `${Math.round(radius)}mi`,
      'datetime_local.gte': startDate,
      'datetime_local.lte': endDate,
      per_page: String(size),
      sort: 'datetime_local.asc',
    });
    if (process.env.SEATGEEK_CLIENT_SECRET) params.set('client_secret', process.env.SEATGEEK_CLIENT_SECRET);
    if (keywords) params.set('q', keywords);
    const res = await fetch(`https://api.seatgeek.com/2/events?${params}`);
    if (!res.ok) throw new Error(`seatgeek ${res.status}`);
    const data = await res.json();
    return (data?.events || []).map((e) => {
      const [d, t] = (e.datetime_local || '').split('T');
      const st = e.stats || {};
      return {
        source: 'seatgeek',
        title: e.title,
        description: e.description || '',
        location: e.venue ? [e.venue.name, e.venue.city].filter(Boolean).join(', ') : '',
        date: toEventDate(d, t),
        url: e.url || null,
        imageUrl: e.performers?.[0]?.image || null,
        imageKeywords: [e.type, e.performers?.[0]?.name].filter(Boolean).join(' '),
        priceTier: tierFromPrice(st.lowest_price),
        isTicketed: true,
        ticketsUrl: e.url || null,
        // Resale price stats — the client shows "from $NN" + a derived deal
        // badge from these. SeatGeek exposes these aggregates (not their
        // consumer "Deal Score"), so the deal tier is computed client-side.
        lowestPrice: st.lowest_price ?? null,
        avgPrice: st.average_price ?? null,
        medianPrice: st.median_price ?? null,
        listingCount: st.visible_listing_count ?? st.listing_count ?? null,
        lat: e.venue?.location?.lat ?? null,
        lng: e.venue?.location?.lon ?? null,
        category: e.type || null,
        type: normalizeType(e.type),
      };
    });
  },
};

const predicthq = {
  id: 'predicthq',
  get enabled() {
    return !!process.env.PREDICTHQ_TOKEN;
  },
  async fetch({ lat, lng, radius, startDate, endDate, keywords, size }) {
    const params = new URLSearchParams({
      within: `${Math.round(radius)}mi@${lat},${lng}`,
      'active.gte': startDate,
      'active.lte': endDate,
      // Restrict to social/leisure categories — PredictHQ otherwise returns a
      // lot of noise (academic terms, public holidays, observances, weather).
      category: 'concerts,festivals,performing-arts,sports,community,expos',
      limit: String(size),
      sort: 'rank', // most notable first, before the global date sort/slice
    });
    if (keywords) params.set('q', keywords);
    const res = await fetch(`https://api.predicthq.com/v1/events/?${params}`, {
      headers: { Authorization: `Bearer ${process.env.PREDICTHQ_TOKEN}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`predicthq ${res.status}`);
    const data = await res.json();
    return (data?.results || []).map((e) => {
      const start = e.start || '';
      const [d, t] = start.includes('T') ? [start.slice(0, 10), start.slice(11, 16)] : [start, ''];
      return {
        source: 'predicthq',
        title: e.title,
        description: e.description || '',
        location: e.entities?.find((x) => x.type === 'venue')?.name || '',
        date: toEventDate(d, t),
        url: null,
        imageUrl: null,
        imageKeywords: [e.category, e.labels?.[0]].filter(Boolean).join(' '),
        priceTier: null,
        isTicketed: ['concerts', 'sports', 'performing-arts', 'expos'].includes(e.category),
        ticketsUrl: null,
        lat: Array.isArray(e.location) ? e.location[1] : null,
        lng: Array.isArray(e.location) ? e.location[0] : null,
        category: e.category || null,
        type: normalizeType(e.category),
      };
    });
  },
};

// NYC Open Data permitted events (keyless Socrata API) — street fairs,
// festivals, plaza/park events, parades. NYC-only, so it no-ops unless the
// client passes a NYC borough. Film/TV production permits are filtered out.
const nycEvents = {
  id: 'nyc',
  get enabled() {
    return true; // keyless; returns [] without a borough (i.e. non-NYC users)
  },
  async fetch({ borough, startDate, endDate, size }) {
    if (!borough) return [];
    const where = `start_date_time >= '${startDate}T00:00:00' AND start_date_time <= '${endDate}T23:59:59' AND event_borough = '${borough}'`;
    const params = new URLSearchParams({ $where: where, $order: 'start_date_time', $limit: String(Math.min(size * 2, 50)) });
    const res = await fetch(`https://data.cityofnewyork.us/resource/tvpp-9vvx.json?${params}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`nyc ${res.status}`);
    const rows = await res.json();
    return rows
      .filter((r) => r.event_name && r.event_type && !/production/i.test(r.event_type)) // drop film/TV permits
      .map((r) => {
        const start = r.start_date_time || '';
        const [d, t] = start.includes('T') ? [start.slice(0, 10), start.slice(11, 16)] : [start, ''];
        return {
          source: 'nyc',
          title: r.event_name,
          description: [r.event_type, r.event_agency].filter(Boolean).join(' · '),
          location: (r.event_location || '').split(',')[0].trim() || borough,
          date: toEventDate(d, t),
          url: null,
          imageUrl: null,
          imageKeywords: [r.event_type, borough].filter(Boolean).join(' '),
          priceTier: null,
          isTicketed: false,
          ticketsUrl: null,
          lat: null,
          lng: null,
          category: r.event_type || null,
          type: normalizeType(r.event_type),
        };
      });
  },
};

// PredictHQ is intentionally excluded: the trial expired (no free tier) and its
// events carry no ticket/buy links — Ticketmaster + SeatGeek + AI search + NYC
// Open Data cover discovery. The `predicthq` provider def is kept below for easy
// re-enable if a paid plan is ever added (drop it back into this array).
const PROVIDERS = [ticketmaster, seatgeek, nycEvents];

// Google Places (New) is the PLACES source — restaurants/bars/activities, not
// dated events. Queried via ?kind=places and pinned to a user's free slot
// client-side. Returns only well-reviewed spots. Uses Text Search; no photos
// (those need a key-bearing media URL) — the client's image fallback covers it.
const PRICE_LEVEL_TIER = {
  PRICE_LEVEL_FREE: 'Free',
  PRICE_LEVEL_INEXPENSIVE: '$',
  PRICE_LEVEL_MODERATE: '$$',
  PRICE_LEVEL_EXPENSIVE: '$$$',
  PRICE_LEVEL_VERY_EXPENSIVE: '$$$$',
};
const googlePlaces = {
  id: 'google',
  get enabled() {
    return !!process.env.GOOGLE_PLACES_KEY;
  },
  async fetch({ lat, lng, radius, term, size }) {
    const body = {
      textQuery: `${term || 'popular'} restaurants and bars`,
      maxResultCount: Math.min(size * 3, 20),
      // Hard restriction (not bias) so results stay strictly within the radius —
      // a soft bias let a Park Slope query return New Jersey. Text Search needs
      // a rectangle here (circle is bias-only).
      locationRestriction: { rectangle: radiusRectangle(lat, lng, Math.min(Math.round(radius * 1609), 50000)) },
    };
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': process.env.GOOGLE_PLACES_KEY,
        'X-Goog-FieldMask':
          'places.displayName,places.rating,places.userRatingCount,places.priceLevel,places.formattedAddress,places.googleMapsUri,places.location,places.primaryTypeDisplayName',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`google ${res.status}`);
    const data = await res.json();
    return (data?.places || [])
      .filter((p) => (p.rating || 0) >= 4.0 && (p.userRatingCount || 0) >= 25)
      .map((p) => ({
        source: 'google',
        title: p.displayName?.text || 'Place',
        description: `${p.rating}★ (${p.userRatingCount} reviews)${p.primaryTypeDisplayName?.text ? ' · ' + p.primaryTypeDisplayName.text : ''}`,
        location: p.formattedAddress || '',
        date: null, // not dated — the client pins it to one of the user's free slots
        url: p.googleMapsUri || null, // real Google Maps listing (hours/photos/reviews/map)
        imageUrl: null,
        imageKeywords: [p.primaryTypeDisplayName?.text, p.displayName?.text].filter(Boolean).join(' '),
        priceTier: PRICE_LEVEL_TIER[p.priceLevel] || null,
        isTicketed: false,
        ticketsUrl: null,
        lat: p.location?.latitude ?? null,
        lng: p.location?.longitude ?? null,
        category: p.primaryTypeDisplayName?.text || 'place',
        type: normalizeType(p.primaryTypeDisplayName?.text || 'restaurant'),
        rating: p.rating ?? null,
        reviewCount: p.userRatingCount ?? null,
      }));
  },
};

// Verify a single venue by name within a hard radius (Places Text Search). Used
// to confirm an AI-suggested food/drink spot is real & nearby, and to attach a
// real Maps link + rating. Returns { found:false } when nothing matches inside
// the radius.
const googleVerify = async ({ name, lat, lng, radius }) => {
  const body = {
    textQuery: name,
    maxResultCount: 1,
    locationRestriction: { rectangle: radiusRectangle(lat, lng, Math.min(Math.round(radius * 1609), 50000)) },
  };
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': process.env.GOOGLE_PLACES_KEY,
      'X-Goog-FieldMask': 'places.displayName,places.rating,places.priceLevel,places.formattedAddress,places.googleMapsUri,places.location',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`google ${res.status}`);
  const p = ((await res.json()).places || [])[0];
  if (!p) return { found: false };
  return {
    found: true,
    url: p.googleMapsUri || null,
    rating: p.rating ?? null,
    priceTier: PRICE_LEVEL_TIER[p.priceLevel] || null,
    address: p.formattedAddress || null,
    lat: p.location?.latitude ?? null,
    lng: p.location?.longitude ?? null,
  };
};

// Collapse near-duplicates that surface from more than one provider: same
// (lowercased) title on the same calendar day.
const dedupe = (events) => {
  const seen = new Map();
  for (const ev of events) {
    if (!ev?.title || !ev?.date) continue;
    const key = `${ev.title.trim().toLowerCase()}|${ev.date.slice(0, 10)}`;
    if (!seen.has(key)) seen.set(key, ev);
  }
  return [...seen.values()];
};

// --- Ticket-link resolver -------------------------------------------------
// Match an AI-found event against the ticketing APIs to recover its REAL
// purchase URL. Only returns a link on a CONFIDENT match (strong title overlap
// + near date) so we never swap in a wrong direct link — a miss returns
// { url: null } and the client uses its web-search fallback instead.
const TL_STOP = new Set(['the', 'and', 'for', 'with', 'party', 'event', 'festival', 'live', 'show', 'tour', 'nyc', 'new', 'york', 'presents', 'feat', 'featuring', 'at', 'of', 'in', 'on']);
const tlTokens = (s) => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !TL_STOP.has(w));
const tlOverlap = (query, cand) => {
  const A = new Set(tlTokens(query));
  const B = tlTokens(cand);
  if (!A.size || !B.length) return 0;
  return B.filter((w) => A.has(w)).length / A.size;
};
const tlDayDiff = (a, b) => {
  try { return Math.abs((new Date(a) - new Date(b)) / 86400000); } catch { return 999; }
};
// Minimum title overlap to even consider a candidate. Date is NOT a hard gate
// (recurring acts and AI's approximate dates routinely miss an exact window) —
// it's a scoring boost below, so a confident title match still resolves even
// when the date is off. Geographic proximity is likewise a boost, not a filter.
const TL_OVERLAP_FLOOR = 0.5;
// Haversine miles between two lat/lng pairs (NaN-safe → null).
const tlMiles = (aLat, aLng, bLat, bLng) => {
  const ok = [aLat, aLng, bLat, bLng].every((n) => typeof n === 'number' && !Number.isNaN(n));
  if (!ok) return null;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 3959 * 2 * Math.asin(Math.min(1, Math.sqrt(s)));
};
// Combined confidence: title overlap, minus a capped date penalty, plus a geo
// bonus when the candidate is near the target (and a penalty when it's clearly
// in another region). Higher = better; used to pick the single best candidate.
const tlScore = ({ overlap, dayDiff, miles }) => {
  let s = overlap;
  if (dayDiff != null) s -= Math.min(dayDiff, 60) * 0.004; // ≤0.24 over 60d
  if (miles != null) s += miles <= 75 ? 0.25 : miles >= 250 ? -0.4 : 0;
  return s;
};

const findTicketLink = async ({ title, lat, lng, date }) => {
  if (!title) return { url: null };
  const targetDate = date ? String(date).slice(0, 10) : null;
  const hasGeo = lat != null && lng != null && !Number.isNaN(lat) && !Number.isNaN(lng);
  const candidates = [];

  // Ticketmaster Discovery
  if (process.env.TICKETMASTER_API_KEY) {
    try {
      const p = new URLSearchParams({ apikey: process.env.TICKETMASTER_API_KEY, keyword: title.slice(0, 90), size: '20', sort: 'relevance,desc' });
      if (hasGeo) { p.set('latlong', `${lat},${lng}`); p.set('radius', '75'); p.set('unit', 'miles'); }
      const r = await fetch(`https://app.ticketmaster.com/discovery/v2/events.json?${p}`);
      if (r.ok) {
        for (const e of ((await r.json())?._embedded?.events || [])) {
          const ov = tlOverlap(title, e.name);
          if (ov < TL_OVERLAP_FLOOR || !e.url) continue;
          const ed = e.dates?.start?.localDate;
          const v = e._embedded?.venues?.[0]?.location;
          const miles = hasGeo && v ? tlMiles(lat, lng, parseFloat(v.latitude), parseFloat(v.longitude)) : null;
          candidates.push({ url: e.url, source: 'ticketmaster', overlap: ov, dayDiff: targetDate && ed ? tlDayDiff(targetDate, ed) : null, miles });
        }
      }
    } catch { /* fall through to SeatGeek */ }
  }

  // SeatGeek (only if a client id is configured)
  if (process.env.SEATGEEK_CLIENT_ID) {
    try {
      const p = new URLSearchParams({ client_id: process.env.SEATGEEK_CLIENT_ID, q: title.slice(0, 90), per_page: '20' });
      if (process.env.SEATGEEK_CLIENT_SECRET) p.set('client_secret', process.env.SEATGEEK_CLIENT_SECRET);
      if (hasGeo) { p.set('lat', String(lat)); p.set('lon', String(lng)); p.set('range', '75mi'); }
      const r = await fetch(`https://api.seatgeek.com/2/events?${p}`);
      if (r.ok) {
        for (const e of ((await r.json())?.events || [])) {
          const ov = tlOverlap(title, e.title);
          if (ov < TL_OVERLAP_FLOOR || !e.url) continue;
          const ed = (e.datetime_local || '').slice(0, 10);
          const v = e.venue?.location;
          const miles = hasGeo && v ? tlMiles(lat, lng, v.lat, v.lon) : null;
          candidates.push({ url: e.url, source: 'seatgeek', overlap: ov, dayDiff: targetDate && ed ? tlDayDiff(targetDate, ed) : null, miles });
        }
      }
    } catch { /* fall through to null */ }
  }

  if (!candidates.length) return { url: null };
  let best = null, bestScore = -Infinity;
  for (const c of candidates) {
    const s = tlScore(c);
    if (s > bestScore) { best = c; bestScore = s; }
  }
  return best ? { url: best.url, source: best.source } : { url: null };
};

export default async function handler(req, res) {
  const q = req.query || {};
  const size = Math.min(parseInt(q.size, 10) || 12, 50);
  const radius = parseFloat(q.radius) || 25;
  const keywords = (q.keywords || '').toString().slice(0, 120);

  // Resolve coordinates: explicit lat/lng wins, else geocode the location text.
  let lat = q.lat != null ? parseFloat(q.lat) : null;
  let lng = q.lng != null ? parseFloat(q.lng) : null;
  if ((lat == null || Number.isNaN(lat)) && q.location) {
    const c = await geocode(q.location.toString());
    if (c) {
      lat = c.lat;
      lng = c.lng;
    }
  }

  // Verify mode: confirm a single venue is real & within the radius (and enrich
  // it). `verified:false` means we couldn't check (no key/location) → caller
  // should keep the item; `verified:true, found:false` means it checked and the
  // venue isn't local → caller should drop it.
  if ((q.kind || '').toString() === 'verify') {
    const canVerify = googlePlaces.enabled && lat != null && !Number.isNaN(lat) && !!q.name;
    if (!canVerify) {
      res.status(200).json({ verified: false, found: false });
      return;
    }
    try {
      const r = await googleVerify({ name: q.name.toString().slice(0, 120), lat, lng, radius });
      res.status(200).json({ verified: true, ...r });
    } catch (e) {
      res.status(200).json({ verified: false, found: false, error: e.message });
    }
    return;
  }

  // Meta mode: fetch a page's og:image and confirm the URL is alive, so the
  // client can upgrade AI-event cards with the event's real photo. Public
  // http(s) pages only; small read window + timeout; edge-cached. Returns
  // { alive, image } and never throws.
  if ((q.kind || '').toString() === 'meta') {
    const target = (q.url || '').toString().slice(0, 2000);
    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      res.status(200).json({ alive: false, image: null });
      return;
    }
    const host = parsed.hostname;
    // Only public http(s) hosts — no localhost/intranet probing via the proxy.
    const isPrivateHost =
      !/^https?:$/.test(parsed.protocol) ||
      !host.includes('.') ||
      /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host);
    if (isPrivateHost) {
      res.status(200).json({ alive: false, image: null });
      return;
    }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const page = await fetch(parsed.href, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; hangouts-app/1.0; +event preview)', Accept: 'text/html' },
      });
      clearTimeout(timer);
      if (!page.ok) {
        res.status(200).json({ alive: false, image: null });
        return;
      }
      // Read only the head-ish part of the document — og tags live early.
      const reader = page.body?.getReader?.();
      let html = '';
      if (reader) {
        const decoder = new TextDecoder();
        while (html.length < 60000) {
          const { done, value } = await reader.read();
          if (done) break;
          html += decoder.decode(value, { stream: true });
        }
        reader.cancel().catch(() => {});
      } else {
        html = (await page.text()).slice(0, 60000);
      }
      const m =
        html.match(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i) ||
        html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i) ||
        html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
      let image = m ? m[1] : null;
      if (image && image.startsWith('/')) image = `${parsed.origin}${image}`;
      if (image && !/^https?:\/\//.test(image)) image = null;
      res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
      res.status(200).json({ alive: true, image });
    } catch {
      res.status(200).json({ alive: false, image: null });
    }
    return;
  }

  // Ticket-link mode: resolve an AI event's real purchase URL via the ticketing
  // APIs. Returns { url, source } on a confident match, else { url: null } so the
  // client uses its web-search fallback. Never throws.
  if ((q.kind || '').toString() === 'ticketlink') {
    try {
      const r = await findTicketLink({ title: (q.title || q.name || '').toString().slice(0, 120), lat, lng, date: q.date });
      res.status(200).json(r);
    } catch (e) {
      res.status(200).json({ url: null, error: e.message });
    }
    return;
  }

  // Places mode (Google Places): restaurants/bars/activities, not dated events.
  if ((q.kind || '').toString() === 'places') {
    if (lat == null || Number.isNaN(lat) || !googlePlaces.enabled) {
      res.status(200).json({
        events: [],
        sources: {},
        errors: !googlePlaces.enabled ? ['places API not configured'] : ['could not resolve location'],
      });
      return;
    }
    try {
      const term = (q.term || '').toString().slice(0, 120);
      const places = (await googlePlaces.fetch({ lat, lng, radius, term, size }))
        .sort((a, b) => (b.rating || 0) - (a.rating || 0))
        .slice(0, size);
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
      res.status(200).json({ events: places, sources: { google: places.length }, errors: [] });
    } catch (e) {
      res.status(200).json({ events: [], sources: { google: 0 }, errors: [`google: ${e.message}`] });
    }
    return;
  }

  // Date window (YYYY-MM-DD). Default: today → +30 days.
  const today = new Date().toISOString().slice(0, 10);
  const startDate = (q.startDate || today).toString().slice(0, 10);
  const endDate = (q.endDate || new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10)).toString().slice(0, 10);

  const enabled = PROVIDERS.filter((p) => p.enabled);

  // No coordinates and no provider can run → nothing to do. The client treats
  // an empty list as "fall back to AI search", so this is a soft outcome.
  if (lat == null || Number.isNaN(lat) || enabled.length === 0) {
    res.status(200).json({
      events: [],
      sources: {},
      errors: enabled.length === 0 ? ['no providers configured'] : ['could not resolve location'],
    });
    return;
  }

  const borough = (q.borough || '').toString().slice(0, 20);
  const params = { lat, lng, radius, startDate, endDate, keywords, size, borough };
  const settled = await Promise.allSettled(enabled.map((p) => p.fetch(params)));

  const sources = {};
  const errors = [];
  let all = [];
  settled.forEach((r, i) => {
    const id = enabled[i].id;
    if (r.status === 'fulfilled') {
      const list = (r.value || []).filter((e) => e.title && e.date);
      sources[id] = list.length;
      all = all.concat(list);
    } else {
      sources[id] = 0;
      errors.push(`${id}: ${r.reason?.message || 'error'}`);
    }
  });

  // Group by source, sort each by date, then round-robin so no single source
  // (e.g. the high-volume keyless NYC feed) dominates the slice.
  const bySource = {};
  for (const ev of dedupe(all)) (bySource[ev.source] ||= []).push(ev);
  Object.values(bySource).forEach((list) => list.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()));
  const order = Object.keys(bySource);
  const events = [];
  let ri = 0;
  while (events.length < size && order.some((s) => bySource[s].length)) {
    const list = bySource[order[ri % order.length]];
    if (list.length) events.push(list.shift());
    ri += 1;
  }

  // Short edge cache: identical nearby queries within a few minutes reuse the
  // result, easing provider quotas under a burst of testers.
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  res.status(200).json({ events, sources, errors });
}
