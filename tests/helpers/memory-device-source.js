import { assertSource } from "../../server/features/devices/device-source.js";

/** A promise with its `resolve` and `reject`. */
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/**
 * A device source that lives in memory and satisfies the contract of
 * device-source.js, for tests of what is built on a source:
 *
 * - `log`: every call, `[name, id, ...]`, in order
 * - `gates.start`, `gates.stop`, `gates.exec`: `(record) => promise` that the call
 *   awaits before it completes (a rejection fails the call)
 * - `peak`: the most starts, adb calls and live devices (starting, running or
 *   stopping) seen at one moment
 * - `image`: what `reset` answers; `unavailable`: what `availability()` answers
 * - `exit(id, result)`: the device ends by itself, as a crashed emulator does
 */
export function memoryDeviceSource({ image = "android-36-google_apis-r7" } = {}) {
  const states = new Map();
  const log = [];
  const active = { start: 0, exec: 0 };
  const peak = { start: 0, exec: 0, live: 0 };
  const set = (id, state) => {
    if (state) states.set(id, state);
    else states.delete(id);
    const live = [...states.values()].filter((value) => value !== "stopped").length;
    peak.live = Math.max(peak.live, live);
  };
  const during = async (name, work) => {
    peak[name] = Math.max(peak[name], ++active[name]);
    try {
      return await work();
    } finally {
      active[name]--;
    }
  };
  const source = {
    log,
    peak,
    gates: {},
    image,
    unavailable: null,
    onExit: null,
    availability: () => source.unavailable,
    async create(record) {
      log.push(["create", record.id, record.image]);
      set(record.id, "stopped");
    },
    start(record) {
      log.push(["start", record.id]);
      return during("start", async () => {
        set(record.id, "starting");
        try {
          await source.gates.start?.(record);
        } catch (error) {
          set(record.id, "stopped");
          throw error;
        }
        set(record.id, "running");
        return {
          serial: `memory-${record.id}`,
          ...(record.provisioned === false && { provisioned: true }),
        };
      });
    },
    async stop(record) {
      if ((states.get(record.id) ?? "stopped") === "stopped") return;
      log.push(["stop", record.id]);
      set(record.id, "stopping");
      await source.gates.stop?.(record);
      set(record.id, "stopped");
    },
    async reset(record) {
      await source.stop(record);
      log.push(["reset", record.id]);
      return { image: source.image };
    },
    async remove(record) {
      await source.stop(record);
      log.push(["remove", record.id]);
      set(record.id, null);
    },
    state(record) {
      const state = states.get(record.id) ?? "stopped";
      return { state, serial: state === "running" ? `memory-${record.id}` : null };
    },
    exec(record, args, options = {}) {
      log.push(["exec", record.id, args.join(" ")]);
      return during("exec", async () => {
        await source.gates.exec?.(record, args, options);
        return { stdout: `${args.join(" ")}\n`, stderr: "", code: 0, truncated: false };
      });
    },
    ports: (record) => (states.get(record.id) === "running" ? [1, 2] : []),
    async diskBytes(record) {
      return 1000 + record.name.length;
    },
    async reclaim(records) {
      log.push(["reclaim", records.map((record) => record.id)]);
      return [];
    },
    async close({ graceMs } = {}) {
      log.push(["close", graceMs]);
      await Promise.all(
        [...states].map(([id, state]) => state !== "stopped" && source.stop({ id })),
      );
    },
    exit(id, result = { code: 1, signal: null }) {
      set(id, "stopped");
      source.onExit?.(id, result);
    },
    calls: (name) => log.filter(([call]) => call === name).map(([, id]) => id),
  };
  return assertSource(source);
}
