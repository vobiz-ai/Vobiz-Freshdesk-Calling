#!/usr/bin/env node
/**
 * Vobiz calling backend for the Freshdesk panel.
 *
 * Implements docs/backend-contract.md against the real Vobiz REST API.
 * Zero dependencies: node:http, node:crypto and the global fetch (Node 20+).
 *
 *   cp backend/.env.example backend/.env    # set PUBLIC_BASE and SIGNING_SECRET
 *   npm run backend                         # http://127.0.0.1:8093
 *
 * It serves any Vobiz account. Nothing about an account is configured here:
 * an agent signs in to the panel with their own Auth ID and Auth Token, the
 * backend checks the pair with Vobiz, and then — in that account — finds or
 * creates this integration's application and the agent's own SIP endpoint,
 * with a fresh SIP password for that browser session.
 *
 * What it guarantees, because the panel cannot:
 *
 * - The browser never sees an account's Auth Token. It stays in this process's
 *   memory, keyed by Auth ID — never logged, never written to disk.
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

function readConfig(env = process.env) {
  const publicBase = String(env.PUBLIC_BASE || "").trim().replace(/\/+$/, "");
  const extraOrigins = String(env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  return {
    port: Number(env.PORT || 8093),
    host: env.HOST || "127.0.0.1",
    apiBase: String(env.VOBIZ_API_BASE || "https://api.vobiz.ai").replace(/\/+$/, ""),
    publicBase,
    // Where the endpoint map ({authId:agentId -> endpointId, username}) lives.
    // It holds ids only — never a password or a token.
    dataDir: env.DATA_DIR || path.join(__dirname, "data"),
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

// ─── Vobiz ids ───────────────────────────────────────────────────────────────

// An application id is 17 digits — above Number.MAX_SAFE_INTEGER. If Vobiz
// ever sends one as a bare JSON number, JSON.parse rounds it to a different
// application. So every id field is quoted in the raw text before parsing, and
// ids stay strings from there on.
const ID_FIELDS = /"(app_id|application_id|application|endpoint_id)"\s*:\s*(-?\d+)(?=\s*[,}\]])/g;

function parseVobizJson(raw) {
  try { return JSON.parse(String(raw).replace(ID_FIELDS, '"$1":"$2"')); } catch { return raw; }
}

const isDigits = v => /^\d+$/.test(String(v || ""));

/** A phone number in strict E.164, or "" — never something half-parsed. */
function cleanPhone(raw) {
  const n = toE164(raw);
  return /^\+[1-9]\d{7,14}$/.test(n) ? n : "";
}

/**
 * A custom X-VH- SIP header from the INVITE. Vobiz hands these to the answer
 * URL as top-level parameters, sometimes prefixed SIPHeader_, in any case.
 */
function vhParam(params, name) {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(params || {})) {
    const key = k.toLowerCase().replace(/^sipheader_/, "");
    if (key === want) return String(v || "");
  }
  return "";
}

/** The app id an endpoint reports, whether as an object, an id, or a resource URI. */
function boundAppId(application, raw) {
  if (application && typeof application === "object" && isDigits(application.app_id)) return String(application.app_id);
  if (isDigits(application)) return String(application);
  const m = typeof application === "string" && application.match(/(\d+)\/?$/);
  if (m) return m[1];
  const r = String(raw || "").match(/"app_id"\s*:\s*"?(\d+)/);
  return r ? r[1] : "";
}

/**
 * Splice a validated integer id into a JSON body as a number literal. The
 * documented field is an integer, and going through Number() would corrupt it.
 */
function withIntegerField(obj, field, digits) {
  if (!isDigits(digits)) throw new Error(`refusing to send a non-numeric ${field}`);
  const json = JSON.stringify(obj);
  return `${json === "{}" ? "{" : `${json.slice(0, -1)},`}"${field}":${digits}}`;
}

// Auth IDs go into URL paths, agent ids into endpoint usernames, aliases, map
// keys and recording links. The panel sends `fd<Freshdesk user id>`.
const AUTH_ID_RE = /^[A-Za-z0-9_]{2,64}$/;
const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const AGENT_ID_ERROR = "The agent identity must be 1–64 letters, digits, dots, dashes or underscores, starting with a letter or digit";
// The panel's own reference for one outbound call, sent as X-VH-Call-Ref so it
// can ask /call-status whether the customer has joined yet.
const CALL_REF_RE = /^[A-Za-z0-9-]{8,64}$/;
// A conference room outlives its timeLimit by no more than this.
const ROOM_MAX_AGE_MS = (14400 + 300) * 1000;

/** A name to show in the panel: printable, trimmed, at most 64 characters. */
function cleanDisplayName(raw, fallback) {
  const s = String(raw || "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 64);
  return s || fallback;
}

// ─── endpoint map ────────────────────────────────────────────────────────────

/**
 * {authId:agentId -> {endpointId, username}} on disk, mode 0600. Ids only: the
 * SIP password is rotated on every sign-in and lives in the session, the Auth
 * Token lives in memory, and neither is ever written here.
 */
function createEndpointStore(dir) {
  const file = path.join(dir, "endpoints.json");
  let map = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object") map = parsed;
  } catch { /* first run */ }
  const save = () => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  };
  return {
    file,
    get: key => map[key] || null,
    set(key, { endpointId, username }) { map[key] = { endpointId: String(endpointId), username: String(username) }; save(); },
    delete(key) { delete map[key]; save(); },
  };
}

// ─── the app ─────────────────────────────────────────────────────────────────

function createApp(config, { fetchImpl = globalThis.fetch, log = console.log } = {}) {
  // Every Vobiz account someone has signed in with since start-up:
  //   authId -> { authId, authToken, numbers, appId }
  // In memory only. The Auth Token is never logged, returned or written down.
  const accounts = new Map();
  const sessions = new Map();        // token -> { authId, agentId, sipUser, sipUsername, sipPassword, numbers, from, createdAt }
  const bySipUser = new Map();       // SIP username -> { authId, agentId, callerId }
  const rooms = new Map();           // outbound room -> { authId, sipUsername, callRef, agentCallUuid, joined, createdAt }
  const lastCallerId = new Map();    // authId:agentId -> the caller ID the agent last picked
  const store = createEndpointStore(config.dataDir);
  const answerUrl = `${config.publicBase}/answer`;

  // ── Vobiz REST, as one particular account ─────────────────────────────────
  async function vobiz(acct, method, apiPath, body) {
    try {
      const res = await fetchImpl(`${config.apiBase}/api/v1/Account/${encodeURIComponent(acct.authId)}${apiPath}`, {
        method,
        headers: {
          "X-Auth-ID": acct.authId,
          "X-Auth-Token": acct.authToken,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
      });
      const raw = await res.text();
      return { status: res.status, body: parseVobizJson(raw), raw };
    } catch (err) {
      return { status: 0, body: { error: err.message }, raw: "" };
    }
  }
  const ok = r => r.status >= 200 && r.status < 300;

  // One provisioning run at a time per key, so two tabs signing in together
  // cannot create two applications or two endpoints.
  const locks = new Map();
  function withLock(key, fn) {
    const run = (locks.get(key) || Promise.resolve()).catch(() => {}).then(fn);
    locks.set(key, run);
    run.catch(() => {}).finally(() => { if (locks.get(key) === run) locks.delete(key); });
    return run;
  }

  // ── per-sign-in provisioning ──────────────────────────────────────────────

  /**
   * This integration's application in the account: the one whose answer URL is
   * this backend's /answer. An application anyone else made is never changed.
   */
  function ensureApplication(acct) {
    return withLock(`app:${acct.authId}`, async () => {
      for (let offset = 0; offset < 1000; offset += 100) {
        const r = await vobiz(acct, "GET", `/Application/?limit=100&offset=${offset}`);
        if (!ok(r)) throw new Error(`Vobiz returned ${r.status} listing applications`);
        const objects = (r.body && r.body.objects) || [];
        const mine = objects.find(a => a && a.answer_url === answerUrl && isDigits(a.app_id));
        if (mine) return String(mine.app_id);
        if (objects.length < 100) break;
      }
      const created = await vobiz(acct, "POST", "/Application/", {
        app_name: config.appName,
        answer_url: answerUrl,
        answer_method: "POST",
        hangup_url: answerUrl,
        hangup_method: "POST",
      });
      if (!ok(created)) throw new Error(`Vobiz returned ${created.status} creating the application`);
      const appId = boundAppId(created.body && created.body.app_id, created.raw);
      if (!isDigits(appId)) throw new Error("Vobiz did not return an application id");
      log(`  created application ${appId} → ${answerUrl} in ${acct.authId}`);
      return appId;
    });
  }

  /** app_id -> app_name for every application in the account, for the panel's hints. */
  async function applicationNames(acct) {
    const names = {};
    for (let offset = 0; offset < 1000; offset += 100) {
      const r = await vobiz(acct, "GET", `/Application/?limit=100&offset=${offset}`);
      if (!ok(r)) break;
      const objects = (r.body && r.body.objects) || [];
      for (const a of objects) if (a && isDigits(a.app_id) && a.app_name) names[String(a.app_id)] = String(a.app_name).slice(0, 80);
      if (objects.length < 100) break;
    }
    return names;
  }

  /**
   * Name each number's current application, and say whether it is already
   * this integration's, so "Enable inbound calls" can say what it would change.
   */
  async function describeNumberApps(acct, details, appId) {
    const others = details.some(d => d.applicationId && d.applicationId !== appId);
    const names = others ? await applicationNames(acct) : {};
    for (const d of details) {
      d.applicationName = d.applicationId ? names[d.applicationId] || null : null;
      d.thisPanel = Boolean(d.applicationId) && d.applicationId === appId;
    }
  }

  async function readEndpoint(acct, endpointId) {
    const r = await vobiz(acct, "GET", `/Endpoint/${encodeURIComponent(endpointId)}/`);
    if (!ok(r)) return { status: r.status };
    const username = String((r.body && r.body.username) || "");
    return { status: r.status, username, appId: boundAppId(r.body && r.body.application, r.raw) };
  }

  /**
   * Point the endpoint at this integration's application, then read it back.
   * `{"app_id": "<id>"}` (a string) goes first — it is what the production
   * WebRTC playground sends and it works. If the endpoint does not read back as
   * bound, the documented integer `application` is the one retry, spliced in
   * as a raw literal. Either way the outcome is logged, because an unbound
   * endpoint means the browser's calls never reach /answer.
   */
  async function bindEndpoint(acct, endpointId, appId) {
    const epPath = `/Endpoint/${encodeURIComponent(endpointId)}/`;
    await vobiz(acct, "POST", epPath, { app_id: String(appId) });
    let info = await readEndpoint(acct, endpointId);
    if (ok(info) && info.appId !== appId) {
      log(`  endpoint ${endpointId}: not bound after app_id (reports ${info.appId || "none"}) — retrying with the integer application field`);
      await vobiz(acct, "POST", epPath, withIntegerField({}, "application", appId));
      info = await readEndpoint(acct, endpointId);
    }
    if (!ok(info)) throw new Error(`Vobiz returned ${info.status} reading the SIP endpoint`);
    const bound = info.appId === appId;
    log(bound
      ? `  endpoint ${endpointId} bound to application ${appId}`
      : `  ✖ endpoint ${endpointId} is NOT bound to application ${appId} — calls from the panel will not reach this backend`);
    return { ...info, bound };
  }

  // One alias per agent identity, so a lost endpoint map can still find the
  // agent's endpoint by exact alias instead of creating a second one.
  const endpointAlias = agentId => `Freshdesk-${agentId.replace(/[^a-z0-9_-]/gi, "").slice(0, 40) || "agent"}`;

  async function findEndpointByAlias(acct, agentId) {
    const alias = endpointAlias(agentId);
    for (let offset = 0; offset < 1000; offset += 100) {
      const r = await vobiz(acct, "GET", `/Endpoint/?limit=100&offset=${offset}`);
      if (!ok(r)) return null;
      const objects = (r.body && r.body.objects) || [];
      const hit = objects.find(e => e && e.alias === alias && e.endpoint_id);
      if (hit) return String(hit.endpoint_id);
      if (objects.length < 100) break;
    }
    return null;
  }

  async function createEndpoint(acct, agentId, password, appId) {
    // Alphanumeric only — Vobiz rejects anything else, and rewrites what it
    // accepts, so the stored username is read back afterwards.
    const stem = `fd${agentId.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 16)}`;
    const alias = endpointAlias(agentId);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const username = `${stem}${crypto.randomBytes(3).toString("hex")}`;
      const r = await vobiz(acct, "POST", "/Endpoint/", { username, password, alias, app_id: String(appId) });
      if (r.status === 409) continue;
      if (!ok(r)) throw new Error(`Vobiz returned ${r.status} creating the SIP endpoint`);
      const id = String((r.body && r.body.endpoint_id) || (String(r.raw).match(/"endpoint_id"\s*:\s*"?([A-Za-z0-9-]+)/) || [])[1] || "");
      if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error("Vobiz did not return an endpoint id");
      log(`  created endpoint ${id} for agent "${agentId}" in ${acct.authId}`);
      return id;
    }
    throw new Error("Vobiz kept refusing the endpoint username as taken");
  }

  /**
   * One endpoint per (account, agent): reuse the one on file with a fresh
   * password, or create it. The password goes to this sign-in's session only.
   */
  function provisionAgent(acct, agentId) {
    const key = `${acct.authId}:${agentId}`;
    return withLock(key, async () => {
      const appId = await ensureApplication(acct);
      const password = crypto.randomBytes(16).toString("hex");
      let endpointId = null;
      let stored = store.get(key);
      if (!stored) {
        const found = await findEndpointByAlias(acct, agentId);
        if (found) {
          log(`  reusing endpoint ${found} for "${agentId}", found by alias`);
          stored = { endpointId: found };
        }
      }
      if (stored) {
        const r = await vobiz(acct, "POST", `/Endpoint/${encodeURIComponent(stored.endpointId)}/`, { password });
        if (r.status === 404) {
          log(`  endpoint ${stored.endpointId} for "${agentId}" is gone — creating a new one`);
          if (store.get(key)) store.delete(key);
        } else if (!ok(r)) {
          throw new Error(`Vobiz returned ${r.status} updating the SIP endpoint`);
        } else {
          endpointId = stored.endpointId;
        }
      }
      if (!endpointId) endpointId = await createEndpoint(acct, agentId, password, appId);
      const info = await bindEndpoint(acct, endpointId, appId);
      if (!/^[A-Za-z0-9]+$/.test(info.username)) throw new Error("Vobiz did not return a usable endpoint username");
      store.set(key, { endpointId, username: info.username });
      return { appId, endpointId, username: info.username, password, bound: info.bound };
    });
  }

  // ── sessions ──────────────────────────────────────────────────────────────
  const fresh = s => Date.now() - s.createdAt <= config.sessionTtlMs;

  /**
   * Forget an account's Auth Token once nothing needs it: no live session of
   * that account, and no outbound room of that account still waiting for its
   * hangup webhook (which may have to release the agent's leg as the account,
   * and whose signature is checked with the account's token).
   */
  function releaseAccountIfIdle(authId) {
    if (!authId || !accounts.has(authId)) return;
    if ([...sessions.values()].some(s => s.mode === "account" && s.authId === authId && fresh(s))) return;
    if ([...rooms.values()].some(r => r.authId === authId)) return;
    accounts.delete(authId);
    log(`  ${authId}: no agent signed in — Auth Token dropped from memory`);
  }

  function dropSession(token) {
    const s = sessions.get(token);
    if (!s) return;
    sessions.delete(token);
    const route = bySipUser.get(s.sipUsername);
    if (route && route.token === token) bySipUser.delete(s.sipUsername);
    if (s.mode === "account") releaseAccountIfIdle(s.authId);
  }

  function dropRoom(name) {
    const room = rooms.get(name);
    if (!room) return;
    rooms.delete(name);
    releaseAccountIfIdle(room.authId);
  }

  /**
   * Expire what nobody will come back for: sessions past SESSION_TTL_HOURS (a
   * tab closed without signing out) and rooms whose hangup webhook never came.
   * Runs on every request and on a timer, so an idle backend forgets too.
   */
  function sweep() {
    for (const [t, s] of sessions) if (!fresh(s)) dropSession(t);
    for (const [name, r] of rooms) if (Date.now() - r.createdAt > ROOM_MAX_AGE_MS) dropRoom(name);
  }

  function getSession(req) {
    const h = String(req.headers.authorization || "");
    const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
    if (!token) return null;
    const s = sessions.get(token);
    if (!s) return null;
    if (!fresh(s)) { dropSession(token); return null; }
    return s;
  }

  const liveSessions = authId => [...sessions.values()].filter(s => s.mode === "account" && s.authId === authId && fresh(s));

  // ── recording links ───────────────────────────────────────────────────────
  //
  // The Auth ID is inside the signed payload and on the link, so a link minted
  // for one account can never be replayed to fetch another account's audio.
  const hmac = msg => crypto.createHmac("sha256", config.signingSecret).update(msg).digest("hex");

  function signRecording(authId, agentId, recordingId) {
    const exp = Math.floor(Date.now() / 1000) + config.recordingTtlSeconds;
    const sig = hmac(`${authId}|${agentId}|${recordingId}|${exp}`);
    return `/recording-audio/${encodeURIComponent(agentId)}/${encodeURIComponent(recordingId)}` +
      `?account=${encodeURIComponent(authId)}&exp=${exp}&sig=${sig}`;
  }

  function verifyRecording(authId, agentId, recordingId, exp, sig) {
    if (!authId || !exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
    const a = Buffer.from(String(sig));
    const b = Buffer.from(hmac(`${authId}|${agentId}|${recordingId}|${exp}`));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // Where recording audio may be fetched from, and which of those hosts may
  // see the account credentials. Vobiz serves media from *.vobiz.ai; a redirect
  // to presigned object storage carries its own authorisation, so the Auth
  // Token is never sent there.
  const isVobizHost = h => /(^|\.)vobiz\.ai$/i.test(h);
  const isMediaHost = h => isVobizHost(h) || /(^|\.)s3([.-][a-z0-9-]+)?\.amazonaws\.com$/i.test(h);

  async function fetchRecordingAudio(acct, startUrl) {
    let url = startUrl;
    for (let hop = 0; hop < 4; hop += 1) {
      let u;
      try { u = new URL(url); } catch { return { error: "bad recording URL" }; }
      if (u.protocol !== "https:" || !isMediaHost(u.hostname)) return { error: `refusing to fetch audio from ${u.hostname}` };
      const headers = isVobizHost(u.hostname) ? { "X-Auth-ID": acct.authId, "X-Auth-Token": acct.authToken } : {};
      const res = await fetchImpl(url, { headers, redirect: "manual" });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        url = new URL(res.headers.get("location"), url).toString();
        continue;
      }
      return { res };
    }
    return { error: "too many redirects" };
  }

  // ── which account a webhook belongs to ────────────────────────────────────
  function accountByNumber(raw) {
    const n = toE164(raw);
    if (!n) return null;
    for (const a of accounts.values()) if (a.numbers.includes(n)) return a;
    return null;
  }

  function accountForWebhook(params, q) {
    const room = q.room && rooms.get(q.room);
    if (room) return accounts.get(room.authId) || null;
    const from = String(params.From || "");
    if (/^sip:/i.test(from)) {
      const route = bySipUser.get(sipUsername(from));
      return route && route.mode === "account" ? accounts.get(route.authId) || null : null;
    }
    const parent = accounts.get(String(params.ParentAuthID || ""));
    return parent || accountByNumber(params.To) || accountByNumber(params.From);
  }

  // ── webhook signatures ────────────────────────────────────────────────────
  //
  // Vobiz signs callbacks over the callback URL (query string stripped) and a
  // nonce — never over the body, which is form-encoded:
  //   V3 = base64(HMAC-SHA256(authToken, baseURL + "." + nonce))
  //   V2 = base64(HMAC-SHA256(authToken, baseURL + nonce))
  // The key is the Auth Token of the account the webhook belongs to. When the
  // webhook names no account this backend knows, any signed-in account's token
  // is tried — a match still proves Vobiz sent it.
  function webhookSignatureValid(req, pathname, tokens) {
    const base = `${config.publicBase}${pathname}`;
    const check = (sigHeader, nonceHeader, sep) => {
      const sig = req.headers[sigHeader];
      const nonce = req.headers[nonceHeader];
      if (!sig || !nonce) return null;
      const a = Buffer.from(String(sig));
      return tokens.some(token => {
        const b = Buffer.from(crypto.createHmac("sha256", token).update(`${base}${sep}${nonce}`).digest("base64"));
        return a.length === b.length && crypto.timingSafeEqual(a, b);
      });
    };
    const v3 = check("x-vobiz-signature-v3", "x-vobiz-signature-v3-nonce", ".");
    if (v3 !== null) return v3;
    return check("x-vobiz-signature-v2", "x-vobiz-signature-v2-nonce", "");
  }

  /** true when the webhook may proceed. */
  function verifyWebhook(req, pathname, acct) {
    if (config.webhookSignature === "off") return true;
    const tokens = acct ? [acct.authToken] : [...accounts.values()].map(a => a.authToken);
    const valid = webhookSignatureValid(req, pathname, tokens);
    if (valid === true) return true;
    const why = valid === null ? "no signature headers" : tokens.length ? "signature mismatch" : "no signed-in account to check it against";
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
   * The browser dialled out. Reach the customer, as the account and from the
   * number of the agent whose SIP username is in `From`.
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
    const user = sipUsername(p.From);
    const route = bySipUser.get(user);
    const owner = route && sessions.get(route.token);
    if (!route || !owner || !fresh(owner)) {
      log(`  ✖ outbound from SIP user "${user}", which no signed-in agent holds — hanging up`);
      return xmlDoc("<Hangup/>");
    }
    const acct = route.mode === "account" ? accounts.get(route.authId) : null;
    if (route.mode === "account" && !acct) {
      log(`  ✖ outbound from "${user}": the account is no longer signed in — hanging up`);
      return xmlDoc("<Hangup/>");
    }
    const destination = toE164(p.To);
    if (!/^\+\d{6,15}$/.test(destination)) {
      log(`  ✖ outbound to "${p.To}" is not a dialable number — hanging up`);
      return xmlDoc("<Hangup/>");
    }
    // The caller ID the panel set for this SIP user out of band, unless the
    // INVITE itself carries X-VH-Caller-ID. An account-mode caller ID must be
    // one of that account's numbers; in SIP direct Vobiz enforces ownership.
    let callerId = route.callerId;
    const fromHeader = cleanPhone(vhParam(p, "X-VH-Caller-ID"));
    if (fromHeader) {
      if (!acct || acct.numbers.includes(fromHeader)) callerId = fromHeader;
      else log(`  ignoring X-VH-Caller-ID ${fromHeader}: not a number on ${acct.authId}`);
    }
    if (!callerId || (acct && !acct.numbers.includes(callerId))) {
      log(`  ✖ agent "${route.agentId}" has no caller ID — hanging up`);
      return xmlDoc("<Speak>This account has no phone number to call from.</Speak><Hangup/>");
    }
    const agentCallUuid = String(p.CallUUID || "");

    // SIP direct has no account credentials, so it cannot place the REST leg
    // the conference bridge needs: it always uses <Dial><Number>.
    if (config.outboundMode === "dial" || !acct) {
      log(`  → outbound (dial${acct ? "" : ", SIP direct"}) ${user} → ${destination} as ${callerId}`);
      return xmlDoc(`${recordXml()}<Dial ${dialAttrs(callerId)}><Number>${xmlEscape(destination.slice(1))}</Number></Dial>`);
    }

    const room = `fd${agentCallUuid.replace(/[^a-z0-9]/gi, "") || crypto.randomBytes(8).toString("hex")}`;
    const ref = vhParam(p, "X-VH-Call-Ref");
    rooms.set(room, {
      authId: acct.authId,
      sipUsername: user,
      callRef: CALL_REF_RE.test(ref) ? ref : null,
      agentCallUuid,
      joined: false,
      createdAt: Date.now(),
    });
    log(`  → outbound (conference ${room}) ${user} → ${destination} as ${callerId}`);

    const q = `room=${encodeURIComponent(room)}`;
    const placed = await vobiz(acct, "POST", "/Call/", {
      // The REST API takes E.164 digits without the leading +.
      from: callerId.replace(/^\+/, ""),
      to: destination.slice(1),
      answer_url: `${config.publicBase}/outbound-join?${q}`,
      answer_method: "POST",
      hangup_url: `${config.publicBase}/outbound-hangup?${q}`,
      hangup_method: "POST",
    });
    if (!ok(placed)) {
      log(`  ✖ Vobiz refused the customer leg: ${placed.status} ${JSON.stringify(placed.body).slice(0, 200)}`);
      dropRoom(room);
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
   * The SIP users to ring for an inbound call. The answer webhook names the
   * account in ParentAuthID; that is the key. Without it — or when that account
   * has nobody signed in — the dialled number is matched against signed-in
   * accounts' numbers, and then against SIP-direct agents' inbound numbers.
   */
  function inboundTargets(p, did) {
    const parent = String(p.ParentAuthID || p.parentauthid || "");
    let acct = parent ? accounts.get(parent) : null;
    if (!acct || !liveSessions(acct.authId).length) acct = did ? accountByNumber(did) : null;
    if (acct) {
      const users = [...new Set(liveSessions(acct.authId).map(s => s.sipUser))];
      if (users.length) return { users, label: acct.authId };
    }
    const direct = [...sessions.values()].filter(s => s.mode === "sip" && fresh(s) && did && s.from === did);
    if (direct.length) return { users: [...new Set(direct.map(s => s.sipUser))], label: "SIP direct" };
    return { users: [], label: "" };
  }

  /**
   * A PSTN caller reached a number. Ring the signed-in agents it belongs to.
   *
   * callerId must be the DID that was dialled: left unset, Vobiz derives it
   * from the A leg — the caller's own number, which the account does not own —
   * and refuses to create the B leg, so the browser never rings.
   */
  function answerInbound(p) {
    const did = toE164(p.To);
    const { users, label } = inboundTargets(p, did);
    if (!users.length) {
      log(`  ✖ inbound call to ${did || "?"}: no signed-in agent's account owns that number — hanging up`);
      return xmlDoc("<Speak>Sorry, nobody is available to take your call.</Speak><Hangup/>");
    }
    log(`  → inbound ${p.From || "?"} → ${did} (${label}), ringing ${users.length} agent(s)`);
    const dial = users.map(t => `<User>sip:${xmlEscape(t)}</User>`).join("");
    return xmlDoc(`${recordXml()}<Dial ${dialAttrs(did)}>${dial}</Dial>`);
  }

  async function handleAnswer(p) {
    // A hangup notification is not a request for instructions. Answering it
    // with call control would start a fresh leg after the call has ended.
    if ((p.Event || p.event) === "Hangup") return EMPTY_XML;
    const from = String(p.From || "");
    const fromBrowser = /^sip:/i.test(from) || String(p.RouteType || "").toLowerCase() === "sip";
    return fromBrowser ? answerOutbound(p) : answerInbound(p);
  }

  /**
   * "Enable inbound calls": attach the agent's selected number to this
   * integration's application. Only ever on that explicit action, because it
   * moves the number off whatever application it was on.
   */
  async function bindInbound(session, acct) {
    const appId = await ensureApplication(acct);
    acct.appId = appId;
    const did = session.from;
    const before = (acct.details || []).find(d => d.e164 === did);
    const previousAppId = before && before.applicationId !== appId ? before.applicationId : null;
    const previousAppName = previousAppId ? before.applicationName || null : null;
    const attached = await vobiz(acct, "POST", `/numbers/%2B${did.replace(/\D/g, "")}/application`, { application_id: appId });
    if (!ok(attached)) return { error: `Vobiz returned ${attached.status} attaching ${did}` };
    const stored = store.get(`${acct.authId}:${session.agentId}`);
    let endpointBound = false;
    if (stored) endpointBound = (await bindEndpoint(acct, stored.endpointId, appId)).bound;
    if (before) Object.assign(before, { applicationId: appId, applicationName: config.appName, thisPanel: true });
    return { number: did, appId, previousAppId, previousAppName, endpointBound };
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

  /**
   * Every number the account can call from: List Account Phone Numbers, paged
   * until `total` is loaded, keeping active, voice-enabled numbers. Each keeps
   * the application it is attached to, so "Enable inbound calls" can say which
   * application it moves the number off.
   */
  async function listNumbers(acct) {
    const details = [];
    const seen = new Set();
    for (let page = 1; page <= 50; page += 1) {
      const r = await vobiz(acct, "GET", `/numbers?page=${page}&per_page=100`);
      if (!ok(r)) return page === 1 ? { status: r.status } : { status: 200, details };
      const items = (r.body && r.body.items) || [];
      for (const n of items) {
        if (!n || (n.status !== undefined && n.status !== "active") || n.voice_enabled === false) continue;
        const e164 = cleanPhone(n.e164 || n.number);
        if (!e164 || seen.has(e164)) continue;
        seen.add(e164);
        details.push({ e164, applicationId: isDigits(n.application_id) ? String(n.application_id) : null });
      }
      const total = Number(r.body && r.body.total);
      if (!items.length || !(total > page * 100)) break;
    }
    return { status: 200, details };
  }

  async function login(body) {
    const agentId = String(body.agentId || "").trim();
    const authId = String(body.authId || "").trim();
    const authToken = String(body.authToken || "").trim();
    if (!agentId || !authId || !authToken) return [400, { error: "agentId, authId and authToken are all required" }];
    if (!AGENT_ID_RE.test(agentId)) return [400, { error: AGENT_ID_ERROR }];
    if (!AUTH_ID_RE.test(authId)) return [401, { error: "That is not a Vobiz Auth ID" }];
    if (!/^https:\/\//.test(config.publicBase)) return [500, { error: "This backend has no PUBLIC_BASE — it must be the public https URL Vobiz reaches it on" }];

    // The account is whatever Vobiz says these credentials are. Nothing about
    // a particular account is configured here.
    const acct = { authId, authToken };
    // The first page of the account's numbers doubles as the credential check.
    const listed = await listNumbers(acct);
    if (listed.status === 0) return [502, { error: "Could not reach Vobiz to check those credentials" }];
    if (!ok(listed)) {
      log(`login refused for agent "${agentId}" on ${authId}: Vobiz returned ${listed.status}`);
      return [401, { error: "Vobiz did not accept that Auth ID and Auth Token" }];
    }
    const { details } = listed;
    const numbers = details.map(d => d.e164);

    let agent;
    try {
      agent = await provisionAgent(acct, agentId);
    } catch (err) {
      log(`  ✖ could not provision "${agentId}" on ${authId}: ${err.message}`);
      return [502, { error: `Could not set up this agent's phone line: ${err.message}` }];
    }

    await describeNumberApps(acct, details, agent.appId);
    accounts.set(authId, { authId, authToken, numbers, details, appId: agent.appId });

    // The agent's last pick, if it is still on the account; otherwise the first.
    const last = lastCallerId.get(`${authId}:${agentId}`);
    const from = (last && numbers.includes(last) ? last : numbers[0]) || null;
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, {
      mode: "account",
      authId,
      agentId,
      displayName: cleanDisplayName(body.displayName, agentId),
      sipUsername: agent.username,
      sipUser: fullSipUser(agent.username),
      sipPassword: agent.password,
      numbers,
      from,
      createdAt: Date.now(),
    });
    bySipUser.set(agent.username, { mode: "account", authId, agentId, callerId: from, token });
    // The password just rotated, so any older session for this agent holds a
    // dead one. This sign-in replaces it. (After the new session exists, so the
    // account is never momentarily idle and its token dropped.)
    for (const [t, s] of sessions) if (t !== token && s.mode === "account" && s.authId === authId && s.agentId === agentId) dropSession(t);
    log(`login ok — agent "${agentId}" on ${authId}, endpoint ${agent.endpointId}, ${numbers.length} number(s)`);
    return [200, { token, mode: "account", numbers, numberDetails: details, selected: from }];
  }

  /**
   * SIP direct: the agent types an existing endpoint's SIP username and
   * password and the caller ID to use. No account credentials exist in this
   * mode, so nothing is provisioned or verified with the account API — the
   * registrar checks the password when the panel registers, and Vobiz checks
   * the caller ID when it places the call. The endpoint and the number must
   * already be bound to an application whose answer URL is this backend.
   */
  function loginSip(body) {
    const agentId = String(body.agentId || "").trim();
    const sipUser = fullSipUser(body.sipUser);
    const username = sipUsername(sipUser);
    const sipPassword = String(body.sipPassword || "");
    const callerId = cleanPhone(body.callerId);
    if (!agentId || !username || !sipPassword || !body.callerId) return [400, { error: "agentId, sipUser, sipPassword and callerId are all required" }];
    if (!AGENT_ID_RE.test(agentId)) return [400, { error: AGENT_ID_ERROR }];
    if (!/^[A-Za-z0-9]+$/.test(username)) return [400, { error: "A Vobiz SIP username is letters and digits only" }];
    if (!callerId) return [400, { error: "The caller ID must be a phone number in E.164, like +91XXXXXXXXXX" }];
    const existing = bySipUser.get(username);
    if (existing && existing.mode === "account") {
      // Never let a typed username take over an endpoint this backend provisioned.
      return [409, { error: "That SIP user is already signed in through a Vobiz account" }];
    }
    for (const [t, s] of sessions) if (s.mode === "sip" && s.sipUsername === username) dropSession(t);
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, {
      mode: "sip",
      authId: null,
      agentId,
      displayName: cleanDisplayName(body.displayName, agentId),
      sipUsername: username,
      sipUser,
      sipPassword,
      numbers: [callerId],
      from: callerId,
      createdAt: Date.now(),
    });
    bySipUser.set(username, { mode: "sip", authId: null, agentId, callerId, token });
    log(`login ok — agent "${agentId}", SIP direct as ${username}, calling from ${callerId}`);
    return [200, { token, mode: "sip", numbers: [callerId], selected: callerId }];
  }

  const server = http.createServer(async (req, res) => {
    sweep();
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
        const params = { ...q, ...body };
        if (!verifyWebhook(req, p, accountForWebhook(params, q))) return send(403, EMPTY_XML);
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
            const acct = accounts.get(room.authId);
            if (!room.joined && room.agentCallUuid && acct) {
              log(`  customer never answered (${params.HangupCause || params.CallStatus || "?"}) — releasing the agent's leg`);
              await vobiz(acct, "DELETE", `/Call/${encodeURIComponent(room.agentCallUuid)}/`);
            }
            dropRoom(q.room);
          }
          return send(200, EMPTY_XML);
        }
      }

      if (p === "/health" && method === "GET") return send(200, { ok: true });

      // ── routes the browser calls ──────────────────────────────────────────
      if (p === "/login" && method === "POST") {
        const [code, payload] = await login(body);
        return send(code, payload);
      }

      if (p === "/login-sip" && method === "POST") {
        const [code, payload] = loginSip(body);
        return send(code, payload);
      }

      // Everything below needs the session /login issued.
      const session = getSession(req);
      const sameAgent = id => session && session.agentId === decodeURIComponent(id);

      if ((m = p.match(/^\/session\/([^/]+)$/)) && method === "GET") {
        if (!sameAgent(m[1])) return send(200, { loggedIn: false });
        const acctNow = session.mode === "account" ? accounts.get(session.authId) : null;
        return send(200, {
          loggedIn: true, mode: session.mode, numbers: session.numbers, from: session.from, authId: session.authId,
          ...(acctNow ? { numberDetails: acctNow.details } : {}),
        });
      }

      // An <audio> element cannot send an Authorization header, so playback is
      // authorised by the signature /recordings put on the link instead. The
      // audio URL is resolved here from the recording id — a caller never gets
      // to name what this server fetches — with the credentials of the account
      // the link was signed for.
      if ((m = p.match(/^\/recording-audio\/([^/]+)\/([^/]+)$/)) && method === "GET") {
        const agentId = decodeURIComponent(m[1]);
        const recordingId = decodeURIComponent(m[2]);
        const authId = String(q.account || "");
        if (!verifyRecording(authId, agentId, recordingId, q.exp, q.sig)) return send(403, { error: "Invalid or expired playback link" });
        const acct = accounts.get(authId);
        if (!acct) return send(401, { error: "Nobody is signed in to this Vobiz account right now — sign in to the panel again" });
        const meta = await vobiz(acct, "GET", `/Recording/${encodeURIComponent(recordingId)}/`);
        const src = meta.status === 200 && meta.body && meta.body.recording_url;
        if (!src) return send(404, { error: "No audio for that recording" });
        const { res: audio, error } = await fetchRecordingAudio(acct, src);
        if (error) { log(`  ✖ recording ${recordingId}: ${error}`); return send(502, { error: "Could not fetch the recording" }); }
        if (!audio.ok) return send(502, { error: `Vobiz returned ${audio.status} for the recording audio` });
        const buf = Buffer.from(await audio.arrayBuffer());
        return send(200, buf, { "Content-Type": audio.headers.get("content-type") || "audio/mpeg", "Content-Length": String(buf.length) });
      }

      if (!session) return send(401, { error: "Sign in first" });

      if ((m = p.match(/^\/agent\/([^/]+)$/)) && method === "GET") {
        if (!sameAgent(m[1])) return send(403, { error: "That identity belongs to a different session" });
        return send(200, { displayName: session.displayName, sipUser: session.sipUser, sipPassword: session.sipPassword });
      }

      if (p === "/logout" && method === "POST") {
        // The last agent of an account out takes the account's Auth Token with
        // them — once any call they still have in a room has ended.
        for (const [t, s] of sessions) if (s === session) dropSession(t);
        return send(200, { ok: true });
      }

      if (p === "/start-call" && method === "POST") {
        // The browser places outbound calls itself; nothing here originates one.
        return send(410, { error: "Outbound calls are placed by the panel over SIP. See docs/backend-contract.md." });
      }

      // Everything below uses the account API, which SIP direct has no
      // credentials for.
      if (session.mode !== "account") return send(403, { error: "Sign in with your Vobiz account to use this" });
      const acct = accounts.get(session.authId);
      if (!acct) return send(401, { error: "Sign in again" });

      if (p === "/select-number" && method === "POST") {
        const number = toE164(body.number);
        if (!session.numbers.includes(number)) return send(400, { error: "That number is not on this account" });
        session.from = number;
        lastCallerId.set(`${session.authId}:${session.agentId}`, number);
        const route = bySipUser.get(session.sipUsername);
        if (route) route.callerId = number;
        return send(200, { selected: number });
      }

      if (p === "/setup-inbound" && method === "POST") {
        if (!session.from) return send(400, { error: "Pick a number to receive calls on first" });
        const r = await bindInbound(session, acct);
        if (r.error) return send(502, { error: r.error });
        log(`inbound: ${r.number} → app ${r.appId}${r.endpointBound ? ", endpoint bound" : ", endpoint NOT bound"}`);
        return send(200, r);
      }

      if ((m = p.match(/^\/call-status\/([^/]+)$/)) && method === "GET") {
        const id = decodeURIComponent(m[1]);
        // The panel's X-VH-Call-Ref for an outbound call: say whether the
        // customer has joined the agent's room yet. Only the agent who placed
        // the call can ask.
        if (CALL_REF_RE.test(id)) {
          const room = [...rooms.values()].find(r => r.callRef === id && r.authId === session.authId && r.sipUsername === session.sipUsername);
          if (room) return send(200, { active: true, state: room.joined ? "connected" : "ringing" });
        }
        const r = await vobiz(acct, "GET", `/Call/${encodeURIComponent(id)}/?status=live`);
        return send(200, { active: r.status === 200 });
      }

      if ((m = p.match(/^\/recordings\/([^/]+)$/)) && method === "GET") {
        if (!sameAgent(m[1])) return send(403, { error: "That identity belongs to a different session" });
        const limit = Math.min(Math.max(Number(q.limit) || 15, 1), 100);
        const r = await vobiz(acct, "GET", `/Recording/?limit=${limit}`);
        if (r.status !== 200) return send(502, { error: `Vobiz returned ${r.status} listing recordings` });
        const objects = ((r.body && r.body.objects) || []).map(o => ({
          recording_id: o.recording_id,
          add_time: o.add_time,
          rounded_recording_duration: o.rounded_recording_duration,
          playUrl: signRecording(session.authId, session.agentId, o.recording_id),
        }));
        return send(200, { objects });
      }

      return send(404, { error: `No route for ${method} ${p}` });
    } catch (err) {
      log(`✖ ${method} ${p}: ${err.message}`);
      return send(500, { error: "Internal error" });
    }
  });
  const sweeper = setInterval(sweep, 60 * 1000);
  sweeper.unref();
  server.on("close", () => clearInterval(sweeper));
  return server;
}

module.exports = { createApp, readConfig, loadDotEnv, originAllowed, toE164, fullSipUser, parseVobizJson, withIntegerField, cleanPhone, vhParam };

if (require.main === module) {
  loadDotEnv(path.join(__dirname, ".env"));
  const config = readConfig();
  const server = createApp(config);
  server.listen(config.port, config.host, () => {
    console.log("");
    console.log("  Vobiz calling backend for Freshdesk");
    console.log(`  listening      http://${config.host}:${config.port}`);
    console.log(`  public base    ${config.publicBase || "(not set)"}`);
    console.log(`  answer URL     ${config.publicBase ? `${config.publicBase}/answer` : "(set PUBLIC_BASE)"}`);
    console.log("  sign-in        any Vobiz account (Auth ID + Auth Token), or SIP direct");
    console.log(`  endpoint map   ${path.join(config.dataDir, "endpoints.json")}`);
    console.log(`  outbound       ${config.outboundMode}`);
    console.log(`  recording      ${config.recordCalls ? "on" : "off"}`);
    console.log(`  signatures     ${config.webhookSignature}`);
    if (!process.env.SIGNING_SECRET) console.log("  note           SIGNING_SECRET unset — recording links stop working on restart");
    if (!config.publicBase) console.log("  ✖ missing      PUBLIC_BASE");
    if (config.publicBase && !config.publicBase.startsWith("https://")) console.log("  ✖ PUBLIC_BASE must be https — Vobiz will not call plain http");
    console.log("");
  });
}
