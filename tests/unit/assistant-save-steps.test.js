import test from "node:test";
import assert from "node:assert/strict";
import {
  assistantPatchStep,
  assistantWorkStep,
} from "../../web/features/assistants/assistant-save-steps.js";
import { runSaveChain } from "../../web/lib/settings/save-chain.js";

test("the agent patch step sends the draft's base revision and confirmation flags", async () => {
  const sent = [];
  const step = assistantPatchStep({
    assistantId: "a1",
    label: "Fähigkeiten",
    keys: ["shell"],
    body: (values) => ({ shell: values.shell }),
    update: async (id, input) => {
      sent.push([id, input]);
      if (!input.confirmShell)
        throw Object.assign(new Error("confirm"), {
          status: 409,
          code: "ASSISTANT_SHELL_CONFIRMATION_REQUIRED",
          required: ["confirmShell"],
        });
      return { revision: input.revision + 1 };
    },
  });
  const result = await runSaveChain({
    steps: [step],
    values: { shell: "approval" },
    base: { shell: "off" },
    revisions: { assistant: 4 },
    ask: async () => true,
  });
  assert.equal(result.status, "saved");
  assert.deepEqual(sent, [
    ["a1", { shell: "approval", revision: 4 }],
    ["a1", { shell: "approval", revision: 4, confirmShell: true }],
  ]);
  assert.equal(result.revisions.assistant, 5);
});

test("the work step sends both revisions and adopts both from the response", async () => {
  const sent = [];
  const step = assistantWorkStep({
    assistantId: "a1",
    label: "Arbeit",
    keys: ["projectIds", "maxMembers"],
    access: (values) => ({
      projectIds: values.projectIds,
      pipelineIds: [],
      memoryWrite: false,
      autonomous: false,
      publish: false,
    }),
    team: (values) => ({ maxMembers: values.maxMembers }),
    save: async (id, body) => {
      sent.push([id, body]);
      return {
        access: { revision: body.access.revision + 1 },
        team: { revision: body.team.revision + 1 },
      };
    },
  });
  const result = await runSaveChain({
    steps: [step],
    values: { projectIds: ["p"], maxMembers: 5 },
    base: { projectIds: [], maxMembers: 4 },
    revisions: { access: 2, team: 7 },
  });
  assert.equal(result.status, "saved");
  assert.equal(sent[0][1].access.revision, 2);
  assert.equal(sent[0][1].team.revision, 7);
  assert.deepEqual(result.revisions, { access: 3, team: 8 });
});
