# Hangouts

An AI-powered social planning app built with React, Firebase, and the Gemini API. Originally generated in Google Gemini Canvas, then refactored to run as a standard Vite + React project.

## Features
- Sign in with Google, Apple, or anonymously
- Profile with photo, preferences, family, and availability calendar
- Groups with real-time chat
- AI-generated event suggestions (Gemini + Google Search grounding)
- Calendar sync (analyze your Google Calendar to auto-fill availability)
- One-click "Save to Google Calendar" or `.ics` download

## Stack
- Vite + React 18
- Firebase (Auth, Firestore, Storage)
- Tailwind CSS (via CDN — swap to a build step for production)
- Gemini API (`gemini-2.5-flash` with Google Search grounding)

## Local setup
1. Install Node 18+ if you don't have it.
2. Clone the repo, then `npm install`.
3. Copy `.env.example` to `.env.local` and fill in the values (see below).
4. `npm run dev` — opens at http://localhost:5173.

### Getting Firebase config
1. Go to [console.firebase.google.com](https://console.firebase.google.com) → create a project.
2. Add a web app (the `</>` icon). Register it and copy the `firebaseConfig` values into `.env.local`.
3. Enable **Authentication** → Sign-in method → enable Google, Apple, and Anonymous.
4. Enable **Firestore Database** → Create database → start in production mode.
5. Enable **Storage** → Get started.
6. Apply the security rules from `firestore.rules` and `storage.rules` (paste them into the Rules tab of each).

### Getting a Gemini API key
1. Go to [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey).
2. Create an API key. Paste it into `VITE_GEMINI_API_KEY` in `.env.local`.

> **Security note:** the Gemini key is bundled into the client at build time, so anyone using your site can read it. For a colleague demo this is fine; for production, restrict the key by HTTP referrer in Google Cloud Console, or proxy through a backend.

## Event sources
The feed and group suggestions gather events from multiple sources in parallel, merge them, and de-duplicate:

1. **Gemini AI search** — always on (the original behavior): Gemini web-searches and proposes personalized events.
2. **Partner event APIs** — real, structured events via the `/api/events` serverless proxy ([api/events.js](api/events.js)). Each provider is **optional** and activates only when its key is set:
   - **Ticketmaster Discovery** (`TICKETMASTER_API_KEY`) — free, generous quota; concerts/sports/theater/arts.
   - **SeatGeek** (`SEATGEEK_CLIENT_ID`, optional `SEATGEEK_CLIENT_SECRET`) — ticketed events.
   - **PredictHQ** (`PREDICTHQ_TOKEN`) — broad coverage incl. non-ticketed (paid).
3. **Places to do when you're free** — **Google Places API (New)** (`GOOGLE_PLACES_KEY`) via the proxy's `?kind=places` mode. Enable "Places API (New)" in the same Google Cloud project as Gemini billing (Maps Platform's $200/mo free credit covers a beta). When a user has food/drink tastes (captured as `preferenceDetails`) and marked-free dates, the feed pins a couple of highly-rated nearby spots to those free slots.

Partner-API events are then ranked and given friendly blurbs by Gemini (factual fields are preserved verbatim). If no partner keys are set, the app runs on AI search alone — no breakage.

**Keys are server-side**: they're read by the proxy via `process.env` (no `VITE_` prefix) and set in **Vercel → Settings → Environment Variables**, so they never reach the browser. See `.env.example`.

**Adding a new source** (e.g. restaurants via Yelp Fusion or Google Places): add one provider object to the `PROVIDERS` array in [api/events.js](api/events.js) (map its response to the normalized shape) and one env key — nothing else in the app changes.

## Deploying
The repo is set up for **Vercel** (zero-config). Push to GitHub, import the repo at [vercel.com/new](https://vercel.com/new), and add the env vars from `.env.example` in the project settings (including any partner-event keys above). Vercel auto-builds on every push, and serves `/api/events` as a serverless function automatically.

You'll also need to add your Vercel URL (e.g. `your-app.vercel.app`) to the Firebase Auth "Authorized domains" list under **Authentication → Settings**.

## Notes / known issues
- Grounded Gemini calls (`tools: [{ google_search: {} }]`) split their answer across multiple response parts; `callGemini` joins all parts and surfaces `finishReason` when empty (a `MAX_TOKENS` finish from 2.5-flash thinking tokens is the usual cause of an empty result).
- The `.tsx` extension on the original Canvas output was misleading — there were no TypeScript types. This refactor uses `.jsx`.
- Apple sign-in requires Apple Developer setup in the Firebase console — the button is wired up but won't work until you complete that flow.
