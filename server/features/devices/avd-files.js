import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { privateDirectory, writePrivateText } from "../../lib/storage.js";

/*
 * The files of one Android virtual device, written by AgentPier itself (there is no
 * avdmanager, because there is no Java): `<avd>/<id>.ini`, which names the folder,
 * and `<avd>/<id>.avd/config.ini`. The emulator creates everything else in the
 * folder on the first boot and never rewrites `config.ini`.
 *
 * The 24 keys are the set that makes the emulator resolve the same hardware as an
 * AVD made by avdmanager, apart from the screen, the absent SD card and the absent
 * device profile (proved on macOS arm64 and Linux x64 with emulator 37.3.10).
 */
const deviceId = /^d-[a-f0-9]{12}$/;
const imageId = /^android-(\d+)-([a-z0-9_]+)-r\d+$/;
const architectures = { "arm64-v8a": "arm64", x86_64: "x86_64" };
const tagNames = { google_apis: "Google APIs" };

/** The image of a recovered device whose files name none (device-store.js). */
export const unknownImage = "unknown";

/** Whether `id` is a device id (`d-` and twelve hex digits): the only AVD names used. */
export const isDeviceId = (id) => typeof id === "string" && deviceId.test(id);

function checked(id) {
  if (!isDeviceId(id)) throw TypeError("Not a device id.");
  return id;
}

const files = (paths, id) => ({
  ini: path.join(paths.avd, `${checked(id)}.ini`),
  folder: path.join(paths.avd, `${id}.avd`),
});

/**
 * The key/value pairs of `config.ini` for device `id` on image `image` (an id like
 * `android-36-google_apis-r7`) for `abi`, with the manifest's `shape`.
 */
export function avdConfig({ id, image, abi, shape }) {
  checked(id);
  const [, api, tag] = imageId.exec(image || "") || [];
  const arch = architectures[abi];
  if (!api || !arch) throw TypeError("Unknown system image or ABI.");
  return {
    "avd.ini.encoding": "UTF-8",
    "abi.type": abi,
    "hw.cpu.arch": arch,
    "hw.cpu.ncore": String(shape.cores),
    "hw.ramSize": String(shape.memoryMb),
    "hw.lcd.width": String(shape.width),
    "hw.lcd.height": String(shape.height),
    "hw.lcd.density": String(shape.density),
    "hw.gpu.enabled": "yes",
    "hw.gpu.mode": "swiftshader_indirect",
    "hw.keyboard": "no",
    "hw.keyboard.lid": "yes",
    "hw.dPad": "no",
    "hw.mainKeys": "no",
    "hw.trackBall": "no",
    "hw.sdCard": "no",
    // Relative to the SDK, as avdmanager writes it.
    "image.sysdir.1": `system-images/${image}/${abi}/`,
    "tag.id": tag,
    "tag.display": tagNames[tag] ?? tag,
    target: `android-${api}`,
    "PlayStore.enabled": "no",
    "disk.dataPartition.size": shape.dataPartition,
    "fastboot.forceFastBoot": "yes",
    "vm.heapSize": "228M",
  };
}

const ini = (pairs) =>
  Object.entries(pairs)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");

/** Writes both files of device `id`, for the owner only; nothing boots. */
export function writeAvd(paths, { id, image, abi, shape }) {
  const config = avdConfig({ id, image, abi, shape });
  const { ini: iniFile, folder } = files(paths, id);
  privateDirectory(paths.avd);
  privateDirectory(folder);
  writePrivateText(path.join(folder, "config.ini"), ini(config));
  writePrivateText(
    iniFile,
    ini({ "avd.ini.encoding": "UTF-8", path: folder, target: config.target }),
  );
}

/** Removes both files of device `id`. Throws for anything that is not a device id. */
export function removeAvd(paths, id) {
  const { ini: iniFile, folder } = files(paths, id);
  fs.rmSync(folder, { recursive: true, force: true });
  fs.rmSync(iniFile, { force: true });
}

/** Whether the files of device `id` exist. */
export function hasAvd(paths, id) {
  const { ini: iniFile, folder } = files(paths, id);
  return fs.existsSync(iniFile) && fs.existsSync(path.join(folder, "config.ini"));
}

/** The ids of the device folders that exist (`<id>.avd`), in order. */
export function listAvds(paths) {
  try {
    return fs
      .readdirSync(paths.avd)
      .filter((name) => name.endsWith(".avd") && isDeviceId(name.slice(0, -4)))
      .map((name) => name.slice(0, -4))
      .sort();
  } catch {
    return [];
  }
}

/** The system image the files of device `id` name, or null when they name none. */
export function avdImage(paths, id) {
  try {
    const config = fs.readFileSync(
      path.join(files(paths, id).folder, "config.ini"),
      "utf8",
    );
    const [, image] = /^image\.sysdir\.1=system-images\/([^/\s]+)\//m.exec(config) || [];
    return imageId.test(image || "") ? image : null;
  } catch {
    return null;
  }
}

/** Whether device `id` has a saved quick-boot snapshot. */
export function hasSnapshot(paths, id) {
  const { folder } = files(paths, id);
  try {
    return fs.readdirSync(path.join(folder, "snapshots", "default_boot")).length > 0;
  } catch {
    return false;
  }
}

/**
 * The bytes device `id` takes on disk, as `du` counts them: the image of the data
 * partition is sparse, so the file sizes would say 6 GB for a new device.
 */
export async function avdBytes(paths, id) {
  const { ini: iniFile, folder } = files(paths, id);
  let bytes = 0;
  const visit = async (target) => {
    let stat;
    try {
      stat = await fsp.lstat(target);
    } catch {
      return;
    }
    bytes += stat.blocks * 512;
    if (!stat.isDirectory()) return;
    let names = [];
    try {
      names = await fsp.readdir(target);
    } catch {
      // Removed meanwhile.
    }
    for (const name of names) await visit(path.join(target, name));
  };
  await visit(iniFile);
  await visit(folder);
  return bytes;
}
