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
 * This is a DEVELOPMENT TOOL. It has no authentication, accepts any
 * credentials, and is deliberately permissive about CORS. Never deploy it.
 *
 * ---------------------------------------------------------------------------
 * Optional: real SIP registration
 * ---------------------------------------------------------------------------
 * By default /agent/:agentId returns placeholder SIP credentials, so the panel
 * will reach "Registration failed" — everything else still works. To exercise
 * the full audio path, create a SIP endpoint in the Vobiz Console and export:
 *
 *   export VOBIZ_SIP_USER='myendpoint@registrar.vobiz.ai'
 *   export VOBIZ_SIP_PASSWORD='...'
 *
 * Zero dependencies. Node 18+.
 */

"use strict";

const http = require("node:http");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 8092);
const HOST = process.env.HOST || "127.0.0.1";

// --- fake state -------------------------------------------------------------

const NUMBERS = ["+911140848108", "+911140848109", "+911140848110"];

/** agentId -> session */
const sessions = new Map();

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

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
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

  if (method === "OPTIONS") {
    send(res, 204, "");
    return log(method, path, 204);
  }

  // GET /agent/:agentId
  let m = path.match(/^\/agent\/([^/]+)$/);
  if (m && method === "GET") {
    const agentId = decodeURIComponent(m[1]);
    const usingReal = Boolean(process.env.VOBIZ_SIP_USER && process.env.VOBIZ_SIP_PASSWORD);
    send(res, 200, {
      displayName: `${agentId} (mock)`,
      sipUser: process.env.VOBIZ_SIP_USER || `${agentId}@registrar.vobiz.ai`,
      sipPassword: process.env.VOBIZ_SIP_PASSWORD || "mock-password-registration-will-fail",
    });
    return log(method, path, 200, usingReal ? "real SIP creds" : "placeholder SIP creds");
  }

  // GET /session/:agentId
  m = path.match(/^\/session\/([^/]+)$/);
  if (m && method === "GET") {
    const agentId = decodeURIComponent(m[1]);
    const s = sessions.get(agentId);
    send(res, 200, s
      ? { loggedIn: true, numbers: NUMBERS, from: s.from, authId: s.authId }
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
    sessions.set(agentId, { authId, from: NUMBERS[0] });
    send(res, 200, { numbers: NUMBERS, selected: NUMBERS[0] });
    return log(method, path, 200, `agent=${agentId}`);
  }

  // POST /select-number
  if (path === "/select-number" && method === "POST") {
    const { agentId, number } = await readJson(req).catch(() => ({}));
    const s = sessions.get(agentId);
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
    const { agentId } = await readJson(req).catch(() => ({}));
    const s = sessions.get(agentId);
    if (!s) {
      send(res, 401, { error: "Log in before enabling inbound calls" });
      return log(method, path, 401);
    }
    send(res, 200, { number: s.from });
    return log(method, path, 200, s.from);
  }

  // POST /start-call
  if (path === "/start-call" && method === "POST") {
    const { to, agentId } = await readJson(req).catch(() => ({}));
    const s = sessions.get(agentId);
    if (!s) {
      send(res, 401, { error: "Log in before placing a call" });
      return log(method, path, 401, "not logged in");
    }
    if (!to) {
      send(res, 400, { error: "A number to call is required" });
      return log(method, path, 400);
    }
    const uuid = `mock-${Math.random().toString(16).slice(2, 10)}`;
    calls.set(uuid, { startedAt: Date.now(), to });
    send(res, 200, { request_uuid: uuid });
    return log(method, path, 200, `${to} → ${uuid}`);
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
    if (!sessions.has(agentId)) {
      send(res, 401, { error: "Log in to see recordings" });
      return log(method, path, 401, "not logged in");
    }
    const limit = Number(url.searchParams.get("limit") || 15);
    send(res, 200, { objects: RECORDINGS.slice(0, limit) });
    return log(method, path, 200, `${Math.min(limit, RECORDINGS.length)} items`);
  }

  // GET /recording-audio/:agentId/:recordingId
  m = path.match(/^\/recording-audio\/([^/]+)\/([^/]+)$/);
  if (m && method === "GET") {
    send(res, 200, WAV, { "Content-Type": "audio/wav", "Content-Length": String(WAV.length) });
    return log(method, path, 200, `${WAV.length} bytes`);
  }

  // Vobiz-facing webhooks. Included so the shape is visible; nothing calls
  // these locally because no real call is ever placed.
  if (path === "/answer" || path === "/inbound-answer") {
    const sipUser = process.env.VOBIZ_SIP_USER || "agent@registrar.vobiz.ai";
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Dial><User>sip:${sipUser}</User></Dial></Response>`;
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
  const real = Boolean(process.env.VOBIZ_SIP_USER && process.env.VOBIZ_SIP_PASSWORD);
  console.log("");
  console.log("  Vobiz mock calling backend");
  console.log("  ──────────────────────────");
  console.log(`  Listening       http://${HOST}:${PORT}`);
  console.log(`  SIP identity    ${real ? "real (from VOBIZ_SIP_USER)" : "placeholder — SIP registration will fail"}`);
  console.log(`  Numbers         ${NUMBERS.join(", ")}`);
  console.log(`  Mock call runs  ${CALL_DURATION_MS / 1000}s`);
  console.log("");
  console.log("  Set this as the app's 'Calling backend URL'.");
  console.log("  Any Auth ID and Auth Token are accepted; use 'fail' as the Auth ID to test the error path.");
  console.log("");
  console.log("  Requests");
});
