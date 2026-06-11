// Ride quote/booking scaffold for the Uber Guest Rides / Lyft partner APIs.
//
// INERT BY DEFAULT: returns { available: false } until a partner is configured,
// so the client silently falls back to the affiliate ride deep-link. Uber and
// Lyft both CLOSED their public ride/estimate APIs to general developers — live
// fares and booking now require approval into a partner/business program:
//   • Uber:  Uber for Business / "Guest Rides" API  → https://developer.uber.com
//   • Lyft:  Lyft partner program (no open self-serve API)
// Once approved you get server credentials; set them in Vercel (see .env.example)
// and fill in the TODO sections below with the real estimate/booking calls.
//
// Request  (POST): { dropoff: { address?, lat?, lng? }, pickup?: { lat?, lng? } }
// Response (200):  { available: false, reason } when not wired, OR when live:
//   { available: true, provider, low, high, currency, etaMinutes, deeplink }

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }
  const { dropoff } = req.body || {};
  if (!dropoff || (!dropoff.address && (dropoff.lat == null || dropoff.lng == null))) {
    res.status(400).json({ error: 'dropoff (address or lat/lng) required' });
    return;
  }

  // Choose the partner from env. Explicit RIDE_PROVIDER wins; otherwise infer
  // from whichever credentials are present. None set → stay inert.
  const provider =
    process.env.RIDE_PROVIDER ||
    (process.env.UBER_SERVER_TOKEN || process.env.UBER_CLIENT_ID ? 'uber' : process.env.LYFT_CLIENT_ID ? 'lyft' : null);
  if (!provider) {
    res.status(200).json({ available: false, reason: 'no ride partner configured' });
    return;
  }

  try {
    if (provider === 'uber') {
      // TODO(uber-guest-rides): with Guest Rides access —
      //   1. OAuth client-credentials grant (UBER_CLIENT_ID/SECRET) → bearer token.
      //   2. POST the pickup/dropoff to the Guest Rides fare-estimate endpoint.
      //   3. Map the response into the shape below and return available:true.
      res.status(200).json({ available: false, reason: 'uber partner scaffold not wired' });
      return;
    }
    if (provider === 'lyft') {
      // TODO(lyft-partner): call the partner cost-estimate endpoint with
      // LYFT_CLIENT_ID/SECRET and map the response into the shape below.
      res.status(200).json({ available: false, reason: 'lyft partner scaffold not wired' });
      return;
    }
    res.status(200).json({ available: false, reason: `unknown provider ${provider}` });
  } catch (e) {
    // Never block the UI — the client falls back to the deep-link on null.
    console.error('ride-quote error:', e);
    res.status(200).json({ available: false, reason: 'error' });
  }
}
