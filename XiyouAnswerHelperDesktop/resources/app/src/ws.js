// 极简 WebSocket 客户端（RFC6455）+ HTTP GET，兼容 Node 16（Electron 22 主进程）
// 只实现 CDP 需要的部分：文本帧、ping/pong、close、分片
'use strict';
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const bufs = [];
      res.on('data', (d) => bufs.push(d));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(bufs).toString('utf8')));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('HTTP 超时')));
  });
}

class MiniWS extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.fragOp = 0;
    this.ready = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const u = new URL(this.url);
      const key = crypto.randomBytes(16).toString('base64');
      const req = http.request({
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': key,
        },
      });

      req.on('upgrade', (res, socket) => {
        this.socket = socket;
        this.ready = true;
        socket.on('data', (d) => this._onData(d));
        socket.on('close', () => this.emit('close'));
        socket.on('error', (e) => this.emit('error', e));
        resolve(this);
      });
      req.on('response', (res) => reject(new Error('握手失败 HTTP ' + res.statusCode)));
      req.on('error', reject);
      req.end();
    });
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const frame = this._readFrame();
      if (!frame) break;
      const { fin, opcode, payload } = frame;
      if (opcode === 0x8) {
        this.emit('close');
        try {
          this.socket.end();
        } catch {}
        return;
      }
      if (opcode === 0x9) {
        this._sendFrame(0xa, payload);
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x0) {
        this.fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(this.fragments);
          this.fragments = [];
          this.emit('message', full.toString('utf8'));
        }
        continue;
      }
      // 文本/二进制
      if (fin) {
        this.emit('message', payload.toString('utf8'));
      } else {
        this.fragOp = opcode;
        this.fragments = [payload];
      }
    }
  }

  _readFrame() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < off + 2) return null;
      len = b.readUInt16BE(off);
      off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) return null;
      len = Number(b.readBigUInt64BE(off));
      off += 8;
    }
    let mask = null;
    if (masked) {
      if (b.length < off + 4) return null;
      mask = b.slice(off, off + 4);
      off += 4;
    }
    if (b.length < off + len) return null;
    let payload = b.slice(off, off + len);
    if (mask) {
      const out = Buffer.alloc(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i % 4];
      payload = out;
    }
    this.buf = b.slice(off + len);
    return { fin, opcode, payload };
  }

  _sendFrame(opcode, payload) {
    if (!this.socket || this.socket.destroyed) return;
    const len = payload.length;
    let header;
    const mask = crypto.randomBytes(4);
    if (len < 126) {
      header = Buffer.alloc(6);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | len;
      mask.copy(header, 2);
    } else if (len < 65536) {
      header = Buffer.alloc(8);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
      mask.copy(header, 4);
    } else {
      header = Buffer.alloc(14);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
      mask.copy(header, 10);
    }
    const body = Buffer.alloc(len);
    for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i % 4];
    try {
      this.socket.write(Buffer.concat([header, body]));
    } catch {}
  }

  send(text) {
    this._sendFrame(0x1, Buffer.from(String(text), 'utf8'));
  }

  close() {
    try {
      this._sendFrame(0x8, Buffer.alloc(0));
      this.socket.end();
    } catch {}
  }
}

module.exports = { MiniWS, httpGetJson };
