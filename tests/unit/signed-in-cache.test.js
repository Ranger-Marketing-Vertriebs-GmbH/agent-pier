import test from "node:test";
import assert from "node:assert/strict";
import {
  SIGNED_IN_KEY,
  forgetSignedIn,
  rememberSignedIn,
  wasSignedIn,
} from "../../web/features/login/signed-in-cache.js";

const memoryStore = () => {
  const values = new Map();
  return {
    values,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
};

test("a signed-in owner is remembered for the current login only", () => {
  const store = memoryStore();
  store.setItem("agentpier-auth-change", "1");
  assert.equal(wasSignedIn({ store }), false);
  rememberSignedIn({ configured: true, authenticated: true, role: "owner" }, { store });
  assert.equal(wasSignedIn({ store }), true);
  assert.doesNotMatch(store.getItem(SIGNED_IN_KEY), /owner|password|token/);
  // Another login or logout in another tab writes a new marker.
  store.setItem("agentpier-auth-change", "2");
  assert.equal(wasSignedIn({ store }), false);
});

test("restricted users, signed-out states and logouts leave nothing", () => {
  const store = memoryStore();
  rememberSignedIn({ authenticated: true, role: "user" }, { store });
  assert.equal(wasSignedIn({ store }), false);
  rememberSignedIn({ authenticated: true }, { store });
  assert.equal(wasSignedIn({ store }), true);
  rememberSignedIn({ authenticated: false }, { store });
  assert.equal(wasSignedIn({ store }), false);
  rememberSignedIn({ authenticated: true }, { store });
  forgetSignedIn({ store });
  assert.equal(store.values.size, 0);
});

test("blocked storage never throws", () => {
  const store = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  };
  rememberSignedIn({ authenticated: true }, { store });
  assert.equal(wasSignedIn({ store }), false);
  forgetSignedIn({ store });
});
