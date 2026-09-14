# Security policy

## Reporting a vulnerability

Email **support@vobiz.ai** with the details. Please do not open a public issue
for a security problem.

Include what you found, how to reproduce it, and what an attacker could do with
it. We will acknowledge your report and keep you updated on the fix.

## Scope

This repository contains the Freshdesk client app only. It holds no credentials
and stores nothing in the browser.

**Most of the attack surface of this integration lives in the calling backend**,
which is a separate service that you run and that holds your Vobiz Auth Token.
Its security requirements are documented in
[docs/backend-contract.md](docs/backend-contract.md#security-requirements).

If you are implementing that backend, note in particular:

- `agentId` arrives from the browser as an unauthenticated, guessable string.
  Do not treat it as proof of identity.
- Do not serve long-lived SIP passwords from an open endpoint.
- Do not build an unauthenticated recording proxy. Sign recording URLs with a
  short expiry instead.
- Do not set `Access-Control-Allow-Origin: *`.

A backend that skips these exposes call recordings, allows calls to be billed to
your account, and allows your inbound number routing to be rewritten.
