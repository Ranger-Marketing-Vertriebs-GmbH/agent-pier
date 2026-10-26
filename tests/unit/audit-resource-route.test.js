import test from "node:test";
import assert from "node:assert/strict";
import {
  readSettingsRoute,
  settingsRoutePath,
} from "../../web/features/operations/routes.js";
import { auditRoute } from "../../web/features/connections/routes.js";

test("the activity log keeps a resource filter in its address", () => {
  const route = readSettingsRoute(
    "/settings/audit",
    "?resourceId=host-1&outcome=failure",
  );
  assert.equal(route.resourceIdFilter, "host-1");
  assert.equal(route.auditOutcome, "failure");
  assert.equal(
    settingsRoutePath(route),
    "/settings/audit?outcome=failure&resourceId=host-1",
  );
  assert.equal(readSettingsRoute("/settings/audit", "").resourceIdFilter, "");
  // Zugänge links one entry's events.
  assert.equal(
    settingsRoutePath(auditRoute("srv-1")),
    "/settings/audit?resourceId=srv-1",
  );
});
