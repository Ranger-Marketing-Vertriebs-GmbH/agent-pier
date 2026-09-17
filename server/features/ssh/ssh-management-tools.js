const string = { type: "string", minLength: 1, maxLength: 100 };
const requestId = { ...string, maxLength: 80 };
const tool = (name, description, properties, required = []) => ({
  name,
  description,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
});
export const sshManagementTools = [
  tool(
    "ssh_list_keys",
    "List public metadata of keys owned by this session's project. Never returns private key contents.",
    { page: { type: "integer", minimum: 1 } },
  ),
  tool(
    "ssh_generate_key",
    "Generate a managed Ed25519 key for this project. Reuse requestId only for an identical retry after an uncertain outcome. Returns public key and fingerprint; install the public key through an existing authorized access.",
    { name: string, requestId },
    ["name", "requestId"],
  ),
  tool(
    "ssh_import_key",
    "Import an existing unencrypted private key from an absolute local path or ~/path. AgentPier reads and copies the file without changing it. Never paste private bytes here. Returns public metadata; identical project keys are reused. Retry with the same requestId and arguments after an uncertain outcome.",
    { name: string, sourcePath: { type: "string", maxLength: 4096 }, requestId },
    ["name", "sourcePath", "requestId"],
  ),
  tool(
    "ssh_get_public_key",
    "Get the public key and fingerprint of a project-owned key for installation on a host. Private export is available only in the owner UI.",
    { keyId: string },
    ["keyId"],
  ),
  tool(
    "ssh_scan_host",
    "Observe a server host key. Scanning does NOT verify server identity or grant access. Verify through an existing pinned access, trusted provider console/API or the user before registering.",
    {
      host: { type: "string", maxLength: 253 },
      port: { type: "integer", minimum: 1, maximum: 65535 },
    },
    ["host"],
  ),
  tool(
    "ssh_register_host",
    "Register a host for all sessions of this project using a project-owned key and independently verified host key. Does not install keys or connect. Preserve existing authorized_keys when bootstrapping through existing access/provider tools; test afterward. Reuse requestId only for identical retries. Editing/deletion is owner UI only.",
    {
      name: string,
      host: { type: "string", maxLength: 253 },
      port: { type: "integer", minimum: 1, maximum: 65535 },
      username: string,
      keyId: string,
      hostKey: { type: "string", maxLength: 16384 },
      requestId,
      trustSource: {
        type: "object",
        properties: {
          kind: { enum: ["existing", "provider", "user"] },
          accessId: string,
        },
        required: ["kind"],
        additionalProperties: false,
      },
    },
    ["name", "host", "username", "keyId", "hostKey", "trustSource", "requestId"],
  ),
  tool(
    "ssh_test_host",
    "Test authentication and the pinned identity of an effective project or explicitly assigned host by running true. Failure does not roll back local or remote keys.",
    { accessId: string },
    ["accessId"],
  ),
];
