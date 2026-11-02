import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn as spawnProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { privateFolder, readJSON, writePrivate } from "../../../../lib/storage.js";

// Chromium flags of every agent browser AgentPier launches for Hermes, as OpenClaw
// launches its managed profiles (openclaw dist chrome-*.mjs
// buildOpenClawChromeLaunchArgs, plus the extraArgs of openclaw-config/web-tools.js):
// no first-run UI, sync or crash bubbles, the basic password store and the mock
// keychain (a visible launch never prompts the owner for a keyring) and no throttling
// of a window the owner rarely looks at.
const launchArgs = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-sync",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-features=Translate,MediaRouter",
  "--disable-session-crashed-bubble",
  "--hide-crash-restore-bubble",
  "--password-store=basic",
  "--use-mock-keychain",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
];
const startTimeoutMs = 30000;
const stopGraceMs = 5000;
const ticketMs = 30000;
const commandTimeoutMs = 5000;

const problem = (code) => Object.assign(Error(code), { code });

/**
 * The command line of one launch, as OpenClaw's: headless without the GPU and, on
 * Linux, without /dev/shm (small in containers). The sandbox is never switched off.
 */
export function chromiumArgs({ port, userData, headless, platform = process.platform }) {
  return [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${userData}`,
    ...launchArgs,
    ...(headless ? ["--headless=new", "--disable-gpu"] : []),
    ...(platform === "linux" ? ["--disable-dev-shm-usage"] : []),
    "about:blank",
  ];
}

/**
 * The launch environment: AgentPier's, with Chromium's Linux config and cache homes
 * beside the agent's profile unless set, as OpenClaw keeps them in its own folder.
 */
export function chromiumEnvironment({
  directory,
  platform = process.platform,
  env = process.env,
}) {
  if (platform !== "linux") return { ...env };
  const state = path.join(directory, "chromium-state");
  return {
    ...env,
    XDG_CONFIG_HOME: env.XDG_CONFIG_HOME || state,
    XDG_CACHE_HOME: env.XDG_CACHE_HOME || state,
  };
}

/** A free loopback TCP port, as the system hands one out. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// A CDP WebSocket URL on this very loopback port, or null.
function loopbackSocket(value, port) {
  try {
    const url = new URL(String(value));
    return url.protocol === "ws:" &&
      url.hostname === "127.0.0.1" &&
      url.port === String(port) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/**
 * One Hermes agent's own Chromium, which AgentPier starts and owns (ADR 0006 decision
 * 4) and Hermes attaches to through `browser.cdp_url` (Hermes v0.22.5
 * tools/browser_tool_cdp.py: a CDP override never launches a browser of Hermes's
 * own). Its profile lives in the agent's home (`directory`), its CDP port is chosen
 * once and kept (`port.json`), so the compiled `cdp_url` stays the same.
 *
 * The browser sub-port (../agent-runtime.js) speaks the part of OpenClaw's browser
 * control API AgentPier's live view and limits use (agent-browsers.js,
 * browser-live-view.js): `GET /` (`{ running }`), `POST /start`, `POST /stop`, `GET
 * /tabs`, `POST /screencast` (a single-use ticket for one tab) and `openStream`,
 * which relays CDP's screencast of that tab in OpenClaw's frame format (a four-byte
 * header length, a JSON header with the CSS viewport, the JPEG).
 *
 * `settings()`: `{ executablePath, headless }` of the next launch, or null while
 * AgentPier knows no browser app.
 */
export class HermesBrowser {
  constructor({
    directory,
    settings = () => null,
    spawn = spawnProcess,
    fetch = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket,
    platform = process.platform,
  }) {
    // `directory`: the folder, or a function answering it (read when first needed).
    Object.assign(this, {
      place: directory,
      settings,
      spawn,
      fetch,
      WebSocketImpl,
      platform,
    });
    this.child = null;
    this.starting = null;
    this.tickets = new Map();
  }
  get directory() {
    return typeof this.place === "function" ? this.place() : this.place;
  }
  get userData() {
    return path.join(this.directory, "user-data");
  }
  /** The CDP port this agent's browser listens on, chosen once. */
  async port() {
    const file = path.join(this.directory, "port.json");
    const saved = readJSON(file, null)?.port;
    if (Number.isSafeInteger(saved) && saved > 1024 && saved < 65536) return saved;
    privateFolder(this.directory);
    const port = await freePort();
    writePrivate(file, { port });
    return port;
  }
  /** The port as known now (null before the first port()). */
  knownPort() {
    const saved = readJSON(path.join(this.directory, "port.json"), null)?.port;
    return Number.isSafeInteger(saved) ? saved : null;
  }
  async version() {
    const port = this.knownPort();
    if (!port) return null;
    try {
      const response = await this.fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(commandTimeoutMs),
      });
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  }
  async running() {
    return !!this.child && !!(await this.version());
  }
  async start() {
    if (await this.running()) return;
    this.starting ??= this.launch().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
  async launch() {
    const settings = this.settings();
    if (!settings?.executablePath) throw problem("BROWSER_UNAVAILABLE");
    const port = await this.port();
    privateFolder(this.directory);
    privateFolder(this.userData);
    await this.stop();
    // A browser of an earlier AgentPier run (one that crashed) still holds the port
    // and the profile: it is asked to close over CDP before the new one starts.
    await this.closeStray(port);
    const { platform } = this;
    const child = this.spawn(
      settings.executablePath,
      chromiumArgs({
        port,
        userData: this.userData,
        headless: settings.headless !== false,
        platform,
      }),
      {
        detached: true,
        stdio: "ignore",
        env: chromiumEnvironment({ directory: this.directory, platform }),
      },
    );
    child.on?.("error", () => {});
    child.once?.("exit", () => {
      if (this.child === child) this.child = null;
    });
    child.unref?.();
    this.child = child;
    const deadline = Date.now() + startTimeoutMs;
    while (Date.now() < deadline) {
      if (this.child !== child) break;
      if (await this.version()) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await this.stop();
    throw problem("BROWSER_START_FAILED");
  }
  async closeStray(port) {
    const socket = loopbackSocket((await this.version())?.webSocketDebuggerUrl, port);
    if (!socket) return;
    await new Promise((resolve) => {
      const ws = new this.WebSocketImpl(socket);
      const done = setTimeout(resolve, commandTimeoutMs);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
      ws.onerror = ws.onclose = () => {
        clearTimeout(done);
        resolve();
      };
    });
    const deadline = Date.now() + stopGraceMs;
    while (Date.now() < deadline && (await this.version()))
      await new Promise((resolve) => setTimeout(resolve, 250));
  }
  /** Ends the browser this AgentPier started; its profile stays. */
  async stop() {
    const child = this.child;
    this.child = null;
    for (const ticket of this.tickets.values()) ticket.stream?.close();
    this.tickets.clear();
    if (!child?.pid || child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once?.("exit", resolve));
    const signal = (name) => {
      try {
        process.kill(-child.pid, name);
      } catch {
        /* Gone already. */
      }
    };
    signal("SIGTERM");
    const timer = setTimeout(() => signal("SIGKILL"), stopGraceMs);
    await Promise.race([exited, new Promise((r) => setTimeout(r, stopGraceMs * 2))]);
    clearTimeout(timer);
  }
  async tabs() {
    const port = this.knownPort();
    const response = await this.fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(commandTimeoutMs),
    });
    const list = response.ok ? await response.json() : [];
    return (Array.isArray(list) ? list : []).map((tab) => ({
      targetId: String(tab.id || ""),
      type: String(tab.type || ""),
      title: String(tab.title || ""),
      url: String(tab.url || ""),
      socket: loopbackSocket(tab.webSocketDebuggerUrl, port),
    }));
  }
  /** One call of the control API (the profile in `query` names this browser). */
  async request({ method = "GET", path: route, body } = {}) {
    if (method === "GET" && route === "/") return { running: await this.running() };
    if (method === "POST" && route === "/start") {
      await this.start();
      return { ok: true };
    }
    if (method === "POST" && route === "/stop") {
      await this.stop();
      return { ok: true };
    }
    if (!(await this.running())) throw problem("BROWSER_NOT_RUNNING");
    if (method === "GET" && route === "/tabs")
      return {
        tabs: (await this.tabs()).map(({ socket: _s, ...tab }) => tab),
      };
    if (method === "POST" && route === "/screencast") {
      const pages = (await this.tabs()).filter(
        (tab) => tab.type === "page" && tab.socket,
      );
      const tab = body?.targetId
        ? pages.find((page) => page.targetId === body.targetId)
        : pages[0];
      if (!tab) throw problem("BROWSER_NO_TAB");
      const id = randomBytes(16).toString("hex");
      this.tickets.set(id, {
        tab,
        options: {
          format: "jpeg",
          quality: Math.min(100, Math.max(1, Number(body?.quality) || 60)),
          maxWidth: Math.min(4096, Math.max(64, Number(body?.maxWidth) || 1280)),
          maxHeight: Math.min(4096, Math.max(64, Number(body?.maxHeight) || 1280)),
        },
        expires: Date.now() + ticketMs,
      });
      return { wsPath: `/screencast/${id}`, targetId: tab.targetId, url: tab.url };
    }
    throw problem("BROWSER_ROUTE_UNKNOWN");
  }
  /** The screencast a ticket names; synchronous, throws for anything else. */
  openStream({ path: route }) {
    const id = /^\/screencast\/([0-9a-f]{32})$/.exec(String(route || ""))?.[1];
    const ticket = id && this.tickets.get(id);
    if (!ticket || ticket.used || ticket.expires < Date.now())
      throw problem("BROWSER_TICKET_INVALID");
    ticket.used = true;
    ticket.stream = new Screencast(ticket.tab, ticket.options, this.WebSocketImpl);
    ticket.stream.once("close", () => this.tickets.delete(id));
    return ticket.stream;
  }
}

/**
 * CDP's screencast of one tab as the live view reads OpenClaw's: "message" events
 * with a text `{ type: "ready", targetId, url, title }` once, then one binary frame
 * per picture; "close" with 4004 when the tab went away, 1000 otherwise.
 */
class Screencast extends EventEmitter {
  constructor(tab, options, WebSocketImpl) {
    super();
    this.tab = tab;
    this.ended = false;
    this.id = 0;
    const ws = new WebSocketImpl(tab.socket);
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      this.send("Page.enable");
      this.send("Page.startScreencast", options);
      this.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            type: "ready",
            targetId: tab.targetId,
            url: tab.url,
            title: tab.title,
          }),
        ),
        false,
      );
    };
    ws.onmessage = (event) => this.cdp(event.data);
    ws.onerror = () => this.emit("error", Error("cdp"));
    ws.onclose = () => this.end(this.detached ? 4004 : 1000);
  }
  send(method, params = {}) {
    if (this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify({ id: ++this.id, method, params }));
  }
  cdp(data) {
    let message;
    try {
      message = JSON.parse(
        typeof data === "string" ? data : Buffer.from(data).toString(),
      );
    } catch {
      return;
    }
    if (message.method === "Inspector.detached" || message.method === "Target.detached")
      this.detached = true;
    if (message.method === "Page.frameNavigated" && !message.params?.frame?.parentId)
      this.emit(
        "message",
        Buffer.from(JSON.stringify({ type: "meta", url: message.params.frame.url })),
        false,
      );
    if (message.method !== "Page.screencastFrame") return;
    const { data: jpeg, metadata = {}, sessionId } = message.params || {};
    this.send("Page.screencastFrameAck", { sessionId });
    if (typeof jpeg !== "string") return;
    const header = Buffer.from(
      JSON.stringify({
        cssWidth: metadata.deviceWidth,
        cssHeight: metadata.deviceHeight,
        pageScaleFactor: metadata.pageScaleFactor,
        offsetTop: metadata.offsetTop,
        timestamp: metadata.timestamp,
      }),
    );
    const length = Buffer.alloc(4);
    length.writeUInt32BE(header.length, 0);
    this.emit(
      "message",
      Buffer.concat([length, header, Buffer.from(jpeg, "base64")]),
      true,
    );
  }
  end(code) {
    if (this.ended) return;
    this.ended = true;
    this.emit("close", code);
  }
  close() {
    try {
      this.send("Page.stopScreencast");
      this.ws.close();
    } catch {
      /* Closed already. */
    }
    this.end(1000);
  }
}

/** Whether `directory` holds a stored profile. */
export const storedProfile = (directory) =>
  fs.existsSync(path.join(directory, "user-data"));
