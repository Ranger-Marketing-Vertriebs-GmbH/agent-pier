// Test-only launcher preload (NODE_OPTIONS=--import=<this file>): swallows the adapter's
// `ready` message and writes the adapter PID to $HOLD_MARKER, so the launcher stays in its
// adapter start phase until a signal arrives. The adapter's env never carries NODE_OPTIONS
// (adapterEnvironment derives it), so only the launcher is affected.
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const original = cp.spawn;
cp.spawn = (...args) => {
  const child = original(...args);
  if (String(args[1]).includes("adapter-process.js")) {
    const emit = child.emit;
    child.emit = function (event, message, ...rest) {
      if (event === "message" && message?.type === "ready") {
        fs.writeFileSync(process.env.HOLD_MARKER, String(child.pid));
        return true; // held: the launcher stays in its start phase
      }
      return emit.call(this, event, message, ...rest);
    };
  }
  return child;
};
syncBuiltinESMExports();
