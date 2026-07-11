# Launch checklist — sign-in & mobile release

Code-side work (branch `mobile-redesign`) removed the Calendar scope from the
login popup, so **basic Google sign-in shows no "unverified app" warning as
soon as this deploys** — no console work needed for that. The items below
finish the job (clean on-demand Calendar consent, email links, Apple).

## 1. Google Cloud Console — OAuth consent screen
_APIs & Services → OAuth consent screen (project `hangouts-app-9101f`)_

- [ ] Set **Publishing status → In production** (leaving "Testing" caps you at
      100 users and shows warnings regardless).
- [ ] Fill in: app name, logo, support email, developer contact.
- [ ] Add **privacy policy + terms URLs** (host them at e.g.
      `https://<your-domain>/privacy` — required for verification).
- [ ] **Verify domain ownership** of the production domain (Search Console).
- [ ] **Submit for verification.** Only the *sensitive* scope
      `.../auth/calendar.events` needs review (brand verification + a short
      screen-recording of the calendar flow). It is **not** a *restricted*
      scope, so no third-party security audit is required.
      Until verification completes, the warning appears **only** on the
      on-demand calendar prompt — never at login.

## 2. Firebase Console — Authentication
- [ ] **Sign-in method → Email/Password: Enable**, and inside it also enable
      **Email link (passwordless sign-in)** — the new auth screen's primary
      email flow is the magic link.
- [ ] **Sign-in method → Apple: Enable** (after step 3).
- [ ] **Settings → Authorized domains**: confirm the production Vercel domain
      (and any preview domain you test on) is listed.
- [ ] Optional polish: Templates → customize the sign-in-link email sender
      name/branding.

## 3. Apple sign-in (needed for App Store later anyway)
- [ ] Join **Apple Developer Program** ($99/yr).
- [ ] Create an **App ID** + **Services ID**, enable "Sign in with Apple".
- [ ] Create a **Sign in with Apple key** (.p8) and plug Services ID, Team ID,
      Key ID + key into Firebase's Apple provider config.
- [ ] Register the Firebase callback URL
      (`https://<project>.firebaseapp.com/__/auth/handler`) on the Services ID.
- [ ] Then in `src/App.jsx` flip **`APPLE_SIGNIN_ENABLED = true`** and deploy.

## 4. Go-public switches (when ready — currently intentionally OFF)
- The **passcode gate** and **NDA/TOS modal** are still active by decision.
  To go public later: drop `VITE_PASSCODE_HASH` from Vercel env (gate
  auto-bypasses) and replace the NDA modal with a plain Terms link.

## Verifying after deploy
1. Sign in with Google on the preview URL → consent screen should ask only
   for name/email, with **no warning screen**.
2. Tap the calendar icon on any event card → *now* Google asks for Calendar
   access (this prompt carries the warning until verification clears).
   Decline → an `.ics` file downloads instead.
3. Auth screen → enter an email → "Email me a sign-in link" → open link on
   the same device → signed in.
4. "Use a password instead" → new email creates an account; existing email +
   wrong password shows a friendly error.
5. "Browse as guest" still enters the app.
