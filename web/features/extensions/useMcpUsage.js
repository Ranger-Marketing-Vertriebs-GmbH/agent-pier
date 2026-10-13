import { useEffect, useState } from "react";

/**
 * GET /accounts/usage once per page visit. It feeds the MCP reference row's count;
 * a failed or pending read stays null, so the row shows "—" instead of a made-up 0.
 */
export default function useMcpUsage(request) {
  const [usage, setUsage] = useState(null);
  useEffect(() => {
    let current = true;
    request("/accounts/usage")
      .then((next) => {
        if (current) setUsage(next);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [request]);
  return usage;
}
