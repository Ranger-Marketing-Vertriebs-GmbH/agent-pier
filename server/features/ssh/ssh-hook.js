import { isMainModule } from "../../lib/is-main-module.js";

// Discovery only: authorization and all ssh access belong to the broker.
export function sshReminder(prefix = "") {
  return `Project SSH tools are available, including projects with no saved hosts. Discover keys with ${prefix}ssh_list_keys and hosts with ${prefix}ssh_list_hosts. Generate a managed key or import an existing local key by sourcePath; retrieve its public key. Bootstrap only through existing authorized SSH access or a provider workflow, preserving existing authorized keys and selecting the intended remote user. Verify host identity through an independent trusted source before ssh_register_host, then ssh_test_host. A scan is unverified; ask for a trusted fingerprint when none is available. Reuse request IDs after uncertain outcomes. Share only public metadata in chat; private-key download is available in the AgentPier UI. Do not automatically provision or connect.`;
}

function emitReminder() {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: sshReminder(),
      },
    }) + "\n",
  );
}

export async function runSshHook() {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    process.stdin.destroy();
  }, 2000);
  timer.unref();
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 64 * 1024) throw Error("Oversized input");
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (text.trim()) JSON.parse(text);
    emitReminder();
  } catch {
    if (timedOut) {
      // The reminder does not depend on native input. A host that leaves stdin
      // open must not suppress discovery, even when its last JSON chunk is partial.
      emitReminder();
    } else process.stderr.write("agentpier-ssh: discovery input unavailable\n");
  } finally {
    clearTimeout(timer);
  }
}

if (isMainModule(import.meta.url)) await runSshHook();
