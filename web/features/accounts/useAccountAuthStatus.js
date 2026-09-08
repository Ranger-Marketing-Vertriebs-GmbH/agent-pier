import { useEffect, useState } from "react";
import api from "../../lib/api.js";

export default function useAccountAuthStatus(account) {
  const [auth, setAuth] = useState("unknown");
  const native = !account.provider && !account.internal;
  useEffect(() => {
    if (
      !native ||
      account.hasSecret ||
      !["claude", "codex", "opencode"].includes(account.tool)
    )
      return;
    const controller = new AbortController();
    let timer;
    async function poll() {
      try {
        const result = await api(
          `/accounts/${account.id}/auth-status`,
          "GET",
          undefined,
          controller.signal,
        );
        if (!controller.signal.aborted) setAuth(result.state || "unknown");
      } catch {
        if (!controller.signal.aborted) setAuth("unknown");
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 10000);
    }
    poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [account.id, account.tool, account.hasSecret, native]);
  return auth;
}
