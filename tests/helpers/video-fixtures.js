// Hand-built video containers for the sniffing and metadata tests: the boxes and
// elements a phone or a browser writes, around a payload that is no real codec data.

/** An ISO BMFF box: 32-bit size, four-letter type, body. */
export function box(type, ...parts) {
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, body]);
}

// version + flags
const full = (version) => Buffer.from([version, 0, 0, 0]);
const u32 = (value) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value >>> 0);
  return b;
};
const u64 = (value) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(value));
  return b;
};
const s32 = (value) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(value);
  return b;
};

function mvhd(version, timescale, duration) {
  const times =
    version === 1
      ? [u64(0), u64(0), u32(timescale), u64(duration)]
      : [u32(0), u32(0), u32(timescale), u32(duration)];
  return box("mvhd", full(version), ...times, Buffer.alloc(80));
}

// The display matrix: identity, or rotated by 90° as an iPhone records portrait.
function matrix(rotate) {
  const [a, b, c, d] = rotate ? [0, 0x10000, -0x10000, 0] : [0x10000, 0, 0, 0x10000];
  return Buffer.concat([
    s32(a),
    s32(b),
    s32(0),
    s32(c),
    s32(d),
    s32(0),
    s32(0),
    s32(0),
    s32(0x40000000),
  ]);
}

function tkhd(version, width, height, rotate) {
  const times =
    version === 1
      ? [u64(0), u64(0), u32(1), u32(0), u64(0)]
      : [u32(0), u32(0), u32(1), u32(0), u32(0)];
  return box(
    "tkhd",
    full(version),
    ...times,
    Buffer.alloc(16),
    matrix(rotate),
    u32(width * 0x10000),
    u32(height * 0x10000),
  );
}

const hdlr = (handler) =>
  box("hdlr", full(0), u32(0), Buffer.from(handler, "latin1"), Buffer.alloc(13));

function trak(handler, width, height, version, rotate) {
  return box(
    "trak",
    tkhd(version, width, height, rotate),
    box("mdia", box("mdhd", full(0), Buffer.alloc(20)), hdlr(handler)),
  );
}

/**
 * An MP4 or QuickTime file. `brand` is the major brand ("qt  " for an iPhone MOV,
 * "isom" or "mp42" for MP4), `compatible` the listed brands. The movie box sits
 * before or after the media data (`moovFirst`), as fast-start files and phone
 * recordings differ. An audio track comes first so the video track must be found.
 */
export function mp4File({
  brand = "isom",
  compatible = ["isom", "iso2", "avc1", "mp41"],
  timescale = 600,
  duration = 600 * 42,
  width = 1920,
  height = 1080,
  version = 0,
  rotate = false,
  moovFirst = false,
  payload = 64,
} = {}) {
  const ftyp = box(
    "ftyp",
    Buffer.from(brand, "latin1"),
    u32(0),
    ...compatible.map((name) => Buffer.from(name, "latin1")),
  );
  const moov = box(
    "moov",
    mvhd(version, timescale, duration),
    trak("soun", 0, 0, version, false),
    trak("vide", width, height, version, rotate),
  );
  const mdat = box("mdat", Buffer.alloc(payload, 7));
  const wide = box("wide");
  return Buffer.concat(moovFirst ? [ftyp, moov, mdat] : [ftyp, wide, mdat, moov]);
}

// EBML: an element id (with its marker bits) and a size as an 8-byte vint.
function element(id, body) {
  const size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(body.length) | (1n << 56n));
  return Buffer.concat([Buffer.from(id), size, body]);
}
const uint = (value) => u32(value);
const float = (value) => {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(value);
  return b;
};

/** A WebM file: EBML header, then a segment with info, tracks and one cluster. */
export function webmFile({
  docType = "webm",
  duration = 2500,
  timecodeScale = 1_000_000,
  width = 640,
  height = 360,
  unknownSegmentSize = false,
} = {}) {
  const header = element(
    [0x1a, 0x45, 0xdf, 0xa3],
    Buffer.concat([
      element([0x42, 0x86], Buffer.from([1])),
      element([0x42, 0x82], Buffer.from(docType)),
    ]),
  );
  const info = element(
    [0x15, 0x49, 0xa9, 0x66],
    Buffer.concat([
      element([0x2a, 0xd7, 0xb1], uint(timecodeScale)),
      ...(duration == null ? [] : [element([0x44, 0x89], float(duration))]),
    ]),
  );
  const tracks = element(
    [0x16, 0x54, 0xae, 0x6b],
    Buffer.concat([
      element(
        [0xae],
        Buffer.concat([element([0x83], Buffer.from([2]))]), // audio
      ),
      element(
        [0xae],
        Buffer.concat([
          element([0x83], Buffer.from([1])),
          element(
            [0xe0],
            Buffer.concat([element([0xb0], uint(width)), element([0xba], uint(height))]),
          ),
        ]),
      ),
    ]),
  );
  const cluster = element([0x1f, 0x43, 0xb6, 0x75], Buffer.alloc(32, 9));
  const content = Buffer.concat([info, tracks, cluster]);
  const segment = unknownSegmentSize
    ? Buffer.concat([
        Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
        Buffer.from([0xff]),
        content,
      ])
    : element([0x18, 0x53, 0x80, 0x67], content);
  return Buffer.concat([header, segment]);
}
