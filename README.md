# Vobiz Calling for Freshdesk

A calling panel that puts [Vobiz](https://www.vobiz.ai) telephony inside
Freshdesk. Agents place and receive real phone calls from the browser, and play
back call recordings, without leaving the helpdesk.

This is a **custom app**. You install it on your own Freshdesk account — there
is no Marketplace approval to wait for, and it is usually live within about
thirty minutes of upload.

```
Freshdesk  ──cti.triggerDialer──▶  this app  ──HTTPS──▶  your calling backend  ──▶  Vobiz REST API
                                       │                                              │
                                       └──────────── SIP over WebSocket ──────────────┘
                                                      (audio in the browser)
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

1. Pack the app: `fdk pack` — the result is in `dist/`.
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
fdk run                  # terminal 2 — http://localhost:10001
```

Open a Freshdesk page with `?dev=true` appended, and set the app's settings at
<http://localhost:10001/custom_configs>:

| Setting | Value |
| --- | --- |
| Calling backend URL | `http://localhost:8092` |
| Agent identity | anything, e.g. `priya` |
| SIP registrar URL | leave blank |

Any Auth ID and Auth Token are accepted; use `fail` as the Auth ID to see the
error path. See [mock-backend/README.md](mock-backend/README.md) for the rest,
including how to point it at a real Vobiz SIP endpoint to test actual audio.

## Tests

```bash
npm test        # 45 tests, with coverage
fdk validate    # platform and lint rules
fdk pack        # build dist/
```

Current coverage is **97.8% of statements, 100% of functions, 80.8% of
branches** — Freshworks requires 80% on every metric for Marketplace
submission, and `fdk pack` enforces it.

The tests load the real `app/scripts/app.js` and the real markup from
`app/index.html` into jsdom with the Freshworks SDK, JsSIP, and `fetch` faked,
so they exercise the code that ships rather than a copy of it.

> `fdk pack` additionally wants *local simulation* coverage, which is only
> produced by running the app inside a real Freshdesk account via `?dev=true`.
> For local builds use `fdk pack --skip-coverage`; do not use that flag for a
> Marketplace submission.

The whole app is three files — `app/index.html`, `app/scripts/app.js`, and
`app/styles/style.css`. There is no build step and no framework.

## What is in this repository

| Path | What it is |
| --- | --- |
| `manifest.json`, `config/` | The Freshworks app manifest and its installation settings |
| `app/` | The panel itself — markup, script, styles, icon |
| `mock-backend/` | A zero-dependency fake backend for local development |
| `tests/` | 45 tests against the real source, run with Vitest in jsdom |
| `docs/backend-contract.md` | Every endpoint the backend must implement, and its security requirements |
| `docs/install.md` | Installing as a Freshdesk custom app, with troubleshooting |
| `docs/architecture.md` | How a Freshdesk CTI app works, and what this one does not do yet |

## Known limitations

Honest list, so nobody is surprised:

- **The panel is a softphone, not a full CTI integration.** It does not yet
  create tickets, log calls as ticket notes, pop the contact record on an
  inbound call, or attach recordings to a ticket. Click-to-call works; the rest
  is on the roadmap in [CHANGELOG.md](CHANGELOG.md).
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
