# Open issues

Everything currently blocking, degraded or deliberately unbuilt in this app, with the evidence behind each.

Last reviewed: **17 September 2026**.

> **This repository is public.** Every account identifier, endpoint username, phone number, backend hostname and credential below is deliberately replaced with a placeholder. Please keep it that way when adding to this file — one of the issues here is a backend that serves SIP passwords to anyone who knows its URL.

| # | Issue | Severity | Owner | Blocks? |
|---|---|---|---|---|
| [1](#issue-1--inbound-routing-into-a-webrtc-endpoint-is-blocked-platform-side) | Inbound routing into a WebRTC endpoint is blocked | **P0** | VoBiz platform | **Worked around** — inbound connects via a conference |
| ~~2~~ | ~~`fdk pack` fails lint on the vendored JsSIP bundle~~ | ~~P1~~ | Us | **Fixed** — see [closed](#closed--fdk-lint-on-the-vendored-jssip-bundle) |
| ~~3~~ | ~~The mock backend cannot be used as documented~~ | ~~P1~~ | Us | **Fixed** — see [closed](#closed--the-mock-backend-could-not-be-used-as-documented) |
| [4](#issue-4--the-backend-contract-has-security-gaps-that-are-easy-to-implement-wrongly) | Backend contract security gaps | **P0** for production | Whoever runs the backend | **Yes for launch** |
| ~~5~~ | ~~Inbound calls auto-answer with no popup~~ | ~~P2~~ | Us | **Fixed** — see [closed](#closed--inbound-calls-auto-answered-with-no-popup) |
| [6](#issue-6--nothing-is-written-back-into-freshdesk) | Nothing is written back into Freshdesk | P2 | Us | No |
| [7](#issue-7--the-caller-waits-through-the-agents-own-call-setup) | The caller waits through the agent's own call setup | P1 | Us + browser | No, but it is felt on every call |

**Recently closed:** [inbound auto-answer](#closed--inbound-calls-auto-answered-with-no-popup) (17 Sep) · [three undocumented JsSIP settings](#closed--three-undocumented-jssip-settings-were-required) (this is what made outbound work) · [FDK lint on the vendored JsSIP bundle](#closed--fdk-lint-on-the-vendored-jssip-bundle) · [the mock backend setup path](#closed--the-mock-backend-could-not-be-used-as-documented) · [the JsSIP CDN URL that never worked](#closed--the-jssip-cdn-url-had-never-worked) — the rest 16 Sep 2026.

---

# Issue #1 — Inbound routing into a WebRTC endpoint is blocked platform-side

| | |
|---|---|
| **Severity** | **P0** for inbound. Outbound is unaffected |
| **Component** | The VoBiz platform. **Not this app** |
| **Owner** | VoBiz — unfixable from application code |
| **Status** | **Open**, reproduced across accounts and across VoBiz's own SDK. Worked around in this app since 17 Sep — see below |

## Worked around, not fixed

Inbound calls now connect, and the defect below is still entirely real. The app
stopped trying to be rung and inverted the flow instead:

1. The caller is answered into a **`<Conference>`** room and waits there.
2. The panel learns about them by **polling the backend**, not by SIP.
3. Accepting places an ordinary **outgoing** call, which is the direction that
   works, and both legs meet in the room.

`<Dial><User>` is not used for inbound anywhere in this app any more. The
consequences of the detour are their own issue —
[#7](#issue-7--the-caller-waits-through-the-agents-own-call-setup).

**This does not reduce the priority of the platform defect.** Every WebRTC
customer who expects `<Dial><User>` to reach a browser still hits it, the
workaround costs a conference leg per call, and nothing here would be necessary
if the URI below parsed.

## Summary

`<Dial><User>` to a registered WebRTC endpoint never reaches the browser.
`vobiz-outboundsip` builds a gateway URI it cannot itself parse, and drops the
INVITE:

```
ERROR: pv [pv_trans.c:1547]: tr_eval_uri(): invalid uri
[<username>@prod-voice-ap-south-1-webrtc-3.vobiz.ai:7032;timeout=60;carrierid=sip;
 carrierrate=0;cloudrate=0.01;user_agent=<ua>;registrarip=registrar.vobiz.ai;
 contact=sip:<token>@<ip>:<port>;transport=ws;]

INVITE|blocking gw: <username>@prod-voice-ap-south-1-webrtc-3.vobiz.ai:7032;…
```

Two defects in that one string:

1. **No `sip:` scheme.** It begins `user@host:port`, which is not a URI.
2. **An unescaped URI inside a parameter** — `contact=sip:…@…:port` puts colons
   and an `@` where a parameter value cannot contain them.

## Scale

**510 blocked INVITEs in 14 days**, the earliest at the edge of log retention
(9 Sep), so possibly older. Across four distinct patterns and multiple accounts,
and including `user_agent=vobiz-webrtc-sdk 1.0.3` and `1.0.4` — **VoBiz's own SDK
hits this too**. This is not an integration mistake.

## What an agent experiences

The customer's phone rings, they answer, they hear a couple of seconds of
ringback, then VoBiz's "the agent could not be reached" fallback. Nothing ever
rings in the browser.

## What the evidence is *not*

Two earlier theories in this file were wrong, and are recorded here so nobody
re-runs them:

- **`sip_registered` is cosmetic.** It stays `"false"` even when registration
  genuinely succeeded. Tested on a fresh endpoint, polling for 40s, twice: once
  with stock `jssip@3.10.1` and once with `vobiz-jssip@1.0.1` — the fork inside
  VoBiz's own SDK. Byte-identical results. Every endpoint on the account reads
  `"false"`, including the one behind VoBiz's working public demo. The endpoint
  object documentation promises it flips; it does not. Filed with VoBiz's docs
  team.
- **It is not the SIP stack.** Stock JsSIP and VoBiz's fork behave the same.

## What actually fixed outbound

Nothing in this issue. Outbound works by **making the browser the A leg** — it
sends the INVITE itself and the backend answers `<Dial><Number>`, which is the
shape VoBiz's own `rtc-demo` and WebRTC playground use. See
[the closed client-configuration issue](#closed--three-undocumented-jssip-settings-were-required).

Inbound has no such workaround: `<Dial><User>` is the only way to reach a
registered endpoint, and it is the broken path.

## What to ask VoBiz

1. Is `<Dial><User>` into a WebRTC endpoint working for *anyone* in ap-south-1?
2. Is `sip_registered` expected to populate for WebSocket registrations at all,
   or only for UDP/TCP/TLS?
3. `POST /Endpoint/` silently rewrites the submitted username, and
   `POST /Endpoint/{id}/` returns `202 "changed"` for an `application` field it
   ignores — the working field name is `app_id`. Both are undocumented.

---

# Closed — Three undocumented JsSIP settings were required

| | |
|---|---|
| **Was** | P0 — outbound calls failed with errors that pointed nowhere near the cause |
| **Status** | **Fixed**, 16 Sep 2026. Outbound verified end to end, both legs billed |

Raw JsSIP against VoBiz does not work out of the box. Three settings are needed,
none documented by VoBiz, all of them taken from what `vobiz-webrtc-sdk` sets:

| Setting | Symptom without it |
|---|---|
| `session_timers: false` | `422 Session Interval Too Small`. JsSIP surfaces this as the opaque cause **"SIP Failure Code"**, and **no CDR is written at all**, because the call is refused before it is created. |
| `pcConfig: { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] }` | The offer carries host-only candidates, VoBiz logs `PrivateIP … Detected in SDP`, and the browser rejects the early-media answer as **"Incompatible SDP"**, cancelling ~220 ms in. FreeSWITCH records `Q.850;cause=88 INCOMPATIBLE_DESTINATION`. |
| `user_agent` with no space | VoBiz interpolates the registration's User-Agent unescaped into a gateway URI. JsSIP's default `JsSIP 3.10.1` contains a space. Not the cause of Issue #1 — the URI is malformed regardless — but worth avoiding. |

The diagnostic that distinguishes these: a **422** produces no CDR, while an SDP
rejection produces a CDR billed `0s` with `DialBLegUUID` empty.

---

# Closed — FDK lint on the vendored JsSIP bundle

| | |
|---|---|
| **Was** | P1 — blocked `fdk pack` **and**, contrary to what this file used to say, `fdk run` |
| **Status** | **Fixed**, 16 Sep 2026 |

FDK lints every `.js` file under `app/`, vendored dependencies included. JsSIP uses `var` 901 times, which is 989 lint errors. `.fdkignore`, `.eslintignore` and relocating the file all fail to exempt it.

**This file previously claimed `fdk run` was unaffected. It is not.** On FDK 10.1.9 the same lint errors abort the local server too:

```
The local server could not be started due to the following issue(s):
Lint errors:
✖ app/lib/jssip.min.js::1: Unexpected var, use let or const instead.
```

So local development was blocked as well, not only the packaged-install path.

**The fix.** FDK does not lint inline `<script>` — verified with a probe containing both `var` and `==`: 0 lint errors. So:

- **`npm run pack`** (`tools/pack.sh`) builds a *copy* of the app with `app/lib/jssip.min.js` inlined into `index.html`, drops `app/lib/`, and packs that. The source tree is never modified and JsSIP's semantics are untouched — no `var`→`let` rewriting of minified code. Produces `dist/vobiz-freshdesk-calling.zip`.
- **`npm run dev`** runs `fdk run --skip-validation lint`, which is enough for the local server.

`tools/pack.sh` also passes `--skip-coverage`. FDK 10 otherwise refuses to pack unless `fdk run` has been driven through a browser to generate *local simulation* coverage above 50% — a Marketplace submission gate that does not apply to custom apps. Unit tests still run and must pass before the zip is written.

---

# Closed — The mock backend could not be used as documented

| | |
|---|---|
| **Was** | P1 — the documented local-development path did not work |
| **Status** | **Fixed**, 16 Sep 2026 |

Both READMEs told you to set the **Calling backend URL** to `http://localhost:8092`. The app rejected it and `return`ed out of `init()` *before* the Log in button's click handler was attached, so the button was wired to nothing — no error, no console message, just a dead button.

Fixed by exempting loopback specifically, keeping the HTTPS requirement for every other host:

```js
const isLocalBackend = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(BACKEND_URL);
if (!/^https:\/\//i.test(BACKEND_URL) && !isLocalBackend) {
```

Browsers already treat localhost as a secure context, so this does not weaken the check — which exists because a bare hostname resolves against the Freshdesk app origin and 404s silently. Three tests cover it, including that `http://localhost.evil.example` is still rejected.

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

# Closed — Inbound calls auto-answered with no popup

| | |
|---|---|
| **Severity** | P2 — feature gap, not a defect |
| **Owner** | Us |
| **Status** | **Fixed, 17 September 2026** |

**What it does now.** An incoming call raises a banner with the caller's number,
plays a synthesised ringtone, and waits. **Accept** connects; **Decline** ends
the room so the caller reaches voicemail rather than being cut off. Enter and
Escape are bound to the same two actions. Nothing is answered without a click,
which also matters for the microphone: browsers treat a microphone request that
follows a user gesture differently from one that does not.

The mechanism changed completely along the way. The description below assumes
the browser is *rung* over SIP, which is the path
[#1](#issue-1--inbound-routing-into-a-webrtc-endpoint-is-blocked-platform-side)
shows never arrives. The panel now polls the backend for a waiting caller and
dials into a conference to reach them. The `newRTCSession` handler is still
there and still correct — it costs nothing and starts working on its own the day
VoBiz fixes its router.

<details>
<summary>Original report</summary>



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

</details>

---

# Issue #7 — The caller waits through the agent's own call setup

| | |
|---|---|
| **Severity** | P1 — felt on every inbound call |
| **Component** | This app, and the browser underneath it |
| **Owner** | Us, partly |
| **Status** | Open. Reduced, not solved |

## Summary

Because inbound is delivered by the agent dialling *out*
([#1](#issue-1--inbound-routing-into-a-webrtc-endpoint-is-blocked-platform-side)),
the caller is on hold for the whole of the agent's call setup — and that setup
does not begin when the call arrives, it begins when **Accept** is clicked.

On a measured call the agent's leg reached VoBiz **40.3 seconds** after the
click. VoBiz's own logs show no activity whatsoever in that window: no
registration, no retry, no error. The entire delay is inside the browser, before
JsSIP sends anything.

Two things happen there, in order, and both must finish first:

| Step | What it is |
|---|---|
| `getUserMedia` | Taking the microphone — a permission check, sometimes a prompt |
| ICE gathering | Asking a STUN server what the connection looks like from outside, across **every** network interface |

## What has been done

- The offer is polled every **1 s** rather than every 2 s.
- The microphone is acquired **while the banner is ringing** and the stream is
  handed to `call()`, so `getUserMedia` is off the critical path after the click.
- The backend logs the gap on every join, so it is measurable rather than
  inferred:
  `browser leg took 40.3s after Accept`.
- `INBOUND_RING_SECONDS` was raised well above the worst observed setup time. It
  was previously **shorter than the flow takes**, which sent callers to
  voicemail while the agent was already on the way.

## What has not

ICE gathering. JsSIP exposes no gathering timeout, so the app cannot cap it, and
a machine with many virtual network interfaces — VPNs, Docker, VirtualBox — has
more candidates to enumerate and gathers more slowly. Worth measuring on a clean
machine before assuming the number above is typical.

## Why it is not visible on outbound

It is exactly the same cost. Nobody is sitting on hold listening to it.

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

Serving it from the app's own origin also removes any question about the Freshworks iframe CSP blocking a third-party script. The trade-off was the FDK lint failure, since [closed](#closed--fdk-lint-on-the-vendored-jssip-bundle).

---

# Reporting something new

Please include:

- The **hangup cause code** from the VoBiz CDR — the number, not the name. The name is frequently `NORMAL_CLEARING` on calls that plainly did not clear normally.
- The browser console, filtered to `Vobiz` — this app prefixes its own logs.
- The panel's **status line**, which is above the "Sign in" section and names the exact failure. The hint under the Call button is generic and will not tell you which of several causes applies.
- A UTC timestamp, so it can be correlated against VoBiz's logs.

And please keep account identifiers, endpoint usernames, phone numbers and backend hostnames out of this public repository.
