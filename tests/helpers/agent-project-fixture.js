import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { workflowFixture } from "./assistant-workflow-fixture.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import { auditEvent } from "../../server/features/audit/audit-schema.js";

/**
 * The real workflows (Telegram paired, in German) with a disposable default project
 * folder `parent` and a recorded audit log, for the agentpier_project tool
 * (agent-projects.js). `call` runs one tool call in a fresh owner turn; `code`
 * answers a call's tool error code, or null when it succeeded.
 */
export async function agentProjectFixture(t) {
  const f = await workflowFixture(t);
  const parent = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agent-projects-")),
  );
  t.after(() => {
    // A test may have made the folder unwritable.
    fs.chmodSync(parent, 0o700);
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const preferences = { defaultCwd: parent };
  f.services.preferences = { get: () => ({ ...preferences }) };
  const audit = [];
  f.services.audit = { append: (event) => audit.push(auditEvent(event)) };
  const call = async (input, origin = { kind: "owner" }) =>
    f.workflows.projects.invoke(await f.invocation(randomUUID(), origin), input);
  const code = (promise) =>
    promise.then(
      () => null,
      (error) => toolError(error).code,
    );
  const projectRows = () =>
    f.workflows.store.list(f.id).filter((a) => a.payload.action === "agent_project");
  const projectIds = () =>
    f.memory
      .projectNames()
      .map((p) => p.id)
      .sort();
  // Rows the creation record would hold, `ago` ms before now.
  const addRows = (count, ago) => {
    for (let i = 0; i < count; i++)
      f.workflows.projects.store.add({
        projectId: `earlier-${ago}-${i}`,
        assistantId: f.id,
        createdAt: new Date(Date.now() - ago).toISOString(),
      });
  };
  // Sets one field of the agent's stored definition, bypassing validation.
  const setAgent = (field, value) =>
    f.assistants.store.db
      .prepare(
        `UPDATE assistants SET body=json_set(body,'$.${field}',json(?)) WHERE id=?`,
      )
      .run(JSON.stringify(value), f.id);
  return {
    ...f,
    parent,
    preferences,
    audit,
    call,
    code,
    projectRows,
    projectIds,
    addRows,
    setAgent,
  };
}
