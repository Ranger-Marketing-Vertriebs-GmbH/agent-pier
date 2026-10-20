import http from "node:http";

export const tailnetUrl = "https://agentpier.example";

/** Sends a request the way Tailscale Serve forwards it for one tailnet login. */
export function tailnetRequest(f, login, endpoint, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      f.url + endpoint,
      {
        method: body ? "POST" : "GET",
        headers: {
          host: new URL(tailnetUrl).host,
          origin: tailnetUrl,
          "tailscale-user-login": login,
          "content-type": "application/json",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null }),
        );
      },
    );
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
