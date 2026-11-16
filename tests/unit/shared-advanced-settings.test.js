import test from "node:test";
import assert from "node:assert/strict";
import {
  sharedSetting,
  sharedSettings,
  validSharedValue,
} from "../../server/features/assistants/runtimes/shared-settings.js";
import {
  advancedSettings,
  settingBounds,
  validSettingValue,
} from "../../server/features/assistants/runtimes/openclaw/openclaw-config/advanced-settings.js";
import { hermesAdvancedSettings } from "../../server/features/assistants/runtimes/hermes/hermes-config/advanced.js";

// ADR 0007, step 4: the shared advanced settings are AgentPier's. Each runtime states
// which of them it takes and how (its compiler's `advancedSettings`).

test("the shared settings name no runtime's path or reload kind", () => {
  assert.deepEqual(
    sharedSettings.map((setting) => setting.id),
    [
      "runTimeout",
      "thinkingDefault",
      "userTimezone",
      "imageQuality",
      "imageMaxDimension",
      "mediaRetention",
    ],
  );
  for (const setting of sharedSettings) {
    assert.ok(Object.isFrozen(setting), setting.id);
    assert.equal(sharedSetting(setting.id), setting);
    for (const key of ["path", "reloadKind", "schema", "limits", "env"])
      assert.equal(Object.hasOwn(setting, key), false, `${setting.id}.${key}`);
    assert.ok(["runs", "media"].includes(setting.group), setting.id);
    assert.ok(["integer", "string"].includes(setting.type), setting.id);
  }
  assert.equal(sharedSetting("gateway"), undefined);
  assert.equal(sharedSetting("toString"), undefined);
});

test("the shared bounds, options and defaults are what the page showed before", () => {
  const view = ({ id, path: _path, schema: _schema, limits: _limits, ...rest }) => ({
    id,
    ...rest,
  });
  assert.deepEqual(sharedSettings.map(view), [
    {
      id: "runTimeout",
      group: "runs",
      type: "integer",
      minimum: 300,
      maximum: 604800,
      unit: "seconds",
      fallback: 172800,
    },
    {
      id: "thinkingDefault",
      group: "runs",
      type: "string",
      options: [
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "adaptive",
        "max",
        "ultra",
      ],
      fallback: null,
    },
    {
      id: "userTimezone",
      group: "runs",
      type: "string",
      format: "timeZone",
      fallback: null,
    },
    {
      id: "imageQuality",
      group: "media",
      type: "string",
      options: ["auto", "efficient", "balanced", "high"],
      fallback: "auto",
    },
    {
      id: "imageMaxDimension",
      group: "media",
      type: "integer",
      minimum: 256,
      maximum: 2000,
      unit: "pixels",
      fallback: 1200,
    },
    {
      id: "mediaRetention",
      group: "media",
      type: "integer",
      minimum: 48,
      maximum: 168,
      unit: "hours",
      fallback: null,
    },
  ]);
});

test("OpenClaw takes every shared setting, with the shared group, unit and bounds", () => {
  assert.deepEqual(
    advancedSettings.map((setting) => setting.id),
    sharedSettings.map((setting) => setting.id),
  );
  for (const setting of advancedSettings) {
    const shared = sharedSetting(setting.id);
    assert.equal(typeof setting.path, "string");
    assert.equal(setting.group, shared.group);
    assert.equal(setting.unit, shared.unit);
    assert.equal(setting.format, shared.format);
    assert.equal(setting.fallback, shared.fallback);
    assert.equal(setting.schema.type, shared.type);
    assert.deepEqual(setting.schema.enum, shared.options);
    const { minimum, maximum } = settingBounds(setting);
    assert.equal(minimum, shared.minimum, setting.id);
    assert.equal(maximum, shared.maximum, setting.id);
  }
});

test("every runtime's setting is a shared one", () => {
  for (const { id } of hermesAdvancedSettings.list) assert.ok(sharedSetting(id), id);
});

test("a shared value is valid exactly when OpenClaw's allow list accepts it", () => {
  const values = [
    0,
    1,
    47,
    48,
    168,
    169,
    255,
    256,
    299,
    300,
    1200,
    2000,
    2001,
    604800,
    604801,
    300.5,
    Number.NaN,
    Infinity,
    "300",
    "off",
    "adaptive",
    "auto",
    "loud",
    "Europe/Berlin",
    "Asia/Tokyo",
    "+02:00",
    "Nowhere/City",
    "",
    true,
    null,
    undefined,
    [],
    {},
  ];
  for (const setting of advancedSettings)
    for (const value of values)
      assert.equal(
        validSharedValue(sharedSetting(setting.id), value),
        validSettingValue(setting, value),
        `${setting.id}: ${JSON.stringify(value) ?? String(value)}`,
      );
});
