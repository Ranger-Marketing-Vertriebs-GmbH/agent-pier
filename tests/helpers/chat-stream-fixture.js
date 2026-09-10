/** Publish fixture changes explicitly, using the same stream boundary as production. */
export async function mockChatStream(page, snapshot) {
  const sockets = new Map();
  const send = (socket) => {
    const sequence = sockets.get(socket) + 1;
    sockets.set(socket, sequence);
    socket.send(JSON.stringify({ type: "snapshot", sequence, snapshot: snapshot() }));
  };
  await page.routeWebSocket("**/api/sessions/*/chat-stream", (socket) => {
    sockets.set(socket, 0);
    socket.onClose(() => sockets.delete(socket));
    send(socket);
  });
  return () => {
    for (const socket of sockets.keys()) send(socket);
  };
}
