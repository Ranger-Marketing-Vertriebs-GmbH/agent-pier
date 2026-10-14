import fs from "node:fs";
import { parseCredentialRequest } from "./features/repositories/git-credential-request.js";

// A private file exists only during this clone. Git may call store/erase too;
// neither operation must persist the token into any credential manager.
if (process.argv[2] === "get") {
  try {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 65536) throw new Error("Input too long");
    }
    const fields = parseCredentialRequest(input);
    if (!fields) throw new Error("Invalid credential request");
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
