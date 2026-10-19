import test from "node:test";
import assert from "node:assert/strict";
import {
  cliSupport as server,
  clis,
} from "../../server/features/mcp-servers/cli-native.js";
import {
  cliSupport as browser,
  clis as browserClis,
} from "../../web/features/mcp-servers/cli-support.js";

test("the form disables exactly what the server refuses", () => {
  assert.deepEqual(browserClis, clis);
  for (const cli of clis)
    for (const transport of ["http", "sse", "stdio"])
      for (const cwd of [null, "", "/tmp"])
        for (const agentPlaceholders of [false, true])
          assert.deepEqual(
            browser(cli, { transport, cwd, agentPlaceholders }),
            server(cli, { transport, cwd, agentPlaceholders }),
            `${cli}/${transport}/${cwd}/${agentPlaceholders}`,
          );
});
