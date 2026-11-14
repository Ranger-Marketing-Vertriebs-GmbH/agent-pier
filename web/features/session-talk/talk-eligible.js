import { isCodingCli } from "../../../server/features/clis/catalog.js";

/**
 * Whether a session may be granted agents to talk to (server session-agent-grants.js):
 * a running coding CLI, not a sign-in, pipeline step or imported session.
 */
export const talkEligibleSession = (session) =>
  session?.status === "running" &&
  isCodingCli(session.tool) &&
  session.purpose !== "login" &&
  !session.pipeline &&
  !session.imported;
