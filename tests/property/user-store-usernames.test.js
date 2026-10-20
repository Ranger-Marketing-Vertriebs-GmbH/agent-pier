import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { UserStore } from "../../server/features/users/user-store.js";

// Hashing is not under test: a cheap stand-in keeps each run fast.
const hashPassword = async (value, salt) =>
  Buffer.from(`${salt}${value}`.padEnd(64, "x").slice(0, 64));
const normalise = (name) => name.trim().toLowerCase();
const variant = fc
  .tuple(
    fc.constantFrom("anna", "Anna", "ANNA", "ben", "Bén", "ö", "Ö", "x y"),
    fc.constantFrom("", " ", "  ", "\t"),
    fc.constantFrom("", " ", " "),
  )
  .map(([name, before, after]) => before + name + after);

test("usernames normalise uniquely", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.oneof(variant, fc.string()), { maxLength: 8 }),
      async (names) => {
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-user-names-"));
        try {
          const store = new UserStore({ dataDir, hashPassword });
          const created = new Map();
          for (const username of names) {
            try {
              await store.create({ username, password: "disposable-user-password" });
              const key = normalise(username);
              assert.equal(created.has(key), false);
              created.set(key, username);
            } catch (error) {
              assert.ok([400, 409].includes(error.status), error.message);
            }
          }
          const stored = store.list().map((user) => normalise(user.username));
          assert.equal(new Set(stored).size, stored.length);
        } finally {
          fs.rmSync(dataDir, { recursive: true, force: true });
        }
      },
    ),
    { numRuns: 60 },
  );
});
