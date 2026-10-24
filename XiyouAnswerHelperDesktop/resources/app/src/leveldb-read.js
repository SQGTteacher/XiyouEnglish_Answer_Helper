// 纯 JS 的 LevelDB 读取器（Table .ldb/.sst + WAL .log），支持 Snappy
// 用途：在不依赖原生模块的前提下，读取 Chromium 的 Local Storage / Session Storage
'use strict';
const fs = require('fs');
const path = require('path');
// 内置 Snappy，无外部依赖
const snappy = require('./vendor/snappy');

const TABLE_MAGIC = '57fb808b247547db'; // 0xdb4775248b80fb57 的小端字节序

function readVarint(buf, pos) {
  let result = 0,
    shift = 0,
    b;
  do {
    if (pos >= buf.length) throw new Error('varint 越界');
    b = buf[pos++];
    result += (b & 0x7f) * Math.pow(2, shift);
    shift += 7;
  } while (b & 0x80);
  return [result, pos];
}

function decompressBlock(raw, type) {
  if (type === 0) return raw;
  if (type === 1) {
    if (!snappy) throw new Error('需要 snappyjs');
    return Buffer.from(snappy.uncompress(raw));
  }
  throw new Error('不支持的压缩类型: ' + type);
}

/** 解析 block 体，返回 [{key, value}] */
function parseBlock(block) {
  const out = [];
  if (block.length < 4) return out;
  const numRestarts = block.readUInt32LE(block.length - 4);
  const dataEnd = block.length - 4 - numRestarts * 4;
  if (dataEnd < 0) return out;
  let pos = 0;
  let key = Buffer.alloc(0);
  while (pos < dataEnd) {
    let shared, unshared, vlen;
    [shared, pos] = readVarint(block, pos);
    [unshared, pos] = readVarint(block, pos);
    [vlen, pos] = readVarint(block, pos);
    if (pos + unshared + vlen > block.length) break;
    key = Buffer.concat([key.slice(0, shared), block.slice(pos, pos + unshared)]);
    pos += unshared;
    const value = block.slice(pos, pos + vlen);
    pos += vlen;
    out.push({ key: Buffer.from(key), value: Buffer.from(value) });
  }
  return out;
}

/** 读取一个 block；bodySize 不含 5 字节 trailer */
function readBlock(buf, offset, bodySize) {
  const raw = buf.slice(offset, offset + bodySize + 5);
  if (raw.length < 5) throw new Error('block 越界');
  const type = raw[bodySize];
  return parseBlock(decompressBlock(raw.slice(0, bodySize), type));
}

/** 读取 Table 文件，返回所有内部键值 */
function readTable(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 48) return [];
  if (buf.slice(buf.length - 8).toString('hex') !== TABLE_MAGIC) return [];
  const footer = buf.slice(buf.length - 48, buf.length - 8);
  let pos = 0;
  let metaOff, metaSize, idxOff, idxSize;
  [metaOff, pos] = readVarint(footer, pos);
  [metaSize, pos] = readVarint(footer, pos);
  [idxOff, pos] = readVarint(footer, pos);
  [idxSize, pos] = readVarint(footer, pos);

  const out = [];
  for (const ie of readBlock(buf, idxOff, idxSize)) {
    let off, size;
    let p = 0;
    [off, p] = readVarint(ie.value, p);
    [size, p] = readVarint(ie.value, p);
    try {
      out.push(...readBlock(buf, off, size));
    } catch (e) {
      /* 跳过坏块 */
    }
  }
  return out;
}

/** 读取 WAL 日志文件
 *  记录头: crc32(4) + length(2) + type(1)
 *  type: 1=FULL 2=FIRST 3=MIDDLE 4=LAST 0=零填充
 */
function readLog(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return [];
  }
  const BLOCK = 32768;
  const records = [];
  let pos = 0;
  let pending = null;
  while (pos + 7 <= buf.length) {
    const blockOffset = pos % BLOCK;
    if (BLOCK - blockOffset < 7) {
      pos += BLOCK - blockOffset; // 跳到下一个块
      continue;
    }
    const len = buf.readUInt16LE(pos + 4);
    const type = buf[pos + 6];
    if (type === 0) {
      // 零填充，跳到下一个块
      pos += BLOCK - blockOffset;
      continue;
    }
    if (pos + 7 + len > buf.length) break;
    if (BLOCK - blockOffset < 7 + len) {
      // 记录跨越块边界（理论上不会发生）
      pos += BLOCK - blockOffset;
      continue;
    }
    const data = buf.slice(pos + 7, pos + 7 + len);
    pos += 7 + len;
    if (type === 1) {
      records.push(data);
      pending = null;
    } else if (type === 2) {
      pending = [data];
    } else if (type === 3) {
      if (pending) pending.push(data);
    } else if (type === 4) {
      if (pending) {
        pending.push(data);
        records.push(Buffer.concat(pending));
        pending = null;
      } else {
        records.push(data);
      }
    }
  }
  // 解析 write batch: seq(8) + count(4) + [type(1) + key(varint+bytes) + (value varint+bytes)?]
  const kvs = [];
  for (const rec of records) {
    if (rec.length < 12) continue;
    const seq = Number(rec.readBigUInt64LE(0));
    const count = rec.readUInt32LE(8);
    let p = 12;
    for (let i = 0; i < count && p < rec.length; i++) {
      const t = rec[p++];
      let klen, vlen;
      try {
        [klen, p] = readVarint(rec, p);
      } catch {
        break;
      }
      const key = rec.slice(p, p + klen);
      p += klen;
      let value = Buffer.alloc(0);
      if (t === 1) {
        try {
          [vlen, p] = readVarint(rec, p);
        } catch {
          break;
        }
        value = rec.slice(p, p + vlen);
        p += vlen;
      }
      kvs.push({ key: Buffer.from(key), value: Buffer.from(value), _seq: seq + i, _type: t });
    }
  }
  return kvs;
}

/** 拆出内部键：用户键 + 8 字节 (seq<<8|type) */
function splitInternalKey(k) {
  if (k.length < 8) return { userKey: k, seq: 0, type: 1 };
  const tail = k.slice(k.length - 8);
  const num = Number(tail.readBigUInt64LE(0));
  return { userKey: k.slice(0, k.length - 8), seq: num >> 8, type: num & 0xff };
}

/**
 * 读取整个 leveldb 目录，返回「最新版本」的用户键值
 * 注意：Table(.ldb) 的 key 带 8 字节内部后缀；WAL(.log) 的 key 就是用户键本身
 * @returns {Map<string, {value:Buffer, seq:number, src:string}>}
 */
function readLevelDB(dir) {
  const out = new Map();
  for (const [id, arr] of readLevelDBAll(dir)) {
    const v = arr.find((x) => x.type !== 0); // 取最新一个「未删除」的版本
    if (!v) continue;
    out.set(id, { value: v.value, seq: v.seq, src: v.src });
  }
  return out;
}

/**
 * 读取全部版本：返回 Map<用户键, Array<{value,seq,type,src}>>，按 seq 降序
 */
function readLevelDBAll(dir) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.(ldb|sst)$/.test(f) || /\.log$/.test(f))
    .sort();
  const byKey = new Map();
  const add = (id, value, seq, type, src) => {
    if (!byKey.has(id)) byKey.set(id, []);
    byKey.get(id).push({ value, seq, type, src });
  };
  for (const f of files) {
    const full = path.join(dir, f);
    try {
      if (f.endsWith('.log')) {
        for (const kv of readLog(full)) add(kv.key.toString('latin1'), kv.value, kv._seq, kv._type, f);
      } else {
        for (const kv of readTable(full)) {
          const { userKey, seq, type } = splitInternalKey(kv.key);
          add(userKey.toString('latin1'), kv.value, seq, type, f);
        }
      }
    } catch (e) {
      /* 单文件失败不影响其它 */
    }
  }
  for (const arr of byKey.values()) arr.sort((a, b) => b.seq - a.seq);
  return byKey;
}

/** Chromium DOMStorage 值解码
 *  形式1: 原始 UTF-16LE 字节（Session Storage 新格式）
 *  形式2: 前缀 0x00 + UTF-16LE
 *  形式3: 前缀 0x01 + Latin-1/UTF-8
 */
function decodeDOMValue(buf) {
  if (!buf || buf.length === 0) return '';
  if ((buf[0] === 0x00 || buf[0] === 0x01) && buf.length > 1) {
    const rest = buf.slice(1);
    if (buf[0] === 0x00) return rest.toString('utf16le').replace(/^\uFEFF/, '');
    return rest.toString('utf8');
  }
  // 无前缀：探测 UTF-16LE（ASCII 隔字节为 0）
  if (buf.length >= 2 && buf[1] === 0x00 && buf[0] !== 0x00) {
    return buf.toString('utf16le').replace(/^\uFEFF/, '');
  }
  return buf.toString('utf8');
}

module.exports = { readLevelDB, readLevelDBAll, readTable, readLog, decodeDOMValue, splitInternalKey };
