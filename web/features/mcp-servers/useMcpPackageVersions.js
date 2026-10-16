import { useEffect, useState } from "react";
import { assistantApi } from "../assistants/assistant-api.js";

const empty = {
  loading: false,
  failed: false,
  error: "",
  latest: null,
  versions: [],
  publisher: null,
  repositoryUrl: null,
};

/**
 * Versions of `name` in `registry`, fetched 400 ms after the name settles. A failure
 * keeps the server's message (package not found, registry unreachable). `publisher`
 * and `repositoryUrl` name who publishes the package and where its source lives.
 */
export default function useMcpPackageVersions(registry, name) {
  const [state, setState] = useState(empty);
  useEffect(() => {
    const trimmed = name.trim();
    if (!trimmed) {
      setState(empty);
      return undefined;
    }
    let live = true;
    setState({ ...empty, loading: true });
    const timer = setTimeout(() => {
      assistantApi
        .mcpPackageVersions(registry, trimmed)
        .then(
          (result) =>
            live &&
            setState({
              ...empty,
              latest: result?.latest ?? null,
              versions: Array.isArray(result?.versions) ? result.versions : [],
              publisher: typeof result?.publisher === "string" ? result.publisher : null,
              repositoryUrl:
                typeof result?.repositoryUrl === "string" ? result.repositoryUrl : null,
            }),
        )
        .catch(
          (failure) =>
            live && setState({ ...empty, failed: true, error: failure.message || "" }),
        );
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [registry, name]);
  return state;
}
