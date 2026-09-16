/**
 * Test harness.
 *
 * app/scripts/app.js is a classic browser script: it calls init() at the top
 * level and talks to the Freshworks SDK through the globals `app` and
 * `client`. Rather than refactor the shipping code to suit the tests, the
 * harness reproduces the environment the app actually runs in — the real
 * markup from app/index.html, plus fakes for the SDK, JsSIP and fetch — and
 * then evaluates the real source.
 *
 * That means these tests exercise the code that ships, including its DOM
 * wiring, not an extracted copy of it.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const INDEX_HTML = fs.readFileSync(path.join(root, "app/index.html"), "utf8");
const APP_PATH = "../app/scripts/app.js";

// jsdom ships no navigator.mediaDevices, but every browser the panel runs in
// has one. Without this the app's "is there a microphone path at all" guard
// trips and the inbound leg is never answered — a property of the test
// environment, not of the code under test.
if (!globalThis.navigator.mediaDevices) {
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [] })) },
  });
}

/** The <body> of the real panel, so tests bind to the real element ids. */
function bodyMarkup() {
  const m = INDEX_HTML.match(/<body>([\s\S]*?)<\/body>/i);
  if (!m) throw new Error("could not find <body> in app/index.html");
  return m[1].replace(/<script[\s\S]*?<\/script>/gi, "");
}

/** A minimal stand-in for a JsSIP UA that records what the app did to it. */
class FakeUA {
  constructor(config) {
    this.config = config;
    this.handlers = {};
    this.started = false;
    this.stopped = false;
    this.calls = [];
  }
  on(event, cb) { (this.handlers[event] ||= []).push(cb); }
  start() { this.started = true; }
  stop() { this.stopped = true; }
  emit(event, payload) { (this.handlers[event] || []).forEach(cb => cb(payload)); }
  /**
   * Mirrors JsSIP's ua.call(target, options): records what was dialled and
   * hands back a session the test can drive through progress/confirmed/ended.
   */
  call(target, options) {
    const session = new FakeSession();
    this.calls.push({ target, options, session });
    return session;
  }
}

/** A stand-in for an inbound JsSIP RTC session. */
export class FakeSession {
  constructor() {
    this.handlers = {};
    this.answered = false;
    this.terminated = false;
    this.connection = null;
  }
  on(event, cb) { (this.handlers[event] ||= []).push(cb); }
  emit(event, payload) { (this.handlers[event] || []).forEach(cb => cb(payload)); }
  answer() { this.answered = true; }
  terminate() { this.terminated = true; }
}

/**
 * Boot the app.
 *
 * @param {object}   opts
 * @param {object}   opts.iparams  installation settings the SDK returns
 * @param {Function} opts.fetch    fetch implementation for this test
 */
export async function boot({ iparams = {}, fetch: fetchImpl } = {}) {
  document.body.innerHTML = bodyMarkup();

  const events = {};
  const triggers = [];

  const client = {
    iparams: { get: vi.fn(async () => iparams) },
    events: { on: vi.fn((name, cb) => { events[name] = cb; }) },
    interface: { trigger: vi.fn((...args) => { triggers.push(args); }) },
  };

  const uas = [];
  const JsSIP = {
    WebSocketInterface: vi.fn(function (url) { this.url = url; }),
    UA: vi.fn(function (config) {
      const ua = new FakeUA(config);
      uas.push(ua);
      return ua;
    }),
  };

  globalThis.app = { initialized: vi.fn(async () => client) };
  globalThis.client = client;
  globalThis.JsSIP = JsSIP;
  globalThis.fetch = fetchImpl || vi.fn(async () => ({ ok: true, json: async () => ({}) }));

  // Import the real source so the coverage instrumenter sees it. app.js is a
  // classic browser script, but it has no import/export of its own, so it
  // evaluates cleanly as a module — and calls init() on evaluation.
  // resetModules() forces a fresh evaluation for each test.
  vi.resetModules();
  await import(APP_PATH);

  // Let init()'s awaited chain settle.
  await flush();

  return {
    client,
    JsSIP,
    triggers,
    /** The UA the app constructed, once initVobizSip has run. */
    get ua() { return uas[uas.length - 1]; },
    /** Fire a Freshworks event the app subscribed to. */
    fire: (name, payload) => events[name] && events[name](payload),
    text: id => document.getElementById(id)?.textContent ?? "",
    el: id => document.getElementById(id),
    isDisabled: id => document.getElementById(id)?.hasAttribute("disabled"),
  };
}

/** Drain the microtask queue a few times so chained awaits complete. */
export async function flush(times = 8) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

/** Build a fetch fake from a map of URL-substring → response. */
export function routes(map) {
  return vi.fn(async url => {
    for (const [pattern, value] of Object.entries(map)) {
      if (String(url).includes(pattern)) {
        const r = typeof value === "function" ? value() : value;
        if (r instanceof Error) throw r;
        return { ok: r.ok !== false, status: r.status ?? 200, json: async () => r.body ?? {} };
      }
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
}

export const AGENT_OK = { body: { displayName: "Priya", sipUser: "priya@registrar.vobiz.ai", sipPassword: "s3cret" } };
export const SETTINGS = { backend_url: "https://backend.example.com", agent_id: "priya" };
