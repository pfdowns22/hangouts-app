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
      return {
        source: 'seatgeek',
        title: e.title,
        description: e.description || '',
        location: e.venue ? [e.venue.name, e.venue.city].filter(Boolean).join(', ') : '',
        date: toEventDate(d, t),
        url: e.url || null,
        imageUrl: e.performers?.[0]?.image || null,
        imageKeywords: [e.type, e.performers?.[0]?.name].filter(Boolean).join(' '),
        priceTier: tierFromPrice(e.stats?.lowest_price),
        isTicketed: true,
        ticketsUrl: e.url || null,
        lat: e.venue?.location?.lat ?? null,
        lng: e.venue?.location?.lon ?? null,
        category: e.type || null,
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
      };
    });
  },
};

const PROVIDERS = [ticketmaster, seatgeek, predicthq];

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

  const params = { lat, lng, radius, startDate, endDate, keywords, size };
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

  const events = dedupe(all)
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    .slice(0, size);

  // Short edge cache: identical nearby queries within a few minutes reuse the
  // result, easing provider quotas under a burst of testers.
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  res.status(200).json({ events, sources, errors });
}
