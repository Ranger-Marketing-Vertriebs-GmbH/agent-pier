// The managed GitHub MCP server for agents (AGENTPIER-129): a pinned release of the
// official server (https://github.com/github/github-mcp-server). The SHA-256 of each
// archive is the release's own github-mcp-server_<version>_checksums.txt, checked
// against the downloads on 2026-10-17. Updating the server means raising `version`
// and replacing every platform's url, sha256 and size (docs/github-agents.md).
const release = "https://github.com/github/github-mcp-server/releases/download/v2.0.2";
export const githubMcpManifest = {
  version: "2.0.2",
  platforms: {
    "darwin-arm64": {
      url: `${release}/github-mcp-server_Darwin_arm64.tar.gz`,
      sha256: "5d9b38511bffc84d2272eb6189129eb721c8900e45784d8ea7eaf25f8d3dd835",
      size: 8848361,
    },
    "darwin-x64": {
      url: `${release}/github-mcp-server_Darwin_x86_64.tar.gz`,
      sha256: "7ac4d549e0bf37ad9efee7be7913cae4ad50cea8d9d5be1afa9a6dbcee9d1f2c",
      size: 9427411,
    },
    "linux-arm64": {
      url: `${release}/github-mcp-server_Linux_arm64.tar.gz`,
      sha256: "73f5e76c6a3b5e0d731e1134a7c38575df6ec96c646192095a3be2d4d0d6c1fc",
      size: 8417035,
    },
    "linux-x64": {
      url: `${release}/github-mcp-server_Linux_x86_64.tar.gz`,
      sha256: "815e27d931c796af0c97f24fd211e14f8a4607d4528377719a5ad2352086b0b0",
      size: 9209049,
    },
  },
};

/** The manifest entry for this host, or null when none is published. */
export const githubMcpPlatform = (
  manifest = githubMcpManifest,
  platform = process.platform,
  arch = process.arch,
) => manifest.platforms[`${platform}-${arch}`] || null;
