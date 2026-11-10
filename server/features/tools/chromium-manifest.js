// The managed agent browser: a pinned Chrome for Testing build (AGENTPIER-121).
// Chrome for Testing publishes its downloads at
// https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json
// but no checksums, so the SHA-256 and size of each archive are pinned here; they
// were computed from the downloads below on 2026-11-10. Updating the browser means
// raising `version` and replacing every platform's url, sha256 and size
// (docs/assistant-gateway.md "Managed agent browser").
export const chromiumManifest = {
  version: "157.0.8103.50",
  platforms: {
    "mac-arm64": {
      url: "https://storage.googleapis.com/chrome-for-testing-public/157.0.8103.50/mac-arm64/chrome-mac-arm64.zip",
      sha256: "aceb0578a1cc3631358b164dbbef04bf8936f96c690fb78c3ac25b7655e795e8",
      size: 196583703,
      executable:
        "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      app: "chrome-mac-arm64/Google Chrome for Testing.app",
    },
    "mac-x64": {
      url: "https://storage.googleapis.com/chrome-for-testing-public/157.0.8103.50/mac-x64/chrome-mac-x64.zip",
      sha256: "7b1c12bee8024f1193b28754aa0d46b7eaa08394de51bef84fd65a6cf08d61dc",
      size: 207136222,
      executable:
        "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      app: "chrome-mac-x64/Google Chrome for Testing.app",
    },
    linux64: {
      url: "https://storage.googleapis.com/chrome-for-testing-public/157.0.8103.50/linux64/chrome-linux64.zip",
      sha256: "d17167bc092eb495a3b768c7467f27e35f625aa03834233a1663af67dcb668c9",
      size: 203527334,
      executable: "chrome-linux64/chrome",
    },
    "linux-arm64": {
      url: "https://storage.googleapis.com/chrome-for-testing-public/157.0.8103.50/linux-arm64/chrome-linux-arm64.zip",
      sha256: "9539c1612121eb09c4b787f4f9d0c732357772eb22583620ffed64d50dd6c4cc",
      size: 203292807,
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
