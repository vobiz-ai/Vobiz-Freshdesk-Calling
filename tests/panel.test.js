import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { boot, flush, routes, FakeSession, AGENT_OK, SETTINGS } from "./harness.js";

const LOGGED_IN = {
  body: { loggedIn: true, numbers: ["+910000000001", "+910000000002"], from: "+910000000001", authId: "MA_TEST0001" },
};

const RECORDINGS = {
  body: {
    objects: [
      { recording_id: "rec_a", add_time: "2026-09-14 11:42:07", rounded_recording_duration: 96 },
      { recording_id: "rec_b", add_time: "2026-09-14 10:18:44", rounded_recording_duration: 41 },
    ],
  },
};

function base(extra = {}) {
  return routes({ "/agent/": AGENT_OK, "/session/": LOGGED_IN, "/recordings/": RECORDINGS, ...extra });
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("caller-ID selection", () => {
  it("tells the backend which number to call from", async () => {
    const fetch = base({ "/select-number": { body: { selected: "+910000000002" } } });
    const t = await boot({ iparams: SETTINGS, fetch });
    await flush();

    const select = t.el("vobiz-number-select");
    select.value = "+910000000002";
    select.dispatchEvent(new window.Event("change"));
    await flush();

    const call = fetch.mock.calls.find(c => String(c[0]).includes("/select-number"));
    expect(call).toBeTruthy();
    expect(JSON.parse(call[1].body)).toMatchObject({ agentId: "fd1001", number: "+910000000002" });
  });

  it("reports a rejected selection", async () => {
    const fetch = base({ "/select-number": { ok: false, status: 400, body: { error: "Number not on this account" } } });
    const t = await boot({ iparams: SETTINGS, fetch });
    await flush();

    t.el("vobiz-number-select").dispatchEvent(new window.Event("change"));
    await flush();
    expect(t.text("vobiz-login-status")).toMatch(/number not on this account/i);
  });

  it("hides the caller-ID picker when the account has no numbers", async () => {
    // Covers the empty-list branch: a logged-in account with zero DIDs should
    // not show an empty dropdown.
    const t = await boot({
      iparams: SETTINGS,
      fetch: routes({
        "/agent/": AGENT_OK,
        "/session/": { body: { loggedIn: true, numbers: [], from: null, authId: "MA_TEST0001" } },
        "/recordings/": RECORDINGS,
      }),
    });
    await flush();
    expect(t.el("vobiz-number-select").hidden).toBe(true);
    expect(t.el("vobiz-number-label").hidden).toBe(true);
  });

  it("shows the caller-ID label only once numbers exist", async () => {
    const t = await boot({ iparams: SETTINGS, fetch: base() });
    await flush();
    expect(t.el("vobiz-number-label").hidden).toBe(false);
    expect(t.el("vobiz-number-select").hidden).toBe(false);
  });
});

describe("inbound setup", () => {
  it("binds the selected number to this panel", async () => {
    const fetch = base({ "/setup-inbound": { body: { number: "+910000000001" } } });
    const t = await boot({ iparams: SETTINGS, fetch });
    await flush();

    t.el("setup-inbound-btn").click();
    await flush();

    const call = fetch.mock.calls.find(c => String(c[0]).includes("/setup-inbound"));
    // The token says who and which number; the ignored `platform` field is gone.
    expect(JSON.parse(call[1].body)).toEqual({});
    expect(t.text("inbound-setup-status")).toMatch(/\+910000000001/);
  });

  it("reports a refusal from the backend", async () => {
    const fetch = base({ "/setup-inbound": { ok: false, status: 401, body: { error: "Log in first" } } });
    const t = await boot({ iparams: SETTINGS, fetch });
    await flush();

    t.el("setup-inbound-btn").click();
    await flush();
    expect(t.text("inbound-setup-status")).toMatch(/log in first/i);
  });
});

describe("call recordings", () => {
  it("lists recordings once logged in", async () => {
    const t = await boot({ iparams: SETTINGS, fetch: base() });
    await flush();
    const items = t.el("call-history-list").querySelectorAll("li");
    expect(items.length).toBe(2);
  });

  it("does not ask for recordings before login", async () => {
    // Regression: the panel requested recordings on boot, before any session
    // existed, and showed an error on every fresh open.
    const fetch = routes({ "/agent/": AGENT_OK, "/session/": { body: { loggedIn: false } } });
    await boot({ iparams: SETTINGS, fetch });
    await flush();
    expect(fetch.mock.calls.some(c => String(c[0]).includes("/recordings/"))).toBe(false);
  });

  it("refreshes on demand", async () => {
    const fetch = base();
    const t = await boot({ iparams: SETTINGS, fetch });
    await flush();
    const before = fetch.mock.calls.filter(c => String(c[0]).includes("/recordings/")).length;

    t.el("refresh-history-btn").click();
    await flush();
    const after = fetch.mock.calls.filter(c => String(c[0]).includes("/recordings/")).length;
    expect(after).toBe(before + 1);
  });

  it("says so when there are none", async () => {
    const t = await boot({ iparams: SETTINGS, fetch: base({ "/recordings/": { body: { objects: [] } } }) });
    await flush();
    expect(t.el("call-history-list").textContent).toMatch(/no recordings/i);
  });

  it("reports a failure to load", async () => {
    const t = await boot({ iparams: SETTINGS, fetch: base({ "/recordings/": new Error("ECONNREFUSED") }) });
    await flush();
    expect(t.el("call-history-list").textContent).toMatch(/could not load/i);
  });

  it("plays a recording through the backend, url-encoding the id", async () => {
    const t = await boot({ iparams: SETTINGS, fetch: base() });
    await flush();

    const audio = t.el("vobiz-playback-audio");
    // jsdom has no media stack; play() would throw "not implemented".
    audio.play = vi.fn(() => Promise.resolve());

    const playBtn = t.el("call-history-list").querySelector("button");
    expect(playBtn).toBeTruthy();
    playBtn.click();

    expect(audio.src).toContain("/recording-audio/fd1001/rec_a");
  });
});

describe("call progress", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // The browser is the A leg: it sends the INVITE itself, so progress comes
  // from the JsSIP session rather than from polling the backend.
  async function dial() {
    const fetch = routes({ "/agent/": AGENT_OK, "/session/": LOGGED_IN, "/recordings/": RECORDINGS });
    const t = await boot({ iparams: SETTINGS, fetch });
    await vi.advanceTimersByTimeAsync(0);
    t.ua.emit("registered");

    t.el("dialnumber").value = "+910000000001";
    t.el("dialbtn").click();
    await vi.advanceTimersByTimeAsync(0);
    return { t, session: t.ua.calls.at(-1).session };
  }

  it("dials the registrar with the typed number", async () => {
    const { t } = await dial();
    expect(t.ua.calls).toHaveLength(1);
    expect(t.ua.calls[0].target).toBe("sip:+910000000001@registrar.vobiz.ai");
    expect(t.ua.calls[0].options.mediaConstraints).toEqual({ audio: true, video: false });
  });

  it("reports ringing, then connected, then the end", async () => {
    const { t, session } = await dial();

    session.emit("progress");
    expect(t.text("callnum")).toMatch(/ringing \+910000000001/i);

    session.emit("confirmed");
    await vi.advanceTimersByTimeAsync(0);
    expect(t.text("callnum")).toMatch(/on a call with \+910000000001/i);

    session.emit("ended");
    expect(t.text("callnum")).toMatch(/call ended/i);
  });

  it("reports a failure cause", async () => {
    const { t, session } = await dial();
    session.emit("failed", { cause: "Busy" });
    expect(t.text("callnum")).toMatch(/call failed — busy/i);
  });

  it("keeps the Call button disabled until SIP is registered", async () => {
    // The first line of defence against dialling with nowhere to put the audio.
    // The in-placeCall guard behind it is covered in app.test.js, which reaches
    // placeCall through cti.triggerDialer rather than the button.
    const fetch = routes({ "/agent/": AGENT_OK, "/session/": LOGGED_IN, "/recordings/": RECORDINGS });
    const t = await boot({ iparams: SETTINGS, fetch });
    await vi.advanceTimersByTimeAsync(0);

    expect(t.el("dialbtn").disabled).toBe(true);
    t.ua.emit("registered");
    expect(t.el("dialbtn").disabled).toBe(false);
  });
});

describe("the dial button", () => {
  it("ignores an empty number", async () => {
    const fetch = base();
    const t = await boot({ iparams: SETTINGS, fetch });
    await flush();
    t.ua.emit("registered");
    t.el("dialnumber").value = "   ";
    t.el("dialbtn").click();
    await flush();
    expect(fetch.mock.calls.some(c => String(c[0]).includes("/start-call"))).toBe(false);
  });

  it("trims the number before dialling", async () => {
    const t = await boot({ iparams: SETTINGS, fetch: base({}) });
    await flush();
    t.ua.emit("registered");
    t.el("dialnumber").value = "  +910000000001  ";
    t.el("dialbtn").click();
    await flush();
    expect(t.ua.calls.at(-1).target).toBe("sip:+910000000001@registrar.vobiz.ai");
  });
});

describe("defensive guards", () => {
  it("hanging up with no active session does nothing", async () => {
    // hangUp() guards on currentRTCSession; clicking it with no call must not throw.
    const t = await boot({ iparams: SETTINGS, fetch: base() });
    await flush();
    expect(() => t.el("hangupbtn").click()).not.toThrow();
  });

  it("survives a hangup that the SIP stack rejects", async () => {
    const t = await boot({
      iparams: SETTINGS,
      fetch: routes({ "/agent/": AGENT_OK, "/session/": LOGGED_IN, "/recordings/": RECORDINGS }),
    });
    await flush();
    t.ua.emit("registered");

    const session = new FakeSession();
    session.terminate = () => { throw new Error("already terminated"); };
    t.ua.emit("newRTCSession", { originator: "remote", session });

    // The error is caught and logged rather than propagating to the click handler.
    expect(() => t.el("hangupbtn").click()).not.toThrow();
  });
});

describe("sign-in tabs", () => {
  const SIGNED_OUT = { ok: false, status: 401, body: { error: "Sign in first" } };

  function sipFlow(extra = {}) {
    let signedIn = false;
    return routes({
      "/agent/": () => (signedIn ? { body: { displayName: "ravi", sipUser: "ravidesk@registrar.vobiz.ai", sipPassword: "typed" } } : SIGNED_OUT),
      "/session/": { body: { loggedIn: false } },
      "/login-sip": () => { signedIn = true; return { body: { token: "tok-sip", mode: "sip", numbers: ["+910000000005"], selected: "+910000000005" } }; },
      "/login": () => { signedIn = true; return { body: { token: "tok-acct", mode: "account", numbers: ["+910000000001"], numberDetails: [{ e164: "+910000000001", applicationId: "20000000000000001" }], selected: "+910000000001" } }; },
      "/recordings/": RECORDINGS,
      ...extra,
    });
  }

  it("switches between the Vobiz account and SIP direct forms", async () => {
    const t = await boot({ iparams: SETTINGS, fetch: sipFlow() });
    expect(t.el("vobiz-login-form").hidden).toBe(false);
    expect(t.el("sip-login-form").hidden).toBe(true);
    t.el("signin-tab-sip").click();
    expect(t.el("vobiz-login-form").hidden).toBe(true);
    expect(t.el("sip-login-form").hidden).toBe(false);
    expect(t.el("signin-tab-sip").getAttribute("aria-selected")).toBe("true");
    t.el("signin-tab-account").click();
    expect(t.el("vobiz-login-form").hidden).toBe(false);
  });

  it("asks for all three SIP-direct fields", async () => {
    const fetch = sipFlow();
    const t = await boot({ iparams: SETTINGS, fetch });
    t.el("sip-user").value = "ravidesk";
    t.el("sip-login-btn").click();
    await flush();
    expect(t.text("vobiz-login-status")).toMatch(/SIP username/);
    expect(fetch.mock.calls.some(c => String(c[0]).includes("/login-sip"))).toBe(false);
  });

  it("signs in over SIP direct, registers with the typed endpoint and hides account-only features", async () => {
    const fetch = sipFlow();
    const t = await boot({ iparams: SETTINGS, fetch });
    t.el("signin-tab-sip").click();
    t.el("sip-user").value = "ravidesk";
    t.el("sip-password").value = "typed";
    t.el("sip-caller-id").value = "+910000000005";
    t.el("sip-login-btn").click();
    await flush(16);

    const call = fetch.mock.calls.find(c => String(c[0]).includes("/login-sip"));
    expect(JSON.parse(call[1].body)).toEqual({ agentId: "fd1001", displayName: "Priya", sipUser: "ravidesk", sipPassword: "typed", callerId: "+910000000005" });
    expect(t.ua.config.uri).toBe("sip:ravidesk@registrar.vobiz.ai");
    expect(t.text("vobiz-login-status")).toMatch(/SIP direct — calling from \+910000000005/);
    expect(t.el("inbound-step").hidden).toBe(true);
    expect(t.el("call-history-list").hidden).toBe(true);
    expect(t.el("account-only-note").hidden).toBe(false);
    expect(t.el("vobiz-number-select").hidden).toBe(true);
    expect(fetch.mock.calls.some(c => String(c[0]).includes("/recordings/"))).toBe(false);
  });

  it("reports a refused SIP-direct sign-in", async () => {
    const fetch = sipFlow({ "/login-sip": { ok: false, status: 400, body: { error: "The caller ID must be a phone number" } } });
    const t = await boot({ iparams: SETTINGS, fetch });
    t.el("sip-user").value = "ravidesk";
    t.el("sip-password").value = "typed";
    t.el("sip-caller-id").value = "nope";
    t.el("sip-login-btn").click();
    await flush(16);
    expect(t.text("vobiz-login-status")).toMatch(/caller ID must be a phone number/);
  });

  it("re-registers with the new password on every sign-in", async () => {
    const t = await boot({ iparams: SETTINGS, fetch: sipFlow() });
    t.el("vobiz-auth-id").value = "MA_TEST0001";
    t.el("vobiz-auth-token").value = "token";
    t.el("vobiz-login-btn").click();
    await flush(16);
    const first = t.ua;
    // The Auth Token field is cleared after a sign-in, so it is typed again.
    t.el("vobiz-auth-token").value = "token";
    t.el("vobiz-login-btn").click();
    await flush(16);
    expect(first.stopped).toBe(true);
    expect(t.ua).not.toBe(first);
  });

  it("says which application Enable inbound calls would move the number off", async () => {
    const t = await boot({ iparams: SETTINGS, fetch: sipFlow() });
    t.el("vobiz-auth-id").value = "MA_TEST0001";
    t.el("vobiz-auth-token").value = "token";
    t.el("vobiz-login-btn").click();
    await flush(16);
    expect(t.el("inbound-current-app").hidden).toBe(false);
    expect(t.text("inbound-current-app")).toMatch(/application 20000000000000001/);
  });

  it("restores a SIP-direct session in SIP-direct mode", async () => {
    const t = await boot({
      iparams: SETTINGS,
      fetch: routes({ "/agent/": AGENT_OK, "/session/": { body: { loggedIn: true, mode: "sip", numbers: ["+910000000005"], from: "+910000000005" } } }),
    });
    await flush();
    expect(t.text("vobiz-login-status")).toMatch(/SIP direct/);
    expect(t.el("inbound-step").hidden).toBe(true);
  });
});

describe("caller ID on the INVITE", () => {
  it("sends the selected caller ID as X-VH-Caller-ID", async () => {
    const fetch = base({ "/setup-inbound": { body: { number: "+910000000001", previousAppId: "20000000000000001" } } });
    const t = await boot({ iparams: SETTINGS, fetch });
    await flush();
    t.ua.emit("registered");
    await flush();
    t.el("dialnumber").value = "+919999988888";
    t.el("dialbtn").click();
    await flush();
    const headers = t.ua.calls.at(-1).options.extraHeaders;
    expect(headers[0]).toBe("X-VH-Caller-ID: +910000000001");
    expect(headers[1]).toMatch(/^X-VH-Call-Ref: [0-9a-f]{24}$/);

    t.el("setup-inbound-btn").click();
    await flush();
    expect(t.text("inbound-setup-status")).toMatch(/moved off application 20000000000000001/);
  });
});
