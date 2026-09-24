import { useState } from "react";
import useAsyncAction from "../../lib/useAsyncAction.js";

// Run actions offered in several places share one lock and busy state, so a pending
// decision disables the header actions too. Each place keeps its own error message.
export default function useRunAction(shared) {
  const own = useAsyncAction();
  const [error, setError] = useState("");
  if (!shared) return own;
  return {
    busy: shared.busy,
    lock: shared.lock,
    error,
    run: async (action) => {
      if (shared.lock.current) return;
      setError("");
      let failure = null;
      const result = await shared.run(async () => {
        try {
          return await action();
        } catch (caught) {
          failure = caught;
        }
      });
      if (failure) setError(failure.message);
      return result;
    },
  };
}
