import test from "node:test";
import assert from "node:assert/strict";
import { addGrant, mergeGrants } from "../../server/features/nono/sandbox-grants.js";

test("addGrant does not mutate the launch it is given", () => {
  const launch = { command: "/bin/claude", args: [] };
  const next = addGrant(launch, { access: "allow", path: "/data" });
  assert.equal(launch.sandboxGrants, undefined);
  assert.deepEqual(next.sandboxGrants, [{ access: "allow", path: "/data" }]);
  assert.equal(next.command, "/bin/claude");
});

test("addGrant appends to existing grants", () => {
  const launch = { sandboxGrants: [{ access: "read", path: "/install" }] };
  const next = addGrant(launch, { access: "allow", path: "/data" });
  assert.deepEqual(next.sandboxGrants, [
    { access: "read", path: "/install" },
    { access: "allow", path: "/data" },
  ]);
  assert.deepEqual(launch.sandboxGrants, [{ access: "read", path: "/install" }]);
});

test("mergeGrants keeps the strongest access for a repeated path", () => {
  assert.deepEqual(
    mergeGrants([
      { access: "read", path: "/data" },
      { access: "allow", path: "/data" },
      { access: "read", path: "/install" },
    ]),
    [
      { access: "allow", path: "/data" },
      { access: "read", path: "/install" },
    ],
  );
});

test("mergeGrants removes exact duplicates", () => {
  assert.deepEqual(
    mergeGrants([
      { access: "allow", path: "/data" },
      { access: "allow", path: "/data" },
    ]),
    [{ access: "allow", path: "/data" }],
  );
});

test("mergeGrants raises read beside write on one path to allow", () => {
  assert.deepEqual(
    mergeGrants([
      { access: "read", path: "/p" },
      { access: "write", path: "/p" },
    ]),
    [{ access: "allow", path: "/p" }],
  );
  // Order must not decide the outcome.
  assert.deepEqual(
    mergeGrants([
      { access: "write", path: "/p" },
      { access: "read", path: "/p" },
    ]),
    [{ access: "allow", path: "/p" }],
  );
});

test("mergeGrants keeps a socket grant beside a filesystem grant on one path", () => {
  // connect() is not a file capability, so neither grant may swallow the other.
  assert.deepEqual(
    mergeGrants([
      { access: "socket", path: "/run/bridge.sock" },
      { access: "read", path: "/run/bridge.sock" },
      { access: "socket", path: "/run/bridge.sock" },
    ]),
    [
      { access: "socket", path: "/run/bridge.sock" },
      { access: "read", path: "/run/bridge.sock" },
    ],
  );
});

test("mergeGrants keeps a socket-dir-bind grant beside a filesystem grant on one path, and beside a plain socket grant", () => {
  // Neither connect()+bind() on a directory's sockets nor connect() on one
  // socket path is a file capability, and they are not the same capability as
  // each other either, so none of the three may collapse into "allow".
  assert.deepEqual(
    mergeGrants([
      { access: "socket-dir-bind", path: "/run/bus" },
      { access: "allow", path: "/run/bus" },
      { access: "socket", path: "/run/bus" },
      { access: "socket-dir-bind", path: "/run/bus" },
    ]),
    [
      { access: "socket-dir-bind", path: "/run/bus" },
      { access: "allow", path: "/run/bus" },
      { access: "socket", path: "/run/bus" },
    ],
  );
});
