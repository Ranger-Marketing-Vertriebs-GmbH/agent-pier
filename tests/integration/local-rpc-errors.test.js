import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

test("repeated post-listen broker errors do not crash AgentPier or disclose details", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-errors-"));
  const module = new URL("../../server/lib/local-rpc-broker.js", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
 import {LocalRpcBroker} from ${JSON.stringify(module)};
 const broker=new LocalRpcBroker({root:process.argv[1],name:'errors',respond:()=>null});
 await broker.ready;
 broker.server.emit('error',new Error('private-first'));
 broker.server.emit('error',new Error('private-second'));
 console.log('alive',broker.server.listening);
 await broker.close();
 `,
      root,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const done = once(child, "close");
  let out = "",
    err = "";
  child.stdout.on("data", (part) => (out += part));
  child.stderr.on("data", (part) => (err += part));
  t.after(async () => {
    child.kill();
    await done;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const [code] = await done;
  assert.equal(code, 0, err);
  assert.match(out, /alive true/);
  assert.doesNotMatch(err, /private-first|private-second/);
});
