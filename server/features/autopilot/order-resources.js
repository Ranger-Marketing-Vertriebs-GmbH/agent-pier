import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { problem } from "../../lib/storage.js";
import { serverMessages } from "../../lib/i18n/de.js";
import { nativeModelFor } from "../../application/session-selection.js";
import { cliDefinition, isCodingCli } from "../clis/catalog.js";
import { profileLocation, readShared } from "../cli-profiles/configuration.js";
import {
  seedBundledSkills,
  upgradeStockComposerForOrder,
} from "../cli-profiles/bundled-skills.js";
import { safePath } from "../extensions/mcp-config.js";
import { skillMetadata } from "../extensions/skill-packages.js";
import { sessionScope } from "../chat/chat-delivery.js";
import { confirmedDelivery } from "../chat/chat-delivery-blocked.js";
import { orderError } from "./order-error.js";
import {
  orderBaseRef,
  orderWorkspace,
  cleanupOrderResources,
  assertProject,
} from "./order-workspace.js";

const selectionKeys = new Set([
  "tool",
  "accountId",
  "providerConnectionId",
  "providerModelId",
  "nativeModelId",
  "launchMode",
]);
const skillName = "agentpier-composer";

export function checkSelection(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !(value.tool || value.accountId)
  )
    throw orderError("selectionRequired", 400);
  for (const [key, entry] of Object.entries(value)) {
    if (
      !selectionKeys.has(key) ||
      typeof entry !== "string" ||
      !entry.trim() ||
      entry.length > 300 ||
      /[\x00-\x1f\x7f]/.test(entry)
    )
      throw orderError("selectionRequired", 400);
  }
  if (value.tool && !isCodingCli(value.tool)) throw orderError("selectionRequired", 400);
  // Stable request receipts are independent of JSON field order.
  return Object.fromEntries(
    [...selectionKeys]
      .filter((key) => Object.hasOwn(value, key))
      .map((key) => [key, value[key]]),
  );
}

function composerSkill(services, account) {
  const source = profileLocation(
    services.accounts,
    services.sharedProfiles.resolve(account.id),
  );
  seedBundledSkills(services.accounts.dataDir, source);
  const dir = path.join(source.root, "skills", skillName);
  const file = path.join(dir, "SKILL.md"),
    helper = path.join(dir, "scripts", "order-progress.mjs");
  try {
    upgradeStockComposerForOrder(dir, source.boundary);
    for (const part of [file, helper]) {
      safePath(part, source.boundary);
      const st = fs.statSync(part);
      if (!st.isFile() || st.size > 256 * 1024)
        throw orderError("composerSkillUnavailable");
    }
    const content = fs.readFileSync(file);
    if (
      skillMetadata(content).name !== skillName ||
      !content.includes("agentpier-order-contract-v2")
    )
      throw orderError("composerSkillUnavailable");
    const skills = readShared(source).skills?.config;
    if (
      Array.isArray(skills) &&
      skills.some((entry) => entry?.enabled === false && [dir, file].includes(entry.path))
    )
      throw orderError("composerSkillUnavailable");
  } catch {
    throw orderError("composerSkillUnavailable");
  }
  return file;
}

// Use the normal session MCP capability. Only the order's repository is in scope;
// the pipeline profiles determine which configured accounts and connections it uses.
function pipelineTools(s) {
  const resources = s.sessionMcp.resources();
  const profiles = s.pipelineDefinitions.listProfiles({ enabledOnly: true });
  const ids = (group, key) =>
    resources[group]
      .map((entry) => entry.id)
      .filter((id) => profiles.some((profile) => profile.config[key] === id));
  return {
    currentProject: true,
    projectIds: [],
    scopes: ["catalog:read", "runs:read", "runs:start", "runs:publish"],
    accountIds: ids("accounts", "accountId"),
    connectionIds: ids("connections", "providerConnectionId"),
  };
}

// All inputs here are private register metadata. The file Composer edits supplies none
// of the session ID, access choices, worktree or cleanup evidence.
export class OrderResources {
  constructor(services) {
    this.services = services;
  }

  async ownedSession(ctx, id) {
    if (!id) return null;
    const session = await this.services.sessions.get(id).catch((error) => {
      if (error.status === 404) return null;
      throw error;
    });
    if (
      session &&
      (session.cwd !== ctx.resources.workspace?.cwd ||
        session.id !== id ||
        !isCodingCli(session.tool) ||
        session.purpose ||
        session.pipeline)
    )
      throw orderError("ownershipMismatch");
    return session;
  }

  async inspectSession(ctx) {
    if (!ctx.resources?.workspace || !ctx.resources.sessionId) return null;
    const session = await this.ownedSession(ctx, ctx.resources.sessionId);
    return session ? { id: session.id, status: session.status } : null;
  }

  async start(ctx, { recover = false, notify = false } = {}) {
    const s = this.services;
    s.deletionGuard?.refuse(ctx.projectRoot);
    if (ctx.cleanup) throw orderError("ownershipMismatch");
    await assertProject(ctx);
    let r = ctx.resources || {};
    const save = async (patch) => {
      r = { ...r, ...patch };
      await ctx.saveResources(r);
      ctx.resources = r;
    };
    let current = await this.ownedSession(ctx, r.sessionId);
    if (r.workspace) await orderWorkspace(s, ctx, r);
    if (current?.status === "running" && r.delivered && !notify)
      return result(current, r.workspace);
    if (!current && r.sessionConfirmed && !recover)
      throw orderError("sessionRecoveryRequired");

    const selection = checkSelection(ctx.selection);
    // A resumed conversation may have switched accounts through the regular reload UI.
    const account = current
      ? s.accounts.get(current.accountId)
      : s.providerAccess.resolve(selection).account;
    if (!isCodingCli(account.tool)) throw orderError("selectionRequired", 400);
    if (!s.tools().some((tool) => tool.id === account.tool && tool.installed))
      throw problem(serverMessages.accounts.cliNotInstalled(account.tool), 409);
    if (
      selection.launchMode &&
      !Object.hasOwn(cliDefinition(account.tool).launchModes, selection.launchMode)
    )
      throw problem(serverMessages.accounts.invalidLaunchMode);
    if (!current) nativeModelFor(selection, account);
    let skill = composerSkill(s, account);

    if (!r.workspaceId) {
      await save({ workspaceId: randomUUID(), baseRef: await orderBaseRef(ctx) });
    }
    if (!r.workspace) await save({ workspace: await orderWorkspace(s, ctx, r) });
    if (current?.status === "stopped") {
      const state = await s.reload.status(current.id);
      if (["waiting", "reloading"].includes(state.state))
        throw orderError("sessionUnavailable");
      if (state.eligible) {
        if (r.delivered) await save({ deliveryId: randomUUID(), delivered: false });
        const loaded = await s.reload.request(
          current.id,
          { requestId: randomUUID(), mode: "now" },
          {
            current: (session) =>
              session.status === "stopped" && session.cwd === r.workspace.cwd,
          },
        );
        current = await this.ownedSession(ctx, current.id);
        if (loaded?.state === "failed" || current?.status !== "running")
          throw orderError("sessionUnavailable");
      } else {
        if (!recover) throw orderError("sessionRecoveryRequired");
        // Keep the old history, and only retire a stopped session which cannot reload.
        await save({
          retiredSessionIds: [...(r.retiredSessionIds || []), current.id],
          sessionId: null,
          sessionConfirmed: false,
        });
        current = null;
      }
    }
    if (!current) {
      if (r.sessionConfirmed && r.sessionId) {
        await save({
          retiredSessionIds: [...(r.retiredSessionIds || []), r.sessionId],
          sessionId: null,
          sessionConfirmed: false,
        });
      }
      for (const retired of r.retiredSessionIds || []) {
        const former = await this.ownedSession(ctx, retired);
        if (
          former &&
          (former.status !== "stopped" ||
            ["waiting", "reloading"].includes(former.reload?.state))
        )
          throw orderError("worktreeBusy");
      }
      if (!r.sessionId || r.sessionConfirmed)
        await save({
          sessionId: randomUUID(),
          sessionConfirmed: false,
          deliveryId: randomUUID(),
          delivered: false,
        });
      const expected = s.providerAccess.resolve(selection).account;
      if (expected.id !== account.id) skill = composerSkill(s, expected);
      const name = (
        typeof ctx.title === "string" && ctx.title.trim() ? ctx.title : ctx.id
      ).slice(0, 100);
      current = await s.launch(
        { ...selection, cwd: r.workspace.cwd, name, agentpierTools: pipelineTools(s) },
        false,
        {
          id: r.sessionId,
          validateAccount: (chosen) => {
            if (chosen.id !== expected.id || chosen.tool !== expected.tool)
              throw orderError("selectionRequired");
          },
        },
      );
    }
    if (!r.sessionConfirmed) await save({ sessionConfirmed: true });
    if (!r.delivered || notify) {
      const requestId = notify && ctx.resumeId ? ctx.resumeId : r.deliveryId;
      let deliveryId = requestId;
      if (r.deliveryRetry?.requestId === requestId) {
        if (r.deliveryRetry.rejected) {
          if (!recover) throw orderError("deliveryFailed");
          await save({
            deliveryRetry: { requestId, deliveryId: randomUUID(), rejected: false },
          });
        }
        deliveryId = r.deliveryRetry.deliveryId;
      }
      const file = path.join(ctx.commonDir, "agentpier-composer", ctx.filename);
      const message = [
        `Use the agentpier-composer skill at ${JSON.stringify(skill)} for this interactive Autopilot order.`,
        `Read and continue the existing order at ${JSON.stringify(file)} (id ${JSON.stringify(ctx.id)}).`,
        `Run this skill's progress helper with the AgentPier Node executable at ${JSON.stringify(process.execPath)}.`,
        "Reconcile all recorded batches, tickets, pipeline runs and pull requests before starting any work.",
        "Read autopilot_policy before each external action and check its orderId. Honor manualPaused, implementationAuthorized and allowMerge from this response.",
      ].join("\n");
      const receipt = await confirmedDelivery(
        s.chatDelivery,
        current.id,
        await s.chatDelivery.send(current.id, {
          deliveryId,
          deliveryScope: sessionScope(current),
          text: message,
          submit: true,
        }),
      );
      if (!["accepted", "pending", "handed-off", "uncertain"].includes(receipt?.status)) {
        // A definitive rejection can be retried explicitly in the same session;
        // ambiguous receipts keep their original at-most-once delivery identity.
        if (receipt?.status === "rejected")
          await save({ deliveryRetry: { requestId, deliveryId, rejected: true } });
        throw orderError("deliveryFailed");
      }
      if (!r.delivered) await save({ delivered: true });
    }
    return result(current, r.workspace);
  }

  cleanup(ctx, options) {
    return cleanupOrderResources(this.services, ctx, options, (id) =>
      this.ownedSession(ctx, id),
    );
  }
}

function result(session, workspace) {
  return { sessionId: session.id, worktree: workspace.cwd, branch: workspace.branch };
}
