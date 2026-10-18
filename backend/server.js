#!/usr/bin/env node
/**
 * Vobiz calling backend for the Freshdesk panel.
 *
 * Implements docs/backend-contract.md against the real Vobiz REST API.
 * Zero dependencies: node:http, node:crypto and the global fetch (Node 20+).
 *
 *   cp backend/.env.example backend/.env    # fill it in
 *   npm run backend                         # http://127.0.0.1:8093
 *
 * What it guarantees, because the panel cannot:
 *
 * - The browser never sees the account Auth Token. It stays in this process.
 * - Every browser route needs the bearer token /login issues. An `agentId` on
 *   its own proves nothing and gets nothing, including the SIP password.
 * - Recording playback links are HMAC-signed and expire. The audio is fetched
 *   server-side from a Vobiz host on an allowlist, never from a caller-named URL.
 * - CORS answers only origins on an allowlist. Never `*`, never a reflection.
 *
 * Calls run with the browser as the A leg: the panel sends the SIP INVITE, and
 * Vobiz asks /answer what to do with it. See docs/architecture.md.
 */
"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// ─── configuration ───────────────────────────────────────────────────────────

/** Read KEY=value lines into process.env without overriding what is already set. */
function loadDotEnv(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    const key = t.slice(0, i).trim();
    const value = t.slice(i + 1).trim().replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

const REGISTRAR_DOMAIN = "registrar.vobiz.ai";

/** user@domain, adding the Vobiz registrar when only a username is given. */
function fullSipUser(user) {
  const u = String(user || "").trim().replace(/^sip:/i, "");
  if (!u) return "";
  return u.includes("@") ? u : `${u}@${REGISTRAR_DOMAIN}`;
}

/** The username part of a SIP identity — what Vobiz puts in `From`. */
function sipUsername(user) {
  return String(user || "").replace(/^sip:/i, "").split("@")[0];
}

function toE164(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (s.startsWith("+")) return `+${s.slice(1).replace(/\D/g, "")}`;
  // An Indian national number with its trunk prefix, as some carriers send it.
  if (/^0\d{10}$/.test(s)) return `+91${s.slice(1)}`;
  const digits = s.replace(/\D/g, "");
  return digits ? `+${digits}` : "";
}

/**
 * Who may register as whom.
 *
 * With an agents file, each Freshdesk "Agent identity" maps to its own Vobiz
 * SIP endpoint, and an identity not in the file is refused. Without one, every
 * identity shares the single endpoint in VOBIZ_SIP_USER — fine for one agent or
 * a demo, and the reason two agents must not share a backend that way.
 */
function loadAgents(env) {
  const file = env.AGENTS_FILE;
  if (file) {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const agents = new Map();
    for (const [id, a] of Object.entries(raw)) {
      if (!a || !a.sipUser || !a.sipPassword) {
        throw new Error(`${file}: agent "${id}" needs both sipUser and sipPassword`);
      }
      agents.set(id, { displayName: a.displayName || id, sipUser: fullSipUser(a.sipUser), sipPassword: a.sipPassword });
    }
    return { lookup: id => agents.get(id) || null, all: () => [...agents.values()] };
  }
  const single = env.VOBIZ_SIP_USER && env.VOBIZ_SIP_PASSWORD
    ? { sipUser: fullSipUser(env.VOBIZ_SIP_USER), sipPassword: env.VOBIZ_SIP_PASSWORD }
    : null;
  return {
    lookup: id => (single ? { displayName: id, ...single } : null),
    all: () => (single ? [single] : []),
  };
}

function readConfig(env = process.env) {
  const publicBase = String(env.PUBLIC_BASE || "").trim().replace(/\/+$/, "");
  const extraOrigins = String(env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  return {
    port: Number(env.PORT || 8093),
    host: env.HOST || "127.0.0.1",
    authId: env.VOBIZ_AUTH_ID || "",
    authToken: env.VOBIZ_AUTH_TOKEN || "",
    fromNumber: toE164(env.VOBIZ_FROM_NUMBER),
    apiBase: String(env.VOBIZ_API_BASE || "https://api.vobiz.ai").replace(/\/+$/, ""),
    publicBase,
    agents: loadAgents(env),
    // How outbound calls are bridged. See answerOutbound().
    outboundMode: (env.OUTBOUND_MODE || "conference").toLowerCase() === "dial" ? "dial" : "conference",
    recordCalls: /^(1|true|yes)$/i.test(env.RECORD_CALLS || ""),
    ringSeconds: Math.min(Math.max(Number(env.INBOUND_RING_SECONDS || 30), 5), 120),
    signingSecret: env.SIGNING_SECRET || crypto.randomBytes(32).toString("hex"),
    recordingTtlSeconds: Number(env.RECORDING_URL_TTL_SECONDS || 300),
    sessionTtlMs: Number(env.SESSION_TTL_HOURS || 12) * 3600 * 1000,
    // off | log | require. See verifyWebhook().
    webhookSignature: ["off", "require"].includes(env.VOBIZ_WEBHOOK_SIGNATURE) ? env.VOBIZ_WEBHOOK_SIGNATURE : "log",
    allowedOrigins: extraOrigins,
    appName: env.VOBIZ_APP_NAME || "Freshdesk-Calling",
  };
}

// ─── CORS ────────────────────────────────────────────────────────────────────

// Origins a Freshdesk app iframe or the FDK dev server can come from. Anything
// else is answered without Access-Control-Allow-Origin, so the browser refuses
// to hand the response to the page. ALLOWED_ORIGINS adds exact origins, or
// suffix patterns written as https://*.example.com.
const BUILTIN_ORIGINS = [
  /^https:\/\/[a-z0-9-]+\.freshdesk\.com$/i,
  /^https:\/\/[a-z0-9-]+\.myfreshworks\.com$/i,
  /^https:\/\/[a-z0-9-]+\.freshworks\.com$/i,
  /^https?:\/\/localhost(:\d+)?$/i,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/i,
];

function originAllowed(origin, extra) {
  if (!origin || origin === "null") return false;
  if (BUILTIN_ORIGINS.some(re => re.test(origin))) return true;
  return extra.some(rule => {
    if (!rule.includes("*")) return rule === origin;
    const m = rule.match(/^(https?):\/\/\*\.(.+)$/i);
    if (!m) return false;
    const escaped = m[2].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${m[1]}://[a-z0-9-]+(\\.[a-z0-9-]+)*\\.${escaped}$`, "i").test(origin);
  });
}

// ─── XML ─────────────────────────────────────────────────────────────────────

const xmlEscape = s => String(s).replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));
const xmlDoc = inner => `<?xml version="1.0" encoding="UTF-8"?>\n<Response>${inner}</Response>`;
const EMPTY_XML = xmlDoc("");

// ─── the app ─────────────────────────────────────────────────────────────────

function createApp(config, { fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const sessions = new Map();        // token -> { agentId, agent, numbers, from, createdAt }
  const fromBySipUser = new Map();   // SIP username -> caller ID the agent picked
  const inboundRoutes = new Map();   // DID (E.164) -> SIP user@domain to ring
  const rooms = new Map();           // outbound room -> { agentCallUuid, joined, createdAt }

  // ── Vobiz REST ────────────────────────────────────────────────────────────
  async function vobiz(method, apiPath, body) {
    try {
      const res = await fetchImpl(`${config.apiBase}/api/v1/Account/${config.authId}${apiPath}`, {
        method,
        headers: {
          "X-Auth-ID": config.authId,
          "X-Auth-Token": config.authToken,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const raw = await res.text();
      let parsed = raw;
      try { parsed = JSON.parse(raw); } catch { /* keep the raw body */ }
      return { status: res.status, body: parsed };
    } catch (err) {
      return { status: 0, body: { error: err.message } };
    }
  }

  // ── sessions ──────────────────────────────────────────────────────────────
  function getSession(req) {
    const h = String(req.headers.authorization || "");
    const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
    if (!token) return null;
    const s = sessions.get(token);
    if (!s) return null;
    if (Date.now() - s.createdAt > config.sessionTtlMs) { sessions.delete(token); return null; }
    return s;
  }

  const safeEqual = (a, b) => {
    const x = crypto.createHash("sha256").update(String(a)).digest();
    const y = crypto.createHash("sha256").update(String(b)).digest();
    return crypto.timingSafeEqual(x, y);
  };

  // ── recording links ───────────────────────────────────────────────────────
  const hmac = msg => crypto.createHmac("sha256", config.signingSecret).update(msg).digest("hex");

  function signRecording(agentId, recordingId) {
    const exp = Math.floor(Date.now() / 1000) + config.recordingTtlSeconds;
    const sig = hmac(`${agentId}|${recordingId}|${exp}`);
    return `/recording-audio/${encodeURIComponent(agentId)}/${encodeURIComponent(recordingId)}?exp=${exp}&sig=${sig}`;
  }

  function verifyRecording(agentId, recordingId, exp, sig) {
    if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
    const a = Buffer.from(String(sig));
    const b = Buffer.from(hmac(`${agentId}|${recordingId}|${exp}`));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // Where recording audio may be fetched from, and which of those hosts may
  // see the account credentials. Vobiz serves media from *.vobiz.ai; a redirect
  // to presigned object storage carries its own authorisation, so the Auth
  // Token is never sent there.
  const isVobizHost = h => /(^|\.)vobiz\.ai$/i.test(h);
  const isMediaHost = h => isVobizHost(h) || /(^|\.)s3([.-][a-z0-9-]+)?\.amazonaws\.com$/i.test(h);

  async function fetchRecordingAudio(startUrl) {
    let url = startUrl;
    for (let hop = 0; hop < 4; hop += 1) {
      let u;
      try { u = new URL(url); } catch { return { error: "bad recording URL" }; }
      if (u.protocol !== "https:" || !isMediaHost(u.hostname)) return { error: `refusing to fetch audio from ${u.hostname}` };
      const headers = isVobizHost(u.hostname) ? { "X-Auth-ID": config.authId, "X-Auth-Token": config.authToken } : {};
      const res = await fetchImpl(url, { headers, redirect: "manual" });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        url = new URL(res.headers.get("location"), url).toString();
        continue;
      }
      return { res };
    }
    return { error: "too many redirects" };
  }

  // ── webhook signatures ────────────────────────────────────────────────────
  //
  // Vobiz signs callbacks over the callback URL (query string stripped) and a
  // nonce — never over the body, which is form-encoded:
  //   V3 = base64(HMAC-SHA256(authToken, baseURL + "." + nonce))
  //   V2 = base64(HMAC-SHA256(authToken, baseURL + nonce))
  // The URL is the public one Vobiz called, so it is rebuilt from PUBLIC_BASE;
  // behind a tunnel the Host header is the tunnel's, not ours.
  function webhookSignatureValid(req, pathname) {
    const base = `${config.publicBase}${pathname}`;
    const check = (sigHeader, nonceHeader, sep) => {
      const sig = req.headers[sigHeader];
      const nonce = req.headers[nonceHeader];
      if (!sig || !nonce) return null;
      const expected = crypto.createHmac("sha256", config.authToken).update(`${base}${sep}${nonce}`).digest("base64");
      const a = Buffer.from(String(sig));
      const b = Buffer.from(expected);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    };
    const v3 = check("x-vobiz-signature-v3", "x-vobiz-signature-v3-nonce", ".");
    if (v3 !== null) return v3;
    return check("x-vobiz-signature-v2", "x-vobiz-signature-v2-nonce", "");
  }

  /** true when the webhook may proceed. */
  function verifyWebhook(req, pathname) {
    if (config.webhookSignature === "off") return true;
    const ok = webhookSignatureValid(req, pathname);
    if (ok === true) return true;
    const why = ok === null ? "no signature headers" : "signature mismatch";
    if (config.webhookSignature === "require") {
      log(`✖ rejected ${pathname}: ${why}`);
      return false;
    }
    log(`  (webhook ${pathname}: ${why} — set VOBIZ_WEBHOOK_SIGNATURE=require once this reads valid)`);
    return true;
  }

  // ── call control ──────────────────────────────────────────────────────────
  const recordXml = () => (config.recordCalls
    ? '<Record fileFormat="mp3" recordSession="true" maxLength="14400" playBeep="false" redirect="false"/>'
    : "");

  const dialAttrs = callerId =>
    `callerId="${xmlEscape(callerId)}" timeout="${config.ringSeconds}" timeLimit="14400" ` +
    `action="${xmlEscape(`${config.publicBase}/dial-status`)}" method="POST" redirect="false"`;

  /**
   * The browser dialled out. Reach the customer.
   *
   * conference (default): the agent's leg waits in a room of its own and the
   * customer is dialled into it over the REST API. <Dial><Number> straight
   * from a WebRTC leg was measured losing the phone side's media on three of
   * five calls (98–99% packet loss) while the browser side stayed clean; a
   * REST-placed leg joined to a conference measured clean every time.
   *
   * dial: the documented <Dial><Number>. Kept behind OUTBOUND_MODE=dial as a
   * way back once the bridge is fixed upstream.
   */
  async function answerOutbound(p) {
    const from = String(p.From || "");
    const user = sipUsername(from);
    const destination = toE164(p.To);
    if (!/^\+\d{6,15}$/.test(destination)) {
      log(`  ✖ outbound to "${p.To}" is not a dialable number — hanging up`);
      return xmlDoc("<Hangup/>");
    }
    const callerId = fromBySipUser.get(user) || config.fromNumber;
    const agentCallUuid = String(p.CallUUID || "");

    if (config.outboundMode === "dial") {
      log(`  → outbound (dial) ${user} → ${destination} as ${callerId}`);
      return xmlDoc(`${recordXml()}<Dial ${dialAttrs(callerId)}><Number>${xmlEscape(destination.slice(1))}</Number></Dial>`);
    }

    const room = `fd${agentCallUuid.replace(/[^a-z0-9]/gi, "") || crypto.randomBytes(8).toString("hex")}`;
    rooms.set(room, { agentCallUuid, joined: false, createdAt: Date.now() });
    log(`  → outbound (conference ${room}) ${user} → ${destination} as ${callerId}`);

    const q = `room=${encodeURIComponent(room)}`;
    const placed = await vobiz("POST", "/Call/", {
      // The REST API takes E.164 digits without the leading +.
      from: callerId.replace(/^\+/, ""),
      to: destination.slice(1),
      answer_url: `${config.publicBase}/outbound-join?${q}`,
      answer_method: "POST",
      hangup_url: `${config.publicBase}/outbound-hangup?${q}`,
      hangup_method: "POST",
    });
    if (placed.status < 200 || placed.status >= 300) {
      log(`  ✖ Vobiz refused the customer leg: ${placed.status} ${JSON.stringify(placed.body).slice(0, 200)}`);
      rooms.delete(room);
      return xmlDoc('<Speak>The call could not be placed.</Speak><Hangup/>');
    }

    return xmlDoc(
      recordXml() +
      `<Conference stayAlone="true" startConferenceOnEnter="false" endConferenceOnExit="true" ` +
      `waitSound="${xmlEscape(`${config.publicBase}/outbound-wait`)}" timeLimit="14400" ` +
      `callbackUrl="${xmlEscape(`${config.publicBase}/conf-event`)}" callbackMethod="POST">${room}</Conference>` +
      "<Hangup/>",
    );
  }

  /**
   * A PSTN caller reached one of the account's numbers. Ring the browser.
   *
   * callerId must be the DID that was dialled: left unset, Vobiz derives it
   * from the A leg — the caller's own number, which the account does not own —
   * and refuses to create the B leg, so the browser never rings.
   */
  function answerInbound(p) {
    const did = toE164(p.To) || config.fromNumber;
    const fallback = config.agents.all()[0];
    const target = inboundRoutes.get(did) || (fallback && fallback.sipUser);
    if (!target) {
      log("  ✖ inbound call but no SIP endpoint is configured");
      return xmlDoc("<Speak>Sorry, nobody is available to take your call.</Speak><Hangup/>");
    }
    log(`  → inbound ${p.From || "?"} → ${did}, ringing sip:${target}`);
    return xmlDoc(`${recordXml()}<Dial ${dialAttrs(did)}><User>sip:${xmlEscape(target)}</User></Dial>`);
  }

  async function handleAnswer(p) {
    // A hangup notification is not a request for instructions. Answering it
    // with call control would start a fresh leg after the call has ended.
    if ((p.Event || p.event) === "Hangup") return EMPTY_XML;
    const from = String(p.From || "");
    const fromBrowser = /^sip:/i.test(from) || String(p.RouteType || "").toLowerCase() === "sip";
    return fromBrowser ? answerOutbound(p) : answerInbound(p);
  }

  // ── application / number / endpoint binding ───────────────────────────────
  async function bindInbound(session) {
    const answerUrl = `${config.publicBase}/answer`;
    const apps = await vobiz("GET", "/Application/?limit=100");
    if (apps.status !== 200) return { error: `Vobiz returned ${apps.status} listing applications` };
    let app = ((apps.body && apps.body.objects) || []).find(a => a.answer_url === answerUrl);
    if (!app) {
      const created = await vobiz("POST", "/Application/", {
        app_name: config.appName,
        answer_url: answerUrl,
        answer_method: "POST",
        hangup_url: answerUrl,
        hangup_method: "POST",
      });
      if (created.status >= 300) return { error: `Vobiz returned ${created.status} creating the application` };
      app = created.body;
    }
    const appId = app && app.app_id;
    if (!appId) return { error: "Vobiz did not return an application id" };

    // The docs name the field application_id; app_id is what has been observed
    // working. Sending both is harmless.
    const did = session.from;
    const attached = await vobiz("POST", `/numbers/${encodeURIComponent(did)}/application`, { application_id: appId, app_id: appId });
    if (attached.status >= 300) return { error: `Vobiz returned ${attached.status} attaching ${did}` };

    // The endpoint's application is what answers the browser's own INVITE, so
    // outbound depends on this binding too.
    const username = sipUsername(session.agent.sipUser);
    const eps = await vobiz("GET", "/Endpoint/?limit=100");
    const ep = ((eps.body && eps.body.objects) || []).find(e => e.username === username);
    let endpointBound = false;
    if (ep) {
      const r = await vobiz("POST", `/Endpoint/${encodeURIComponent(ep.endpoint_id)}/`, { application: appId, app_id: appId });
      endpointBound = r.status >= 200 && r.status < 300;
    }
    inboundRoutes.set(did, session.agent.sipUser);
    return { number: did, appId, endpointBound };
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let raw = "";
      req.on("data", c => {
        raw += c;
        if (raw.length > 64 * 1024) { reject(new Error("body too large")); req.destroy(); }
      });
      req.on("end", () => resolve(raw));
      req.on("error", reject);
    });
  }

  /** Webhooks are form-encoded; the panel sends JSON. Accept either. */
  function parseBody(raw, req) {
    if (!raw) return {};
    const type = String(req.headers["content-type"] || "");
    if (type.includes("application/json")) {
      try { const v = JSON.parse(raw); return v && typeof v === "object" ? v : {}; } catch { return {}; }
    }
    return Object.fromEntries(new URLSearchParams(raw));
  }

  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const cors = { Vary: "Origin" };
    if (originAllowed(origin, config.allowedOrigins)) {
      cors["Access-Control-Allow-Origin"] = origin;
      cors["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS";
      // ngrok-skip-browser-warning must be listed or the preflight fails and the
      // real request is never sent.
      cors["Access-Control-Allow-Headers"] = "Content-Type, Authorization, ngrok-skip-browser-warning";
      cors["Access-Control-Max-Age"] = "600";
    } else if (origin) {
      log(`  (origin ${origin} is not allowed — add it to ALLOWED_ORIGINS if this is your Freshdesk app)`);
    }

    const send = (code, payload, headers = {}) => {
      const isBuf = Buffer.isBuffer(payload);
      const isXml = typeof payload === "string" && payload.startsWith("<?xml");
      res.writeHead(code, {
        "Content-Type": isXml ? "text/xml" : isBuf ? "application/octet-stream" : "application/json",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
        ...cors,
        ...headers,
      });
      res.end(isBuf || typeof payload === "string" ? payload : JSON.stringify(payload));
    };

    let url;
    try { url = new URL(req.url, "http://backend.local"); } catch { return send(400, { error: "bad request" }); }
    const p = url.pathname.replace(/\/+$/, "") || "/";
    const q = Object.fromEntries(url.searchParams);
    const method = req.method;
    let m;

    if (method === "OPTIONS") return send(204, "");

    let body = {};
    if (method === "POST") {
      try { body = parseBody(await readBody(req), req); } catch { return send(413, { error: "request too large" }); }
    }

    try {
      // ── webhooks Vobiz calls ──────────────────────────────────────────────
      const WEBHOOKS = ["/answer", "/inbound-answer", "/dial-status", "/outbound-join", "/outbound-hangup", "/outbound-wait", "/conf-event"];
      if (WEBHOOKS.includes(p)) {
        if (!verifyWebhook(req, p)) return send(403, EMPTY_XML);
        const params = { ...q, ...body };
        log(`WEBHOOK ${method} ${p} ${["Event", "CallUUID", "From", "To", "CallStatus", "DialStatus", "ConferenceAction"].map(k => params[k] ? `${k}=${params[k]}` : "").filter(Boolean).join(" ")}`);

        if (p === "/answer" || p === "/inbound-answer") return send(200, await handleAnswer(params));

        if (p === "/dial-status") {
          if (!params.DialBLegUUID) log("  ⚠ no B leg was created — unreachable destination, or a callerId the account does not own");
          return send(200, EMPTY_XML);
        }

        if (p === "/outbound-wait") return send(200, xmlDoc('<Wait length="10"/>'));

        if (p === "/conf-event") return send(200, EMPTY_XML);

        if (p === "/outbound-join") {
          if ((params.Event || "") === "Hangup") return send(200, EMPTY_XML);
          const room = rooms.get(q.room);
          if (!room) return send(200, xmlDoc("<Hangup/>"));
          room.joined = true;
          return send(200, xmlDoc(
            `<Conference startConferenceOnEnter="true" stayAlone="false" endConferenceOnExit="true" timeLimit="14400">${xmlEscape(q.room)}</Conference><Hangup/>`,
          ));
        }

        if (p === "/outbound-hangup") {
          // The customer's leg ended. If they never answered, nothing else will
          // release the agent, who is sitting alone in a room that stays open.
          const room = rooms.get(q.room);
          if (room) {
            rooms.delete(q.room);
            if (!room.joined && room.agentCallUuid) {
              log(`  customer never answered (${params.HangupCause || params.CallStatus || "?"}) — releasing the agent's leg`);
              await vobiz("DELETE", `/Call/${encodeURIComponent(room.agentCallUuid)}/`);
            }
          }
          return send(200, EMPTY_XML);
        }
      }

      if (p === "/health" && method === "GET") return send(200, { ok: true });

      // ── routes the browser calls ──────────────────────────────────────────
      if (p === "/login" && method === "POST") {
        const { agentId, authId, authToken } = body;
        if (!agentId || !authId || !authToken) return send(400, { error: "agentId, authId and authToken are all required" });
        if (!config.authId || !config.authToken) return send(500, { error: "This backend has no Vobiz account configured" });
        // Compare both, always, in constant time.
        const idOk = safeEqual(authId, config.authId);
        const tokenOk = safeEqual(authToken, config.authToken);
        if (!idOk || !tokenOk) {
          log(`login refused for agent "${agentId}"`);
          return send(401, { error: "Invalid Auth ID or Auth Token for the account this backend serves" });
        }
        const agent = config.agents.lookup(String(agentId));
        if (!agent) return send(403, { error: `Unknown agent identity "${agentId}" — add it to the backend's agents file` });

        const r = await vobiz("GET", "/numbers?per_page=50");
        if (r.status !== 200) return send(502, { error: `Vobiz returned ${r.status} listing numbers` });
        const numbers = ((r.body && r.body.items) || []).map(n => toE164(n.e164 || n.number)).filter(Boolean);
        if (config.fromNumber && !numbers.includes(config.fromNumber)) numbers.unshift(config.fromNumber);
        const from = numbers.includes(config.fromNumber) ? config.fromNumber : numbers[0] || null;

        const token = crypto.randomBytes(32).toString("hex");
        sessions.set(token, { agentId: String(agentId), agent, numbers, from, createdAt: Date.now() });
        if (from) fromBySipUser.set(sipUsername(agent.sipUser), from);
        log(`login ok — agent "${agentId}", ${numbers.length} number(s)`);
        return send(200, { token, numbers, selected: from });
      }

      // Everything below needs the session /login issued.
      const session = getSession(req);
      const sameAgent = id => session && session.agentId === decodeURIComponent(id);

      if ((m = p.match(/^\/session\/([^/]+)$/)) && method === "GET") {
        if (!sameAgent(m[1])) return send(200, { loggedIn: false });
        return send(200, { loggedIn: true, numbers: session.numbers, from: session.from, authId: config.authId });
      }

      // An <audio> element cannot send an Authorization header, so playback is
      // authorised by the signature /recordings put on the link instead. The
      // audio URL is resolved here from the recording id — a caller never gets
      // to name what this server fetches.
      if ((m = p.match(/^\/recording-audio\/([^/]+)\/([^/]+)$/)) && method === "GET") {
        const agentId = decodeURIComponent(m[1]);
        const recordingId = decodeURIComponent(m[2]);
        if (!verifyRecording(agentId, recordingId, q.exp, q.sig)) return send(403, { error: "Invalid or expired playback link" });
        const meta = await vobiz("GET", `/Recording/${encodeURIComponent(recordingId)}/`);
        const src = meta.status === 200 && meta.body && meta.body.recording_url;
        if (!src) return send(404, { error: "No audio for that recording" });
        const { res: audio, error } = await fetchRecordingAudio(src);
        if (error) { log(`  ✖ recording ${recordingId}: ${error}`); return send(502, { error: "Could not fetch the recording" }); }
        if (!audio.ok) return send(502, { error: `Vobiz returned ${audio.status} for the recording audio` });
        const buf = Buffer.from(await audio.arrayBuffer());
        return send(200, buf, { "Content-Type": audio.headers.get("content-type") || "audio/mpeg", "Content-Length": String(buf.length) });
      }

      if (!session) return send(401, { error: "Sign in first" });

      if ((m = p.match(/^\/agent\/([^/]+)$/)) && method === "GET") {
        if (!sameAgent(m[1])) return send(403, { error: "That identity belongs to a different session" });
        const a = session.agent;
        return send(200, { displayName: a.displayName, sipUser: a.sipUser, sipPassword: a.sipPassword });
      }

      if (p === "/logout" && method === "POST") {
        for (const [t, s] of sessions) if (s === session) sessions.delete(t);
        return send(200, { ok: true });
      }

      if (p === "/select-number" && method === "POST") {
        const number = toE164(body.number);
        if (!session.numbers.includes(number)) return send(400, { error: "That number is not on this account" });
        session.from = number;
        fromBySipUser.set(sipUsername(session.agent.sipUser), number);
        return send(200, { selected: number });
      }

      if (p === "/setup-inbound" && method === "POST") {
        if (!/^https:\/\//.test(config.publicBase)) return send(500, { error: "PUBLIC_BASE must be the public https URL Vobiz reaches this backend on" });
        if (!session.from) return send(400, { error: "Pick a number to receive calls on first" });
        const r = await bindInbound(session);
        if (r.error) return send(502, { error: r.error });
        log(`inbound: ${r.number} → app ${r.appId}${r.endpointBound ? ", endpoint bound" : ", endpoint NOT bound — bind it in the console"}`);
        return send(200, r);
      }

      if (p === "/start-call" && method === "POST") {
        // The browser places outbound calls itself; nothing here originates one.
        return send(410, { error: "Outbound calls are placed by the panel over SIP. See docs/backend-contract.md." });
      }

      if ((m = p.match(/^\/call-status\/([^/]+)$/)) && method === "GET") {
        const r = await vobiz("GET", `/Call/${encodeURIComponent(decodeURIComponent(m[1]))}/?status=live`);
        return send(200, { active: r.status === 200 });
      }

      if ((m = p.match(/^\/recordings\/([^/]+)$/)) && method === "GET") {
        if (!sameAgent(m[1])) return send(403, { error: "That identity belongs to a different session" });
        const limit = Math.min(Math.max(Number(q.limit) || 15, 1), 100);
        const r = await vobiz("GET", `/Recording/?limit=${limit}`);
        if (r.status !== 200) return send(502, { error: `Vobiz returned ${r.status} listing recordings` });
        const objects = ((r.body && r.body.objects) || []).map(o => ({
          recording_id: o.recording_id,
          add_time: o.add_time,
          rounded_recording_duration: o.rounded_recording_duration,
          playUrl: signRecording(session.agentId, o.recording_id),
        }));
        return send(200, { objects });
      }

      return send(404, { error: `No route for ${method} ${p}` });
    } catch (err) {
      log(`✖ ${method} ${p}: ${err.message}`);
      return send(500, { error: "Internal error" });
    }
  });
}

module.exports = { createApp, readConfig, loadDotEnv, originAllowed, toE164, fullSipUser };

if (require.main === module) {
  loadDotEnv(path.join(__dirname, ".env"));
  const config = readConfig();
  const missing = ["VOBIZ_AUTH_ID", "VOBIZ_AUTH_TOKEN", "VOBIZ_FROM_NUMBER", "PUBLIC_BASE"].filter(k => !process.env[k]);
  if (!process.env.AGENTS_FILE && !(process.env.VOBIZ_SIP_USER && process.env.VOBIZ_SIP_PASSWORD)) missing.push("VOBIZ_SIP_USER/VOBIZ_SIP_PASSWORD (or AGENTS_FILE)");
  const server = createApp(config);
  server.listen(config.port, config.host, () => {
    console.log("");
    console.log("  Vobiz calling backend for Freshdesk");
    console.log(`  listening      http://${config.host}:${config.port}`);
    console.log(`  public base    ${config.publicBase || "(not set)"}`);
    console.log(`  answer URL     ${config.publicBase ? `${config.publicBase}/answer` : "(set PUBLIC_BASE)"}`);
    console.log(`  outbound       ${config.outboundMode}`);
    console.log(`  recording      ${config.recordCalls ? "on" : "off"}`);
    console.log(`  signatures     ${config.webhookSignature}`);
    if (!process.env.SIGNING_SECRET) console.log("  note           SIGNING_SECRET unset — recording links stop working on restart");
    if (missing.length) console.log(`  ✖ missing      ${missing.join(", ")}`);
    if (config.publicBase && !config.publicBase.startsWith("https://")) console.log("  ✖ PUBLIC_BASE must be https — Vobiz will not call plain http");
    console.log("");
  });
}
