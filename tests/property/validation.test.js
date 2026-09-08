import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { nameValue } from "../../server/lib/storage.js";
import { RepositoryStore } from "../../server/features/repositories/repository-store.js";
import { check, characters, dnsLabel } from "../helpers/property.js";

function repositoryFixture(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-property-")),
  );
  const store = new RepositoryStore({
    dataDir: path.join(root, "data"),
    home: root,
  });
  t.after(async () => {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, store };
}

test("display names preserve meaningful Unicode and trimming is idempotent", () => {
  const name = characters(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 äöüé日本語",
    { minLength: 1, maxLength: 90 },
  ).filter((value) => value.trim().length > 0);
  check(
    fc.property(name, (value) => {
      const accepted = nameValue(`  ${value}  `);
      assert.equal(accepted, value.trim());
      assert.equal(nameValue(accepted), accepted);
    }),
  );
});

test("control characters and oversized names never reach persisted labels", () => {
  check(
    fc.property(
      characters("abcXYZ123", { maxLength: 50 }),
      fc.integer({ min: 0, max: 31 }),
      (prefix, control) => {
        assert.throws(() => nameValue(`${prefix}${String.fromCharCode(control)}name`), {
          status: 400,
        });
      },
    ),
  );
  check(
    fc.property(fc.integer({ min: 101, max: 500 }), (length) => {
      assert.throws(() => nameValue("a".repeat(length)), { status: 400 });
    }),
  );
});

test("HTTPS host canonicalization is stable and metadata never includes the token", (t) => {
  const { store } = repositoryFixture(t);
  check(
    fc.property(dnsLabel, fc.boolean(), (label, uppercase) => {
      const host = `${label}.example.test`;
      const credential = store.createCredential({
        name: "Generated",
        host: uppercase ? `https://${host.toUpperCase()}/` : host,
        token: "fixture-private-token",
      });
      assert.equal(credential.host, `https://${host}`);
      assert.equal(JSON.stringify(credential).includes("fixture-private-token"), false);
      assert.equal(
        store.updateCredential(credential.id, {
          name: "Generated",
          host: credential.host,
        }).host,
        credential.host,
      );
      store.removeCredential(credential.id);
    }),
  );
});

test("generated cross-host clone requests fail before creating directories or invoking git", async (t) => {
  const { root, store } = repositoryFixture(t);
  const credential = store.createCredential({
    name: "Owner",
    host: "github.com",
    token: "fixture-private-token",
  });
  await check(
    fc.asyncProperty(
      dnsLabel,
      characters("abcdefghijklmnopqrstuvwxyz0123456789", {
        minLength: 1,
        maxLength: 30,
      }),
      async (host, folder) => {
        await assert.rejects(
          store.clone({
            credentialId: credential.id,
            url: `https://${host}.example.test/owner/repo`,
            parentDirectory: root,
            folderName: `clone-${folder}`,
          }),
          (error) =>
            error.status === 400 && !error.message.includes("fixture-private-token"),
        );
        assert.equal(fs.existsSync(path.join(root, `clone-${folder}`)), false);
        assert.deepEqual(store.listProjects(), []);
      },
    ),
    { numRuns: 50 },
  );
});

test("generated host URL confusion is rejected before a credential is persisted", (t) => {
  const { store } = repositoryFixture(t);
  const invalidHost = fc
    .tuple(
      dnsLabel,
      fc.constantFrom("scheme", "userinfo", "path", "query", "fragment", "control"),
    )
    .map(([label, kind]) => {
      const host = `${label}.example.test`;
      return {
        scheme: `http://${host}`,
        userinfo: `https://fixture-user@${host}`,
        path: `https://${host}/repository`,
        query: `https://${host}?token=fixture-host-secret`,
        fragment: `https://${host}#fragment`,
        control: `${host}\n`,
      }[kind];
    });
  check(
    fc.property(invalidHost, (host) => {
      assert.throws(
        () =>
          store.createCredential({
            name: "Rejected host",
            host,
            token: "fixture-host-secret",
          }),
        (error) => error.status === 400 && !error.message.includes("fixture-host-secret"),
      );
      assert.deepEqual(store.listCredentials(), []);
    }),
  );
});
