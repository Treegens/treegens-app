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

export function zipStream(entries: Iterable<ZipEntry>): ReadableStream<Uint8Array> {
  const it = entries[Symbol.iterator]();
  const central: Uint8Array[] = [];
  const used = new Set<string>();
  let offset = 0;
  let count = 0;
  const { time, date } = dosTime(new Date());

  return new ReadableStream<Uint8Array>({
    pull(ctrl) {
      const next = it.next();
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
