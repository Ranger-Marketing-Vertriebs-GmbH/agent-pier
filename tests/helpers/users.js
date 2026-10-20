import { WebSocket } from "ws";

export const userPassword = "temporary-user-password";
const cookieOf = (response) => response.headers.get("set-cookie").split(";")[0];

/** Creates a restricted user in the fixture's store and signs her in over HTTP. */
export async function signedInUser(f, username = "Anna", displayName = username) {
  const user = await f.application.users.create({
    username,
    displayName,
    password: userPassword,
  });
  return { user, cookie: await signIn(f, username) };
}

export async function signIn(f, username, password = userPassword) {
  const response = await f.request("/auth/login", {
    method: "POST",
    headers: { cookie: "" },
    body: { username, password },
  });
  if (response.status !== 200) throw new Error(`Sign-in failed: ${response.status}`);
  return cookieOf(response);
}

/** Resolves the HTTP status of a refused upgrade; rejects when the socket opens. */
export function upgradeStatus(f, endpoint, cookie) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(f.url.replace("http", "ws") + endpoint, {
      headers: { cookie, origin: f.url },
    });
    socket.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode);
      res.destroy();
      socket.terminate();
    });
    socket.on("error", () => {});
    socket.on("open", () => {
      socket.terminate();
      reject(new Error(`${endpoint} opened`));
    });
  });
}
