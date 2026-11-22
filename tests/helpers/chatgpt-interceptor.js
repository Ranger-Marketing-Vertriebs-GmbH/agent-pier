import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

// A proxy for a native OpenClaw that reaches ChatGPT without leaving the host: every
// CONNECT to chatgpt.com:443 is answered by a local TLS endpoint whose certificate a
// throwaway CA signed, and its plain HTTP goes to `target` (startFakeCodex). Every
// other host is refused, and `tunnels` records each CONNECT host. The process under
// test trusts the CA only through NODE_EXTRA_CA_CERTS=`caFile`.
const host = "chatgpt.com";

function issue(dir) {
  const run = (args) =>
    execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  const key = ["-newkey", "rsa:2048", "-nodes"];
  const days = ["-days", "2"];
  run(
    ["req", "-x509", ...key, ...days, "-keyout", "ca.key", "-out", "ca.pem"].concat([
      "-subj",
      "/CN=agentpier-test-ca",
    ]),
  );
  run(["req", ...key, "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", `/CN=${host}`]);
  fs.writeFileSync(path.join(dir, "leaf.ext"), `subjectAltName=DNS:${host}\n`);
  const ca = ["-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial"];
  run(
    ["x509", "-req", "-in", "leaf.csr", ...ca, ...days, "-out", "leaf.pem"].concat([
      "-extfile",
      "leaf.ext",
    ]),
  );
  return {
    caFile: path.join(dir, "ca.pem"),
    cert: fs.readFileSync(path.join(dir, "leaf.pem")),
    key: fs.readFileSync(path.join(dir, "leaf.key")),
  };
}

export async function startChatgptInterceptor({ target }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-interceptor-"));
  const { caFile, cert, key } = issue(dir);
  const tunnels = [];
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    return socket;
  };
  const proxy = net.createServer((socket) => {
    track(socket);
    socket.once("data", (chunk) => {
      const [method, authority = ""] = chunk
        .toString("latin1")
        .split("\r\n")[0]
        .split(" ");
      const name = authority.replace(/:\d+$/, "").toLowerCase();
      tunnels.push(name);
      if (method !== "CONNECT" || authority.toLowerCase() !== `${host}:443`)
        return socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const secure = track(new tls.TLSSocket(socket, { isServer: true, cert, key }));
      const upstream = track(net.connect(target, "127.0.0.1"));
      secure.pipe(upstream).pipe(secure);
    });
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${proxy.address().port}`,
    caFile,
    tunnels,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => proxy.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
