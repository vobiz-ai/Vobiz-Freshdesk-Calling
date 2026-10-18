# Vobiz Calling for Freshdesk

A calling panel that puts [Vobiz](https://www.vobiz.ai) telephony inside
Freshdesk. Agents place and receive real phone calls from the browser, and play
back call recordings, without leaving the helpdesk.

This is a **custom app**. You install it on your own Freshdesk account — there
is no Marketplace approval to wait for, and it is usually live within about
thirty minutes of upload.

The repository has two parts, and you run both:

| Part | Where | What it does |
| --- | --- | --- |
| **The panel** | `app/`, `config/`, `manifest.json` | The Freshdesk app. A SIP softphone in the CTI sidebar |
| **The calling backend** | `backend/` | A small Node service you host. Serves any Vobiz account: checks an agent's credentials at sign-in, sets up their SIP line, answers Vobiz's webhooks, signs recording links |

```
  agent clicks a number
          │  cti.triggerDialer
          ▼
   ┌─────────────┐   SIP INVITE over WebSocket    ┌──────────────┐
   │  the panel  │ ─────────────────────────────▶ │    Vobiz     │
   │ (the A leg) │ ◀───────── RTP audio ────────▶ │              │
   └──────┬──────┘                                └──────┬───────┘
          │ HTTPS (sign-in, recordings)                  │ answer URL
          ▼                                              ▼
   ┌──────────────────────────────────────────────────────────┐
   │                calling backend (backend/)                │──▶ PSTN
   └──────────────────────────────────────────────────────────┘
```

**The browser is the A leg.** The panel sends the INVITE itself; Vobiz then asks
the backend's `/answer` what to do with the call, and the backend reaches the
customer. [docs/architecture.md](docs/architecture.md) explains both directions.

## What you need first

- A Freshdesk account on **Growth, Pro, or Enterprise** with admin access.
- A [Vobiz account](https://console.vobiz.ai) with at least one phone number.
  Agents sign in with its Auth ID and Auth Token; the backend creates each
  agent's SIP endpoint for them. Nothing about the account goes in the
  backend's configuration.
- Somewhere to run the backend on **public HTTPS** — a server, or a tunnel for
  testing. Vobiz must be able to reach it.
- Node **20+** for the backend, and Node **24.11.1** with FDK 10.1.9 to pack the
  app.

> **Freshcaller cannot be enabled at the same time as a CTI app**, and Freshdesk
> allows only one CTI app to be active at a time. Installing this replaces
> whatever telephony your account uses today.

## 1. Run the calling backend

```bash
git clone https://github.com/vobiz-ai/Vobiz-Freshdesk-Calling.git
cd Vobiz-Freshdesk-Calling
cp backend/.env.example backend/.env     # then fill it in
npm run backend                          # http://127.0.0.1:8093
```

`backend/.env.example` documents every variable. None of them is a Vobiz
credential, number or endpoint — the backend serves whichever account an agent
signs in with. The ones to set:

| Variable | Value |
| --- | --- |
| `PUBLIC_BASE` | The public `https://` URL Vobiz reaches the backend on, no trailing slash |
| `SIGNING_SECRET` | A long random value (`openssl rand -hex 32`) that signs recording links |
| `DATA_DIR` (optional) | Where the endpoint map is kept. Default `backend/data` |

Put the backend behind HTTPS (a reverse proxy, or a tunnel for testing). There
is nothing to configure in the Vobiz console for **Vobiz account** sign-in:

1. **At sign-in**, the backend checks the Auth ID and Auth Token with Vobiz
   (`GET /numbers`), and refuses the pair if Vobiz does.
2. In that account it finds this integration's **Application** — the one whose
   answer URL is `PUBLIC_BASE/answer` — or creates it. An application anyone
   else made is never changed.
3. It finds the agent's own **SIP endpoint** (one per account and agent
   identity), or creates it, sets a fresh random SIP password that only that
   browser session receives, and binds the endpoint to the application.
   `backend/data/endpoints.json` remembers `{authId:agentId → endpointId,
   username}` — ids only, mode 0600, gitignored.
4. **Enable inbound calls** in the panel attaches the agent's selected number to
   the application. It is a separate, explicit step because it moves the number
   off whatever application it was on; the panel says which one.

The Auth Token stays in the backend's memory, keyed by Auth ID. It is never
logged, written to disk, or sent back to the browser. After a restart, agents
sign in again; a recording link for an account nobody has signed in to since
then answers "sign in again".

### SIP direct

The panel's **SIP direct** tab signs in with an existing endpoint instead: its
SIP username and password, and the caller ID to use. No account credentials are
involved, so the backend cannot set anything up — you bind things yourself,
once, so that Vobiz sends the calls to this backend:

1. In the Vobiz console, create an **Application** with answer URL
   `PUBLIC_BASE/answer`, method `POST` (API: `POST /Account/{auth_id}/Application/`
   with `answer_url`, `answer_method`).
2. Open the **Endpoint** and set its application to that one (API:
   `POST /Account/{auth_id}/Endpoint/{endpoint_id}/` with `{"app_id": "<app_id>"}`).
3. To receive calls, attach the **number** you use as caller ID to the same
   application (API: `POST /Account/{auth_id}/numbers/%2B<digits>/application`
   with `{"application_id": "<app_id>"}`).

In SIP direct, outbound calls use `<Dial><Number>` with the typed caller ID
(Vobiz refuses a number the account does not own), inbound calls to that number
ring the agent, and recordings, the number list and **Enable inbound calls** are
hidden — they need a Vobiz account sign-in. The backend cannot verify a SIP-direct
claim, so prefer account sign-in on a backend shared by several companies.

## 2. Pack and install the app

```bash
nvm install 24.11.1 && nvm use 24.11.1
npm install https://cdn.freshdev.io/fdk/latest-v24.tgz -g
npm install
npm run pack            # → dist/vobiz-freshdesk-calling.zip
```

Then follow **[docs/install.md](docs/install.md)**: create a Custom App in the
Freshdesk Developer Portal, upload the zip, install it, and set:

- **Calling backend URL** — the backend's `https://` URL.
- **Agent identity** — which agent this installation is. Every agent needs a
  different value.

> **Use `npm run pack`, not a bare `fdk pack`.** FDK lints every `.js` file under
> `app/`, vendored dependencies included, and JsSIP's `var` declarations abort
> the pack. `tools/pack.sh` packs a copy with JsSIP inlined into `index.html`,
> which FDK does not lint. The source tree is never modified.

## Using it

1. Open any agent page and click the Vobiz icon at the bottom left.
2. **Sign in** on the **Vobiz account** tab with your Auth ID and Auth Token —
   any Vobiz account works. The backend checks them with Vobiz, sets up your SIP
   line and returns a session; the token is not stored by the panel. Or use the
   **SIP direct** tab with an endpoint you already have (see above). The badge
   goes from *Signed out* to *Ready* once the panel has registered.
3. **Pick the number** to call from. The list is the account's active,
   voice-enabled numbers; the backend refuses anything else.
4. **Call** by typing a number, or click any phone number in Freshdesk. The
   first call asks for microphone permission.
5. **Receive calls** by clicking **Enable inbound calls** once. Keep the
   Freshdesk tab open — the panel answers incoming calls automatically.
6. **Play recordings** from the Call Recordings list (set `RECORD_CALLS=1` on the
   backend to record).

## Run it locally

You can develop the panel with no Vobiz account, against the mock backend:

```bash
npm install
npm run mock-backend     # terminal 1 — http://localhost:8092
npm run dev              # terminal 2 — http://localhost:10001
```

`npm run dev` is `fdk run --skip-coverage --skip-validation lint`, and both flags
are load-bearing: without the first, FDK instruments the 281 KB JsSIP bundle and
the tab hangs; without the second, JsSIP's lint errors stop the server starting.

On the **first** `fdk run`, FDK asks which account to simulate at
<http://localhost:10001/system_settings>: **Organization Domain** without the
scheme (`yourcompany.freshdesk.com`), **account URL** with it. Then set the app's
settings at <http://localhost:10001/custom_configs>:

| Setting | Value |
| --- | --- |
| Calling backend URL | `http://localhost:8092` (mock) or `http://localhost:8093` (real backend) |
| Agent identity | anything, e.g. `priya` |
| SIP registrar URL | leave blank |

Open a Freshdesk page with `?dev=true` appended to load the panel from your
machine.

With the mock, any Auth ID and Auth Token are accepted (`fail` as the Auth ID
shows the error path) and no call is placed. Its **SIP direct** tab hands back
whatever endpoint you type, so you can test real registration. To place real calls, run the real
backend instead with `PUBLIC_BASE` set to a public HTTPS tunnel to port 8093.

> **On ngrok's free tier**, the browser interstitial breaks requests unless they
> carry `ngrok-skip-browser-warning`. The panel sends it and the backend allows
> it in CORS.

## Tests

```bash
npm test        # panel and backend, with coverage
fdk validate    # Freshworks platform rules
npm run pack    # build dist/vobiz-freshdesk-calling.zip
```

The panel tests load the real `app/scripts/app.js` and the real markup from
`app/index.html` into jsdom with the Freshworks SDK, JsSIP and `fetch` faked. The
backend tests start the real `backend/server.js` and drive it over HTTP, with
only the Vobiz API faked — a stateful fake with two accounts. They cover two
accounts signing in to distinct endpoints, wrong tokens, webhook routing by SIP
user, `ParentAuthID` and dialled number, the 17-digit application id surviving
intact, account-scoped recording links, SIP direct, and the security checks
(SIP password, Auth Token never in a response, CORS, path traversal, webhook
signatures).

`fdk validate` reports 0 platform errors. Its lint count is JsSIP's, from the
vendored bundle, and does not reach the packed app.

The vendored `app/lib/jssip.min.js` exists because **JsSIP has no browser build
on any CDN**. Rebuild it with:

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
| `app/` | The panel — markup, script, styles, icon, vendored JsSIP |
| `backend/` | The calling backend you run |
| `mock-backend/` | A fake backend for developing the panel without a Vobiz account |
| `tools/` | `pack.sh` and `inline-jssip.mjs` — the packaging workaround |
| `tests/` | Panel tests (jsdom) and backend tests (real HTTP) |
| `docs/backend-contract.md` | Every route the backend serves, and why |
| `docs/architecture.md` | How calls flow in each direction |
| `docs/install.md` | Installing as a Freshdesk custom app, with troubleshooting |
| `ISSUES.md` | Known limitations |

## Known limitations

- **Inbound calls auto-answer**, with no ring, caller ID or Accept/Decline.
- **The panel is a softphone, not a full CTI integration.** It does not create
  tickets, log calls, pop the contact on an inbound call, or attach recordings.
  Click-to-call works.
- **No hold, mute, transfer, or conference controls.**
- **Sessions and Auth Tokens live in the backend's memory.** Restarting it signs
  everyone out (the endpoint map survives, so they get the same endpoint back),
  and it runs as a single instance.

Detail in [ISSUES.md](ISSUES.md).

## Security

The panel stores nothing — no credentials in `localStorage`, no cookies. The
Auth Token is sent once, to your backend, at sign-in, and held there in memory
only.

The backend issues a session token at sign-in and requires it for the SIP
identity, caller-ID changes, inbound setup and recordings; it answers CORS only
for Freshdesk and localhost origins; it serves recordings only through signed,
expiring links scoped to one account; and it checks Vobiz's webhook signatures
with the Auth Token of the account each call belongs to. See
[docs/backend-contract.md](docs/backend-contract.md#security) and
[SECURITY.md](SECURITY.md).

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
