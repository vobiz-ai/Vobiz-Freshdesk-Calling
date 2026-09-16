# Calling backend contract

This app is a client. It holds no Vobiz credentials and cannot place a call on
its own — it talks to a **calling backend** that you run, which holds the Vobiz
account credentials and drives the [Vobiz REST API](https://www.vobiz.ai/docs).

This document is the complete contract. Implement these endpoints and the app
works; nothing else is required of you.

> **The backend is not included in this repository.** It is a separate service.
> If you are building one, read the [security requirements](#security-requirements)
> first — the obvious implementation is unsafe.

## Why a backend exists at all

Two reasons, both non-negotiable:

1. **Vobiz Auth Tokens are account-level API credentials.** Vobiz's own
   documentation says never to expose `X-Auth-Token` in client-side code. The
   backend holds the token and the browser never sees it.
2. **A `<audio>` element cannot send authentication headers.** Call recordings
   are protected, so playback needs a server-side step. See
   [recordings](#get-recording-audioagentidrecordingid) for the right way to do
   this — a plain proxy is the wrong answer.

## Base URL

Everything below is relative to the `backend_url` installation parameter. The
app requires HTTPS and strips trailing slashes.

## Endpoints the browser calls

### `GET /agent/{agentId}`

Returns the SIP identity this panel registers as.

```json
{ "displayName": "Priya S", "sipUser": "priya@registrar.vobiz.ai", "sipPassword": "..." }
```

`sipUser` must be a full `user@domain` — the app builds `sip:${sipUser}`.

> **Do not serve a long-lived SIP password from an unauthenticated endpoint.**
> See [security requirements](#security-requirements).

### `GET /session/{agentId}`

Session restore, called when the panel loads.

```json
{ "loggedIn": true, "numbers": ["+919876543210"], "from": "+919876543210", "authId": "MA_XXXXXXXX" }
```

Return `{ "loggedIn": false }` when there is no session. Errors are swallowed by
the app.

### `POST /login`

```json
{ "agentId": "priya", "authId": "MA_XXXXXXXX", "authToken": "..." }
```

Validate against Vobiz, store the credentials server-side keyed by `agentId`,
and return the account's numbers:

```json
{ "numbers": ["+919876543210", "+919876543211"], "selected": "+919876543210" }
```

On failure return a non-2xx status with `{ "error": "..." }`.

### `POST /select-number`

```json
{ "agentId": "priya", "number": "+919876543211" }
```

→ `{ "selected": "+919876543211" }`

### `POST /start-call` — *no longer used for outbound*

The panel does **not** ask the backend to originate outbound calls any more. It
sends the SIP INVITE itself, so the browser is the **A leg**, and your `/answer`
handler bridges outward with `<Dial><Number>`.

The previous design — backend originates to the customer over the REST API, then
bridges the browser in with `<Dial><User>` — is dead. Routing *into* a registered
WebRTC endpoint is broken platform-side: Vobiz builds an unparseable gateway URI
and drops its own INVITE. Verified across other accounts and Vobiz's own SDK; see
[ISSUES.md](../ISSUES.md).

Keep the route if you want a server-originated fallback (for ringing an agent's
mobile, say). Its shape is unchanged:

```json
{ "to": "+919876543210", "agentId": "priya", "platform": "freshdesk" }
```

→ `{ "request_uuid": "..." }`

### `GET /call-status/{callUuid}?agentId={agentId}`

→ `{ "active": true }`

Polled every 3 seconds while a call is up.

### `POST /setup-inbound`

```json
{ "agentId": "priya" }
```

→ `{ "number": "+919876543210" }`

Creates (or reuses) a Vobiz application pointing at your `/inbound-answer`, and
attaches the agent's selected number to it.

### `GET /recordings/{agentId}?limit=15`

```json
{ "objects": [ { "recording_id": "...", "add_time": "2026-09-14 10:30:00", "rounded_recording_duration": 42 } ] }
```

### `GET /recording-audio/{agentId}/{recordingId}`

Returns playable audio. The app assigns this URL directly to an `<audio>`
element, so **it cannot carry an `Authorization` header.**

**Do not solve this with an open proxy.** An endpoint that streams any
recording to anyone who knows the URL is a data breach waiting to happen, and
the listing endpoint above hands out the IDs. Instead:

- have `/recordings` return **signed, short-lived URLs** (a few minutes) that
  encode the recording ID and an expiry, and
- verify that signature on every request here.

## Endpoints Vobiz calls

These are webhooks. Vobiz must reach them over public HTTPS.

### `GET|POST /answer`

One handler serves both directions. Pick by looking at who the call is *from*:

- `From` starts with `sip:` (or `RouteType=sip`) → the **browser dialled out**.
  Bridge to the PSTN with `<Dial><Number>`.
- `From` is a plain number → a **PSTN caller** reached your DID. Bridge to the
  browser with `<Dial><User>`.

```xml
<!-- browser is the A leg, dialling out -->
<Response>
  <Dial callerId="+919876543210" timeout="30" timeLimit="14400"
        action="https://you.example.com/dial-status" method="POST" redirect="false">
    <Number>919876543211</Number>
  </Dial>
</Response>

<!-- PSTN inbound, bridging into the browser (currently blocked platform-side) -->
<Response>
  <Dial callerId="+919876543210" timeout="30" timeLimit="14400"
        action="https://you.example.com/dial-status" method="POST" redirect="false">
    <User>sip:priya@registrar.vobiz.ai</User>
  </Dial>
</Response>
```

**`action` and `redirect="false"` are required.** Without them Vobiz re-fetches
the answer URL when `<Dial>` ends and re-executes the document, so one call hits
this webhook repeatedly and dials again each time.

**An `Event=Hangup` request is not a request for instructions.** Answer it with
an empty `<Response></Response>`; returning `<Dial>` originates a fresh leg after
the call has already ended.

### `GET|POST /dial-status`

The `action` target above. Return `200` with an empty body. Log `DialStatus`,
`DialHangupCause` and especially `DialBLegUUID` — an empty `DialBLegUUID` means
no B leg was ever created, which is the signature of an unreachable destination
or a caller ID the account does not own.

### `GET|POST /inbound-answer`

Returns the XML for an inbound call. A 20-second no-answer timeout falling
through to voicemail is a sensible default.

## Security requirements

The app sends `agentId` as a plain string in the path, body, or query. **If your
backend trusts that string, every endpoint above is unauthenticated and the
`agentId` is guessable.** An attacker who learns your backend URL could then
read SIP passwords, place calls billed to your account, rewrite your inbound
number routing, and download every call recording.

A backend implementing this contract must therefore:

- [ ] **Authenticate every request.** Do not treat `agentId` as proof of
      identity. Issue a per-agent token at login and require it.
- [ ] **Not serve long-lived SIP passwords.** Mint short-lived credentials, or
      gate `/agent/{agentId}` behind the same authentication.
- [ ] **Sign recording URLs** with a short expiry, as described above.
- [ ] **Scope CORS to the Freshdesk origin.** Never `Access-Control-Allow-Origin: *`.
- [ ] **Store Auth Tokens encrypted at rest**, and never log them.
- [ ] **Serve over HTTPS** with a stable hostname.

If you are adapting an internal prototype, assume it does none of these.
