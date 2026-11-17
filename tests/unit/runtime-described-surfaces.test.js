import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  RUNTIME_SLOTS,
  defineRuntimeDescriptor,
} from "../../server/features/assistants/runtimes/agent-runtime.js";
import { validFieldValue } from "../../server/features/assistants/runtimes/runtime-surfaces.js";
import {
  RuntimeSettingStore,
  hostFields,
  ownSettings,
} from "../../server/features/assistants/runtimes/runtime-settings.js";
import { migrateAssistants } from "../../server/features/assistants/assistant-schema.js";
import { hermesDescriptor } from "../../server/features/assistants/runtimes/hermes/descriptor.js";
import { openClawDescriptor } from "../../server/features/assistants/runtimes/openclaw/descriptor.js";
import {
  fixtureDescriptor,
  fixtureFields,
  fixtureSurface,
} from "../helpers/runtime-fixture.js";

// ADR 0007, step 4: a described surface is a list of fields AgentPier renders,
// validates and stores for the runtime. Its advanced settings for all agents
// (`scope: "host"`) sit at the slot `hub.runtime.advanced`.

const describe = (surfaces) => defineRuntimeDescriptor({ id: "x", name: "X", surfaces });
const described = (fields, extra = {}) => ({ ...fixtureSurface, fields, ...extra });
const field = (extra = {}) => ({
  id: "delegation",
  type: "toggle",
  default: false,
  apply: "live",
  ...extra,
});

test("the advanced rows of a runtime have a slot of their own", () => {
  assert.ok(RUNTIME_SLOTS.includes("hub.runtime.advanced"));
});

test("a descriptor resolves a described surface with its fields, frozen", () => {
  const [surface] = fixtureDescriptor.surfaces;
  assert.deepEqual(surface, {
    id: "tuning",
    slot: "hub.runtime.advanced",
    kind: "described",
    shows: "whileEnabled",
    scope: "host",
    fields: fixtureFields,
  });
  assert.ok(Object.isFrozen(surface.fields));
  assert.ok(Object.isFrozen(surface.fields[1]));
  assert.ok(Object.isFrozen(surface.fields[1].options));
  // The list is sent as JSON: the fields survive it unchanged.
  assert.deepEqual(JSON.parse(JSON.stringify(surface)), surface);
});

test("a wrong described surface fails as the module loads, naming what is wrong", () => {
  const select = { id: "effort", type: "select", default: "low", apply: "live" };
  const number = { id: "workers", type: "number", default: 2, apply: "restart" };
  const refused = [
    [[described([field()], { scope: undefined })], /tuning: unknown scope/],
    [[described([field()], { scope: "agent" })], /tuning: unknown scope "agent"/],
    [[described([field()], { slot: "hub.runtime" })], /tuning: described .* slot/],
    [[described(undefined)], /tuning: a described surface needs fields/],
    [[described([])], /tuning: a described surface needs fields/],
    [[described([null])], /tuning: a field needs an id/],
    [[described([field({ id: "Not valid" })])], /tuning: a field needs an id/],
    [[described([field(), field()])], /tuning: duplicate field id delegation/],
    [[described([field({ type: "color" })])], /delegation: unknown type "color"/],
    [[described([field({ type: undefined })])], /delegation: unknown type/],
    [[described([select])], /effort: a select needs options/],
    [[described([{ ...select, options: [] }])], /effort: a select needs options/],
    [[described([{ ...select, options: ["low", 2] }])], /effort: a select needs options/],
    [
      [described([{ ...select, options: ["low", "low"] }])],
      /effort: a select needs options/,
    ],
    [[described([field({ options: ["a"] })])], /delegation: options on a toggle/],
    [[described([field({ min: 0 })])], /delegation: min on a toggle/],
    [[described([field({ max: 1 })])], /delegation: max on a toggle/],
    [[described([field({ step: 1 })])], /delegation: step on a toggle/],
    [[described([field({ unit: "count" })])], /delegation: unit on a toggle/],
    [[described([{ ...number, min: "1" }])], /workers: min must be a number/],
    [[described([{ ...number, min: 5, max: 3 }])], /workers: min above max/],
    [[described([{ ...number, step: 0 }])], /workers: step must be above 0/],
    [[described([{ ...number, default: 9, max: 8 }])], /workers: unknown default 9/],
    [[described([field({ default: undefined })])], /delegation: unknown default/],
    [[described([field({ default: "yes" })])], /delegation: unknown default "yes"/],
    [[described([{ ...select, options: ["low"], default: "high" }])], /unknown default/],
    [[described([field({ apply: "hot" })])], /delegation: unknown apply "hot"/],
    [[described([field({ apply: undefined })])], /delegation: unknown apply/],
    [[described([field({ label: "Delegation" })])], /delegation: unknown key label/],
    // Two surfaces of one runtime share its store: a field id is the runtime's.
    [
      [described([field()]), described([field()], { id: "more" })],
      /more: duplicate field id delegation/,
    ],
    // A built surface has no fields, and nothing but a described one a scope.
    [
      [{ id: "install", slot: "hub.runtime", kind: "built", fields: [field()] }],
      /install: unknown key fields/,
    ],
    [
      [{ id: "install", slot: "hub.runtime", kind: "built", scope: "host" }],
      /install: unknown key scope/,
    ],
    [[described([field()], { more: 1 })], /tuning: unknown key more/],
  ];
  for (const [surfaces, message] of refused)
    assert.throws(
      () => describe(surfaces),
      (error) => error instanceof TypeError && message.test(error.message),
      JSON.stringify(surfaces),
    );
});

test("a field accepts the values its description allows, and nothing else", () => {
  const [toggle, select, number, text] = fixtureFields;
  const accepted = [
    [toggle, [true, false]],
    [select, ["low", "high"]],
    [number, [1, 2, 8]],
    [text, ["", "Hello", "x".repeat(500)]],
  ];
  const refused = [
    [toggle, [0, "true", null, undefined, {}]],
    [select, ["medium", "", 1, null, ["low"]]],
    [number, [0, 9, 1.5, "2", Number.NaN, Infinity, null]],
    [text, [1, null, "x".repeat(501), "line\nbreak", "bell\u0007", {}]],
  ];
  for (const [described, values] of accepted)
    for (const value of values)
      assert.equal(validFieldValue(described, value), true, `${described.id}: ${value}`);
  for (const [described, values] of refused)
    for (const value of values)
      assert.equal(
        validFieldValue(described, value),
        false,
        `${described.id}: ${JSON.stringify(value)}`,
      );
  // Without bounds or a step any finite number is one.
  const free = { id: "ratio", type: "number", default: 0, apply: "live" };
  assert.equal(validFieldValue(free, -2.25), true);
  assert.equal(validFieldValue({ ...free, min: 0, step: 0.1 }, 0.3), true);
  assert.equal(validFieldValue({ ...free, min: 0, step: 0.1 }, 0.35), false);
});

test("hostFields: the described advanced fields of a runtime, with their surface", () => {
  assert.deepEqual(
    hostFields(fixtureDescriptor).map(({ surface, id }) => [surface, id]),
    [
      ["tuning", "delegation"],
      ["tuning", "effort"],
      ["tuning", "workers"],
      ["tuning", "greeting"],
    ],
  );
  // No shipped runtime describes a setting of its own yet.
  assert.deepEqual(hostFields(openClawDescriptor), []);
  assert.deepEqual(hostFields(hermesDescriptor), []);
  assert.deepEqual(hostFields(undefined), []);
});

function database() {
  const db = new DatabaseSync(":memory:");
  migrateAssistants(db);
  return db;
}

test("a runtime's own settings are stored by runtime id and field id", () => {
  const db = database();
  const store = new RuntimeSettingStore(db);
  assert.deepEqual(store.list("fixture"), []);
  store.set("fixture", "workers", 4);
  store.set("fixture", "delegation", true);
  store.set("other", "workers", 7);
  assert.deepEqual(store.list("fixture"), [
    { field: "delegation", value: true, revision: 1 },
    { field: "workers", value: 4, revision: 1 },
  ]);
  store.set("fixture", "workers", 5);
  assert.deepEqual(store.get("fixture", "workers"), {
    field: "workers",
    value: 5,
    revision: 2,
  });
  assert.equal(store.get("fixture", "greeting"), null);
  store.remove("fixture", "workers");
  assert.equal(store.get("fixture", "workers"), null);
  assert.deepEqual(store.list("other"), [{ field: "workers", value: 7, revision: 1 }]);
  // Only a plain scalar is ever stored.
  for (const value of [null, undefined, {}, ["a"], Number.NaN])
    assert.throws(() => store.set("fixture", "greeting", value), { key: "invalid" });
  for (const [runtime, name] of [
    ["", "workers"],
    ["fixture", ""],
    [1, "workers"],
  ])
    assert.throws(() => store.set(runtime, name, 1), { key: "invalid" });
});

test("the shared overrides and a runtime's own settings do not meet", () => {
  const db = database();
  new RuntimeSettingStore(db).set("fixture", "workers", 4);
  assert.deepEqual(db.prepare("SELECT * FROM openclaw_overrides").all(), []);
  assert.deepEqual(
    db
      .prepare("SELECT runtime, field, value, revision FROM runtime_settings")
      .all()
      .map((row) => ({ ...row })),
    [{ runtime: "fixture", field: "workers", value: "4", revision: 1 }],
  );
});

test("ownSettings: every field's stored value, else its default", () => {
  const db = database();
  const store = new RuntimeSettingStore(db);
  const defaults = { delegation: false, effort: "low", workers: 2, greeting: "" };
  assert.deepEqual(ownSettings(fixtureDescriptor, store), defaults);
  store.set("fixture", "workers", 4);
  store.set("fixture", "greeting", "Hello");
  assert.deepEqual(ownSettings(fixtureDescriptor, store), {
    ...defaults,
    workers: 4,
    greeting: "Hello",
  });
  assert.ok(Object.isFrozen(ownSettings(fixtureDescriptor, store)));
});

test("a stored value its descriptor no longer names or accepts is ignored", () => {
  const db = database();
  const skipped = [];
  const store = new RuntimeSettingStore(db, {
    onSkip: (runtime, name) => skipped.push(`${runtime}.${name}`),
  });
  // A field a later descriptor dropped, a value out of today's range, and a row
  // that is no JSON: none is an error, each field falls back to its default.
  store.set("fixture", "retired", "x");
  store.set("fixture", "workers", 64);
  db.prepare(
    "INSERT INTO runtime_settings (runtime, field, value, revision) VALUES (?, ?, ?, 1)",
  ).run("fixture", "effort", "{broken");
  assert.deepEqual(ownSettings(fixtureDescriptor, store), {
    delegation: false,
    effort: "low",
    workers: 2,
    greeting: "",
  });
  assert.deepEqual(skipped, ["fixture.effort"]);
  // A runtime without described fields has no settings of its own.
  assert.deepEqual(ownSettings(openClawDescriptor, store), {});
  // An unreadable store leaves the defaults.
  const closed = {
    list: () => {
      throw Error("closed");
    },
  };
  assert.deepEqual(ownSettings(fixtureDescriptor, closed).workers, 2);
});
