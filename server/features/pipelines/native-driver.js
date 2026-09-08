import { randomUUID } from "node:crypto";
import { problem } from "../../lib/storage.js";
import { validId } from "../sessions/session-validation.js";
import { pipelineIdentity } from "./native-session.js";
import { NativeEventReader } from "./native-reader.js";
import {
  profileCommand,
  validateFrozenAccount,
  profileAccess,
  validateProfileLaunch,
} from "./native-profile.js";
import { renderProfilePrompt } from "./profile-validation.js";

export class NativePipelineDriver {
  constructor({ dataDir, accounts, sessions, lifecycle, chat }) {
    Object.assign(this, { accounts, sessions, lifecycle, chat });
    this.reader = new NativeEventReader(dataDir);
  }
  async start(input) {
    const { profileSnapshot: profile, cwd, prompt, resumeNativeId } = input;
    const sessionId = validId(input.sessionId),
      pipeline = pipelineIdentity({ ...input, headless: true });
    if (!profile?.accountSnapshot)
      throw problem("A frozen account configuration is required.");
    if (
      profile.config.providerConnectionId !== undefined &&
      !profile.providerConnectionSnapshot
    )
      throw problem("A frozen provider connection configuration is required.");
    if (input.kind && input.kind !== "kickoff" && !resumeNativeId)
      throw problem(
        "The previous turn has no verified native conversation to resume.",
        409,
      );
    validateFrozenAccount(profile, this.accounts.get(profile.config.accountId));
    if (resumeNativeId && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(resumeNativeId))
      throw problem("Invalid native conversation identity.");
    const text = [
      profile.config.prompts.role
        ? `Role instructions:\n${profile.config.prompts.role}`
        : "",
      prompt,
    ]
      .filter(Boolean)
      .join("\n\n");
    const session = await this.lifecycle.launch(
      {
        ...profileAccess(profile),
        cwd,
        name: `${profile.name} · ${input.kind || "pipeline"}`.slice(0, 100),
      },
      false,
      {
        id: sessionId,
        pipeline,
        modelId: profile.config.models.default,
        validateAccount: (account) =>
          validateProfileLaunch(profile, account, this.accounts),
        transformLaunch: ({ launch, id }) =>
          profileCommand({
            profile,
            launch,
            sessionId: id,
            resumeNativeId,
            headless: true,
            prompt: text,
          }),
      },
    );
    if (resumeNativeId) this.chat?.initialize(session, resumeNativeId, "automatic");
    return {
      sessionId: session.id,
      startedAt: session.createdAt,
      ...(resumeNativeId ? { nativeId: resumeNativeId } : {}),
    };
  }
  async owned(identity) {
    validId(identity.sessionId);
    const expected = pipelineIdentity({ ...identity, headless: true });
    const session = await this.sessions.get(identity.sessionId);
    if (
      Object.entries(expected).some(([key, value]) => session.pipeline?.[key] !== value)
    )
      throw problem("Pipeline session ownership does not match.", 409);
    return session;
  }
  async inspect(identity) {
    let session;
    try {
      session = await this.owned(identity);
    } catch (error) {
      if (error.status === 404) return { status: "missing" };
      throw error;
    }
    let observed;
    try {
      observed = await this.reader.read(session.id, session.tool);
    } catch {
      observed = { result: "failed", error: "Native output could not be validated." };
    }
    if (observed.nativeId) this.chat?.initialize(session, observed.nativeId, "automatic");
    const common = {
      startedAt: session.createdAt,
      ...(observed.lastActivityAt ? { lastActivityAt: observed.lastActivityAt } : {}),
      ...(observed.nativeId ? { nativeId: observed.nativeId } : {}),
      ...(observed.usage ? { usage: observed.usage } : {}),
    };
    if (session.status === "running") return { ...common, status: "running" };
    const receipt = await this.reader.receipt(session.id).catch(() => null);
    const quiesced =
      receipt?.groupStopped === true && receipt.exitCode === session.exitCode;
    const failed =
      observed.result === "failed" ||
      observed.incomplete ||
      session.exitCode !== 0 ||
      !quiesced;
    return {
      ...common,
      status: failed ? "failed" : "completed",
      exitCode: session.exitCode,
      isError: Boolean(failed),
      quiesced,
      quiescenceScope: "owned-process-group",
      ...(observed.error ? { error: observed.error } : {}),
      ...(observed.errorCode ? { errorCode: observed.errorCode } : {}),
      nativeResult: observed.result || null,
    };
  }
  async cancel(identity) {
    let session;
    try {
      session = await this.owned(identity);
    } catch (error) {
      if (error.status === 404) return;
      throw error;
    }
    if (session.status === "running") await this.sessions.stop(session.id);
  }
  async launchProfile(profile, { cwd, params = {}, model } = {}) {
    const prompt = renderProfilePrompt(profile, params, model);
    if (!profile.enabled) throw problem("This profile is disabled.", 409);
    const sessionId = randomUUID();
    return this.lifecycle.launch(
      {
        ...profileAccess(profile, model ?? profile.config.models.default),
        cwd,
        name: profile.name,
      },
      false,
      {
        id: sessionId,
        modelId: model ?? profile.config.models.default,
        validateAccount: (account) =>
          validateProfileLaunch(
            profile,
            account,
            this.accounts,
            model ?? profile.config.models.default,
          ),
        transformLaunch: ({ launch, id }) =>
          profileCommand({ profile, launch, sessionId: id, headless: false, prompt }),
      },
    );
  }
}
