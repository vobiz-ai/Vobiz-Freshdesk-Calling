import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { boot, flush, routes, FakeSession, AGENT_OK, SETTINGS } from "./harness.js";

const LOGGED_IN = {
  body: { loggedIn: true, numbers: ["+911140848108", "+911140848109"], from: "+911140848108", authId: "MA_TEST" },
};

function base(extra = {}) {
  return routes({ "/agent/": AGENT_OK, "/session/": LOGGED_IN, ...extra });
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

describe("recording is chosen per call, by the agent", () => {
  /**
   * Whether a call is recorded travels ON the call, as the `X-VH-Record` SIP
   * header Vobiz hands to the answer webhook. Nothing is stored server-side, so
   * these assert the header itself — that is the entire contract.
   */
  async function dial(record) {
    const t = await boot({ iparams: SETTINGS, fetch: base() });
    await flush();
    t.ua.emit("registered");
    if (record) t.el("record-call").checked = true;
    t.el("dialnumber").value = "+919876543210";
    t.el("dialbtn").click();
    await flush();
    return t;
  }

  it("sends no header when the box is clear, so nothing is recorded or billed", async () => {
    const t = await dial(false);
    expect(t.ua.calls).toHaveLength(1);
    const headers = t.ua.calls[0].options.extraHeaders || [];
    expect(headers.join(" ")).not.toMatch(/X-VH-Record/i);
  });

  it("sends X-VH-Record when the box is ticked", async () => {
    const t = await dial(true);
    const headers = t.ua.calls[0].options.extraHeaders || [];
    expect(headers).toContain("X-VH-Record: true");
  });

  it("applies the same choice to an inbound call it joins", async () => {
    // Inbound is answered by placing an outgoing leg into the caller's room, so
    // the box has to reach that leg too or it would only work in one direction.
    const offer = { pending: true, from: "+919999900001", room: "fdroom1", callUuid: "u-1" };
    const fetch = vi.fn(async (url, options = {}) => {
      const u = String(url);
      const json =
        u.includes("/agent/") ? AGENT_OK.body
        : u.includes("/inbound-pending/") ? offer
        : u.includes("/inbound-accept") ? { ok: true, room: offer.room, from: offer.from }
        : {};
      return { ok: true, status: 200, json: async () => json };
    });

    vi.useFakeTimers();
    try {
      const t = await boot({ iparams: SETTINGS, fetch });
      t.ua.emit("registered");
      t.el("record-call").checked = true;
      await vi.advanceTimersByTimeAsync(2100);
      await flush();
      t.el("acceptbtn").click();
      await flush();

      expect(t.ua.calls[0].options.extraHeaders).toContain("X-VH-Record: true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("no longer lists recordings in the panel", async () => {
    // They live in the Vobiz Console. Mirroring them here meant streaming call
    // audio back out through the calling backend.
    const t = await boot({ iparams: SETTINGS, fetch: base() });
    await flush();
    expect(t.el("call-history-list")).toBeNull();
    expect(t.el("vobiz-playback-audio")).toBeNull();
  });
});

describe("call progress", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // The browser is the A leg: it sends the INVITE itself, so progress comes
  // from the JsSIP session rather than from polling the backend.
  async function dial() {
    const fetch = routes({ "/agent/": AGENT_OK, "/session/": LOGGED_IN });
    const t = await boot({ iparams: SETTINGS, fetch });
    await vi.advanceTimersByTimeAsync(0);
    t.ua.emit("registered");

    t.el("dialnumber").value = "+911140848108";
    t.el("dialbtn").click();
    await vi.advanceTimersByTimeAsync(0);
    return { t, session: t.ua.calls.at(-1).session };
  }

  it("dials the registrar with the typed number", async () => {
    const { t } = await dial();
    expect(t.ua.calls).toHaveLength(1);
    expect(t.ua.calls[0].target).toBe("sip:+911140848108@registrar.vobiz.ai");
    expect(t.ua.calls[0].options.mediaConstraints).toEqual({ audio: true, video: false });
  });

  it("reports ringing, then connected, then the end", async () => {
    const { t, session } = await dial();

    session.emit("progress");
    expect(t.text("callnum")).toMatch(/ringing \+911140848108/i);

    session.emit("confirmed");
    expect(t.text("callnum")).toMatch(/on a call with \+911140848108/i);

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
    const fetch = routes({ "/agent/": AGENT_OK, "/session/": LOGGED_IN });
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
    t.el("dialnumber").value = "  +911140848108  ";
    t.el("dialbtn").click();
    await flush();
    expect(t.ua.calls.at(-1).target).toBe("sip:+911140848108@registrar.vobiz.ai");
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
      fetch: routes({ "/agent/": AGENT_OK, "/session/": LOGGED_IN }),
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
