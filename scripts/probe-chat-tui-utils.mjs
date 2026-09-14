import { setTimeout as sleep } from "node:timers/promises";

export async function waitFor(read, predicate, timeout = 15000) {
  const started = performance.now();
  while (performance.now() - started < timeout) {
    const value = await read();
    if (predicate(value)) return value;
    await sleep(20);
  }
  throw new Error("Probe observation timed out; no submit is retried");
}

export function summary(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1),
  };
}
