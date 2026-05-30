// Client-side wrapper around the /api/events serverless proxy. Returns a
// normalized event array, or [] on any failure — it never throws, so a proxy
// hiccup never blocks the always-on Gemini AI-search source that runs in
// parallel with it.

export const fetchRealEvents = async ({ lat, lng, location, startDate, endDate, radius, keywords, size } = {}) => {
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

    const res = await fetch(`/api/events?${params.toString()}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    return Array.isArray(data?.events) ? data.events : [];
  } catch {
    return [];
  }
};

// Fetch highly-rated PLACES (restaurants/bars/activities) from Yelp via the
// proxy's ?kind=places mode. Returns [] on any failure (never throws).
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
