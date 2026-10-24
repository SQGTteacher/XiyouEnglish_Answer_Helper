// 内置的 Snappy 解压实现（仅解压，LevelDB 用得到）
// 源自 snappyjs (MIT License, Copyright (c) 2016 Zhipeng Jia)，为免去运行时依赖内联于此。
'use strict';

const WORD_MASK = [0, 0xff, 0xffff, 0xffffff, 0xffffffff];

function copyBytes(fromArray, fromPos, toArray, toPos, length) {
  for (let i = 0; i < length; i++) toArray[toPos + i] = fromArray[fromPos + i];
}

function selfCopyBytes(array, pos, offset, length) {
  for (let i = 0; i < length; i++) array[pos + i] = array[pos - offset + i];
}

function readUncompressedLength(array, start) {
  let result = 0;
  let shift = 0;
  let pos = start;
  while (shift < 32 && pos < array.length) {
    const c = array[pos];
    pos += 1;
    const val = c & 0x7f;
    if (((val << shift) >>> shift) !== val) return -1;
    result |= val << shift;
    if (c < 128) return { length: result, pos };
    shift += 7;
  }
  return -1;
}

/**
 * 解压 Snappy 数据
 * @param {Buffer|Uint8Array} compressed
 * @returns {Buffer}
 */
function uncompress(compressed) {
  const array = compressed instanceof Uint8Array ? compressed : new Uint8Array(compressed);
  const head = readUncompressedLength(array, 0);
  if (head === -1) throw new Error('Invalid Snappy bitstream');
  const outBuffer = Buffer.alloc(head.length);
  const arrayLength = array.length;
  let pos = head.pos;
  let outPos = 0;

  while (pos < array.length) {
    const c = array[pos];
    pos += 1;
    if ((c & 0x3) === 0) {
      // literal
      let len = (c >>> 2) + 1;
      if (len > 60) {
        if (pos + 3 >= arrayLength) throw new Error('Invalid Snappy bitstream');
        const smallLen = len - 60;
        len = array[pos] + (array[pos + 1] << 8) + (array[pos + 2] << 16) + (array[pos + 3] << 24);
        len = (len & WORD_MASK[smallLen]) + 1;
        pos += smallLen;
      }
      if (pos + len > arrayLength) throw new Error('Invalid Snappy bitstream');
      copyBytes(array, pos, outBuffer, outPos, len);
      pos += len;
      outPos += len;
    } else {
      let len, offset;
      switch (c & 0x3) {
        case 1:
          len = ((c >>> 2) & 0x7) + 4;
          offset = array[pos] + ((c >>> 5) << 8);
          pos += 1;
          break;
        case 2:
          if (pos + 1 >= arrayLength) throw new Error('Invalid Snappy bitstream');
          len = (c >>> 2) + 1;
          offset = array[pos] + (array[pos + 1] << 8);
          pos += 2;
          break;
        case 3:
          if (pos + 3 >= arrayLength) throw new Error('Invalid Snappy bitstream');
          len = (c >>> 2) + 1;
          offset = array[pos] + (array[pos + 1] << 8) + (array[pos + 2] << 16) + (array[pos + 3] << 24);
          pos += 4;
          break;
        default:
          throw new Error('Invalid Snappy bitstream');
      }
      if (offset === 0 || offset > outPos) throw new Error('Invalid Snappy bitstream');
      selfCopyBytes(outBuffer, outPos, offset, len);
      outPos += len;
    }
  }
  return outBuffer;
}

module.exports = { uncompress };
