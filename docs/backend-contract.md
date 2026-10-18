# Calling backend contract

The panel is a client. It holds no Vobiz credentials and cannot place a call on
its own — it talks to a **calling backend**, which serves any Vobiz account: it
checks the credentials an agent signs in with, sets up that agent's SIP line in
that account, answers Vobiz's webhooks, and signs recording links. Nothing about
an account is configured on the backend.

**`backend/` in this repository implements this contract.** This document is for
anyone running it, changing it, or writing their own.

## Why a backend exists at all

1. **Vobiz Auth Tokens are account-level API credentials.** They must never
   reach client-side code. The backend holds each signed-in account's token in
   memory, keyed by Auth ID; the browser never sees it after sign-in.
2. **Vobiz needs an answer URL.** When the panel dials, Vobiz asks a URL what to
   do with the call. That URL has to be a public HTTPS service.
3. **An `<audio>` element cannot send authentication headers**, and recordings
   are protected. Playback needs a server-side step.

## Authentication

`POST /login` (Vobiz account) or `POST /login-sip` (SIP direct) returns a
**bearer token**. Every other browser route requires
`Authorization: Bearer <token>`, and routes that name an agent only answer for
the agent the token was issued to. Without the token the backend answers `401`
— including `/agent/{agentId}`, which is what holds the SIP password.

The panel keeps the token in memory only. Reloading the tab means signing in
again.

## Routes the browser calls

All relative to the `backend_url` installation parameter. The panel requires
HTTPS (or `http://localhost` for development) and strips trailing slashes.

### `POST /login`

```json
{ "agentId": "fd1001", "displayName": "Priya", "authId": "MA_XXXXXXXX", "authToken": "..." }
```

Any Vobiz account. The backend:

1. Lists the account's numbers with those credentials —
   `GET /Account/{authId}/numbers?page=N&per_page=100`, every page. A non-2xx
   answer is a `401`. The caller-ID list is the `active`, voice-enabled items.
2. Finds this integration's application in that account (answer URL
   `PUBLIC_BASE/answer`) or creates it. Applications it did not create are
   never changed.
3. Finds the agent's endpoint — from `backend/data/endpoints.json`
   (`{authId:agentId → endpointId, username}`, ids only, mode 0600), or by its
   exact alias `Freshdesk-<agentId>` — or creates it. It sets a fresh random SIP
   password, binds the endpoint to the application with `{"app_id": "<id>"}`,
   reads the endpoint back to verify, and retries once with the documented
   `{"application": <integer>}` if it is not bound. App ids are 17 digits, above
   `Number.MAX_SAFE_INTEGER`, so they are kept as strings and spliced into the
   body as a literal — never passed through `Number()`.
4. Reads the endpoint's **stored** username back (Vobiz rewrites what it was
   sent) and hands it, with the password, only to this session.

```json
{ "token": "64 hex chars", "mode": "account",
  "numbers": ["+91XXXXXXXXXX"], "numberDetails": [{ "e164": "+91XXXXXXXXXX", "applicationId": "..." }],
  "selected": "+91XXXXXXXXXX" }
```

A new sign-in for the same agent rotates the password, so it closes that
agent's older session. Attaching a number for inbound never happens here — only
on `POST /setup-inbound`.

### `POST /login-sip` — SIP direct

```json
{ "agentId": "fd1001", "displayName": "Priya", "sipUser": "endpointusername", "sipPassword": "...", "callerId": "+91XXXXXXXXXX" }
```

No account credentials, so nothing is provisioned or checked with the API: the
registrar checks the password when the panel registers, and Vobiz refuses a
caller ID the account does not own. The backend records `sipUser → callerId`
(which is also the inbound number) for webhook routing. A username a Vobiz
account sign-in provisioned is refused with `409`. The endpoint and number must
already be bound to an application whose answer URL is `PUBLIC_BASE/answer`.

→ `{ "token": "...", "mode": "sip", "numbers": ["+91XXXXXXXXXX"], "selected": "+91XXXXXXXXXX" }`

`/select-number`, `/setup-inbound`, `/recordings` and `/call-status` answer a
SIP-direct session with `403` "Sign in with your Vobiz account to use this"; the
panel hides them.

### `GET /agent/{agentId}` — *token required*

The SIP identity the panel registers as.

```json
{ "displayName": "Priya", "sipUser": "fdfd10011a2b3c@registrar.vobiz.ai", "sipPassword": "..." }
```

`agentId` is `fd<Freshdesk user ID>` — the panel reads the logged-in agent with
`client.data.get("loggedInUser")`, so each Freshdesk agent has their own
endpoint. The backend accepts 1–64 letters, digits, `.`, `_` or `-`, starting
with a letter or digit, and refuses anything else with `400`. `/login` and
`/login-sip` also take an optional `displayName` (the agent's Freshdesk name),
returned here for the status line.

`sipUser` is a full `user@domain`; the panel builds `sip:${sipUser}`. Before
sign-in this returns `401`, and the panel shows *Signed out* until it has a
token.

### `GET /session/{agentId}`

```json
{ "loggedIn": true, "mode": "account", "numbers": ["+91XXXXXXXXXX"], "from": "+91XXXXXXXXXX", "authId": "MA_XXXXXXXX" }
```

`{ "loggedIn": false }` without a valid token for that agent.

### `POST /select-number` — *token required*

```json
{ "agentId": "fd1001", "number": "+91XXXXXXXXXX" }
```

→ `{ "selected": "+91XXXXXXXXXX" }`. A number not in the account's list is
refused with `400` — accepting one would be caller-ID spoofing. The choice is
remembered for the agent's next sign-in.

### `POST /setup-inbound` — *token required*

→ `{ "number": "+91XXXXXXXXXX", "appId": "...", "previousAppId": "...", "previousAppName": "My IVR", "endpointBound": true }`

The **Enable inbound calls** button. Attaches the agent's selected number to
this integration's application (`POST /numbers/%2B<digits>/application` with
`{"application_id": "<id>"}`), in the agent's own account, and re-checks the
endpoint binding. It is explicit because it moves the number off whatever
application it was on — `previousAppId` and `previousAppName` name it. The
request body is empty; the session says which agent and number.

`numberDetails` (from `/login` and `/session`) carries, per number,
`applicationId`, `applicationName` (looked up with `GET /Application/`, `null`
if not found) and `thisPanel` (already on this integration's application), which
the panel uses for its "Enable inbound calls" hint.

### `GET /recordings/{agentId}?limit=15` — *token required*

```json
{ "objects": [ {
  "recording_id": "...", "add_time": "2026-09-14 10:30:00", "rounded_recording_duration": 42,
  "playUrl": "/recording-audio/fd1001/<id>?account=MA_XXXXXXXX&exp=1760000000&sig=<hmac>"
} ] }
```

These are the account's most recent recordings — every agent's calls on that
Vobiz account, not only this agent's.

### `GET /recording-audio/{agentId}/{recordingId}?account=…&exp=…&sig=…`

The audio. The panel assigns `playUrl` directly to an `<audio>` element, which
cannot send the bearer token, so this route is authorised by the signature
instead: HMAC-SHA256 over `authId|agentId|recordingId|exp` with
`SIGNING_SECRET`, valid for `RECORDING_URL_TTL_SECONDS` (default 300). The Auth
ID is in the signed payload, so one account's link can never fetch another
account's audio, and the audio is fetched with that account's credentials.
When nobody from that account is signed in (after the last sign-out, a session
expiry or a restart) a link answers `401` "sign in again".

The backend looks the recording up by ID and fetches the audio itself. It only
fetches from Vobiz media hosts (and object storage they redirect to), and only
sends the account credentials to `*.vobiz.ai`. **There is no route that fetches
a URL the caller names** — that would be an open proxy carrying your Auth Token.

### `GET /call-status/{callRef}` — *token required*

During an outbound call the panel polls this with the `X-VH-Call-Ref` it put on
the INVITE (8–64 letters, digits or dashes). While the customer's leg is still
ringing → `{ "active": true, "state": "ringing" }`; once they join the room →
`{ "active": true, "state": "connected" }`. Only the agent who placed the call
gets an answer for it. Anything else is treated as a Vobiz CallUUID and answered
`{ "active": <live?> }` with no `state`, which the panel shows as *On a call*.

### `POST /logout` — *token required*

The panel's **Sign out** button. Ends the session and stops routing calls to the
agent's SIP user; the panel then unregisters. When no live session of that
account remains, the backend forgets the account's Auth Token — straight away,
or once the last outbound room of that account has ended (its hangup webhook
may need to release the agent's leg as the account). Sessions that expire
(`SESSION_TTL_HOURS`) and rooms whose hangup webhook never arrives (after the
4-hour call limit) are swept the same way, on every request and once a minute.

### `POST /start-call` — *retired*

Returns `410`. The panel places outbound calls itself over SIP.

## Webhooks Vobiz calls

These must be reachable at `PUBLIC_BASE` over public HTTPS. Vobiz sends them
**form-encoded** (`application/x-www-form-urlencoded`).

### `POST /answer`

The answer URL of the application your endpoint and number are attached to. One
handler serves both directions, told apart by `From`:

- `From` starts with `sip:` → **the browser dialled out.** The SIP username
  says which agent and account: the backend keeps `sipUser → {authId, agentId,
  callerId}` in memory. An unknown SIP user is hung up on.
- `From` is a plain number → **a PSTN caller reached a number.** The account is
  `ParentAuthID` from the webhook; if it is absent or nobody from that account
  is signed in, the dialled `To` is matched against signed-in accounts' numbers,
  then against SIP-direct agents' caller IDs. Every signed-in agent of that
  account rings. No match → a polite `<Speak>` and `<Hangup/>`, and a log line.

An `Event=Hangup` request is a notification, not a request for instructions. It
gets an empty `<Response></Response>` — returning call control would start a
new leg after the call has ended.

#### Outbound (default: `OUTBOUND_MODE=conference`)

The agent's leg waits in a room of its own, and the customer is dialled into it
over the REST API:

```xml
<Response>
  <Conference stayAlone="true" startConferenceOnEnter="false" endConferenceOnExit="true"
              waitSound="https://calling.example.com/outbound-wait" timeLimit="14400"
              callbackUrl="https://calling.example.com/conf-event" callbackMethod="POST">fd<call-uuid></Conference>
  <Hangup/>
</Response>
```

```
POST /api/v1/Account/{the agent's auth_id}/Call/
  from=<agent's caller ID>  to=<customer>
  answer_url=https://calling.example.com/outbound-join?room=fd<call-uuid>
  hangup_url=https://calling.example.com/outbound-hangup?room=fd<call-uuid>
```

Why not `<Dial><Number>`? It is simpler, and it is available as
`OUTBOUND_MODE=dial`. But a `<Dial><Number>` bridged from a WebRTC leg can lose
the phone side's audio, while a REST-placed leg joined to a conference stays
clean. A call that loses audio still rings, answers and bills, with nobody able
to hear anything.

`OUTBOUND_MODE=dial` answers — and SIP-direct agents always get this, since
there are no account credentials to place a REST leg with:

```xml
<Response>
  <Dial callerId="+91XXXXXXXXXX" timeout="30" timeLimit="14400"
        action="https://calling.example.com/dial-status" method="POST" redirect="false">
    <Number>91XXXXXXXXXX</Number>
  </Dial>
</Response>
```

**Caller ID** is the number the agent picked in the panel, which the panel also
sends on the INVITE as the `X-VH-Caller-ID` SIP header (it reaches the webhook as
a parameter, sometimes prefixed `SIPHeader_`). For an account sign-in it must be
one of that account's numbers, or it is ignored. There is no default from
configuration. The A leg's own identity is a SIP username, which is not a
dialable CLI.

#### Inbound

```xml
<Response>
  <Dial callerId="+91XXXXXXXXXX" timeout="30" timeLimit="14400"
        action="https://calling.example.com/dial-status" method="POST" redirect="false">
    <User>sip:fdfd10011a2b3c@registrar.vobiz.ai</User>
  </Dial>
</Response>
```

**`callerId` must be the number that was dialled**, in E.164 (`0XXXXXXXXXX` →
`+91XXXXXXXXXX`; no `+` → one is added). Left unset, Vobiz derives it
from the A leg — the caller's own number, which your account does not own — and
refuses to create the leg to the browser.

**`action` and `redirect="false"` are required** on every `<Dial>`. Without
them Vobiz re-fetches the answer URL when `<Dial>` ends and runs the document
again, dialling a second time.

With `RECORD_CALLS=1`, a `<Record recordSession="true" redirect="false"/>` is
placed as a sibling **before** `<Dial>` or `<Conference>` — never inside it.

### `POST /outbound-join?room=…`

The customer answered. They join the agent's room, and their arrival starts it:

```xml
<Response>
  <Conference startConferenceOnEnter="true" stayAlone="false" endConferenceOnExit="true"
              timeLimit="14400">fd<call-uuid></Conference>
  <Hangup/>
</Response>
```

With `endConferenceOnExit` on both legs, either side hanging up ends the call
for the other.

### `POST /outbound-hangup?room=…`

The customer's leg ended. If they never answered, the backend hangs up the
agent's leg (`DELETE /Call/{uuid}/`); otherwise nothing would release the agent
from a room set to stay open.

### `POST /outbound-wait`

What the agent hears while the customer's phone rings: `<Wait length="10"/>`.

### `POST /conf-event`, `POST /dial-status`

Logged, answered with an empty `<Response></Response>`. On `/dial-status`, an
empty `DialBLegUUID` means no B leg was created — an unreachable destination, or
a caller ID the account does not own.

### Webhook signatures

Vobiz signs callbacks with `X-Vobiz-Signature-V3` and
`X-Vobiz-Signature-V3-Nonce`:

```
base64( HMAC-SHA256( key = Auth Token, msg = <callback URL without query> + "." + nonce ) )
```

The key is the Auth Token **of the account the webhook belongs to** — found by
room, SIP user, `ParentAuthID` or number as above. When the webhook names no
account the backend knows, every signed-in account's token is tried; a match
still proves Vobiz sent it. With nobody signed in through an account (SIP direct
only), there is no token to check with, so `require` rejects everything.

The signature covers the URL and nonce, never the form body. The backend rebuilds
the URL from `PUBLIC_BASE`, since behind a tunnel the `Host` header is not the
public one. `VOBIZ_WEBHOOK_SIGNATURE=log` (default) logs mismatches;
`require` rejects them with `403`.

## Security

What `backend/` does, and what any replacement must also do:

- **Authenticate every browser request** with a token issued at sign-in. An
  `agentId` is a guessable string and proves nothing.
- **Serve the SIP password only to the signed-in agent it belongs to.**
- **Sign recording links** with a short expiry, and fetch the audio server-side
  from an allowlist of hosts. Never proxy a URL a caller supplies.
- **Scope CORS** to the Freshdesk and localhost origins. Never
  `Access-Control-Allow-Origin: *`, never a reflected origin. Add others with
  `ALLOWED_ORIGINS`; the backend logs each origin it refuses.
- **Never log the Auth Token**, return it, write it to disk, or put it in a URL.
- **Never need an account in configuration.** Any account signs in with its own
  credentials.
- **Serve over HTTPS** with a stable hostname.
- **Serve no files from disk.** There is no static route to traverse.

Sessions and Auth Tokens are in memory. That keeps credentials off disk, and
means the backend runs as a single instance and signs everyone out when it
restarts. The endpoint map on disk holds ids only, so agents get their own
endpoint back on the next sign-in.
