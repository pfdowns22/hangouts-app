# Hangouts — Build-Out Roadmap (Monetization · Mobile UX · App Stores · Messaging)

> Strategic roadmap to take Hangouts from a working web beta to a sellable,
> multi-platform, revenue-generating product. This is a planning doc — not
> implemented. A future session can pick it up cold. Reflects app state as of
> the `ae93575` deploy.

## 0. Where we are today (baseline)
- **Stack:** Vite + React 18 (single ~5k-line `src/App.jsx`), Firebase (Auth /
  Firestore / Storage), Tailwind via CDN, deployed on **Vercel** (push-to-deploy;
  **no local Node** — builds run in the cloud). Serverless funcs in `/api`.
- **Features live:** multi-source event discovery (Ticketmaster, PredictHQ, NYC
  Open Data, Gemini grounded search) with Google-Places verification of food;
  hyper-local + per-interest tailoring; Today/Upcoming feed with type filter +
  dedup + past-prune; groups with real-time chat (reactions/images/edit/typing/
  unread), proposals + RSVP; availability + interests; chat-aware suggestions;
  **affiliate link-wrapping** (inert until enrolled); **self-serve Stripe
  sponsored marketplace** (`/sponsor` + webhook); email-on-propose (Resend).
- **Cost posture:** Gemini (paid, with an in-app daily grounding cap to stay in
  the free 1,500/day allowance) + Google Places ($200/mo Maps credit). Largely
  free at beta scale.
- **Known debt:** monolithic `App.jsx`; no router; no test suite; no product
  analytics/error monitoring; no privacy policy; no native apps.

---

## 1. MONETIZATION BUILD-OUT

### 1a. Booking & affiliate funnel (own the whole outing)
The app decides dinner → drinks → show → ride. Earn on each downstream action.

**Phase 1 — affiliate redirect (low effort, no liability):** deep-link out with
our tracking ID; partner pays commission. Reuse the existing `affiliateUrl()`
link-wrapper pattern in `src/App.jsx`.
- **Enroll in:** affiliate networks — **Impact**, **Partnerize**, **CJ**, **Awin**
  — plus direct programs: **OpenTable/Resy** (reservations), **Viator /
  GetYourGuide** (experiences/tours), **GolfNow** (tee times), **Uber/Lyft**
  (rides), **Booking.com/Expedia** (group getaways), **Ticketmaster** (already
  planned).
- **Code:** per-partner host→deeplink map (extend `affiliateUrl`); "Get a ride",
  "Reserve a table", "Book it" buttons on cards keyed by event type; env IDs.
- **Effort:** S–M per partner, mostly link templates + buttons.

**Phase 2 — true in-app booking (where partners allow):** programmatic booking
via partner APIs (e.g., OpenTable partner reservation API, Viator booking API).
- **Reality check:** most consumer ticketing (Ticketmaster) does NOT allow
  third-party purchase; reservations/experiences sometimes do, behind a partner
  agreement + revenue share + possibly PCI scope. Requires application/approval.
- **Code:** per-partner booking integration + a checkout/confirmation UI; handle
  failures, holds, cancellations.
- **Effort:** L per partner; partner-gated.

**Phase 3 — "agent booking" (AI completes the booking):** the most ambitious.
- **Honest constraints:** a real "the agent books it for you" needs EITHER (a)
  partner booking APIs from Phase 2 that the agent orchestrates, OR (b)
  browser/automation against sites that forbid it (ToS + reliability + payment
  + liability risk). There is no clean universal "book anything" API.
- **Recommended shape:** an AI **planning + pre-fill** agent (assembles the
  itinerary, deep-links each step with details prefilled, and — for partners
  with booking APIs — completes those programmatically with user confirmation +
  saved payment). Frame as "concierge that does the legwork," not "buys anything
  anywhere."
- **Depends on:** Phase 2 partner APIs, a payments/vault story, and likely a
  premium tier to fund it.
- **Effort:** XL; sequence last.

### 1b. Subscription — "Hangouts+" (recurring revenue)
- **Use:** Stripe Billing (you'll already have Stripe from the sponsor flow) +
  Customer Portal. Add an `entitlement`/`plan` field on the profile; gate
  features; webhook keeps it in sync.
- **Premium features worth paying for:** one-tap **concierge planning** (full
  night timed to everyone's availability), **unlimited AI** generations (vs the
  free grounding cap), calendar sync, larger/advanced groups, no ads, early
  access. Consider a **per-organizer** plan (one person pays for the group).
- **Enroll in:** Stripe Billing + **Stripe Tax** (sales-tax handling).
- **Code:** subscription checkout + webhook + entitlement gating throughout;
  upgrade UI; manage-subscription link to Stripe portal.
- **Effort:** M.

### 1c. Sponsored / venue marketplace (extend what's built)
- **Recurring venue subscriptions** (always-on placement for matching users),
  **"claim your venue"** self-management, **deals/coupons** (cut of redemptions),
  **promoter self-serve event creation/targeting**.
- **Code:** extend the `sponsored` model + a venue/owner portal (auth'd seller
  dashboard); recurring billing via Stripe Billing; redemption tracking.
- **Enroll in:** none new (Stripe). **Effort:** M–L.

### 1d. Aggregate insights (B2B, later — the *ethical* data play)
- Sell **anonymized, aggregate** local-trend reports to venues/promoters
  ("what's trending in Park Slope"). **Never** individual behavior.
- **Needs:** explicit consent + disclosure, a data pipeline (Firestore →
  BigQuery export → aggregation), and a B2B sales motion. **Legal counsel
  required** (GDPR/CCPA, your ToS). **Effort:** L; gated on real usage + legal.

### 1e. Cost controls (the other half of the balance)
- Keep the Gemini grounding cap; add an **owner revenue/cost dashboard**
  (sponsored impressions/clicks/CTR, affiliate tallies, AI spend); budget alerts.
- **Effort:** S–M.

---

## 2. MOBILE-FIRST UX OVERHAUL (Instagram / Facebook / Reddit feel)

Goal: a polished, "sells itself" social feed app, not a utility.

**Design phase (do first):** wireframes/Figma for: bottom tab nav (Feed /
Groups / Create / Activity / Profile), image-forward full-bleed cards, infinite
feed, pull-to-refresh, gestures, skeleton loaders, dark mode, polished
onboarding, empty states, profile pages. Establish a design-token system.

**Engineering prerequisites (important):**
- **Refactor the monolith:** split `src/App.jsx` (~5k lines) into feature
  modules/components; introduce **routing (react-router)** and lightweight state
  management; add a component library/design system. This unblocks everything
  below (deep links, app stores, testing).
- **Add tests + error monitoring (Sentry)** before scaling UI churn.

**Implementation:** rebuild navigation (bottom nav), card UI, feed interactions,
profile, create-flow; responsive-first; accessibility. **Effort:** XL (this is a
substantial redesign + refactor — phase it: foundation → navigation → feed →
groups/chat → profile/onboarding).

---

## 3. NATIVE APPS — Apple App Store & Google Play

**Recommended approach: Capacitor** (wrap the existing React web app in a native
shell) — fastest path to both stores while reusing the codebase. Alternatives:
React Native/Expo (native rewrite, better feel, XL effort) or PWA (no proper App
Store path on iOS). Pick Capacitor unless we decide to go fully native.

**Accounts/signups:**
- **Apple Developer Program** — $99/yr (App Store Connect).
- **Google Play Developer** — $25 one-time (Play Console).

**Native work:**
- Capacitor shell + plugins: **push (APNs via FCM)** — this finally solves the
  iOS web-push limitation; **deep links / universal links**; calendar; native
  share sheet; haptics.
- App icons, splash screens, store listings/screenshots, content rating.
- **Apple requirements:** privacy nutrition labels + data-use disclosures,
  **in-app account deletion**, Sign in with Apple (already wired), support +
  privacy-policy URLs.
- Build/sign/submit pipelines (EAS or Xcode/Gradle); **note:** native builds need
  a Mac + Xcode toolchain (can't be done from the no-Node Vercel flow — this is a
  local/CI build step).
- **Effort:** L (Capacitor) once the web UX is solid + routing exists.

---

## 4. WhatsApp & iMessage — conversation → event suggestions

**Critical honesty up front — you cannot silently read users' existing chats.**
Both platforms forbid third parties from reading arbitrary conversations
(WhatsApp is E2E-encrypted with no such API; iMessage extensions only see what
the user explicitly hands them). So "analyze their conversation" must be
**opt-in and scoped**. Viable designs:

**WhatsApp:**
- **Opt-in Hangouts bot** via **WhatsApp Business Platform (Cloud API)** — a
  number/bot a group invites or forwards messages to; it analyzes *that*
  conversation context (what's shared with the bot), replies with suggestions +
  app deep links. **Enroll:** Meta Business verification + WhatsApp Business API
  (directly via Meta or a BSP like **Twilio**). **Code:** a serverless webhook
  (receive → Gemini → reply + deep link). **Effort:** M–L + Meta approval.
- **Share-out (easy, high virality):** "Share to WhatsApp" of a suggestion/RSVP
  with an app deep link. **Effort:** S.

**iMessage:**
- **iMessage App Extension** (native iOS, Swift, in Xcode; ships with the iOS
  app): inside a conversation the user taps Hangouts to get suggestions and drop
  an interactive card/link. **Still cannot read history** — it's a "tap to
  suggest/share" composer. Requires the native iOS app (Capacitor alone won't do
  an iMessage extension — needs a native target). **Enroll:** Apple Developer.
  **Effort:** L (native Swift).

**Recommended framing:** lead with **share-OUT** (drive growth: users post
Hangouts suggestions into their WhatsApp/iMessage threads with deep links back),
then the **opt-in WhatsApp bot** (real conversation analysis where permitted),
and treat the **iMessage extension** as a native add-on after the iOS app ships.

---

## 5. CROSS-CUTTING FOUNDATIONS (needed by most of the above)
- **Routing + deep links** (react-router + universal/app links) — required for
  app stores, sharing, `/sponsor`, and messaging funnels.
- **Codebase refactor** out of the monolith — prerequisite for scale + native.
- **Backend maturity:** background triggers (push on new message/proposal,
  scheduled jobs, the WhatsApp webhook) likely need **Firebase Cloud Functions
  (Blaze plan)** or a small dedicated backend, beyond today's Vercel funcs.
- **Auth/accounts:** account deletion (Apple), hardened onboarding.
- **Privacy/legal (do early):** privacy policy + ToS update, consent flows
  (analytics, push, messaging, any insights), GDPR/CCPA, app-store data
  disclosures. **Engage counsel** before the insights/data products and store
  submission.
- **Observability:** product analytics (privacy-respecting, e.g. PostHog),
  **Sentry** error monitoring, revenue/cost dashboards.
- **Payments maturity:** Stripe Billing + Tax; **Stripe Connect** if we ever pay
  venues/partners out.

---

## 6. SUGGESTED SEQUENCING (phases)
0. **Foundation** — refactor `App.jsx` into modules, add router, Sentry,
   analytics, privacy policy. *(Unblocks everything.)*
1. **Revenue quick wins** — booking/experience/ride **affiliate** (enroll
   networks) + **Hangouts+ subscription** (Stripe Billing) + owner dashboard.
2. **Mobile UX overhaul** — design system + redesigned feed/nav/profile.
3. **Native apps (Capacitor)** — push notifications, Apple + Google submissions.
4. **Growth / messaging** — WhatsApp share-out → opt-in bot; iMessage extension.
5. **Venue marketplace + aggregate-insights B2B** (legal-gated).
6. **Agent booking** (depends on Phase-2 partner booking APIs + premium funding).

---

## 7. SIGNUPS / ACCOUNTS CHECKLIST (consolidated)
- **Apple Developer** ($99/yr) · **Google Play** ($25 once)
- **Meta Business + WhatsApp Business API** (or **Twilio** as BSP)
- **Stripe** — Billing, Tax, (maybe Connect)
- **Affiliate:** Impact / Partnerize / CJ / Awin + direct: OpenTable·Resy,
  Viator·GetYourGuide, GolfNow, Uber·Lyft, Booking·Expedia, Ticketmaster
- **Resend** (email; already planned) · **Sentry** · **PostHog** (or similar)
- **Firebase Blaze** (Cloud Functions / higher quotas)
- **Legal counsel** — privacy policy, data products, store compliance

---

## 8. ENV / KEYS that will accumulate (server-side unless noted)
Existing: `VITE_FIREBASE_*`, `VITE_GEMINI_API_KEY`, `GOOGLE_PLACES_KEY`,
`TICKETMASTER_API_KEY`, `PREDICTHQ_TOKEN`, `VITE_UNSPLASH_KEY`,
`VITE_FEEDBACK_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`FIREBASE_SERVICE_ACCOUNT`, `RESEND_API_KEY`, `RESEND_FROM`, `VITE_AFFILIATE_*`.
Coming: more `VITE_AFFILIATE_*`/partner keys, Stripe price IDs, WhatsApp/Meta
tokens, Sentry DSN, analytics key, APNs/FCM credentials.

---

## 9. Effort snapshot
| Workstream | Effort | Gated by |
|---|---|---|
| Affiliate funnel (P1) | S–M | network signups |
| Hangouts+ subscription | M | Stripe Billing |
| Sponsored/venue marketplace | M–L | — |
| Foundation refactor + router | L | — (do first) |
| Mobile UX overhaul | XL | foundation |
| Native apps (Capacitor) | L | UX + Mac/Xcode |
| WhatsApp bot + share-out | M–L | Meta approval |
| iMessage extension | L | native iOS app |
| In-app / agent booking | L–XL | partner APIs |
| Aggregate insights (B2B) | L | legal + usage |
