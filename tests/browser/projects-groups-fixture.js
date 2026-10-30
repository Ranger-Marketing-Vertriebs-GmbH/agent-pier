import { hubFixture } from "./projects-fixture.js";

// A project-groups server in memory: version check, ids for new groups, 409 with the
// current document. `fail` answers the next PUT with a 400; reads wait for a
// promise in `gate`.
export async function groupsFixture(page, { projects, ...controls } = {}) {
  const server = { document: { version: 0, groups: [], assignments: {} }, puts: [] };
  let nextId = 1;
  const calls = await hubFixture(page, {
    ...controls,
    async intercept(route, url, method) {
      if (projects && url.pathname === "/api/memory/projects" && method === "GET") {
        await route.fulfill({ json: { projects } });
        return true;
      }
      if (url.pathname !== "/api/project-groups") return false;
      if (method === "GET") {
        await server.gate;
        await route.fulfill({ json: server.document });
        return true;
      }
      const body = route.request().postDataJSON();
      server.puts.push(body);
      if (server.fail) {
        server.fail = false;
        await route.fulfill({
          status: 400,
          json: { code: "PROJECT_GROUP_INVALID", error: "Refused by the server." },
        });
      } else if (body.version !== server.document.version)
        await route.fulfill({
          status: 409,
          json: {
            ...server.document,
            code: "PROJECT_GROUP_CONFLICT",
            error: "The groups were changed elsewhere in the meantime.",
          },
        });
      else {
        server.document = {
          version: server.document.version + 1,
          groups: body.groups.map((group) =>
            group.id ? group : { id: `g_${nextId++}`, name: group.name },
          ),
          assignments: body.assignments,
        };
        await route.fulfill({ json: server.document });
      }
      return true;
    },
  });
  return { server, calls };
}

export const projectList = (page) =>
  page.getByRole("navigation", { name: "Projects", exact: true });
export const section = (page, name) =>
  projectList(page).getByRole("button", { name: new RegExp(`^${name}\\s*\\d+$`) });
export const rowNames = (page) =>
  projectList(page).locator(".project-row strong").filter({ visible: true });
