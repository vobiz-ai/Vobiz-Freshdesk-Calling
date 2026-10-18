# Vobiz Calling for Freshdesk

Vobiz Calling for Freshdesk adds a phone to Freshdesk. Your agents make and
receive real phone calls in the browser, through your Vobiz account, from a
panel in the Freshdesk sidebar. They don't need a desk phone or a desktop app,
and they don't have to leave the helpdesk.

There are two parts, and you run both. **The panel** is a Freshdesk custom app
that you upload to your own Freshdesk account. **The calling backend** is a
small Node service that you host. The panel talks to the backend, and Vobiz
calls the backend to find out how to connect each call.

**What it does**

- **Click-to-call.** An agent clicks any phone number in Freshdesk and the panel
  opens and dials it. Agents can also type a number into the panel.
- **Inbound calls in the browser.** Calls to your Vobiz number ring the panel,
  and the panel picks them up.
- **Caller ID choice.** Agents choose which of your Vobiz numbers their calls
  come from.
- **Call recording.** Turn it on for every call, then play recent recordings
  in the panel.
- **Two ways to sign in.** Sign in with a **Vobiz account** (an Auth ID and
  Auth Token), and the backend sets up the phone line for you. Or use **SIP
  direct** to sign in with a SIP endpoint you already have.
- **One backend for many accounts.** One backend serves any number of Vobiz
  accounts. You don't put any account details in its configuration.

The app does not write anything into Freshdesk. It does not create tickets, add
call notes or look up contacts. See [Limitations](#limitations).

## How it works

```
  Agent clicks a number in Freshdesk
              │
              ▼
   ┌─────────────────────┐   SIP over WebSocket (audio)   ┌─────────┐
   │  Panel (Freshdesk)  │ ◀────────────────────────────▶ │  Vobiz  │ ◀──▶ phone network
   └──────────┬──────────┘                                └────┬────┘
              │ HTTPS: sign-in, caller ID,                     │ HTTPS webhooks:
              │ inbound setup, recordings                      │ "what do I do with this call?"
              ▼                                                ▼
   ┌───────────────────────────────────────────────────────────────┐
   │          Your calling backend (backend/, public HTTPS)          │
   └───────────────────────────────────────────────────────────────┘
```

- The panel is a softphone. It registers with Vobiz over SIP-over-WebSocket,
  and the call audio runs in the browser tab.
- When an agent signs in, the backend checks the credentials with Vobiz. In that
  account it then sets up an application that points at the backend and a SIP
  endpoint for the agent.
- **Outbound:** the panel calls Vobiz, and Vobiz asks the backend's `/answer`
  URL what to do. By default the backend places the agent in a private
  conference room, then dials the customer into that room from the caller ID
  the agent chose.
- **Inbound:** a call to your number reaches `/answer`. The backend rings every
  agent who is signed in to that Vobiz account, and the panel answers.
- **Recordings:** the backend lists them and gives the panel a playback link
  that is signed and short-lived. Your Auth Token never reaches the browser.

## Requirements

| You need | Details |
| --- | --- |
| A Vobiz account | Your **Auth ID** and **Auth Token** from the [Vobiz Console](https://console.vobiz.ai) dashboard, under **API credentials**. The Auth Token is not your login password. You also need **at least one active, voice-enabled phone number** and a positive **balance**. |
| Freshdesk | The **Growth, Pro or Enterprise** plan (these plans support CTI apps), and an **admin** login to upload and install a custom app. **Freshcaller must be turned off.** Freshdesk runs only one CTI app at a time, and this app replaces your current telephony. |
| A public HTTPS URL for the backend | Vobiz must reach the backend over `https://` with a valid certificate. You can use a server behind a reverse proxy, or a tunnel while you test, for example `https://calling.example.com`. |
| Node.js | **Node 20 or later** to run the backend. **Node 24.11.1** with the Freshworks CLI (`fdk`) **10.1.9** to run the app locally and to pack it. |
| A browser and a microphone | A current desktop browser with WebRTC, a microphone, and a network that allows WebSocket connections to `wss://registrar.vobiz.ai:5063`. |

## Quick start

1. **Clone the repository and install.**

   ```bash
   git clone https://github.com/vobiz-ai/Vobiz-Freshdesk-Calling.git
   cd Vobiz-Freshdesk-Calling
   npm install
   ```

2. **Configure the backend.** Copy the example file, then set two values:

   ```bash
   cp backend/.env.example backend/.env
   openssl rand -hex 32        # paste the output as SIGNING_SECRET
   ```

   ```ini
   PUBLIC_BASE=https://calling.example.com
   SIGNING_SECRET=<the 64 hex characters from openssl>
   ```

   `backend/.env` holds deployment settings only. It never contains a Vobiz
   Auth ID, Auth Token, phone number or endpoint. See the
   [configuration reference](#configuration-reference) for every setting.

3. **Start the backend.**

   ```bash
   npm run backend             # listens on http://127.0.0.1:8093
   ```

   The startup banner shows the answer URL, the outbound mode, and whether
   recording is on.

4. **Make the backend public.** Point `https://calling.example.com` at
   `127.0.0.1:8093` with a reverse proxy, or use a tunnel while you test. Then
   check it from outside:

   ```bash
   curl https://calling.example.com/health      # {"ok":true}
   ```

5. **Pack the Freshdesk app.**

   ```bash
   nvm install 24.11.1 && nvm use 24.11.1
   npm install -g https://cdn.freshdev.io/fdk/latest-v24.tgz
   npm run pack                # writes dist/vobiz-freshdesk-calling.zip
   ```

6. **Upload and install it as a custom app.** In Freshdesk, go to
   **Admin → Apps → Go to Developer Portal → Create New App → Custom App**.
   Upload the zip, then **Save and Publish** and **Promote to Live**. Next, go to
   **Admin → Apps → Manage Apps → Custom**, click **Install** on the app, and
   fill in:

   | Setting | Value |
   | --- | --- |
   | **Calling backend URL** | `https://calling.example.com`, with no trailing slash |
   | **SIP registrar URL (optional)** | Leave blank. It defaults to `wss://registrar.vobiz.ai:5063/` |

   There is nothing to set per agent: each agent's own Freshdesk login decides
   which SIP line they get. [docs/install.md](docs/install.md) walks through
   these screens step by step.

7. **Sign in.** Open any agent page in Freshdesk and click the Vobiz icon at the
   bottom left. On the **Vobiz account** tab, enter your Auth ID and Auth Token
   and click **Log in**. When the badge turns **Ready**, you can make a call.

### Try it before you upload (local FDK)

To run the panel from your machine inside your real Freshdesk account before
you upload it:

```bash
npm run backend             # terminal 1. PUBLIC_BASE must still be public HTTPS.
npm run dev                 # terminal 2: fdk run on http://localhost:10001
```

1. The first time you run `fdk run`, it asks which account to simulate, at
   <http://localhost:10001/system_settings>. Enter the **Organization Domain**
   without `https://` (for example `yourcompany.freshdesk.com`) and the account
   URL with it.
2. Set the installation parameters at <http://localhost:10001/custom_configs>.
   For **Calling backend URL**, use `http://localhost:8093`. The panel accepts
   plain `http` only for `localhost`.
3. Open any Freshdesk agent page with `?dev=true` added to the URL. Freshdesk
   then loads the panel from your machine.

## Signing in

The panel has two tabs. Agents sign in each time they open the panel. The
panel keeps no credentials, so reloading the Freshdesk tab also means signing in
again.

### Vobiz account (recommended)

Enter your **Auth ID** (`MA_XXXXXXXX`) and **Auth Token**, then click **Log in**.
The backend checks them with Vobiz by listing the account's phone numbers. If
Vobiz refuses them, so does the panel.

The first time anyone signs in, the backend creates these in your Vobiz account:

| What | Details |
| --- | --- |
| **One application** | Named `Freshdesk-Calling`. You can change the name with `VOBIZ_APP_NAME`. Its answer URL and hangup URL are both `https://calling.example.com/answer` (method `POST`). If an application with that answer URL already exists, the backend reuses it. It never changes an application that it did not create. |
| **One SIP endpoint per Freshdesk agent** | Alias `Freshdesk-fd<Freshdesk user ID>`, with a username that starts with `fd`. The endpoint is attached to the application above. The backend reuses this endpoint on later sign-ins. |

The panel reads the logged-in Freshdesk agent and signs in as `fd<their user
ID>`, so colleagues who share one Vobiz account each get their own line and
never sign each other out. Each sign-in gives the endpoint a new random SIP
password. Only that browser session receives it. Signing in again as the same
Freshdesk agent (for example in a second tab) ends the previous session.

**Sign out.** Click **Sign out** under the sign-in form. The panel ends any call,
tells the backend, unregisters from Vobiz so inbound calls stop ringing that
browser, and returns to **Signed out**. When the last agent of a Vobiz account
signs out, or their session expires, the backend drops that account's Auth
Token from memory — after any outbound call still in progress has ended.

**Choose a caller ID.** The **Calling from** list shows every active,
voice-enabled number on the account. Your outbound calls come from the number
you pick. The backend accepts only numbers on that account. The panel remembers
your choice for your next sign-in, until the backend restarts.

**Enable inbound calls.** Click **Enable inbound calls** once for each number.
This attaches the selected number to the `Freshdesk-Calling` application, so
calls to it ring the panel. Attaching the number **moves it off the application
it is on now**. Before you click, the panel names that application, with its ID:
*"+91XXXXXXXXXX is attached to application "My IVR" (…) now; enabling moves it to
this panel's."* (only the ID if the name can't be read), or says the number
already rings this panel. Anything
that number did before, such as an IVR or another integration, stops. Nothing
moves until you click the button.

### SIP direct

Use this tab to sign in with a Vobiz SIP endpoint you already have. Enter:

- **SIP username**: the endpoint's username as the Console shows it, letters
  and digits only.
- **SIP password**: the endpoint's password.
- **Caller ID (E.164)**: a number on the same Vobiz account, for example
  `+91XXXXXXXXXX`.

Then click **Connect**. The backend has no account credentials in this mode,
so it cannot set anything up for you. Before you sign in, attach the endpoint,
and the number if you want inbound calls, to an application whose answer URL is
your backend's `/answer`.

**In the Vobiz Console**

1. Go to **Voice → Applications** and click **+ Create New Application**. Set the
   **Answer URL** to `https://calling.example.com/answer` with method **POST**.
2. Open **Voice → Endpoints**, edit your endpoint, and set its **Application** to
   the one you just created.
3. To take inbound calls, open the application, go to the **Phone Numbers** tab,
   and click **+ Attach Number**. Attach the number you will use as the caller ID.

**Or with the Vobiz API** (base URL `https://api.vobiz.ai/api/v1`, headers
`X-Auth-ID` and `X-Auth-Token`):

```bash
# 1. Create the application. Note the app_id in the response.
curl -X POST "https://api.vobiz.ai/api/v1/Account/MA_XXXXXXXX/Application/" \
  -H "X-Auth-ID: MA_XXXXXXXX" -H "X-Auth-Token: $VOBIZ_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"app_name":"Freshdesk-Calling","answer_url":"https://calling.example.com/answer","answer_method":"POST"}'

# 2. Attach the endpoint to it
curl -X POST "https://api.vobiz.ai/api/v1/Account/MA_XXXXXXXX/Endpoint/<endpoint_id>/" \
  -H "X-Auth-ID: MA_XXXXXXXX" -H "X-Auth-Token: $VOBIZ_AUTH_TOKEN" \
  -H "Content-Type: application/json" -d '{"app_id":"<app_id>"}'

# 3. For inbound calls, attach the number (+ is written as %2B)
curl -X POST "https://api.vobiz.ai/api/v1/Account/MA_XXXXXXXX/numbers/%2B91XXXXXXXXXX/application" \
  -H "X-Auth-ID: MA_XXXXXXXX" -H "X-Auth-Token: $VOBIZ_AUTH_TOKEN" \
  -H "Content-Type: application/json" -d '{"application_id":"<app_id>"}'
```

SIP direct does not have these features:

- The caller-ID list (you type one caller ID instead), **Enable inbound calls**,
  and the recordings list. These all need the account API.
- The conference bridge for outbound calls. SIP direct calls always use a plain
  dial. See `OUTBOUND_MODE`.
- Checks by the backend. The registrar checks the password, and Vobiz refuses a
  caller ID that the account doesn't own, but the backend can't confirm that
  the endpoint and the number belong together.

SIP direct cannot take over an endpoint that a Vobiz account sign-in created.

## Using it

**Making a call.** Type a number in E.164 format (`+91XXXXXXXXXX`) and click
**Call**, or click any phone number in Freshdesk. The **Call** button works only
when you are signed in **and** the panel is registered. If either is missing,
the hint under the button says which. Your browser asks for microphone access
on the first call. Click **Hang up** to end the call.

With the default conference bridge, your side joins a private room first and
the customer is then dialled into it. The panel shows **Ringing** while their
phone rings (you hear silence) and **On a call** once they answer. If the
customer doesn't answer, the backend ends your side of the call. With SIP
direct or `OUTBOUND_MODE=dial` the panel can't see the customer's leg, so it
shows **On a call** as soon as your side connects.

**Taking a call.** Keep a Freshdesk tab open with the panel signed in and
showing **Ready**. When a call reaches your number, every agent signed in to
that Vobiz account rings, and the first panel to pick up **answers
automatically**. If nobody is signed in, the caller hears *"Sorry, nobody is available to take your call."*

**Call logging.** Nothing is written to Freshdesk. Vobiz keeps a call log for
every call in your account, and you can see it in the Console under
**Voice → Call Logs**.

**Recordings.** Set `RECORD_CALLS=1` on the backend to record both sides of
every call, inbound and outbound. Recording is off by default. Tell the people
you call that you record. The panel's **Call recordings** list shows the 15 most
recent recordings on the Vobiz account. Click the refresh button to update it,
and click **▶ Play** to listen. The list refreshes itself a few seconds after
an outbound call ends. Each playback link stops working after 5 minutes. The
recordings stay in your Vobiz account.

## Configuration reference

The backend reads `backend/.env` when it starts. A variable that is already set
in the environment takes priority over the file.

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `PUBLIC_BASE` | **Yes** | none | The public `https://` URL Vobiz uses to reach the backend, with no trailing slash. The answer URL is `PUBLIC_BASE/answer`. Sign-in fails if it isn't `https://`. |
| `SIGNING_SECRET` | Recommended | A random value at each start | The key that signs recording playback links. If you don't set it, links stop working whenever the backend restarts. Generate one with `openssl rand -hex 32`. |
| `PORT` | No | `8093` | The port to listen on. |
| `HOST` | No | `127.0.0.1` | The address to listen on. Set `0.0.0.0` in a container, or when the proxy runs on another host. |
| `DATA_DIR` | No | `backend/data` | Where the endpoint map (`endpoints.json`) is kept. |
| `OUTBOUND_MODE` | No | `conference` | `conference`: the agent waits in a private room and the customer is dialled into it. `dial`: a plain dial to the customer. SIP direct always uses `dial`. |
| `RECORD_CALLS` | No | off | `1`, `true` or `yes` records every call in both directions. |
| `INBOUND_RING_SECONDS` | No | `30` | How long an inbound call rings the agents, and in `dial` mode how long the customer's phone rings. The value is held between 5 and 120. |
| `SESSION_TTL_HOURS` | No | `12` | How long a panel sign-in lasts. |
| `RECORDING_URL_TTL_SECONDS` | No | `300` | How long a recording playback link works. |
| `VOBIZ_WEBHOOK_SIGNATURE` | No | `log` | `off`, `log` or `require`. Checks the Vobiz signature on each webhook. `log` records failures and lets the request through. `require` rejects it. |
| `VOBIZ_APP_NAME` | No | `Freshdesk-Calling` | The name of the application that sign-in creates in each account. |
| `ALLOWED_ORIGINS` | No | none | Extra browser origins that can call the backend, separated by commas. You can write wildcards as `https://*.example.com`. Origins on `*.freshdesk.com`, `*.myfreshworks.com`, `*.freshworks.com` and `localhost` are already allowed. |
| `VOBIZ_API_BASE` | No | `https://api.vobiz.ai` | The Vobiz API host. Change it only if Vobiz support asks you to. |

The Freshdesk app has two installation parameters: **Calling backend URL** and
**SIP registrar URL (optional)**. There is no per-agent setting: the agent
identity is `fd<Freshdesk user ID>` of whoever is logged in. To change them later, go to
**Admin → Apps → Manage Apps → Custom → Vobiz Calling → Settings → Configure**.

## Deploying to production

- **Serve over HTTPS** on a stable hostname with a valid certificate. Vobiz
  doesn't call plain `http`. Every path must be reachable from the internet:
  the backend routes `/answer`, `/dial-status`, `/outbound-join`,
  `/outbound-hangup`, `/outbound-wait` and `/conf-event` for Vobiz, and
  everything else for the panel.
- **Run exactly one instance.** Sessions, signed-in accounts and active calls
  are held in memory. With a second instance behind a load balancer, webhooks
  and sign-ins land on different processes, and calls fail.
- **Keep `DATA_DIR` on persistent storage.** It maps each account and Freshdesk
  agent to that agent's endpoint, so agents get the same endpoint after a
  restart. If you lose it, the backend finds the endpoints again by their
  aliases.
- **Set `SIGNING_SECRET`** to a fixed random value.
- **Set `VOBIZ_WEBHOOK_SIGNATURE=require`** once the log shows that signatures
  verify. Leave it at `log` if your agents only use SIP direct. See
  [Security and privacy](#security-and-privacy).
- **Expect agents to sign in again after a restart.** Auth Tokens live only in
  memory. Until an agent from an account signs in again, calls for that account
  can't be routed.
- **Package the Freshdesk app** with `npm run pack`, not a bare `fdk pack`.
  `fdk pack` stops on lint errors in the bundled SIP library. The script packs
  a copy with that library inlined into the page, and your source tree is not
  changed. Upload `dist/vobiz-freshdesk-calling.zip` as a custom app, as in
  [Quick start](#quick-start). To ship an update, upload the new zip to the
  same custom app in the Developer Portal.

## Security and privacy

- **Your Auth Token never leaves the backend and is never stored on disk.** The
  panel sends it once, at sign-in. The backend keeps it in memory, never logs it,
  never returns it to the browser, and never puts it in a URL. It stays in
  memory only while an agent of that account is signed in (or a call they
  placed is still up), and is dropped at sign-out or session expiry.
- **The panel stores nothing.** It uses no cookies, `localStorage` or
  `sessionStorage`. The session token from sign-in lives in the page's memory
  and disappears when the tab reloads.
- **Everything the browser asks for requires that session token.** That
  includes the SIP password. An agent identity (`fd<user ID>`) on its own gets nothing.
- **The browser receives:** a session token, the account's phone numbers and
  the ID and name of the application each number is attached to, its own endpoint's SIP
  username and current password, and signed playback links.
- **On disk**, the backend keeps only `DATA_DIR/endpoints.json`. That file holds
  endpoint IDs and usernames, with no passwords or tokens, and has file mode
  `0600`.
- **Recordings** are reached only through signed links that expire, made for one
  account. A link for one account cannot fetch another account's audio. The
  backend fetches the audio itself, and only from Vobiz media hosts. It never
  fetches a URL that a browser gives it.
- **CORS** allows only Freshdesk and Freshworks origins, `localhost`, and
  anything you add in `ALLOWED_ORIGINS`. It never allows `*`. The backend logs
  any origin it refuses.
- **Webhook signatures.** The backend checks Vobiz's `X-Vobiz-Signature-V3` header
  on every webhook. It uses the Auth Token of the account the call belongs to.
  The signature covers the URL, so `PUBLIC_BASE` must exactly match the URL
  Vobiz calls.
- **The backend serves no files from disk.**

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Troubleshooting

The panel's status line and the backend's console log usually name the problem.
The log prints every webhook with its `CallUUID`.

| Symptom | Cause | Fix |
| --- | --- | --- |
| "Not configured — set the Calling backend URL…" | The installation parameter is empty | Fill it in under **Manage Apps → Custom → Vobiz Calling → Settings**. |
| "Could not identify the signed-in Freshdesk agent" | Freshdesk did not return the logged-in agent to the app | Reload the Freshdesk page. |
| "Backend URL must start with https://" | The URL has no scheme, or uses `http` for a host other than localhost | Enter the full `https://…` URL. |
| "Cannot reach the calling backend" | The backend is down, the URL is wrong, or the backend refused the page's origin | Check `curl https://calling.example.com/health`. If the log says `origin … is not allowed`, add that origin to `ALLOWED_ORIGINS`. |
| "Login failed: Vobiz did not accept that Auth ID and Auth Token" | Wrong credentials, or you used the Console password | Copy both again from Console → **API credentials**. |
| "Login failed: This backend has no PUBLIC_BASE…" | `PUBLIC_BASE` is not set, or is not `https://` | Set it in `backend/.env` and restart. |
| "Login failed: Could not set up this agent's phone line…" | Vobiz refused to create the application or endpoint | The backend log shows Vobiz's status code. Check the account's permissions and balance. |
| "Logged in … — this account has no phone numbers yet", and **Call** stays disabled | The account has no active, voice-enabled number | Buy or activate a number, then sign in again. |
| "Registration failed: …" | The SIP password was rejected, or WebSocket traffic to the registrar is blocked | With a Vobiz account, sign in again, because each sign-in sets a new password. With SIP direct, check the username and password. Allow `wss://registrar.vobiz.ai:5063`. |
| The panel signs out, or registration fails, after you open it in another tab | Each Freshdesk agent has one session; a new sign-in replaces the previous one | Use the panel in one tab at a time. |
| Outbound call ends at once, and the backend log says "no signed-in agent holds" | The backend restarted, or the session expired | Sign in again. |
| Outbound call fails, and no `/answer` webhook appears in the backend log | The endpoint is not attached to an application whose answer URL is `/answer` | With a Vobiz account, sign in again (the log says whether the attach worked). With SIP direct, attach the endpoint as in [SIP direct](#sip-direct). |
| You hear "The call could not be placed." | Vobiz refused the call to the customer | The log shows Vobiz's reason. Check the balance, the destination number and the caller ID. |
| You hear "This account has no phone number to call from." | No caller ID was selected | Pick a number in **Calling from**. |
| Inbound callers hear "Sorry, nobody is available…" | Nobody is signed in to the account that owns the number | Sign in, and keep the panel open. |
| Inbound callers hear ringing, but the panel never rings | The number is not attached to the application, or no panel is open and registered | Click **Enable inbound calls**. With SIP direct, attach the number in the Console. Keep the tab open. |
| Connected but no audio, or "Could not answer — microphone permission was refused" | The browser blocked the microphone | Allow the microphone for Freshdesk in the address bar, then reload. |
| A recording won't play, or "sign in again" | The link expired after 5 minutes, or nobody from that account is signed in right now | Click the refresh button on the list, or sign in again. |
| Webhooks get `403`, and the log says "rejected" | `VOBIZ_WEBHOOK_SIGNATURE=require` with a `PUBLIC_BASE` that doesn't match the URL Vobiz calls, or nobody signed in with a Vobiz account | Fix `PUBLIC_BASE`, or set the mode to `log`. |

## Limitations

- **Nothing is written to Freshdesk.** The app does not create tickets, add call
  notes, show the caller's contact (screen pop) or attach recordings. The only
  link to Freshdesk data is click-to-call.
- **Inbound calls answer themselves.** The panel doesn't ring first, doesn't
  show the caller's number, and has no Accept or Decline buttons.
- **There are no hold, mute, transfer or conference controls.**
- **Sign in again after reloading the page,** after the backend restarts, and
  after `SESSION_TTL_HOURS` (12 hours by default).
- **Run one backend instance.** Sessions and Auth Tokens are held in memory.
- **With SIP direct or `OUTBOUND_MODE=dial`, the panel shows "On a call" while
  the customer's phone is still ringing.** Only the conference bridge reports
  when the customer answers.
- **SIP direct has no recordings list, no caller-ID list and no
  Enable inbound calls,** and outbound calls always use a plain dial. Inbound calls
  to a SIP-direct number ring the agents signed in with that caller ID.
- **The recordings list covers the whole Vobiz account,** not just your own calls.
- **Calls run only in the browser.** They can't be routed to a mobile or a desk
  phone, and inbound calls need an open, signed-in Freshdesk tab.

## Development

```bash
npm install
npm test                    # panel and backend tests, with coverage (80% minimum)
fdk validate                # Freshworks platform rules (Node 24.11.1, FDK 10.1.9)
npm run pack                # builds dist/vobiz-freshdesk-calling.zip
```

To work on the panel without a Vobiz account, run the mock backend. It accepts
any credentials and places no calls:

```bash
npm run mock-backend        # terminal 1: http://localhost:8092
npm run dev                 # terminal 2: http://localhost:10001
```

Set **Calling backend URL** to `http://localhost:8092` at
<http://localhost:10001/custom_configs>, and open Freshdesk with `?dev=true`. See
[mock-backend/README.md](mock-backend/README.md). Never deploy the mock backend.

| Path | What it is |
| --- | --- |
| `manifest.json`, `config/iparams.json` | The Freshworks app manifest (the CTI sidebar placement) and the installation parameters |
| `app/` | The panel: `index.html`, `scripts/app.js`, `styles/`, and the bundled JsSIP library in `lib/` |
| `backend/server.js`, `backend/.env.example` | The calling backend. It uses only Node's standard library. |
| `mock-backend/` | A fake backend for panel development |
| `tools/` | `pack.sh` and `inline-jssip.mjs`, which build the installable zip |
| `tests/` | Panel tests (jsdom) and backend tests (real HTTP, with the Vobiz API faked) |
| `docs/install.md` | Installing the custom app in Freshdesk |
| `docs/architecture.md` | How calls flow, for people changing the code |
| `docs/backend-contract.md` | Every backend route and webhook, for people changing or replacing the backend |

See [CONTRIBUTING.md](CONTRIBUTING.md) before you open a pull request.

## Support and links

- Vobiz documentation: <https://www.vobiz.ai/docs>
- This integration's documentation page: <https://www.vobiz.ai/docs/integrations/freshdesk>
- Vobiz Console: <https://console.vobiz.ai>
- Accounts, numbers and billing: [support@vobiz.ai](mailto:support@vobiz.ai)
- Bugs and feature requests: [GitHub issues](https://github.com/vobiz-ai/Vobiz-Freshdesk-Calling/issues).
  Include the panel's status message, the backend log around the call, and the
  hangup cause from the Vobiz call log. Leave out Auth IDs, tokens and phone
  numbers.

## License

[MIT](LICENSE) © 2026 Vobiz. This is an official Vobiz integration. It is not a
Freshworks product. Freshdesk, Freshcaller and Freshworks are trademarks of
Freshworks Inc., and they are named here only to describe compatibility.
