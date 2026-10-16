import { useEffect, useState } from "react";
import { assistantApi } from "../../assistants/assistant-api.js";

const idle = { state: "idle", path: "" };

/** Where an own command resolves on the service PATH, 400 ms after typing settles. */
export default function useCommandResolve(command) {
  const [result, setResult] = useState(idle);
  useEffect(() => {
    const name = command.trim();
    if (!name) {
      setResult(idle);
      return undefined;
    }
    let live = true;
    setResult({ state: "checking", path: "" });
    const timer = setTimeout(() => {
      assistantApi.resolveMcpCommand(name).then(
        (found) =>
          live &&
          setResult(
            found?.found
              ? { state: "found", path: found.path }
              : { state: "missing", path: "" },
          ),
        () => live && setResult(idle),
      );
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [command]);
  return result;
}
