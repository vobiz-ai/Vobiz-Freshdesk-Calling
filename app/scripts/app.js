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
let statusTimer = null;

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
  if (!/^https:\/\//i.test(BACKEND_URL)) {
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

function setHangupVisible(visible) {
  const btn = document.getElementById("hangupbtn");
  if (btn) btn.hidden = !visible;
}

async function restoreVobizSession() {
  try {
    const res = await fetch(`${BACKEND_URL}/session/${encodeURIComponent(AGENT_ID)}`);
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
    const res = await fetch(`${BACKEND_URL}/login`, {
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
    const res = await fetch(`${BACKEND_URL}/select-number`, {
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
    const res = await fetch(`${BACKEND_URL}/setup-inbound`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: AGENT_ID }),
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
    const res = await fetch(`${BACKEND_URL}/recordings/${encodeURIComponent(AGENT_ID)}?limit=15`);
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
    const res = await fetch(`${BACKEND_URL}/agent/${encodeURIComponent(AGENT_ID)}`);
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

    currentRTCSession.answer({ mediaConstraints: { audio: true, video: false } });
  });

  vobizUA.start();
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

async function placeCall(number) {
  if (!number) return;

  const numEl = document.getElementById("callnum");
  if (numEl) {
    numEl.textContent = `Calling ${number}…`;
    numEl.hidden = false;
  }

  let result;
  try {
    const res = await fetch(`${BACKEND_URL}/start-call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: number, agentId: AGENT_ID, platform: "freshdesk" }),
    });
    result = await res.json();
    if (!res.ok) {
      const message = result.error || `Call failed (${res.status})`;
      if (numEl) numEl.textContent = message;
      setLoginStatus(message);
      return;
    }
  } catch (err) {
    console.error("[Vobiz] Could not start the call:", err);
    if (numEl) numEl.textContent = "Could not reach the calling backend";
    setLoginStatus("Could not reach the calling backend");
    return;
  }

  const callUuid = result.request_uuid;
  if (callUuid && numEl) watchCallStatus(callUuid, number, numEl);
}

// The AI/agent leg never rings into this browser tab, so there's no SIP
// event here to say the call ended — poll Vobiz directly instead. Skips
// the first couple of polls' worth of "ended" readings, since a
// just-placed call is briefly "queued" (not "live" yet) and would
// otherwise look like it already finished.
function watchCallStatus(callUuid, number, numEl) {
  let sawLive = false;
  let ticks = 0;
  // A generous ceiling so a genuinely long call is not cut off in the UI,
  // while a call that never goes live still stops polling. Applied on every
  // tick, not only while the call is idle.
  const maxTicks = 1200; // ~60 minutes at 3s/tick

  // Two dials in one session would otherwise leave two timers racing on the
  // same element, each independently scheduling a history refresh.
  if (statusTimer) clearInterval(statusTimer);

  const timer = setInterval(async () => {
    ticks += 1;
    try {
      const res = await fetch(`${BACKEND_URL}/call-status/${encodeURIComponent(callUuid)}?agentId=${encodeURIComponent(AGENT_ID)}`);
      const { active } = await res.json();
      if (active) {
        sawLive = true;
        numEl.textContent = `On a call with ${number}…`;
      }
      if ((!active && sawLive) || ticks >= maxTicks) {
        clearInterval(timer);
        if (statusTimer === timer) statusTimer = null;
        numEl.textContent = "Call ended";
        setTimeout(() => { numEl.hidden = true; }, 4000);
        // Vobiz writes the CDR a few seconds after the call actually ends,
        // so refresh a beat later rather than immediately (an instant
        // refresh would just miss this call and look like nothing happened).
        setTimeout(loadCallHistory, 5000);
      }
    } catch (err) {
      console.warn("[Vobiz] call-status poll failed:", err);
    }
  }, 3000);

  statusTimer = timer;
}
