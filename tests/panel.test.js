import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { boot, flush, routes, FakeSession, AGENT_OK, SETTINGS } from "./harness.js";

const LOGGED_IN = {
  body: { loggedIn: true, numbers: ["+911140848108", "+911140848109"], from: "+911140848108", authId: "MA_TEST" },
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
    const fetch = base({ "/select-number": { body: { selected: "+911140848109" } } });
    const t = await boot({ iparams: SETTINGS, fetch });
    await flush();

    const select = t.el("vobiz-number-select");
    select.value = "+911140848109";
    select.dispatchEvent(new window.Event("change"));
    await flush();

    const call = fetch.mock.calls.find(c => String(c[0]).includes("/select-number"));
    expect(call).toBeTruthy();
    expect(JSON.parse(call[1].body)).toMatchObject({ agentId: "priya", number: "+911140848109" });
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
        "/session/": { body: { loggedIn: true, numbers: [], from: null, authId: "MA_TEST" } },
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
    const fetch = base({ "/setup-inbound": { body: { number: "+911140848108" } } });
    const t = await boot({ iparams: SETTINGS, fetch });
    await flush();

    t.el("setup-inbound-btn").click();
    await flush();

    const call = fetch.mock.calls.find(c => String(c[0]).includes("/setup-inbound"));
    expect(JSON.parse(call[1].body)).toMatchObject({ agentId: "priya" });
    expect(t.text("inbound-setup-status")).toMatch(/\+911140848108/);
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

    expect(audio.src).toContain("/recording-audio/priya/rec_a");
  });
});

describe("call progress polling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function dial(statusSequence) {
    let i = 0;
    const fetch = routes({
      "/agent/": AGENT_OK,
      "/session/": LOGGED_IN,
      "/recordings/": RECORDINGS,
      "/start-call": { body: { request_uuid: "uuid-1" } },
      "/call-status/": () => ({ body: { active: statusSequence[Math.min(i++, statusSequence.length - 1)] } }),
    });
    const t = await boot({ iparams: SETTINGS, fetch });
    await vi.advanceTimersByTimeAsync(0);
    t.ua.emit("registered");

    t.el("dialnumber").value = "+911140848108";
    t.el("dialbtn").click();
    await vi.advanceTimersByTimeAsync(0);
    return t;
  }

  it("reports a live call, then its end", async () => {
    const t = await dial([true, true, false]);

    await vi.advanceTimersByTimeAsync(3000);
    expect(t.text("callnum")).toMatch(/on a call with \+911140848108/i);

    await vi.advanceTimersByTimeAsync(6000);
    expect(t.text("callnum")).toMatch(/call ended/i);
  });

  it("stops polling once the call has ended", async () => {
    const t = await dial([true, false]);
    await vi.advanceTimersByTimeAsync(9000);
    expect(t.text("callnum")).toMatch(/call ended/i);

    const el = t.el("callnum");
    el.textContent = "sentinel";
    await vi.advanceTimersByTimeAsync(30000);
    // The timer is cleared, so nothing overwrites the sentinel.
    expect(el.textContent).toBe("sentinel");
  });

  it("survives a failed poll without stopping", async () => {
    let n = 0;
    const fetch = routes({
      "/agent/": AGENT_OK,
      "/session/": LOGGED_IN,
      "/recordings/": RECORDINGS,
      "/start-call": { body: { request_uuid: "uuid-1" } },
      "/call-status/": () => {
        n += 1;
        if (n === 1) return new Error("transient");
        return { body: { active: true } };
      },
    });
    const t = await boot({ iparams: SETTINGS, fetch });
    await vi.advanceTimersByTimeAsync(0);
    t.ua.emit("registered");
    t.el("dialnumber").value = "+911140848108";
    t.el("dialbtn").click();
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(6000);
    expect(t.text("callnum")).toMatch(/on a call/i);
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
    const fetch = base({ "/start-call": { body: { request_uuid: "u" } } });
    const t = await boot({ iparams: SETTINGS, fetch });
    await flush();
    t.ua.emit("registered");
    t.el("dialnumber").value = "  +911140848108  ";
    t.el("dialbtn").click();
    await flush();
    const call = fetch.mock.calls.find(c => String(c[0]).includes("/start-call"));
    expect(JSON.parse(call[1].body).to).toBe("+911140848108");
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
