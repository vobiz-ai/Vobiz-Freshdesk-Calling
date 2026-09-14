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

### `POST /start-call`

```json
{ "to": "+919876543210", "agentId": "priya", "platform": "freshdesk" }
```

→ `{ "request_uuid": "..." }`

Reject with a non-2xx and `{ "error": "..." }` when the agent has no session.

**Call order is load-bearing.** Dial the *customer* first via the Vobiz REST
API, then bridge the agent's registered browser in via `<Dial><User>` in your
`/answer` response. The reverse does not work: the REST API cannot originate to
a registered WebRTC endpoint and returns `Endpoint Not Registered`. This is also
why the person you call hears a few seconds of ringback after answering.

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

Returns the XML that bridges your agent into an outbound call:

```xml
<Response><Dial><User>sip:priya@registrar.vobiz.ai</User></Dial></Response>
```

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
