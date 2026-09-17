# Changelog

All notable changes to this app are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **A second way to sign in: the endpoint's own SIP credentials.** Auth ID and
  Auth Token are account-wide — they authorise listing every number on the
  account, and the panel exchanges them for a SIP identity the backend looks up
  and hands back. **SIP direct** takes the endpoint's username and password
  instead, from Console → Voice → Endpoints, and never asks the backend for a
  credential. Its caller ID is typed rather than picked, because listing the
  account's numbers is exactly what those credentials do not authorise.
- **Per-call recording.** A **Record this call** checkbox next to the number.
  The choice travels on the call as an `X-VH-Record` SIP header rather than
  being stored anywhere, so the backend emits `<Record>` only when asked.
  Unticked means nothing recorded and nothing billed for recording. It governs
  inbound too, starting when the agent accepts — so hold time is not in the file.
- **Inbound calls ring, and wait to be answered.** A banner shows the caller's
  number with **Accept** and **Decline**, a ringtone plays, and nothing is
  answered without a click. Enter and Escape are bound to the same two actions.
  Declining sends the caller to voicemail rather than cutting them off.
- **Inbound calls connect at all**, by a different route. VoBiz cannot deliver a
  call into a registered WebRTC endpoint, so the caller is parked in a
  `<Conference>` and the panel dials *into* that room to meet them — outgoing
  being the direction that works. `<Dial><User>` is no longer used for inbound.
- The microphone is taken **while the banner is ringing** and handed to `call()`,
  so the caller is not held through `getUserMedia` after the agent clicks.

### Changed
- The inbound offer is polled every second rather than every two.
- `README.md` no longer says inbound does not work, and documents why it is
  slower than outbound.

### Removed
- **The recordings list.** The Vobiz Console already lists recordings, and
  mirroring it meant the calling backend streamed call audio to anyone who could
  reach it — see [ISSUES.md #4](ISSUES.md#issue-4--the-backend-contract-has-security-gaps-that-are-easy-to-implement-wrongly).

### Fixed
- A rejected SIP sign-in said nothing. The form kept reading "Signing in as …"
  while the real answer went to the panel status, so a wrong password looked
  like a hang.
- A replaced SIP connection could still write to the panel. `stop()` closes the
  socket asynchronously, so a discarded connection reported its own
  disconnection over the live one's status — and could raise an incoming-call
  banner for a call the panel was no longer able to answer.

### Known issues
- The caller waits through the agent's browser setting up its own leg —
  **40 s** on a measured call, almost all of it ICE gathering, which JsSIP gives
  no way to cap. See [ISSUES.md #7](ISSUES.md#issue-7--the-caller-waits-through-the-agents-own-call-setup).
- One inbound offer per agent at a time. A second caller goes to voicemail.

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
