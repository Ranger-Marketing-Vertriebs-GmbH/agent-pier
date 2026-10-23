import test from "node:test";
import assert from "node:assert/strict";
import { stableIdentity } from "../../server/features/memory/project-scope.js";

test("stableIdentity ignores only the device number", () => {
  assert.equal(
    stableIdentity(JSON.stringify(["git", "/p/.git", "1", "7"])),
    stableIdentity(JSON.stringify(["git", "/p/.git", "2", "7"])),
  );
  assert.notEqual(
    stableIdentity(JSON.stringify(["git", "/p/.git", "1", "7"])),
    stableIdentity(JSON.stringify(["git", "/p/.git", "1", "8"])),
  );
  assert.equal(stableIdentity("not json"), null);
});
