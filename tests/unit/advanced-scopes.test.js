import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage } from "../../web/lib/i18n/index.js";
import { assistantAdvancedCopy as copy } from "../../web/lib/i18n/messages/assistant-advanced.js";
import {
  advancedNotes,
  ownRows,
  settingScope,
} from "../../web/features/assistants/hub/advanced-scopes.js";
import {
  advancedKey,
  advancedServer,
  ownFieldError,
  ownKey,
  runtimeSteps,
} from "../../web/features/assistants/hub/runtime-draft.js";
import {
  slotEntries,
  slotSurfaces,
  surfaceKey,
} from "../../web/features/assistants/runtime-surfaces.js";
import { runtimeFieldCopy } from "../../web/features/assistants/runtimes/fields.js";
import { hermesDescriptor } from "../../server/features/assistants/runtimes/hermes/descriptor.js";
import { openClawDescriptor } from "../../server/features/assistants/runtimes/openclaw/descriptor.js";
import { missingFieldCopy } from "../helpers/described-field-copy.js";
import { fixtureDescriptor, fixtureFields } from "../helpers/runtime-fixture.js";

// ADR 0007, step 4, the web app's half: Agents › Runtime › Advanced renders from the
// runtimes the server lists and names none itself.

const service = (extra = {}) => ({
  id: "one",
  name: "One",
  shortName: "One",
  process: "shared",
  enabled: true,
  running: true,
  version: "1.0",
  qualified: true,
  agents: 2,
  own: [],
  ...extra,
});
const second = (extra = {}) => ({
  id: "two",
  name: "Two Agent",
  shortName: "Two",
  process: "perAgent",
  enabled: true,
  running: null,
  version: "0.5",
  qualified: true,
  agents: 1,
  own: [],
  ...extra,
});
const taken = (apply = "hot", available = true) => ({ apply, available, current: null });
const kinds = (notes) => notes.map((note) => note.kind);

test("the notes of the agent service: an unapproved version, or a stopped service", () => {
  assert.deepEqual(advancedNotes(null), []);
  assert.deepEqual(advancedNotes({ runtimes: [service()] }), []);
  assert.deepEqual(advancedNotes({ runtimes: [service({ running: false })] }), [
    { kind: "stopped" },
  ]);
  // An unapproved version says so, whether the service runs or not.
  assert.deepEqual(
    advancedNotes({
      runtimes: [service({ qualified: false, running: false, version: "0.9" })],
    }),
    [{ kind: "unqualified", version: "0.9" }],
  );
});

test("a further runtime is named only while it is enabled and has agents", () => {
  const notes = (extra) => advancedNotes({ runtimes: [service(), second(extra)] });
  assert.deepEqual(notes({ enabled: false }), []);
  assert.deepEqual(notes({ agents: 0 }), []);
  assert.deepEqual(notes({}), [{ kind: "applies", only: "One", name: "Two" }]);
  assert.deepEqual(notes({ qualified: false, version: "0.6" }), [
    { kind: "otherUnqualified", product: "Two Agent", version: "0.6", name: "Two" },
  ]);
  // Its own host is never "the agent service".
  assert.deepEqual(
    kinds(advancedNotes({ runtimes: [service({ running: false }), second()] })),
    ["stopped", "applies"],
  );
});

test("a row shows how the first runtime that takes it does, and names the others", () => {
  const data = { runtimes: [service(), second()] };
  const both = { id: "a", runtimes: { one: taken(), two: taken("restart") } };
  const alone = { id: "b", runtimes: { one: taken("restart") } };
  assert.deepEqual(settingScope(data, both), {
    taken: both.runtimes.one,
    pills: [{ kind: "restart", name: "Two" }],
  });
  assert.deepEqual(settingScope(data, alone), {
    taken: alone.runtimes.one,
    pills: [{ kind: "only", name: "One", other: "Two" }],
  });
  // Taken live by both: nothing to add.
  const live = { id: "c", runtimes: { one: taken(), two: taken() } };
  assert.deepEqual(settingScope(data, live).pills, []);
  // An installation the mapping is not approved for takes none: no restart to name.
  const unapproved = {
    id: "d",
    runtimes: { one: taken(), two: taken("restart", false) },
  };
  assert.deepEqual(settingScope(data, unapproved).pills, []);
  // Without agents on the further runtime, or while it is off, nothing is said.
  for (const extra of [{ agents: 0 }, { enabled: false }]) {
    const quiet = { runtimes: [service(), second(extra)] };
    assert.deepEqual(settingScope(quiet, both).pills, []);
    assert.deepEqual(settingScope(quiet, alone).pills, []);
  }
  // A setting the first runtime does not take shows how the one that does takes it.
  const other = { id: "e", runtimes: { two: taken("restart") } };
  assert.deepEqual(settingScope(data, other), {
    taken: other.runtimes.two,
    pills: [{ kind: "only", name: "Two", other: "One" }],
  });
  // One "only" pill, however many runtimes lack the setting.
  const three = {
    runtimes: [service(), second(), second({ id: "three", shortName: "Three" })],
  };
  assert.deepEqual(settingScope(three, alone).pills, [
    { kind: "only", name: "One", other: "Two" },
  ]);
  assert.deepEqual(settingScope(null, alone), { taken: alone.runtimes.one, pills: [] });
});

test("the notes read as before with the shipped runtimes' names, in both languages", (t) => {
  t.after(() => setLanguage("de"));
  setLanguage("en");
  assert.equal(copy.runtimeOnly("OpenClaw"), "OpenClaw only");
  assert.equal(copy.runtimeRestart("Hermes"), "Restarts Hermes agents");
  assert.equal(
    copy.runtimeOnlyLabel("OpenClaw", "Hermes"),
    "Applies to OpenClaw agents only; Hermes agents keep Hermes's default",
  );
  assert.equal(
    copy.runtimeRestartLabel("Hermes"),
    "Hermes agents restart to take a change",
  );
  assert.equal(
    copy.runtimeApplies("OpenClaw", "Hermes"),
    "Settings without “OpenClaw only” also apply to Hermes agents.",
  );
  assert.equal(
    copy.runtimeUnqualified("Hermes Agent", "0.23.0", "Hermes"),
    "Hermes Agent 0.23.0 is not approved for these settings. Hermes agents start with Hermes's defaults until the approved version runs.",
  );
  setLanguage("de");
  assert.equal(copy.runtimeOnly("OpenClaw"), "Nur OpenClaw");
  assert.equal(copy.runtimeRestart("Hermes"), "Startet Hermes-Agenten neu");
  assert.equal(
    copy.runtimeOnlyLabel("OpenClaw", "Hermes"),
    "Gilt nur für OpenClaw-Agenten; Hermes-Agenten behalten den Standard von Hermes",
  );
  assert.equal(
    copy.runtimeRestartLabel("Hermes"),
    "Hermes-Agenten starten neu, um eine Änderung zu übernehmen",
  );
  assert.equal(
    copy.runtimeApplies("OpenClaw", "Hermes"),
    "Einstellungen ohne „Nur OpenClaw“ gelten auch für Hermes-Agenten.",
  );
  assert.equal(
    copy.runtimeUnqualified("Hermes Agent", "0.23.0", "Hermes"),
    "Hermes Agent 0.23.0 ist für diese Einstellungen nicht freigegeben. Hermes-Agenten starten mit den Standards von Hermes, bis die freigegebene Version läuft.",
  );
});

// A runtime's own described settings.

const texts = {
  delegation: { label: "Delegation", hint: "Hands work to helpers." },
  effort: { label: "Effort", hint: "How hard.", options: { low: "Low", high: "High" } },
  workers: { label: "Workers", hint: "How many." },
};
const own = fixtureFields.map((field) => ({
  surface: "tuning",
  ...field,
  value: field.id === "workers" ? 4 : null,
}));

test("the draft holds the shared overrides and each runtime's own values", () => {
  const data = {
    runtimes: [service(), second({ id: "fixture", own })],
    settings: [{ id: "runTimeout", override: 900 }, { id: "x" }],
  };
  assert.deepEqual(advancedServer(data), {
    [advancedKey("runTimeout")]: 900,
    [advancedKey("x")]: "",
    // A field without a stored value shows its default.
    [ownKey("fixture", "delegation")]: false,
    [ownKey("fixture", "effort")]: "low",
    [ownKey("fixture", "workers")]: 4,
    [ownKey("fixture", "greeting")]: "",
  });
  assert.deepEqual(advancedServer(null), {});
});

test("ownRows: a surface's fields this build has texts for, with their values", () => {
  const data = { runtimes: [service(), second({ id: "fixture", own })] };
  const surface = { id: "tuning", fields: fixtureFields };
  const rows = ownRows(data, { id: "fixture" }, surface, (id) => texts[id]);
  // "greeting" has no text here (a newer server): it is left out.
  assert.deepEqual(
    rows.map((row) => [row.field.id, row.key, row.text.label]),
    [
      ["delegation", ownKey("fixture", "delegation"), "Delegation"],
      ["effort", ownKey("fixture", "effort"), "Effort"],
      ["workers", ownKey("fixture", "workers"), "Workers"],
    ],
  );
  // Before the settings are read there is no value to show, so no row.
  assert.deepEqual(
    ownRows(null, { id: "fixture" }, surface, (id) => texts[id]),
    [],
  );
  assert.deepEqual(
    ownRows(data, { id: "other" }, surface, (id) => texts[id]),
    [],
  );
});

test("an own value outside its description is refused before a request", () => {
  const [toggle, select, number, text] = fixtureFields;
  assert.equal(ownFieldError(number, 4, "Workers"), "");
  assert.equal(ownFieldError(number, "", "Workers"), "");
  assert.match(ownFieldError(number, 64, "Workers"), /^Workers: .*1.*8/);
  assert.match(ownFieldError(number, 1.5, "Workers"), /^Workers: /);
  const free = { id: "ratio", type: "number", default: 0, apply: "live" };
  assert.equal(ownFieldError(free, -2.5, "Ratio"), "");
  assert.match(ownFieldError({ ...free, min: 0 }, -1, "Ratio"), /^Ratio: /);
  assert.equal(ownFieldError(toggle, true, "Delegation"), "");
  assert.equal(ownFieldError(select, "high", "Effort"), "");
  assert.equal(ownFieldError(text, "Hello", "Greeting"), "");
  assert.match(ownFieldError(text, "x".repeat(501), "Greeting"), /^Greeting: /);
});

test("a save names a shared setting by id and a runtime's own by runtime and field", async () => {
  const calls = [];
  const api = { saveAdvancedSetting: async (body) => (calls.push(body), { saved: 1 }) };
  const seen = [];
  const steps = runtimeSteps({
    api,
    setEnabled: async () => ({}),
    refresh: { assistants: async () => {}, dreaming: async () => {} },
    settings: [{ id: "runTimeout", type: "integer", minimum: 300 }],
    own: [
      {
        runtime: "fixture",
        field: own[2],
        key: ownKey("fixture", "workers"),
        text: texts.workers,
      },
      {
        runtime: "fixture",
        field: own[1],
        key: ownKey("fixture", "effort"),
        text: texts.effort,
      },
    ],
    onAdvanced: (next) => seen.push(next),
  }).slice(5);
  assert.deepEqual(
    steps.map((step) => [step.id, step.keys, step.label]),
    [
      ["advanced-runTimeout", [advancedKey("runTimeout")], steps[0].label],
      ["own-fixture-workers", [ownKey("fixture", "workers")], "Workers"],
      ["own-fixture-effort", [ownKey("fixture", "effort")], "Effort"],
    ],
  );
  const values = {
    [advancedKey("runTimeout")]: 900,
    [ownKey("fixture", "workers")]: 6,
    [ownKey("fixture", "effort")]: "low",
  };
  await steps[0].run({ values });
  await steps[1].run({ values, confirmations: { confirmRestart: true } });
  // The default is sent as a reset, so the field follows its default again.
  await steps[2].run({ values });
  await steps[1].run({ values: { [ownKey("fixture", "workers")]: "" } });
  assert.deepEqual(calls, [
    { setting: "runTimeout", value: 900 },
    { runtime: "fixture", field: "workers", value: 6, confirmRestart: true },
    { runtime: "fixture", field: "effort", value: null },
    { runtime: "fixture", field: "workers", value: null },
  ]);
  assert.equal(seen.length, 4);
});

test("only an emptied number resets an own field; an emptied text is saved empty", async () => {
  const calls = [];
  const api = { saveAdvancedSetting: async (body) => (calls.push(body), {}) };
  const field = (extra) => ({ surface: "tuning", apply: "live", ...extra });
  const fields = [
    field({ id: "greeting", type: "text", default: "Hello" }),
    field({ id: "note", type: "text", default: "" }),
    field({ id: "workers", type: "number", default: 2 }),
  ];
  const steps = runtimeSteps({
    api,
    setEnabled: async () => ({}),
    refresh: { assistants: async () => {}, dreaming: async () => {} },
    own: fields.map((entry) => ({
      runtime: "fixture",
      field: entry,
      key: ownKey("fixture", entry.id),
      text: { label: entry.id },
    })),
  }).slice(5);
  const values = Object.fromEntries(fields.map(({ id }) => [ownKey("fixture", id), ""]));
  for (const step of steps) await step.run({ values });
  assert.deepEqual(calls, [
    // A text with a default of its own can be emptied.
    { runtime: "fixture", field: "greeting", value: "" },
    // Empty is this text's default: a reset.
    { runtime: "fixture", field: "note", value: null },
    { runtime: "fixture", field: "workers", value: null },
  ]);
});

test("slotEntries: built and described surfaces of a slot that show", () => {
  const runtimes = [
    {
      id: "one",
      ready: true,
      surfaces: [
        {
          id: "rows",
          slot: "hub.runtime.advanced",
          kind: "built",
          shows: "whileEnabled",
        },
        {
          id: "tuning",
          slot: "hub.runtime.advanced",
          kind: "described",
          shows: "whileEnabled",
          scope: "host",
          fields: fixtureFields,
        },
        { id: "later", slot: "hub.runtime.advanced", kind: "sketched", shows: "always" },
      ],
    },
    {
      id: "two",
      ready: false,
      surfaces: [
        {
          id: "tuning",
          slot: "hub.runtime.advanced",
          kind: "described",
          shows: "whileEnabled",
          scope: "host",
          fields: fixtureFields,
        },
      ],
    },
  ];
  assert.deepEqual(slotEntries(runtimes, "hub.runtime.advanced").map(surfaceKey), [
    "one:rows",
    "one:tuning",
  ]);
  // The search lists built surfaces alone.
  assert.deepEqual(slotSurfaces(runtimes, "hub.runtime.advanced").map(surfaceKey), [
    "one:rows",
  ]);
  assert.deepEqual(slotEntries(undefined, "hub.runtime.advanced"), []);
});

test("every described field of a shipped runtime has a label and a hint in both languages", (t) => {
  t.after(() => setLanguage("de"));
  const copyOf = (descriptor) => (language) => {
    setLanguage(language);
    return Object.fromEntries(
      descriptor.surfaces
        .flatMap((surface) => surface.fields || [])
        .map((field) => [field.id, runtimeFieldCopy(descriptor.id, field.id)]),
    );
  };
  for (const descriptor of [openClawDescriptor, hermesDescriptor])
    assert.deepEqual(missingFieldCopy(descriptor, copyOf(descriptor)), [], descriptor.id);
  assert.equal(runtimeFieldCopy("next", "workers"), undefined);
  assert.equal(runtimeFieldCopy("toString", "workers"), undefined);
});

test("the check names each text a described field lacks", () => {
  const complete = { ...texts, greeting: { label: "Greeting", hint: "What it says." } };
  assert.deepEqual(
    missingFieldCopy(fixtureDescriptor, () => complete),
    [],
  );
  const german = {
    ...complete,
    workers: { label: "Arbeiter" },
    effort: { label: "Aufwand", hint: "Wie sehr.", options: { low: "Niedrig" } },
  };
  const english = { ...complete, greeting: undefined };
  assert.deepEqual(
    missingFieldCopy(fixtureDescriptor, (language) =>
      language === "de" ? german : english,
    ),
    [
      "de: fixture.effort.options.high",
      "de: fixture.workers.hint",
      "en: fixture.greeting.label",
      "en: fixture.greeting.hint",
    ],
  );
  // No catalog at all for the runtime: every text is missing.
  assert.equal(missingFieldCopy(fixtureDescriptor, () => undefined).length, 20);
});
