/** === Vobiz Calling — Freshdesk CTI sidebar app ===
 *
 * A softphone panel that lives in Freshdesk's CTI placeholder. It does two
 * jobs: it stays registered over SIP for as long as the panel is open, and
 * it starts a call when an agent clicks a phone number anywhere in Freshdesk
 * (Freshdesk emits `cti.triggerDialer`).
 *
 * Every value this app needs is an installation parameter — see
 * config/iparams.json. Nothing about a particular account is compiled in.
 *
 * This app is a client. It cannot place a call on its own: it talks to a
 * calling backend that holds the Vobiz account credentials and drives the
 * Vobiz REST API. That contract is documented in docs/backend-contract.md.
 */
let BACKEND_URL = null;
let AGENT_ID = null;
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
// True only between an inbound leg arriving and it being accepted, declined or
// withdrawn. The keyboard shortcuts are gated on this.
let incomingPending = false;

/**
 * Every backend call goes through here.
 *
 * ngrok's free tier serves a browser interstitial (ERR_NGROK_6024) to anything
 * with a browser User-Agent, which means a plain fetch() from this panel gets an
 * HTML warning page instead of JSON. The `ngrok-skip-browser-warning` header
 * suppresses it. It is inert against any other host, so it costs nothing once
 * the backend is on a real domain.
 */
async function backendFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: { "ngrok-skip-browser-warning": "1", ...(options.headers || {}) },
  });
}

init();

async function init() {
  client = await app.initialized();

  const iparams = await client.iparams.get();
  BACKEND_URL = (iparams.backend_url || "").trim().replace(/\/+$/, "");
  AGENT_ID = (iparams.agent_id || "").trim();
  REGISTRAR_URL = (iparams.registrar_url || "wss://registrar.vobiz.ai:5063/").trim();

  if (!BACKEND_URL || !AGENT_ID) {
    setStatus("Not configured — set the Backend URL and Agent Identity in this app's settings.");
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

  client.events.on("cti.triggerDialer", onTriggerDialer);
  document.getElementById("dialbtn").addEventListener("click", onDialButtonClick);
  document.getElementById("vobiz-login-btn").addEventListener("click", vobizLogin);
  document.getElementById("vobiz-number-select").addEventListener("change", vobizSelectNumber);
  document.getElementById("setup-inbound-btn").addEventListener("click", setupInboundCalling);
  document.getElementById("refresh-history-btn").addEventListener("click", loadCallHistory);
  document.getElementById("hangupbtn").addEventListener("click", hangUp);
  document.getElementById("acceptbtn").addEventListener("click", acceptCall);
  document.getElementById("declinebtn").addEventListener("click", declineCall);

  // Enter and Escape while a call is ringing. An agent already reaching for the
  // keyboard should not have to find the mouse to pick up.
  // Gated on incomingPending rather than on the banner's hidden attribute: the
  // listener is on document, so it sees every keystroke in the panel, and
  // reading state back off the DOM makes it act on a banner some other code
  // put there.
  document.addEventListener("keydown", e => {
    if (!incomingPending) return;
    if (e.key === "Enter") { e.preventDefault(); acceptCall(); }
    else if (e.key === "Escape") { e.preventDefault(); declineCall(); }
  });

  // Leave the registrar cleanly. Without this the binding lingers until it
  // expires (JsSIP defaults to 600s) and inbound calls route to a dead leg
  // for up to ten minutes after the agent closes the tab.
  window.addEventListener("beforeunload", () => {
    try { if (vobizUA) vobizUA.stop(); } catch { /* nothing useful to do on the way out */ }
  });

  initVobizSip();
  restoreVobizSession();
}

/** === Vobiz account login (Auth ID / Auth Token) ===
 * Separate from initVobizSip() above: that's the SIP identity used for a
 * future real agent bridge. This is which Vobiz *account* places the call —
 * whose number it goes out on, whose balance it bills to. Without logging
 * in here, /start-call is rejected by the backend; there is no more shared
 * fallback account.
 */
function setLoginStatus(text) {
  const el = document.getElementById("vobiz-login-status");
  if (el) el.textContent = text;
}

function renderNumberOptions(numbers, selected) {
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
  const hasNumbers = (numbers || []).length > 0;
  select.hidden = !hasNumbers;
  const label = document.getElementById("vobiz-number-label");
  if (label) label.hidden = !hasNumbers;
}

function setDialEnabled(enabled) {
  accountReady = Boolean(enabled);
  refreshDialState();
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

/** === Incoming calls ===
 *
 * An inbound leg is NOT answered on arrival. answer() reaches for the
 * microphone, and a browser treats a microphone request that no one asked for
 * differently from one that follows a click: without a user gesture it can be
 * stalled or refused outright, particularly inside an embedded frame like this
 * one. The call then rings until the caller gives up, and the CDR shows a leg
 * billed 0s with nothing to explain it.
 *
 * Accept is that gesture. It is also simply what an agent expects — the panel
 * used to pick up by itself, with no ring, no caller shown and no way to
 * refuse.
 */
function callerOf(session) {
  try {
    const uri = session && session.remote_identity && session.remote_identity.uri;
    const user = uri && uri.user;
    if (user) return String(user).startsWith("+") ? String(user) : `+${user}`;
    return (session && session.remote_identity && session.remote_identity.display_name) || "unknown";
  } catch {
    return "unknown";
  }
}

function showIncoming(from) {
  const banner = document.getElementById("incoming");
  const fromEl = document.getElementById("incoming-from");
  if (fromEl) fromEl.textContent = from;
  if (banner) banner.hidden = false;
}

/** Clear the banner and every trace of the call it belonged to. */
function endIncoming(status) {
  incomingPending = false;
  stopRingtone();
  const banner = document.getElementById("incoming");
  if (banner) banner.hidden = true;
  setHangupVisible(false);
  currentRTCSession = null;
  if (status) setStatus(status);
}

function acceptCall() {
  if (!currentRTCSession) return;
  incomingPending = false;
  stopRingtone();
  const banner = document.getElementById("incoming");
  if (banner) banner.hidden = true;

  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("navigator.mediaDevices is unavailable — this frame is not a secure context");
    }
    attachRemoteAudio(currentRTCSession);
    // pcConfig matters here exactly as much as it does on an outbound call:
    // without STUN the answer carries host-only candidates and the leg is torn
    // down without connecting, leaving a leg billed 0s and no explanation.
    currentRTCSession.answer({
      mediaConstraints: { audio: true, video: false },
      pcConfig: { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] },
      sessionTimersExpires: 300,
    });
    setHangupVisible(true);
    setStatus("On a call");
  } catch (err) {
    console.error("[Vobiz] could not answer the incoming leg:", err);
    setStatus(`Could not answer — ${err.name === "NotAllowedError"
      ? "microphone permission was refused for this frame"
      : err.message}`);
    try { currentRTCSession.terminate(); } catch { /* already gone */ }
    endIncoming();
  }
}

function declineCall() {
  if (!currentRTCSession) return;
  incomingPending = false;
  try {
    currentRTCSession.terminate();
  } catch (err) {
    console.warn("[Vobiz] decline failed:", err);
  }
  endIncoming();
}

/** A ringtone, synthesised — nothing to ship and nothing to fail to load. */
let ringCtx = null;
let ringTimer = null;

function startRingtone() {
  stopRingtone();
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    ringCtx = new Ctx();
    const beep = () => {
      if (!ringCtx) return;
      const osc = ringCtx.createOscillator();
      const gain = ringCtx.createGain();
      osc.frequency.value = 440;
      gain.gain.setValueAtTime(0.0001, ringCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.12, ringCtx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ringCtx.currentTime + 0.9);
      osc.connect(gain).connect(ringCtx.destination);
      osc.start();
      osc.stop(ringCtx.currentTime + 0.95);
    };
    beep();
    ringTimer = setInterval(beep, 2000);
  } catch (err) {
    // A silent panel is worse than no ringtone, but not worth failing the call
    // over — the banner is still on screen either way.
    console.warn("[Vobiz] could not start the ringtone:", err);
  }
}

function stopRingtone() {
  if (ringTimer) { clearInterval(ringTimer); ringTimer = null; }
  if (ringCtx) {
    try { ringCtx.close(); } catch { /* already closed */ }
    ringCtx = null;
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
      renderNumberOptions(session.numbers, session.from);
      setLoginStatus(`Logged in as ${session.authId} — calling from ${session.from}`);
      setDialEnabled(true);
      loadCallHistory();
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
      body: JSON.stringify({ agentId: AGENT_ID, authId, authToken }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `login failed (${res.status})`);
    renderNumberOptions(data.numbers, data.selected);
    setLoginStatus(
      (data.numbers || []).length
        ? `Logged in as ${authId} — calling from ${data.selected}`
        : `Logged in as ${authId} — this account has no phone numbers yet`,
    );
    setDialEnabled(Boolean(data.selected));
    if (data.selected) loadCallHistory();
  } catch (err) {
    console.error("[Vobiz] Login failed:", err);
    setLoginStatus(`Login failed: ${err.message}`);
    setDialEnabled(false);
  }
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
    setLoginStatus(`Calling from ${data.selected}`);
  } catch (err) {
    console.error("[Vobiz] Could not switch numbers:", err);
    setLoginStatus(`Could not switch numbers: ${err.message}`);
  }
}

/** === Inbound calling setup (one-time, manual — real account changes) ===
 * Creates a Vobiz Application pointed at this backend's /inbound-answer and
 * attaches the currently-selected number to it. Only runs when the button
 * is clicked — never automatically — since this changes real Vobiz account
 * routing, not just local UI state.
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
      // Declaring the platform matters: this panel is browser-only, so the
      // backend must not also ring the agent's mobile on an inbound call.
      body: JSON.stringify({ agentId: AGENT_ID, platform: "freshdesk" }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `setup failed (${res.status})`);
    statusEl.textContent = `Inbound calls to ${data.number} now ring this panel.`;
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
  if (!listEl || !BACKEND_URL || !AGENT_ID) return;

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
    playBtn.addEventListener("click", () => playRecording(rec.recording_id));

    li.append(info, playBtn);
    listEl.appendChild(li);
  });
}

function playRecording(recordingId) {
  const audioEl = document.getElementById("vobiz-playback-audio");
  if (!audioEl) return;
  audioEl.src = `${BACKEND_URL}/recording-audio/${encodeURIComponent(AGENT_ID)}/${encodeURIComponent(recordingId)}`;
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
  if (/^call ringing/i.test(text)) return { label: "Ringing", tone: "busy" };
  if (/^connecting/i.test(text)) return { label: "Connecting", tone: "pending" };
  if (/reconnecting/i.test(text)) return { label: "Reconnecting", tone: "pending" };
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
  vobizUA = new JsSIP.UA({
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

  vobizUA.on("registered", () => {
    setStatus(`Ready — registered as ${agent.displayName}`);
    setSipRegistered(true);
  });
  vobizUA.on("registrationFailed", e => {
    setStatus(`Registration failed: ${(e && e.cause) || "unknown"}`);
    setSipRegistered(false);
  });
  // Without these two, a dropped transport leaves the panel showing "Ready"
  // while the endpoint is uncallable.
  vobizUA.on("unregistered", () => {
    setStatus("Not registered — reconnecting…");
    setSipRegistered(false);
  });
  vobizUA.on("disconnected", () => {
    setStatus("Disconnected from the registrar — reconnecting…");
    setSipRegistered(false);
  });

  // Vobiz dialing INTO this registered endpoint — the agent leg of a call
  // our backend originated via the REST API (outbound bridge).
  vobizUA.on("newRTCSession", data => {
    if (data.originator !== "remote") return;

    currentRTCSession = data.session;
    const caller = callerOf(currentRTCSession);

    setStatus(`Incoming call from ${caller}`);
    incomingPending = true;
    showIncoming(caller);
    startRingtone();

    currentRTCSession.on("confirmed", () => setStatus("On a call"));
    // The caller can give up, or Vobiz can time the leg out, while the banner
    // is still on screen. Clear it either way rather than leaving an Accept
    // button that answers a call which no longer exists.
    currentRTCSession.on("ended", () => endIncoming(`Ready — registered as ${agent.displayName}`));
    currentRTCSession.on("failed", () => endIncoming(`Ready — registered as ${agent.displayName}`));
  });

  vobizUA.start();

  // Surface a dead microphone path at startup rather than mid-call.
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    console.error("[Vobiz] navigator.mediaDevices is unavailable in this frame — inbound audio cannot work.");
    setStatus("No microphone access in this frame — calls will ring but cannot connect.");
  }
}

async function onTriggerDialer(event) {
  client.interface.trigger("show", { id: "softphone" });
  const data = event.helper.getData();
  await placeCall(data && data.number);
}

function onDialButtonClick() {
  const input = document.getElementById("dialnumber");
  const number = input && input.value.trim();
  placeCall(number);
}

/**
 * Place an outbound call with this browser as the A leg.
 *
 * The obvious design — and what docs/backend-contract.md describes — is to have
 * the backend originate to the customer over the REST API and then bridge this
 * browser in with <Dial><User>. That path is dead: routing *into* a registered
 * WebRTC endpoint is broken platform-side. Vobiz builds an unparseable gateway
 * URI for the B leg and drops its own INVITE:
 *
 *   ERROR: tr_eval_uri(): invalid uri [user@…-webrtc-3.vobiz.ai:7032;…]
 *   INVITE|blocking gw: …
 *
 * 510 of those in 14 days, across other accounts and Vobiz's own SDK. The caller
 * hears ringback and nothing else, and the dial result reads ring=true with an
 * empty DialBLegUUID.
 *
 * Dialling *out* of a registered endpoint works fine, so this sends the INVITE
 * from here instead. Vobiz then fetches the endpoint application's answer URL,
 * and the backend replies with <Dial><Number> to reach the customer — the same
 * shape Vobiz's own rtc-demo and WebRTC playground use.
 */
async function placeCall(number) {
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
    });
    currentRTCSession = session;
    attachRemoteAudio(session);
    setHangupVisible(true);

    session.on("progress", () => { if (numEl) numEl.textContent = `Ringing ${number}…`; });
    session.on("confirmed", () => {
      if (numEl) numEl.textContent = `On a call with ${number}`;
      setStatus("On a call");
    });
    session.on("failed", e => {
      const cause = (e && e.cause) || "unknown";
      if (numEl) numEl.textContent = `Call failed — ${cause}`;
      setStatus("Ready");
      currentRTCSession = null;
      setHangupVisible(false);
    });
    session.on("ended", () => {
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

