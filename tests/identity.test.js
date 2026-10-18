import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { boot, flush, routes, FakeSession, AGENT_OK, SETTINGS, AGENT } from "./harness.js";

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

const SIGNED_OUT = { ok: false, status: 401, body: { error: "Sign in first" } };
const LOGIN_OK = {
  body: {
    token: "tok123",
    mode: "account",
    numbers: ["+910000000001", "+910000000002"],
    numberDetails: [
      { e164: "+910000000001", applicationId: "20000000000000001", applicationName: "Old IVR" },
      { e164: "+910000000002", applicationId: "43919358318796814", applicationName: "Freshdesk-Calling", thisPanel: true },
    ],
    selected: "+910000000001",
  },
};

/** A backend that serves the SIP identity only after /login, and forgets it on /logout. */
function backend(extra = {}) {
  let signedIn = false;
  return routes({
    "/agent/": () => (signedIn ? AGENT_OK : SIGNED_OUT),
    "/session/": { body: { loggedIn: false } },
    "/login": () => { signedIn = true; return LOGIN_OK; },
    "/logout": () => { signedIn = false; return { body: { ok: true } }; },
    "/recordings/": { body: { objects: [] } },
    ...extra,
  });
}

async function signIn(t) {
  t.el("vobiz-auth-id").value = "MA_TEST0001";
  t.el("vobiz-auth-token").value = "token";
  t.el("vobiz-login-btn").click();
  await flush(16);
}

describe("the agent identity comes from the Freshdesk login", () => {
  it("is fd<user id>, sent with the agent's name on sign-in", async () => {
    const fetch = backend();
    const t = await boot({ iparams: SETTINGS, fetch });
    expect(t.client.data.get).toHaveBeenCalledWith("loggedInUser");
    expect(String(fetch.mock.calls[0][0])).toBe(`https://backend.example.com/agent/${AGENT}`);
    await signIn(t);
    const call = fetch.mock.calls.find(c => String(c[0]).endsWith("/login"));
    expect(JSON.parse(call[1].body)).toEqual({ agentId: AGENT, displayName: "Priya", authId: "MA_TEST0001", authToken: "token" });
    expect(t.el("vobiz-auth-token").value).toBe("");
  });

  it("accepts the user object unwrapped, and falls back to the email for a name", async () => {
    const fetch = backend();
    const t = await boot({ iparams: SETTINGS, fetch, user: { id: 77, email: "ravi@example.com" } });
    await signIn(t);
    const call = fetch.mock.calls.find(c => String(c[0]).endsWith("/login"));
    expect(JSON.parse(call[1].body)).toMatchObject({ agentId: "fd77", displayName: "ravi@example.com" });
  });

  it("sends no name when Freshdesk gives none", async () => {
    const fetch = backend();
    const t = await boot({ iparams: SETTINGS, fetch, user: { loggedInUser: { id: 5 } } });
    await signIn(t);
    const call = fetch.mock.calls.find(c => String(c[0]).endsWith("/login"));
    expect(JSON.parse(call[1].body)).toMatchObject({ agentId: "fd5", displayName: null });
  });

  it("stops, and says why, when the logged-in agent cannot be read", async () => {
    const fetch = backend();
    const t = await boot({ iparams: SETTINGS, fetch, user: new Error("not available here") });
    expect(t.text("status-message")).toMatch(/could not identify the signed-in freshdesk agent/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops when the user has no id", async () => {
    const fetch = backend();
    const t = await boot({ iparams: SETTINGS, fetch, user: { loggedInUser: {} } });
    expect(t.text("status-message")).toMatch(/could not identify/i);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("sign out", () => {
  it("is offered only once signed in", async () => {
    const t = await boot({ iparams: SETTINGS, fetch: backend() });
    expect(t.el("signout-btn").hidden).toBe(true);
    await signIn(t);
    expect(t.el("signout-btn").hidden).toBe(false);
  });

  it("is offered for a restored session", async () => {
    const t = await boot({
      iparams: SETTINGS,
      fetch: routes({ "/agent/": AGENT_OK, "/session/": { body: { loggedIn: true, numbers: ["+910000000001"], from: "+910000000001", authId: "MA_TEST0001" } } }),
    });
    await flush();
    expect(t.el("signout-btn").hidden).toBe(false);
  });

  it("calls /logout with the token, unregisters, and returns to Signed out", async () => {
    const fetch = backend();
    const t = await boot({ iparams: SETTINGS, fetch });
    await signIn(t);
    const ua = t.ua;
    ua.emit("registered");
    expect(t.isDisabled("dialbtn")).toBe(false);

    t.el("signout-btn").click();
    await flush(16);

    const call = fetch.mock.calls.find(c => String(c[0]).endsWith("/logout"));
    expect(call[1].method).toBe("POST");
    expect(call[1].headers.Authorization).toBe("Bearer tok123");
    expect(ua.stopped).toBe(true);
    expect(t.text("status")).toBe("Signed out");
    expect(t.text("vobiz-login-status")).toBe("Signed out.");
    expect(t.isDisabled("dialbtn")).toBe(true);
    expect(t.el("signout-btn").hidden).toBe(true);
    expect(t.el("vobiz-number-select").hidden).toBe(true);
    expect(t.el("inbound-current-app").hidden).toBe(true);

    // The stopped UA's own unregistered/disconnected events must not repaint the badge.
    ua.emit("unregistered");
    ua.emit("disconnected");
    ua.emit("registered");
    expect(t.text("status")).toBe("Signed out");

    // The token is gone: later requests carry none.
    t.el("refresh-history-btn").click();
    await flush();
    const after = fetch.mock.calls.slice(fetch.mock.calls.indexOf(call) + 1);
    expect(after.every(c => !(c[1] && c[1].headers && c[1].headers.Authorization))).toBe(true);
  });

  it("ends a call in progress", async () => {
    const t = await boot({ iparams: SETTINGS, fetch: backend() });
    await signIn(t);
    t.ua.emit("registered");
    const session = new FakeSession();
    t.ua.emit("newRTCSession", { originator: "remote", session });
    t.el("signout-btn").click();
    await flush(16);
    expect(session.terminated).toBe(true);
    expect(t.el("hangupbtn").hidden).toBe(true);
  });

  it("still signs out locally when the backend cannot be reached", async () => {
    const t = await boot({ iparams: SETTINGS, fetch: backend({ "/logout": new Error("ECONNREFUSED") }) });
    await signIn(t);
    t.ua.stop = () => { throw new Error("socket already closed"); };
    t.el("signout-btn").click();
    await flush(16);
    expect(t.text("status")).toBe("Signed out");
  });

  it("can sign back in afterwards", async () => {
    const t = await boot({ iparams: SETTINGS, fetch: backend() });
    await signIn(t);
    t.el("signout-btn").click();
    await flush(16);
    await signIn(t);
    t.ua.emit("registered");
    expect(t.text("status")).toBe("Ready");
  });

  it("skips /logout with no session and only resets the panel", async () => {
    const fetch = backend();
    const t = await boot({ iparams: SETTINGS, fetch });
    t.el("signout-btn").click();
    await flush(16);
    expect(fetch.mock.calls.some(c => String(c[0]).endsWith("/logout"))).toBe(false);
    expect(t.text("status")).toBe("Signed out");
  });

  it("ignores events from a UA replaced by a new sign-in", async () => {
    const t = await boot({ iparams: SETTINGS, fetch: backend() });
    await signIn(t);
    const old = t.ua;
    t.el("vobiz-auth-token").value = "token";
    t.el("vobiz-login-btn").click();
    await flush(16);
    t.ua.emit("registered");
    old.emit("registrationFailed", { cause: "stale" });
    const session = new FakeSession();
    old.emit("newRTCSession", { originator: "remote", session });
    expect(t.text("status")).toBe("Ready");
    expect(session.answered).toBe(false);
  });
});

describe("the inbound hint names the application", () => {
  it("by name and id, or says the number already rings this panel", async () => {
    const t = await boot({ iparams: SETTINGS, fetch: backend() });
    await signIn(t);
    expect(t.text("inbound-current-app")).toBe('+910000000001 is attached to application "Old IVR" (20000000000000001) now; enabling moves it to this panel\'s.');

    const select = t.el("vobiz-number-select");
    select.value = "+910000000002";
    const fetchSelect = backend({ "/select-number": { body: { selected: "+910000000002" } } });
    globalThis.fetch = fetchSelect;
    select.dispatchEvent(new window.Event("change"));
    await flush();
    expect(t.text("inbound-current-app")).toBe("+910000000002 already rings this panel.");
  });

  it("names the application Enable inbound calls moved the number off", async () => {
    const t = await boot({
      iparams: SETTINGS,
      fetch: backend({ "/setup-inbound": { body: { number: "+910000000001", appId: "43919358318796814", previousAppId: "20000000000000001", previousAppName: "Old IVR" } } }),
    });
    await signIn(t);
    t.el("setup-inbound-btn").click();
    await flush();
    expect(t.text("inbound-setup-status")).toMatch(/moved off application "Old IVR" \(20000000000000001\)/);
    expect(t.text("inbound-current-app")).toMatch(/already rings this panel/);
  });
});

describe("an outbound call shows Ringing until the customer joins", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function dial(callStatus, { mode = "account" } = {}) {
    const fetch = routes({
      "/agent/": AGENT_OK,
      "/session/": { body: { loggedIn: true, mode, numbers: ["+910000000001"], from: "+910000000001", authId: "MA_TEST0001" } },
      "/recordings/": { body: { objects: [] } },
      "/call-status/": callStatus,
    });
    const t = await boot({ iparams: SETTINGS, fetch });
    await vi.advanceTimersByTimeAsync(0);
    t.ua.emit("registered");
    t.el("dialnumber").value = "+910000000009";
    t.el("dialbtn").click();
    await vi.advanceTimersByTimeAsync(0);
    const { session, options } = t.ua.calls.at(-1);
    const ref = options.extraHeaders.find(h => h.startsWith("X-VH-Call-Ref: ")).slice(15);
    return { t, fetch, session, ref };
  }

  const statusCalls = fetch => fetch.mock.calls.filter(c => String(c[0]).includes("/call-status/"));

  it("polls /call-status with the call's reference: Ringing, then On a call", async () => {
    let state = "ringing";
    const { t, fetch, session, ref } = await dial(() => ({ body: { active: true, state } }));
    session.emit("confirmed");
    await vi.advanceTimersByTimeAsync(0);
    expect(String(statusCalls(fetch)[0][0])).toBe(`https://backend.example.com/call-status/${ref}`);
    expect(t.text("status")).toBe("Ringing");
    expect(t.text("callnum")).toMatch(/ringing \+910000000009/i);

    await vi.advanceTimersByTimeAsync(1500);
    expect(statusCalls(fetch)).toHaveLength(2);
    expect(t.text("status")).toBe("Ringing");

    state = "connected";
    await vi.advanceTimersByTimeAsync(1500);
    expect(t.text("status")).toBe("On a call");
    expect(t.text("callnum")).toMatch(/on a call with \+910000000009/i);
    await vi.advanceTimersByTimeAsync(6000);
    expect(statusCalls(fetch)).toHaveLength(3);
  });

  it("stops polling when the call ends while still ringing", async () => {
    const { fetch, session } = await dial({ body: { active: true, state: "ringing" } });
    session.emit("confirmed");
    await vi.advanceTimersByTimeAsync(0);
    session.emit("ended");
    await vi.advanceTimersByTimeAsync(10000);
    expect(statusCalls(fetch)).toHaveLength(1);
  });

  it("stops polling when the call fails", async () => {
    const { fetch, session } = await dial({ body: { active: true, state: "ringing" } });
    session.emit("confirmed");
    await vi.advanceTimersByTimeAsync(0);
    session.emit("failed", { cause: "Canceled" });
    await vi.advanceTimersByTimeAsync(10000);
    expect(statusCalls(fetch)).toHaveLength(1);
  });

  it("falls back to On a call when the backend does not track it", async () => {
    const { t, session } = await dial({ body: { active: true } });
    session.emit("confirmed");
    await vi.advanceTimersByTimeAsync(0);
    expect(t.text("status")).toBe("On a call");
  });

  it("falls back to On a call when the status cannot be read", async () => {
    const { t, session } = await dial(new Error("ECONNREFUSED"));
    session.emit("confirmed");
    await vi.advanceTimersByTimeAsync(0);
    expect(t.text("status")).toBe("On a call");
  });

  it("falls back to On a call on an error response", async () => {
    const { t, session } = await dial({ ok: false, status: 401, body: { error: "Sign in first" } });
    session.emit("confirmed");
    await vi.advanceTimersByTimeAsync(0);
    expect(t.text("status")).toBe("On a call");
  });

  it("does not repaint a call that ended while the status was in flight", async () => {
    let release;
    const { t, session } = await dial(() => new Promise(r => { release = r; }).then(() => ({ body: { state: "connected" } })));
    session.emit("confirmed");
    session.emit("ended");
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.text("status")).toBe("Ready");
  });

  it("shows On a call straight away over SIP direct, which has no status route", async () => {
    const { t, fetch, session } = await dial({ body: { state: "ringing" } }, { mode: "sip" });
    session.emit("confirmed");
    await vi.advanceTimersByTimeAsync(0);
    expect(t.text("status")).toBe("On a call");
    expect(statusCalls(fetch)).toHaveLength(0);
  });
});
