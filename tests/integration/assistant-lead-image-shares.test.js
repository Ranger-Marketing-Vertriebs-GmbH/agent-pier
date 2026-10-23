import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { leadShareFixture } from "../helpers/lead-share-fixture.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import {
  personalCapabilities,
  profileTools,
} from "../../server/features/assistants/native-capabilities.js";
import { followLead } from "../../server/features/assistants/member-follow.js";
import { png } from "../helpers/image-bytes.js";

const code = (key) => (error) => toolError(error).code === key;
const shareAudits = (f) => f.audits.filter((e) => e.details?.kind === "lead-share");
const switchImages = (f, id, documents) => {
  const agent = f.store.getAssistant(id);
  f.store.updateAssistant(
    id,
    {
      capabilities: { ...agent.capabilities, memory: false, reminders: false, documents },
    },
    agent.revision,
  );
};
// The lead holds Read images and shares its folder for reading; the member has
// neither switch of its own.
async function setup(t) {
  const f = await leadShareFixture(t);
  fs.writeFileSync(path.join(f.folder, "screen.png"), png);
  switchImages(f, f.lead, true);
  await f.share({ grants: { projects: { [f.folderProject.id]: "read" } } });
  const view = async () =>
    f.call(await f.turn(f.memberChat.id), { action: "image_view", path: "screen.png" });
  const images = () =>
    personalCapabilities(f.store.getAssistant(f.member.assistantId)).documents;
  return { ...f, view, images };
}

test("a lead shares Read images with its permanent member, visibly", async (t) => {
  const f = await setup(t);
  await assert.rejects(f.view(), code("IMAGES_OFF"));
  const result = await f.share({ grants: { documents: true } });
  assert.deepEqual(result, {
    status: "shared",
    memberId: f.member.id,
    projects: [],
    coding: [],
    mcpServers: 0,
    capabilities: ["documents"],
  });
  // The member now holds Read images through its lead, its own switch untouched.
  assert.equal(f.images(), true);
  const member = f.store.getAssistant(f.member.assistantId);
  assert.notEqual(member.capabilities?.documents, true);
  assert.ok(profileTools(member, true, true).includes("view_image"));
  assert.equal((await f.view()).mimeType, "image/png");
  // Never persisted with the member's own record.
  const stored = f.store.storedAssistant(f.member.assistantId);
  assert.equal(stored.leadCapabilities, undefined);
  f.store.updateAssistant(f.member.assistantId, { name: "Scout 2" }, member.revision);
  assert.equal(f.store.storedAssistant(f.member.assistantId).leadCapabilities, undefined);
  // Notes in both chats, the audit and the owner's list.
  for (const id of [f.member.assistantId, f.lead]) {
    const note = f.workflows.store.list(id).at(-1);
    assert.equal(note.payload.action, "member_grant");
    assert.deepEqual(note.payload.granted, ["documents"], id);
  }
  const audit = shareAudits(f).at(-1);
  assert.equal(audit.details.change, "grant");
  assert.deepEqual(audit.details.capabilities, ["documents"]);
  const listed = f.shares.list().find((s) => s.kind === "capability");
  assert.equal(listed.capability, "documents");
  assert.equal(listed.leadId, f.lead);
  assert.equal(listed.requestId, null);
  assert.deepEqual(listed.live, { on: true });
  // Sharing again changes nothing but the time.
  await f.share({ grants: { documents: true } });
  assert.equal(f.shares.rows().filter((r) => r.kind === "capability").length, 1);
});

test("a lead without Read images cannot share it", async (t) => {
  const f = await setup(t);
  switchImages(f, f.lead, false);
  await assert.rejects(f.share({ grants: { documents: true } }), {
    key: "teamGrantNotHeld",
  });
  // Other capabilities stay the owner's to set.
  switchImages(f, f.lead, true);
  await assert.rejects(f.share({ grants: { documents: true, webSearch: true } }), {
    key: "teamShareAccessOnly",
  });
  assert.equal(f.shares.rows().filter((r) => r.kind === "capability").length, 0);
});

test("the share ends when the lead loses Read images, and the member follows", async (t) => {
  const f = await setup(t);
  await f.share({ grants: { documents: true } });
  const applied = [];
  f.assistants.config.apply = async (id) => applied.push(id);
  switchImages(f, f.lead, false);
  // Live at once: the member's next call is refused.
  assert.equal(f.images(), false);
  await assert.rejects(f.view(), code("IMAGES_OFF"));
  const row = f.shares.rows().find((r) => r.kind === "capability");
  assert.equal(f.shares.live(row).on, false);
  // The lead's re-applied profile prunes the share and re-applies the member.
  followLead(f.assistants, f.lead);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(applied.includes(f.member.assistantId));
  assert.equal(f.shares.rows().filter((r) => r.kind === "capability").length, 0);
  const revoked = shareAudits(f).at(-1);
  assert.equal(revoked.details.change, "revoke");
  assert.equal(revoked.details.reason, "lead-lost");
  assert.deepEqual(revoked.details.capabilities, ["documents"]);
  // Switching it on again does not bring the ended share back.
  switchImages(f, f.lead, true);
  assert.equal(f.images(), false);
});

test("the lead revokes Read images, and the owner can remove the share", async (t) => {
  const f = await setup(t);
  await f.share({ grants: { documents: true } });
  const revoked = await f.share({ grants: { documents: true }, revoke: true });
  assert.equal(revoked.status, "revoked");
  assert.deepEqual(revoked.capabilities, ["documents"]);
  assert.equal(f.images(), false);
  // The folder share stays.
  assert.equal(f.shares.rows().length, 1);
  const note = f.workflows.store.list(f.member.assistantId).at(-1);
  assert.deepEqual(note.payload.revoked, ["documents"]);
  assert.equal(shareAudits(f).at(-1).details.change, "revoke");
  // The owner removes a share from the member's settings.
  await f.share({ grants: { documents: true } });
  const row = f.shares.rows().find((r) => r.kind === "capability");
  f.shares.remove(row.id);
  assert.equal(f.images(), false);
  const owner = f.workflows.store.list(f.member.assistantId).at(-1);
  assert.equal(owner.payload.by, "owner");
  assert.deepEqual(owner.payload.revoked, ["documents"]);
  assert.equal(shareAudits(f).at(-1).details.by, "owner");
});

test("a shared Read images counts only for the lead's own permanent member", async (t) => {
  const f = await setup(t);
  await f.share({ grants: { documents: true } });
  f.teams.archive(f.member.id, f.teams.member(f.member.id).revision);
  assert.equal(f.images(), false);
  f.shares.prune();
  assert.equal(f.shares.rows().length, 0);
});

test("a share pruned elsewhere still re-applies the member", async (t) => {
  const f = await setup(t);
  await f.share({ grants: { documents: true } });
  const applied = [];
  f.assistants.config.apply = async (id) => applied.push(id);
  switchImages(f, f.lead, false);
  // The owner's list prunes before the lead's re-apply follows.
  assert.equal(f.shares.list().filter((s) => s.kind === "capability").length, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(applied.includes(f.member.assistantId));
});

test("a revoke note names only what was actually removed", async (t) => {
  const f = await setup(t);
  const notes = () => f.workflows.store.list(f.member.assistantId).length;
  const before = notes();
  // Nothing of Read images was shared: no note, and the lead is told so.
  const nothing = await f.share({ grants: { documents: true }, revoke: true });
  assert.equal(nothing.status, "nothing_to_revoke");
  assert.equal(notes(), before);
  // Revoking the folder and Read images when only the folder is shared names the folder.
  const revoked = await f.share({
    grants: { projects: { [f.folderProject.id]: "read" }, documents: true },
    revoke: true,
  });
  assert.equal(revoked.status, "revoked");
  const note = f.workflows.store.list(f.member.assistantId).at(-1);
  assert.deepEqual(note.payload.revoked, ["projects"]);
});
