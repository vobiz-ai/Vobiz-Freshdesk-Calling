# Changelog

All notable changes to this app are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [1.1.0] — Unreleased

### Added
- **Any Vobiz account can sign in.** The backend no longer holds an account:
  `VOBIZ_AUTH_ID`, `VOBIZ_AUTH_TOKEN`, `VOBIZ_FROM_NUMBER`, `VOBIZ_SIP_USER`,
  `VOBIZ_SIP_PASSWORD` and `AGENTS_FILE` are gone. Sign-in checks the pair with
  Vobiz, finds or creates this integration's application and the agent's own SIP
  endpoint in that account, and rotates its password. Webhooks are routed to the
  right account by SIP username, `ParentAuthID` or dialled number.
- **SIP direct** sign-in tab: an existing endpoint's username and password plus
  a typed caller ID, with no account credentials anywhere.
- The caller-ID picker lists the account's active, voice-enabled numbers (all
  pages), and the INVITE carries the choice as `X-VH-Caller-ID`.
- **The calling backend** (`backend/`). The repository previously described a
  backend it did not contain. It runs with `npm run backend`, configured from
  `backend/.env.example`.
- Outbound calls are bridged through a conference by default, with plain
  `<Dial><Number>` available as `OUTBOUND_MODE=dial`.
- **Enable inbound calls** now attaches the number to this integration's
  application and says which application it moved the number off.
- Optional call recording (`RECORD_CALLS=1`) and webhook signature checking
  (`VOBIZ_WEBHOOK_SIGNATURE`).

### Changed
- **The panel signs in before it registers.** `/login` returns a session token,
  held in memory and sent as a bearer header; the backend serves the SIP
  identity only with it. A fresh open shows *Signed out* until sign-in.
- Recordings play from signed, expiring links returned by `/recordings`.
- `/start-call` is retired; the panel places outbound calls over SIP.
- The mock backend follows the same token flow, answers CORS only for loopback,
  and shows the browser-as-A-leg XML.

### Fixed
- `npm run pack` failed on lint errors in `app/scripts/app.js`, while CI stayed
  green because `fdk validate` exits 0 on lint errors. CI now packs.
- `npm run dev` lacked the `--skip-coverage` flag the README described.
- Tests now pin the three SIP settings every call depends on: a space-free
  User-Agent, session timers off, and STUN on calls and answers.

### Documentation
- The README is rewritten for the people setting the app up: requirements,
  quick start, both sign-in modes, a configuration reference, production,
  security, troubleshooting and limitations. `ISSUES.md` is folded into it.

### Security
- The SIP password is no longer served to any caller who names an agent id.
- CORS no longer reflects arbitrary origins.
- Recording playback no longer relies on an unauthenticated route.

## [1.0.0] — 2026-09-14

First public release.

### Added
- Outbound calling from the panel, and click-to-call from any phone number in
  Freshdesk via `cti.triggerDialer`.
- Inbound calling to the panel, with one-time setup per number.
- Vobiz account login at runtime, with caller-ID number selection.
- Call recording playback.
- **Hang up control.** Previously a call could only be ended by the other party.
- **SIP registrar URL is now an installation parameter**, defaulting to
  `wss://registrar.vobiz.ai:5063/`.
- **Agent identity is now free text.** It was previously a fixed dropdown, which
  made the app impossible to install outside its original test account.

### Fixed
- **Calling is now gated on SIP registration, not only on account login.**
  Previously, if SIP was down an agent could still dial: the call connected, the
  customer answered, and heard silence indefinitely because there was no
  registered endpoint to bridge to.
- Added `unregistered` and `disconnected` handlers. The panel no longer shows
  "Ready" after the transport has dropped.
- The app now unregisters from the registrar when the tab closes, instead of
  leaving a stale binding that routed inbound calls to a dead leg for up to ten
  minutes.
- A failed or unreachable backend now produces a readable message instead of an
  unhandled rejection and a panel stuck on "Connecting…".
- A successful login that returns no numbers no longer reports as a failure.
- Call-status polling no longer leaks a timer per call, and no longer stops
  updating calls longer than two minutes.
- Recordings are no longer requested before login, which previously showed an
  error on every fresh open.
- The backend URL is now validated as HTTPS at startup. A bare hostname
  previously resolved against the Freshdesk origin and 404'd silently.
- Removed logging of backend response payloads to the browser console.

### Developer tooling
- **Mock calling backend** (`mock-backend/`) implementing the whole contract
  with fake data, so the panel can be developed without a Vobiz account.
- **45 unit tests** run with Vitest in jsdom against the real source and the
  real markup. Coverage: 97.8% statements, 100% functions, 80.8% branches —
  above the 80% Freshworks requires for Marketplace submission.
- **CI** on every push and pull request: tests with an explicit coverage gate,
  `fdk validate`, and a scan for credentials, real phone numbers, and
  ephemeral tunnel URLs.
- Toolchain pinned in `manifest.json` to Node 24.11.1 with FDK 10.1.9. The
  previously declared pairing was not one the CLI accepts.
- Brand palette aligned to the Vobiz tokens used across vobiz.ai and the
  Console (`#E83C00` / `#E86A00` / `#C93400`).

### Known limitations
- No ticket creation, call logging to tickets, screen pop, or recording
  attachment. Click-to-call is the only Freshdesk data integration today.
- No hold, mute, transfer, or conference.
- Browser calling only — calls cannot be routed to an agent's mobile or desk
  phone.
