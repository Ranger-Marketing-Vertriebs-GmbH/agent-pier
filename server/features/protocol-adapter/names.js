const HASH_LENGTH = 8;
const encoder = new TextEncoder();

/** Stable FNV-1a (32 bit) over the UTF-8 bytes, as 8 lowercase hex digits. */
export function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (const byte of encoder.encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(HASH_LENGTH, "0");
}

const testPattern = (pattern, value) => {
  pattern.lastIndex = 0;
  return pattern.test(value);
};

/**
 * Allocates upstream strings for arbitrary keys. The mapping is injective for the lifetime of
 * the instance: a candidate that is already taken by another key gets a counter suffix.
 */
function createAllocator({ pattern, maxLength }) {
  const forward = new Map();
  const backward = new Map();
  const fits = (value) => value.length <= maxLength && testPattern(pattern, value);

  const leadingSlice = (text, limit) => {
    let slice = "";
    for (const char of text) {
      if (slice.length + char.length > limit || !testPattern(pattern, char)) break;
      slice += char;
    }
    return slice;
  };

  const allocate = (key, full, hashedPrefix) => {
    const known = forward.get(key);
    if (known !== undefined) return known;
    const hash = fnv1a(full);
    const base = fits(full)
      ? full
      : `${hashedPrefix(maxLength - hash.length - 1)}_${hash}`;
    let candidate = base;
    for (let counter = 2; backward.has(candidate); counter += 1) {
      const suffix = `_${counter}`;
      candidate = `${base.slice(0, Math.max(0, maxLength - suffix.length))}${suffix}`;
    }
    forward.set(key, candidate);
    backward.set(candidate, key);
    return candidate;
  };

  return { allocate, backward, leadingSlice };
}

/**
 * Per-session bijective map between client tool names (optionally namespaced) and the names an
 * upstream accepts. Valid names pass through, others become `<prefix>_<fnv1a hash>`.
 */
export function createNameMap({ pattern, maxLength }) {
  const allocator = createAllocator({ pattern, maxLength });
  return {
    toUpstream(name, rawNamespace) {
      const namespace = rawNamespace || null; // "" and undefined both mean no namespace
      const full = namespace ? `${namespace}__${name}` : name;
      const key = JSON.stringify([namespace, name]);
      return allocator.allocate(key, full, (limit) =>
        allocator.leadingSlice(full, limit),
      );
    },
    fromUpstream(name) {
      const key = allocator.backward.get(name);
      if (key === undefined) return { name };
      const [namespace, original] = JSON.parse(key);
      return namespace === null ? { name: original } : { name: original, namespace };
    },
  };
}

/** Per-session bijective map for ids that must match a pattern; invalid ids become `id_<hash>`. */
export function createIdMap(pattern) {
  const allocator = createAllocator({ pattern, maxLength: Infinity });
  return {
    toUpstream(id) {
      return allocator.allocate(JSON.stringify(id), id, () => "id");
    },
    fromUpstream(id) {
      const key = allocator.backward.get(id);
      return key === undefined ? id : JSON.parse(key);
    },
  };
}
