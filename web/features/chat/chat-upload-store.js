const DATABASE = "agentpier.chat.uploads.v1";

// Each transaction is committed before its promise resolves. No file leaves the
// browser before its recovery copy has been saved successfully.
export async function uploadStore(scope, action, value) {
  // WebKit may reject Blob/File values in IndexedDB (notably private contexts).
  // ArrayBuffer keeps the exact bytes durable without relying on blob backing files.
  if (action === "put" && value.file instanceof Blob) {
    const { file, ...entry } = value;
    value = {
      ...entry,
      bytes: await file.arrayBuffer(),
      type: file.type,
      lastModified: file.lastModified,
    };
  }
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result
        .createObjectStore("files", { keyPath: "key" })
        .createIndex("scope", "scope");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Upload storage blocked"));
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(
        "files",
        action === "list" ? "readonly" : "readwrite",
      );
      const store = transaction.objectStore("files");
      const request =
        action === "list"
          ? store.index("scope").getAll(scope)
          : action === "put"
            ? store.put({ ...value, scope })
            : store.delete(value);
      let result;
      request.onsuccess = () => {
        result = request.result;
      };
      transaction.oncomplete = () =>
        resolve(
          action === "list"
            ? result
                .filter((item) => item.scope === scope)
                .map(({ bytes, type, lastModified, ...item }) => ({
                  ...item,
                  file: new File([bytes], item.name, { type, lastModified }),
                }))
            : result,
        );
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () =>
        reject(transaction.error || new Error("Upload storage aborted"));
    });
  } finally {
    db.close();
  }
}

export function uploadLock(scope, operation, options = {}) {
  if (!navigator.locks) return Promise.reject(new Error("Upload lock unavailable"));
  return navigator.locks.request(`agentpier.upload:${scope}`, options, operation);
}
