import test from "node:test";
import assert from "node:assert/strict";
import {
  assertWithinLead,
  grantInput,
  grantedKeys,
  memberFolders,
  mergeGrants,
  removeGrants,
} from "../../server/features/assistants/member-grants.js";

const lead = { id: "lead", capabilities: {} };

test("folder grants are validated maps of read or write", () => {
  assert.deepEqual(grantInput({ projects: { b: "write", a: "read" } }), {
    projects: { a: "read", b: "write" },
  });
  assert.deepEqual(grantInput({ projects: {} }), {});
  for (const projects of [{ a: "admin" }, ["a"], { "../a": "read" }, "a"])
    assert.throws(() => grantInput({ projects }), { status: 400 });
  assert.deepEqual(grantedKeys({ projects: { a: "read" } }), ["projects"]);
});

test("a lead grants a folder only at or below its own level", () => {
  const projects = { a: "write", b: "read" };
  assertWithinLead(lead, { projects: { a: "write", b: "read" } }, { projects });
  for (const grants of [{ projects: { b: "write" } }, { projects: { c: "read" } }])
    assert.throws(() => assertWithinLead(lead, grants, { projects }), {
      key: "teamGrantNotHeld",
    });
});

test("a member's folders are its grants within the lead's levels right now", () => {
  const granted = { a: "write", b: "write", c: "read" };
  assert.deepEqual(memberFolders(granted, { a: "write", b: "read" }), {
    a: "write",
    b: "read",
  });
  assert.deepEqual(memberFolders(granted, {}), {});
  assert.deepEqual(memberFolders(undefined, { a: "write" }), {});
});

test("later grants raise a folder level and revoking removes it at any level", () => {
  const next = mergeGrants(
    { projects: { a: "read" } },
    { projects: { a: "write", b: "read" } },
  );
  assert.deepEqual(next.projects, { a: "write", b: "read" });
  assert.deepEqual(
    mergeGrants(next, { projects: { a: "read" } }).projects,
    next.projects,
  );
  assert.deepEqual(removeGrants(next, { projects: { a: "read" } }).projects, {
    b: "read",
  });
  assert.equal(
    removeGrants(next, { projects: { a: "read", b: "read" } }).projects,
    undefined,
  );
});
