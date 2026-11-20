/*
 * Fathom — minimal, dependency-free ZIP writer.
 *
 * The exporter hands a set of generated files (index.html, styles.css,
 * snapshot.json, downloaded asset binaries) to the user as one download.
 * Chrome ships no ZIP API, and a compression library would mean a build step,
 * so the archive is written by hand:
 *
 *   [local header + payload] * N  ->  [central directory]  ->  [EOCD]
 *
 * Method 0 (STORE, no compression) keeps the writer small and guarantees that
 * binary payloads (PNG bytes, font files) round-trip byte for byte. CRC-32,
 * the central-directory offsets and the UTF-8 filename flag (general-purpose
 * bit 11) are the only details a reader actually insists on.
 *
 * Usage:
 *   Fathom.zip([
 *     { name: "index.html", data: "<!doctype html>…" },
 *     { name: "assets/logo.png", data: pngBytes },
 *   ]) -> Blob (type "application/zip")
 *
 * Classic script: exposes globalThis.Fathom.zip. When lib/export.js has already
 * installed Fathom.exportLib, the same function is attached there too, so the
 * two files can be injected in either order.
 *
 * Nothing here touches the DOM or runs at evaluation time.
 */
(() => {
  const F = (globalThis.Fathom = globalThis.Fathom || {});

  const SIG_LOCAL = 0x04034b50;
  const SIG_CENTRAL = 0x02014b50;
  const SIG_EOCD = 0x06054b50;
  const VERSION = 20; // 2.0 — understands STORE + the UTF-8 flag
  const FLAG_UTF8 = 0x0800; // general-purpose bit 11
  const METHOD_STORE = 0;
  const MAX_U32 = 0xffffffff;

  /* ------------------------------------------------------------- CRC-32 --- */

  let CRC_TABLE = null;

  /** Lazily built (and then cached) CRC-32 lookup table — IEEE polynomial. */
  function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    CRC_TABLE = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let bit = 0; bit < 8; bit += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      CRC_TABLE[i] = c >>> 0;
    }
    return CRC_TABLE;
  }

  /** Standard CRC-32 over a byte array; returns an unsigned 32-bit integer. */
  function crc32(bytes) {
    const table = crcTable();
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) {
      crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  /* --------------------------------------------------------- primitives --- */

  function utf8(text) {
    return new TextEncoder().encode(String(text));
  }

  /** Coerce one payload to bytes. Strings are UTF-8; binary data is untouched. */
  function toBytes(data, name) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    if (typeof data === "string") return utf8(data);
    if (data === null || data === undefined) return new Uint8Array(0);
    throw new TypeError(`Fathom.zip: "${name}" must be a string or a Uint8Array.`);
  }

  /**
   * ZIP entry names are archive paths, never filesystem paths. Normalise
   * separators so a Windows-style name still unzips on macOS, reject `.`/`..`
   * segments (path traversal in a downloaded archive is a real hazard) and keep
   * the length sane.
   */
  function safeName(name, index) {
    const segments = String(name === null || name === undefined ? "" : name)
      .replace(/\\/g, "/")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .split("/")
      .filter((part) => part && part !== "." && part !== "..");
    let out = segments.join("/").replace(/^\/+|\/+$/g, "");
    // Slice by code point so a long UTF-8 name never ends on a lone surrogate.
    if (out.length > 180) out = Array.from(out).slice(-180).join("").replace(/^\/+/, "");
    if (!out) out = `file-${index + 1}.txt`;
    return out;
  }

  /** MS-DOS time/date pair (2-second resolution, 1980 epoch). */
  function dosStamp(date) {
    const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
    const year = Math.min(2107, Math.max(1980, d.getFullYear()));
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const day = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, date: day };
  }

  /* ------------------------------------------------------------------ zip --- */

  /**
   * Build an uncompressed ZIP archive.
   * @param {Array<{name: string, data: string|Uint8Array}>} files
   * @returns {Blob} "application/zip"
   */
  function zip(files) {
    if (!Array.isArray(files)) {
      throw new TypeError("Fathom.zip(files) expects an array of { name, data }.");
    }

    const stamp = dosStamp(new Date());
    const entries = files.map((file, index) => {
      const source = file && typeof file === "object" ? file : {};
      const name = safeName(source.name, index);
      const nameBytes = utf8(name);
      const data = toBytes(source.data, name);
      if (data.length > MAX_U32) {
        throw new Error(`Fathom.zip: "${name}" is larger than 4 GB.`);
      }
      return { nameBytes, data, crc: crc32(data), offset: 0 };
    });

    // Sizes are known up front (STORE), so one flat buffer can be written with
    // no post-processing and no data descriptors.
    let localSize = 0;
    let centralSize = 0;
    for (const entry of entries) {
      localSize += 30 + entry.nameBytes.length + entry.data.length;
      centralSize += 46 + entry.nameBytes.length;
    }
    const total = localSize + centralSize + 22;
    if (total > MAX_U32) {
      throw new Error("Fathom.zip: archive is larger than 4 GB.");
    }

    const bytes = new Uint8Array(total);
    const view = new DataView(bytes.buffer);
    let cursor = 0;

    const u16 = (value) => {
      view.setUint16(cursor, value & 0xffff, true);
      cursor += 2;
    };
    const u32 = (value) => {
      view.setUint32(cursor, value >>> 0, true);
      cursor += 4;
    };
    const raw = (chunk) => {
      bytes.set(chunk, cursor);
      cursor += chunk.length;
    };

    for (const entry of entries) {
      entry.offset = cursor;
      u32(SIG_LOCAL); // local file header signature
      u16(VERSION); // version needed to extract
      u16(FLAG_UTF8); // general purpose flags
      u16(METHOD_STORE); // compression method
      u16(stamp.time); // last mod time
      u16(stamp.date); // last mod date
      u32(entry.crc); // CRC-32 of the payload
      u32(entry.data.length); // compressed size == stored size
      u32(entry.data.length); // uncompressed size
      u16(entry.nameBytes.length); // file name length
      u16(0); // extra field length
      raw(entry.nameBytes);
      raw(entry.data);
    }

    const centralStart = cursor;
    for (const entry of entries) {
      u32(SIG_CENTRAL); // central directory header signature
      u16(VERSION); // version made by (MS-DOS host, 2.0)
      u16(VERSION); // version needed to extract
      u16(FLAG_UTF8);
      u16(METHOD_STORE);
      u16(stamp.time);
      u16(stamp.date);
      u32(entry.crc);
      u32(entry.data.length);
      u32(entry.data.length);
      u16(entry.nameBytes.length);
      u16(0); // extra field length
      u16(0); // file comment length
      u16(0); // disk number start
      u16(0); // internal file attributes
      u32(0); // external file attributes
      u32(entry.offset); // offset of the local header
      raw(entry.nameBytes);
    }
    const centralEnd = cursor;

    u32(SIG_EOCD); // end of central directory signature
    u16(0); // number of this disk
    u16(0); // disk with the central directory
    u16(entries.length); // entries on this disk
    u16(entries.length); // total entries
    u32(centralEnd - centralStart); // size of the central directory
    u32(centralStart); // offset of the central directory
    u16(0); // archive comment length

    return new Blob([bytes], { type: "application/zip" });
  }

  F.zip = zip;

  // lib/export.js may have loaded first and installed its own Promise-returning
  // delegator (the documented `exportLib.zip(files): Promise<Blob>`). Never
  // clobber it: only fill the gap when exportLib exists without a zip.
  if (F.exportLib && typeof F.exportLib === "object" && typeof F.exportLib.zip !== "function") {
    F.exportLib.zip = zip;
  }
})();
