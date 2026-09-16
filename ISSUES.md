# Open issues

Everything currently blocking, degraded or deliberately unbuilt in this app, with the evidence behind each.

Last reviewed: **16 September 2026**.

> **This repository is public.** Every account identifier, endpoint username, phone number, backend hostname and credential below is deliberately replaced with a placeholder. Please keep it that way when adding to this file — one of the issues here is a backend that serves SIP passwords to anyone who knows its URL.

| # | Issue | Severity | Owner | Blocks? |
|---|---|---|---|---|
| [1](#issue-1--vobiz-never-records-the-endpoints-registration) | VoBiz never records the endpoint's registration | **P0** | VoBiz platform | **Yes — browser calling is dead** |
| [2](#issue-2--fdk-pack-fails-lint-on-the-vendored-jssip-bundle) | `fdk pack` fails lint on the vendored JsSIP bundle | P1 | Us | **Yes — can't install as a custom app** |
| [3](#issue-3--the-mock-backend-cannot-be-used-as-documented) | The mock backend cannot be used as documented | P1 | Us | No — but wastes a day |
| [4](#issue-4--the-backend-contract-has-security-gaps-that-are-easy-to-implement-wrongly) | Backend contract security gaps | **P0** for production | Whoever runs the backend | **Yes for launch** |
| [5](#issue-5--inbound-calls-auto-answer-with-no-popup) | Inbound calls auto-answer with no popup | P2 | Us | No |
| [6](#issue-6--nothing-is-written-back-into-freshdesk) | Nothing is written back into Freshdesk | P2 | Us | No |

**Recently closed:** [the JsSIP CDN URL that never worked](#closed--the-jssip-cdn-url-had-never-worked) — fixed 16 Sep 2026.

---

# Issue #1 — VoBiz never records the endpoint's registration

| | |
|---|---|
| **Severity** | **P0.** Browser calling cannot work at all |
| **Component** | The VoBiz platform. **Not this app** |
| **Owner** | VoBiz — unfixable from application code |
| **Status** | Open, reproduced from four independent angles |

## Summary

The panel registers with VoBiz's SIP registrar. The registrar replies `200 OK`. JsSIP fires `registered`, the badge turns green and the status reads *"Ready — registered as …"*.

**VoBiz then behaves as though that registration never happened.** Its own Endpoint API reports `sip_registered: "false"` with an empty `sip_registration` block, and any attempt to route a call to that endpoint with `<Dial><User>` is refused with hangup cause **`2020` — Endpoint Not Registered**.

Two parts of VoBiz disagree: the one that accepts registrations says yes, and the one that routes calls has no record of it.

## What an agent experiences

1. Open the panel, log in. Badge goes green — *"Ready — registered as …"*.
2. Place a call. The customer's phone rings, they answer.
3. They hear a couple of seconds of ringback, then *"The agent could not be reached. Goodbye."*
4. The call ends. **Nothing ever rings in the browser.**

That closing message is VoBiz's own fallback audio, played because the `<Dial>` produced no answered leg. It is not from this app and not from Freshdesk.

## Evidence

### A. The registrar accepts the registration

JsSIP only fires `registered` on a **2xx response to REGISTER**. This is an affirmative acceptance, not a timeout or a dropped packet.

```
[Vobiz SIP] WebSocket connected
[Vobiz SIP] Registered successfully as <endpoint-username>
```

### B. VoBiz's own API denies it exists

Queried seconds later through VoBiz's documented [List all endpoints](https://www.vobiz.ai/docs/endpoint/list-all-endpoints) API:

```json
{
  "username": "<endpoint-username>",
  "sip_registered": "false",
  "sip_registration": null,
  "sip_contact": null,
  "sip_expires": null,
  "sip_user_agent": null
}
```

Not an expired registration. Not a stale one. **Nothing was ever written.**

### C. VoBiz's documentation says B cannot happen

From [Endpoint object → Registration and WebRTC](https://www.vobiz.ai/docs/endpoint/endpoint-object):

> Once registered, `sip_registered` flips to `"true"` and the live `sip_contact`, `sip_expires`, and `sip_user_agent` fields populate.

We do exactly what that paragraph describes, over the documented registrar, with the documented credentials. Neither stated effect occurs. **The observed behaviour contradicts the documented behaviour** — that is the core of the escalation.

### D. Reproduced with no browser at all

A ~40-line Node script — **no browser, no Freshdesk, no JsSIP, none of this app's code** — performing a bare SIP REGISTER with the same credentials:

```
[sip] 200 OK — REGISTERED
Contact: <sip:…@<public-ip>:<port>;transport=ws>;expires=600;
         received="sip:…@<public-ip>:<port>;transport=ws"
```

The socket was then held open for 180 seconds and VoBiz's API polled throughout:

```
t+10s   sip_registered = false
t+30s   sip_registered = false
t+50s   sip_registered = false
t+70s   sip_registered = false
```

**A live, VoBiz-acknowledged registration, denied by VoBiz's own API for over a minute straight.** This is the single most important piece of evidence: it removes this app, Freshdesk, the browser and JsSIP from the picture entirely.

### E. Reproduced over a completely different transport

VoBiz documents two transports for the same endpoint and the same credentials:

| Client | Registrar | Transport |
|---|---|---|
| Softphone or IP desk phone | `registrar.vobiz.ai` | UDP, TCP, or TLS |
| Custom WebRTC SIP client | `registrar.vobiz.ai` | SIP over WebSocket |

The same test was repeated over **plain UDP on port 5060** — no WebSocket anywhere:

```
<<< SIP/2.0 401 Unauthorized
<<< SIP/2.0 200 OK
✅ REGISTERED over UDP — Contact: <sip:…@<local-ip>:<port>>;expires=600

t+35s   sip_registered = false
t+55s   sip_registered = false
t+75s   sip_registered = false
```

**Identical failure.** This rules out the WebSocket transport as the cause and shows the defect is not specific to browsers in any way.

### F. Dialling the endpoint is refused

```xml
<Dial callerId="+91XXXXXXXXXX" timeout="30">
  <User>sip:&lt;endpoint-username&gt;@registrar.vobiz.ai</User>
</Dial>
```

Every attempt, in the call detail record:

```
destination: sip:<endpoint-username>   ring_time: 1s   duration: 1s
hangup_cause_code: 2020   (Endpoint Not Registered)
```

Note the CDR's `hangup_cause` **name** reads `NORMAL_CLEARING`, which is misleading. The **code** is the truth.

### G. Account-wide, not one bad endpoint

All five endpoints on the account report `sip_registered: "false"`, including three that have an application linked:

```
Prod                              registered=false  hasApplication=true
WebRTC Playground Endpoint        registered=false  hasApplication=true
WebRTC Playground Endpoint        registered=false  hasApplication=true
<agent endpoint 1>                registered=false  hasApplication=false
<agent endpoint 2>                registered=false  hasApplication=false
```

This also disproves the theory that a missing application causes it — endpoints *with* one are equally unregistered.

## What was ruled out, and how

| Suspected cause | Ruled out by |
|---|---|
| Freshworks iframe CSP blocking the WebSocket | Reproduced outside any browser (D) |
| Brave Shields / browser extensions | Reproduced outside any browser (D) |
| JsSIP library bug | The bare-socket test doesn't use JsSIP (D) |
| WebSocket transport | Reproduced over plain UDP (E) |
| Wrong SIP URI form | Matches VoBiz's documented `<User>sip:user@domain</User>` exactly |
| Wrong credentials | The same credentials return `200 OK` |
| Missing `callerId` on `<Dial>` | `2020` persists with a valid `callerId` present |
| No application linked to the endpoint | Endpoints *with* one are equally unregistered (G) |
| Propagation delay | Still false after 75 seconds of continuous registration (D, E) |
| Our backend | The `2020` is generated by VoBiz and reported in VoBiz's own CDR |
| One faulty endpoint | All five on the account behave the same (G) |

## Why it went unnoticed for so long

The backend used to dial **two** destinations simultaneously — the browser *and* the agent's phone:

```xml
<Dial>
  <User>sip:&lt;agent-endpoint&gt;</User>   <!-- failed with 2020, every time -->
  <Number>+91XXXXXXXXXX</Number>            <!-- this carried every conversation -->
</Dial>
```

Every call that ever "worked" connected over the phone leg. The browser leg had been failing silently from the very first call. Removing the phone fallback is what made the failure visible.

## What we need from VoBiz

1. For a given endpoint, **what does the registration store hold immediately after a `200 OK` to REGISTER?** If the answer is "nothing", the registrar is acknowledging and then discarding.
2. **Is the store the registrar writes to the same one `sip_registered` and `<Dial><User>` read from?** The symptoms fit two systems that don't share state.
3. **Does this account have a setting that disables endpoint registration tracking?** It's account-wide across five endpoints, which would fit a per-account flag.
4. If endpoint registration is not expected to work on a **trial account**, please say so explicitly — nothing in the documentation mentions that limitation.

## Workarounds

| Option | What you get | Cost |
|---|---|---|
| **Ring the agent's phone alongside the browser** | Calls connect today, audio on a phone | Backend change, already proven |
| **Wait for a platform fix** | The real fix | Not on our timeline |
| **Put a SIP↔WebRTC gateway in between** (e.g. LiveKit, which VoBiz's own docs recommend for this) | Browser calling independent of this bug | A real infrastructure project |

Switching to VoBiz's Auth-ID/Token WebRTC method was investigated and **is not viable** — their docs reserve it for their own hosted playground and explicitly list it as the wrong choice for a custom client, and there is no public API behind it.

---

# Issue #2 — `fdk pack` fails lint on the vendored JsSIP bundle

| | |
|---|---|
| **Severity** | P1 — blocks installing as a real custom app |
| **Owner** | Us |
| **Status** | Open |

Since JsSIP is now vendored at `app/lib/jssip.min.js` (see [the closed issue below](#closed--the-jssip-cdn-url-had-never-worked)), `fdk pack` lints it as if it were our source and fails:

```
✖ app\lib\jssip.min.js::75: Unexpected var, use let or const instead.   (× many)
⚠ app\lib\jssip.min.js::75: Expected '===' and instead saw '=='.
…
Total Lint Errors: 989
```

JsSIP's own source uses `var` **901 times**. No bundler setting avoids this — building with `--target=es2022` still emits them, because they come from the library, not the bundler.

**What was tried and did not work:** `.fdkignore`, `.eslintignore`, and relocating the file from `app/scripts/` to `app/lib/`. FDK lints everything under `app/` regardless of path or ignore files.

`fdk validate` still passes (0 platform errors) and `fdk run` is unaffected, so local development works. Only the packaged-install path is blocked.

**Options, roughly in order of preference:**

1. Inline the bundle into `index.html` inside a `<script>` tag — FDK may not lint inline script the way it lints `.js` files. Untested.
2. Ask Freshworks how to exclude a vendored dependency from lint. There is no documented mechanism today.
3. Post-process the bundle to replace `var` with `let`. Fragile and unpleasant, but mechanical.
4. Host the bundle on a CDN that actually serves it and load it remotely — reintroduces a network dependency and may hit the iframe CSP.

---

# Issue #3 — The mock backend cannot be used as documented

| | |
|---|---|
| **Severity** | P1 — documented setup path does not work |
| **Owner** | Us |
| **Status** | Open |

`README.md` and `mock-backend/README.md` both instruct you to set the **Calling backend URL** to:

```
http://localhost:8092
```

The app rejects that. From `app/scripts/app.js`:

```js
if (!/^https:\/\//i.test(BACKEND_URL)) {
  setStatus("Backend URL must start with https:// — check this app's settings.");
  return;                       // ← bails out here
}
…
document.getElementById("vobiz-login-btn").addEventListener("click", vobizLogin);   // never runs
```

The **Log in** button's click handler is attached *after* that `return`, so with an `http://` backend the button is wired to nothing. Clicking it does nothing at all, with no error in the console — it looks like a broken button rather than a configuration problem.

**The whole documented local-development path is therefore unusable as written.** Pick one:

- Serve the mock backend over HTTPS with a self-signed certificate, and document trusting it.
- Allow `http://localhost` and `http://127.0.0.1` specifically, keeping the HTTPS requirement for everything else. Browsers already treat localhost as a secure context, so this is defensible.
- Fix both READMEs to describe a setup that actually works.

The second option is the smallest honest fix. The HTTPS check exists for a good reason — a bare hostname resolves relative to the Freshdesk origin and 404s silently, which looks like "the backend is down" rather than a typo — and localhost can be exempted without weakening that.

---

# Issue #4 — The backend contract has security gaps that are easy to implement wrongly

| | |
|---|---|
| **Severity** | **P0** before any real deployment |
| **Owner** | Whoever runs the calling backend |
| **Status** | Open in the reference implementation |

[`docs/backend-contract.md`](docs/backend-contract.md) documents these requirements, and the backend this app has been developed against **meets almost none of them**. If you are building a backend, treat that document as the specification and this as a warning list.

**`GET /agent/{agentId}` serves a long-lived SIP password over an unauthenticated endpoint.** Anyone who learns the backend URL can retrieve working SIP credentials, then register as that agent and place calls billed to the account. The contract warns about exactly this. The reference backend does it anyway.

**Recording URLs are not signed.** The contract requires `/recordings` to return short-lived signed URLs and `/recording-audio` to verify the signature. The reference backend instead requires a live in-memory agent session, which is a different — and weaker — control, and breaks entirely for any consumer that isn't a logged-in browser.

**`agentId` is treated as proof of identity.** It arrives as a plain string in the path or body and nothing authenticates it. Every endpoint in the contract is effectively open.

**CORS is `*`.** The contract asks for the Freshdesk origin specifically.

Because `agentId` values are guessable and the backend is publicly reachable, these compound: learn the URL, guess an agent id, retrieve a SIP password, place calls on someone else's account, and download their recordings.

---

# Issue #5 — Inbound calls auto-answer with no popup

| | |
|---|---|
| **Severity** | P2 — feature gap, not a defect |
| **Owner** | Us |
| **Status** | Not built |

From `app/scripts/app.js`:

```js
vobizUA.on("newRTCSession", data => {
  if (data.originator !== "remote") return;
  setStatus("Call ringing in…");
  …
  currentRTCSession.answer({ mediaConstraints: { audio: true, video: false } });  // immediate
});
```

The session is answered the instant it arrives. There is no ring, no caller identification, no Accept/Decline, and the panel is not brought to the front if it is closed.

That handler was written for the **outbound** case, where the browser is bridged in as the agent leg after the agent has already clicked Call — auto-answering is correct there. Nobody adapted it for genuine inbound calls.

A working incoming-call experience needs:

1. Distinguish an expected outbound bridge from a genuine inbound call rather than treating both the same.
2. Bring the panel forward — `client.interface.trigger("show", { id: "softphone" })`, already used elsewhere in the file for click-to-call.
3. Show the caller — available on `data.session.remote_identity.uri.user`.
4. Accept / Decline buttons wired to `session.answer(...)` and `session.terminate(...)`.
5. A longer `<Dial timeout>` on the backend, so there is time to react.

Steps 1–4 are in this repository. Step 5 is in the backend.

---

# Issue #6 — Nothing is written back into Freshdesk

| | |
|---|---|
| **Severity** | P2 — feature gap |
| **Owner** | Us |
| **Status** | Not built |

The panel is a softphone that happens to live inside Freshdesk. It does not create tickets, log calls as ticket notes, attach recordings to tickets, or open the matching contact when a call arrives. Click-to-call from a Freshdesk phone number works; everything after the call ends does not.

This is the difference between "a phone in a sidebar" and a CTI integration, and it is the main thing standing between this app and something a support team would actually adopt.

---

# Closed — the JsSIP CDN URL had never worked

| | |
|---|---|
| **Severity** | Was P0 — the panel never got past "Connecting…" |
| **Closed** | 16 September 2026 |

`app/index.html` loaded JsSIP from:

```
https://cdn.jsdelivr.net/npm/jssip@3.10.1/dist/jssip.min.js
```

That URL returns:

```
Couldn't find the requested file /dist/jssip.min.js in jssip.
```

**The npm package has no `dist/` folder.** Checked directly against the registry: 101 files, none of them a browser bundle. JsSIP ships CommonJS and expects you to bundle it yourself. Also checked and also unavailable:

| Source | Result |
|---|---|
| unpkg, same path | 404 |
| cdnjs | lists version 3.10.1, serves **zero files** |
| GitHub repository | no `dist/` directory, no release assets |

So `JsSIP` was never defined in the browser. `initVobizSip()` threw `ReferenceError: JsSIP is not defined` at the line that constructs the WebSocket interface, and because that happens inside an async handler the panel simply sat on *"Connecting as …"* forever with no visible error.

**This app could never have worked as shipped** — which strongly suggests it was only ever exercised against the unit tests, where JsSIP is faked.

**Fix:** a browser bundle is now vendored at `app/lib/jssip.min.js`, built with:

```bash
npm i jssip@3.10.1
echo "module.exports = require('jssip');" > entry.js
npx esbuild entry.js --bundle --minify --format=iife \
  --global-name=JsSIP --outfile=app/lib/jssip.min.js
```

Verified in jsdom before vendoring — `JsSIP.UA` and `JsSIP.WebSocketInterface` both present, version 3.10.1.

Serving it from the app's own origin also removes any question about the Freshworks iframe CSP blocking a third-party script. The trade-off is [Issue #2](#issue-2--fdk-pack-fails-lint-on-the-vendored-jssip-bundle).

---

# Reporting something new

Please include:

- The **hangup cause code** from the VoBiz CDR — the number, not the name. The name is frequently `NORMAL_CLEARING` on calls that plainly did not clear normally.
- The browser console, filtered to `Vobiz` — this app prefixes its own logs.
- The panel's **status line**, which is above the "Sign in" section and names the exact failure. The hint under the Call button is generic and will not tell you which of several causes applies.
- A UTC timestamp, so it can be correlated against VoBiz's logs.

And please keep account identifiers, endpoint usernames, phone numbers and backend hostnames out of this public repository.
