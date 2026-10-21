/**
 * Records what a user's page asks the server for: every HTTP request to /api or
 * /auth and every WebSocket. Her app may make HTTP requests only to /auth and /api/me,
 * and open only an agent chat stream, a browser view or dictation, the sockets
 * docs/users.md names and server/http/socket-access.js admits.
 */
const allowedHttp = /^\/(auth\/[a-z-]+|api\/me(\/.*)?)$/;
const allowedSockets = [
  /^\/api\/assistant-conversations\/[^/]+\/stream$/,
  /^\/api\/assistants\/[A-Za-z0-9_-]+\/browser-stream$/,
  /^\/api\/dictation\/stream$/,
];

export function userRequestLog(page) {
  const http = [];
  const sockets = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (/^\/(api|auth)(\/|$)/.test(pathname))
      http.push(`${request.method()} ${pathname}`);
  });
  page.on("websocket", (socket) => sockets.push(new URL(socket.url()).pathname));
  return {
    http,
    sockets,
    /** Every request and socket outside her allowed paths. */
    violations: () => [
      ...http.filter((entry) => !allowedHttp.test(entry.split(" ")[1])),
      ...sockets
        .filter((path) => !allowedSockets.some((pattern) => pattern.test(path)))
        .map((path) => `WS ${path}`),
    ],
  };
}
