/** === Vobiz Calling — Freshdesk CTI sidebar app ===
 *
 * A softphone panel that lives in Freshdesk's CTI placeholder. It does two
 * jobs: it stays registered over SIP for as long as the panel is open, and
 * it starts a call when an agent clicks a phone number anywhere in Freshdesk
 * (Freshdesk emits `cti.triggerDialer`).
 *
 * The backend URL is an installation parameter (config/iparams.json). The
 * agent identity is not: it is derived from the Freshdesk agent logged in to
 * this browser (`fd<user id>`), so every agent gets their own SIP line in the
 * Vobiz account they sign in with. Nothing about an account is compiled in.
 *
 * This app is a client. It cannot place a call on its own: it talks to a
 * calling backend that answers Vobiz's webhooks and, for an agent signed in
 * with a Vobiz account, drives the Vobiz REST API with that account's
 * credentials. That contract is documented in docs/backend-contract.md.
 *
 * Two ways to sign in: "Vobiz account" (Auth ID + Auth Token; the backend
 * sets up this agent's SIP line and lists the account's numbers) and "SIP
 * direct" (an existing endpoint's username and password plus a typed caller
 * ID; recordings and inbound setup need the account, so they are hidden).
 */
let BACKEND_URL = null;
let AGENT_ID = null;
let AGENT_NAME = null;
let REGISTRAR_URL = null;

let client;
let vobizUA = null;
let currentRTCSession = null;

// Calling requires BOTH an account login (whose number/balance) and a live
// SIP registration (where the audio lands). Tracking them separately matters:
// gating the Call button on login alone lets an agent dial while SIP is down,
// which rings the customer and then connects them to silence.
let accountReady = false;
let sipRegistered = false;

// The bearer token /login returns. Held in memory only — never localStorage,
// never a cookie, never a URL — so it dies with the tab. The backend serves
// the SIP identity and everything else only to a request carrying it.
let sessionToken = null;

// "account" or "sip": which sign-in this panel is using.
let signInMode = "account";
// The caller ID calls go out from, also sent on the INVITE as X-VH-Caller-ID.
let selectedCallerId = null;
// number -> { id, name, thisPanel } for the application it is attached to now.
let numberApps = {};
// Polls /call-status while an outbound call waits for the customer to join.
let callStatusTimer = null;
const CALL_STATUS_POLL_MS = 1500;

/**
 * Every backend call goes through here.
 *
 * ngrok's free tier serves a browser interstitial (ERR_NGROK_6024) to anything
 * with a browser User-Agent, which means a plain fetch() from this panel gets an
 * HTML warning page instead of JSON. The `ngrok-skip-browser-warning` header
 * suppresses it. It is inert against any other host, so it costs nothing once
 * the backend is on a real domain.
 */
function backendFetch(url, options = {}) {
  const auth = sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {};
  return fetch(url, {
    ...options,
    headers: { "ngrok-skip-browser-warning": "1", ...auth, ...(options.headers || {}) },
  });
}

init();

async function init() {
  client = await app.initialized();

  const iparams = await client.iparams.get();
  BACKEND_URL = (iparams.backend_url || "").trim().replace(/\/+$/, "");
  REGISTRAR_URL = (iparams.registrar_url || "wss://registrar.vobiz.ai:5063/").trim();

  if (!BACKEND_URL) {
    setStatus("Not configured — set the Calling backend URL in this app's settings.");
    return;
  }
  // A bare hostname would resolve relative to the Freshdesk app origin and
  // 404 silently, which looks like "the backend is down" rather than a typo.
  // http://localhost is the one exemption: browsers already treat it as a
  // secure context, and the mock backend serves plain HTTP for local dev.
  const isLocalBackend = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(BACKEND_URL);
  if (!/^https:\/\//i.test(BACKEND_URL) && !isLocalBackend) {
    setStatus("Backend URL must start with https:// — check this app's settings.");
    return;
  }

  const me = await loggedInAgent();
  if (!me) {
    setStatus("Could not identify the signed-in Freshdesk agent — reload the page.");
    return;
  }
  AGENT_ID = me.id;
  AGENT_NAME = me.name;

  client.events.on("cti.triggerDialer", onTriggerDialer);
  document.getElementById("dialbtn").addEventListener("click", onDialButtonClick);
  document.getElementById("vobiz-login-btn").addEventListener("click", vobizLogin);
  document.getElementById("sip-login-btn").addEventListener("click", sipDirectLogin);
  document.getElementById("signin-tab-account").addEventListener("click", () => showSignInTab("account"));
  document.getElementById("signin-tab-sip").addEventListener("click", () => showSignInTab("sip"));
  document.getElementById("vobiz-number-select").addEventListener("change", vobizSelectNumber);
  document.getElementById("setup-inbound-btn").addEventListener("click", setupInboundCalling);
  document.getElementById("refresh-history-btn").addEventListener("click", loadCallHistory);
  document.getElementById("hangupbtn").addEventListener("click", hangUp);
  document.getElementById("signout-btn").addEventListener("click", signOut);

  // Leave the registrar cleanly. Without this the binding lingers until it
  // expires (JsSIP defaults to 600s) and inbound calls route to a dead leg
  // for up to ten minutes after the agent closes the tab.
  window.addEventListener("beforeunload", () => {
    try { if (vobizUA) vobizUA.stop(); } catch { /* nothing useful to do on the way out */ }
  });

  initVobizSip();
  restoreVobizSession();
}

/**
 * Who this panel is: the Freshdesk agent logged in to this browser. Each
 * agent's id becomes their own identity on the backend (`fd<id>`), so two
 * agents on one Vobiz account get two SIP lines and never sign each other out.
 * The data method resolves to `{ loggedInUser: {...} }`; the bare object is
 * accepted too.
 */
async function loggedInAgent() {
  try {
    const data = await client.data.get("loggedInUser");
    const user = (data && data.loggedInUser) || data || {};
    const id = String(user.id === null || user.id === undefined ? "" : user.id).replace(/[^A-Za-z0-9]/g, "");
    if (!id) return null;
    const contact = user.contact || {};
    const name = String(contact.name || user.display_name || contact.email || user.email || "").trim();
    return { id: `fd${id}`, name: name || null };
  } catch (err) {
    console.error("[Vobiz] Could not read the logged-in Freshdesk agent:", err);
    return null;
  }
}

/** === Vobiz account sign-in (Auth ID / Auth Token) ===
 * The backend checks these against the account it serves and returns a
 * session token. That token is what unlocks the SIP identity the panel
 * registers with (initVobizSip), the caller-ID choice, inbound setup and
 * recordings. The Auth Token itself is sent once, here, and never kept.
 */
function setLoginStatus(text) {
  const el = document.getElementById("vobiz-login-status");
  if (el) el.textContent = text;
}

function showSignInTab(mode) {
  const sip = mode === "sip";
  document.getElementById("vobiz-login-form").hidden = sip;
  document.getElementById("sip-login-form").hidden = !sip;
  const account = document.getElementById("signin-tab-account");
  const direct = document.getElementById("signin-tab-sip");
  account.classList.toggle("is-active", !sip);
  direct.classList.toggle("is-active", sip);
  account.setAttribute("aria-selected", String(!sip));
  direct.setAttribute("aria-selected", String(sip));
}

/** Show or hide what needs the account API, for the mode now signed in. */
function applySignInMode(mode) {
  signInMode = mode === "sip" ? "sip" : "account";
  const sip = signInMode === "sip";
  const inbound = document.getElementById("inbound-step");
  if (inbound) inbound.hidden = sip;
  const list = document.getElementById("call-history-list");
  if (list) list.hidden = sip;
  const refresh = document.getElementById("refresh-history-btn");
  if (refresh) refresh.hidden = sip;
  const note = document.getElementById("account-only-note");
  if (note) note.hidden = !sip;
}

function rememberNumberApps(details) {
  numberApps = {};
  (details || []).forEach(d => {
    if (d && d.e164 && d.applicationId) {
      numberApps[d.e164] = { id: d.applicationId, name: d.applicationName || null, thisPanel: Boolean(d.thisPanel) };
    }
  });
  renderInboundHint();
}

/** "Old IVR" (1234…) when the backend found the name, the bare id otherwise. */
function appLabel(id, name) {
  return name ? `"${name}" (${id})` : String(id);
}

/** Says which application "Enable inbound calls" would move the number off. */
function renderInboundHint() {
  const el = document.getElementById("inbound-current-app");
  if (!el) return;
  const app = selectedCallerId && numberApps[selectedCallerId];
  el.hidden = !app;
  if (!app) el.textContent = "";
  else if (app.thisPanel) el.textContent = `${selectedCallerId} already rings this panel.`;
  else el.textContent = `${selectedCallerId} is attached to application ${appLabel(app.id, app.name)} now; enabling moves it to this panel's.`;
}

function renderNumberOptions(numbers, selected) {
  selectedCallerId = selected || null;
  renderInboundHint();
  const select = document.getElementById("vobiz-number-select");
  if (!select) return;
  select.innerHTML = "";
  (numbers || []).forEach(n => {
    const opt = document.createElement("option");
    opt.value = n;
    opt.textContent = n;
    if (n === selected) opt.selected = true;
    select.appendChild(opt);
  });
  const hasNumbers = (numbers || []).length > 0 && signInMode === "account";
  select.hidden = !hasNumbers;
  const label = document.getElementById("vobiz-number-label");
  if (label) label.hidden = !hasNumbers;
}

function setDialEnabled(enabled) {
  accountReady = Boolean(enabled);
  refreshDialState();
}

function setSignOutVisible(visible) {
  const btn = document.getElementById("signout-btn");
  if (btn) btn.hidden = !visible;
}

function refreshDialState() {
  const btn = document.getElementById("dialbtn");
  if (!btn) return;
  const ready = accountReady && sipRegistered;
  if (ready) btn.removeAttribute("disabled");
  else btn.setAttribute("disabled", true);

  const hint = document.getElementById("dial-hint");
  if (!hint) return;
  if (ready) hint.textContent = "";
  else if (!accountReady && !sipRegistered) hint.textContent = "Log in and wait for the panel to register before calling.";
  else if (!accountReady) hint.textContent = "Log in to enable calling.";
  else hint.textContent = "Not registered — calling is disabled until the panel reconnects.";
}

function setSipRegistered(isRegistered) {
  sipRegistered = Boolean(isRegistered);
  refreshDialState();
}

function hangUp() {
  if (!currentRTCSession) return;
  try {
    currentRTCSession.terminate();
  } catch (err) {
    console.warn("[Vobiz] hangup failed:", err);
  }
}

function setHangupVisible(visible) {
  const btn = document.getElementById("hangupbtn");
  if (btn) btn.hidden = !visible;
}

async function restoreVobizSession() {
  try {
    const res = await backendFetch(`${BACKEND_URL}/session/${encodeURIComponent(AGENT_ID)}`);
    const session = await res.json();
    if (session.loggedIn) {
      applySignInMode(session.mode);
      rememberNumberApps(session.numberDetails);
      renderNumberOptions(session.numbers, session.from);
      setLoginStatus(session.mode === "sip"
        ? `Connected over SIP direct — calling from ${session.from}`
        : `Logged in as ${session.authId} — calling from ${session.from}`);
      setDialEnabled(true);
      setSignOutVisible(true);
      if (session.mode !== "sip") loadCallHistory();
    } else {
      setDialEnabled(false);
    }
  } catch (err) {
    console.warn("[Vobiz] Could not check login session:", err);
  }
}

async function vobizLogin() {
  const authId = document.getElementById("vobiz-auth-id").value.trim();
  const authToken = document.getElementById("vobiz-auth-token").value.trim();
  if (!authId || !authToken) {
    setLoginStatus("Enter both an Auth ID and an Auth Token.");
    return;
  }
  setLoginStatus("Logging in…");
  try {
    const res = await backendFetch(`${BACKEND_URL}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: AGENT_ID, displayName: AGENT_NAME, authId, authToken }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `login failed (${res.status})`);
    sessionToken = data.token || null;
    applySignInMode("account");
    rememberNumberApps(data.numberDetails);
    renderNumberOptions(data.numbers, data.selected);
    setLoginStatus(
      (data.numbers || []).length
        ? `Logged in as ${authId} — calling from ${data.selected}`
        : `Logged in as ${authId} — this account has no phone numbers yet`,
    );
    setDialEnabled(Boolean(data.selected));
    setSignOutVisible(true);
    document.getElementById("vobiz-auth-token").value = "";
    if (data.selected) loadCallHistory();
    // The backend hands out the SIP identity only to a signed-in panel, and
    // every sign-in rotates the SIP password, so (re)register now.
    restartSip();
  } catch (err) {
    console.error("[Vobiz] Login failed:", err);
    setLoginStatus(`Login failed: ${err.message}`);
    setDialEnabled(false);
  }
}

/** Drop any registration made with older credentials, then register again. */
function restartSip() {
  if (vobizUA) {
    try { vobizUA.stop(); } catch { /* it is being replaced anyway */ }
    vobizUA = null;
    setSipRegistered(false);
  }
  initVobizSip();
}

async function sipDirectLogin() {
  const sipUser = document.getElementById("sip-user").value.trim();
  const sipPassword = document.getElementById("sip-password").value;
  const callerId = document.getElementById("sip-caller-id").value.trim();
  if (!sipUser || !sipPassword || !callerId) {
    setLoginStatus("Enter the SIP username, its password and a caller ID.");
    return;
  }
  setLoginStatus("Connecting…");
  try {
    const res = await backendFetch(`${BACKEND_URL}/login-sip`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: AGENT_ID, displayName: AGENT_NAME, sipUser, sipPassword, callerId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `sign-in failed (${res.status})`);
    sessionToken = data.token || null;
    applySignInMode("sip");
    rememberNumberApps([]);
    renderNumberOptions(data.numbers, data.selected);
    setLoginStatus(`Connected over SIP direct — calling from ${data.selected}`);
    setDialEnabled(Boolean(data.selected));
    setSignOutVisible(true);
    document.getElementById("sip-password").value = "";
    restartSip();
  } catch (err) {
    console.error("[Vobiz] SIP direct sign-in failed:", err);
    setLoginStatus(`Sign-in failed: ${err.message}`);
    setDialEnabled(false);
  }
}

/**
 * Sign out: end any call, tell the backend (which forgets the session, and the
 * account's Auth Token once its last agent is out), leave the registrar so
 * inbound calls stop ringing this browser, and return to Signed out. The panel
 * signs out locally even when the backend cannot be reached.
 */
async function signOut() {
  if (currentRTCSession) {
    try { currentRTCSession.terminate(); } catch { /* already gone */ }
    currentRTCSession = null;
    setHangupVisible(false);
  }
  stopCallStatusPolling();
  if (sessionToken) {
    try {
      await backendFetch(`${BACKEND_URL}/logout`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    } catch (err) {
      console.warn("[Vobiz] Could not reach the backend to sign out:", err);
    }
  }
  sessionToken = null;
  if (vobizUA) {
    // stop() sends an un-REGISTER and closes the socket. The handlers ignore
    // events from a UA that is no longer current, so the badge stays put.
    try { vobizUA.stop(); } catch { /* it is being discarded anyway */ }
    vobizUA = null;
  }
  setSipRegistered(false);
  setDialEnabled(false);
  setSignOutVisible(false);
  applySignInMode("account");
  rememberNumberApps([]);
  renderNumberOptions([], null);
  const list = document.getElementById("call-history-list");
  if (list) list.innerHTML = "";
  const inboundStatus = document.getElementById("inbound-setup-status");
  if (inboundStatus) inboundStatus.textContent = "";
  setLoginStatus("Signed out.");
  setStatus("Sign in below to bring your phone line online.");
}

async function vobizSelectNumber() {
  const number = document.getElementById("vobiz-number-select").value;
  try {
    const res = await backendFetch(`${BACKEND_URL}/select-number`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: AGENT_ID, number }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `could not switch numbers (${res.status})`);
    selectedCallerId = data.selected || number;
    renderInboundHint();
    setLoginStatus(`Calling from ${data.selected}`);
  } catch (err) {
    console.error("[Vobiz] Could not switch numbers:", err);
    setLoginStatus(`Could not switch numbers: ${err.message}`);
  }
}

/** === Inbound calling setup (one-time, manual — real account changes) ===
 * The backend finds or creates this integration's Vobiz application (answer
 * URL: the backend's /answer) and attaches the currently-selected number to
 * it. Only runs when the button is clicked — never automatically — since this
 * changes real Vobiz account routing, not just local UI state.
 */
async function setupInboundCalling() {
  const statusEl = document.getElementById("inbound-setup-status");
  const btn = document.getElementById("setup-inbound-btn");
  statusEl.textContent = "Setting up inbound routing…";
  statusEl.classList.remove("is-ok", "is-error");
  btn.setAttribute("disabled", true);
  try {
    const res = await backendFetch(`${BACKEND_URL}/setup-inbound`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The session token says which agent and number; the body carries nothing.
      body: "{}",
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `setup failed (${res.status})`);
    statusEl.textContent = data.previousAppId
      ? `Inbound calls to ${data.number} now ring this panel (moved off application ${appLabel(data.previousAppId, data.previousAppName)}).`
      : `Inbound calls to ${data.number} now ring this panel.`;
    numberApps[data.number] = { id: data.appId || null, name: null, thisPanel: true };
    renderInboundHint();
    statusEl.classList.add("is-ok");
  } catch (err) {
    console.error("[Vobiz] Inbound setup failed:", err);
    statusEl.textContent = `Setup failed: ${err.message}`;
    statusEl.classList.add("is-error");
  } finally {
    btn.removeAttribute("disabled");
  }
}

/** === Call recordings ===
 * Only the Recording list — no CDR merge, no phone numbers or SIP legs
 * shown. Played through /recording-audio/:agentId/:recordingId — the
 * backend proxy that adds the auth headers a plain <audio> tag can't
 * send itself. Field names match Vobiz's real Recording object
 * (add_time, rounded_recording_duration, recording_id).
 */
async function loadCallHistory() {
  const listEl = document.getElementById("call-history-list");
  if (!listEl || !BACKEND_URL || !AGENT_ID || signInMode === "sip") return;

  try {
    const res = await backendFetch(`${BACKEND_URL}/recordings/${encodeURIComponent(AGENT_ID)}?limit=15`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "could not load recordings");
    renderCallHistory(json.objects || []);
  } catch (err) {
    console.warn("[Vobiz] Could not load recordings:", err);
    listEl.innerHTML = `<li class="empty">Could not load recordings.</li>`;
  }
}

function renderCallHistory(recordings) {
  const listEl = document.getElementById("call-history-list");
  if (!listEl) return;

  if (!recordings.length) {
    listEl.innerHTML = `<li class="empty">No recordings yet.</li>`;
    return;
  }

  listEl.innerHTML = "";
  recordings.forEach(rec => {
    const seconds = Number(rec.rounded_recording_duration) || 0;
    const durationText = seconds > 0 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : "";
    const when = rec.add_time && new Date(rec.add_time);
    const whenText = when && !isNaN(when) ? when.toLocaleString() : "";

    const li = document.createElement("li");

    const info = document.createElement("span");
    info.className = "info";
    const metaEl = document.createElement("span");
    metaEl.className = "meta";
    metaEl.textContent = [durationText, whenText].filter(Boolean).join(" · ") || "Call recording";
    info.append(metaEl);

    const playBtn = document.createElement("button");
    playBtn.className = "secondary-btn play-btn";
    playBtn.textContent = "▶ Play";
    playBtn.addEventListener("click", () => playRecording(rec.recording_id, rec.playUrl));

    li.append(info, playBtn);
    listEl.appendChild(li);
  });
}

function playRecording(recordingId, playUrl) {
  const audioEl = document.getElementById("vobiz-playback-audio");
  if (!audioEl) return;
  // An <audio> element cannot send the session token, so the backend signs
  // each link with a short expiry instead. Use the link it gave us.
  audioEl.src = playUrl
    ? (/^https?:\/\//i.test(playUrl) ? playUrl : `${BACKEND_URL}${playUrl}`)
    : `${BACKEND_URL}/recording-audio/${encodeURIComponent(AGENT_ID)}/${encodeURIComponent(recordingId)}`;
  // The element is hidden until there is something to play; an empty native
  // player renders as a bright browser-chrome blob.
  audioEl.hidden = false;
  audioEl.classList.add("is-visible");
  audioEl.play().catch(err => console.warn("[Vobiz] recording playback blocked:", err));
}

/**
 * Status is two things, not one.
 *
 * The header carries a short STATE ("Ready", "Offline", "On a call") — that is
 * what a badge is for. The full sentence, which can run to seventy characters,
 * goes in a message row beneath it where there is room to read it.
 *
 * Cramming a sentence into a nowrap pill is what made the header overflow.
 */
function statusState(text) {
  if (/^ready/i.test(text)) return { label: "Ready", tone: "ok" };
  if (/^on a call/i.test(text)) return { label: "On a call", tone: "busy" };
  if (/^(call )?ringing/i.test(text)) return { label: "Ringing", tone: "busy" };
  if (/^connecting/i.test(text)) return { label: "Connecting", tone: "pending" };
  if (/reconnecting/i.test(text)) return { label: "Reconnecting", tone: "pending" };
  if (/^sign in/i.test(text)) return { label: "Signed out", tone: "pending" };
  if (/^not configured|must start with|cannot reach|could not load|registration failed/i.test(text)) {
    return { label: "Offline", tone: "error" };
  }
  return { label: "Offline", tone: "error" };
}

function setStatus(text) {
  const el = document.getElementById("status");
  const msg = document.getElementById("status-message");
  const { label, tone } = statusState(text);

  if (el) {
    el.textContent = label;
    el.className = `status-badge is-${tone}`;
  }

  if (msg) {
    // Only show the sentence when it says more than the badge already does.
    const redundant = label.toLowerCase() === text.trim().toLowerCase();
    msg.textContent = redundant ? "" : text;
    msg.hidden = redundant;
    msg.className = `status-message is-${tone}`;
  }
}

// For an INCOMING session JsSIP has not built the RTCPeerConnection yet —
// session.connection is still null until the call is answered. Touching it
// here throws, and because that throw happens inside the newRTCSession
// handler it aborts before .answer() ever runs: the browser silently never
// picks up, Vobiz rings the endpoint until it times out, and the far end is
// never dialed. Bind via the "peerconnection" event instead, and only fall
// back to session.connection when one already exists.
function attachRemoteAudio(session) {
  const audioEl = document.getElementById("vobiz-remote-audio");
  if (!audioEl) return;
  const bindTrack = pc => {
    if (!pc) return;
    pc.addEventListener("track", event => {
      audioEl.srcObject = event.streams[0];
      audioEl.play().catch(err => console.warn("[Vobiz] audio autoplay blocked:", err));
    });
  };
  session.on("peerconnection", e => bindTrack(e.peerconnection));
  bindTrack(session.connection);
}

async function initVobizSip() {
  let agent;
  try {
    const res = await backendFetch(`${BACKEND_URL}/agent/${encodeURIComponent(AGENT_ID)}`);
    if (res.status === 401) {
      // Expected on every fresh open: the line comes online after sign-in.
      setStatus("Sign in below to bring your phone line online.");
      setSipRegistered(false);
      return;
    }
    if (!res.ok) {
      setStatus(`Could not load the identity "${AGENT_ID}" — check this app's settings.`);
      setSipRegistered(false);
      return;
    }
    agent = await res.json();
  } catch (err) {
    // The usual cause is the backend being unreachable. Without this catch the
    // rejection is unhandled and the panel sits on "Connecting…" forever.
    console.error("[Vobiz] Could not reach the calling backend:", err);
    setStatus("Cannot reach the calling backend — check the Backend URL in this app's settings.");
    setSipRegistered(false);
    return;
  }

  setStatus(`Connecting as ${agent.displayName}…`);

  const vobizSocket = new JsSIP.WebSocketInterface(REGISTRAR_URL);
  const ua = new JsSIP.UA({
    sockets: [vobizSocket],
    uri: `sip:${agent.sipUser}`,
    password: agent.sipPassword,
    register: true,
    // No space in the User-Agent, deliberately.
    //
    // Vobiz stores the registration's User-Agent and later interpolates it into
    // a gateway URI as a `user_agent=` parameter when <Dial><User> routes a call
    // back to this endpoint. JsSIP's default is "JsSIP 3.10.1" — the space makes
    // that URI unparseable, and Kamailio drops the INVITE rather than ringing us:
    //
    //   ERROR: tr_eval_uri(): invalid uri [...;user_agent=JsSIP 3.10.1;...]
    //   INVITE|blocking gw: ...
    //
    // The caller then hears ringback and nothing else, and the dial result reads
    // ring=true with no B leg. Confirmed in vobiz-outboundsip logs, 16 Sep 2026.
    user_agent: "VobizFreshdeskCalling/1.0.0",
    // Vobiz's media server rejects JsSIP's default session-timer proposal with
    // "422 Session Interval Too Small", which JsSIP surfaces to the app as the
    // opaque cause "SIP Failure Code" and which produces no CDR at all, because
    // the call is refused before it is ever created. Vobiz's own SDK sets this
    // same flag (vobiz-webrtc-sdk/lib/managers/account.ts), so matching it is
    // the supported configuration rather than a workaround.
    session_timers: false,
  });
  vobizUA = ua;

  // A UA that was replaced (new sign-in) or stopped (sign-out) still emits
  // unregistered/disconnected on its way down. Those must not repaint a panel
  // that has moved on, so every handler first checks it is still current.
  const current = () => vobizUA === ua;

  ua.on("registered", () => {
    if (!current()) return;
    setStatus(`Ready — registered as ${agent.displayName}`);
    setSipRegistered(true);
  });
  ua.on("registrationFailed", e => {
    if (!current()) return;
    setStatus(`Registration failed: ${(e && e.cause) || "unknown"}`);
    setSipRegistered(false);
  });
  // Without these two, a dropped transport leaves the panel showing "Ready"
  // while the endpoint is uncallable.
  ua.on("unregistered", () => {
    if (!current()) return;
    setStatus("Not registered — reconnecting…");
    setSipRegistered(false);
  });
  ua.on("disconnected", () => {
    if (!current()) return;
    setStatus("Disconnected from the registrar — reconnecting…");
    setSipRegistered(false);
  });

  // Vobiz dialling INTO this registered endpoint: an inbound PSTN call that
  // the backend's answer URL bridged here with <Dial><User>.
  ua.on("newRTCSession", data => {
    if (!current() || data.originator !== "remote") return;

    setStatus("Call ringing in…");
    currentRTCSession = data.session;
    attachRemoteAudio(currentRTCSession);
    setHangupVisible(true);

    currentRTCSession.on("confirmed", () => setStatus("On a call"));
    currentRTCSession.on("ended", () => {
      setStatus(`Ready — registered as ${agent.displayName}`);
      currentRTCSession = null;
      setHangupVisible(false);
    });
    currentRTCSession.on("failed", () => {
      setStatus(`Ready — registered as ${agent.displayName}`);
      currentRTCSession = null;
      setHangupVisible(false);
    });

    // answer() reaches for the microphone. Anything that throws here — no
    // getUserMedia (the iframe is not a secure context), or the Freshdesk
    // iframe not delegating microphone permission — used to abort this handler
    // silently: the browser never picks up, Vobiz rings until it gives up, and
    // the dial result reads "ring=true" with no B leg and no explanation
    // anywhere. Say what happened instead.
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("navigator.mediaDevices is unavailable — this frame is not a secure context");
      }
      // pcConfig matters here exactly as much as it does on an outbound call:
      // without STUN the answer carries host-only candidates and the leg is torn
      // down without connecting, leaving a B leg billed 0s and no explanation.
      currentRTCSession.answer({
        mediaConstraints: { audio: true, video: false },
        pcConfig: { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] },
        sessionTimersExpires: 300,
      });
    } catch (err) {
      console.error("[Vobiz] could not answer the incoming leg:", err);
      setStatus(`Could not answer — ${err.name === "NotAllowedError"
        ? "microphone permission was refused for this frame"
        : err.message}`);
      try { currentRTCSession.terminate(); } catch { /* already gone */ }
      currentRTCSession = null;
      setHangupVisible(false);
    }
  });

  ua.start();

  // Surface a dead microphone path at startup rather than mid-call.
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    console.error("[Vobiz] navigator.mediaDevices is unavailable in this frame — inbound audio cannot work.");
    setStatus("No microphone access in this frame — calls will ring but cannot connect.");
  }
}

function onTriggerDialer(event) {
  client.interface.trigger("show", { id: "softphone" });
  const data = event.helper.getData();
  placeCall(data && data.number);
}

function onDialButtonClick() {
  const input = document.getElementById("dialnumber");
  const number = input && input.value.trim();
  placeCall(number);
}

/**
 * Place an outbound call with this browser as the A leg.
 *
 * The INVITE goes from here. Vobiz then fetches the answer URL of the
 * application this endpoint is bound to, and the backend reaches the customer
 * from there — by default by putting this leg in a conference room and dialling
 * the customer into it (see docs/architecture.md).
 *
 * The reverse — the backend dials the customer over the REST API, then rings
 * this browser with <Dial><User> — is not used: the REST API cannot originate
 * to a WebRTC endpoint, and the customer would hear ringback while the agent
 * is being found.
 */
function placeCall(number) {
  if (!number) return;

  const numEl = document.getElementById("callnum");
  if (numEl) {
    numEl.textContent = `Calling ${number}…`;
    numEl.hidden = false;
  }

  if (!vobizUA || !sipRegistered) {
    const message = "Not registered yet — wait for the badge to go green.";
    if (numEl) numEl.textContent = message;
    setLoginStatus(message);
    return;
  }

  // Vobiz routes a bare E.164 destination; the registrar is the SIP domain.
  const target = `sip:${String(number).replace(/[^\d+]/g, "")}@registrar.vobiz.ai`;
  // Names this call to the backend, which keys the customer's leg by it, so
  // /call-status can say whether the customer has picked up yet.
  const callRef = newCallRef();
  const headers = [`X-VH-Call-Ref: ${callRef}`];
  if (selectedCallerId) headers.unshift(`X-VH-Caller-ID: ${selectedCallerId}`);

  try {
    const session = vobizUA.call(target, {
      mediaConstraints: { audio: true, video: false },
      // Without a STUN server the offer carries only host candidates, so Vobiz
      // sees a private address and logs "PrivateIP … Detected in SDP"; the
      // early-media answer that comes back is then rejected by the browser as
      // an incompatible SDP and the call is cancelled inside a few hundred ms.
      // These are the values Vobiz's own SDK uses.
      pcConfig: { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] },
      sessionTimersExpires: 300,
      // Vobiz passes X-VH- headers to the answer URL, so the backend reads the
      // caller ID off this call itself. It still checks it against the account.
      extraHeaders: headers,
    });
    currentRTCSession = session;
    attachRemoteAudio(session);
    setHangupVisible(true);

    session.on("progress", () => { if (numEl) numEl.textContent = `Ringing ${number}…`; });
    // Vobiz answers this leg as soon as it is in the conference room, which is
    // before the customer's phone has even rung. So "confirmed" means "your
    // leg is up"; the backend says when the customer joins.
    session.on("confirmed", () => {
      if (signInMode === "account") {
        if (numEl) numEl.textContent = `Ringing ${number}…`;
        setStatus("Ringing — waiting for the customer to answer");
        pollCallStatus(callRef, number, session);
      } else {
        showConnected(number);
      }
    });
    session.on("failed", e => {
      stopCallStatusPolling();
      const cause = (e && e.cause) || "unknown";
      if (numEl) numEl.textContent = `Call failed — ${cause}`;
      setStatus("Ready");
      currentRTCSession = null;
      setHangupVisible(false);
    });
    session.on("ended", () => {
      stopCallStatusPolling();
      if (numEl) {
        numEl.textContent = "Call ended";
        setTimeout(() => { numEl.hidden = true; }, 4000);
      }
      setStatus("Ready");
      currentRTCSession = null;
      setHangupVisible(false);
      // Vobiz writes the CDR a few seconds after the call ends, so refreshing
      // immediately would miss this call and look like nothing happened.
      setTimeout(loadCallHistory, 5000);
    });
  } catch (err) {
    console.error("[Vobiz] Could not start the call:", err);
    const message = err && err.name === "NotAllowedError"
      ? "Microphone permission was refused for this frame"
      : `Could not start the call — ${err.message}`;
    if (numEl) numEl.textContent = message;
    setLoginStatus(message);
  }
}

function showConnected(number) {
  const numEl = document.getElementById("callnum");
  if (numEl) numEl.textContent = `On a call with ${number}`;
  setStatus("On a call");
}

function newCallRef() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

function stopCallStatusPolling() {
  if (callStatusTimer) clearTimeout(callStatusTimer);
  callStatusTimer = null;
}

/**
 * Ask the backend whether the customer has joined, until they have. "ringing"
 * keeps polling; "connected" shows the call as live. Anything else — a backend
 * that does not track it (OUTBOUND_MODE=dial), or an error — falls back to
 * "On a call", which is what JsSIP alone can say.
 */
async function pollCallStatus(callRef, number, session) {
  stopCallStatusPolling();
  if (currentRTCSession !== session) return;
  let state = null;
  try {
    const res = await backendFetch(`${BACKEND_URL}/call-status/${encodeURIComponent(callRef)}`);
    const data = await res.json();
    if (res.ok) state = data.state || null;
  } catch (err) {
    console.warn("[Vobiz] Could not read the call status:", err);
  }
  if (currentRTCSession !== session) return;
  if (state === "ringing") {
    callStatusTimer = setTimeout(() => pollCallStatus(callRef, number, session), CALL_STATUS_POLL_MS);
    return;
  }
  showConnected(number);
}
