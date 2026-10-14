import path from "node:path";
import { packageProblem } from "./package-errors.js";

const safe = (file) => {
  if (typeof file !== "string" || !file) return null;
  const normal = path.posix.normalize(file.replaceAll("\\", "/"));
  if (path.posix.isAbsolute(normal) || normal.split("/").includes("..")) return null;
  return normal.replace(/^\.\//, "");
};

export function npmPrograms(name, bin) {
  const entries =
    typeof bin === "string" ? [[name.split("/").pop(), bin]] : Object.entries(bin || {});
  return entries
    .map(([program, file]) => ({ name: program, path: safe(file) }))
    .filter(
      (program) => program.path && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(program.name),
    );
}

export function chooseProgram(programs, wanted) {
  if (!programs.length) throw packageProblem("MCP_PACKAGE_NO_PROGRAM", 400);
  if (programs.length === 1 && (wanted === undefined || wanted === programs[0].name))
    return programs[0];
  const chosen = programs.find((program) => program.name === wanted);
  if (!chosen) throw packageProblem("MCP_PACKAGE_PROGRAM_REQUIRED", 400);
  return chosen;
}
