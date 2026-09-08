import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProviderConnections } from "../../server/features/providers/provider-connections.js";
import { ProviderAccess } from "../../server/features/providers/provider-access.js";
import { ProviderCatalog } from "../../server/features/providers/provider-catalog.js";
import { AccountStore } from "../../server/features/accounts/account-store.js";
for (const providerId of ["openrouter", "zai", "zai-coding-plan"])
  for (const tool of ["codex", "claude", "opencode"])
    test(`${providerId} central connection resolves ${tool} native configuration and verified model context`, (t) => {
      const dataDir = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-connection-launch-")),
      );
      t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
      const providerCatalog = new ProviderCatalog({ dataDir });
      const connections = new ProviderConnections({ dataDir });
      const accounts = new AccountStore({
        dataDir,
        home: dataDir,
        providerCatalog,
        providerConnections: connections,
      });
      const access = new ProviderAccess({ accounts, connections, providerCatalog });
      const connection = connections.create({
        name: "Matrix",
        providerId,
        apiKey: "matrix-private-key",
        ...(providerId !== "openrouter" ? { responsesAccess: true } : {}),
      });
      const model = providerCatalog.list({ providerId, tool })[0];
      const body = {
        tool,
        providerConnectionId: connection.id,
        providerModelId: model.modelId,
      };
      const { account } = access.resolve(body);
      const executable = path.join(dataDir, "version-fixture");
      fs.writeFileSync(executable, "#!/bin/sh\nprintf '2.2.0\\n'\n", { mode: 0o755 });
      const launch = accounts.command(account.id, { [tool]: executable });
      assert.equal(launch.provider.modelId, model.modelId);
      assert.equal(launch.provider.contextTokens, model.contextTokens);
      assert.equal(JSON.stringify(launch.args).includes("matrix-private-key"), false);
      assert.equal(JSON.stringify(launch.provider).includes("matrix-private-key"), false);
      const native = accounts.command(`local-${tool}`, { [tool]: executable });
      assert.deepEqual(native.args, []);
      assert.equal(native.env.OPENROUTER_API_KEY, undefined);
      assert.equal(native.env.ZAI_API_KEY, undefined);
      assert.equal(native.env.ZHIPU_API_KEY, undefined);
      assert.equal(native.env.ANTHROPIC_AUTH_TOKEN, undefined);
      const alternative = providerCatalog
        .list({ providerId, tool })
        .find((value) => value.modelId !== model.modelId);
      if (alternative)
        assert.notEqual(
          access.resolve({ ...body, providerModelId: alternative.modelId }).account.id,
          account.id,
        );
    });
