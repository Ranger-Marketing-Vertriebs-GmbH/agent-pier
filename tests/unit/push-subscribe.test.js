import test from "node:test";
import assert from "node:assert/strict";
import { subscribePush } from "../../web/features/notifications/push-subscribe.js";
import * as en from "../../web/lib/i18n/en/notifications.js";
import * as de from "../../web/lib/i18n/de/notifications.js";

const refusing = (name, message) => ({
  subscribe: async () => {
    throw Object.assign(new Error(message), { name });
  },
});

test("a browser refusal to register for push shows the app's own words", async () => {
  for (const copy of [en.notificationCopy, de.notificationCopy]) {
    await assert.rejects(
      subscribePush(
        refusing("NotAllowedError", "Registration failed - permission denied"),
        {},
        copy,
      ),
      { message: copy.denied },
    );
    await assert.rejects(
      subscribePush(
        refusing("AbortError", "Registration failed - push service error"),
        {},
        copy,
      ),
      { message: copy.subscribeFailed },
    );
  }
  const subscription = { endpoint: "https://push.example/1" };
  assert.equal(
    await subscribePush({ subscribe: async () => subscription }, {}, en.notificationCopy),
    subscription,
  );
});
