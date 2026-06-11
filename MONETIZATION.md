# Monetization — Go-Live Guide

How to turn each revenue lever from "built" into "earning." The honest summary:
**the code is done; what's left is business signups only you can complete.** No
model or code change can bypass partner approval or affiliate enrollment.

All env vars below are set in **Vercel → Project → Settings → Environment
Variables**, then **redeploy**. `VITE_`-prefixed vars are bundled into the
client (not secret); the rest are server-only.

## Status at a glance

| Lever | State | What unlocks it | Effort |
|---|---|---|---|
| **Sponsored marketplace (Stripe)** | ✅ Real money once Stripe keys + webhook are set | §1 below | ~30 min |
| **Affiliate % (tickets/experiences/reservations/rides)** | ⚙️ Code-ready, $0 until enrolled | Enroll per program, paste IDs (§2) | per-program signups |
| **Ride deep-link affiliate** | ✅ Live (opens Uber w/ destination) | Uber/Lyft affiliate id (§2, §3) | small |
| **Ride live quotes + in-app booking** | ⛔ Partner-gated; scaffold ready | Uber/Lyft *partner* approval (§3) | large + approval |

---

## 1. Sponsored marketplace (Stripe) — the one lever that's real money today

**Flow:** a sponsor visits `/sponsor`, fills the form, pays via Stripe Checkout
→ `api/stripe-webhook.js` writes an active placement → it appears at the top of
matching feeds. Money lands in **your** Stripe account. Prices are set in code
(`api/sponsor-checkout.js`): **$29 / 7 days**, **$79 / 30 days** — edit `PACKAGES`
there to change.

### Setup
1. **Create a Stripe account** → https://dashboard.stripe.com . Complete business
   activation (bank details) so you can accept live payments.
2. **API key:** Developers → API keys → copy the **Secret key** (`sk_live_…`, or
   `sk_test_…` while testing) → set **`STRIPE_SECRET_KEY`**.
3. **Webhook:** Developers → Webhooks → **Add endpoint**:
   - URL: `https://<your-deploy>/api/stripe-webhook`
   - Event: **`checkout.session.completed`**
   - After creating, click the endpoint → **Signing secret** (`whsec_…`) → set
     **`STRIPE_WEBHOOK_SECRET`**.
4. **Firebase Admin (so the webhook can write the placement):** Firebase Console
   → Project settings → **Service accounts** → **Generate new private key** →
   download the JSON. Paste the **entire JSON as one line** into
   **`FIREBASE_SERVICE_ACCOUNT`** (it's `JSON.parse`d in `api/_admin.js`).
5. *(Optional)* **`RESEND_API_KEY` / `RESEND_FROM`** — only for proposal emails,
   not the sponsor flow. Skip unless you want those.
6. **Redeploy.**

### Test it end-to-end
1. With **test** keys, open `/sponsor`, fill title + sponsor name, pick a package,
   pay with Stripe's test card `4242 4242 4242 4242` (any future expiry/CVC).
2. You should be redirected to `/sponsor?status=success`.
3. In the app feed, a **Sponsored** card should appear at the top (within its
   active window; if you set a borough, only for users in that borough).
4. Stripe Dashboard → Webhooks → your endpoint shows a **200** for the event.
5. `/owner` → **Sponsored marketplace** shows the revenue, impressions, CTR.
6. Switch to **live** keys for real sales.

**Hardened recently:** borough targeting now actually filters (field was
mismatched), and the webhook is **idempotent** (Stripe retries won't create
duplicate placements or reset counters).

---

## 2. Affiliate — % of what users already buy (code-ready; enroll to earn)

Outbound partner links are auto-wrapped by `affiliateUrl()` once you set the
matching `VITE_AFFILIATE_*`. **Empty = inert** (normal link, $0). You earn after
you (a) enroll in the program, (b) paste the id, (c) a user clicks and converts,
(d) the network pays out on their schedule.

### How the value is formatted (`wrapAffiliate`)
Each `VITE_AFFILIATE_*` accepts **either**:
- a **deep-link template** containing `{url}` — the network's click-tracking URL
  with your destination slotted in. Example (Partnerize/Impact style):
  `https://prf.hn/click/camref:1011XXXX/destination:{url}`
- **or** a **`key=value`** query param the program tells you to append, e.g.
  `irclickid=YOURSUBID` or `siteID=YOURID`.

Most networks (Impact, Partnerize, CJ, AWIN) give you the **deep-link template**
form — use `{url}` where their docs show the destination/`murl`/`url` slot.

### Program → env var map
Brands move between networks over time, so search the brand inside each network's
marketplace. Best-known homes below:

| Env var | Brands (host match) | Where to enroll |
|---|---|---|
| `VITE_AFFILIATE_TICKETMASTER` | Ticketmaster, Live Nation | **Impact** (impact.com) |
| `VITE_AFFILIATE_SEATGEEK` | SeatGeek | **Impact** / SeatGeek Affiliate |
| `VITE_AFFILIATE_STUBHUB` | StubHub | **Impact** / Partnerize |
| `VITE_AFFILIATE_VIVIDSEATS` | Vivid Seats | **CJ** (cj.com) / Impact |
| `VITE_AFFILIATE_VIATOR` | Viator **and** GetYourGuide | Viator Partner Program / **Partnerize**; GetYourGuide via **Partnerize/CJ/AWIN** |
| `VITE_AFFILIATE_OPENTABLE` | OpenTable, Resy | OpenTable via **CJ/Partnerize** (Resy has no public affiliate — OpenTable links earn) |
| `VITE_AFFILIATE_UBER` | Uber (ride deep-link) | Uber affiliate via **Partnerize/Impact** (region-dependent) |
| `VITE_AFFILIATE_LYFT` | Lyft (ride deep-link) | Lyft affiliate via **Impact** |
| `VITE_AFFILIATE_BOOKING` | Booking.com, Expedia | Booking.com **Partner Program**; Expedia via **Partnerize** |

### Steps per program
1. Sign up to the network (Impact / CJ / Partnerize / AWIN) — free; approval can
   take a few days and may ask for your site URL (your deploy).
2. Apply to the specific brand inside that network.
3. Once approved, grab your **tracking-link template** (or sub-id param).
4. Set the matching `VITE_AFFILIATE_*` in Vercel → **redeploy**.
5. Verify: open an event, click **Buy/Find Tickets** or **Get a ride**, and
   confirm the outbound URL now routes through the network's domain. `/owner` →
   **Affiliate clicks** logs the engagement.

> Note: this is **referral commission** (a few %), not us processing the sale.
> True in-app booking where we take a cut requires partner booking APIs + a
> revenue-share agreement — that's a later phase.

---

## 3. Rides (Uber / Lyft) — deep-link now, live quotes/booking after approval

**Today (live):** the **Get a ride** button deep-links to Uber with the venue as
the destination, affiliate-wrapped (`VITE_AFFILIATE_UBER`). Real but modest,
often new-rider-weighted — treat as a bonus.

**Live fares + in-app booking (partner-gated):** Uber and Lyft **closed their
public ride/estimate APIs** to general developers. To show real quotes and book
in-app you must be approved into a partner program:
- **Uber:** Uber for Business / **Guest Rides** API → https://developer.uber.com
  and https://business.uber.com . Requires a business account + use-case review;
  you receive OAuth client credentials + a server token.
- **Lyft:** **Lyft partner** program (contact Lyft Business; no open self-serve API).

**Scaffold (already built, inert):** `api/ride-quote.js` + the client helper
`fetchRideQuote()` in `src/events.js`. With no credentials it returns
`available: false` and the app uses the deep-link. To activate after approval:
1. Set the partner creds in Vercel (see `.env.example`): `UBER_CLIENT_ID`,
   `UBER_CLIENT_SECRET`, `UBER_SERVER_TOKEN` (or `LYFT_CLIENT_ID/SECRET`), and
   optionally `RIDE_PROVIDER=uber|lyft`.
2. Fill in the `TODO(uber-guest-rides)` / `TODO(lyft-partner)` sections in
   `api/ride-quote.js` with the real estimate/booking calls.
3. We then surface the quote ("~$18–24, 4 min") on the ride button and add a
   confirm-to-book step.

---

## 4. Cost control (the other half of the ledger)
- **AI grounding** is capped at 1,400 grounded searches/day to stay inside
  Google's free 1,500/day (beyond that ≈ $35/1,000). `/owner` shows today's usage
  vs the cap with a near-cap alert.
- **Google Places** verification runs on the ~$200/mo Maps credit.

---

## 5. Consolidated signup checklist (priority order)
1. **Stripe** (account + `STRIPE_SECRET_KEY` + webhook `STRIPE_WEBHOOK_SECRET` +
   `FIREBASE_SERVICE_ACCOUNT`) — the only lever that earns immediately. *(§1)*
2. **`VITE_OWNER_EMAIL`** — so you can see `/owner`.
3. **Affiliate networks** — Impact, CJ, Partnerize, AWIN accounts, then apply to
   the brands you care about; paste each id into the matching `VITE_AFFILIATE_*`. *(§2)*
4. **Uber/Lyft affiliate** ids for the ride deep-link. *(§2)*
5. *(Later)* **Uber Guest Rides / Lyft partner** approval for live quotes+booking. *(§3)*
