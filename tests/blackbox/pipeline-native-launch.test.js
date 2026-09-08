import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { applicationFixture } from "../helpers/application.js";

async function ended(driver, identity) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const result = await driver.inspect(identity);
    if (result.status !== "running") return result;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail("Synthetic native CLI did not exit.");
}
for (const providerId of [null, "openrouter", "zai", "zai-coding-plan"])
  for (const [tool, mode, prefix] of [
    ["codex", "never", "exec"],
    ["claude", "acceptEdits", "--print"],
    ["opencode", "auto", "run"],
  ])
    test(`${providerId || "native"}/${tool} pipeline uses normal account lifecycle and exact native resume across real owned tmux turns`, async (t) => {
      const app = await applicationFixture(t),
        application = app.application;
      const account = application.accounts.create({ name: `Fixture ${tool}`, tool });
      const cli = path.join(app.root, `synthetic-${tool}.cjs`),
        capture = path.join(app.root, `${tool}-argv.json`),
        nativeId = randomUUID();
      await fs.writeFile(
        cli,
        `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);if(args.includes('--version')){console.log('2.1.263');process.exit(0)}let prompt='';process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({args,prompt,memory:!!process.env.AGENTPIER_MEMORY_CAPABILITY_FILE,keyRotated:Object.values(process.env).includes("synthetic-rotated-key")}));const event=${JSON.stringify(tool)}==='codex'?{type:'thread.started',thread_id:${JSON.stringify(nativeId)}}:${JSON.stringify(tool)}==='claude'?{type:'system',session_id:${JSON.stringify(nativeId)}}:{type:'step_start',sessionID:${JSON.stringify(nativeId)}};console.log(JSON.stringify(event));console.log(JSON.stringify(${JSON.stringify(tool)}==='codex'?{type:'turn.completed',usage:{input_tokens:12,output_tokens:3}}:${JSON.stringify(tool)}==='claude'?{type:'result',session_id:${JSON.stringify(nativeId)},is_error:false,usage:{input_tokens:12,output_tokens:3}}:{type:'step_finish',sessionID:${JSON.stringify(nativeId)},part:{reason:'stop',tokens:{input:12,output:3}}}));});`,
        { mode: 0o700 },
      );
      const command = application.accounts.command.bind(application.accounts);
      application.accounts.command = (id, _binaries, login, launchMode, options) =>
        command(id, { [tool]: cli }, login, launchMode, options);
      const connection = providerId
        ? application.providerConnections.create({
            name: "Pipeline connection",
            providerId,
            apiKey: "synthetic-first-key",
            ...(providerId !== "openrouter" ? { responsesAccess: true } : {}),
          })
        : null;
      const modelId = providerId
        ? application.providerCatalog.list({ providerId, tool })[0].modelId
        : "";
      let profile = {
        id: "fixture",
        name: "Fixture",
        enabled: true,
        accountSnapshot: { id: account.id, tool, kind: account.kind },
        config: {
          accountId: account.id,
          cliTool: tool,
          ...(connection ? { providerConnectionId: connection.id } : {}),
          models: { available: [modelId], default: modelId },
          prompts: { role: "Role retained", kickoff: "Task", params: [] },
          permissions: { mode },
          run: { autonomous: true },
        },
      };
      const saved = application.pipelineDefinitions.saveProfile(profile);
      const pipeline = application.pipelineDefinitions.savePipeline({
        name: "Fixture",
        graph: {
          entry: "work",
          nodes: [{ id: "work", kind: "profile", profileId: saved.id }],
          edges: [],
        },
      });
      profile = application.pipelineDefinitions.snapshot(pipeline.id).profiles[saved.id];
      const identity = {
        runId: randomUUID(),
        nodeId: "work",
        attemptId: randomUUID(),
        turnId: randomUUID(),
        sessionId: randomUUID(),
      };
      await application.pipelineDriver.start({
        ...identity,
        profileSnapshot: profile,
        cwd: app.home,
        prompt: "First task",
        kind: "kickoff",
      });
      const first = await ended(application.pipelineDriver, identity);
      assert.equal(first.status, "completed");
      assert.equal(first.exitCode, 0);
      assert.equal(first.nativeId, nativeId);
      assert.equal(first.quiesced, true);
      assert.equal(first.quiescenceScope, "owned-process-group");
      const session = await application.sessions.get(identity.sessionId);
      assert.equal(session.memory.enabled, true);
      assert.equal(session.pipeline.turnId, identity.turnId);
      // A headless pipeline turn gets no chat attachment grant: no chat UI
      // will ever attach to it, and the flag must never reach a native argv.
      assert.equal(session.attachments, undefined);
      assert.equal(
        await fs
          .access(
            path.join(app.dataDir, "chat-attachments", session.accountId, session.id),
          )
          .then(
            () => true,
            () => false,
          ),
        false,
      );
      const argv = JSON.parse(await fs.readFile(capture, "utf8"));
      assert.equal(argv.args[0], prefix);
      assert.equal(argv.args.includes("--add-dir"), false);
      assert.match(argv.prompt, /Role retained/);
      const binding = JSON.parse(
        await fs.readFile(
          path.join(app.dataDir, "chat", `${identity.sessionId}.binding.json`),
          "utf8",
        ),
      );
      assert.equal(binding.providerSessionId, nativeId);
      if (connection) {
        assert.equal(session.access.providerConnectionId, connection.id);
        assert.equal(session.access.sourceAccountId, account.id);
        assert.equal(session.provider.requestedModelId, modelId);
        assert.equal(
          session.provider.contextTokens,
          application.providerCatalog.get(providerId, modelId, { tool }).contextTokens,
        );
        assert.notEqual(session.accountId, account.id);
        await assert.rejects(
          fs.access(
            path.join(application.accounts.profile(session.accountId), "secret.json"),
          ),
        );
        application.providerConnections.update(connection.id, {
          apiKey: "synthetic-rotated-key",
          name: "Renamed connection",
        });
        const replacement = application.providerConnections.create({
          name: "Other",
          providerId,
          apiKey: "synthetic-other-key",
          ...(providerId !== "openrouter" ? { responsesAccess: true } : {}),
        });
        application.pipelineDefinitions.saveProfile(
          {
            ...saved,
            expectedRevision: saved.revision,
            config: { ...saved.config, providerConnectionId: replacement.id },
          },
          saved.id,
        );
      }
      if (providerId === "openrouter") {
        application.providerCatalog.fetch = async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: modelId,
                  name: "Refreshed fixture",
                  context_length: 128000,
                  top_provider: { context_length: 64000, max_completion_tokens: 8000 },
                  architecture: {
                    input_modalities: ["text"],
                    output_modalities: ["text"],
                  },
                  supported_parameters: ["tools"],
                },
              ],
            }),
          );
        await application.providerCatalog.refresh(providerId);
      }
      const next = { ...identity, turnId: randomUUID(), sessionId: randomUUID() };
      await application.pipelineDriver.start({
        ...next,
        profileSnapshot: profile,
        cwd: app.home,
        prompt: "Follow-up",
        kind: "gate-feedback",
        resumeNativeId: nativeId,
      });
      assert.equal((await ended(application.pipelineDriver, next)).status, "completed");
      const resumed = JSON.parse(await fs.readFile(capture, "utf8"));
      assert.equal(resumed.args.includes(nativeId), true);
      assert.equal(resumed.args.includes("--continue"), false);
      if (connection) {
        const resumedSession = await application.sessions.get(next.sessionId);
        assert.equal(
          resumedSession.accountId,
          session.accountId,
          "rotation and profile editing preserve native history identity",
        );
        assert.equal(resumedSession.access.providerConnectionId, connection.id);
        assert.equal(
          resumed.keyRotated,
          true,
          "native process reads the rotated central credential",
        );
        assert.equal(resumedSession.provider.requestedModelId, modelId);
        if (providerId === "openrouter") {
          assert.equal(resumedSession.provider.contextTokens, 128000);
          assert.equal(resumedSession.provider.routingContextTokens, 64000);
          assert.notEqual(
            session.provider.contextTokens,
            resumedSession.provider.contextTokens,
          );
        }
        application.providerConnections.remove(connection.id);
        await assert.rejects(
          application.pipelineDriver.start({
            ...next,
            sessionId: randomUUID(),
            profileSnapshot: profile,
            cwd: app.home,
            prompt: "Deleted connection",
            resumeNativeId: nativeId,
          }),
          /connection/i,
        );
        assert.equal(
          application.accounts.get(session.accountId).id,
          session.accountId,
          "connection removal retains history profile",
        );
      }
      const screen = await application.sessions.screen(next.sessionId);
      assert.match(screen, new RegExp(nativeId));
    });
