/** Bound local waiting; abort never implies that the server cancelled a mutation. */
export async function modelRequest(request, path, method, body, timeoutMessage, signal) {
  const controller = new AbortController();
  let timer, abort;
  try {
    return await Promise.race([
      new Promise((_, reject) => {
        abort = () => {
          controller.abort();
          reject(
            Object.assign(new Error(timeoutMessage), { code: "MODEL_REQUEST_TIMEOUT" }),
          );
        };
        signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(abort, 15000);
        if (signal?.aborted) abort();
      }),
      request(path, method, body, controller.signal),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
