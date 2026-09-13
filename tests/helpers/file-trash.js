import { fixture } from "./file-publisher.js";
import { readFileLimits } from "../../server/features/files/file-limits.js";
export async function trashFixture(t, intercept) {
  const f = await fixture(t, intercept);
  const { FileTrash } = await import("../../server/features/files/file-trash.js");
  f.trash = new FileTrash({ ...f, limits: readFileLimits() });
  t.after(() => f.trash.close());
  return f;
}
