import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { terminalKey } from "../web/features/terminal/terminal-keyboard.js";

export async function probeTerminalKeyboard({
  manager,
  session,
  capture,
  provider,
  waitFor,
}) {
  let output = "";
  const client = await manager.attach(session.id, {
    onData: (text) => {
      output += text;
    },
  });
  try {
    await waitFor(
      () => output,
      (text) => text.includes("\x1b[?2004h"),
    );
    const marker = "AP_PROBE_MULTILINE";
    const text = `${marker}\nsecond line ünicode`;
    const offset = provider.events.length;
    await client.write(marker);
    await waitFor(capture, (screen) => screen.includes(marker));
    await client.write(terminalKey({ type: "keydown", key: "Enter", shiftKey: true }));
    await client.write("second line ünicode");
    await waitFor(capture, (screen) => screen.includes("second line ünicode"));
    await sleep(750);
    assert.equal(
      provider.events.slice(offset).filter((event) => event.marker === marker).length,
      0,
      "Shift+Enter must leave both lines in the native composer without submitting",
    );
    await client.write("\r");
    const expected = createHash("sha256").update(text).digest("hex");
    const payloads = () =>
      provider.events.slice(offset).flatMap((event) => event.payloads || []);
    await waitFor(payloads, (rows) => rows.some((row) => row.sha256 === expected)).catch(
      async (error) => {
        console.error(
          "KEYBOARD_PAYLOAD_MISMATCH",
          JSON.stringify({ expected, observed: payloads() }),
        );
        console.error(
          "KEYBOARD_SCREEN",
          (await capture()).replaceAll(session.cwd, "<fixture-project>"),
        );
        console.error("KEYBOARD_EVENTS", JSON.stringify(provider.events.slice(offset)));
        throw error;
      },
    );
    await waitFor(capture, (screen) =>
      screen.includes(`Synthetic response complete: ${marker}`),
    );
    return {
      newlineWithoutSubmit: true,
      acceptedExactMultilineAfterEnter: true,
      sha256: expected,
    };
  } finally {
    client.dispose();
  }
}
