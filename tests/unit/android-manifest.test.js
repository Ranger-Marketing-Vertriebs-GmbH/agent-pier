import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import yazl from "yazl";
import {
  androidManifest,
  androidPlatform,
  diskBytes,
  downloadBytes,
} from "../../server/features/devices/android-manifest.js";
import {
  manifestEntry,
  parseIndex,
  pick,
  pinnedArchives,
  refreshAndroidManifest,
} from "../../scripts/refresh-android-manifest.mjs";

// The pinned Android components (android-manifest.js) and the pure part of the
// script that computes their entries; nothing here reaches the network.
const keys = ["darwin-arm64", "linux-x64"];
const components = ["emulator", "platformTools", "image"];

test("every pinned archive names an HTTPS download on dl.google.com with its digest", () => {
  assert.deepEqual(androidManifest.hosts, ["dl.google.com"]);
  for (const component of components) {
    assert.deepEqual(Object.keys(androidManifest[component].archives).sort(), keys);
    for (const key of keys) {
      const archive = androidManifest[component].archives[key];
      assert.ok(archive.url.startsWith("https://dl.google.com/"), archive.url);
      assert.ok(archive.url.startsWith(androidManifest.baseUrl), archive.url);
      assert.match(archive.sha256, /^[a-f0-9]{64}$/);
      for (const field of ["size", "expandedBytes", "files"])
        assert.ok(Number.isSafeInteger(archive[field]) && archive[field] > 0, field);
      assert.ok(archive.expandedBytes > archive.size);
      assert.match(archive.top, /^[a-z0-9_-]+$/);
    }
  }
  assert.equal(androidManifest.emulator.archives["linux-x64"].top, "emulator");
  assert.equal(androidManifest.platformTools.archives["linux-x64"].top, "platform-tools");
  for (const [key, abi] of [
    ["darwin-arm64", "arm64-v8a"],
    ["linux-x64", "x86_64"],
  ]) {
    const image = androidManifest.image.archives[key];
    assert.equal(image.abi, abi);
    // The image unpacks into a folder named after its ABI.
    assert.equal(image.top, abi);
  }
});

test("the pin and the device shape are the proven ones", () => {
  assert.equal(androidManifest.emulator.version, "37.3.10");
  assert.equal(androidManifest.emulator.build, "16970787");
  assert.equal(androidManifest.platformTools.version, "37.0.3");
  const { id, api, tag, revision } = androidManifest.image;
  assert.deepEqual(
    { id, api, tag, revision },
    { id: "android-36-google_apis-r7", api: 36, tag: "google_apis", revision: 7 },
  );
  assert.deepEqual(androidManifest.shape, {
    width: 720,
    height: 1600,
    density: 320,
    cores: 4,
    memoryMb: 2048,
    dataPartition: "6G",
  });
  assert.ok(androidManifest.licences.length);
  for (const licence of androidManifest.licences) {
    assert.match(licence.id, /^[a-z0-9-]+$/);
    assert.ok(licence.name);
    assert.ok(licence.url.startsWith("https://"));
  }
});

test("only macOS arm64 and Linux x64 have a platform key", () => {
  assert.equal(androidPlatform("darwin", "arm64"), "darwin-arm64");
  assert.equal(androidPlatform("linux", "x64"), "linux-x64");
  assert.equal(androidPlatform("darwin", "x64"), null);
  assert.equal(androidPlatform("linux", "arm64"), null);
  assert.equal(androidPlatform("win32", "x64"), null);
});

test("download and disk sizes are the sums over the three components", () => {
  for (const key of keys) {
    const archives = components.map((name) => androidManifest[name].archives[key]);
    assert.equal(
      downloadBytes(androidManifest, key),
      archives.reduce((sum, archive) => sum + archive.size, 0),
    );
    assert.equal(
      diskBytes(androidManifest, key),
      archives.reduce((sum, archive) => sum + archive.expandedBytes, 0),
    );
  }
  assert.equal(downloadBytes(androidManifest, "linux-arm64"), 0);
  assert.equal(diskBytes(androidManifest, null), 0);
});

// A cut of Google's index: two revisions of the emulator in different channels, the
// platform tools without a host architecture, and an image without a host.
const archive = (url, size, sha1, host = "") =>
  `<archive><complete><size>${size}</size><checksum type="sha1">${sha1}</checksum>` +
  `<url>${url}</url></complete>${host}</archive>`;
const sha1 = (letter) => letter.repeat(40);
const toolsXml = `<?xml version="1.0" ?>
<sdk:sdk-repository xmlns:sdk="http://schemas.android.com/sdk/android/repo/repository2/03">
  <license id="android-sdk-license" type="text">Terms &lt;and&gt; Conditions</license>
  <remotePackage path="emulator">
    <revision><major>37</major><minor>4</minor><micro>2</micro></revision>
    <uses-license ref="android-sdk-preview-license"/>
    <archives>
      ${archive("emulator-linux_x64-99.zip", 9, sha1("9"), "<host-os>linux</host-os><host-arch>x64</host-arch>")}
    </archives>
  </remotePackage>
  <remotePackage path="emulator">
    <type-details xsi:type="generic:genericDetailsType"/>
    <revision>
      <major>37</major>
      <minor>3</minor>
      <micro>10</micro>
    </revision>
    <uses-license ref="android-sdk-license"/>
    <archives>
      ${archive("emulator-linux_x64-16970787.zip", 350, sha1("a"), "<host-os>linux</host-os><host-arch>x64</host-arch>")}
      ${archive("emulator-darwin_x64-16970787.zip", 487, sha1("b"), "<host-os>macosx</host-os><host-arch>x64</host-arch>")}
      ${archive("emulator-darwin_aarch64-16970787.zip", 420, sha1("c"), "<host-os>macosx</host-os><host-arch>aarch64</host-arch>")}
    </archives>
  </remotePackage>
  <remotePackage path="platform-tools">
    <revision><major>37</major><minor>0</minor><micro>3</micro></revision>
    <uses-license ref="android-sdk-license"/>
    <archives>
      ${archive("platform-tools_r37.0.3-linux.zip", 95, sha1("d"), "<host-os>linux</host-os>")}
      ${archive("platform-tools_r37.0.3-darwin.zip", 165, sha1("e"), "<host-os>macosx</host-os>")}
    </archives>
  </remotePackage>
</sdk:sdk-repository>`;
const image = (abi, licence, letter) => `
  <remotePackage path="system-images;android-36;google_apis;${abi}">
    <revision><major>7</major></revision>
    <uses-license ref="${licence}"/>
    <dependencies><dependency path="emulator"><min-revision><major>35</major>
      <minor>4</minor><micro>9</micro></min-revision></dependency></dependencies>
    <archives>${archive(`${abi}-36_r07.zip`, 1800, sha1(letter))}</archives>
  </remotePackage>`;
const imagesXml = `<sys-img:sdk-sys-img>${image("arm64-v8a", "android-sdk-arm-dbt-license", "f")}
  ${image("x86_64", "android-sdk-license", "0")}</sys-img:sdk-sys-img>`;

test("the index parser finds the pinned archive of a host", () => {
  const index = parseIndex(toolsXml);
  assert.deepEqual(
    index.packages.map((entry) => `${entry.path}@${entry.revision}`),
    ["emulator@37.4.2", "emulator@37.3.10", "platform-tools@37.0.3"],
  );
  assert.deepEqual(
    pick(index, { path: "emulator", revision: "37.3.10", os: "macosx", arch: "aarch64" }),
    {
      url: "emulator-darwin_aarch64-16970787.zip",
      size: 420,
      sha1: sha1("c"),
      licence: "android-sdk-license",
    },
  );
  // An archive without a host architecture serves every architecture of its system.
  assert.equal(
    pick(index, { path: "platform-tools", revision: "37.0.3", os: "linux", arch: "x64" })
      .url,
    "platform-tools_r37.0.3-linux.zip",
  );
  // The dependency's revision inside an image package is not the package's own.
  const images = parseIndex(imagesXml);
  assert.equal(
    pick(images, {
      path: "system-images;android-36;google_apis;x86_64",
      revision: 7,
      os: "linux",
      arch: "x64",
    }).url,
    "x86_64-36_r07.zip",
  );
});

test("a revision or a host the index does not list is refused", () => {
  const index = parseIndex(toolsXml);
  assert.throws(
    () =>
      pick(index, { path: "emulator", revision: "37.3.11", os: "linux", arch: "x64" }),
    /does not list emulator at revision 37\.3\.11/,
  );
  assert.throws(
    () => pick(index, { path: "ndk", revision: "1", os: "linux", arch: "x64" }),
    /does not list ndk/,
  );
  assert.throws(
    () =>
      pick(index, {
        path: "emulator",
        revision: "37.3.10",
        os: "linux",
        arch: "aarch64",
      }),
    /0 archives for linux aarch64/,
  );
});

test("the pin resolves to three archives per platform with their download folders", () => {
  const wanted = pinnedArchives({
    tools: parseIndex(toolsXml),
    images: parseIndex(imagesXml),
  });
  assert.deepEqual(
    wanted.map(({ component, key, base, url }) => [component, key, base + url]),
    [
      [
        "emulator",
        "darwin-arm64",
        "https://dl.google.com/android/repository/emulator-darwin_aarch64-16970787.zip",
      ],
      [
        "platformTools",
        "darwin-arm64",
        "https://dl.google.com/android/repository/platform-tools_r37.0.3-darwin.zip",
      ],
      [
        "image",
        "darwin-arm64",
        "https://dl.google.com/android/repository/sys-img/google_apis/arm64-v8a-36_r07.zip",
      ],
      [
        "emulator",
        "linux-x64",
        "https://dl.google.com/android/repository/emulator-linux_x64-16970787.zip",
      ],
      [
        "platformTools",
        "linux-x64",
        "https://dl.google.com/android/repository/platform-tools_r37.0.3-linux.zip",
      ],
      [
        "image",
        "linux-x64",
        "https://dl.google.com/android/repository/sys-img/google_apis/x86_64-36_r07.zip",
      ],
    ],
  );
  assert.equal(wanted[2].abi, "arm64-v8a");
  assert.equal(wanted[2].licence, "android-sdk-arm-dbt-license");
});

const zipOf = (entries) =>
  new Promise((resolve) => {
    const zip = new yazl.ZipFile();
    for (const [name, content] of entries)
      if (name.endsWith("/")) zip.addEmptyDirectory(name);
      else zip.addBuffer(Buffer.from(content), name);
    const chunks = [];
    zip.outputStream.on("data", (chunk) => chunks.push(chunk));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.end();
  });
const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest("hex");

test("an archive's entry carries its SHA-256, top folder, files and expanded size", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "android-manifest-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bytes = await zipOf([
    ["emulator/", ""],
    ["emulator/emulator", "x".repeat(1000)],
    ["emulator/lib64/libfake.so", "y".repeat(500)],
  ]);
  const file = path.join(directory, "emulator.zip");
  fs.writeFileSync(file, bytes);
  const pinned = {
    url: "https://dl.google.com/android/repository/emulator.zip",
    size: bytes.length,
    sha1: digest("sha1", bytes),
  };
  assert.deepEqual(await manifestEntry(file, pinned), {
    url: pinned.url,
    sha256: digest("sha256", bytes),
    size: bytes.length,
    top: "emulator",
    files: 2,
    expandedBytes: 1500,
  });
  // Google's index is the only statement about the archive: another SHA-1 is refused.
  await assert.rejects(
    manifestEntry(file, { ...pinned, sha1: sha1("0") }),
    /the index names .* Nothing is printed/,
  );
  await assert.rejects(manifestEntry(file, { ...pinned, size: bytes.length + 1 }));
});

test("the refresh takes archives from a local folder and downloads the others", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "android-manifest-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const archives = {
    "emulator-linux_x64-16970787.zip": await zipOf([["emulator/emulator", "e"]]),
    "platform-tools_r37.0.3-linux.zip": await zipOf([["platform-tools/adb", "adb"]]),
    "x86_64-36_r07.zip": await zipOf([["x86_64/system.img", "image"]]),
  };
  const entry = (name, host = "") => {
    const bytes = archives[name];
    return archive(name, bytes.length, digest("sha1", bytes), host);
  };
  const linux = "<host-os>linux</host-os>";
  fs.writeFileSync(
    path.join(directory, "repository2-3.xml"),
    `<r><remotePackage path="emulator"><revision><major>37</major><minor>3</minor>
      <micro>10</micro></revision><uses-license ref="android-sdk-license"/><archives>
      ${entry("emulator-linux_x64-16970787.zip", `${linux}<host-arch>x64</host-arch>`)}
      </archives></remotePackage><remotePackage path="platform-tools"><revision>
      <major>37</major><minor>0</minor><micro>3</micro></revision>
      <uses-license ref="android-sdk-license"/><archives>
      ${entry("platform-tools_r37.0.3-linux.zip", linux)}</archives></remotePackage></r>`,
  );
  fs.writeFileSync(
    path.join(directory, "sys-img2-3.xml"),
    `<r><remotePackage path="system-images;android-36;google_apis;x86_64"><revision>
      <major>7</major></revision><uses-license ref="android-sdk-license"/><archives>
      ${entry("x86_64-36_r07.zip")}</archives></remotePackage></r>`,
  );
  const local = path.join(directory, "zips");
  fs.mkdirSync(local);
  fs.writeFileSync(path.join(local, "x86_64-36_r07.zip"), archives["x86_64-36_r07.zip"]);
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    return new Response(archives[path.basename(url)], { status: 200 });
  };
  const result = await refreshAndroidManifest({
    archives: local,
    index: directory,
    keys: ["linux-x64"],
    fetchImpl,
  });
  assert.deepEqual(requests, [
    "https://dl.google.com/android/repository/emulator-linux_x64-16970787.zip",
    "https://dl.google.com/android/repository/platform-tools_r37.0.3-linux.zip",
  ]);
  assert.deepEqual(result.image["linux-x64"], {
    url: "https://dl.google.com/android/repository/sys-img/google_apis/x86_64-36_r07.zip",
    sha256: digest("sha256", archives["x86_64-36_r07.zip"]),
    size: archives["x86_64-36_r07.zip"].length,
    top: "x86_64",
    files: 1,
    expandedBytes: 5,
    abi: "x86_64",
  });
  assert.equal(result.emulator["linux-x64"].top, "emulator");
  assert.equal(result.platformTools["linux-x64"].files, 1);
  assert.deepEqual(result.licences, ["android-sdk-license"]);
  // The local archive stays; nothing else is left in its folder.
  assert.deepEqual(fs.readdirSync(local), ["x86_64-36_r07.zip"]);
});
