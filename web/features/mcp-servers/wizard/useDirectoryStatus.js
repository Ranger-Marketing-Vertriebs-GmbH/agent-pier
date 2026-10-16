import { useEffect, useState } from "react";
import { directoryApi } from "./directory-api.js";

/** Whether the directory card can be used: on, and the registry answered its health check. */
export default function useDirectoryStatus() {
  const [state, setState] = useState({ status: null, error: "" });
  useEffect(() => {
    let live = true;
    directoryApi.status().then(
      (status) => live && setState({ status, error: "" }),
      (failure) => live && setState({ status: null, error: failure.message }),
    );
    return () => {
      live = false;
    };
  }, []);
  return state;
}
