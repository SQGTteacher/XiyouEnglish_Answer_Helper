// 可选数据源：如果客户端带 --remote-debugging-port=9222 运行，
// 直接读取 iframe 的 sessionStorage，延迟更低（并 hook setItem 捕获瞬时写入）
'use strict';
const net = require('net');
const { MiniWS, httpGetJson } = require('./ws');

const DEFAULT_PORT = 9222;

function probePort(port, timeout = 400) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try {
        s.destroy();
      } catch {}
      resolve(ok);
    };
    s.setTimeout(timeout);
    s.once('connect', () => finish(true));
    s.once('timeout', () => finish(false));
    s.once('error', () => finish(false));
    s.connect(port, '127.0.0.1');
  });
}

async function listTargets(port) {
  return httpGetJson(`http://127.0.0.1:${port}/json`);
}

class WS {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
  }
  async connect() {
    const ws = new MiniWS(this.url);
    this.ws = ws;
    ws.on('message', (txt) => {
      let m;
      try {
        m = JSON.parse(txt);
      } catch {
        return;
      }
      if (m.id !== undefined && this.pending.has(m.id)) {
        const { resolve: r, reject: j } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) j(new Error(JSON.stringify(m.error)));
        else r(m.result);
      } else if (m.method) {
        for (const h of this.handlers.get(m.method) || []) {
          try {
            h(m.params);
          } catch {}
        }
      }
    });
    ws.on('close', () => {
      for (const { reject: j } of this.pending.values()) j(new Error('连接关闭'));
      this.pending.clear();
    });
    await ws.connect();
    return this;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('超时 ' + method));
        }
      }, 20000);
    });
  }
  on(m, f) {
    if (!this.handlers.has(m)) this.handlers.set(m, []);
    this.handlers.get(m).push(f);
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

const READ_EXPR = `(() => {
  try {
    const raw = sessionStorage.getItem('vuex') || localStorage.getItem('vuex');
    if (!raw) return '';
    const j = JSON.parse(raw);
    const pg = j && j.params && j.params.paperGroupList;
    if (!Array.isArray(pg) || !pg.length) return '';
    return JSON.stringify(pg);
  } catch (e) { return ''; }
})()`;

/** 通过 CDP 读取实时试题；onPaper(groupList) */
class LiveSource {
  constructor({ port = DEFAULT_PORT, interval = 800, log = console.log } = {}) {
    this.port = port;
    this.interval = interval;
    this.log = log;
    this.timer = null;
    this.cdp = null;
    this.lastLen = 0;
    this.stopped = false;
  }

  async available() {
    return probePort(this.port);
  }

  async start(onPaper, onStatus) {
    this.stopped = false;
    const setStatus = (v) => {
      if (this.connected !== v) {
        this.connected = v;
        try {
          onStatus && onStatus(v);
        } catch {}
      }
    };
    const tick = async () => {
      if (this.stopped) return;
      try {
        if (!this.cdp) {
          const targets = await listTargets(this.port);
          const t = targets.find((x) => String(x.url).includes('xiyouyingyu'));
          if (!t || !t.webSocketDebuggerUrl) throw new Error('未找到客户端页面');
          const cdp = new WS(t.webSocketDebuggerUrl);
          await cdp.connect();
          await cdp.send('Runtime.enable');
          this.cdp = cdp;
          setStatus(true);
        }
        const r = await this.cdp.send('Runtime.evaluate', { expression: READ_EXPR, returnByValue: true });
        const val = r && r.result && r.result.value;
        if (val && val.length > 500 && val.length !== this.lastLen) {
          this.lastLen = val.length;
          const groupList = JSON.parse(val);
          onPaper(groupList);
        }
      } catch (e) {
        setStatus(false);
        try {
          if (this.cdp) this.cdp.close();
        } catch {}
        this.cdp = null;
      }
      if (!this.stopped) this.timer = setTimeout(tick, this.interval);
    };
    tick();
  }

  stop() {
    this.stopped = true;
    this.connected = false;
    if (this.timer) clearTimeout(this.timer);
    try {
      if (this.cdp) this.cdp.close();
    } catch {}
    this.cdp = null;
  }
}

module.exports = { LiveSource, probePort, DEFAULT_PORT };
