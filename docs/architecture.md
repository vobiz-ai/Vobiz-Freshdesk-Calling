# How it works

## The shape of a Freshdesk CTI app

Freshdesk's telephony surface is smaller than it looks. It exposes exactly one
event to a calling app:

```js
client.events.on("cti.triggerDialer", cb);   // the only cti.* event that exists
```

It fires when an agent clicks a phone number on a ticket or contact page.
Installing a CTI app is what makes those numbers clickable — the app registers
nothing to enable it.

There is **no inbound-call event, no agent-presence event, and no call-ended
event**. Everything else flows the other way: the app tells Freshdesk what
happened, using `client.interface.trigger` for the UI and the Freshdesk REST API
for data.

That makes the integration a one-way push, and it means the depth of the
integration is entirely a function of how much the app chooses to write back.

## What this app uses

| Call | Purpose |
| --- | --- |
| `app.initialized()` | Boot |
| `client.iparams.get()` | Read the installation settings |
| `client.events.on("cti.triggerDialer")` | Receive click-to-call |
| `client.interface.trigger("show", {id:"softphone"})` | Open the panel when a call starts |

That is the whole Freshworks surface today. The app does not currently read or
write tickets — see [what is missing](#what-is-missing).

## An outbound call, end to end

1. The agent clicks **Call**, or clicks a number in Freshdesk.
2. The app POSTs `/start-call` to the calling backend.
3. The backend calls the Vobiz REST API and **dials the customer first**.
4. When the customer answers, Vobiz fetches the backend's `/answer` webhook,
   which returns `<Dial><User>sip:…</User></Dial>`.
5. Vobiz dials *into* this browser's registered SIP endpoint.
6. The app auto-answers that leg and binds the audio.

The order matters and cannot be reversed: the Vobiz REST API cannot originate a
call to a registered WebRTC endpoint — it returns `Endpoint Not Registered`.
This is also why the customer hears a few seconds of ringback after answering,
while the agent's browser is being bridged in.

## An inbound call

The agent clicks **Enable inbound calls** once. The backend creates a Vobiz
application pointing at its own `/inbound-answer` and attaches the agent's
selected number to it. Real calls to that number then hit `/inbound-answer`,
which dials `sip:…` — landing on the same auto-answer path as the outbound
bridge leg.

## Binding inbound audio

Worth knowing if you modify the SIP code. For an **incoming** session, JsSIP has
not built the `RTCPeerConnection` yet — `session.connection` is `null` until the
call is answered. Dereferencing it inside the `newRTCSession` handler throws, and
because the throw happens inside that handler it aborts before `.answer()` runs:
the browser silently never picks up, Vobiz rings the endpoint until it times out,
and the far end is never connected.

Bind through the `peerconnection` event instead, and only fall back to
`session.connection` when one already exists:

```js
session.on("peerconnection", e => bindTrack(e.peerconnection));
bindTrack(session.connection);   // no-op on the incoming path
```

## What is missing

The app is a softphone that lives inside Freshdesk rather than an integration
with Freshdesk's data. Closing that gap means using the Freshdesk REST API v2 —
there is no call or activity object for third-party apps, so calls become
ordinary tickets and notes:

| Capability | How |
| --- | --- |
| Screen pop on inbound | `GET /api/v2/contacts?phone=` and `?mobile=` (both — the filter is literal, not fuzzy), then `client.interface.trigger("click", {id:"contact", value:id})` |
| Create a ticket from a call | `POST /api/v2/tickets` with `source: 3` (Phone) |
| Log the call | `POST /api/v2/tickets/{id}/notes`, `private: true` |
| Attach a recording | A signed URL in the note body — attachments cap at 20 MB total |
| Disposition / wrap-up | App UI, then a note write and a status update |

Two constraints to plan around:

- **The CTI sidebar has no page context.** `client.data.get("ticket")` is not
  available in `cti_global_sidebar`. Knowing which ticket the agent is viewing
  requires also shipping a `ticket_background` instance — a *separate* app
  instance that shares no JavaScript state, so coordination goes through `$db`
  or the backend.
- **The Freshdesk API key should be a secure iparam**, which means calls to it
  must go through `client.request.invokeTemplate` rather than `fetch`. Secure
  iparams are only substituted into request-template headers and are never
  readable from front-end JavaScript.
