# Mock calling backend

A zero-dependency stand-in for the calling backend, so the Freshdesk panel can
be developed without a Vobiz account. It places no calls. To place real calls,
run the real backend in [`../backend/`](../backend/) instead.

It implements every endpoint in [../docs/backend-contract.md](../docs/backend-contract.md).

```bash
npm run mock-backend        # http://localhost:8092
```

Set `http://localhost:8092` as the app's **Calling backend URL** at
<http://localhost:10001/custom_configs>.

## What it does

| Behaviour | Detail |
| --- | --- |
| Credentials | Any Auth ID and Auth Token are accepted, and a session token is issued |
| Session | `/agent`, `/session`, `/recordings` need the token, as on the real backend |
| Forced failure | Use `fail` as the Auth ID to exercise the login error path |
| Numbers | Three fake DIDs |
| Calls | A call is queued for 3s, live until 20s, then ends |
| Recordings | Four fake entries; playback returns a generated 440 Hz tone |
| Logging | Every request is printed with its status |

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8092` | Listen port |
| `HOST` | `127.0.0.1` | Listen address |
| `MOCK_CALL_MS` | `20000` | How long a mock call stays active |

After a **Vobiz account** sign-in the SIP credentials it serves are
placeholders, so registration fails and the Call button stays disabled. **That
is the panel behaving correctly** — it deliberately refuses to dial without a
registered endpoint, because otherwise the customer answers and hears silence.

To test SIP registration against a real endpoint, use the panel's **SIP direct**
tab and type that endpoint's username, password and a caller ID: the mock hands
them back to the panel exactly as the real backend does. Nothing is read from
the environment. Calls will still not connect — nothing here answers Vobiz's
webhooks; that is `npm run backend`.

## Do not deploy this

It accepts any credentials and listens on loopback only. It exists to make the
panel developable. The real backend is in [`../backend/`](../backend/); its
security model is in [the contract](../docs/backend-contract.md#security).
