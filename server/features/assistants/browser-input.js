/**
 * The owner's input while holding an agent's browser (docs/assistant-gateway.md
 * "Takeover"): validates the live view's input commands, maps the owner's pointer on
 * the displayed picture to the page's CSS pixels and sends raw CDP Input events to
 * the shown tab on the agent's own, loopback-only CDP port.
 */
const buttons = ["none", "left", "middle", "right"];
const pointerActions = { move: "mouseMoved", down: "mousePressed", up: "mouseReleased" };
const keyActions = ["down", "up"];
const MAX_TEXT = 4000;
const fraction = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const integer = (value, min, max) =>
  Number.isInteger(value) && value >= min && value <= max;
const shortText = (value, max) =>
  typeof value === "string" &&
  value.length <= max &&
  !/[\u0000-\u0008\u000e-\u001f]/.test(value);

/** A validated input command, or null. Coordinates are fractions of the picture. */
export function validateInput(command) {
  if (!command || typeof command !== "object") return null;
  const modifiers = command.modifiers ?? 0;
  if (!integer(modifiers, 0, 15)) return null;
  if (command.type === "pointer") {
    if (
      !Object.hasOwn(pointerActions, command.action) ||
      !fraction(command.x) ||
      !fraction(command.y) ||
      !buttons.includes(command.button ?? "none") ||
      !integer(command.buttons ?? 0, 0, 7) ||
      !integer(command.clickCount ?? 0, 0, 3)
    )
      return null;
    return {
      type: "pointer",
      action: command.action,
      x: command.x,
      y: command.y,
      button: command.button ?? "none",
      buttons: command.buttons ?? 0,
      clickCount: command.clickCount ?? 0,
      modifiers,
    };
  }
  if (command.type === "wheel") {
    const delta = (value) =>
      typeof value === "number" && Number.isFinite(value)
        ? Math.max(-2000, Math.min(2000, value))
        : null;
    const deltaX = delta(command.deltaX ?? 0),
      deltaY = delta(command.deltaY ?? 0);
    if (
      !fraction(command.x) ||
      !fraction(command.y) ||
      deltaX === null ||
      deltaY === null
    )
      return null;
    return { type: "wheel", x: command.x, y: command.y, deltaX, deltaY, modifiers };
  }
  if (command.type === "key") {
    if (
      !keyActions.includes(command.action) ||
      !shortText(command.key, 32) ||
      !command.key ||
      !shortText(command.code ?? "", 32) ||
      !shortText(command.text ?? "", 8)
    )
      return null;
    return {
      type: "key",
      action: command.action,
      key: command.key,
      code: command.code ?? "",
      text: command.text ?? "",
      modifiers,
    };
  }
  if (command.type === "text" || command.type === "paste") {
    if (
      typeof command.text !== "string" ||
      !command.text ||
      command.text.length > MAX_TEXT
    )
      return null;
    return { type: "text", text: command.text };
  }
  return null;
}

/**
 * The page point under the owner's pointer: fractions of the shown picture times the
 * frame's layout viewport in CSS pixels (its cssWidth/cssHeight metadata). CDP's
 * mouse events take viewport coordinates, so the scroll offset is not added.
 */
export function toViewport({ x, y }, metrics) {
  const width = metrics?.cssWidth,
    height = metrics?.cssHeight;
  if (!(width > 0) || !(height > 0)) return null;
  return {
    x: Math.min(width - 1, Math.max(0, Math.round(x * width))),
    y: Math.min(height - 1, Math.max(0, Math.round(y * height))),
  };
}

// Windows virtual key codes CDP needs for keys without text.
const virtualKeys = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Escape: 27,
  " ": 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
  Meta: 91,
};
/** The CDP Input.dispatchKeyEvent parameters for a key command. */
export function keyEvent({ action, key, code, text, modifiers }) {
  const single = key.length === 1;
  const keyCode =
    virtualKeys[key] ??
    (single && /[a-z0-9]/i.test(key) ? key.toUpperCase().charCodeAt(0) : 0);
  // A character goes in with its text, unless a shortcut modifier (Ctrl, Meta) is
  // held; Enter carries "\r". An event with text must be keyDown: Chromium ignores
  // the text of a rawKeyDown, so Enter would neither submit nor break a line.
  const typed =
    action === "down" &&
    (key === "Enter" && !(modifiers & 6)
      ? "\r"
      : text || (single && !(modifiers & 6) ? key : ""));
  return {
    type: action === "up" ? "keyUp" : typed ? "keyDown" : "rawKeyDown",
    key,
    code,
    modifiers,
    windowsVirtualKeyCode: keyCode,
    ...(typed ? { text: typed, unmodifiedText: typed } : {}),
  };
}

/** The CDP calls for one validated command; empty when it cannot be placed. */
export function inputCalls(command, metrics) {
  if (command.type === "text") return [["Input.insertText", { text: command.text }]];
  if (command.type === "key") return [["Input.dispatchKeyEvent", keyEvent(command)]];
  const point = toViewport(command, metrics);
  if (!point) return [];
  if (command.type === "wheel")
    return [
      [
        "Input.dispatchMouseEvent",
        {
          type: "mouseWheel",
          ...point,
          deltaX: command.deltaX,
          deltaY: command.deltaY,
          modifiers: command.modifiers,
        },
      ],
    ];
  return [
    [
      "Input.dispatchMouseEvent",
      {
        type: pointerActions[command.action],
        ...point,
        button: command.button,
        buttons: command.buttons,
        clickCount: command.clickCount,
        modifiers: command.modifiers,
      },
    ],
  ];
}

/**
 * A CDP session on one tab of the agent's browser: its loopback port, the tab's
 * target, one attached flat session; re-attached when the shown tab changes.
 */
export class CdpInput {
  constructor(cdpPort, { fetch = globalThis.fetch, timeoutMs = 2000 } = {}) {
    Object.assign(this, { cdpPort, fetch, timeoutMs });
    this.closed = false;
    this.pending = new Map();
    this.id = 0;
    this.ws = null;
    this.sessionId = null;
    this.targetId = null;
  }
  async connect() {
    if (this.closed) throw Error("closed");
    if (this.ws?.readyState === 1) return;
    const response = await this.fetch(`http://127.0.0.1:${this.cdpPort}/json/version`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const { webSocketDebuggerUrl } = await response.json();
    // Only the browser endpoint on this very loopback port is ever connected.
    const url = new URL(String(webSocketDebuggerUrl));
    if (
      url.protocol !== "ws:" ||
      url.hostname !== "127.0.0.1" ||
      url.port !== String(this.cdpPort) ||
      !url.pathname.startsWith("/devtools/browser/") ||
      url.username ||
      url.password
    )
      throw Error("cdp endpoint");
    if (this.closed) throw Error("closed");
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(url.href);
      this.ws = ws;
      const opening = setTimeout(() => {
        reject(Error("cdp timeout"));
        ws.close();
      }, this.timeoutMs);
      ws.onopen = () => {
        clearTimeout(opening);
        if (this.closed) {
          ws.close();
          return reject(Error("closed"));
        }
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(opening);
        reject(Error("cdp"));
      };
      ws.onclose = () => {
        if (this.ws === ws) this.ws = null;
        this.sessionId = null;
        for (const { reject: fail } of this.pending.values()) fail(Error("closed"));
        this.pending.clear();
      };
      ws.onmessage = (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        const waiting = this.pending.get(message.id);
        if (!waiting) return;
        this.pending.delete(message.id);
        if (message.error) waiting.reject(Error(message.error.message || "cdp"));
        else waiting.resolve(message.result || {});
      };
    });
  }
  send(method, params = {}, sessionId) {
    if (this.ws?.readyState !== 1) return Promise.reject(Error("closed"));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error("timeout"));
      }, this.timeoutMs);
      timer.unref?.();
      const done = (fn) => (value) => {
        clearTimeout(timer);
        fn(value);
      };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject) });
      this.ws.send(
        JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }),
      );
    });
  }
  /**
   * Sends `calls` to tab `targetId`, attaching to it first when needed. Commands
   * go out one after another, in the order the owner made them.
   */
  dispatch(targetId, calls) {
    if (this.closed) return Promise.reject(Error("closed"));
    const next = (this.queue || Promise.resolve())
      .catch(() => {})
      .then(() => this.dispatchNow(targetId, calls));
    this.queue = next;
    return next;
  }
  async dispatchNow(targetId, calls) {
    // Nothing queued reaches the page once the owner handed the browser back.
    if (this.closed) throw Error("closed");
    if (!calls.length) return;
    await this.connect();
    if (this.targetId !== targetId || !this.sessionId) {
      const previous = this.sessionId;
      this.sessionId = null;
      if (previous)
        await this.send("Target.detachFromTarget", { sessionId: previous }).catch(
          () => {},
        );
      const { sessionId } = await this.send("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      this.sessionId = sessionId;
      this.targetId = targetId;
    }
    for (const [method, params] of calls) await this.send(method, params, this.sessionId);
  }
  close() {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* Already closed. */
    }
    this.ws = null;
    this.sessionId = null;
  }
}
