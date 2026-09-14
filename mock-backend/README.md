# Mock calling backend

A zero-dependency stand-in for the calling backend, so the Freshdesk panel can
be developed and tested without a Vobiz account or the production service.

It implements every endpoint in [../docs/backend-contract.md](../docs/backend-contract.md).

```bash
npm run mock-backend        # http://localhost:8092
```

Set `http://localhost:8092` as the app's **Calling backend URL** at
<http://localhost:10001/custom_configs>.

## What it does

| Behaviour | Detail |
| --- | --- |
| Credentials | Any Auth ID and Auth Token are accepted |
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
| `VOBIZ_SIP_USER` | — | Real SIP user, to test actual registration |
| `VOBIZ_SIP_PASSWORD` | — | Real SIP password |

By default the SIP credentials are placeholders, so registration fails and the
Call button stays disabled. **That is the panel behaving correctly** — it
deliberately refuses to dial without a registered endpoint, because otherwise
the customer answers and hears silence.

To exercise the full audio path, create a SIP endpoint in the
[Vobiz Console](https://console.vobiz.ai) and export its credentials:

```bash
export VOBIZ_SIP_USER='myendpoint@registrar.vobiz.ai'
export VOBIZ_SIP_PASSWORD='...'
npm run mock-backend
```

## Do not deploy this

It has no authentication, accepts any credentials, and sets permissive CORS. It
exists to make the panel developable. A real backend must meet the
[security requirements](../docs/backend-contract.md#security-requirements).
