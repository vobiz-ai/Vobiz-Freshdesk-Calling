# Installing the app in Freshdesk

The panel installs as a Freshdesk **custom app**. Freshworks does not review
custom apps, and an uploaded app is usually available on your account within
about thirty minutes.

## Before you start

- Freshdesk on the **Growth, Pro or Enterprise** plan, and an admin login.
- **Freshcaller turned off.** Freshdesk runs one CTI app at a time, and this app
  replaces your current telephony.
- The calling backend running on public HTTPS. See the
  [README quick start](../README.md#quick-start).
- Node **24.11.1** and the Freshworks CLI (`fdk`) **10.1.9**:

  ```bash
  nvm install 24.11.1 && nvm use 24.11.1
  npm install -g https://cdn.freshdev.io/fdk/latest-v24.tgz
  fdk version     # 10.1.9
  ```

## 1. Pack the app

```bash
git clone https://github.com/vobiz-ai/Vobiz-Freshdesk-Calling.git
cd Vobiz-Freshdesk-Calling
npm install
npm run pack
```

This writes the installable zip to `dist/vobiz-freshdesk-calling.zip`. Use
`npm run pack` and not a bare `fdk pack`. A bare `fdk pack` stops on lint errors
in the bundled SIP library.

## 2. Create the custom app

1. In Freshdesk, go to **Admin → Apps**.
2. Click **Go to Developer Portal**.
3. Click **Create New App** and choose **Custom App**.
4. Select your Freshdesk account.
5. Upload the zip from `dist/`.
6. Fill in the app details:
   - **Name:** Vobiz Calling
   - **Description:** Make and receive Vobiz calls, and play recordings, inside Freshdesk.
   - **Support email:** your team's address
7. Click **Save and Publish**, then **Promote to Live**.

## 3. Install it on your account

1. In Freshdesk, go to **Admin → Apps → Manage Apps**.
2. Filter to **Custom**.
3. Find **Vobiz Calling** and click **Install**.
4. Fill in the installation parameters:

   | Setting | Value |
   | --- | --- |
   | Calling backend URL | Your backend's HTTPS base URL, with no trailing slash, for example `https://calling.example.com` |
   | Agent identity | A short name with no spaces, slashes or colons, for example `support`. Everyone in this Freshdesk account shares it. See the README's [Limitations](../README.md#limitations). |
   | SIP registrar URL (optional) | Leave blank unless Vobiz support gives you a different URL |

5. Click **Save**.

To change these later, go to **Admin → Apps → Manage Apps → Custom → Vobiz
Calling → Settings → Configure**. You don't need to reinstall.

## 4. Open the panel

Open any agent page and click the Vobiz icon at the **bottom left**. The panel
loads on every agent page, not only on tickets. If the icon doesn't appear, do a
hard refresh (`Ctrl` + `F5`).

Sign in on the **Vobiz account** tab with your Auth ID and Auth Token, or on
the **SIP direct** tab with an existing endpoint. The README explains
[both sign-in modes](../README.md#signing-in).

## Updating the app

Run `npm run pack` again, and upload the new zip to the same custom app in the
Developer Portal.

## If something goes wrong

For a symptom-by-symptom guide, see the README's
[Troubleshooting](../README.md#troubleshooting) section.

The panel registers over SIP-over-WebSocket from inside a Freshworks-hosted
iframe. If your network blocks WebSocket connections to
`wss://registrar.vobiz.ai:5063`, registration fails and the panel says so. Test
with one agent before you roll the app out to everyone.
