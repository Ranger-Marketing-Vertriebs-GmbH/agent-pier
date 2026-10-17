// The managed agent browser: a pinned Chrome for Testing build (AGENTPIER-121).
// Chrome for Testing publishes its downloads at
// https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json
// but no checksums, so the SHA-256 and size of each archive are pinned here; they
// were computed from the downloads below on 2026-10-17. Updating the browser means
// raising `version` and replacing every platform's url, sha256 and size
// (docs/assistant-gateway.md "Managed agent browser").
export const chromiumManifest = {
  version: "155.0.8059.84",
  platforms: {
    "mac-arm64": {
      url: "https://storage.googleapis.com/chrome-for-testing-public/155.0.8059.84/mac-arm64/chrome-mac-arm64.zip",
      sha256: "13b9e98ce56f5ce18e100a009f455c9285f399e7c9dc8a76fdf2f3a9755bb5f2",
      size: 192672771,
      executable:
        "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      app: "chrome-mac-arm64/Google Chrome for Testing.app",
    },
    "mac-x64": {
      url: "https://storage.googleapis.com/chrome-for-testing-public/155.0.8059.84/mac-x64/chrome-mac-x64.zip",
      sha256: "d805a173118daa5f6f5cf464500789e1e00022a9a6aed8abfec821ab828fa862",
      size: 203150281,
      executable:
        "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      app: "chrome-mac-x64/Google Chrome for Testing.app",
    },
    linux64: {
      url: "https://storage.googleapis.com/chrome-for-testing-public/155.0.8059.84/linux64/chrome-linux64.zip",
      sha256: "cf0f049892dea22e6a6db26d47ed0d7776b7158edcbec4634086633df8bafcbc",
      size: 199014491,
      executable: "chrome-linux64/chrome",
    },
    "linux-arm64": {
      url: "https://storage.googleapis.com/chrome-for-testing-public/155.0.8059.84/linux-arm64/chrome-linux-arm64.zip",
      sha256: "1692a407908867de88eb1f1b2a93ca47c348d8fb2e3c04752d966e0f2e0344b4",
      size: 198807353,
      executable: "chrome-linux-arm64/chrome",
    },
  },
};

/** The manifest platform key for this host, or null when none is published. */
export function chromiumPlatform(platform = process.platform, arch = process.arch) {
  const key = {
    "darwin-arm64": "mac-arm64",
    "darwin-x64": "mac-x64",
    "linux-x64": "linux64",
    "linux-arm64": "linux-arm64",
  }[`${platform}-${arch}`];
  return key || null;
}
