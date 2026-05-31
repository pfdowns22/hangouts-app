# Hangouts

AI-powered social planning app. Originally generated in Google Gemini Canvas, then
refactored into a standard Vite + React project. See [README.md](README.md) for
end-user setup, deploy, and known-issues notes.

## Backlog / TODO
- **Local open-data events beyond NYC.** The `nycEvents` provider (api/events.js)
  is NYC-only (gated by `nycBorough()` in src/App.jsx). Add equivalent civic
  open-data event feeds for other major cities (Chicago, LA, SF, etc.) and route
  by the user's city/region the same way.
- **Live booking integrations.** Chat-aware recs surface golf courses / venues
  but not live tee-time or table booking — add partner/paid APIs (GolfNow,
  OpenTable/Resy) for in-app booking later.
- **Chat push notifications.** Chat is real-time in-app; add FCM + a service
  worker for background push (note: iOS Safari needs the app installed as a PWA).
- **Owner revenue dashboard.** In-app view of sponsored impressions/clicks/CTR +
  affiliate tallies (data already tracked on the sponsored docs / Stripe).
- **Email-notification opt-out.** A profile toggle to suppress proposal emails.
- **Sponsor ops:** /sponsor checkout requires the Stripe webhook
  (https://<deploy>/api/stripe-webhook) registered + STRIPE_*/FIREBASE_SERVICE_ACCOUNT
  /RESEND_* env vars set in Vercel.

## Stack
- **Vite + React 18** (plain `.jsx`, no TypeScript despite the original `.tsx` naming)
- **Firebase** — Auth, Firestore, Storage (`src/firebase.js`)
- **Tailwind CSS via CDN** (loaded in `index.html`; no build step — inline className strings only)
- **Multi-provider AI** — Gemini (`gemini-2.5-flash`), Claude, OpenAI, with user-supplied keys

## Commands
- `npm run dev` — Vite dev server at http://localhost:5173
- `npm run build` — production build
- `npm run preview` — preview the build
- No test or lint setup currently.

## Layout (this is a single-file app)
Almost everything lives in **`src/App.jsx`** (~4000 lines). When working here, search by
component name rather than scrolling.

- `src/main.jsx` — React entry point
- `src/firebase.js` — Firebase init + exported `auth`, `db`, `storage`, `appId`, `geminiApiKey`
- `src/App.jsx` — all components, AI calls, and helpers

### Key regions of App.jsx
- **AI layer** (top of file): `AI_PROVIDERS`, `callGemini` / `callClaude` / `callOpenAI`,
  unified `callAI({ prompt, useWebSearch, provider })`. Keys stored client-side via
  `getStoredKey` / `storeKey` (localStorage).
- **Images**: `useEventImage`, `pollinationsImage`, Unsplash cache, text placeholders.
- **State**: `AppContext` (React context) holds user/profile/tab state app-wide.
- **Icons**: a large block of inline SVG `Icon` components (`MenuIcon`, `FunnelIcon`, …).
- **Three main tabs** rendered by `MainContent`, switched via `activeTab`:
  - `myFeed` → `MyFeedSection` (+ `FeedCard`, filter/sort funnel popover)
  - `groups` → `GroupSection` (+ `GroupDetailView`, `GroupProposals`, `ProposalCard`, `ChatRoom`)
  - `suggestions` → `SuggestionSection` (AI event generation)
- **Auth/onboarding**: `AuthScreen`, `SurveyModal`, `LegalAcceptanceModal`, `NameSettingModal`
- **Profile/settings**: `ProfileSection`, `SettingsSection`, `CalendarPicker` (availability)
- **Sharing**: `InviteModal`, `JoinGroupModal`, `SendToGroupModal`
- **Calendar export**: `generateICSFile`, `addToGoogleCalendar`

## Conventions
- Styling is Tailwind utility classes inline in `className`. No CSS modules, no styled-components.
- Components are arrow-function consts; keep new ones in the same file unless it grows unmanageable.
- Firestore docs are namespaced by `appId` (env `VITE_APP_ID`, defaults to `hangouts-app`).
- Security rules live in `firestore.rules` and `storage.rules` — update these when changing
  the data model; they must be pasted into the Firebase console to take effect.

## Config / secrets
- Env vars in `.env.local` (gitignored); template in `.env.example`. All `VITE_`-prefixed,
  so they are **bundled into the client** — not secret. Restrict keys by referrer for prod.

## Known gotchas
- Gemini `google_search` tool combined with `responseSchema` can return empty results
  (the "Find Real Events" failure mode). `extractJsonArray` defensively parses model output.
- Apple sign-in is wired up but needs Apple Developer setup in Firebase to actually work.
- After deploying, add the deploy URL to Firebase Auth → Settings → Authorized domains.
