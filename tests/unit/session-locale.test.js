import test from "node:test";
import assert from "node:assert/strict";
import { withUtf8Locale, defaultUtf8Locale } from "../../server/lib/session-locale.js";
import { cleanEnvironment } from "../../server/features/accounts/account-store.js";

test("sessions without any locale variable get a UTF-8 default", () => {
  assert.equal(defaultUtf8Locale("darwin"), "en_US.UTF-8");
  assert.equal(defaultUtf8Locale("linux"), "C.UTF-8");
  assert.deepEqual(withUtf8Locale({ PATH: "/bin" }, "darwin"), {
    PATH: "/bin",
    LANG: "en_US.UTF-8",
  });
  assert.equal(withUtf8Locale({ LANG: "" }, "linux").LANG, "C.UTF-8");
  const env = cleanEnvironment({ PATH: "/bin", HOME: "/home/example" });
  assert.equal(env.LANG, defaultUtf8Locale());
  assert.equal(env.LC_ALL, undefined);
  assert.equal(env.LC_CTYPE, undefined);
});

test("an owner-set locale is never overridden", () => {
  for (const key of ["LANG", "LC_ALL", "LC_CTYPE"]) {
    const source = { PATH: "/bin", [key]: "de_DE.ISO8859-1" };
    assert.deepEqual(withUtf8Locale(source, "darwin"), source);
    const env = cleanEnvironment(source);
    assert.equal(env[key], "de_DE.ISO8859-1");
    for (const other of ["LANG", "LC_ALL", "LC_CTYPE"])
      if (other !== key) assert.equal(env[other], undefined);
  }
});
