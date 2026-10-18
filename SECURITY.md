# Security policy

## Reporting a vulnerability

Email **support@vobiz.ai** with the details. Please do not open a public issue
for a security problem.

Include what you found, how to reproduce it, and what an attacker could do with
it. We will acknowledge your report and keep you updated on the fix.

## Scope

This repository contains the Freshdesk panel (`app/`) and the calling backend
(`backend/`) that holds your Vobiz Auth Token. Both are in scope.
`mock-backend/` is a local development tool and must never be deployed.

## What the design relies on

- **The panel stores nothing.** No credentials in `localStorage`,
  `sessionStorage` or cookies. The session token from sign-in lives in memory.
- **`agentId` is not identity.** It is a guessable string. Every browser route
  on the backend needs the bearer token issued at sign-in, and the SIP password
  is served only to the agent it belongs to.
- **Recordings are reached only through signed, expiring links**, and the
  backend fetches the audio itself from Vobiz media hosts. It has no route that
  fetches a URL a caller names.
- **CORS is an allowlist** of Freshdesk and localhost origins, extended only by
  `ALLOWED_ORIGINS`. Never `*`, never reflected.
- **Webhook signatures** (`X-Vobiz-Signature-V3`) are checked; set
  `VOBIZ_WEBHOOK_SIGNATURE=require` in production once they verify.
- **No Vobiz credential is configured anywhere.** Agents sign in with their own
  account; its Auth Token stays in the backend's memory, keyed by Auth ID, and
  is never logged, written to disk or returned to the browser. SIP passwords
  are random, rotated on every sign-in, and handed only to that session.
- **`backend/data/endpoints.json` holds ids only** (`endpointId`, `username`),
  mode 0600, gitignored and excluded from the packed app, like `backend/.env`.
- **Recording links are account-scoped**: the Auth ID is inside the signed
  payload, so a link minted for one account cannot fetch another's audio.
- **SIP direct is unverifiable by the backend** — it has no account credentials
  to check a typed endpoint against. It cannot take over an endpoint a Vobiz
  account sign-in provisioned. Prefer account sign-in on a shared backend.

If you run the backend, serve it over HTTPS on a stable hostname, set
`SIGNING_SECRET`, and have agents rotate their Vobiz Auth Token if the host is
ever exposed (SIP passwords rotate on the next sign-in).
