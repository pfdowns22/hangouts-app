// Client-side wrapper around the /api/events serverless proxy. Returns a
// normalized event array, or [] on any failure — it never throws, so a proxy
// hiccup never blocks the always-on Gemini AI-search source that runs in
// parallel with it.

export const fetchRealEvents = async ({ lat, lng, location, startDate, endDate, radius, keywords, size, borough } = {}) => {
  try {
    const params = new URLSearchParams();
    if (lat != null && lng != null) {
      params.set('lat', String(lat));
      params.set('lng', String(lng));
    }
    if (location) params.set('location', location);
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);
    if (radius) params.set('radius', String(radius));
    if (keywords) params.set('keywords', keywords);
    if (size) params.set('size', String(size));
    if (borough) params.set('borough', borough);

    const res = await fetch(`/api/events?${params.toString()}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    return Array.isArray(data?.events) ? data.events : [];
  } catch {
    return [];
  }
};

// Fetch highly-rated PLACES (restaurants/bars/activities) from Google Places
// via the proxy's ?kind=places mode. Returns [] on any failure (never throws).
export const fetchPlaces = async ({ lat, lng, location, radius, term, categories, size } = {}) => {
  try {
    const params = new URLSearchParams({ kind: 'places' });
    if (lat != null && lng != null) {
      params.set('lat', String(lat));
      params.set('lng', String(lng));
    }
    if (location) params.set('location', location);
    if (radius) params.set('radius', String(radius));
    if (term) params.set('term', term);
    if (categories) params.set('categories', categories);
    if (size) params.set('size', String(size));

    const res = await fetch(`/api/events?${params.toString()}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    return Array.isArray(data?.events) ? data.events : [];
  } catch {
    return [];
  }
};

// Resolve an event's REAL ticket-purchase URL via the ticketing APIs
// (Ticketmaster Discovery + SeatGeek). Returns { url, source } only on a
// confident match, else null so the caller keeps its web-search fallback.
// Never throws.
export const resolveTicketLink = async ({ title, location, date } = {}) => {
  try {
    if (!title) return null;
    const params = new URLSearchParams({ kind: 'ticketlink', title });
    if (location) params.set('location', location);
    if (date) params.set('date', String(date).slice(0, 10));
    const res = await fetch(`/api/events?${params.toString()}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return data && data.url ? data : null;
  } catch {
    return null;
  }
};

// Fetch a live ride quote from the partner scaffold (/api/ride-quote → Uber
// Guest Rides / Lyft partner). Returns null unless a partner is configured AND
// returns a usable quote, so callers fall back to the affiliate deep-link.
// Never throws.
export const fetchRideQuote = async ({ address, lat, lng } = {}) => {
  try {
    const res = await fetch('/api/ride-quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dropoff: { address, lat, lng } }),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return data && data.available ? data : null;
  } catch {
    return null;
  }
};

// Verify a single venue is real & within radius (Google Places). Returns the
// proxy's { verified, found, url, rating, priceTier, address } shape. On any
// failure returns { verified: false } so callers keep the item rather than drop it.
export const verifyVenue = async ({ name, lat, lng, location, radius } = {}) => {
  try {
    const params = new URLSearchParams({ kind: 'verify', name: name || '' });
    if (lat != null && lng != null) {
      params.set('lat', String(lat));
      params.set('lng', String(lng));
    }
    if (location) params.set('location', location);
    if (radius) params.set('radius', String(radius));
    const res = await fetch(`/api/events?${params.toString()}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) return { verified: false, found: false };
    return (await res.json().catch(() => ({ verified: false, found: false }))) || { verified: false, found: false };
  } catch {
    return { verified: false, found: false };
  }
};
