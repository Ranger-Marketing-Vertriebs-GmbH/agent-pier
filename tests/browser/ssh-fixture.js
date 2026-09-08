import { operationsFixture } from "./operations-fixture.js";
export async function fixture(page) {
  const base = await operationsFixture(page);
  const access = {
    id: "ssh-one",
    keyId: "key-one",
    keyName: "Deployment key",
    name: "Build server",
    host: "build.example.test",
    port: 22,
    username: "deploy",
    hostKey: "ssh-ed25519 fixture",
    hostFingerprint: "SHA256:verified-host",
    publicKey: "ssh-ed25519 public-fixture",
    fingerprint: "SHA256:public",
  };
  const key = {
    id: "key-one",
    name: "Deployment key",
    publicKey: access.publicKey,
    fingerprint: access.fingerprint,
    hosts: [],
  };
  const state = {
    keys: [key],
    accesses: [],
    assignedIds: [],
    calls: [],
    fail: false,
    base,
  };
  await page.route("**/api/ssh-keys**", async (route) => {
    const request = route.request(),
      method = request.method(),
      path = new URL(request.url()).pathname;
    const body = request.postData() ? request.postDataJSON() : null;
    state.calls.push({ path, method, body });
    if (state.fail && method !== "GET")
      return route.fulfill({ status: 409, json: { error: "Fixture conflict" } });
    const id = path.split("/").at(-1);
    if (method === "GET")
      return route.fulfill({
        json: {
          keys: state.keys.map((key) => ({
            ...key,
            hosts: state.accesses
              .filter((a) => a.keyId === key.id)
              .map((a) => ({ id: a.id, name: a.name })),
          })),
        },
      });
    if (method === "DELETE") {
      state.keys = state.keys.filter((key) => key.id !== id);
      return route.fulfill({ status: 204 });
    }
    const result =
      method === "PATCH"
        ? { ...state.keys.find((key) => key.id === id), name: body.name }
        : { ...key, id: `key-${state.keys.length + 1}`, name: body.name };
    state.keys = [...state.keys.filter((key) => key.id !== result.id), result];
    state.accesses = state.accesses.map((a) =>
      a.keyId === result.id ? { ...a, keyName: result.name } : a,
    );
    return route.fulfill({ json: result });
  });
  await page.route("**/api/**/ssh-accesses**", handle);
  await page.route("**/api/ssh-accesses**", handle);
  async function handle(route) {
    const request = route.request(),
      path = new URL(request.url()).pathname,
      method = request.method();
    const body = request.postData() ? request.postDataJSON() : null;
    state.calls.push({ path, method, body });
    if (state.fail && method !== "GET")
      return route.fulfill({ status: 409, json: { error: "Fixture conflict" } });
    let result;
    if (path.endsWith("/scan"))
      result = { hostKey: access.hostKey, hostFingerprint: access.hostFingerprint };
    else if (path.includes("/sessions/")) {
      if (method === "PUT") state.assignedIds = body.accessIds;
      result = {
        accesses: state.accesses,
        assignedIds: state.assignedIds,
        commands: state.assignedIds.map((id) => ({
          id,
          command:
            "node '/fixture/ssh.mjs' --data-dir '/fixture/data' --session fixture-session --access ssh-one",
        })),
      };
    } else if (method === "POST" && path.endsWith("/test")) result = { ok: true };
    else if (method === "POST") {
      const created = {
        ...access,
        ...body,
        id: `ssh-${state.accesses.length + 1}`,
        keyName: state.keys.find((key) => key.id === body.keyId)?.name,
      };
      state.accesses.push(created);
      result = created;
    } else if (method === "DELETE") {
      state.accesses = state.accesses.filter(
        (access) => access.id !== path.split("/").at(-1),
      );
      return route.fulfill({ status: 204 });
    } else if (method === "PATCH") {
      state.accesses[0] = { ...state.accesses[0], ...body };
      result = state.accesses[0];
    } else result = { accesses: state.accesses };
    return route.fulfill({ json: result });
  }
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value) => {
          window.copiedText = value;
        },
      },
    }),
  );
  await page.addInitScript(() => {
    window.sshTerminalInputs = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try {
        if (JSON.parse(data).type === "input") window.sshTerminalInputs.push(data);
      } catch {
        /* Non-JSON transport frame. */
      }
      return send.call(this, data);
    };
  });
  state.access = access;
  return state;
}
