import { useEffect, useRef, useState } from "react";

// A page-level replace (canonical id, first project, clamped page) must not race the
// app's own URL normalisation, and a refused replace must not be retried forever.
// Every wait and every quick refusal spends one attempt of a single budget per target.
export const settledReplaceLimits = { attempts: 40, delay: 50, promptAfter: 250 };

export function nextReplaceStep({
  attempts,
  settled,
  max = settledReplaceLimits.attempts,
}) {
  if (attempts >= max) return "stop";
  return settled ? "navigate" : "wait";
}

// A refusal that took long was most likely a person declining the unsaved-changes
// prompt; asking again would repeat that prompt, so only quick refusals (a concurrent
// navigation or a history step in flight) are retried.
export function retryAfterRefusal({
  attempts,
  elapsed,
  max = settledReplaceLimits.attempts,
  promptAfter = settledReplaceLimits.promptAfter,
}) {
  return attempts + 1 < max && elapsed < promptAfter;
}

const currentLocation = () => window.location.pathname + window.location.search;

export default function useSettledReplace({ target, targetPath, currentPath, navigate }) {
  const key = target ? targetPath : "";
  const [progress, setProgress] = useState({ key: "", attempts: 0 });
  const attempts = progress.key === key ? progress.attempts : 0;
  const latest = useRef({ target, navigate });
  latest.current = { target, navigate };
  useEffect(() => {
    if (!key) return;
    let active = true,
      timer;
    const retry = () => {
      if (!active) return;
      timer = setTimeout(
        () =>
          setProgress((value) => ({
            key,
            attempts: (value.key === key ? value.attempts : 0) + 1,
          })),
        settledReplaceLimits.delay,
      );
    };
    const step = nextReplaceStep({
      attempts,
      settled: currentLocation() === currentPath,
    });
    if (step === "wait") retry();
    else if (step === "navigate") {
      const started = Date.now();
      Promise.resolve(latest.current.navigate(latest.current.target, true)).then(
        (accepted) => {
          if (
            accepted === false &&
            retryAfterRefusal({ attempts, elapsed: Date.now() - started })
          )
            retry();
        },
      );
    }
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [key, attempts, currentPath]);
}
