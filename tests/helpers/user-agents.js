import { signedInUser } from "./users.js";

/** A provider connection the fixture's agents use; never contacted by these suites. */
export function fixtureModel(f) {
  const connection = f.application.providerConnections.create({
    name: "User agents",
    providerId: "openrouter",
    apiKey: "private-user-agent-key",
  });
  return { connectionId: connection.id, modelId: "openai/gpt-4.1-mini" };
}

/** An own agent for a new signed-in user, created through the owner's API. */
export async function ownUserAgent(f, { username = "Anna", level = "chat", body } = {}) {
  const { user, cookie } = await signedInUser(f, username);
  const response = await f.request("/api/user-agents", {
    method: "POST",
    body: {
      name: `${username}'s agent`,
      instructions: "",
      model: fixtureModel(f),
      ...body,
      userAccess: { mode: "own", members: [{ userId: user.id, level }] },
    },
  });
  if (response.status !== 201)
    throw new Error(`User agent not created: ${await response.text()}`);
  return { user, cookie, agent: await response.json() };
}
