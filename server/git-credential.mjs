import fs from "node:fs";

// A private file exists only during this clone. Git may call store/erase too;
// neither operation must persist the token into any credential manager.
if (process.argv[2] === "get") {
  try {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 65536) throw new Error("Input too long");
    }
    const fields = new Map();
    for (const line of input.split("\n")) {
      if (!line) break;
      const index = line.indexOf("=");
      // Git's protocol includes repeated capability[] and wwwauth[] extensions.
      // Ignore these; duplicate scalar fields remain ambiguous and are rejected.
      if (index > 1 && line.slice(0, index).endsWith("[]")) continue;
      if (index < 1 || fields.has(line.slice(0, index)))
        throw new Error("Invalid credential request");
      fields.set(line.slice(0, index), line.slice(index + 1));
    }
    const secret = JSON.parse(
      fs.readFileSync(process.env.AGENTPIER_GIT_CREDENTIAL_FILE, "utf8"),
    );
    const host = fields.get("host");
    if (fields.get("protocol") !== "https" || !host || /[\s/@\\?#]/.test(host))
      throw new Error("Origin mismatch");
    const origin = new URL(`https://${host}`).origin;
    if (
      origin !== secret.host ||
      typeof secret.token !== "string" ||
      /[\x00-\x1f\x7f]/.test(secret.token)
    )
      throw new Error("Origin mismatch");
    process.stdout.write(`username=x-access-token\npassword=${secret.token}\n\n`);
  } catch {
    // Fail closed and never print parsed input, filesystem errors, or secrets.
  }
}
