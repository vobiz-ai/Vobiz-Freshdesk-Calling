# Vobiz Calling for Freshdesk

A calling panel that puts [Vobiz](https://www.vobiz.ai) telephony inside
Freshdesk. Agents place and receive real phone calls from the browser, and play
back call recordings, without leaving the helpdesk.

This is a **custom app**. You install it on your own Freshdesk account — there
is no Marketplace approval to wait for, and it is usually live within about
thirty minutes of upload.

> ## Outbound calling works. Inbound does not yet.
>
> **Outbound is verified end to end** — the panel registers, dials, and carries
> two-way audio in the browser, with both legs billed on the Vobiz CDR.
>
> **Inbound (PSTN → browser) is blocked platform-side.** Routing a call *into* a
> registered WebRTC endpoint with `<Dial><User>` fails: Vobiz builds an
> unparseable gateway URI and drops its own INVITE. The caller hears ringback and
> nothing else. This affects other accounts and Vobiz's own SDK, not just this
> app — see [ISSUES.md](ISSUES.md) for the evidence.
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

**Log in** with your Vobiz Auth ID and Auth Token, then pick the number to call
from. These are entered by the agent at runtime and are not stored by the app.

**Make a call** by typing a number and clicking **Call**, or by clicking any
phone number in Freshdesk — the panel opens and dials automatically.

Audio runs through the browser, so the first call prompts for microphone
permission. The person you call hears a few seconds of ringback after answering
while your browser is bridged in; this is expected, and
[docs/backend-contract.md](docs/backend-contract.md#post-start-call) explains
why.

**Receive calls** by clicking **Enable inbound calls to this panel** once. Keep
the Freshdesk tab open.

**Play recordings** from the Call Recordings section.

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

- **Inbound calls (PSTN → browser) do not connect.** Vobiz drops its own INVITE
  when routing into a registered WebRTC endpoint. Platform-side, not fixable
  here. Outbound is unaffected.
  [ISSUES.md #1](ISSUES.md#issue-1--inbound-routing-into-a-webrtc-endpoint-is-blocked-platform-side).
- **Inbound calls auto-answer**, with no ring, no caller ID and no
  Accept/Decline.
  [ISSUES.md #5](ISSUES.md#issue-5--inbound-calls-auto-answer-with-no-popup).
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
