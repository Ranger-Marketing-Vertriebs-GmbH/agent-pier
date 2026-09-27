import { useEffect, useState } from "react";
import api from "../../lib/api.js";
import { prepareArtifactDocument } from "./artifact-document.js";
import { artifactNavigationType } from "./artifact-navigation.js";

export default function useArtifactDocument(id, frame) {
  const [snapshot, setSnapshot] = useState(null);
  const [history, setHistory] = useState([]);
  const [state, setState] = useState(null);
  const [linkError, setLinkError] = useState(false);
  const target = history.at(-1);
  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    setLinkError(false);
    api(
      `/artifacts/${encodeURIComponent(id)}/bundle`,
      "GET",
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (!alive) return;
        setSnapshot({ id, value });
        setHistory([{ path: value.entrypoint, fragment: "" }]);
      })
      .catch(() => {
        if (alive) setState({ id, error: "unavailable" });
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [id]);
  useEffect(() => {
    if (snapshot?.id !== id || !target) return;
    let alive = true;
    prepareArtifactDocument(
      { ...snapshot.value, entrypoint: target.path },
      { fragment: target.fragment },
    )
      .then((document) => {
        if (alive) setState({ id, target, ...document });
      })
      .catch(() => {
        if (alive) setState({ id, target, error: "unsupported" });
      });
    return () => {
      alive = false;
    };
  }, [id, snapshot, target]);
  const current =
    state?.id === id && (!state.target || state.target === target) ? state : null;
  useEffect(() => {
    function navigate(event) {
      if (
        !current?.resolveLink ||
        event.source !== frame.current?.contentWindow ||
        event.data?.type !== artifactNavigationType ||
        event.data?.token !== current.navigationToken
      )
        return;
      try {
        const next = current.resolveLink(event.data.href);
        setLinkError(false);
        setHistory((previous) => [...previous.slice(-99), next]);
      } catch {
        setLinkError(true);
      }
    }
    window.addEventListener("message", navigate);
    return () => window.removeEventListener("message", navigate);
  }, [current, frame]);
  return {
    current,
    title: snapshot?.id === id ? snapshot.value.artifact.title : null,
    linkError,
    canGoBack: history.length > 1,
    goBack() {
      setLinkError(false);
      setHistory((previous) => previous.slice(0, -1));
    },
  };
}
