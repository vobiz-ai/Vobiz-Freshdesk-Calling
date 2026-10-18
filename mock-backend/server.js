#!/usr/bin/env node
/**
 * Mock calling backend for local development.
 *
 * Implements every endpoint in docs/backend-contract.md with fake data, so the
 * Freshdesk panel can be developed and tested without a Vobiz account, real
 * credentials, or the production backend.
 *
 *   node mock-backend/server.js
 *   → http://localhost:8092
 *
 * This is a DEVELOPMENT TOOL. It accepts any credentials and places no calls.
 * It mirrors the real backend's shape — /login issues a bearer token, and the
 * SIP identity and recordings are only served with it — so the panel is
 * developed against the same flow it meets in production. Never deploy it;
 * backend/ is the real one.
 *
 * ---------------------------------------------------------------------------
 * SIP registration
 * ---------------------------------------------------------------------------
 * After a "Vobiz account" sign-in, /agent/:agentId returns placeholder SIP
 * credentials, so the panel reaches "Registration failed" — everything else
 * still works. To exercise real registration, use the panel's "SIP direct"
 * tab with an endpoint you own: the mock hands those typed credentials back,
 * exactly as the real backend does. Nothing is read from the environment.
 *
 * Zero dependencies. Node 18+.
 */

"use strict";

const http = require("node:http");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 8092);
const HOST = process.env.HOST || "127.0.0.1";

// --- fake state -------------------------------------------------------------

const NUMBERS = ["+910000000001", "+910000000002", "+910000000003"];

/** agentId -> session */
const sessions = new Map();

/** bearer token -> agentId */
const tokens = new Map();

function agentFor(req) {
  const h = String(req.headers.authorization || "");
  return h.startsWith("Bearer ") ? tokens.get(h.slice(7)) || null : null;
}

/** callUuid -> { startedAt, to } */
const calls = new Map();

/** How long a mock call stays "active" before it reports as ended. */
const CALL_DURATION_MS = Number(process.env.MOCK_CALL_MS || 20000);

const RECORDINGS = [
  { recording_id: "rec_9f2c1a7b", add_time: "2026-09-14 11:42:07", rounded_recording_duration: 96 },
  { recording_id: "rec_4d80e315", add_time: "2026-09-14 10:18:44", rounded_recording_duration: 41 },
  { recording_id: "rec_1b66fa02", add_time: "2026-09-13 17:05:12", rounded_recording_duration: 213 },
  { recording_id: "rec_7ae3c904", add_time: "2026-09-13 09:51:30", rounded_recording_duration: 8 },
];

// --- helpers ----------------------------------------------------------------

function log(method, path, status, note) {
  const stamp = new Date().toISOString().slice(11, 19);
  const mark = status >= 400 ? "✗" : "✓";
  console.log(`  ${mark} ${stamp}  ${method.padEnd(4)} ${path.padEnd(46)} ${status}${note ? "  " + note : ""}`);
}

let currentOrigin = null;

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  // Only the FDK dev server and other loopback pages, never "*".
  const cors = currentOrigin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(currentOrigin)
    ? {
      "Access-Control-Allow-Origin": currentOrigin,
      "Access-Control-Allow-Headers": "Content-Type, Authorization, ngrok-skip-browser-warning",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      Vary: "Origin",
    }
    : { Vary: "Origin" };
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...cors,
    ...headers,
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 1e6) reject(new Error("payload too large"));
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

/**
 * A short WAV so recording playback can be exercised. A 440 Hz tone is enough
 * to prove the <audio> element, the URL, and the content type all line up.
 */
function toneWav(seconds = 2, freq = 440, rate = 8000) {
  const samples = seconds * rate;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const fade = Math.min(1, Math.min(i, samples - i) / (rate * 0.1));
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 8000 * fade), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const WAV = toneWav();

// --- routes -----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method;
  currentOrigin = req.headers.origin || null;

  if (method === "OPTIONS") {
    send(res, 204, "");
    return log(method, path, 204);
  }

  // GET /agent/:agentId
  let m = path.match(/^\/agent\/([^/]+)$/);
  if (m && method === "GET") {
    const agentId = decodeURIComponent(m[1]);
    if (agentFor(req) !== agentId) {
      send(res, 401, { error: "Sign in first" });
      return log(method, path, 401, "no session");
    }
    const s = sessions.get(agentId) || {};
    const direct = s.mode === "sip";
    send(res, 200, {
      displayName: `${agentId} (mock)`,
      sipUser: direct ? s.sipUser : `${agentId}@registrar.vobiz.ai`,
      sipPassword: direct ? s.sipPassword : "mock-password-registration-will-fail",
    });
    return log(method, path, 200, direct ? "typed SIP-direct creds" : "placeholder SIP creds");
  }

  // GET /session/:agentId
  m = path.match(/^\/session\/([^/]+)$/);
  if (m && method === "GET") {
    const agentId = decodeURIComponent(m[1]);
    const s = agentFor(req) === agentId ? sessions.get(agentId) : null;
    send(res, 200, s
      ? { loggedIn: true, mode: s.mode, numbers: s.mode === "sip" ? [s.from] : NUMBERS, from: s.from, authId: s.authId || null }
      : { loggedIn: false });
    return log(method, path, 200, s ? "logged in" : "no session");
  }

  // POST /login
  if (path === "/login" && method === "POST") {
    const body = await readJson(req).catch(() => ({}));
    const { agentId, authId, authToken } = body;
    if (!agentId || !authId || !authToken) {
      send(res, 400, { error: "agentId, authId and authToken are all required" });
      return log(method, path, 400, "missing fields");
    }
    // A mock: any non-empty credentials are accepted. Use the literal
    // "fail" as the Auth ID to exercise the error path in the panel.
    if (authId.toLowerCase() === "fail") {
      send(res, 401, { error: "Invalid Auth ID or Auth Token" });
      return log(method, path, 401, "forced failure");
    }
    sessions.set(agentId, { mode: "account", authId, from: NUMBERS[0] });
    const token = require("node:crypto").randomBytes(16).toString("hex");
    tokens.set(token, agentId);
    send(res, 200, { token, mode: "account", numbers: NUMBERS, numberDetails: NUMBERS.map(e164 => ({ e164, applicationId: null })), selected: NUMBERS[0] });
    return log(method, path, 200, `agent=${agentId}`);
  }

  // POST /login-sip — SIP direct: typed endpoint credentials and caller ID.
  if (path === "/login-sip" && method === "POST") {
    const { agentId, sipUser, sipPassword, callerId } = await readJson(req).catch(() => ({}));
    if (!agentId || !sipUser || !sipPassword || !/^\+\d{8,15}$/.test(String(callerId || ""))) {
      send(res, 400, { error: "agentId, sipUser, sipPassword and an E.164 callerId are all required" });
      return log(method, path, 400, "missing fields");
    }
    const user = String(sipUser).includes("@") ? String(sipUser) : `${sipUser}@registrar.vobiz.ai`;
    sessions.set(agentId, { mode: "sip", from: callerId, sipUser: user, sipPassword });
    const token = require("node:crypto").randomBytes(16).toString("hex");
    tokens.set(token, agentId);
    send(res, 200, { token, mode: "sip", numbers: [callerId], selected: callerId });
    return log(method, path, 200, `agent=${agentId} (SIP direct)`);
  }

  // POST /logout
  if (path === "/logout" && method === "POST") {
    await readJson(req).catch(() => ({}));
    const h = String(req.headers.authorization || "");
    const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
    const agentId = tokens.get(token);
    tokens.delete(token);
    if (agentId) sessions.delete(agentId);
    send(res, 200, { ok: true });
    return log(method, path, 200, agentId ? `agent=${agentId}` : "no session");
  }

  // POST /select-number
  if (path === "/select-number" && method === "POST") {
    const { number } = await readJson(req).catch(() => ({}));
    const s = sessions.get(agentFor(req));
    if (!s) {
      send(res, 401, { error: "Not logged in" });
      return log(method, path, 401);
    }
    s.from = number;
    send(res, 200, { selected: number });
    return log(method, path, 200, number);
  }

  // POST /setup-inbound
  if (path === "/setup-inbound" && method === "POST") {
    await readJson(req).catch(() => ({}));
    const s = sessions.get(agentFor(req));
    if (!s) {
      send(res, 401, { error: "Log in before enabling inbound calls" });
      return log(method, path, 401);
    }
    send(res, 200, { number: s.from });
    return log(method, path, 200, s.from);
  }

  // POST /start-call — retired. The panel places outbound calls over SIP.
  if (path === "/start-call" && method === "POST") {
    send(res, 410, { error: "Outbound calls are placed by the panel over SIP" });
    return log(method, path, 410);
  }

  // GET /call-status/:callUuid
  m = path.match(/^\/call-status\/([^/]+)$/);
  if (m && method === "GET") {
    const uuid = decodeURIComponent(m[1]);
    const call = calls.get(uuid);
    // Mirrors the real thing: a call is briefly queued, then live, then ends.
    const age = call ? Date.now() - call.startedAt : Infinity;
    const active = Boolean(call) && age > 3000 && age < CALL_DURATION_MS;
    send(res, 200, { active });
    return log(method, path, 200, active ? "active" : "not active");
  }

  // GET /recordings/:agentId
  m = path.match(/^\/recordings\/([^/]+)$/);
  if (m && method === "GET") {
    const agentId = decodeURIComponent(m[1]);
    if (agentFor(req) !== agentId) {
      send(res, 401, { error: "Log in to see recordings" });
      return log(method, path, 401, "not logged in");
    }
    const limit = Number(url.searchParams.get("limit") || 15);
    send(res, 200, {
      objects: RECORDINGS.slice(0, limit).map(r => ({
        ...r,
        playUrl: `/recording-audio/${encodeURIComponent(agentId)}/${r.recording_id}?exp=0&sig=mock`,
      })),
    });
    return log(method, path, 200, `${Math.min(limit, RECORDINGS.length)} items`);
  }

  // GET /recording-audio/:agentId/:recordingId
  m = path.match(/^\/recording-audio\/([^/]+)\/([^/]+)$/);
  if (m && method === "GET") {
    send(res, 200, WAV, { "Content-Type": "audio/wav", "Content-Length": String(WAV.length) });
    return log(method, path, 200, `${WAV.length} bytes`);
  }

  // Vobiz-facing webhook. Included so the shape is visible; nothing calls it
  // locally because no real call is ever placed. backend/server.js has the
  // real one, including the conference bridge it uses for outbound.
  //   From = sip:…  → the browser dialled out  → <Dial><Number>
  //   From = number → a PSTN caller            → <Dial><User>, callerId = the DID
  if (path === "/answer" || path === "/inbound-answer") {
    const params = Object.fromEntries(url.searchParams);
    const sipUser = "agent@registrar.vobiz.ai";
    const from = String(params.From || "");
    const to = String(params.To || "").replace(/[^\d]/g, "");
    const inner = from.startsWith("sip:")
      ? `<Dial callerId="${NUMBERS[0]}"><Number>${to}</Number></Dial>`
      : `<Dial callerId="+${to || NUMBERS[0].slice(1)}"><User>sip:${sipUser}</User></Dial>`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>${inner}</Response>`;
    send(res, 200, xml, { "Content-Type": "text/xml" });
    return log(method, path, 200, "XML");
  }

  if (path === "/health") {
    send(res, 200, { ok: true, sessions: sessions.size, calls: calls.size });
    return log(method, path, 200);
  }

  send(res, 404, { error: `No route for ${method} ${path}` });
  return log(method, path, 404);
});

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("  Vobiz mock calling backend");
  console.log("  ──────────────────────────");
  console.log(`  Listening       http://${HOST}:${PORT}`);
  console.log("  SIP identity    placeholder after account sign-in; SIP direct uses what you type");
  console.log(`  Numbers         ${NUMBERS.join(", ")}`);
  console.log(`  Mock call runs  ${CALL_DURATION_MS / 1000}s`);
  console.log("");
  console.log("  Set this as the app's 'Calling backend URL'.");
  console.log("  Any Auth ID and Auth Token are accepted; use 'fail' as the Auth ID to test the error path.");
  console.log("");
  console.log("  Requests");
});
