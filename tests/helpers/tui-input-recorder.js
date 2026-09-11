import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

/** A raw TTY recorder owned and removed by an applicationFixture. */
export async function createTuiInputRecorder(fixture, { screen = "" } = {}) {
  const directory = path.join(fixture.root, `tui-recorder-${randomUUID()}`);
  await fs.mkdir(directory);
  const script = path.join(directory, "recorder.mjs");
  const capture = path.join(directory, "bytes");
  const timing = path.join(directory, "timing.jsonl");
  const ready = path.join(directory, "ready");
  await fs.writeFile(capture, "");
  await fs.writeFile(timing, "");
  await fs.writeFile(
    script,
    `import fs from "node:fs";
process.stdin.setRawMode(true);
let offset = 0;
process.stdin.on("data", data => {
  const at = process.hrtime.bigint().toString();
  fs.appendFileSync(${JSON.stringify(capture)}, data);
  fs.appendFileSync(${JSON.stringify(timing)}, JSON.stringify({ at, offset, length: data.length }) + "\\n");
  offset += data.length;
});
process.stdout.write("\\x1b[?2004h" + ${JSON.stringify(screen)});
fs.writeFileSync(${JSON.stringify(ready)}, "ready");
`,
  );
  return {
    command: process.execPath,
    args: [script],
    async waitForText(text, timeout = 5000) {
      const expected = Buffer.from(text);
      const started = performance.now();
      while (performance.now() - started < timeout) {
        // Match the accumulated byte stream, including boundaries across stdin chunks.
        if (text === "ready") {
          if (
            await fs.access(ready).then(
              () => true,
              () => false,
            )
          )
            return;
        } else if ((await fs.readFile(capture)).includes(expected)) return;
        await sleep(10);
      }
      throw new Error(`Recorder did not receive expected ${expected.length} bytes`);
    },
    readBytes: () => fs.readFile(capture),
    async receivedAt() {
      const contents = await fs.readFile(timing, "utf8");
      return contents.trim() ? contents.trim().split("\n").map(JSON.parse) : [];
    },
  };
}
