import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

/** Compare provider bytes with the native CLI's observed whitespace handling. */
export async function probeNativePayloads({
  tool,
  send,
  capture,
  provider,
  waitFor,
  counts,
}) {
  const multiline =
    "AP_PROBE_MULTILINE\r\nGrüße 世界 🙂\rPath: /tmp/Synthetic Folder/datei ü.txt\nA\tB\nLast line";
  const long =
    "AP_PROBE_LONG\n" +
    Array.from(
      { length: 120 },
      (_, n) =>
        `Line ${String(n).padStart(3, "0")}: synthetic content ünicode and /tmp/Folder With Spaces/file.txt.`,
    ).join("\n");
  const results = [];
  for (const text of [multiline, long]) {
    const marker = text.match(/AP_PROBE_[A-Z]+/)[0];
    const normalized = text.replace(/\r\n?/g, "\n");
    const nativeText =
      tool === "claude"
        ? normalized.replaceAll("\t", "    ")
        : tool === "opencode"
          ? normalized + " "
          : normalized;
    const expected = {
      marker,
      length: Buffer.byteLength(nativeText),
      sha256: createHash("sha256").update(nativeText).digest("hex"),
    };
    const offset = provider.events.length;
    const before = { ...counts };
    await send(text);
    assert.equal(counts.paste - before.paste, 1);
    assert.equal(counts.submit - before.submit, 1);
    const matching = () =>
      provider.events
        .slice(offset)
        .filter((event) => event.kind === "request")
        .flatMap((event) => event.payloads || [])
        .filter((payload) => payload.marker === marker);
    await waitFor(matching, (payloads) =>
      payloads.some((payload) => payload.sha256 === expected.sha256),
    ).catch((error) => {
      console.error(
        "PAYLOAD_MISMATCH",
        JSON.stringify({ expected, observed: matching() }),
      );
      throw error;
    });
    assert.ok(
      matching().some(
        (payload) =>
          payload.length === expected.length && payload.sha256 === expected.sha256,
      ),
    );
    await waitFor(capture, (screen) =>
      screen.includes(`Synthetic response complete: ${marker}`),
    );
    results.push({
      ...expected,
      normalizedLength: Buffer.byteLength(normalized),
      normalizedSha256: createHash("sha256").update(normalized).digest("hex"),
      acceptedExactly: nativeText === normalized,
      nativeNormalization:
        nativeText === normalized
          ? "none"
          : tool === "claude"
            ? "tab-to-four-spaces"
            : "appended-one-space",
      acceptedAfterNativeNormalization: true,
      paste: 1,
      submit: 1,
    });
    await sleep(50);
  }
  return results;
}
