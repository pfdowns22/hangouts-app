# Hangouts — Master Plan: Monetization + Mobile Launch

> Written 2026-07-19 as a handoff-quality plan. Any future session (any model)
> should be able to pick this up cold and execute. It supersedes the sequencing
> in ROADMAP.md for these two tracks; the detail docs it points to are current:
> - **MONETIZATION.md** — exact env vars / signup steps per revenue lever
> - **LAUNCH-CHECKLIST.md** — auth, OAuth verification, push, go-public switches
> - **APPSTORE.md** — Capacitor/Xcode runbook for the iOS build
> - **ROADMAP.md** — long-horizon ideas (WhatsApp bot, B2B insights, agent booking)

## Current state (verified 2026-07-19)

- Everything is merged to `main` and deployed (the old `mobile-redesign` branch
  is fully merged — ignore references to it being pending).
- Shipped and live: Instagram-style mobile UI, new auth screen (magic link +
  password + guest), web-push foundation (FCM service worker + opt-in card +
  proposal sends), PWA manifest + icons, in-app account deletion, Capacitor
  scaffold (`capacitor.config.json`, `cap:*` scripts), recommendation engine
  v2, ticket resolver ladder, AI proxy with Gemini→Moonshot failover + global
  budget breaker, time-based expiry, legal gate, first-run tour.
- Stripe sponsor marketplace: code complete, tested with test keys. **Not yet
  live keys.**
- Affiliate wrapping: code complete, **all `VITE_AFFILIATE_*` empty ⇒ $0**.
- App is still passcode-gated + NDA modal (intentional; see go-public switch).
- No local Node on this Mac; deploys are push-to-Vercel; Firestore rules are
  pasted by hand into the console.

---

# TRACK 1 — MONETIZATION

Ordered by (revenue now) ÷ (effort). Most items are **owner/business tasks**
(signups, keys) — the code is done. Code tasks are marked 🔧.

## M1. Stripe go-live (sponsored marketplace) — DO FIRST, ~30 min
The only lever that earns real money today. Steps are in MONETIZATION.md §1:
1. Complete Stripe business activation (bank details).
2. Swap `STRIPE_SECRET_KEY` to `sk_live_…`; create the live-mode webhook
   endpoint (`/api/stripe-webhook`, event `checkout.session.completed`) and set
   the live `STRIPE_WEBHOOK_SECRET`. Confirm `FIREBASE_SERVICE_ACCOUNT` is set.
3. Redeploy; buy the $29 package yourself with a real card as a smoke test;
   confirm the Sponsored card appears and `/owner` logs it; refund in Stripe.
4. **Then actually sell it:** the pitch page is `/sponsor`. First customers =
   NYC venues/promoters you already surface in the feed. A cold-outreach email
   template + a one-line "Promote your event here — from $29" footer card in
   the feed are cheap growth levers. 🔧 (feed footer card: S effort)

## M2. Affiliate enrollment — start now, revenue lags weeks
Zero code left; per-program signups (MONETIZATION.md §2 has the env-var map and
link-template format). Priority order by expected NYC volume:
1. **Impact** network account → apply to Ticketmaster/LiveNation, SeatGeek, Lyft.
2. **CJ** → Vivid Seats, OpenTable.
3. **Partnerize** → StubHub, Viator/GetYourGuide, Booking/Expedia.
4. As each approval lands: paste the tracking template into the matching
   `VITE_AFFILIATE_*` in Vercel → redeploy → click a Buy Tickets link and
   verify it routes through the network domain; `/owner` → Affiliate clicks.

Applications ask for your live site URL — apply **after** going public (M5) or
use the current deploy URL and note it's in private beta.

## M3. Hangouts+ subscription 🔧 — the recurring-revenue lever (effort M)
Build once Stripe is live (reuses the account). Design:
- **Stripe Billing**: one product, monthly ($4.99 suggested start) + yearly.
  Create Price IDs in the dashboard; env `STRIPE_PRICE_MONTHLY/_YEARLY`.
- **New api/subscribe-checkout.js** (mirror `sponsor-checkout.js`, mode
  `subscription`) + extend `stripe-webhook.js` to handle
  `customer.subscription.created/updated/deleted` → write
  `plan: 'plus'`/`'free'` + `stripeCustomerId` on `users/{uid}/profile`.
- **Entitlement gating** in `src/App.jsx`: a `usePlan()` helper reading the
  profile. Gate: (a) AI generations above the free per-user daily cap
  (`AI_USER_DAILY_CAP` already exists — Plus lifts it), (b) unlimited Plan-chat
  concierge sessions, (c) no Sponsored cards, (d) early features. Free tier
  stays genuinely useful.
- **Upgrade UI**: a Plus card in Settings + a contextual upsell where the free
  cap is hit ("You've used today's free AI plans — Plus is unlimited").
- **Manage**: link to Stripe Customer Portal (enable in dashboard; the portal
  URL comes from a tiny `api/billing-portal.js`).
- Enable **Stripe Tax** in the dashboard (checkbox at checkout-session level).
- Firestore rules: profile `plan` field must be **server-write-only** (webhook
  via Admin SDK bypasses rules; deny client writes to it). Publish rules.

## M4. Owner revenue dashboard polish 🔧 (effort S)
`/owner` already shows sponsored revenue + affiliate clicks + AI usage. Add:
subscription MRR/count (from webhook-written profile docs), a 30-day revenue
chart, and cost line (AI grounded-search count × rate). One screen = the whole
business.

## M5. Go public (gates all real revenue)
Revenue needs traffic. In order:
1. Publish `/privacy` + `/terms` pages 🔧 (static routes; also required by
   Google OAuth verification, affiliate apps, and App Store).
2. Complete LAUNCH-CHECKLIST §1–2 (OAuth consent → production + verification;
   Firebase email-link + authorized domains).
3. Custom domain on Vercel (helps OAuth verification + affiliate approvals).
4. Flip the go-public switches: remove `VITE_PASSCODE_HASH`, swap NDA modal for
   a plain Terms link 🔧 (LAUNCH-CHECKLIST §4).

## M6. Later / gated (don't start until traction)
- Venue self-serve marketplace + recurring venue subscriptions (ROADMAP 1c).
- "Find Tickets" concierge agent as a flagship **Plus** feature — active
  ticket-finding (search + monitor + notify, never auto-buy). Natural premium
  hook; effort L. (See ROADMAP 1a Phase 3 for honest constraints.)
- Uber/Lyft ride button — only after a partner deal (MONETIZATION.md §3).
- B2B aggregate insights — legal-gated (ROADMAP 1d).

---

# TRACK 2 — MOBILE LAUNCH

The mobile *UI* is done. "Launch" = PWA polish → iOS App Store (Capacitor) →
Google Play. Web push exists; native push replaces it inside the shells.

## P0. Prereqs (owner, this week — long lead times)
- [ ] **Apple Developer Program** ($99/yr) — enrollment can take days; also
      unlocks Sign in with Apple, which Apple **requires** since Google
      sign-in is offered.
- [ ] **Google Play Developer** ($25 one-time) — new accounts face a 14-day
      "closed testing with 12 testers" requirement before production; start
      early.
- [ ] **Install Node 20+ and Xcode** on this Mac (APPSTORE.md §setup). Native
      builds are local — the no-Node/Vercel flow doesn't cover them.
- [ ] `VITE_FCM_VAPID_KEY` (LAUNCH-CHECKLIST top) so web push works for the
      PWA interim.

## P1. PWA hardening 🔧 (effort S; ship regardless of stores)
- Add an in-app "Install Hangouts" prompt (beforeinstallprompt on Android;
  instructions sheet on iOS Safari). iOS web push only works when installed.
- Verify offline shell: service worker precaches the app shell; feeds show a
  cached-last-session state offline rather than a blank screen.
- Lighthouse PWA + mobile-perf pass; fix any manifest/icon/maskable warnings.

## P2. Sign in with Apple (blocks App Store submission)
LAUNCH-CHECKLIST §3 has the exact steps (App ID + Services ID + .p8 key →
Firebase Apple provider → flip `APPLE_SIGNIN_ENABLED = true` in `src/App.jsx`).

## P3. iOS app (Capacitor) 🔧 (effort M–L)
Follow APPSTORE.md. Key work beyond the runbook:
1. `npx cap add ios`, run in simulator; fix webview quirks (safe-area insets,
   status-bar style, keyboard-resize behavior, external links →
   `@capacitor/browser` not in-webview).
2. **Native push**: APNs key → upload to FCM; `@capacitor/push-notifications`;
   in code, branch on `Capacitor.isNativePlatform()` — request native
   permission + register token to the same Firestore token collection the web
   push sends to (server code then needs no change).
3. **Universal links** (`apple-app-site-association` served from the domain)
   so shared event/invite links open the app. Requires custom domain (M5.3).
4. Native share sheet (`@capacitor/share`) replacing web share where available;
   haptics on key taps (S, optional).
5. Real app icon + splash via `@capacitor/assets` (replace placeholder icons).
6. **In-app purchase decision:** Apple requires IAP for digital subscriptions
   sold *in the iOS app*. Options: (a) launch iOS with Plus purchase hidden
   ("manage on the web" — allowed if you don't link out; simplest), or
   (b) add StoreKit via RevenueCat later. **Recommend (a) for v1.** Sponsor
   checkout is B2B web-only — leave it off the app entirely.
7. TestFlight: archive → internal testing → fix → external beta.
8. Submit: privacy nutrition labels (APPSTORE.md lists the declarations),
   review notes with a demo account, remove/mention the passcode gate.

## P4. Android app (Capacitor) 🔧 (effort S after iOS)
`npx cap add android`; same push/deep-link/icon work (assetlinks.json for App
Links). Closed-testing track first (Play's 12-tester/14-day rule for new
accounts), then production.

## P5. Launch sequencing
1. This week: P0 signups + Node/Xcode install; M1 Stripe live; M2 network apps.
2. Next: M5 go-public (privacy/terms, OAuth verification, domain, drop gate) —
   in parallel with P1 PWA + P2 Apple sign-in.
3. Then: P3 iOS → TestFlight → submit; P4 Android behind it.
4. M3 subscription can be built anytime after M1; ship its iOS treatment per
   P3.6a.

## Deferred (post-launch)
Codebase refactor out of the 8k-line `App.jsx` + react-router + tests + Sentry
(ROADMAP §2 "foundation"). It is real debt and a prerequisite for *scaling*
the codebase — but it is **not** a prerequisite for either track above, and
doing it first would delay revenue and launch. Do it as the first post-launch
engineering block, before any major new feature.

---

## Quick reference — what only the owner can do
| Task | Where | Blocks |
|---|---|---|
| Stripe live keys + webhook | dashboard.stripe.com | M1, M3 |
| Affiliate network signups | impact.com, cj.com, partnerize.com | M2 |
| Apple Developer ($99) | developer.apple.com | P2, P3 |
| Google Play ($25) | play.google.com/console | P4 |
| OAuth consent → production + verify | Google Cloud Console | M5 |
| Firestore rules publish (any rules change) | Firebase console | M3 |
| Custom domain | Vercel | M5, P3.3 |
| Node + Xcode install | this Mac | P3, P4 |
