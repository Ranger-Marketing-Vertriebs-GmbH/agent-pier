import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { leadShareFixture } from "../helpers/lead-share-fixture.js";
import { TeamStore } from "../../server/features/assistants/team-store.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import { png } from "../helpers/image-bytes.js";

const code = (key) => (error) => toolError(error).code === key;
const capabilities = (f, id, on) => {
  const agent = f.store.getAssistant(id);
  f.store.updateAssistant(
    id,
    { capabilities: { ...agent.capabilities, memory: false, reminders: false, ...on } },
    agent.revision,
  );
};

// The owner's agent with a project folder holding a screenshot, Read images on and
// a model whose image input the test switches; every audit record is kept.
async function setup(t) {
  const f = await workflowFixture(t);
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-images-")));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  fs.writeFileSync(path.join(folder, "screen.png"), png);
  fs.writeFileSync(path.join(folder, "README.md"), "# App\n");
  const project = await f.memory.register(folder);
  const audits = [];
  f.services.audit = { append: (event) => audits.push(event) };
  const images = { input: true };
  f.assistants.models = { imageInput: () => images.input };
  const grant = (projectFiles, projectIds = [project.id]) =>
    f.workflows.access.save(
      f.id,
      { ...f.policy, projectIds, projectFiles },
      f.workflows.access.get(f.id).revision,
    );
  const call = async (input, origin) =>
    f.workflows.invoke(await f.invocation(randomUUID(), origin), {
      projectId: project.id,
      ...input,
    });
  capabilities(f, f.id, { documents: true });
  return { ...f, folder, folderProject: project, audits, images, grant, call };
}

test("an owner turn views an image of a granted folder and the view is audited", async (t) => {
  const f = await setup(t);
  await assert.rejects(
    f.call({ action: "image_view", path: "screen.png" }),
    code("PROJECT_NOT_GRANTED"),
  );
  f.grant({ [f.folderProject.id]: "read" });
  const result = await f.call({ action: "image_view", path: "screen.png" });
  assert.deepEqual(result, {
    projectId: f.folderProject.id,
    access: "read",
    path: "screen.png",
    mimeType: "image/png",
    bytes: png.length,
    data: png.toString("base64"),
  });
  const audit = f.audits.findLast((e) => e.details?.kind === "project-file");
  assert.equal(audit.resourceId, f.id);
  assert.equal(audit.projectId, f.folderProject.id);
  assert.equal(audit.details.fileView, "image");
  assert.equal(audit.details.filePath, "screen.png");
  assert.equal(audit.details.bytes, png.length);
  assert.equal(audit.details.fileChange, undefined);
  // A text file is not an image; the reason points back to file_read.
  await assert.rejects(f.call({ action: "image_view", path: "README.md" }), (error) => {
    const { code: c, reason } = toolError(error);
    return c === "PROJECT_IMAGE_UNSUITABLE" && reason.includes("file_read");
  });
  // file_read on a binary image names image_view.
  await assert.rejects(f.call({ action: "file_read", path: "screen.png" }), (error) => {
    const { code: c, reason } = toolError(error);
    return c === "PROJECT_FILE_UNSUITABLE" && reason.includes("image_view");
  });
});

test("image_view needs Read images and a model that takes images", async (t) => {
  const f = await setup(t);
  f.grant({ [f.folderProject.id]: "read" });
  capabilities(f, f.id, { documents: false });
  await assert.rejects(
    f.call({ action: "image_view", path: "screen.png" }),
    code("IMAGES_OFF"),
  );
  capabilities(f, f.id, { documents: true });
  f.images.input = false;
  await assert.rejects(
    f.call({ action: "image_view", path: "screen.png" }),
    code("MODEL_TEXT_ONLY"),
  );
  // An unknown connection is not refused: the runtime decides, as for uploads.
  f.images.input = null;
  assert.equal(
    (await f.call({ action: "image_view", path: "screen.png" })).mimeType,
    "image/png",
  );
  assert.equal(
    f.audits.filter((e) => e.details?.fileView === "image").length,
    1,
    "refused views are not audited as views",
  );
});

test("a task member views an image with its lead's folder and Read images grant", async (t) => {
  const f = await setup(t);
  f.grant({ [f.folderProject.id]: "read" });
  const teams = new TeamStore({
    store: f.store,
    projectFiles: (id) => f.workflows.folders.held(id),
  });
  f.assistants.teams = { store: teams };
  const parent = f.assistants.ledger.accept(f.channel.conversationId, {
    clientRequestId: "team",
    text: "Build a team that checks the screenshots",
  });
  teams.recordContext(parent.id, { kind: "owner", teamAllowed: true });
  const parentAttempt = f.assistants.ledger.recordAttempt(parent.id);
  const proposed = teams.propose({
    operationId: "team-call",
    parentAttemptId: parentAttempt.id,
    objective: "Check the screenshots",
    members: [
      {
        name: "Viewer",
        role: "QA",
        assignment: "Check the screenshots",
        grants: { projects: { [f.folderProject.id]: "read" } },
      },
    ],
  });
  f.assistants.ledger.transition(parentAttempt.id, "completed");
  teams.reserve(proposed.id);
  let member = teams.members(proposed.id)[0];
  const chat = f.store.saveConversation({
    assistantId: member.assistantId,
    runtimeSessionKey: "member-session",
  });
  member = teams.write(member, { conversationId: chat.id, phase: "running" });
  const context = { kind: "team-member", teamId: proposed.id, memberId: member.id };
  const turn = await f.assistants.send(
    chat.id,
    { clientRequestId: "assignment", text: member.assignment },
    context,
  );
  teams.recordContext(turn.request.id, context);
  const memberCall = (input) =>
    f.workflows.invoke(
      { attemptId: turn.attempt.id, toolCallId: randomUUID(), assertCurrent() {} },
      { projectId: f.folderProject.id, ...input },
    );
  // The folder alone is not enough: Read images comes from the lead's grant too.
  await assert.rejects(
    memberCall({ action: "image_view", path: "screen.png" }),
    code("IMAGES_OFF"),
  );
  teams.write(teams.member(member.id), {
    grants: { projects: { [f.folderProject.id]: "read" }, documents: true },
  });
  const viewed = await memberCall({ action: "image_view", path: "screen.png" });
  assert.equal(viewed.mimeType, "image/png");
  const audit = f.audits.findLast((e) => e.details?.fileView === "image");
  assert.equal(audit.details.requestedBy, member.id);
  // The lead switching Read images off ends it for the member at once.
  capabilities(f, f.id, { documents: false });
  await assert.rejects(
    memberCall({ action: "image_view", path: "screen.png" }),
    code("IMAGES_OFF"),
  );
});

test("a permanent member views an image on its lead's standing folder share", async (t) => {
  const f = await leadShareFixture(t);
  fs.writeFileSync(path.join(f.folder, "screen.png"), png);
  capabilities(f, f.member.assistantId, { documents: true });
  const owner = await f.turn(f.memberChat.id);
  await assert.rejects(
    f.call(owner, { action: "image_view", path: "screen.png" }),
    code("PROJECT_NOT_GRANTED"),
  );
  await f.share({ grants: { projects: { [f.folderProject.id]: "read" } } });
  const viewed = await f.call(await f.turn(f.memberChat.id), {
    action: "image_view",
    path: "screen.png",
  });
  assert.equal(viewed.access, "read");
  assert.equal(viewed.data, png.toString("base64"));
  const audit = f.audits.findLast((e) => e.details?.fileView === "image");
  assert.equal(audit.resourceId, f.member.assistantId);
  assert.equal(audit.details.leadAssistantId, f.lead);
  assert.equal(audit.details.sharedBy, "lead");
  // In a task of the lead the share applies too.
  const { inv } = await f.task();
  assert.equal(
    (await f.call(inv, { action: "image_view", path: "screen.png" })).mimeType,
    "image/png",
  );
  // Without its own Read images the member cannot view, whatever the folder share.
  capabilities(f, f.member.assistantId, { documents: false });
  await assert.rejects(
    f.call(await f.turn(f.memberChat.id), { action: "image_view", path: "screen.png" }),
    code("IMAGES_OFF"),
  );
});
