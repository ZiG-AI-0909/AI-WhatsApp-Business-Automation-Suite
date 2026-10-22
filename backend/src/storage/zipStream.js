'use strict';

// Minimal streaming ZIP writer (no dependency). Files are STORED, not
// compressed: the documents kept here (PDF, JPG, PNG, XLSX) are already
// compressed, and storing lets us know the exact ZIP size before sending
// it, so the browser can show progress and confirm it received every byte.
//
// Limits: fewer than 65,535 entries and under 4 GB in total (no ZIP64);
// callers cap archives well below that.

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

/** Incremental CRC-32: crc32(buf) or crc32(buf, previous). */
function crc32(buffer, previous = 0) {
    let crc = (previous ^ 0xffffffff) >>> 0;
    for (let index = 0; index < buffer.length; index++) crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const END_RECORD = 22;
const UTF8_FLAG = 0x0800;

/** Exact size of a ZIP holding these entries: [{ name, size }]. */
function zipLength(entries) {
    let total = END_RECORD;
    for (const entry of entries) {
        const nameBytes = Buffer.byteLength(entry.name, 'utf8');
        total += LOCAL_HEADER + nameBytes + entry.size + CENTRAL_HEADER + nameBytes;
    }
    return total;
}

function dosDateTime(value) {
    const date = value ? new Date(value) : new Date();
    const valid = Number.isNaN(date.getTime()) ? new Date() : date;
    const year = Math.max(1980, valid.getFullYear());
    return {
        time: (valid.getHours() << 11) | (valid.getMinutes() << 5) | Math.floor(valid.getSeconds() / 2),
        date: ((year - 1980) << 9) | ((valid.getMonth() + 1) << 5) | valid.getDate(),
    };
}

/**
 * new ZipWriter(write) — `write(buffer)` must return a promise that
 * resolves when the chunk is accepted (back-pressure). Tracks the byte
 * count and a CRC-32 of the whole ZIP as written.
 */
class ZipWriter {
    constructor(write) {
        this.write = write;
        this.offset = 0;
        this.crc = 0;
        this.central = [];
    }

    async emit(buffer) {
        this.crc = crc32(buffer, this.crc);
        this.offset += buffer.length;
        await this.write(buffer);
    }

    async addFile(name, data, modified) {
        const nameBuffer = Buffer.from(name, 'utf8');
        const fileCrc = crc32(data);
        const { time, date } = dosDateTime(modified);
        const header = Buffer.alloc(LOCAL_HEADER);
        header.writeUInt32LE(0x04034b50, 0);
        header.writeUInt16LE(20, 4);
        header.writeUInt16LE(UTF8_FLAG, 6);
        header.writeUInt16LE(0, 8); // stored
        header.writeUInt16LE(time, 10);
        header.writeUInt16LE(date, 12);
        header.writeUInt32LE(fileCrc, 14);
        header.writeUInt32LE(data.length, 18);
        header.writeUInt32LE(data.length, 22);
        header.writeUInt16LE(nameBuffer.length, 26);
        header.writeUInt16LE(0, 28);
        const localOffset = this.offset;
        await this.emit(header);
        await this.emit(nameBuffer);
        if (data.length) await this.emit(data);
        this.central.push({ nameBuffer, fileCrc, size: data.length, time, date, localOffset });
    }

    async finish() {
        const start = this.offset;
        for (const entry of this.central) {
            const header = Buffer.alloc(CENTRAL_HEADER);
            header.writeUInt32LE(0x02014b50, 0);
            header.writeUInt16LE(20, 4);
            header.writeUInt16LE(20, 6);
            header.writeUInt16LE(UTF8_FLAG, 8);
            header.writeUInt16LE(0, 10);
            header.writeUInt16LE(entry.time, 12);
            header.writeUInt16LE(entry.date, 14);
            header.writeUInt32LE(entry.fileCrc, 16);
            header.writeUInt32LE(entry.size, 20);
            header.writeUInt32LE(entry.size, 24);
            header.writeUInt16LE(entry.nameBuffer.length, 28);
            header.writeUInt32LE(entry.localOffset, 42);
            await this.emit(header);
            await this.emit(entry.nameBuffer);
        }
        const end = Buffer.alloc(END_RECORD);
        end.writeUInt32LE(0x06054b50, 0);
        end.writeUInt16LE(this.central.length, 8);
        end.writeUInt16LE(this.central.length, 10);
        end.writeUInt32LE(this.offset - start, 12);
        end.writeUInt32LE(start, 16);
        await this.emit(end);
        return { bytes: this.offset, crc32: this.crc.toString(16).padStart(8, '0') };
    }
}

module.exports = { crc32, zipLength, ZipWriter };
