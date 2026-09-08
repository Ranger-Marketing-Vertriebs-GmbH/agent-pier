import net from "node:net";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { messages, send } from "./wire.js";

/** Reconnectable native-side channel. Only the native owner decides whether a request still exists. */
export class NativeRequestChannel {
  constructor({ env = process.env, onDisconnect = () => {} } = {}) {
    this.onDisconnect = onDisconnect;
    this.launch = JSON.parse(fs.readFileSync(env.AGENTPIER_REQUEST_FILE, "utf8"));
    if (this.launch.token !== env.AGENTPIER_REQUEST_TOKEN)
      throw Error("Invalid native request launch");
    this.epoch = randomUUID();
    this.pending = new Map();
    this.closed = false;
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
    this.connect();
  }
  connect() {
    if (this.closed) return;
    const socket = (this.socket = net.createConnection(this.launch.socketPath));
    socket.on("connect", () =>
      send(socket, {
        type: "hello",
        sessionId: this.launch.id,
        token: this.launch.token,
        epoch: this.epoch,
      }),
    );
    socket.on("error", () => {});
    messages(socket, async (message) => {
      if (message.type === "ready") {
        this.connected = true;
        this.resolveReady();
        for (const [key, entry] of this.pending)
          if (entry.status === "pending")
            send(socket, { type: "publish", key, request: entry.request });
      }
      if (message.type !== "answer") return;
      const entry = this.pending.get(message.key);
      if (!entry || entry.status !== "pending")
        return void send(socket, {
          type: "result",
          delivery: message.delivery,
          status: "stale",
        });
      // Claim before awaiting native I/O; neither reconnect nor duplicate commands can redeliver.
      entry.status = "responding";
      try {
        await entry.deliver(message.answer);
        this.pending.delete(message.key);
        send(socket, { type: "result", delivery: message.delivery, status: "answered" });
      } catch (error) {
        entry.status = error?.stale ? "stale" : "unknown";
        send(socket, {
          type: "result",
          delivery: message.delivery,
          status: entry.status,
        });
      }
    });
    socket.on("close", () => {
      this.connected = false;
      if (!this.closed) this.onDisconnect();
      if (!this.closed) {
        this.timer = setTimeout(() => this.connect(), 1000);
        this.timer.unref?.();
      }
    });
  }
  publish(key, request, deliver) {
    if (this.pending.has(key)) return;
    this.pending.set(key, { request, deliver, status: "pending" });
    if (this.connected) send(this.socket, { type: "publish", key, request });
  }
  resolve(key) {
    this.pending.delete(key);
    send(this.socket, { type: "resolved", key });
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.socket?.destroy();
    this.pending.clear();
  }
}
