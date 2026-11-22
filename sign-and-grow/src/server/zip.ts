import zlib from 'node:zlib';

// A small streaming ZIP writer (stored, not compressed: PDFs are already compressed). Used for "download everything".
// Classic ZIP limits apply: about 65,000 files and 4 GB in total. The caller stops before either.

export type ZipEntry = { name: string; data: Uint8Array };
export const ZIP_MAX_FILES = 60000;
export const ZIP_MAX_BYTES = 3_800_000_000;

const enc = new TextEncoder();

function dosTime(d: Date) {
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((Math.max(1980, d.getUTCFullYear()) - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

export const safeName = (s: string) => (s || 'untitled').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'untitled';

// `entries` may also be an async generator, for a ZIP whose parts take time to make (the full export, exportfull.ts).
export function zipStream(entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>): ReadableStream<Uint8Array> {
  const it: Iterator<ZipEntry> | AsyncIterator<ZipEntry> = Symbol.asyncIterator in entries ? (entries as AsyncIterable<ZipEntry>)[Symbol.asyncIterator]() : (entries as Iterable<ZipEntry>)[Symbol.iterator]();
  const central: Uint8Array[] = [];
  const used = new Set<string>();
  let offset = 0;
  let count = 0;
  const { time, date } = dosTime(new Date());

  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const next = await it.next();
      if (!next.done) {
        let name = next.value.name;
        for (let n = 2; used.has(name.toLowerCase()); n++) name = next.value.name.replace(/(\.[^./]+)?$/, ` (${n})$1`);
        used.add(name.toLowerCase());
        const data = next.value.data;
        const nameBytes = enc.encode(name);
        const crc = zlib.crc32(data) >>> 0;

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6); // file names are UTF-8
        local.writeUInt16LE(0, 8);
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        local.writeUInt16LE(0, 28);

        const dir = Buffer.alloc(46);
        dir.writeUInt32LE(0x02014b50, 0);
        dir.writeUInt16LE(20, 4);
        dir.writeUInt16LE(20, 6);
        dir.writeUInt16LE(0x0800, 8);
        dir.writeUInt16LE(0, 10);
        dir.writeUInt16LE(time, 12);
        dir.writeUInt16LE(date, 14);
        dir.writeUInt32LE(crc, 16);
        dir.writeUInt32LE(data.length, 20);
        dir.writeUInt32LE(data.length, 24);
        dir.writeUInt16LE(nameBytes.length, 28);
        dir.writeUInt32LE(offset, 42);
        central.push(dir, nameBytes);

        offset += 30 + nameBytes.length + data.length;
        count++;
        ctrl.enqueue(local);
        ctrl.enqueue(nameBytes);
        ctrl.enqueue(data);
        return;
      }
      const size = central.reduce((n, b) => n + b.length, 0);
      for (const b of central) ctrl.enqueue(b);
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(count, 8);
      end.writeUInt16LE(count, 10);
      end.writeUInt32LE(size, 12);
      end.writeUInt32LE(offset, 16);
      ctrl.enqueue(end);
      ctrl.close();
    },
  });
}

// ---- Reading a ZIP ------------------------------------------------------------------------------------------------
// For bringing a full export or a folder of DocuSign downloads in (importer.ts). Stored and deflated entries, no
// ZIP64, no encryption. Every entry is unpacked with a limit, so a file that claims small sizes and unpacks to far
// more is stopped, and `damaged` is thrown (words for a person) whenever the file cannot be read as a ZIP.
// (convert.ts keeps its own reader for office files, with its own words and its own limits.)

export type ZipFile = { name: string; data: Buffer };

const r16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const r32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;

export const looksLikeZip = (b: Uint8Array) => b.length >= 22 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4;

export function readZip(b: Uint8Array, o: { damaged: () => Error; maxUnpacked: number; maxFiles?: number }): ZipFile[] {
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--) if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 5 && b[i + 3] === 6) { end = i; break; }
  if (end < 0) throw o.damaged();
  const count = r16(b, end + 10), size = r32(b, end + 12), at = r32(b, end + 16);
  if (count === 0xffff || size === 0xffffffff || at === 0xffffffff || count > (o.maxFiles ?? ZIP_MAX_FILES) || at + size > end) throw o.damaged();
  const out: ZipFile[] = [];
  let p = at, total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > b.length || r32(b, p) !== 0x02014b50) throw o.damaged();
    const n = r16(b, p + 28), x = r16(b, p + 30), k = r16(b, p + 32);
    const flags = r16(b, p + 8), method = r16(b, p + 10), csize = r32(b, p + 20), usize = r32(b, p + 24), offset = r32(b, p + 42);
    const raw = b.subarray(p + 46, p + 46 + n);
    const name = flags & 0x800 ? Buffer.from(raw).toString('utf8') : Buffer.from(raw).toString('latin1');
    p += 46 + n + x + k;
    if (flags & 1 || (method !== 0 && method !== 8)) throw o.damaged();
    if (offset + 30 > b.length || r32(b, offset) !== 0x04034b50) throw o.damaged();
    const start = offset + 30 + r16(b, offset + 26) + r16(b, offset + 28);
    if (start + csize > b.length) throw o.damaged();
    const packed = b.subarray(start, start + csize);
    if (name.endsWith('/')) continue;
    let data: Buffer;
    try {
      data = method === 0 ? Buffer.from(packed) : zlib.inflateRawSync(packed, { maxOutputLength: Math.max(1, o.maxUnpacked - total) });
    } catch {
      throw o.damaged();
    }
    if (method === 0 && data.length !== usize) throw o.damaged();
    total += data.length;
    if (total > o.maxUnpacked) throw o.damaged();
    // A CRC that does not match is a damaged entry, not one to bring in.
    if ((zlib.crc32(data) >>> 0) !== r32(b, p - 46 - n - x - k + 16)) throw o.damaged();
    out.push({ name, data });
  }
  return out;
}
