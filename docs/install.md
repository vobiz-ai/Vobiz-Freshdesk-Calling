# Installing the app

This app installs as a Freshdesk **custom app**. Custom apps are not reviewed by
Freshworks and are normally available on your account within about thirty
minutes of upload.

## Before you start

- Freshdesk on **Growth, Pro, or Enterprise**, and admin access.
- The calling backend from `backend/` running on public HTTPS — see the
  [README](../README.md#1-run-the-calling-backend). It needs no Vobiz account
  configured: agents sign in with their own, and sign-in sets up their SIP line.
- The [Freshworks CLI](https://developers.freshworks.com/docs/app-sdk/v3.0/common/basic-dev-tools/freshworks-cli/) (`fdk`)
  10.1.9 on Node 24.11.1.

> **This replaces your current telephony.** Freshdesk allows only one CTI app at
> a time, and Freshcaller cannot be enabled alongside one.

## 1. Pack the app

```bash
git clone https://github.com/vobiz-ai/Vobiz-Freshdesk-Calling.git
cd Vobiz-Freshdesk-Calling
npm install
npm run pack
```

The installable zip is written to `dist/vobiz-freshdesk-calling.zip`. Use
`npm run pack` rather than a bare `fdk pack`, which stops on lint errors in the
vendored JsSIP bundle.

## 2. Create the custom app

1. In Freshdesk, go to **Admin → Apps**.
2. Click **Go to Developer Portal**.
3. Click **Create New App** and choose **Custom App**.
4. Select your Freshdesk account.
5. Upload the zip from `dist/`.
6. Fill in the app details:
   - **Name:** Vobiz Calling
   - **Description:** Make and receive Vobiz calls, and review recordings, inside Freshdesk.
   - **Support email:** your team's address
7. **Save and Publish**, then **Promote to Live**.

## 3. Install it on your account

1. Back in Freshdesk, go to **Admin → Apps → Manage Apps**.
2. Filter to **Custom**.
3. Find **Vobiz Calling** and click **Install**.
4. Fill in the settings:

   | Setting | Value |
   | --- | --- |
   | Calling backend URL | The HTTPS base URL of your backend, no trailing slash |
   | Agent identity | The identity for *this* agent — every agent needs a different one |
   | SIP registrar URL | Leave blank unless Vobiz support gave you a different one |

5. Save.

## 4. Open the panel

Open any agent page and look for the Vobiz icon at the **bottom left**. Click it
to open the panel.

If the icon does not appear, hard refresh (`Ctrl` + `F5`). The panel loads on all
agent pages, not only tickets.

## Changing the settings later

**Admin → Apps → Manage Apps → Custom → Vobiz Calling → Settings → Configure.**
All three settings can be changed without reinstalling.

## Troubleshooting

| What you see | What it means | What to do |
| --- | --- | --- |
| "Sign in below to bring your phone line online" | Normal on every fresh open | Sign in on the **Vobiz account** tab with your Auth ID and Auth Token, or on **SIP direct** |
| "Vobiz did not accept that Auth ID and Auth Token" | Vobiz refused the pair | Copy both again from the console's API credentials |
| "Could not set up this agent's phone line" | Vobiz refused to create the application or endpoint | The backend log has Vobiz's status code |
| "Not configured" | Setup was skipped or incomplete | Re-enter the settings via the path above |
| "Backend URL must start with https://" | The URL is missing its scheme | Enter the full `https://…` URL |
| "Cannot reach the calling backend" | The backend is down or the URL is wrong | Confirm the backend is running and reachable over public HTTPS |
| "Cannot reach the calling backend" right after install | The backend refused this page's origin | The backend log names the origin; add it to `ALLOWED_ORIGINS` |
| "Registration failed" | The SIP credentials were rejected | Account sign-in: sign in again (it sets a fresh password). SIP direct: use the username the console shows *after* creation, and its password |
| Calls ring but the customer is never dialled | The endpoint is not bound to an application whose answer URL is your backend | Account sign-in: the backend log says whether the bind verified. SIP direct: bind the endpoint in the console (README, *SIP direct*) |
| Inbound callers hear ringback, the panel never rings | The number is not attached to the application, or the panel is not open and registered | Click **Enable inbound calls** (SIP direct: attach it in the console); keep the tab open |
| "Sign in with your Vobiz account to use this" | Recordings and inbound setup need the account API, which SIP direct does not have | Use the **Vobiz account** tab |
| Call button stays disabled | You are not logged in, or SIP is not registered | The hint under the button says which |
| Connected but no audio | Microphone permission was blocked | Allow the microphone in the browser address bar, then reload |
| Calls ring the wrong person | Two agents share an identity | Give each agent their own |

### A note on WebRTC inside Freshdesk

The app registers over SIP-over-WebSocket from inside a Freshdesk-hosted iframe.
Freshworks does not publish the Content-Security-Policy applied to app iframes,
so if your network or the platform blocks the WebSocket connection, registration
fails and the panel reports it. Test on one account before rolling out widely.
