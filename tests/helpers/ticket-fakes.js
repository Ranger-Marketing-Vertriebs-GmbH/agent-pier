import http from "node:http";

// Fake GitHub issues API on 127.0.0.1. `issues` are raw GitHub issue objects;
// `failures` maps "METHOD /path" (query ignored) to an HTTP status.
export async function fakeGithub(t, { issues = [], failures = {} } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url, "http://127.0.0.1");
      const raw = Buffer.concat(chunks).toString("utf8");
      calls.push({
        method: req.method,
        path: req.url,
        body: raw ? JSON.parse(raw) : undefined,
        authorization: req.headers.authorization,
      });
      const send = (status, data) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };
      const failure = failures[`${req.method} ${url.pathname}`];
      if (failure) return send(failure, { message: "failure" });
      const list = /^\/repos\/([^/]+)\/([^/]+)\/issues$/.exec(url.pathname);
      if (req.method === "GET" && list) {
        const label = url.searchParams.get("labels");
        const page = Number(url.searchParams.get("page") || 1);
        const size = Number(url.searchParams.get("per_page") || 30);
        const open = issues
          .filter((issue) => issue.state !== "closed")
          .filter((issue) => !label || issue.labels?.some((l) => l.name === label));
        return send(200, open.slice((page - 1) * size, page * size));
      }
      const one = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(url.pathname);
      if (req.method === "GET" && one) {
        const issue = issues.find((item) => item.number === Number(one[3]));
        return issue ? send(200, issue) : send(404, { message: "Not Found" });
      }
      if (req.method === "POST" && /\/issues\/\d+\/(labels|comments)$/.test(url.pathname))
        return send(200, []);
      send(404, { message: "Not Found" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const fetchImpl = (url, init) =>
    fetch(String(url).replace("https://api.github.com", origin), init);
  return { origin, fetchImpl, calls };
}

export function githubIssue(number, extra = {}) {
  return {
    number,
    title: `Issue ${number}`,
    body: `Body ${number}`,
    html_url: `https://github.com/acme/app/issues/${number}`,
    state: "open",
    labels: [],
    updated_at: "2026-11-01T10:00:00Z",
    ...extra,
  };
}
