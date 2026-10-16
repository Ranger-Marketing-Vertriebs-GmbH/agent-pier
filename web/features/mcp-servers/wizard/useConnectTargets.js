import { useEffect, useState } from "react";
import { assistantApi } from "../../assistants/assistant-api.js";

/** The agents Connect offers; none (and no request) while agents are off. */
export default function useConnectTargets(agentsEnabled) {
  const [state, setState] = useState({
    assistants: agentsEnabled ? null : [],
    error: "",
  });
  useEffect(() => {
    if (!agentsEnabled) {
      setState({ assistants: [], error: "" });
      return undefined;
    }
    let live = true;
    assistantApi.list().then(
      (result) => live && setState({ assistants: result?.assistants ?? [], error: "" }),
      (failure) => live && setState({ assistants: [], error: failure.message }),
    );
    return () => {
      live = false;
    };
  }, [agentsEnabled]);
  return state;
}
