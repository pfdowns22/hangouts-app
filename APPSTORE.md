# Apple App Store runbook (Capacitor)

Foundation shipped in-repo: PWA manifest + icons, in-app **account deletion**
(Apple review requirement — Settings → Danger zone), `capacitor.config.json`
(appId `com.hangouts.app`, webDir `dist`), and `cap:*` npm scripts.

## One-time setup (owner)
1. **Apple Developer Program** — enroll ($99/yr) at developer.apple.com.
2. **Xcode** — install from the Mac App Store (large download; needs macOS
   with ~40GB free). Also `xcode-select --install`.
3. **Node** — install Node 20+ (e.g. from nodejs.org) so `npm`/`npx` work in
   Terminal (the repo currently deploys via Vercel without local Node).

## First iOS build
```
cd ~/hangouts-app
npm install @capacitor/core && npm install -D @capacitor/cli
npm install @capacitor/ios
npx cap add ios          # creates the ios/ native project
npm run cap:ios          # builds web, syncs, opens Xcode
```
In Xcode: select your Team under Signing & Capabilities, pick a simulator or
device, Run.

## Before submitting
- **Sign in with Apple**: finish Firebase setup (Services ID + key — see
  LAUNCH-CHECKLIST) and flip `APPLE_SIGNIN_ENABLED` to `true` in
  `src/App.jsx`. Apple REQUIRES it when Google sign-in is offered.
- **Push**: create an APNs key in the developer portal, upload it to
  Firebase Cloud Messaging settings; Capacitor `@capacitor/push-notifications`
  plugin replaces web push inside the native shell.
- **App icons / splash**: replace the generated placeholder icons
  (`public/icon-*.png`) with designed artwork; use
  `@capacitor/assets` to generate the full native icon set.
- **Privacy**: App Store privacy "nutrition labels" — declare: account info
  (name/email), coarse location (home base / current location), user content
  (events, chat), diagnostics none. Privacy policy URL must be public
  (publish /privacy page + custom domain — also needed for Google OAuth
  verification).
- **Account deletion**: already in-app (Settings → Danger zone). Reviewers
  check this.
- **Review notes**: provide a demo passcode (the app is passcode-gated) or
  remove the gate for release.

## Each release
```
npm run cap:sync   # rebuild web assets into the native shell
```
Then bump version/build in Xcode → Product → Archive → Distribute.
