import { useEffect, useState } from "react";
import api from "../../lib/api.js";
export default function useMcpResource(path) {
  const [result, setResult] = useState({ path: "", data: null, error: "" });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api(path, "GET", undefined, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setResult({ path, data, error: "" });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setResult({ path, data: null, error: error.message });
      });
    return () => controller.abort();
  }, [path, revision]);
  return {
    data: result.path === path ? result.data : null,
    error: result.path === path ? result.error : "",
    reload: () => {
      setResult({ path: "", data: null, error: "" });
      setRevision((value) => value + 1);
    },
  };
}
