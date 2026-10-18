// @vitest-environment node
/**
 * The calling backend, driven over real HTTP.
 *
 * The server under test is the one that ships (backend/server.js). Only its
 * outbound calls to Vobiz are faked, through the fetchImpl it accepts. The fake
 * is a small stateful Vobiz: two accounts with their own credentials, numbers,
 * applications and endpoints, so each test can see exactly what the backend
 * asked Vobiz for, as which account — and, for the security cases, that it
 * asked for nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createApp, readConfig, originAllowed, parseVobizJson, withIntegerField } = require("../backend/server.js");

const PUBLIC_BASE = "https://calling.example.com";
const API = "https://api.vobiz.ai/api/v1/Account/";

// Obvious fakes. App ids are 17 digits, above Number.MAX_SAFE_INTEGER, like the
// real ones: Number("43919358318796814") is 43919358318796816.
const ONE = { authId: "MA_TEST0001", token: "test-token-one-not-real", numbers: ["+910000000001", "+910000000002"], appId: "43919358318796814" };
const TWO = { authId: "MA_TEST0002", token: "test-token-two-not-real", numbers: ["+910000000003"], appId: "43919358318796815" };
const ACCOUNTS = { [ONE.authId]: ONE, [TWO.authId]: TWO };

let dataDir;

function config(overrides = {}) {
  return readConfig({ PUBLIC_BASE, SIGNING_SECRET: "test-signing-secret", DATA_DIR: dataDir, ...overrides });
}

function json(status, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { "content-type": "application/json", ...headers } });
}

/**
 * A fake Vobiz. It checks X-Auth-ID / X-Auth-Token per account, keeps
 * applications and endpoints per account, sends app ids as bare JSON numbers
 * (the unsafe case), and rewrites endpoint usernames on create like the real one.
 * With ignoreAppIdField it ignores {"app_id"} binds, so only the documented
 * integer `application` field binds.
 */
function fakeVobiz(extra = {}, { ignoreAppIdField = false } = {}) {
  const requests = [];
  const state = {};
  for (const id of Object.keys(ACCOUNTS)) state[id] = { apps: [], endpoints: {} };
  let nextEndpoint = 5000;

  const impl = async (url, opts = {}) => {
    const u = String(url);
    requests.push({ url: u, method: opts.method || "GET", headers: opts.headers || {}, body: opts.body });
    for (const [pattern, handler] of Object.entries(extra)) {
      if (u.includes(pattern)) return handler(u, opts);
    }
    if (!u.startsWith(API)) return json(404, {});
    const [authId, ...rest] = u.slice(API.length).split("/");
    const route = `/${rest.join("/")}`;
    const acct = ACCOUNTS[authId];
    const h = opts.headers || {};
    if (!acct || h["X-Auth-ID"] !== authId || h["X-Auth-Token"] !== acct.token) return json(401, { error: "invalid credentials" });
    const st = state[authId];
    const method = opts.method || "GET";
    let m;

    if (route.startsWith("/numbers?")) {
      // Shaped like List Account Phone Numbers, with one number that is not
      // active and one that cannot carry voice — neither may be offered.
      const items = [
        ...acct.numbers.map(e164 => ({ e164, status: "active", voice_enabled: true, application_id: "20000000000000001" })),
        { e164: "+910000000098", status: "suspended", voice_enabled: true },
        { e164: "+910000000099", status: "active", voice_enabled: false },
      ];
      return json(200, { items, page: 1, per_page: 100, total: items.length });
    }
    if (route.startsWith("/Application/?")) {
      const objects = st.apps.map(a => `{"app_id":${a.app_id},"app_name":"${a.app_name}","answer_url":"${a.answer_url}"}`);
      return json(200, `{"objects":[${objects.join(",")}]}`);
    }
    if (route === "/Application/" && method === "POST") {
      const b = JSON.parse(opts.body);
      st.apps.push({ app_id: acct.appId, app_name: b.app_name, answer_url: b.answer_url });
      return json(201, `{"app_id":${acct.appId},"message":"created"}`);
    }
    if (route.startsWith("/Endpoint/?")) {
      const objects = Object.entries(st.endpoints).map(([id, e]) => ({ endpoint_id: id, username: e.username, alias: e.alias }));
      return json(200, { objects });
    }
    if (route === "/Endpoint/" && method === "POST") {
      const b = JSON.parse(opts.body);
      if (!/^[A-Za-z0-9]+$/.test(b.username)) return json(400, { error: "invalid request parameters" });
      const id = String((nextEndpoint += 1));
      st.endpoints[id] = { username: `${b.username}7`, alias: b.alias, password: b.password, appId: ignoreAppIdField ? "" : String(b.app_id || "") };
      return json(201, { message: "created", endpoint_id: id });
    }
    if ((m = route.match(/^\/Endpoint\/(\d+)\/$/))) {
      const ep = st.endpoints[m[1]];
      if (!ep) return json(404, { error: "Endpoint not found" });
      if (method === "GET") {
        const app = ep.appId ? `{"app_id":${ep.appId},"app_name":"x"}` : "null";
        return json(200, `{"endpoint_id":"${m[1]}","username":"${ep.username}","application":${app}}`);
      }
      const raw = String(opts.body);
      const b = JSON.parse(raw);
      if (b.password) ep.password = b.password;
      const app = (raw.match(/"application":(\d+)[,}]/) || [])[1];
      if (app) ep.appId = app;
      if (b.app_id && !ignoreAppIdField) ep.appId = String(b.app_id);
      return new Response(null, { status: 202 });
    }
    if (/^\/numbers\/%2B\d+\/application$/.test(route) && method === "POST") return json(200, { message: "Number attached to application" });
    if (route === "/Call/" && method === "POST") return json(201, { request_uuid: "req-1" });
    if (route.startsWith("/Call/") && method === "DELETE") return new Response(null, { status: 204 });
    return json(404, {});
  };
  impl.requests = requests;
  impl.state = state;
  return impl;
}

let server;
let base;
let vobiz;
const logs = [];
const responses = [];

async function start(cfg = config(), extra = {}, fakeOpts = {}, fake = null) {
  vobiz = fake || fakeVobiz(extra, fakeOpts);
  server = createApp(cfg, { fetchImpl: vobiz, log: line => logs.push(line) });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-backend-"));
});

afterEach(async () => {
  logs.length = 0;
  responses.length = 0;
  if (server) await new Promise(r => server.close(r));
  server = null;
});

/** fetch that also keeps every response body, for the "token never leaks" check. */
async function call(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.clone().text();
  responses.push(text + JSON.stringify([...res.headers]));
  return res;
}

const post = (p, body, headers = {}) =>
  call(`${base}${p}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

const get = (p, headers = {}) => call(`${base}${p}`, { headers });

const form = (p, params, headers = {}) =>
  call(`${base}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(params).toString(),
  });

async function login(agentId = "priya", acct = ONE) {
  const res = await post("/login", { agentId, authId: acct.authId, authToken: acct.token });
  expect(res.status).toBe(200);
  const data = await res.json();
  const auth = { Authorization: `Bearer ${data.token}` };
  const agent = await (await get(`/agent/${agentId}`, auth)).json();
  return { token: data.token, data, auth, agent, sipUsername: agent.sipUser.split("@")[0] };
}

const callsTo = (acct, method, fragment) =>
  vobiz.requests.filter(r => r.url.startsWith(`${API}${acct.authId}/`) && r.method === method && r.url.includes(fragment));

describe("sign-in accepts any Vobiz account", () => {
  beforeEach(() => start());

  it("checks the pair with Vobiz and returns a token and that account's numbers", async () => {
    const { data } = await login("priya", ONE);
    expect(data.token).toMatch(/^[0-9a-f]{64}$/);
    expect(data.numbers).toEqual(ONE.numbers);
    expect(data.selected).toBe(ONE.numbers[0]);
    const check = vobiz.requests[0];
    expect(check.url).toBe(`${API}${ONE.authId}/numbers?page=1&per_page=100`);
    expect(check.headers).toMatchObject({ "X-Auth-ID": ONE.authId, "X-Auth-Token": ONE.token });
  });

  it("signs two different accounts in, each with its own endpoint", async () => {
    const a = await login("priya", ONE);
    const b = await login("arjun", TWO);
    expect(b.data.numbers).toEqual(TWO.numbers);
    expect(Object.keys(vobiz.state[ONE.authId].endpoints)).toHaveLength(1);
    expect(Object.keys(vobiz.state[TWO.authId].endpoints)).toHaveLength(1);
    expect(a.agent.sipUser).not.toBe(b.agent.sipUser);
    expect(a.agent.sipPassword).not.toBe(b.agent.sipPassword);
    // Each endpoint got exactly the password its own browser was handed.
    const epA = Object.values(vobiz.state[ONE.authId].endpoints)[0];
    const epB = Object.values(vobiz.state[TWO.authId].endpoints)[0];
    expect(epA.password).toBe(a.agent.sipPassword);
    expect(epB.password).toBe(b.agent.sipPassword);
  });

  it("gives the same agent id in two accounts two separate endpoints", async () => {
    const a = await login("priya", ONE);
    const b = await login("priya", TWO);
    expect(a.agent.sipUser).not.toBe(b.agent.sipUser);
  });

  it("refuses a wrong Auth Token and provisions nothing", async () => {
    const res = await post("/login", { agentId: "priya", authId: ONE.authId, authToken: "wrong-token" });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/did not accept/i);
    expect(vobiz.requests).toHaveLength(1);
    expect(Object.keys(vobiz.state[ONE.authId].endpoints)).toHaveLength(0);
  });

  it("refuses one account's Auth ID with another account's token", async () => {
    const res = await post("/login", { agentId: "priya", authId: TWO.authId, authToken: ONE.token });
    expect(res.status).toBe(401);
  });

  it("refuses something that is not an Auth ID without asking Vobiz", async () => {
    const res = await post("/login", { agentId: "priya", authId: "../../x", authToken: ONE.token });
    expect(res.status).toBe(401);
    expect(vobiz.requests).toHaveLength(0);
  });

  it("needs all three fields", async () => {
    expect((await post("/login", { agentId: "priya", authId: ONE.authId })).status).toBe(400);
    expect(vobiz.requests).toHaveLength(0);
  });

  it("says so when Vobiz cannot be reached", async () => {
    await new Promise(r => server.close(r));
    const broken = async () => { throw new Error("network down"); };
    broken.requests = [];
    server = null;
    await start(config(), {}, {}, broken);
    const res = await post("/login", { agentId: "priya", authId: ONE.authId, authToken: ONE.token });
    expect(res.status).toBe(502);
  });

  it("refuses to provision without a public https base", async () => {
    await new Promise(r => server.close(r));
    server = null;
    await start(config({ PUBLIC_BASE: "" }));
    const res = await post("/login", { agentId: "priya", authId: ONE.authId, authToken: ONE.token });
    expect(res.status).toBe(500);
    expect(vobiz.requests).toHaveLength(0);
  });

  it("keeps the Auth Token out of the log", async () => {
    await login("priya", ONE);
    await post("/login", { agentId: "x", authId: ONE.authId, authToken: "wrong-token" });
    expect(logs.join("\n")).not.toContain(ONE.token);
  });
});

describe("the caller ID picker (account mode)", () => {
  it("offers only active, voice-enabled numbers, with the application each is on", async () => {
    await start();
    const { data } = await login("priya", ONE);
    expect(data.numbers).toEqual(ONE.numbers);
    expect(data.numberDetails).toEqual(ONE.numbers.map(e164 => ({ e164, applicationId: "20000000000000001" })));
  });

  it("pages through the whole list", async () => {
    const many = Array.from({ length: 150 }, (_, i) => `+9100000${String(10000 + i).padStart(5, "0")}`);
    await start(config(), {
      [`${ONE.authId}/numbers?page=`]: u => {
        const page = Number(new URL(u).searchParams.get("page"));
        const items = many.slice((page - 1) * 100, page * 100).map(e164 => ({ e164, status: "active", voice_enabled: true }));
        return json(200, { items, page, per_page: 100, total: many.length });
      },
    });
    const res = await post("/login", { agentId: "priya", authId: ONE.authId, authToken: ONE.token });
    const data = await res.json();
    expect(data.numbers).toHaveLength(150);
    expect(vobiz.requests.filter(r => r.url.includes("/numbers?page="))).toHaveLength(2);
  });

  it("rejects a caller ID that is not in the account's list", async () => {
    await start();
    const { auth } = await login("priya", ONE);
    expect((await post("/select-number", { number: "+910000000098" }, auth)).status).toBe(400);
    expect((await post("/select-number", { number: "+910000000099" }, auth)).status).toBe(400);
    expect((await post("/select-number", { number: ONE.numbers[1] }, auth)).status).toBe(200);
  });

  it("remembers the agent's last choice for the next sign-in", async () => {
    await start();
    const { auth } = await login("priya", ONE);
    await post("/select-number", { number: ONE.numbers[1] }, auth);
    const again = await login("priya", ONE);
    expect(again.data.selected).toBe(ONE.numbers[1]);
  });

  it("ignores an X-VH-Caller-ID header naming a number the account does not own", async () => {
    await start(config({ OUTBOUND_MODE: "dial" }));
    const a = await login("priya", ONE);
    const xml = await (await form("/answer", { From: `sip:${a.sipUsername}@registrar.vobiz.ai`, To: "919999988888", "X-VH-Caller-ID": "+910000000003" })).text();
    expect(xml).toContain('callerId="+910000000001"');
    const ok = await (await form("/answer", { From: `sip:${a.sipUsername}@registrar.vobiz.ai`, To: "919999988888", "SIPHeader_X-VH-Caller-ID": "+910000000002" })).text();
    expect(ok).toContain('callerId="+910000000002"');
  });
});

describe("per-sign-in provisioning", () => {
  it("creates this integration's application once, pointed at /answer", async () => {
    await start();
    await login("priya", ONE);
    await login("arjun", ONE);
    const created = callsTo(ONE, "POST", "/Application/");
    expect(created).toHaveLength(1);
    expect(JSON.parse(created[0].body)).toMatchObject({ answer_url: `${PUBLIC_BASE}/answer`, answer_method: "POST", hangup_method: "POST" });
  });

  it("reuses its own application and never repoints anyone else's", async () => {
    await start();
    vobiz.state[ONE.authId].apps.push({ app_id: "11111111111111111", app_name: "Theirs", answer_url: "https://other.example/answer" });
    vobiz.state[ONE.authId].apps.push({ app_id: ONE.appId, app_name: "Freshdesk-Calling", answer_url: `${PUBLIC_BASE}/answer` });
    await login("priya", ONE);
    expect(callsTo(ONE, "POST", "/Application/")).toHaveLength(0);
    expect(vobiz.requests.some(r => r.url.includes("/Application/11111111111111111"))).toBe(false);
    const ep = Object.values(vobiz.state[ONE.authId].endpoints)[0];
    expect(ep.appId).toBe(ONE.appId);
  });

  it("binds the endpoint with the 17-digit app id exactly, as a string app_id first", async () => {
    await start();
    await login("priya", ONE);
    const binds = vobiz.requests.filter(r => /\/Endpoint\/\d+\/$/.test(r.url) && r.method === "POST" && String(r.body).includes("app"));
    expect(binds).toHaveLength(1);
    expect(binds[0].body).toBe('{"app_id":"43919358318796814"}');
    const create = callsTo(ONE, "POST", "/Endpoint/").find(r => r.url.endsWith("/Endpoint/"));
    expect(JSON.parse(create.body).app_id).toBe("43919358318796814");
    expect(Object.values(vobiz.state[ONE.authId].endpoints)[0].appId).toBe("43919358318796814");
    expect(logs.join("\n")).toMatch(/bound to application 43919358318796814/);
  });

  it("falls back to the documented integer application field, spliced in exactly, and logs it", async () => {
    await start(config(), {}, { ignoreAppIdField: true });
    await login("priya", ONE);
    const retry = vobiz.requests.find(r => String(r.body).includes('"application"'));
    expect(retry.body).toBe('{"application":43919358318796814}');
    expect(Object.values(vobiz.state[ONE.authId].endpoints)[0].appId).toBe("43919358318796814");
    expect(logs.join("\n")).toMatch(/retrying with the integer application field/);
    expect(logs.join("\n")).toMatch(/bound to application 43919358318796814/);
  });

  it("finds the agent's endpoint by exact alias when the endpoint map is lost", async () => {
    await start();
    const first = await login("priya", ONE);
    fs.rmSync(path.join(dataDir, "endpoints.json"));
    const fake = vobiz;
    await new Promise(r => server.close(r));
    server = null;
    await start(config(), {}, {}, fake);
    const again = await login("priya", ONE);
    expect(again.agent.sipUser).toBe(first.agent.sipUser);
    expect(Object.keys(fake.state[ONE.authId].endpoints)).toHaveLength(1);
  });

  it("logs loudly when the endpoint never binds", async () => {
    await start(config(), {
      // Swallow every bind.
      "/Endpoint/5001/": (u, o) => ((o.method || "GET") === "GET"
        ? json(200, '{"endpoint_id":"5001","username":"fdpriya7","application":null}')
        : new Response(null, { status: 202 })),
    });
    const res = await post("/login", { agentId: "priya", authId: ONE.authId, authToken: ONE.token });
    expect(res.status).toBe(200);
    expect(logs.join("\n")).toMatch(/NOT bound/);
  });

  it("registers with the username Vobiz stored, not the one it was sent", async () => {
    await start();
    const { agent } = await login("priya", ONE);
    const create = callsTo(ONE, "POST", "/Endpoint/").find(r => r.url.endsWith("/Endpoint/"));
    const sent = JSON.parse(create.body).username;
    expect(sent).toMatch(/^[a-z0-9]+$/);
    expect(agent.sipUser).toBe(`${sent}7@registrar.vobiz.ai`);
  });

  it("reuses the agent's endpoint on the next sign-in with a fresh password", async () => {
    await start();
    const first = await login("priya", ONE);
    const second = await login("priya", ONE);
    expect(callsTo(ONE, "POST", "/Endpoint/").filter(r => r.url.endsWith("/Endpoint/"))).toHaveLength(1);
    expect(second.agent.sipUser).toBe(first.agent.sipUser);
    expect(second.agent.sipPassword).not.toBe(first.agent.sipPassword);
    expect(Object.values(vobiz.state[ONE.authId].endpoints)[0].password).toBe(second.agent.sipPassword);
    // The older session holds a dead password, so it is closed.
    expect((await get("/agent/priya", first.auth)).status).toBe(401);
  });

  it("survives a restart through the endpoint map, which holds ids only", async () => {
    await start();
    const first = await login("priya", ONE);
    const file = path.join(dataDir, "endpoints.json");
    const text = fs.readFileSync(file, "utf8");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const map = JSON.parse(text);
    expect(Object.keys(map)).toEqual([`${ONE.authId}:priya`]);
    expect(Object.keys(map[`${ONE.authId}:priya`]).sort()).toEqual(["endpointId", "username"]);
    expect(text).not.toContain(first.agent.sipPassword);
    expect(text).not.toContain(ONE.token);

    const fake = vobiz;
    await new Promise(r => server.close(r));
    server = null;
    await start(config(), {}, {}, fake);
    const again = await login("priya", ONE);
    expect(again.agent.sipUser).toBe(first.agent.sipUser);
    expect(Object.keys(fake.state[ONE.authId].endpoints)).toHaveLength(1);
  });

  it("creates a new endpoint when the stored one was deleted in the console", async () => {
    await start();
    const first = await login("priya", ONE);
    vobiz.state[ONE.authId].endpoints = {};
    const again = await login("priya", ONE);
    expect(again.agent.sipUser).not.toBe(first.agent.sipUser);
    expect(Object.keys(vobiz.state[ONE.authId].endpoints)).toHaveLength(1);
  });

  it("does not attach any number on sign-in", async () => {
    await start();
    await login("priya", ONE);
    expect(vobiz.requests.some(r => r.url.includes("/application") && r.url.includes("/numbers/"))).toBe(false);
  });
});

describe("the SIP password", () => {
  beforeEach(() => start());

  it("is not served to an anonymous caller", async () => {
    const res = await get("/agent/anyone");
    expect(res.status).toBe(401);
  });

  it("is served to the agent who signed in, and only to them", async () => {
    const { agent, auth } = await login("priya", ONE);
    expect(agent.sipUser).toMatch(/^fdpriya[0-9a-f]{6}7@registrar\.vobiz\.ai$/);
    expect(agent.sipPassword).toMatch(/^[0-9a-f]{32}$/);
    expect((await get("/agent/someone-else", auth)).status).toBe(403);
  });

  it("is not served for a made-up token", async () => {
    const res = await get("/agent/priya", { Authorization: `Bearer ${"0".repeat(64)}` });
    expect(res.status).toBe(401);
  });
});

describe("sessions", () => {
  beforeEach(() => start());

  it("reports no session without the token, even for a signed-in identity", async () => {
    await login("priya", ONE);
    expect(await (await get("/session/priya")).json()).toEqual({ loggedIn: false });
  });

  it("reports the account the session belongs to", async () => {
    const { auth } = await login("arjun", TWO);
    expect(await (await get("/session/arjun", auth)).json()).toMatchObject({ loggedIn: true, authId: TWO.authId, from: TWO.numbers[0] });
  });

  it("will not set a caller ID the account does not own — including another account's", async () => {
    const { auth } = await login("priya", ONE);
    expect((await post("/select-number", { number: TWO.numbers[0] }, auth)).status).toBe(400);
  });

  it("logs out", async () => {
    const { auth } = await login("priya", ONE);
    expect((await post("/logout", {}, auth)).status).toBe(200);
    expect((await get("/agent/priya", auth)).status).toBe(401);
  });
});

describe("the Auth Token", () => {
  it("never appears in any HTTP response", async () => {
    await start(config({ RECORD_CALLS: "1" }), {
      "/Recording/?limit": () => json(200, { objects: [{ recording_id: "rec1", add_time: "2026-10-01 10:00:00", rounded_recording_duration: 12 }] }),
    });
    const a = await login("priya", ONE);
    const b = await login("arjun", TWO);
    await get("/session/priya", a.auth);
    await get("/recordings/priya", a.auth);
    await post("/select-number", { number: ONE.numbers[1] }, a.auth);
    await post("/setup-inbound", {}, a.auth);
    await get("/call-status/abc", b.auth);
    await form("/answer", { CallUUID: "c1", From: `sip:${a.sipUsername}@registrar.vobiz.ai`, To: "919999988888" });
    await form("/answer", { From: "918888877777", To: TWO.numbers[0].slice(1) });
    await post("/login", { agentId: "x", authId: ONE.authId, authToken: "wrong-token" });
    expect(responses.length).toBeGreaterThan(8);
    for (const text of responses) {
      expect(text).not.toContain(ONE.token);
      expect(text).not.toContain(TWO.token);
    }
  });
});

describe("CORS", () => {
  beforeEach(() => start());

  it("never answers with a wildcard or an arbitrary origin", async () => {
    const res = await get("/health", { Origin: "https://evil.example" });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("does not treat a look-alike domain as Freshdesk", () => {
    expect(originAllowed("https://acme.freshdesk.com.evil.example", [])).toBe(false);
    expect(originAllowed("https://evilfreshdesk.com", [])).toBe(false);
    expect(originAllowed("null", [])).toBe(false);
  });

  it("allows a Freshdesk account and the FDK dev server", async () => {
    for (const origin of ["https://acme.freshdesk.com", "http://localhost:10001"]) {
      const res = await get("/health", { Origin: origin });
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    }
  });

  it("lets the preflight through with the headers the panel sends", async () => {
    const res = await fetch(`${base}/agent/priya`, {
      method: "OPTIONS",
      headers: { Origin: "https://acme.freshdesk.com", "Access-Control-Request-Headers": "authorization,ngrok-skip-browser-warning" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toMatch(/Authorization/);
    expect(res.headers.get("access-control-allow-headers")).toMatch(/ngrok-skip-browser-warning/);
  });

  it("honours an extra origin pattern from ALLOWED_ORIGINS", () => {
    expect(originAllowed("https://abc.apps.example.net", ["https://*.example.net"])).toBe(true);
    expect(originAllowed("https://example.net.evil.io", ["https://*.example.net"])).toBe(false);
  });
});

describe("recordings", () => {
  const media = acct => `https://media.vobiz.ai/api/v1/Account/${acct.authId}/Recording/rec1.mp3`;

  function recordingApi(recordingUrl) {
    return {
      "/Recording/?limit": () => json(200, { objects: [{ recording_id: "rec1", add_time: "2026-10-01 10:00:00", rounded_recording_duration: 12 }] }),
      "/Recording/rec1/": u => json(200, { recording_url: recordingUrl || media(u.includes(TWO.authId) ? TWO : ONE) }),
      "media.vobiz.ai": () => new Response(Buffer.from("ID3audio"), { status: 200, headers: { "content-type": "audio/mpeg" } }),
    };
  }

  async function playUrl(agentId = "priya", acct = ONE) {
    const { auth } = await login(agentId, acct);
    const list = await (await get(`/recordings/${agentId}?limit=5`, auth)).json();
    return list.objects[0].playUrl;
  }

  it("is not an open proxy", async () => {
    await start();
    const res = await get("/recording-file?url=https://example.com/");
    expect([401, 404]).toContain(res.status);
    const { auth } = await login();
    expect((await get("/recording-file?url=https://example.com/", auth)).status).toBe(404);
    expect(vobiz.requests.some(r => r.url.includes("example.com"))).toBe(false);
  });

  it("refuses playback without a signature", async () => {
    await start(config(), recordingApi());
    const res = await get(`/recording-audio/priya/rec1?account=${ONE.authId}`);
    expect(res.status).toBe(403);
    expect(vobiz.requests).toHaveLength(0);
  });

  it("plays a signed link, fetching the audio server-side as that account", async () => {
    await start(config(), recordingApi());
    const link = await playUrl();
    expect(link).toMatch(new RegExp(`^/recording-audio/priya/rec1\\?account=${ONE.authId}&exp=\\d+&sig=[0-9a-f]{64}$`));
    expect(link).not.toContain(ONE.token);
    const res = await get(link); // no Authorization header, like <audio>
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(await res.text()).toBe("ID3audio");
    const audio = vobiz.requests.find(r => r.url.startsWith("https://media.vobiz.ai"));
    expect(audio.headers["X-Auth-ID"]).toBe(ONE.authId);
  });

  it("scopes every link to its account", async () => {
    await start(config(), recordingApi());
    const one = await playUrl("priya", ONE);
    const two = await playUrl("arjun", TWO);
    // Re-pointing one account's link at the other account fails the signature.
    expect((await get(one.replace(ONE.authId, TWO.authId))).status).toBe(403);
    expect((await get(one.replace(/account=[^&]+&/, ""))).status).toBe(403);
    // Each link fetches with its own account's credentials.
    vobiz.requests.length = 0;
    expect((await get(two)).status).toBe(200);
    expect(vobiz.requests.every(r => r.headers["X-Auth-ID"] === TWO.authId)).toBe(true);
    expect(vobiz.requests.some(r => r.url.startsWith(`${API}${TWO.authId}/Recording/rec1/`))).toBe(true);
  });

  it("rejects a tampered or re-targeted signature", async () => {
    await start(config(), recordingApi());
    const link = await playUrl();
    expect((await get(link.replace("rec1", "rec2"))).status).toBe(403);
    expect((await get(link.replace("/priya/", "/other/"))).status).toBe(403);
  });

  it("rejects an expired link", async () => {
    await start(config({ RECORDING_URL_TTL_SECONDS: "-10" }), recordingApi());
    expect((await get(await playUrl())).status).toBe(403);
  });

  it("asks for a fresh sign-in after a restart forgets the account", async () => {
    await start(config(), recordingApi());
    const link = await playUrl();
    await new Promise(r => server.close(r));
    server = null;
    await start(config(), recordingApi());
    const res = await get(link);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/sign in/i);
  });

  it("never sends the account credentials off the Vobiz media hosts", async () => {
    await start(config(), recordingApi("https://attacker.example/steal.mp3"));
    const res = await get(await playUrl());
    expect(res.status).toBe(502);
    expect(vobiz.requests.some(r => r.url.includes("attacker.example"))).toBe(false);
  });

  it("drops the credentials when Vobiz redirects to object storage", async () => {
    const api = recordingApi();
    api["media.vobiz.ai"] = () => new Response(null, { status: 302, headers: { location: "https://bucket.s3.ap-south-1.amazonaws.com/rec1.mp3?X-Amz-Signature=abc" } });
    api["amazonaws.com"] = () => new Response(Buffer.from("s3audio"), { status: 200, headers: { "content-type": "audio/mpeg" } });
    await start(config(), api);
    const res = await get(await playUrl());
    expect(await res.text()).toBe("s3audio");
    const s3 = vobiz.requests.find(r => r.url.includes("amazonaws.com"));
    expect(s3.headers["X-Auth-Token"]).toBeUndefined();
  });
});

describe("no file is served from disk", () => {
  beforeEach(() => start());

  it("does not resolve ../ to the .env file or the endpoint map", async () => {
    for (const p of ["/../backend/.env", "/../.env", "/%2e%2e/backend/.env", "/backend/.env", "/backend/data/endpoints.json"]) {
      const res = await new Promise((resolve, reject) => {
        const req = http.request(`${base}${p}`, { method: "GET", path: p }, r => {
          let b = ""; r.on("data", c => (b += c)); r.on("end", () => resolve({ status: r.statusCode, body: b }));
        });
        req.on("error", reject);
        req.end();
      });
      expect([401, 404]).toContain(res.status);
      expect(res.body).not.toMatch(/PUBLIC_BASE|endpointId/);
    }
  });
});

describe("outbound webhooks route by SIP username", () => {
  it("bridges each agent out through a conference, as their own account and number", async () => {
    await start();
    const a = await login("priya", ONE);
    const b = await login("arjun", TWO);
    await post("/select-number", { number: ONE.numbers[1] }, a.auth);

    const res = await form("/answer", { CallUUID: "abc-123", From: `sip:${a.sipUsername}@registrar.vobiz.ai`, To: "919999988888", Direction: "inbound" });
    const xml = await res.text();
    expect(res.headers.get("content-type")).toBe("text/xml");
    expect(xml).toContain('stayAlone="true"');
    expect(xml).toContain(">fdabc123</Conference>");

    await form("/answer", { CallUUID: "def-456", From: `sip:${b.sipUsername}@registrar.vobiz.ai`, To: "919999977777" });

    const legs = vobiz.requests.filter(r => r.url.endsWith("/Call/") && r.method === "POST");
    expect(legs).toHaveLength(2);
    expect(legs[0].url).toBe(`${API}${ONE.authId}/Call/`);
    expect(legs[0].headers["X-Auth-Token"]).toBe(ONE.token);
    expect(JSON.parse(legs[0].body)).toMatchObject({ from: "910000000002", to: "919999988888", answer_url: `${PUBLIC_BASE}/outbound-join?room=fdabc123` });
    expect(legs[1].url).toBe(`${API}${TWO.authId}/Call/`);
    expect(legs[1].headers["X-Auth-Token"]).toBe(TWO.token);
    expect(JSON.parse(legs[1].body)).toMatchObject({ from: "910000000003", to: "919999977777" });
  });

  it("hangs up on a SIP user no signed-in agent holds", async () => {
    await start();
    await login("priya", ONE);
    const xml = await (await form("/answer", { From: "sip:stranger@registrar.vobiz.ai", To: "919999988888" })).text();
    expect(xml).toContain("<Hangup/>");
    expect(vobiz.requests.some(r => r.url.endsWith("/Call/"))).toBe(false);
  });

  it("stops routing an agent who logged out", async () => {
    await start();
    const a = await login("priya", ONE);
    await post("/logout", {}, a.auth);
    const xml = await (await form("/answer", { From: `sip:${a.sipUsername}@registrar.vobiz.ai`, To: "919999988888" })).text();
    expect(xml).toContain("<Hangup/>");
    expect(xml).not.toContain("<Conference");
  });

  it("joins the customer to the agent's room when they answer", async () => {
    await start();
    const a = await login();
    await form("/answer", { CallUUID: "abc-123", From: `sip:${a.sipUsername}@registrar.vobiz.ai`, To: "919999988888" });
    const xml = await (await form("/outbound-join?room=fdabc123", { CallUUID: "cust-1" })).text();
    expect(xml).toContain('<Conference startConferenceOnEnter="true"');
    expect(xml).toContain(">fdabc123</Conference>");
    expect(await (await form("/outbound-join?room=nope", {})).text()).toContain("<Hangup/>");
  });

  it("releases the agent, as the right account, when the customer never answers", async () => {
    await start();
    const b = await login("arjun", TWO);
    await form("/answer", { CallUUID: "abc-123", From: `sip:${b.sipUsername}@registrar.vobiz.ai`, To: "919999988888" });
    await form("/outbound-hangup?room=fdabc123", { CallUUID: "cust-1", HangupCause: "NO_ANSWER" });
    const del = vobiz.requests.find(r => r.method === "DELETE");
    expect(del.url).toBe(`${API}${TWO.authId}/Call/abc-123/`);
    expect(del.headers["X-Auth-Token"]).toBe(TWO.token);
  });

  it("does not release the agent after a call that connected", async () => {
    await start();
    const a = await login();
    await form("/answer", { CallUUID: "abc-123", From: `sip:${a.sipUsername}@registrar.vobiz.ai`, To: "919999988888" });
    await form("/outbound-join?room=fdabc123", { CallUUID: "cust-1" });
    await form("/outbound-hangup?room=fdabc123", { CallUUID: "cust-1" });
    expect(vobiz.requests.some(r => r.method === "DELETE")).toBe(false);
  });

  it("says so when Vobiz refuses the customer leg", async () => {
    await start(config(), { "/Call/": () => json(400, { error: "insufficient balance" }) });
    const a = await login();
    const xml = await (await form("/answer", { CallUUID: "x1", From: `sip:${a.sipUsername}@registrar.vobiz.ai`, To: "919999988888" })).text();
    expect(xml).toContain("could not be placed");
  });

  it("uses <Dial><Number> with the agent's caller ID when OUTBOUND_MODE=dial", async () => {
    await start(config({ OUTBOUND_MODE: "dial" }));
    const a = await login();
    vobiz.requests.length = 0;
    const xml = await (await form("/answer", { From: `sip:${a.sipUsername}@registrar.vobiz.ai`, To: "+919999988888" })).text();
    expect(xml).toMatch(/<Dial callerId="\+910000000001"[^>]*action="https:\/\/calling\.example\.com\/dial-status"[^>]*redirect="false"><Number>919999988888<\/Number><\/Dial>/);
    expect(vobiz.requests).toHaveLength(0);
  });

  it("refuses to dial something that is not a phone number", async () => {
    await start(config({ OUTBOUND_MODE: "dial" }));
    const a = await login();
    const xml = await (await form("/answer", { From: `sip:${a.sipUsername}@registrar.vobiz.ai`, To: "sip:evil@elsewhere" })).text();
    expect(xml).toContain("<Hangup/>");
    expect(xml).not.toContain("<Dial");
  });

  it("records the session when RECORD_CALLS is on, before the bridge", async () => {
    await start(config({ RECORD_CALLS: "1", OUTBOUND_MODE: "dial" }));
    const a = await login();
    const xml = await (await form("/answer", { From: `sip:${a.sipUsername}@registrar.vobiz.ai`, To: "919999988888" })).text();
    expect(xml.indexOf("<Record")).toBeGreaterThan(-1);
    expect(xml.indexOf("<Record")).toBeLessThan(xml.indexOf("<Dial"));
  });

  it("answers a hangup notification with nothing", async () => {
    await start();
    const a = await login();
    vobiz.requests.length = 0;
    const xml = await (await form("/answer", { Event: "Hangup", From: `sip:${a.sipUsername}@registrar.vobiz.ai`, To: "919999988888" })).text();
    expect(xml).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>');
    expect(vobiz.requests).toHaveLength(0);
  });
});

describe("inbound webhooks route by the dialled number", () => {
  it("rings the signed-in agent of the account that owns the DID, with the DID as caller ID", async () => {
    await start();
    const a = await login("priya", ONE);
    const b = await login("arjun", TWO);
    const toTwo = await (await form("/answer", { From: "918888877777", To: "910000000003" })).text();
    expect(toTwo).toMatch(new RegExp(`<Dial callerId="\\+910000000003"[^>]*><User>sip:${b.sipUsername}@registrar\\.vobiz\\.ai</User></Dial>`));
    expect(toTwo).not.toContain(a.sipUsername);
    const toOne = await (await form("/answer", { From: "918888877777", To: "+910000000002" })).text();
    expect(toOne).toMatch(new RegExp(`<Dial callerId="\\+910000000002"[^>]*><User>sip:${a.sipUsername}@registrar\\.vobiz\\.ai</User></Dial>`));
  });

  it("rings every signed-in agent of that account", async () => {
    await start();
    const a = await login("priya", ONE);
    const c = await login("meera", ONE);
    const xml = await (await form("/answer", { From: "918888877777", To: "910000000001" })).text();
    expect(xml).toContain(`<User>sip:${a.sipUsername}@registrar.vobiz.ai</User>`);
    expect(xml).toContain(`<User>sip:${c.sipUsername}@registrar.vobiz.ai</User>`);
  });

  it("hangs up politely, and logs it, when no signed-in account owns the number", async () => {
    await start();
    await login("priya", ONE);
    const xml = await (await form("/answer", { From: "918888877777", To: "910000000009" })).text();
    expect(xml).toContain("<Speak>Sorry, nobody is available to take your call.</Speak><Hangup/>");
    expect(logs.join("\n")).toMatch(/no signed-in agent's account owns that number/);
  });
});

describe("webhook signatures", () => {
  const sign = (token, p, nonce) =>
    crypto.createHmac("sha256", token).update(`${PUBLIC_BASE}${p}.${nonce}`).digest("base64");
  const headers = (token, p, nonce = "12345678901234567890") => ({
    "X-Vobiz-Signature-V3": sign(token, p, nonce), "X-Vobiz-Signature-V3-Nonce": nonce,
  });

  it("accepts a valid V3 signature from the account the call belongs to", async () => {
    await start(config({ VOBIZ_WEBHOOK_SIGNATURE: "require" }));
    await login("priya", ONE);
    await login("arjun", TWO);
    const res = await form("/answer", { From: "918888877777", To: "910000000003" }, headers(TWO.token, "/answer"));
    expect(res.status).toBe(200);
  });

  it("rejects a webhook for one account signed with another account's token", async () => {
    await start(config({ VOBIZ_WEBHOOK_SIGNATURE: "require" }));
    await login("priya", ONE);
    await login("arjun", TWO);
    const res = await form("/answer", { From: "918888877777", To: "910000000003" }, headers(ONE.token, "/answer"));
    expect(res.status).toBe(403);
  });

  it("checks an outbound webhook against the agent's account", async () => {
    await start(config({ VOBIZ_WEBHOOK_SIGNATURE: "require" }));
    const a = await login("priya", ONE);
    const from = `sip:${a.sipUsername}@registrar.vobiz.ai`;
    expect((await form("/answer", { CallUUID: "abc", From: from, To: "919999988888" }, headers(ONE.token, "/answer", "1"))).status).toBe(200);
    // The query string is ignored, as Vobiz does when signing.
    expect((await form("/outbound-join?room=fdabc", {}, headers(ONE.token, "/outbound-join", "2"))).status).toBe(200);
  });

  it("falls back to any signed-in account's token when the webhook names none", async () => {
    await start(config({ VOBIZ_WEBHOOK_SIGNATURE: "require" }));
    await login("priya", ONE);
    expect((await form("/conf-event", {}, headers(ONE.token, "/conf-event"))).status).toBe(200);
    expect((await form("/conf-event", {}, headers("not-a-token", "/conf-event"))).status).toBe(403);
  });

  it("rejects a forged or missing signature when required", async () => {
    await start(config({ VOBIZ_WEBHOOK_SIGNATURE: "require" }));
    await login("priya", ONE);
    const forged = await form("/answer", { From: "918888877777", To: "910000000001" }, {
      "X-Vobiz-Signature-V3": "AAAA", "X-Vobiz-Signature-V3-Nonce": "1",
    });
    expect(forged.status).toBe(403);
    expect((await form("/answer", { From: "918888877777", To: "910000000001" })).status).toBe(403);
  });

  it("only logs a mismatch in the default log mode", async () => {
    await start();
    expect((await form("/dial-status", { DialStatus: "failed" })).status).toBe(200);
    expect(logs.join("\n")).toMatch(/no signature headers/);
  });
});

describe("Enable inbound calls", () => {
  beforeEach(() => start());

  it("needs a session", async () => {
    expect((await post("/setup-inbound", { agentId: "priya" })).status).toBe(401);
    expect((await post("/select-number", { agentId: "priya", number: ONE.numbers[0] })).status).toBe(401);
    expect(vobiz.requests).toHaveLength(0);
  });

  it("attaches the selected number, in the agent's account, to this integration's application", async () => {
    const { auth } = await login("arjun", TWO);
    const res = await post("/setup-inbound", {}, auth);
    expect(await res.json()).toMatchObject({ number: TWO.numbers[0], appId: TWO.appId, endpointBound: true });
    const attach = vobiz.requests.find(r => r.url.endsWith("/numbers/%2B910000000003/application"));
    expect(attach.url.startsWith(`${API}${TWO.authId}/`)).toBe(true);
    expect(JSON.parse(attach.body)).toEqual({ application_id: TWO.appId });
    expect(callsTo(TWO, "POST", "/Application/")).toHaveLength(1);
  });

  it("no longer originates calls from /start-call", async () => {
    const { auth } = await login();
    expect((await post("/start-call", { to: "919999988888" }, auth)).status).toBe(410);
    expect(vobiz.requests.some(r => r.url.endsWith("/Call/"))).toBe(false);
  });
});

describe("id handling", () => {
  it("keeps a 17-digit id exact through parsing", () => {
    const parsed = parseVobizJson('{"app_id":43919358318796814,"application":{"app_id":43919358318796815},"endpoint_id":12}');
    expect(parsed.app_id).toBe("43919358318796814");
    expect(parsed.application.app_id).toBe("43919358318796815");
    expect(parsed.endpoint_id).toBe("12");
  });

  it("splices an id in as an integer literal and refuses anything else", () => {
    expect(withIntegerField({}, "application", "43919358318796814")).toBe('{"application":43919358318796814}');
    expect(withIntegerField({ a: "b" }, "application", "7")).toBe('{"a":"b","application":7}');
    expect(() => withIntegerField({}, "application", "7,\"x\":1")).toThrow();
  });
});

describe("inbound routing by ParentAuthID", () => {
  it("rings the agents of the account the webhook names, even for a number not in the cached list", async () => {
    await start();
    await login("priya", ONE);
    const b = await login("arjun", TWO);
    const xml = await (await form("/answer", { Direction: "inbound", ParentAuthID: TWO.authId, From: "918888877777", To: "07000000004" })).text();
    expect(xml).toMatch(new RegExp(`<Dial callerId="\\+917000000004"[^>]*><User>sip:${b.sipUsername}@registrar\\.vobiz\\.ai</User></Dial>`));
  });

  it("falls back to the dialled number when ParentAuthID names nobody signed in", async () => {
    await start();
    const a = await login("priya", ONE);
    const xml = await (await form("/answer", { Direction: "inbound", ParentAuthID: "MA_TEST0009", From: "918888877777", To: "910000000001" })).text();
    expect(xml).toContain(`<User>sip:${a.sipUsername}@registrar.vobiz.ai</User>`);
  });
});

describe("Enable inbound calls reports where the number came from", () => {
  it("names the application the number was moved off", async () => {
    await start();
    const { auth } = await login("priya", ONE);
    const body = await (await post("/setup-inbound", {}, auth)).json();
    expect(body).toMatchObject({ number: ONE.numbers[0], appId: ONE.appId, previousAppId: "20000000000000001" });
  });
});

describe("SIP direct sign-in", () => {
  const sipLogin = (over = {}) => post("/login-sip", { agentId: "ravi", sipUser: "ravidesk", sipPassword: "typed-sip-password", callerId: "+910000000005", ...over });

  it("signs in with typed SIP credentials and caller ID, with no Vobiz API call", async () => {
    await start();
    const res = await sipLogin();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ mode: "sip", numbers: ["+910000000005"], selected: "+910000000005" });
    const agent = await (await get("/agent/ravi", { Authorization: `Bearer ${data.token}` })).json();
    expect(agent).toMatchObject({ sipUser: "ravidesk@registrar.vobiz.ai", sipPassword: "typed-sip-password" });
    expect(vobiz.requests).toHaveLength(0);
  });

  it("validates the caller ID and the username", async () => {
    await start();
    expect((await sipLogin({ callerId: "call me" })).status).toBe(400);
    expect((await sipLogin({ sipUser: "ravi_desk" })).status).toBe(400);
    expect((await sipLogin({ sipPassword: "" })).status).toBe(400);
  });

  it("dials out with <Dial><Number> as the typed caller ID", async () => {
    await start();
    await sipLogin();
    const xml = await (await form("/answer", { From: "sip:ravidesk@registrar.vobiz.ai", To: "919999988888" })).text();
    expect(xml).toMatch(/<Dial callerId="\+910000000005"[^>]*><Number>919999988888<\/Number><\/Dial>/);
    expect(vobiz.requests).toHaveLength(0);
  });

  it("takes the caller ID from X-VH-Caller-ID when the INVITE carries one", async () => {
    await start();
    await sipLogin();
    const xml = await (await form("/answer", { From: "sip:ravidesk@registrar.vobiz.ai", To: "919999988888", "X-VH-Caller-ID": "+910000000006" })).text();
    expect(xml).toContain('callerId="+910000000006"');
  });

  it("rings the SIP-direct agent for calls to their number", async () => {
    await start();
    await sipLogin();
    const xml = await (await form("/answer", { Direction: "inbound", From: "918888877777", To: "910000000005" })).text();
    expect(xml).toMatch(/<Dial callerId="\+910000000005"[^>]*><User>sip:ravidesk@registrar\.vobiz\.ai<\/User><\/Dial>/);
  });

  it("hides the account-API features", async () => {
    await start();
    const { token } = await (await sipLogin()).json();
    const auth = { Authorization: `Bearer ${token}` };
    for (const [m, p] of [["GET", "/recordings/ravi"], ["POST", "/setup-inbound"], ["POST", "/select-number"], ["GET", "/call-status/x"]]) {
      const res = m === "GET" ? await get(p, auth) : await post(p, { number: "+910000000005" }, auth);
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/Sign in with your Vobiz account/);
    }
    expect(await (await get("/session/ravi", auth)).json()).toMatchObject({ loggedIn: true, mode: "sip", from: "+910000000005" });
  });

  it("cannot take over an endpoint a Vobiz-account sign-in provisioned", async () => {
    await start();
    const a = await login("priya", ONE);
    const res = await sipLogin({ sipUser: a.sipUsername });
    expect(res.status).toBe(409);
    const xml = await (await form("/answer", { CallUUID: "z1", From: `sip:${a.sipUsername}@registrar.vobiz.ai`, To: "919999988888" })).text();
    expect(xml).toContain("<Conference");
  });
});

describe("helpers", () => {
  it("normalises caller IDs strictly", async () => {
    const { cleanPhone, vhParam } = require("../backend/server.js");
    expect(cleanPhone("07000000004")).toBe("+917000000004");
    expect(cleanPhone("910000000001")).toBe("+910000000001");
    expect(cleanPhone("+1 555 0100 123")).toBe("+15550100123");
    expect(cleanPhone("12")).toBe("");
    expect(vhParam({ "sipheader_x-vh-caller-id": "+910000000001" }, "X-VH-Caller-ID")).toBe("+910000000001");
  });
});
