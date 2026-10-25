import { secrets as germanSecrets } from "../../server/lib/i18n/de/secrets.js";
import { operationsFixture } from "./operations-fixture.js";

const namePattern = /^[A-Z_][A-Z0-9_]{0,63}$/;

/** The secrets API as the owner sees it: values go in, never come back out. */
export async function secretsFixture(page) {
  const base = await operationsFixture(page);
  const state = {
    base,
    calls: [],
    secrets: [
      {
        id: "secret-github",
        name: "GITHUB_TOKEN",
        description: "Read-only token",
        projectId: null,
        updatedAt: 1761382800000,
        hasValue: true,
      },
      {
        id: "secret-db",
        name: "DATABASE_URL",
        description: "",
        projectId: "project-app",
        updatedAt: 1761382800000,
        hasValue: true,
      },
    ],
    projects: [
      { id: "project-app", name: "Agent app", cwd: "/work/app", kind: "git" },
      { id: "project-docs", name: "Docs", cwd: "/work/docs", kind: "directory" },
    ],
  };
  await page.route("**/api/ssh-projects", (route) =>
    route.fulfill({ json: { projects: state.projects } }),
  );
  await page.route("**/api/secrets**", async (route) => {
    const request = route.request(),
      method = request.method(),
      path = new URL(request.url()).pathname;
    const body = request.postData() ? request.postDataJSON() : null;
    state.calls.push({ path, method, body });
    const id = path.split("/").at(-1);
    if (method === "GET") return route.fulfill({ json: { secrets: state.secrets } });
    if (method === "DELETE") {
      state.secrets = state.secrets.filter((secret) => secret.id !== id);
      return route.fulfill({ status: 204 });
    }
    // The server sends German text with a code; the English UI translates it.
    if (body.name !== undefined && !namePattern.test(body.name))
      return route.fulfill({
        status: 400,
        json: { code: "SECRET_INVALID", error: germanSecrets.invalidName },
      });
    if (state.secrets.some((secret) => secret.name === body.name && secret.id !== id))
      return route.fulfill({
        status: 409,
        json: { code: "SECRET_NAME_TAKEN", error: germanSecrets.nameTaken },
      });
    const { value, ...fields } = body;
    const saved =
      method === "POST"
        ? {
            id: `secret-${state.secrets.length + 1}`,
            description: "",
            projectId: null,
            ...fields,
            updatedAt: 1761386400000,
            hasValue: Boolean(value),
          }
        : { ...state.secrets.find((secret) => secret.id === id), ...fields };
    state.secrets = [...state.secrets.filter((secret) => secret.id !== saved.id), saved];
    return route.fulfill({ status: method === "POST" ? 201 : 200, json: saved });
  });
  return state;
}
