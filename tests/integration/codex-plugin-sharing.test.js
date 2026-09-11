import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "smol-toml";
import { applicationFixture } from "../helpers/application.js";
import { SharedCliProfiles } from "../../server/features/cli-profiles/shared-profiles.js";
import { fingerprint } from "../../server/features/cli-profiles/synchronization.js";

const remote = "openai-curated-remote";

for (const prepared of [false, true])
  test(`Codex remote plugin state stays private across ${prepared ? "subsequent" : "initial"} sharing, reload and local mutations`, async (t) => {
    const f = await applicationFixture(t);
    const { accounts, sharedProfiles, plugins } = f.application;
    const a = accounts.create({ name: "A", tool: "codex" });
    const b = accounts.create({ name: "B", tool: "codex" });
    if (prepared) {
      sharedProfiles.prepare(a, {});
      sharedProfiles.prepare(b, {});
    }
    const files = [
      path.join(f.home, ".codex", "config.toml"),
      path.join(accounts.profile(a.id), "codex", "config.toml"),
      path.join(accounts.profile(b.id), "codex", "config.toml"),
    ];
    const own = files.map((_, index) => ({
      [`private-${index}@${remote}`]: { enabled: true },
      [`same-name@${remote}`]: { enabled: index === 1 },
    }));
    const read = async (index) => parse(await fs.readFile(files[index], "utf8"));
    for (const [index, file] of files.entries()) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(
        file,
        stringify({
          model: `private-model-${index}`,
          plugins: {
            ...own[index],
            ...(index === 1 ? { "shared@local": { enabled: true } } : {}),
          },
        }),
      );
    }
    const assertPrivate = async () => {
      for (const index of files.keys()) {
        const config = await read(index);
        assert.deepEqual(
          Object.fromEntries(
            Object.entries(config.plugins).filter(([id]) => id.endsWith(`@${remote}`)),
          ),
          own[index],
          `profile ${index} must retain only its own remote plugin settings`,
        );
        assert.equal(config.model, `private-model-${index}`);
      }
      assert.ok(!(await fs.readFile(sharedProfiles.file, "utf8")).includes(remote));
    };
    sharedProfiles.prepare(b, {});
    await assertPrivate();
    assert.equal((await read(0)).plugins["shared@local"].enabled, true);
    assert.equal((await read(2)).plugins["shared@local"].enabled, true);

    // Persisted baselines from older versions may still contain remote entries.
    const state = JSON.parse(await fs.readFile(sharedProfiles.file, "utf8"));
    state[a.id].profiles[path.dirname(files[1])].baseline = fingerprint({
      plugins: (await read(1)).plugins,
    });
    await fs.writeFile(sharedProfiles.file, JSON.stringify(state));
    const reloaded = new SharedCliProfiles({ accounts });
    reloaded.prepare(a, {});
    reloaded.prepare(b, {});
    await assertPrivate();

    plugins.resolveTool = () => "/fixture/codex";
    plugins.runner = async (_command, args) =>
      JSON.stringify(
        args.includes("marketplace")
          ? { marketplaces: [] }
          : { installed: [], available: [{ pluginId: "shared@local" }] },
      );
    assert.equal(
      (
        await f.request("/api/accounts/local-codex/plugins", {
          method: "POST",
          body: { action: "install", pluginId: "shared@local", catalogAccountId: a.id },
        })
      ).status,
      200,
    );
    await assertPrivate();

    const edited = await read(2);
    delete edited.plugins["shared@local"];
    await fs.writeFile(files[2], stringify(edited));
    reloaded.prepare(a, {});
    reloaded.prepare(b, {});
    await assertPrivate();
    for (const index of files.keys())
      assert.equal((await read(index)).plugins["shared@local"], undefined);
  });
