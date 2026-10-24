// 西柚答案助手 —— 主进程
'use strict';
const { app, BrowserWindow, ipcMain, clipboard, shell, screen, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { findClientDataDirs, readLatestPaper } = require('./src/storage-source');
const { LiveSource, probePort, DEFAULT_PORT } = require('./src/cdp-source');
const { parsePaper } = require('./src/paper-parser');
const { XiyouApi } = require('./src/xiyou-api');

// 避免与客户端冲突
app.commandLine.appendSwitch('disable-http-cache');

// 旧版中文目录的数据迁移到新的英文目录
function migrateOldData() {
  try {
    const appData = app.getPath('appData');
    const newFile = path.join(app.getPath('userData'), 'papers.json');
    if (fs.existsSync(newFile)) return;
    for (const legacy of ['西柚答案助手']) {
      const oldFile = path.join(appData, legacy, 'papers.json');
      if (fs.existsSync(oldFile)) {
        fs.mkdirSync(path.dirname(newFile), { recursive: true });
        fs.copyFileSync(oldFile, newFile);
        break;
      }
    }
  } catch {}
}

let win = null;
const state = {
  clientDirs: [],
  dataDir: null,
  paper: null,
  papers: [], // 历史（新的在前）
  status: '正在寻找西柚英语客户端…',
  live: false,
  topMost: true,
  clickThrough: false,
  opacity: 1,
  fontSize: 14,
  autoLaunched: false,
};

// ---------- 历史持久化 ----------
function historyFile() {
  return path.join(app.getPath('userData'), 'papers.json');
}
function loadHistory() {
  try {
    const j = JSON.parse(fs.readFileSync(historyFile(), 'utf8'));
    if (Array.isArray(j.papers)) state.papers = j.papers.slice(0, 60);
  } catch {}
  // 载入历史后自动选中最新一份
  if (!state.paper && state.papers.length) state.paper = state.papers[0];
}
function saveHistory() {
  try {
    fs.mkdirSync(path.dirname(historyFile()), { recursive: true });
    fs.writeFileSync(historyFile(), JSON.stringify({ papers: state.papers.slice(0, 60) }), 'utf8');
  } catch {}
}

// ---------- 在线账号 ----------
function accountFile() {
  return path.join(app.getPath('userData'), 'account.json');
}
function readAccountFile() {
  try {
    const j = JSON.parse(fs.readFileSync(accountFile(), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}
function writeAccountFile(obj) {
  try {
    fs.mkdirSync(path.dirname(accountFile()), { recursive: true });
    fs.writeFileSync(accountFile(), JSON.stringify(obj, null, 2), 'utf8');
  } catch {}
}
function encStr(s) {
  try {
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      return 'v1:' + safeStorage.encryptString(String(s)).toString('base64');
    }
  } catch {}
  return 'v0:' + Buffer.from(String(s), 'utf8').toString('base64');
}
function decStr(s) {
  if (!s) return '';
  try {
    if (String(s).startsWith('v1:')) return safeStorage.decryptString(Buffer.from(String(s).slice(3), 'base64'));
    if (String(s).startsWith('v0:')) return Buffer.from(String(s).slice(3), 'base64').toString('utf8');
  } catch {}
  return '';
}

let api = null;
function getApi() {
  if (api) return api;
  const a = readAccountFile();
  const udid = a.udid || crypto.randomBytes(16).toString('hex');
  api = new XiyouApi(udid);
  api.sessionId = a.sessionId || '';
  api.userId = a.userId || '';
  api.clazzId = a.clazzId || '';
  if (!a.udid) {
    a.udid = udid;
    writeAccountFile(a);
  }
  return api;
}

function pickArray(d) {
  if (!d) return [];
  if (Array.isArray(d)) return d;
  for (const k of ['list', 'records', 'rows', 'itemList', 'bagList', 'homeworkList', 'data', 'content', 'result', 'items']) {
    if (Array.isArray(d[k])) return d[k];
  }
  return [];
}

function normalizeHomeworkItem(x) {
  x = x || {};
  return {
    name: String(x.name || x.shortName || x.homeworkName || x.title || x.bagName || '未命名作业'),
    sub: String(x.className || x.teacherName || x.schoolName || x.remark || ''),
    status: x.status,
    score: x.score,
    totalScore: x.totalScore,
    paperGroupId: String(x.paperGroupId || x.paperGroupID || x.groupId || ''),
    id: x.id,
    bagId: x.bagId || x.id,
    deadline: x.endTime || x.deadline || x.finishTime || '',
  };
}

function paperKey(p) {
  return p.id + '|' + p.title + '|' + p.stats.answers;
}

/** 收到一份新试卷 */
function onPaper(paper, sourceLabel) {
  if (!paper || !paper.stats || paper.stats.answers === 0) return;
  paper.source = sourceLabel;
  const key = paperKey(paper);
  const existing = state.papers.find((x) => paperKey(x) === key);
  if (existing) {
    existing.capturedAt = paper.capturedAt;
    state.papers = [existing, ...state.papers.filter((x) => x !== existing)];
    if (!state.paper || paperKey(state.paper) === key) state.paper = existing;
  } else {
    state.papers.unshift(paper);
    state.papers = state.papers.slice(0, 60);
    state.paper = paper;
  }
  saveHistory();
  pushState();
  // 有新试题时把自己提到最前，确保能盖在被监控的客户端之上
  if (!existing && win && !win.isDestroyed()) {
    try {
      win.setAlwaysOnTop(true, 'screen-saver');
      win.moveTop();
    } catch {}
  }
}

function pushState() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('state', {
      paper: state.paper,
      papers: state.papers.map((p) => ({ id: p.id, title: p.title, subtitle: p.subtitle, capturedAt: p.capturedAt, answers: p.stats.answers })),
      status: state.status,
      live: state.live,
      topMost: state.topMost,
      clickThrough: state.clickThrough,
      opacity: state.opacity,
      fontSize: state.fontSize,
      dataDir: state.dataDir,
    });
  }
}

// ---------- 目录监控 ----------
let lastFingerprint = '';
function pollStorage() {
  if (!state.dataDir) return;
  let res = null;
  try {
    res = readLatestPaper(state.dataDir);
  } catch (e) {
    return;
  }
  if (!res) return;
  const fp = res.version.src + ':' + res.version.seq + ':' + res.paper.stats.answers + ':' + res.paper.title;
  if (fp === lastFingerprint) return;
  lastFingerprint = fp;
  res.paper.source = '文件监控';
  onPaper(res.paper, '文件监控');
}

// ---------- 实时数据源（可选） ----------
let liveSource = null;
async function startLive() {
  const port = Number(process.env.XY_CDP_PORT || DEFAULT_PORT) || DEFAULT_PORT;
  const ok = await probePort(port);
  if (!ok) return;
  liveSource = new LiveSource({ port });
  await liveSource.start(
    (groupList) => {
      const paper = parsePaper(groupList, { source: '实时', capturedAt: Date.now() });
      onPaper(paper, '实时');
    },
    (connected) => {
      state.live = connected;
      pushState();
    },
  );
}

// ---------- 自动拉起客户端 ----------
function candidateClientExes() {
  const out = [];
  const push = (p) => {
    try {
      if (p && fs.existsSync(p) && !out.includes(p)) out.push(p);
    } catch {}
  };
  // 1) 已知安装位置
  push('D:\\web-desktop\\西柚英语个人版.exe');
  push('C:\\web-desktop\\西柚英语个人版.exe');
  // 2) 常见根目录下扫描含「西柚」的文件夹
  const roots = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'), 'D:\\', 'C:\\', 'E:\\'];
  for (const root of roots) {
    if (!root) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (!/西柚|xiyou/i.test(e.name)) continue;
      const dir = path.join(root, e.name);
      push(path.join(dir, '西柚英语个人版.exe'));
      try {
        for (const f of fs.readdirSync(dir)) {
          if (f.toLowerCase().endsWith('.exe') && /西柚|xiyou/i.test(f)) push(path.join(dir, f));
        }
      } catch {}
    }
    // web-desktop 这种不叫西柚的目录，靠 app.asar 判定
    const wd = path.join(root, 'web-desktop');
    if (fs.existsSync(path.join(wd, 'resources', 'app.asar'))) {
      try {
        for (const f of fs.readdirSync(wd)) {
          if (f.toLowerCase().endsWith('.exe') && !/^uninstall/i.test(f)) push(path.join(wd, f));
        }
      } catch {}
    }
  }
  return out;
}

function launchClient() {
  const exes = candidateClientExes();
  if (!exes.length) return false;
  const { spawn } = require('child_process');
  try {
    const child = spawn(exes[0], [`--remote-debugging-port=${DEFAULT_PORT}`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    state.autoLaunched = true;
    state.status = '正在启动西柚英语客户端…';
    pushState();
    return true;
  } catch (e) {
    return false;
  }
}

// ---------- 窗口 ----------
function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: 560,
    height: 820,
    x: Math.max(0, width - 600),
    y: 40,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    backgroundColor: '#0f1115',
    title: '西柚答案助手',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      additionalArguments: ['--xy-helper'],
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('move', placeRestoreWin);
  win.on('resize', placeRestoreWin);
  win.on('minimize', () => {
    if (restoreWin && !restoreWin.isDestroyed()) restoreWin.hide();
  });
  win.on('restore', () => {
    if (restoreWin && !restoreWin.isDestroyed()) restoreWin.show();
    placeRestoreWin();
  });
  win.on('closed', () => {
    hideRestoreWin();
    win = null;
  });
}

// ---------- 鼠标穿透 ----------
// 开启穿透后主窗口整体忽略鼠标；由于 Electron 的 forward 转发在部分环境下不可靠，
// 这里额外弹出一个「独立小窗口」按钮，它永不穿透，保证随时能用鼠标关掉穿透。
let restoreWin = null;

function placeRestoreWin() {
  if (!restoreWin || restoreWin.isDestroyed() || !win || win.isDestroyed()) return;
  try {
    const b = win.getBounds();
    const w = 132;
    const h = 34;
    restoreWin.setBounds({ x: b.x + b.width - w - 10, y: b.y + 6, width: w, height: h });
  } catch {}
}

function showRestoreWin() {
  if (restoreWin && !restoreWin.isDestroyed()) {
    placeRestoreWin();
    return;
  }
  restoreWin = new BrowserWindow({
    width: 132,
    height: 34,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    backgroundColor: '#ff7c53',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  restoreWin.setAlwaysOnTop(true, 'screen-saver');
  restoreWin.loadFile(path.join(__dirname, 'renderer', 'restore.html'));
  restoreWin.on('closed', () => {
    restoreWin = null;
  });
  placeRestoreWin();
  setTimeout(placeRestoreWin, 120);
}

function hideRestoreWin() {
  if (restoreWin && !restoreWin.isDestroyed()) restoreWin.destroy();
  restoreWin = null;
}

function applyClickThrough() {
  if (!win || win.isDestroyed()) return;
  try {
    if (state.clickThrough) {
      win.setIgnoreMouseEvents(true, { forward: true });
      showRestoreWin();
    } else {
      win.setIgnoreMouseEvents(false);
      hideRestoreWin();
    }
  } catch {}
}

function setClickThrough(v) {
  state.clickThrough = !!v;
  applyClickThrough();
  pushState();
  return state.clickThrough;
}

// ---------- 鼠标穿透 / 显隐 热键 ----------
function registerHotkeys() {
  const { globalShortcut } = require('electron');
  const results = [];
  const tryReg = (accel, fn) => {
    try {
      const ok = globalShortcut.register(accel, fn);
      results.push(accel + (ok ? '✓' : '✗'));
      return ok;
    } catch (e) {
      results.push(accel + '✗');
      return false;
    }
  };
  const toggled = tryReg('Control+Alt+X', () => setClickThrough(!state.clickThrough));
  if (!toggled) tryReg('Control+Alt+F8', () => setClickThrough(!state.clickThrough));
  const shown = tryReg('Control+Alt+Z', () => {
    if (!win) return;
    if (win.isVisible() && !win.isMinimized()) win.hide();
    else {
      win.show();
      win.setAlwaysOnTop(state.topMost, 'screen-saver');
    }
  });
  if (!shown)
    tryReg('Control+Alt+F9', () => {
      if (!win) return;
      if (win.isVisible() && !win.isMinimized()) win.hide();
      else win.show();
    });
  state.hotkeys = results.join(' ');
}

// ---------- 启动 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      win.show();
      win.focus();
    }
  });
}

app.whenReady().then(() => {
  migrateOldData();
  loadHistory();
  const dirs = findClientDataDirs();
  state.clientDirs = dirs;
  state.dataDir = (dirs[0] && dirs[0].dir) || null;
  if (state.dataDir) {
    state.status = '正在监控：' + state.dataDir;
  } else {
    state.status = '未找到客户端数据目录';
  }
  // 立即读一次
  pollStorage();
  setInterval(pollStorage, 1200);
  startLive().catch(() => {});
  createWindow();
  registerHotkeys();
});

app.on('will-quit', () => {
  try {
    require('electron').globalShortcut.unregisterAll();
  } catch {}
});

app.on('window-all-closed', () => app.quit());

// ---------- IPC ----------
ipcMain.handle('get-state', () => {
  pollStorage();
  return {
    paper: state.paper,
    papers: state.papers.map((p) => ({ id: p.id, title: p.title, subtitle: p.subtitle, capturedAt: p.capturedAt, answers: p.stats.answers })),
    status: state.status,
    live: state.live,
    topMost: state.topMost,
    clickThrough: state.clickThrough,
    hotkeys: state.hotkeys,
    opacity: state.opacity,
    fontSize: state.fontSize,
    dataDir: state.dataDir,
    clientDirs: state.clientDirs.map((d) => d.dir),
  };
});

ipcMain.handle('select-paper', (_e, id) => {
  const p = state.papers.find((x) => x.id === id);
  if (p) state.paper = p;
  pushState();
  return true;
});

ipcMain.handle('copy', (_e, text) => {
  clipboard.writeText(String(text || ''));
  return true;
});

ipcMain.handle('toggle-top', () => {
  state.topMost = !state.topMost;
  if (win) win.setAlwaysOnTop(state.topMost, 'screen-saver');
  pushState();
  return state.topMost;
});

ipcMain.handle('toggle-pass', () => setClickThrough(!state.clickThrough));
ipcMain.handle('set-pass', (_e, v) => setClickThrough(!!v));

// 渲染进程根据鼠标位置请求临时恢复/恢复穿透
ipcMain.on('pass-hover', (_e, interactive) => {
  if (!state.clickThrough || !win || win.isDestroyed()) return;
  try {
    win.setIgnoreMouseEvents(!interactive, { forward: true });
  } catch {}
});

ipcMain.handle('set-opacity', (_e, v) => {
  state.opacity = Math.max(0.3, Math.min(1, Number(v) || 1));
  if (win) win.setOpacity(state.opacity);
  return state.opacity;
});

ipcMain.handle('set-font', (_e, v) => {
  state.fontSize = Math.max(11, Math.min(22, Number(v) || 14));
  pushState();
  return state.fontSize;
});

ipcMain.handle('refresh', () => {
  lastFingerprint = '';
  pollStorage();
  return true;
});

ipcMain.handle('launch-client', () => launchClient());

ipcMain.handle('open-dir', (_e, dir) => {
  shell.openPath(dir || state.dataDir || '');
  return true;
});

ipcMain.handle('set-data-dir', (_e, dir) => {
  state.dataDir = dir;
  state.status = '正在监控：' + dir;
  lastFingerprint = '';
  pollStorage();
  pushState();
  return true;
});

ipcMain.handle('clear-history', () => {
  state.papers = [];
  state.paper = null;
  saveHistory();
  pushState();
  return true;
});

ipcMain.on('win-min', () => win && win.minimize());
ipcMain.on('win-hide', () => win && win.hide());
ipcMain.on('win-close', () => win && win.close());

// ---------- 在线接口 ----------
ipcMain.handle('api-account', () => {
  const a = readAccountFile();
  return {
    account: a.account || '',
    password: decStr(a.password || ''),
    userName: a.userName || '',
    hasSession: !!a.sessionId,
    schoolName: (a.userInfo && a.userInfo.schoolName) || '',
    className: (a.userInfo && a.userInfo.className) || '',
  };
});

ipcMain.handle('api-login', async (_e, payload) => {
  const account = String((payload && payload.account) || '').trim();
  const password = String((payload && payload.password) || '');
  const remember = !payload || payload.remember !== false;
  if (!account || !password) return { ok: false, error: '请输入账号和密码' };
  try {
    const c = getApi();
    const resp = await c.login(account, password);
    if (!XiyouApi.isOk(resp)) {
      const list = resp && resp.data && resp.data.loginAccountList;
      return {
        ok: false,
        error: (resp && resp.note) || '登录失败（state=' + (resp && resp.state) + '）',
        accounts: list || null,
      };
    }
    const info = (resp.data && resp.data.userInfo) || resp.data || {};
    const a = readAccountFile();
    a.udid = c.udid;
    a.account = account;
    if (remember) a.password = encStr(password);
    else delete a.password;
    a.sessionId = c.sessionId;
    a.userId = c.userId;
    a.clazzId = c.clazzId;
    a.userName = info.name || info.realName || '';
    a.userInfo = { schoolName: info.schoolName || '', className: info.className || '' };
    writeAccountFile(a);
    return { ok: true, user: { name: a.userName, schoolName: a.userInfo.schoolName, className: a.userInfo.className } };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('api-logout', () => {
  const a = readAccountFile();
  delete a.sessionId;
  delete a.userId;
  writeAccountFile(a);
  if (api) {
    api.sessionId = '';
    api.userId = '';
  }
  return { ok: true };
});

ipcMain.handle('api-homeworks', async () => {
  try {
    const c = getApi();
    if (!c.sessionId) return { ok: false, error: '尚未登录，请先登录账号' };
    const resp = await c.homeworks();
    if (!XiyouApi.isOk(resp)) {
      return { ok: false, error: resp.note || '获取作业失败（state=' + (resp && resp.state) + '）' };
    }
    return { ok: true, items: pickArray(resp.data).map(normalizeHomeworkItem) };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('api-bag-items', async (_e, bagId) => {
  try {
    const c = getApi();
    if (!c.sessionId) return { ok: false, error: '尚未登录，请先登录账号' };
    const resp = await c.bagItems(String(bagId));
    if (!XiyouApi.isOk(resp)) {
      return { ok: false, error: resp.note || '打开作业失败（state=' + (resp && resp.state) + '）' };
    }
    return { ok: true, items: pickArray(resp.data).map(normalizeHomeworkItem) };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('api-paper', async (_e, groupId) => {
  try {
    const c = getApi();
    if (!c.sessionId) return { ok: false, error: '尚未登录，请先登录账号' };
    const resp = await c.paper(String(groupId));
    if (!XiyouApi.isOk(resp)) {
      return { ok: false, error: resp.note || '取答案失败（state=' + (resp && resp.state) + '）' };
    }
    const result = resp.data && resp.data.result;
    if (!Array.isArray(result) || !result.length) {
      return { ok: false, error: '服务器没有返回试题内容' };
    }
    const paper = parsePaper(result, {
      id: 'online:' + groupId,
      capturedAt: Date.now(),
      source: '在线',
    });
    if (!paper.stats || paper.stats.answers === 0) {
      return { ok: false, error: '这份试题没有解析到答案（可能是纯练习或答案未下发）' };
    }
    onPaper(paper, '在线');
    return { ok: true, id: paper.id, answers: paper.stats.answers };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});
