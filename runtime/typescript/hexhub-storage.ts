import {constants, closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync} from 'node:fs';
import {join, resolve, sep} from 'node:path';
import {homedir} from 'node:os';
import {Deserializer} from 'node:v8';

// Chromium uses idb_cmp1. Never open/recover/lock its live LevelDB or search
// obsolete files for JSON; resolve the current manifest and sequence tombstones.
const maximum = 64 * 1024 * 1024;
const failure = () => new Error('HexHub 本地连接数据格式不受支持或读取期间发生变化');
function check(value: unknown): asserts value { if (!value) throw failure(); }
class Bytes {
  offset = 0;
  constructor(readonly data: Buffer) {}
  get remaining() { return this.data.length - this.offset; }
  take(length: number) { check(Number.isSafeInteger(length) && length >= 0 && length <= this.remaining); const value = this.data.subarray(this.offset, this.offset + length); this.offset += length; return value; }
  uint() {
    let value = 0n;
    for (let shift = 0; shift < 70; shift += 7) {
      const byte = this.take(1)[0];
      check(shift < 63 || byte <= 1); value |= BigInt(byte & 127) << BigInt(shift);
      if (!(byte & 128)) return value;
    }
    throw failure();
  }
  number() { const value = this.uint(); check(value <= BigInt(Number.MAX_SAFE_INTEGER)); return Number(value); }
  field() { const length = this.number(); check(length <= maximum); return this.take(length); }
}

const crcTable = Array.from({length: 256}, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0x82f63b78 : value >>> 1;
  return value >>> 0;
});
export function hexHubCRC(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  crc = (crc ^ 0xffffffff) >>> 0;
  return (((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0;
}
export function decodeHexHubSnappy(data: Buffer, limit = maximum) {
  const bytes = new Bytes(data), length = bytes.number(); check(length <= limit);
  const output = Buffer.alloc(length); let position = 0;
  while (bytes.remaining) {
    const tag = bytes.take(1)[0], type = tag & 3;
    if (!type) {
      let count = tag >>> 2;
      if (count >= 60) { const raw = bytes.take(count - 59); count = raw.readUIntLE(0, raw.length); }
      count++; check(position + count <= length);
      bytes.take(count).copy(output, position); position += count;
    } else {
      const count = type === 1 ? 4 + ((tag >>> 2) & 7) : 1 + (tag >>> 2);
      const distance = type === 1 ? ((tag & 224) << 3) + bytes.take(1)[0] : type === 2 ? bytes.take(2).readUInt16LE() : bytes.take(4).readUInt32LE();
      check(distance > 0 && distance <= position && position + count <= length);
      for (let index = 0; index < count; index++) { output[position] = output[position - distance]; position++; }
    }
  }
  check(position === length); return output;
}
function journal(data: Buffer, visit: (record: Buffer) => void) {
  let offset = 0, parts: Buffer[] | undefined, size = 0;
  while (offset < data.length) {
    const blockEnd = Math.min(data.length, (Math.floor(offset / 32768) + 1) * 32768);
    if (blockEnd - offset < 7) { check(data.subarray(offset, blockEnd).every(byte => byte === 0)); offset = blockEnd; continue; }
    const crc = data.readUInt32LE(offset), length = data.readUInt16LE(offset + 4), type = data[offset + 6];
    if (!crc && !length && !type) { check(data.subarray(offset, blockEnd).every(byte => byte === 0)); offset = blockEnd; continue; }
    check(offset + 7 + length <= blockEnd && type >= 1 && type <= 4);
    const fragment = data.subarray(offset + 7, offset + 7 + length);
    check(crc === hexHubCRC(data.subarray(offset + 6, offset + 7 + length))); offset += 7 + length;
    if (type === 1) { check(!parts); visit(fragment); }
    else if (type === 2) { check(!parts); parts = [fragment]; size = length; }
    else {
      check(parts); parts.push(fragment); size += length; check(size <= maximum);
      if (type === 4) { visit(Buffer.concat(parts, size)); parts = undefined; size = 0; }
    }
  }
  check(!parts);
}
function manifest(data: Buffer) {
  const files = new Set<bigint>(); let log = 0n, previous = 0n, comparator = false;
  journal(data, record => {
    const bytes = new Bytes(record);
    while (bytes.remaining) {
      switch (bytes.number()) {
        case 1: check(bytes.field().toString() === 'idb_cmp1'); comparator = true; break;
        case 2: log = bytes.uint(); break;
        case 3: case 4: bytes.uint(); break;
        case 9: previous = bytes.uint(); break;
        case 5: bytes.uint(); bytes.field(); break;
        case 6: bytes.uint(); files.delete(bytes.uint()); break;
        case 7: bytes.uint(); { const file = bytes.uint(); bytes.uint(); bytes.field(); bytes.field(); files.add(file); } break;
        default: throw failure();
      }
    }
  });
  check(comparator && files.size <= 256); return {files, log, previous};
}
function prefix(data: Buffer) {
  check(data.length > 0);
  const lengths = [(data[0] >>> 5) + 1, ((data[0] >>> 2) & 7) + 1, (data[0] & 3) + 1];
  const bytes = new Bytes(data); bytes.take(1);
  const values = lengths.map(length => { let value = 0n; const raw = bytes.take(length); for (let index = 0; index < length; index++) value |= BigInt(raw[index]) << BigInt(8 * index); check(value <= BigInt(Number.MAX_SAFE_INTEGER)); return Number(value); });
  return {db: values[0], store: values[1], index: values[2], rest: data.subarray(bytes.offset)};
}
function blockEntries(data: Buffer) {
  check(data.length >= 4); const count = data.readUInt32LE(data.length - 4);
  check(count > 0 && count <= (data.length - 4) / 4);
  const end = data.length - 4 - count * 4, restarts = Array.from({length: count}, (_, index) => data.readUInt32LE(end + index * 4));
  const restartSet = new Set(restarts);
  check(restarts[0] === 0 && restarts.every((value, index) => value <= end && (!index || value > restarts[index - 1])));
  const bytes = new Bytes(data.subarray(0, end)), entries: {key: Buffer; value: Buffer}[] = [], starts = new Set<number>();
  let previous = Buffer.alloc(0);
  while (bytes.remaining) {
    const start = bytes.offset, shared = bytes.number(), unshared = bytes.number(), length = bytes.number();
    check(shared <= previous.length && (!restartSet.has(start) || shared === 0)); starts.add(start);
    const key = Buffer.concat([previous.subarray(0, shared), bytes.take(unshared)]), value = bytes.take(length);
    check(key.length <= maximum && entries.length < 100000); entries.push({key, value}); previous = key;
  }
  check(restarts.every(offset => starts.has(offset) || !end && offset === 0)); return entries;
}
function table(data: Buffer, budget: {expanded: number}, visit: (key: Buffer, value: Buffer, sequence: bigint, deleted: boolean) => void) {
  check(data.length >= 48 && data.readBigUInt64LE(data.length - 8) === 0xdb4775248b80fb57n);
  const footer = new Bytes(data.subarray(data.length - 48, data.length - 8)); footer.uint(); footer.uint();
  const indexOffset = footer.number(), indexSize = footer.number(); check(footer.take(footer.remaining).every(byte => byte === 0));
  const read = (offset: number, size: number) => {
    check(offset >= 0 && size >= 0 && offset + size + 5 <= data.length - 48);
    const type = data[offset + size]; check(type === 0 || type === 1);
    check(data.readUInt32LE(offset + size + 1) === hexHubCRC(data.subarray(offset, offset + size + 1)));
    const value = type ? decodeHexHubSnappy(data.subarray(offset, offset + size), budget.expanded) : data.subarray(offset, offset + size);
    budget.expanded -= value.length; check(budget.expanded >= 0); return value;
  };
  const seen = new Set<number>();
  for (const entry of blockEntries(read(indexOffset, indexSize))) {
    const handle = new Bytes(entry.value), offset = handle.number(), size = handle.number();
    check(!handle.remaining && !seen.has(offset) && offset + size + 5 <= indexOffset); seen.add(offset);
    for (const {key, value} of blockEntries(read(offset, size))) {
      check(key.length >= 8); const tag = key.readBigUInt64LE(key.length - 8); check((tag & 255n) <= 1n);
      visit(key.subarray(0, key.length - 8), value, tag >> 8n, (tag & 255n) === 0n);
    }
  }
}
function ownedDirectory(path: string) {
  const info = lstatSync(path); check(info.isDirectory() && !info.isSymbolicLink() && !(info.mode & 0o022) && (process.platform === 'win32' || info.uid === process.getuid?.()));
}
function stableRead(path: string, budget: {remaining: number}) {
  const info = lstatSync(path); check(info.isFile() && !info.isSymbolicLink() && info.size <= budget.remaining && (process.platform === 'win32' || info.uid === process.getuid?.()));
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd); check(opened.ino === info.ino && opened.dev === info.dev);
    const data = Buffer.alloc(info.size + 1); let size = 0, length = 0;
    while (size < data.length && (length = readSync(fd, data, size, data.length - size, null))) size += length;
    const after = fstatSync(fd); check(size === info.size && after.size === info.size && after.mtimeMs === info.mtimeMs && after.ctimeMs === info.ctimeMs);
    budget.remaining -= size; return data.subarray(0, size);
  } finally { closeSync(fd); }
}
function currentRecords(path: string, signal?: AbortSignal) {
  const budget = {remaining: maximum}, expanded = {expanded: maximum};
  const current = stableRead(join(path, 'CURRENT'), budget), name = current.toString().trim(); check(/^MANIFEST-\d+$/.test(name));
  const raw = stableRead(join(path, name), budget), state = manifest(raw);
  const records = new Map<string, {key: Buffer; value: Buffer; sequence: bigint; deleted: boolean}>();
  const put = (key: Buffer, value: Buffer, sequence: bigint, deleted: boolean) => {
    const p = prefix(key); if (!p.db || !(p.store !== 0 && p.index === 1 || p.store === 0 && p.index === 0 && p.rest[0] === 50)) return;
    const id = key.toString('hex'), previous = records.get(id);
    check(records.size < 20000 || records.has(id));
    if (!previous || sequence > previous.sequence) records.set(id, {key, value: Buffer.from(value), sequence, deleted});
    else if (sequence === previous.sequence) check(deleted === previous.deleted && value.equals(previous.value));
  };
  for (const file of state.files) {
    signal?.throwIfAborted(); const stem = String(file).padStart(6, '0'); let filename = join(path, stem + '.ldb');
    try { lstatSync(filename); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; filename = join(path, stem + '.sst'); }
    table(stableRead(filename, budget), expanded, put);
  }
  for (const filename of readdirSync(path)) {
    if (!/^\d+\.log$/.test(filename)) continue; const number = BigInt(filename.slice(0, -4));
    if (!(state.log !== 0n && number >= state.log || state.previous !== 0n && number === state.previous)) continue;
    signal?.throwIfAborted();
    journal(stableRead(join(path, filename), budget), raw => {
      check(raw.length >= 12); const sequence = raw.readBigUInt64LE(), count = raw.readUInt32LE(8), bytes = new Bytes(raw.subarray(12)); check(count <= 100000);
      for (let index = 0; index < count; index++) { const tag = bytes.take(1)[0]; check(tag <= 1); const key = bytes.field(), value = tag ? bytes.field() : Buffer.alloc(0); put(key, value, sequence + BigInt(index), !tag); }
      check(!bytes.remaining);
    });
  }
  const verification = {remaining: maximum};
  check(stableRead(join(path, name), verification).equals(raw) && stableRead(join(path, 'CURRENT'), verification).equals(current)); return records;
}
function utf16BE(data: Buffer) { check(data.length % 2 === 0); return Buffer.from(data).swap16().toString('utf16le'); }
export function decodeHexHubAsset(input: Buffer) {
  const record = new Bytes(input); record.uint(); let data = input.subarray(record.offset);
  if (data.subarray(0, 3).equals(Buffer.from([255, 17, 2]))) data = decodeHexHubSnappy(data.subarray(3), 1024 * 1024);
  check(data.length <= 1024 * 1024); const bytes = new Bytes(data); check(bytes.take(1)[0] === 255); let version = bytes.number(), start = 0, end = data.length;
  if (version >= 16) {
    check(version <= 21);
    if (version >= 21) { check(bytes.take(1)[0] === 254); const offset = bytes.take(12).readBigUInt64BE(); if (offset) { check(offset <= BigInt(data.length) && offset >= BigInt(bytes.offset)); end = Number(offset); } }
    start = bytes.offset; check(bytes.take(1)[0] === 255); version = bytes.number();
  }
  check(version >= 13 && version <= 15);
  const deserializer = new Deserializer(data.subarray(start, end)); check(deserializer.readHeader()); const value = deserializer.readValue();
  let tail = false; try { deserializer.readRawBytes(1); tail = true; } catch {} check(!tail);
  const seen = new WeakSet<object>(); let nodes = 0;
  const validate = (item: any, depth: number) => {
    check(depth <= 32 && ++nodes <= 20000);
    if (item === null || item === undefined || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number') { check(Number.isFinite(item)); return; }
    check(typeof item === 'object' && !seen.has(item)); seen.add(item);
    if (item instanceof Date) { check(Number.isFinite(item.getTime())); seen.delete(item); return; }
    check(Array.isArray(item) || Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null);
    for (const child of Object.values(item)) validate(child, depth + 1);
    seen.delete(item);
  };
  validate(value, 0); check(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, any>;
}
export function readHexHubLocalAssets(userHome = homedir(), signal?: AbortSignal): Record<string, any>[] {
  try {
    const base = resolve(userHome), pieces = ['.hexhub', 'cache', 'Default', 'IndexedDB']; let directory = base;
    for (const part of pieces) { directory = join(directory, part); ownedDirectory(directory); }
    const profiles = readdirSync(directory).filter(name => /^http_localhost_\d+\.indexeddb\.leveldb$/.test(name)); check(profiles.length === 1);
    const path = join(directory, profiles[0]); ownedDirectory(path); check(realpathSync(path).startsWith(realpathSync(base) + sep));
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      try {
        const records = currentRecords(path, signal), stores = new Set<string>();
        for (const record of records.values()) {
          if (record.deleted) continue; const p = prefix(record.key);
          if (p.store || p.index || p.rest[0] !== 50) continue;
          const bytes = new Bytes(p.rest.subarray(1)), store = bytes.number();
          if (bytes.take(1)[0] === 0 && !bytes.remaining && utf16BE(record.value) === 'assets') stores.add(p.db + ':' + store);
        }
        check(stores.size === 1); const out: Record<string, any>[] = [];
        for (const record of records.values()) {
          const p = prefix(record.key); if (record.deleted || p.index !== 1 || !stores.has(p.db + ':' + p.store)) continue;
          const value = decodeHexHubAsset(record.value);
          if (value.delFlag === true || Number(value.delFlag ?? 0) !== 0 || ![1, 2, 4, 15, 19].includes(Number(value.type))) continue;
          out.push(value);
        }
        return out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      } catch (error) { last = error; }
    }
    throw last;
  } catch (error) { signal?.throwIfAborted(); throw new Error(failure().message, {cause: error}); }
}
