import test from "node:test";
import assert from "node:assert/strict";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import { serverCatalogs } from "../../server/lib/i18n/catalogs.js";

for (const changed of ["pipeline", "profile"])
  test(`a changed ${changed} explains the stale grant and requires an owner save`, async (t) => {
    const f = await workflowFixture(t);
    f.workflows.access.save(f.id, f.policy, 0);
    f[changed].revision++;
    const input = {
      action: "coding_start",
      projectId: f.project.id,
      pipelineId: f.pipeline.id,
      task: "Implement feature",
    };
    for (let attempt = 0; attempt < 2; attempt++)
      await assert.rejects(f.workflows.invoke(await f.invocation(), input), (error) => {
        const result = toolError(error);
        assert.equal(result.status, 409);
        assert.equal(result.code, "PIPELINE_ACCESS_CHANGED");
        assert.match(result.reason, /Do not retry until the owner/);
        assert.match(result.reason, /lead for shared access/);
        assert.doesNotMatch(result.reason, /current revision/);
        for (const lang of ["de", "en"])
          assert.equal(typeof serverCatalogs[lang].assistants[error.key], "string");
        return true;
      });
    assert.equal(f.workflows.store.list(f.id).length, 0);
    assert.equal(f.starts.length, 0);
    assert.equal(f.workflows.access.get(f.id).revision, 1);

    // Only the owner's explicit save accepts the changed definition. The usual
    // per-task approval still applies after that save.
    f.workflows.access.save(f.id, f.policy, 1);
    const action = await f.workflows.invoke(await f.invocation(), input);
    assert.equal(action.state, "awaiting_approval");
    await f.workflows.tick();
    assert.equal(f.starts.length, 0);
    await f.workflows.decide(
      action.id,
      { revision: action.revision, decision: "approve" },
      { kind: "owner" },
    );
    await f.workflows.tick();
    assert.equal(f.starts.length, 1);
  });
