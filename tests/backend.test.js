// @vitest-environment node
/**
 * The calling backend, driven over real HTTP.
 *
 * The server under test is the one that ships (backend/server.js). Only its
 * outbound calls to Vobiz are faked, through the fetchImpl it accepts, so each
 * test can see exactly what the backend asked Vobiz for — and, for the
 * security cases, that it asked for nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createApp, readConfig, originAllowed } = require("../backend/server.js");

const AUTH_ID = "MA_XXXXXXXX";
const AUTH_TOKEN = "test-token-not-real";
const DID = "+919876543210";
const PUBLIC_BASE = "https://calling.example.com";

function config(overrides = {}) {
  return readConfig({
    VOBIZ_AUTH_ID: AUTH_ID,
    VOBIZ_AUTH_TOKEN: AUTH_TOKEN,
    VOBIZ_FROM_NUMBER: DID,
    VOBIZ_SIP_USER: "agentone",
    VOBIZ_SIP_PASSWORD: "sip-secret-not-real",
    PUBLIC_BASE,
    SIGNING_SECRET: "test-signing-secret",
    ...overrides,
  });
}

/** A fake Vobiz API: records every request and answers by URL pattern. */
function fakeVobiz(extra = {}) {
  const requests = [];
  const impl = async (url, opts = {}) => {
    requests.push({ url: String(url), method: opts.method || "GET", headers: opts.headers || {}, body: opts.body });
    const u = String(url);
    for (const [pattern, handler] of Object.entries(extra)) {
      if (u.includes(pattern)) return handler(u, opts);
    }
    if (u.includes("/numbers?")) return json(200, { items: [{ e164: DID }, { e164: "+919876543211" }] });
    if (u.includes("/Call/") && opts.method === "POST") return json(201, { request_uuid: "req-1" });
    if (u.includes("/Call/") && opts.method === "DELETE") return json(204, {});
    return json(404, {});
  };
  impl.requests = requests;
  return impl;
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

let server;
let base;
let vobiz;
const logs = [];

async function start(cfg = config(), extra = {}) {
  vobiz = fakeVobiz(extra);
  server = createApp(cfg, { fetchImpl: vobiz, log: line => logs.push(line) });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
}

afterEach(async () => {
  logs.length = 0;
  if (server) await new Promise(r => server.close(r));
  server = null;
});

const post = (path, body, headers = {}) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

const form = (path, params, headers = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(params).toString(),
  });

async function login(agentId = "priya") {
  const res = await post("/login", { agentId, authId: AUTH_ID, authToken: AUTH_TOKEN });
  expect(res.status).toBe(200);
  const data = await res.json();
  return { token: data.token, data, auth: { Authorization: `Bearer ${data.token}` } };
}

describe("the SIP password", () => {
  beforeEach(() => start());

  it("is not served to an anonymous caller", async () => {
    const res = await fetch(`${base}/agent/anyone`);
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("sip-secret");
  });

  it("is served to the agent who signed in", async () => {
    const { auth } = await login("priya");
    const res = await fetch(`${base}/agent/priya`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sipUser).toBe("agentone@registrar.vobiz.ai");
    expect(body.sipPassword).toBe("sip-secret-not-real");
  });

  it("is not served for a different identity on the same token", async () => {
    const { auth } = await login("priya");
    const res = await fetch(`${base}/agent/someone-else`, { headers: auth });
    expect(res.status).toBe(403);
  });

  it("is not served for a made-up token", async () => {
    const res = await fetch(`${base}/agent/priya`, { headers: { Authorization: `Bearer ${"0".repeat(64)}` } });
    expect(res.status).toBe(401);
  });
});

describe("sign-in", () => {
  beforeEach(() => start());

  it("refuses a wrong Auth Token without asking Vobiz anything", async () => {
    const res = await post("/login", { agentId: "priya", authId: AUTH_ID, authToken: "wrong" });
    expect(res.status).toBe(401);
    expect(vobiz.requests).toHaveLength(0);
  });

  it("refuses a different account's Auth ID", async () => {
    const res = await post("/login", { agentId: "priya", authId: "MA_OTHER000", authToken: AUTH_TOKEN });
    expect(res.status).toBe(401);
  });

  it("returns a token and the account's numbers", async () => {
    const { data } = await login();
    expect(data.token).toMatch(/^[0-9a-f]{64}$/);
    expect(data.numbers).toEqual([DID, "+919876543211"]);
    expect(data.selected).toBe(DID);
  });

  it("reports no session without the token, even for a signed-in identity", async () => {
    await login("priya");
    const res = await fetch(`${base}/session/priya`);
    expect(await res.json()).toEqual({ loggedIn: false });
  });

  it("will not set a caller ID the account does not own", async () => {
    const { auth } = await login();
    const res = await post("/select-number", { number: "+15550001111" }, auth);
    expect(res.status).toBe(400);
  });

  it("keeps the Auth Token out of the log", async () => {
    await login();
    await post("/login", { agentId: "x", authId: AUTH_ID, authToken: "wrong" });
    expect(logs.join("\n")).not.toContain(AUTH_TOKEN);
  });
});

describe("agents file", () => {
  it("refuses an identity it does not list", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agents-")), "agents.json");
    fs.writeFileSync(file, JSON.stringify({ priya: { displayName: "Priya", sipUser: "priyaep", sipPassword: "p" } }));
    await start(config({ AGENTS_FILE: file }));
    const ok = await post("/login", { agentId: "priya", authId: AUTH_ID, authToken: AUTH_TOKEN });
    expect(ok.status).toBe(200);
    const no = await post("/login", { agentId: "mallory", authId: AUTH_ID, authToken: AUTH_TOKEN });
    expect(no.status).toBe(403);
  });
});

describe("CORS", () => {
  beforeEach(() => start());

  it("never answers with a wildcard or an arbitrary origin", async () => {
    const res = await fetch(`${base}/health`, { headers: { Origin: "https://evil.example" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("does not treat a look-alike domain as Freshdesk", () => {
    expect(originAllowed("https://acme.freshdesk.com.evil.example", [])).toBe(false);
    expect(originAllowed("https://evilfreshdesk.com", [])).toBe(false);
    expect(originAllowed("null", [])).toBe(false);
  });

  it("allows a Freshdesk account and the FDK dev server", async () => {
    for (const origin of ["https://acme.freshdesk.com", "http://localhost:10001"]) {
      const res = await fetch(`${base}/health`, { headers: { Origin: origin } });
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
  const MEDIA = "https://media.vobiz.ai/api/v1/Account/MA_XXXXXXXX/Recording/rec1.mp3";

  function recordingApi(recordingUrl = MEDIA) {
    return {
      "/Recording/?limit": () => json(200, { objects: [{ recording_id: "rec1", add_time: "2026-10-01 10:00:00", rounded_recording_duration: 12 }] }),
      "/Recording/rec1/": () => json(200, { recording_url: recordingUrl }),
      "media.vobiz.ai": () => new Response(Buffer.from("ID3audio"), { status: 200, headers: { "content-type": "audio/mpeg" } }),
    };
  }

  it("is not an open proxy", async () => {
    await start();
    // Unknown to this server, so it is refused — 401 without a session, 404 with one.
    const res = await fetch(`${base}/recording-file?url=https://example.com/`);
    expect([401, 404]).toContain(res.status);
    const { auth } = await login();
    expect((await fetch(`${base}/recording-file?url=https://example.com/`, { headers: auth })).status).toBe(404);
    expect(vobiz.requests.some(r => r.url.includes("example.com"))).toBe(false);
  });

  it("refuses playback without a signature", async () => {
    await start(config(), recordingApi());
    const res = await fetch(`${base}/recording-audio/priya/rec1`);
    expect(res.status).toBe(403);
    expect(vobiz.requests).toHaveLength(0);
  });

  it("plays a signed link, fetching the audio server-side", async () => {
    await start(config(), recordingApi());
    const { auth } = await login();
    const list = await (await fetch(`${base}/recordings/priya?limit=5`, { headers: auth })).json();
    const link = list.objects[0].playUrl;
    expect(link).toMatch(/^\/recording-audio\/priya\/rec1\?exp=\d+&sig=[0-9a-f]{64}$/);
    // The link carries no session token and no account credential.
    expect(link).not.toContain(AUTH_TOKEN);

    const res = await fetch(`${base}${link}`); // no Authorization header, like <audio>
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(await res.text()).toBe("ID3audio");
  });

  it("rejects a tampered or re-targeted signature", async () => {
    await start(config(), recordingApi());
    const { auth } = await login();
    const list = await (await fetch(`${base}/recordings/priya`, { headers: auth })).json();
    const link = list.objects[0].playUrl;
    expect((await fetch(`${base}${link.replace("rec1", "rec2")}`)).status).toBe(403);
    expect((await fetch(`${base}${link.replace("/priya/", "/other/")}`)).status).toBe(403);
  });

  it("rejects an expired link", async () => {
    await start(config({ RECORDING_URL_TTL_SECONDS: "-10" }), recordingApi());
    const { auth } = await login();
    const list = await (await fetch(`${base}/recordings/priya`, { headers: auth })).json();
    expect((await fetch(`${base}${list.objects[0].playUrl}`)).status).toBe(403);
  });

  it("never sends the account credentials off the Vobiz media hosts", async () => {
    await start(config(), recordingApi("https://attacker.example/steal.mp3"));
    const { auth } = await login();
    const list = await (await fetch(`${base}/recordings/priya`, { headers: auth })).json();
    const res = await fetch(`${base}${list.objects[0].playUrl}`);
    expect(res.status).toBe(502);
    expect(vobiz.requests.some(r => r.url.includes("attacker.example"))).toBe(false);
  });

  it("drops the credentials when Vobiz redirects to object storage", async () => {
    const api = recordingApi();
    api["media.vobiz.ai"] = () => new Response(null, { status: 302, headers: { location: "https://bucket.s3.ap-south-1.amazonaws.com/rec1.mp3?X-Amz-Signature=abc" } });
    api["amazonaws.com"] = () => new Response(Buffer.from("s3audio"), { status: 200, headers: { "content-type": "audio/mpeg" } });
    await start(config(), api);
    const { auth } = await login();
    const list = await (await fetch(`${base}/recordings/priya`, { headers: auth })).json();
    const res = await fetch(`${base}${list.objects[0].playUrl}`);
    expect(await res.text()).toBe("s3audio");
    const s3 = vobiz.requests.find(r => r.url.includes("amazonaws.com"));
    expect(s3.headers["X-Auth-Token"]).toBeUndefined();
  });
});

describe("no file is served from disk", () => {
  beforeEach(() => start());

  it("does not resolve ../ to the .env file", async () => {
    for (const p of ["/../backend/.env", "/../.env", "/%2e%2e/backend/.env", "/backend/.env"]) {
      const res = await new Promise((resolve, reject) => {
        const req = http.request(`${base}${p}`, { method: "GET", path: p }, r => {
          let b = ""; r.on("data", c => (b += c)); r.on("end", () => resolve({ status: r.statusCode, body: b }));
        });
        req.on("error", reject);
        req.end();
      });
      expect([401, 404]).toContain(res.status);
      expect(res.body).not.toMatch(/VOBIZ_AUTH_TOKEN/);
    }
  });
});

describe("the answer webhook", () => {
  it("bridges the browser out through a conference by default", async () => {
    await start();
    const { auth } = await login();
    await post("/select-number", { number: "+919876543211" }, auth);

    const res = await form("/answer", { CallUUID: "abc-123", From: "sip:agentone@registrar.vobiz.ai", To: "919999988888", Direction: "inbound" });
    const xml = await res.text();
    expect(res.headers.get("content-type")).toBe("text/xml");
    expect(xml).toContain("<Conference");
    expect(xml).toContain('stayAlone="true"');
    expect(xml).toContain(">fdabc123</Conference>");

    // The customer is dialled into that room over the REST API, from the
    // number the agent picked.
    const call = vobiz.requests.find(r => r.url.endsWith("/Call/") && r.method === "POST");
    const body = JSON.parse(call.body);
    expect(body).toMatchObject({ from: "919876543211", to: "919999988888" });
    expect(body.answer_url).toBe(`${PUBLIC_BASE}/outbound-join?room=fdabc123`);
  });

  it("joins the customer to the agent's room when they answer", async () => {
    await start();
    await form("/answer", { CallUUID: "abc-123", From: "sip:agentone@registrar.vobiz.ai", To: "919999988888" });
    const xml = await (await form("/outbound-join?room=fdabc123", { CallUUID: "cust-1" })).text();
    expect(xml).toContain('<Conference startConferenceOnEnter="true"');
    expect(xml).toContain(">fdabc123</Conference>");
  });

  it("releases the agent when the customer never answers", async () => {
    await start();
    await form("/answer", { CallUUID: "abc-123", From: "sip:agentone@registrar.vobiz.ai", To: "919999988888" });
    await form("/outbound-hangup?room=fdabc123", { CallUUID: "cust-1", HangupCause: "NO_ANSWER" });
    const del = vobiz.requests.find(r => r.method === "DELETE");
    expect(del.url).toContain("/Call/abc-123/");
  });

  it("does not release the agent after a call that connected", async () => {
    await start();
    await form("/answer", { CallUUID: "abc-123", From: "sip:agentone@registrar.vobiz.ai", To: "919999988888" });
    await form("/outbound-join?room=fdabc123", { CallUUID: "cust-1" });
    await form("/outbound-hangup?room=fdabc123", { CallUUID: "cust-1" });
    expect(vobiz.requests.some(r => r.method === "DELETE")).toBe(false);
  });

  it("uses <Dial><Number> with the agent's caller ID when OUTBOUND_MODE=dial", async () => {
    await start(config({ OUTBOUND_MODE: "dial" }));
    const xml = await (await form("/answer", { From: "sip:agentone@registrar.vobiz.ai", To: "+919999988888" })).text();
    expect(xml).toMatch(/<Dial callerId="\+919876543210"[^>]*action="https:\/\/calling\.example\.com\/dial-status"[^>]*redirect="false"><Number>919999988888<\/Number><\/Dial>/);
    expect(vobiz.requests).toHaveLength(0);
  });

  it("rings the browser on an inbound call, with the dialled DID as caller ID", async () => {
    await start();
    const xml = await (await form("/answer", { From: "918888877777", To: "919876543210" })).text();
    expect(xml).toMatch(/<Dial callerId="\+919876543210"[^>]*><User>sip:agentone@registrar\.vobiz\.ai<\/User><\/Dial>/);
  });

  it("answers a hangup notification with nothing", async () => {
    await start();
    const xml = await (await form("/answer", { Event: "Hangup", From: "sip:agentone@registrar.vobiz.ai", To: "919999988888" })).text();
    expect(xml).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>');
    expect(vobiz.requests).toHaveLength(0);
  });

  it("refuses to dial something that is not a phone number", async () => {
    await start(config({ OUTBOUND_MODE: "dial" }));
    const xml = await (await form("/answer", { From: "sip:agentone@registrar.vobiz.ai", To: "sip:evil@elsewhere" })).text();
    expect(xml).toContain("<Hangup/>");
    expect(xml).not.toContain("<Dial");
  });

  it("records the session when RECORD_CALLS is on, before the bridge", async () => {
    await start(config({ RECORD_CALLS: "1", OUTBOUND_MODE: "dial" }));
    const xml = await (await form("/answer", { From: "sip:agentone@registrar.vobiz.ai", To: "919999988888" })).text();
    expect(xml.indexOf("<Record")).toBeGreaterThan(-1);
    expect(xml.indexOf("<Record")).toBeLessThan(xml.indexOf("<Dial"));
  });
});

describe("webhook signatures", () => {
  const sign = (path, nonce) =>
    crypto.createHmac("sha256", AUTH_TOKEN).update(`${PUBLIC_BASE}${path}.${nonce}`).digest("base64");

  it("accepts a valid V3 signature when required", async () => {
    await start(config({ VOBIZ_WEBHOOK_SIGNATURE: "require" }));
    const res = await form("/answer", { From: "918888877777", To: "919876543210" }, {
      "X-Vobiz-Signature-V3": sign("/answer", "12345678901234567890"),
      "X-Vobiz-Signature-V3-Nonce": "12345678901234567890",
    });
    expect(res.status).toBe(200);
  });

  it("ignores the query string, as Vobiz does when signing", async () => {
    await start(config({ VOBIZ_WEBHOOK_SIGNATURE: "require" }));
    await form("/answer", { CallUUID: "abc", From: "sip:agentone@registrar.vobiz.ai", To: "919999988888" }, {
      "X-Vobiz-Signature-V3": sign("/answer", "1"), "X-Vobiz-Signature-V3-Nonce": "1",
    });
    const res = await form("/outbound-join?room=fdabc", {}, {
      "X-Vobiz-Signature-V3": sign("/outbound-join", "2"), "X-Vobiz-Signature-V3-Nonce": "2",
    });
    expect(res.status).toBe(200);
  });

  it("rejects a forged or missing signature when required", async () => {
    await start(config({ VOBIZ_WEBHOOK_SIGNATURE: "require" }));
    const forged = await form("/answer", { From: "918888877777", To: "919876543210" }, {
      "X-Vobiz-Signature-V3": "AAAA", "X-Vobiz-Signature-V3-Nonce": "1",
    });
    expect(forged.status).toBe(403);
    expect((await form("/answer", { From: "918888877777", To: "919876543210" })).status).toBe(403);
  });
});

describe("routes that change the account", () => {
  beforeEach(() => start(config(), {
    "/Application/?limit": () => json(200, { objects: [] }),
    "/Application/": () => json(201, { app_id: "111", message: "created" }),
    "/application": () => json(200, { message: "Number attached to application" }),
    "/Endpoint/?limit": () => json(200, { objects: [{ endpoint_id: "222", username: "agentone" }] }),
    "/Endpoint/222/": () => new Response(null, { status: 202 }),
  }));

  it("need a session", async () => {
    expect((await post("/setup-inbound", { agentId: "priya" })).status).toBe(401);
    expect((await post("/select-number", { agentId: "priya", number: DID })).status).toBe(401);
    expect(vobiz.requests).toHaveLength(0);
  });

  it("points the number and the endpoint at this backend's answer URL", async () => {
    const { auth } = await login();
    const res = await post("/setup-inbound", {}, auth);
    expect(await res.json()).toMatchObject({ number: DID, appId: "111", endpointBound: true });
    const created = vobiz.requests.find(r => r.url.endsWith("/Application/") && r.method === "POST");
    expect(JSON.parse(created.body).answer_url).toBe(`${PUBLIC_BASE}/answer`);
    expect(vobiz.requests.some(r => r.url.endsWith("/numbers/%2B919876543210/application"))).toBe(true);
  });

  it("no longer originates calls from /start-call", async () => {
    const { auth } = await login();
    expect((await post("/start-call", { to: "919999988888" }, auth)).status).toBe(410);
    expect(vobiz.requests.some(r => r.url.endsWith("/Call/"))).toBe(false);
  });
});
