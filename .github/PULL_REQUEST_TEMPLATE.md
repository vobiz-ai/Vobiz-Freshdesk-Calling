## What this changes

<!-- A short description of the change and why it is needed. Link the issue it closes, if there is one. -->

## How it was tested

<!-- Commands you ran and what you observed. If you tested against a real Freshdesk account, say so. -->

- [ ] `npm test` passes, and coverage is still at or above 80% on every metric
- [ ] `fdk validate` reports zero platform errors and zero lint errors
- [ ] `fdk pack` succeeds

## Checklist

- [ ] The change is focused on one fix or one feature
- [ ] Documentation is updated if the behaviour changed — `README.md`, `docs/`, and `CHANGELOG.md`
- [ ] No credentials, SIP passwords, production hostnames, or real phone numbers appear in the diff
- [ ] If the backend contract changed, `docs/backend-contract.md` and `mock-backend/server.js` are both updated
