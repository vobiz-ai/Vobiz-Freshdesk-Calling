# Vobiz Calling for Freshdesk

A calling panel that puts [Vobiz](https://www.vobiz.ai) telephony inside
Freshdesk. Agents place and receive real phone calls from the browser, and play
back call recordings, without leaving the helpdesk.

This is a **custom app**. You install it on your own Freshdesk account — there
is no Marketplace approval to wait for, and it is usually live within about
thirty minutes of upload.

> ## Both directions work. Inbound takes an unusual route, on purpose.
>
> **Outbound is verified end to end** — the panel registers, dials, and carries
> two-way audio in the browser, with both legs billed on the Vobiz CDR.
>
> **Inbound is verified end to end too, but it does not ring the browser.** It
> cannot: routing a call *into* a registered WebRTC endpoint with `<Dial><User>`
> is broken platform-side, on other accounts and on Vobiz's own SDK, and nothing
> configurable on this side avoids it — see
> [ISSUES.md #1](ISSUES.md#issue-1--inbound-routing-into-a-webrtc-endpoint-is-blocked-platform-side).
>
> So an incoming caller is parked in a **conference room** and the panel is told
> about them out of band. Accepting places an ordinary **outgoing** call into
> that room — the direction that does work — and the two legs meet there. The
> agent sees a normal ringing panel; the mechanics underneath are inverted.
>
> One consequence worth knowing before you test: the caller waits on hold for
> the whole of the agent's own call setup, which is slower than it looks. See
> [Inbound is slower than outbound](#inbound-is-slower-than-outbound-and-why).
>
> Three client settings are **required** and none of them are documented by
> Vobiz. Without them calls fail with errors that point nowhere near the cause:
>
> | Setting | Without it |
> |---|---|
> | `session_timers: false` | `422 Session Interval Too Small` → "SIP Failure Code", **no CDR at all** |
> | `pcConfig.iceServers` (STUN) | host-only candidates → "Incompatible SDP", cancelled in ~220 ms |
> | space-free `user_agent` | harmless here, but Vobiz interpolates it unescaped into a URI |
>
> All three are what Vobiz's own `vobiz-webrtc-sdk` sets. They are the supported
> configuration, not workarounds.

**The browser is the A leg.** It sends the INVITE itself; the backend only
answers Vobiz's question about what to do with the call. The reverse design —
backend originates to the customer, then bridges the browser in with
`<Dial><User>` — is what this repository used to do, and it is the path that is
currently broken.

```
  agent clicks a number
          │  cti.triggerDialer
          ▼
   ┌─────────────┐   SIP INVITE over WebSocket    ┌──────────────┐
   │  this app   │ ─────────────────────────────▶ │    Vobiz     │
   │ (the A leg) │ ◀───────── RTP audio ────────▶ │              │
   └─────────────┘                                └──────┬───────┘
                                                         │ answer URL
                                                         ▼
                                              ┌────────────────────┐
                                              │  calling backend   │
                                              │  <Dial><Number>    │──▶ PSTN
                                              └────────────────────┘
```

## What you need first

**A calling backend.** This app holds no Vobiz credentials and cannot place a
call by itself. It talks to a small service you run, which holds your Vobiz Auth
Token and drives the Vobiz REST API.

That service is **not** in this repository. Its complete contract — every
endpoint, request and response shape, and the security requirements — is in
**[docs/backend-contract.md](docs/backend-contract.md)**. Read it before you
start; the obvious implementation of the recording endpoint is unsafe, and the
document explains why.

You also need:

- A Freshdesk account on **Growth, Pro, or Enterprise** with admin access.
- A [Vobiz account](https://console.vobiz.ai) with an Auth ID, Auth Token, and at
  least one phone number.

> **Freshcaller cannot be enabled at the same time as a CTI app**, and Freshdesk
> allows only one CTI app to be active at a time. Installing this replaces
> whatever telephony your account uses today.

## Install

See **[docs/install.md](docs/install.md)** for the full walkthrough with the
exact menu paths. In short:

1. Pack the app: `npm run pack` — the result is in `dist/`.
2. In Freshdesk, go to the Developer Portal and create a **Custom App**, then
   upload the packed zip.
3. Install it on your account and fill in the two required settings:
   - **Calling backend URL** — the HTTPS base URL of your backend.
   - **Agent identity** — which identity this installation registers as. Every
     agent needs a different value.
4. Open any agent page and click the Vobiz icon at the bottom left.

## Using it

**Sign in**, either way:

| | **Vobiz account** | **SIP direct** |
|---|---|---|
| You enter | Auth ID and Auth Token | The endpoint's SIP username and password |
| Caller ID | Picked from your account's numbers | Typed |
| The backend | Tells the panel which SIP identity it is | Is not involved in signing in at all |
| Reaches | Everything on the account | That one endpoint |

Both are entered by the agent at runtime. **SIP direct** credentials come from
[Console](https://console.vobiz.ai) → Voice → Endpoints, and are the better
choice when an agent only ever works one endpoint: nothing account-wide is
handed to the browser, and the backend never serves a SIP password — which is
half of [Issue #4](ISSUES.md#issue-4--the-backend-contract-has-security-gaps-that-are-easy-to-implement-wrongly).

Its caller ID is typed rather than picked because listing the account's numbers
is precisely what endpoint credentials do not authorise. It is required: carriers
reject a call with no CLI, and that failure says nothing about a missing caller
ID, so the panel refuses at sign-in instead.

**Make a call** by typing a number and clicking **Call**, or by clicking any
phone number in Freshdesk — the panel opens and dials automatically.

Audio runs through the browser, so the first call prompts for microphone
permission. The person you call hears a few seconds of ringback after answering
while your browser is bridged in; this is expected, and
[docs/backend-contract.md](docs/backend-contract.md#post-start-call) explains
why.

**Receive calls** by clicking **Enable inbound calls to this panel** once. Keep
the Freshdesk tab open, and **only one tab** — several tabs register the same SIP
identity and evict each other, so a call can ring a tab that is no longer the one
Vobiz will reach.

When a call arrives the panel rings and shows the caller's number, with
**Accept** and **Decline**. Accept connects you; Decline sends the caller to
voicemail. Enter and Escape do the same thing.

**Record a call** by ticking **Record this call** before dialling. It applies to
an inbound call too — recording starts when you accept, so the caller's time on
hold is not in the file. Leave it clear and nothing is recorded, and nothing is
billed for recording.

**Play them back in the Vobiz Console**, under Voice → Recordings. The panel
does not list them: it would only be mirroring what the Console already holds,
and serving the audio meant the calling backend could hand call recordings to
anyone able to reach it.

### Inbound is slower than outbound, and why

The caller is on hold from the moment they are parked until your leg reaches
Vobiz — and your leg is not sent the instant you click **Accept**. The browser
first takes the microphone, then gathers its ICE candidates, and only then does
JsSIP send the INVITE. On a measured call that took **40 seconds** after the
click, all of it inside the browser: Vobiz's logs show no activity at all in
that window.

Two things reduce it, both already in the panel: the offer is polled every
second rather than every two, and the microphone is acquired **while the banner
is still ringing** so `call()` does not stop to ask for one. What remains is ICE
gathering, which this app cannot cap — JsSIP exposes no gathering timeout.

Practical consequences:

- **Click Accept promptly.** Every second of hesitation is a second the caller
  spends on hold.
- **A machine with many virtual network adapters gathers ICE more slowly** —
  VPNs, Docker, VirtualBox and similar each add interfaces the browser has to
  enumerate. Worth checking if the delay is consistently long.
- `INBOUND_RING_SECONDS` on the backend must stay **well above** the worst
  observed setup time, or callers are sent to voicemail while the agent is
  already on the way.

## Run it locally

**You do not need a Vobiz account to develop the panel.** This repository ships
a mock backend that implements the whole contract with fake data.

The Freshworks CLI is pinned to a Node version, and there is a separate CLI
build per Node major. Install the pair this app declares in `manifest.json`:

```bash
nvm install 24.11.1 && nvm use 24.11.1
npm install https://cdn.freshdev.io/fdk/latest-v24.tgz -g
fdk version     # 10.1.9
```

Then:

```bash
npm install
npm run mock-backend     # terminal 1 — http://localhost:8092
npm run dev              # terminal 2 — http://localhost:10001
```

`npm run dev` is `fdk run --skip-coverage --skip-validation lint`, and both flags
are load-bearing:

- **`--skip-validation lint`** — FDK lints every `.js` file under `app/`,
  vendored dependencies included. JsSIP uses `var` 901 times, which is 989 lint
  errors, and a bare `fdk run` refuses to start the server because of them.
- **`--skip-coverage`** — FDK instruments app JS for simulation coverage.
  Instrumenting the 281 KB minified JsSIP bundle hangs the browser tab with
  "Page Unresponsive".

On the **first** `fdk run`, FDK asks which account to simulate at
<http://localhost:10001/system_settings> before it will let you set anything
else. Both fields come from your Freshdesk URL — **Organization Domain** without
the scheme (`yourcompany.freshdesk.com`), **account URL** with it
(`https://yourcompany.freshdesk.com`). Product type is `DEFAULT` unless you are
on Freshdesk Omni.

Then set the app's settings at <http://localhost:10001/custom_configs>:

| Setting | Value |
| --- | --- |
| Calling backend URL | `http://localhost:8092`, or an `https://` URL |
| Agent identity | anything, e.g. `priya` |
| SIP registrar URL | leave blank |

> **`http://localhost:8092` works.** Loopback is exempt from the HTTPS check —
> browsers already treat localhost as a secure context. Every other host must be
> `https://`, because a bare hostname resolves against the Freshdesk app origin
> and 404s silently, which reads as "the backend is down" rather than a typo.

> **Testing real calls needs a public HTTPS backend**, not the mock: Vobiz has to
> reach your answer URL from the internet. A tunnel works, but on ngrok's free
> tier the browser interstitial breaks XHR unless every request carries
> `ngrok-skip-browser-warning` — this app sends it, and your backend must list it
> in `Access-Control-Allow-Headers` or the CORS preflight fails and the real
> request is never sent.

Any Auth ID and Auth Token are accepted; use `fail` as the Auth ID to see the
error path. See [mock-backend/README.md](mock-backend/README.md) for the rest,
including how to point it at a real Vobiz SIP endpoint to test actual audio.

Open a Freshdesk page with `?dev=true` appended to load the panel from your
machine. Without that flag Freshdesk looks for a published version and the icon
never appears.

## Tests

```bash
npm test        # 54 tests, with coverage
fdk validate    # platform and lint rules — 0 platform errors
npm run pack    # build dist/vobiz-freshdesk-calling.zip
```

Freshworks requires 80% coverage on every metric for a Marketplace submission,
and `fdk pack` enforces it.

> **Use `npm run pack`, not a bare `fdk pack`.** FDK lints every `.js` file under
> `app/`, vendored dependencies included, and JsSIP's 901 `var` declarations are
> 989 lint errors that abort the pack. `.fdkignore`, `.eslintignore` and moving
> the file elsewhere are all ignored by FDK.
>
> `tools/pack.sh` works around it without touching the library's semantics: it
> builds a *copy* of the app with JsSIP inlined into `index.html` — which FDK
> does not lint — and packs that. The source tree is never modified.

The tests load the real `app/scripts/app.js` and the real markup from
`app/index.html` into jsdom with the Freshworks SDK, JsSIP, and `fetch` faked,
so they exercise the code that ships rather than a copy of it.

> `fdk pack` additionally wants *local simulation* coverage, which is only
> produced by driving the app inside a real Freshdesk account via `?dev=true`.
> That is a Marketplace gate and does not apply to custom apps, so
> `tools/pack.sh` passes `--skip-coverage`. Unit tests still run and must pass
> before the zip is written. Drop that flag for a Marketplace submission.

The app itself is three files — `app/index.html`, `app/scripts/app.js`, and
`app/styles/style.css`. There is no framework.

The one build artefact is `app/lib/jssip.min.js`, vendored because **JsSIP has
no browser build on any CDN** — the npm package ships CommonJS only, and the URL
this repository used to load it from had never worked. Rebuild it with:

```bash
npm i jssip@3.10.1
echo "module.exports = require('jssip');" > entry.js
npx esbuild entry.js --bundle --minify --format=iife \
  --global-name=JsSIP --outfile=app/lib/jssip.min.js
```

## What is in this repository

| Path | What it is |
| --- | --- |
| `manifest.json`, `config/` | The Freshworks app manifest and its installation settings |
| `app/` | The panel itself — markup, script, styles, icon |
| `tools/` | `pack.sh` and `inline-jssip.mjs` — the packaging workaround |
| `mock-backend/` | A zero-dependency fake backend for local development |
| `app/lib/jssip.min.js` | Vendored JsSIP browser bundle — see [Tests](#tests) for why |
| `tests/` | 54 tests against the real source, run with Vitest in jsdom |
| `ISSUES.md` | Open problems and everything already ruled out. **Read this first** |
| `docs/backend-contract.md` | Every endpoint the backend must implement, and its security requirements |
| `docs/install.md` | Installing as a Freshdesk custom app, with troubleshooting |
| `docs/architecture.md` | How a Freshdesk CTI app works, and what this one does not do yet |

## Known limitations

Honest list, so nobody is surprised. Full detail in **[ISSUES.md](ISSUES.md)**.

- **Inbound reaches the agent through a conference, not by ringing the browser.**
  Vobiz cannot route a call into a registered WebRTC endpoint, so the caller is
  parked and the panel dials in to meet them. It works, and the agent cannot
  tell, but it means the caller waits through the agent's own call setup —
  see [Inbound is slower than outbound](#inbound-is-slower-than-outbound-and-why).
  The underlying platform defect is still open:
  [ISSUES.md #1](ISSUES.md#issue-1--inbound-routing-into-a-webrtc-endpoint-is-blocked-platform-side).
- **A second caller while one is already ringing goes straight to voicemail.**
  One offer per agent at a time; there is no queue.
- **The panel is a softphone, not a full CTI integration.** It does not create
  tickets, log calls as ticket notes, pop the contact record on an inbound call,
  or attach recordings to a ticket. Click-to-call works; the rest is on the
  roadmap in [CHANGELOG.md](CHANGELOG.md).
- **Browser calling only.** There is no option to route calls to an agent's
  mobile or desk phone.
- **No hold, mute, transfer, or conference.**
- **One agent identity per installation**, set by an admin.

## Security

The app stores nothing — no credentials in `localStorage`, no cookies. Your
Vobiz Auth Token goes to your backend and is held there.

The security of this integration is therefore almost entirely the security of
your backend. [docs/backend-contract.md](docs/backend-contract.md#security-requirements)
has the checklist. Please read it.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Maintenance and licence

This app is built and maintained by **Vobiz**. Issues and pull requests are
welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

Licensed under the [MIT Licence](LICENSE), © 2026 Vobiz. It is an official
Vobiz integration, not a Freshworks product; Freshdesk, Freshcaller, and
Freshworks are trademarks of Freshworks Inc., used here only to describe
compatibility.

For anything about the Vobiz platform itself — accounts, numbers, billing —
email [support@vobiz.ai](mailto:support@vobiz.ai) or read the
[Vobiz documentation](https://www.vobiz.ai/docs).
