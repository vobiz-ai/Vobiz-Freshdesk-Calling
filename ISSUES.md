# Known limitations

What this app does not do yet, so nobody is surprised. Pull requests welcome.

| # | Limitation | Where the fix belongs |
|---|---|---|
| 1 | Inbound calls auto-answer, with no ring, caller ID, or Accept/Decline | Panel |
| 2 | Nothing is written back into Freshdesk — no tickets, notes, or screen pop | Panel |
| 3 | During an outbound call the panel shows *On a call* while the customer's phone is still ringing | Panel + backend |
| 4 | Sessions and Auth Tokens live in the backend's memory: one instance only, and a restart signs everyone out | Backend |
| 5 | No hold, mute, transfer, or conference controls | Panel + backend |
| 6 | SIP direct sign-in cannot be verified by the backend, and has no recordings or inbound setup | Backend |

## 1. Inbound calls auto-answer

The panel answers an incoming leg the moment it arrives. A complete experience
would bring the panel forward (`client.interface.trigger("show", { id: "softphone" })`),
show the caller (`data.session.remote_identity.uri.user`), and offer Accept and
Decline wired to `session.answer(...)` and `session.terminate(...)`. The backend
already gives the browser `INBOUND_RING_SECONDS` (default 30) to respond.

## 2. Nothing is written back into Freshdesk

Click-to-call works; everything after the call does not. Closing the gap means
the Freshdesk REST API — see [docs/architecture.md](docs/architecture.md#what-is-missing).

## 3. "On a call" while the customer is still ringing

With the default conference bridge, the agent's own leg is answered by the room
straight away, so JsSIP reports the call confirmed before the customer picks up.
The backend knows when they join (`/outbound-join`); surfacing that to the panel
needs a status route or a SIP INFO.

## 4. In-memory sessions

Keeping sessions in memory keeps credentials off disk, at the cost of horizontal
scaling and surviving restarts. A shared store (Redis, a database) would lift
both; encrypt anything sensitive at rest if you add one.

## 6. SIP direct is a claim, not a proof

SIP direct has no account credentials, so the backend cannot check that the
typed endpoint or caller ID belong together; the registrar checks the password
and Vobiz checks the caller ID only when a call is placed. Inbound calls to a
SIP-direct agent's number ring whoever signed in with it most recently. It can
never take over an endpoint a Vobiz account sign-in provisioned. On a backend
shared by several companies, prefer the **Vobiz account** tab.

---

## Reporting something new

Please include:

- The **hangup cause code** from the Vobiz CDR — the number, not the name.
- The browser console, filtered to `Vobiz` — the panel prefixes its logs.
- The panel's status line, which names the exact failure.
- The backend log around the call — every webhook is logged with its
  `CallUUID`, and `/dial-status` says when no B leg was created.
- A UTC timestamp.

Keep account identifiers, endpoint usernames, phone numbers and backend hostnames
out of this public repository.
