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
write tickets — see [extending it](#extending-it-writing-back-to-freshdesk).

## An outbound call, end to end

1. The agent clicks **Call**, or clicks a number in Freshdesk.
2. The panel sends a SIP INVITE for that number from the browser — **the
   browser is the A leg**.
3. Vobiz fetches the answer URL of the application the agent's SIP endpoint is
   bound to: the backend's `/answer`. Sign-in made that binding, in the agent's
   own account.
4. The backend sees `From: sip:…`, looks the SIP username up to find the agent
   and their account, puts the agent's leg in a conference room of its own, and
   dials the customer over the REST API — as that account — with the agent's
   chosen caller ID (also on the INVITE as `X-VH-Caller-ID`).
5. The customer answers; Vobiz fetches `/outbound-join`, and they join the room.
6. Either side hanging up ends the call for both. If the customer never answers,
   the backend hangs up the agent's leg.

`OUTBOUND_MODE=dial` replaces steps 4–5 with a single `<Dial><Number>`, and
SIP-direct agents always get it, since there are no account credentials for the
REST leg. It is simpler, but a `<Dial>` bridged from a WebRTC leg can lose the
phone side's audio, while a REST-placed leg joined to a conference stays clean.
That is why the conference is the default.

With the conference, the agent's leg is answered by the room straight away, so
JsSIP reports the call confirmed before the customer's phone has rung. The panel
sends its own reference for the call as `X-VH-Call-Ref` on the INVITE; the
backend keeps it on the room, and the panel polls `/call-status/<ref>`, showing
*Ringing* until `/outbound-join` marks the customer as joined, then *On a call*.
In `dial` mode and SIP direct there is no room to ask about, so the panel shows
*On a call* as soon as its own leg is up.

The reverse design — the backend dials the customer first, then rings the
browser in — is not used: the REST API cannot originate a call to a WebRTC
endpoint, and the customer would hear ringback while the agent was found.

## An inbound call

The agent clicks **Enable inbound calls** once. The backend attaches the agent's
selected number to this integration's application in their account (the panel
says which application the number was on before). A call to that number then
reaches `/answer` with a plain number in `From` and the account in
`ParentAuthID`, and the backend rings every signed-in agent of that account:

```xml
<Dial callerId="<the dialled number>" …><User>sip:<agent endpoint></User>…</Dial>
```

Vobiz rings the registered browsers, and the first panel to pick up answers
automatically — there is no Accept or Decline yet.

Two things this depends on, both handled:

- **`callerId` is the dialled number.** Left unset, Vobiz uses the caller's own
  number, which the account does not own, and never rings the browser.
- **The panel's SIP User-Agent contains no space.** Vobiz copies the User-Agent
  from the registration into the address it routes `<Dial><User>` through, and
  JsSIP's default, `JsSIP 3.10.1`, breaks it: the caller hears ringback and the
  browser never rings. The panel sends `VobizFreshdeskCalling/1.0.0`.

## Settings the SIP stack needs

| Setting | Without it |
| --- | --- |
| `session_timers: false` | `422 Session Interval Too Small`, surfaced by JsSIP as "SIP Failure Code", and no CDR |
| `pcConfig.iceServers` (STUN), on calls and on answers | host-only candidates; the call is cancelled as "Incompatible SDP", or connects with no audio |
| a `user_agent` with no space | inbound `<Dial><User>` never reaches the browser |

These match what Vobiz's own WebRTC SDK sets, and tests pin all three.

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

## Extending it: writing back to Freshdesk

The app is a softphone that lives inside Freshdesk rather than an integration
with Freshdesk's data — it writes nothing back (see the README's
[Limitations](../README.md#limitations)). Closing that gap means using the Freshdesk REST API v2 —
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
