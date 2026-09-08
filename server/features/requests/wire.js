import readline from "node:readline";
export function messages(socket, callback, invalid = () => socket.destroy()) {
  let size = 0;
  socket.on("data", (chunk) => {
    size += chunk.length;
    if (size > 1024 * 1024) invalid();
  });
  const lines = readline.createInterface({ input: socket });
  lines.on("error", invalid);
  lines.on("line", (line) => {
    size = 0;
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw Error();
      Promise.resolve(callback(value)).catch(invalid);
    } catch {
      invalid();
    }
  });
  socket.once("close", () => lines.close());
}
export function send(socket, value) {
  if (!socket || socket.destroyed || !socket.writable) return false;
  socket.write(JSON.stringify(value) + "\n");
  return true;
}
