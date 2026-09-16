import { describe, it, expect, vi, beforeEach } from "vitest";
import { boot, flush, routes, FakeSession, AGENT_OK, SETTINGS } from "./harness.js";

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("configuration", () => {
  it("refuses to start without both required settings", async () => {
    const t = await boot({ iparams: { backend_url: "https://backend.example.com" } });
    expect(t.text("status-message")).toMatch(/not configured/i);
  });

  it("rejects a backend URL with no scheme", async () => {
    // A bare hostname resolves against the Freshdesk app origin and 404s
    // silently, which reads as "the backend is down" rather than a typo.
    const t = await boot({ iparams: { backend_url: "backend.example.com", agent_id: "priya" } });
    expect(t.text("status-message")).toMatch(/must start with https/i);
  });

  it("rejects a plaintext http backend URL", async () => {
    const t = await boot({ iparams: { backend_url: "http://backend.example.com", agent_id: "priya" } });
    expect(t.text("status-message")).toMatch(/must start with https/i);
  });

  it("accepts http://localhost so the mock backend is usable", async () => {
    // Browsers already treat localhost as a secure context, and mock-backend/
    // serves plain HTTP. Without this the panel bails out of init() before the
    // Log in button is wired up, so the button silently does nothing.
    const fetch = routes({ "/agent/": AGENT_OK });
    const t = await boot({ iparams: { backend_url: "http://localhost:8092", agent_id: "priya" }, fetch });
    expect(t.text("status-message")).not.toMatch(/must start with https/i);
    expect(String(fetch.mock.calls[0][0])).toBe("http://localhost:8092/agent/priya");
  });

  it("accepts http://127.0.0.1 as well", async () => {
    const fetch = routes({ "/agent/": AGENT_OK });
    const t = await boot({ iparams: { backend_url: "http://127.0.0.1:8092", agent_id: "priya" }, fetch });
    expect(t.text("status-message")).not.toMatch(/must start with https/i);
  });

  it("still rejects a non-local http host that merely contains localhost", async () => {
    const t = await boot({ iparams: { backend_url: "http://localhost.evil.example", agent_id: "priya" } });
    expect(t.text("status-message")).toMatch(/must start with https/i);
  });

  it("strips trailing slashes from the backend URL", async () => {
    const fetch = routes({ "/agent/": AGENT_OK });
    await boot({ iparams: { ...SETTINGS, backend_url: "https://backend.example.com///" }, fetch });
    expect(String(fetch.mock.calls[0][0])).toBe("https://backend.example.com/agent/priya");
  });

  it("uses the configured registrar when one is given", async () => {
    const t = await boot({
      iparams: { ...SETTINGS, registrar_url: "wss://registrar.example.test:7443/" },
      fetch: routes({ "/agent/": AGENT_OK }),
    });
    expect(t.JsSIP.WebSocketInterface).toHaveBeenCalledWith("wss://registrar.example.test:7443/");
  });

  it("falls back to the default registrar when none is given", async () => {
    const t = await boot({ iparams: SETTINGS, fetch: routes({ "/agent/": AGENT_OK }) });
    expect(t.JsSIP.WebSocketInterface).toHaveBeenCalledWith("wss://registrar.vobiz.ai:5063/");
  });
});

describe("backend failures are reported, not swallowed", () => {
  it("reports an unreachable backend instead of hanging on Connecting", async () => {
    // Regression: an unguarded `await fetch` left this as an unhandled
    // rejection and the panel stuck on "Connecting…" forever.
    const t = await boot({ iparams: SETTINGS, fetch: routes({ "/agent/": new Error("ECONNREFUSED") }) });
    expect(t.text("status-message")).toMatch(/cannot reach the calling backend/i);
    expect(t.text("status-message")).not.toMatch(/connecting/i);
  });

  it("reports an unknown agent identity", async () => {
    const t = await boot({ iparams: SETTINGS, fetch: routes({ "/agent/": { ok: false, status: 404 } }) });
    expect(t.text("status-message")).toMatch(/could not load the identity/i);
  });
});

describe("status is a short state plus a separate message", () => {
  it("keeps the header badge short even when the message is a sentence", async () => {
    // Regression: the badge had white-space:nowrap and was fed 70-character
    // sentences, which overflowed the 300px panel.
    const t = await boot({ iparams: { backend_url: "backend.example.com", agent_id: "priya" } });
    expect(t.text("status")).toBe("Offline");
    expect(t.text("status").length).toBeLessThan(16);
    expect(t.text("status-message")).toMatch(/must start with https/i);
  });

  it("tones the badge by state", async () => {
    const t = await boot({ iparams: SETTINGS, fetch: routes({ "/agent/": AGENT_OK }) });
    t.ua.emit("registered");
    expect(t.el("status").className).toContain("is-ok");
    t.ua.emit("disconnected");
    expect(t.el("status").className).toContain("is-pending");
  });
});

describe("calling is gated on BOTH login and SIP registration", () => {
  const fetchOk = () => routes({ "/agent/": AGENT_OK, "/session/": { body: { loggedIn: false } } });

  it("starts disabled", async () => {
    const t = await boot({ iparams: SETTINGS, fetch: fetchOk() });
    expect(t.isDisabled("dialbtn")).toBe(true);
  });

  it("stays disabled when registered but not logged in", async () => {
    const t = await boot({ iparams: SETTINGS, fetch: fetchOk() });
    t.ua.emit("registered");
    expect(t.isDisabled("dialbtn")).toBe(true);
    expect(t.text("dial-hint")).toMatch(/log in/i);
  });

  it("stays disabled when logged in but NOT registered", async () => {
    // The regression this guards: with SIP down the agent could dial, the
    // customer answered, and heard silence — there was no registered
    // endpoint to bridge the audio into.
    const t = await boot({
      iparams: SETTINGS,
      fetch: routes({
        "/agent/": AGENT_OK,
        "/session/": { body: { loggedIn: true, numbers: ["+911140848108"], from: "+911140848108", authId: "MA_TEST" } },
        "/recordings/": { body: { objects: [] } },
      }),
    });
    await flush();
    expect(t.isDisabled("dialbtn")).toBe(true);
    expect(t.text("dial-hint")).toMatch(/not registered/i);
  });

  it("enables only once both are true", async () => {
    const t = await boot({
      iparams: SETTINGS,
      fetch: routes({
        "/agent/": AGENT_OK,
        "/session/": { body: { loggedIn: true, numbers: ["+911140848108"], from: "+911140848108", authId: "MA_TEST" } },
        "/recordings/": { body: { objects: [] } },
      }),
    });
    await flush();
    t.ua.emit("registered");
    expect(t.isDisabled("dialbtn")).toBe(false);
    expect(t.text("dial-hint")).toBe("");
  });

  it("disables again when the transport drops", async () => {
    const t = await boot({
      iparams: SETTINGS,
      fetch: routes({
        "/agent/": AGENT_OK,
        "/session/": { body: { loggedIn: true, numbers: ["+911140848108"], from: "+911140848108", authId: "MA_TEST" } },
        "/recordings/": { body: { objects: [] } },
      }),
    });
    await flush();
    t.ua.emit("registered");
    expect(t.isDisabled("dialbtn")).toBe(false);

    t.ua.emit("disconnected");
    expect(t.isDisabled("dialbtn")).toBe(true);
    expect(t.text("status-message")).toMatch(/disconnected/i);
  });

  it("reports a failed registration", async () => {
    const t = await boot({ iparams: SETTINGS, fetch: fetchOk() });
    t.ua.emit("registrationFailed", { cause: "401 Unauthorized" });
    expect(t.text("status-message")).toMatch(/registration failed.*401/i);
    expect(t.isDisabled("dialbtn")).toBe(true);
  });
});

describe("login", () => {
  it("reports a rejected login", async () => {
    const t = await boot({
      iparams: SETTINGS,
      fetch: routes({
        "/agent/": AGENT_OK,
        "/session/": { body: { loggedIn: false } },
        "/login": { ok: false, status: 401, body: { error: "Invalid Auth ID or Auth Token" } },
      }),
    });
    t.el("vobiz-auth-id").value = "MA_TEST";
    t.el("vobiz-auth-token").value = "wrong";
    t.el("vobiz-login-btn").click();
    await flush();
    expect(t.text("vobiz-login-status")).toMatch(/invalid auth id/i);
  });

  it("asks for both fields before calling the backend", async () => {
    const fetch = routes({ "/agent/": AGENT_OK, "/session/": { body: { loggedIn: false } } });
    const t = await boot({ iparams: SETTINGS, fetch });
    const before = fetch.mock.calls.length;
    t.el("vobiz-auth-id").value = "MA_TEST";
    t.el("vobiz-auth-token").value = "";
    t.el("vobiz-login-btn").click();
    await flush();
    expect(t.text("vobiz-login-status")).toMatch(/enter both/i);
    expect(fetch.mock.calls.length).toBe(before);
  });

  it("treats a successful login with no numbers as success, not failure", async () => {
    // Regression: `data.numbers.forEach` threw on undefined, and the catch
    // reported a TypeError as "Login failed" even though the backend had
    // accepted the credentials.
    const t = await boot({
      iparams: SETTINGS,
      fetch: routes({
        "/agent/": AGENT_OK,
        "/session/": { body: { loggedIn: false } },
        "/login": { body: { selected: null } },
      }),
    });
    t.el("vobiz-auth-id").value = "MA_TEST";
    t.el("vobiz-auth-token").value = "token";
    t.el("vobiz-login-btn").click();
    await flush();
    expect(t.text("vobiz-login-status")).toMatch(/no phone numbers yet/i);
    expect(t.text("vobiz-login-status")).not.toMatch(/failed/i);
  });

  it("lists the account's numbers", async () => {
    const t = await boot({
      iparams: SETTINGS,
      fetch: routes({
        "/agent/": AGENT_OK,
        "/session/": { body: { loggedIn: false } },
        "/login": { body: { numbers: ["+911140848108", "+911140848109"], selected: "+911140848108" } },
        "/recordings/": { body: { objects: [] } },
      }),
    });
    t.el("vobiz-auth-id").value = "MA_TEST";
    t.el("vobiz-auth-token").value = "token";
    t.el("vobiz-login-btn").click();
    await flush();
    const opts = [...t.el("vobiz-number-select").options].map(o => o.value);
    expect(opts).toEqual(["+911140848108", "+911140848109"]);
  });
});

describe("click-to-call", () => {
  it("subscribes to the Freshdesk dialer event", async () => {
    const t = await boot({ iparams: SETTINGS, fetch: routes({ "/agent/": AGENT_OK }) });
    expect(t.client.events.on).toHaveBeenCalledWith("cti.triggerDialer", expect.any(Function));
  });

  it("opens the panel and dials the clicked number", async () => {
    const fetch = routes({ "/agent/": AGENT_OK, "/session/": { body: { loggedIn: false } } });
    const t = await boot({ iparams: SETTINGS, fetch });
    t.ua.emit("registered");
    t.fire("cti.triggerDialer", { helper: { getData: () => ({ number: "+911140848108" }) } });
    await flush();

    expect(t.triggers).toContainEqual(["show", { id: "softphone" }]);
    // The browser is the A leg, so this is a SIP INVITE from here, not a
    // request asking the backend to originate the call.
    expect(t.ua.calls.at(-1).target).toBe("sip:+911140848108@registrar.vobiz.ai");
  });

  it("does nothing when the payload carries no number", async () => {
    const fetch = routes({ "/agent/": AGENT_OK, "/session/": { body: { loggedIn: false } } });
    const t = await boot({ iparams: SETTINGS, fetch });
    t.fire("cti.triggerDialer", { helper: { getData: () => ({}) } });
    await flush();
    expect(fetch.mock.calls.some(c => String(c[0]).includes("/start-call"))).toBe(false);
  });

  it("refuses to dial while SIP is not registered", async () => {
    // Dialling unregistered would send no INVITE at all and leave the agent
    // watching a "Calling…" label that never resolves.
    const t = await boot({
      iparams: SETTINGS,
      fetch: routes({ "/agent/": AGENT_OK, "/session/": { body: { loggedIn: false } } }),
    });
    t.fire("cti.triggerDialer", { helper: { getData: () => ({ number: "+911140848108" }) } });
    await flush();
    expect(t.ua.calls).toHaveLength(0);
    expect(t.text("callnum")).toMatch(/not registered yet/i);
  });

  it("surfaces a refused microphone instead of failing silently", async () => {
    const t = await boot({
      iparams: SETTINGS,
      fetch: routes({ "/agent/": AGENT_OK, "/session/": { body: { loggedIn: false } } }),
    });
    t.ua.emit("registered");
    t.ua.call = () => { const e = new Error("Permission denied"); e.name = "NotAllowedError"; throw e; };
    t.fire("cti.triggerDialer", { helper: { getData: () => ({ number: "+911140848108" }) } });
    await flush();
    expect(t.text("callnum")).toMatch(/microphone permission was refused/i);
  });
});

describe("an inbound leg", () => {
  async function ringIn() {
    const t = await boot({
      iparams: SETTINGS,
      fetch: routes({ "/agent/": AGENT_OK, "/session/": { body: { loggedIn: false } } }),
    });
    t.ua.emit("registered");
    const session = new FakeSession();
    t.ua.emit("newRTCSession", { originator: "remote", session });
    return { t, session };
  }

  it("is answered, and exposes a way to end it", async () => {
    const { t, session } = await ringIn();
    expect(session.answered).toBe(true);
    expect(t.el("hangupbtn").hidden).toBe(false);
  });

  it("hangs up when asked", async () => {
    // Regression: there was no hangup control at all, and .terminate() was
    // never called anywhere in the app.
    const { t, session } = await ringIn();
    t.el("hangupbtn").click();
    expect(session.terminated).toBe(true);
  });

  it("hides the hangup control once the call ends", async () => {
    const { t, session } = await ringIn();
    session.emit("ended");
    expect(t.el("hangupbtn").hidden).toBe(true);
  });

  it("binds audio through the peerconnection event, not session.connection", async () => {
    // session.connection is null until the call is answered; dereferencing it
    // inside the newRTCSession handler threw and aborted before .answer().
    const { session } = await ringIn();
    expect(session.handlers.peerconnection).toBeTruthy();

    const pc = { addEventListener: vi.fn() };
    session.emit("peerconnection", { peerconnection: pc });
    expect(pc.addEventListener).toHaveBeenCalledWith("track", expect.any(Function));
  });

  it("ignores locally originated sessions", async () => {
    const t = await boot({
      iparams: SETTINGS,
      fetch: routes({ "/agent/": AGENT_OK, "/session/": { body: { loggedIn: false } } }),
    });
    t.ua.emit("registered");
    const session = new FakeSession();
    t.ua.emit("newRTCSession", { originator: "local", session });
    expect(session.answered).toBe(false);
  });
});

describe("leaving the page", () => {
  it("unregisters from the registrar", async () => {
    // Without this the binding lingers for up to ten minutes and inbound
    // calls route to a dead leg after the agent has gone.
    const t = await boot({ iparams: SETTINGS, fetch: routes({ "/agent/": AGENT_OK }) });
    expect(t.ua.started).toBe(true);
    window.dispatchEvent(new window.Event("beforeunload"));
    expect(t.ua.stopped).toBe(true);
  });
});
