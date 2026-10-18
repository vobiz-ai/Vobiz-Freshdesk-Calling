# Calling backend contract

The panel is a client. It holds no Vobiz credentials and cannot place a call on
its own — it talks to a **calling backend**, which holds the account credentials,
answers Vobiz's webhooks, and signs recording links.

**`backend/` in this repository implements this contract.** This document is for
anyone running it, changing it, or writing their own.

## Why a backend exists at all

1. **Vobiz Auth Tokens are account-level API credentials.** They must never
   reach client-side code. The backend holds the token; the browser never sees
   it after sign-in.
2. **Vobiz needs an answer URL.** When the panel dials, Vobiz asks a URL what to
   do with the call. That URL has to be a public HTTPS service.
3. **An `<audio>` element cannot send authentication headers**, and recordings
   are protected. Playback needs a server-side step.

## Authentication

`POST /login` returns a **bearer token**. Every other browser route requires
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
{ "agentId": "priya", "authId": "MA_XXXXXXXX", "authToken": "..." }
```

The backend compares both values, in constant time, with the account it is
configured for, and refuses anything else with `401`. It refuses an agent
identity it does not know with `403`.

```json
{ "token": "64 hex chars", "numbers": ["+919876543210"], "selected": "+919876543210" }
```

### `GET /agent/{agentId}` — *token required*

The SIP identity the panel registers as.

```json
{ "displayName": "Priya S", "sipUser": "priya@registrar.vobiz.ai", "sipPassword": "..." }
```

`sipUser` is a full `user@domain`; the panel builds `sip:${sipUser}`. Before
sign-in this returns `401`, and the panel shows *Signed out* until it has a
token.

### `GET /session/{agentId}`

```json
{ "loggedIn": true, "numbers": ["+919876543210"], "from": "+919876543210", "authId": "MA_XXXXXXXX" }
```

`{ "loggedIn": false }` without a valid token for that agent.

### `POST /select-number` — *token required*

```json
{ "agentId": "priya", "number": "+919876543211" }
```

→ `{ "selected": "+919876543211" }`. A number the account does not own is
refused with `400` — accepting one would be caller-ID spoofing.

### `POST /setup-inbound` — *token required*

→ `{ "number": "+919876543210", "appId": "...", "endpointBound": true }`

Creates (or reuses) a Vobiz application whose answer URL is `PUBLIC_BASE/answer`,
attaches the agent's selected number to it, and binds the agent's SIP endpoint
to it. The endpoint binding is what makes **outbound** work as well: the panel's
own INVITE is answered by the endpoint's application.

### `GET /recordings/{agentId}?limit=15` — *token required*

```json
{ "objects": [ {
  "recording_id": "...", "add_time": "2026-09-14 10:30:00", "rounded_recording_duration": 42,
  "playUrl": "/recording-audio/priya/<id>?exp=1760000000&sig=<hmac>"
} ] }
```

### `GET /recording-audio/{agentId}/{recordingId}?exp=…&sig=…`

The audio. The panel assigns `playUrl` directly to an `<audio>` element, which
cannot send the bearer token, so this route is authorised by the signature
instead: HMAC-SHA256 over `agentId|recordingId|exp` with `SIGNING_SECRET`,
valid for `RECORDING_URL_TTL_SECONDS` (default 300).

The backend looks the recording up by ID and fetches the audio itself. It only
fetches from Vobiz media hosts (and object storage they redirect to), and only
sends the account credentials to `*.vobiz.ai`. **There is no route that fetches
a URL the caller names** — that would be an open proxy carrying your Auth Token.

### `GET /call-status/{callUuid}` — *token required*

→ `{ "active": true }`

### `POST /start-call` — *retired*

Returns `410`. The panel places outbound calls itself over SIP.

## Webhooks Vobiz calls

These must be reachable at `PUBLIC_BASE` over public HTTPS. Vobiz sends them
**form-encoded** (`application/x-www-form-urlencoded`).

### `POST /answer`

The answer URL of the application your endpoint and number are attached to. One
handler serves both directions, told apart by `From`:

- `From` starts with `sip:` → **the browser dialled out.**
- `From` is a plain number → **a PSTN caller reached your number.**

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
POST /api/v1/Account/{auth_id}/Call/
  from=<agent's caller ID>  to=<customer>
  answer_url=https://calling.example.com/outbound-join?room=fd<call-uuid>
  hangup_url=https://calling.example.com/outbound-hangup?room=fd<call-uuid>
```

Why not `<Dial><Number>`? It is simpler, and it is available as
`OUTBOUND_MODE=dial`. But a `<Dial><Number>` bridged from a WebRTC leg was
measured losing the phone side's audio on three of five calls, while a
REST-placed leg joined to a conference measured clean. A failed call still
rings, answers and bills, with nobody able to hear anything.

`OUTBOUND_MODE=dial` answers:

```xml
<Response>
  <Dial callerId="+919876543210" timeout="30" timeLimit="14400"
        action="https://calling.example.com/dial-status" method="POST" redirect="false">
    <Number>919876543211</Number>
  </Dial>
</Response>
```

**Caller ID** is the number the agent picked in the panel, falling back to
`VOBIZ_FROM_NUMBER`. The A leg's own identity is a SIP username, which is not a
dialable CLI.

#### Inbound

```xml
<Response>
  <Dial callerId="+919876543210" timeout="30" timeLimit="14400"
        action="https://calling.example.com/dial-status" method="POST" redirect="false">
    <User>sip:priya@registrar.vobiz.ai</User>
  </Dial>
</Response>
```

**`callerId` must be the number that was dialled.** Left unset, Vobiz derives it
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
- **Never log the Auth Token**, and keep it out of URLs.
- **Serve over HTTPS** with a stable hostname.
- **Serve no files from disk.** There is no static route to traverse.

Sessions are in memory. That keeps credentials off disk, and means the backend
runs as a single instance and signs everyone out when it restarts.
