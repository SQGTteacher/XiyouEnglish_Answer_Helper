// 数据源：监控西柚英语客户端的 Chromium 存储目录
// 目录： %APPDATA%\<app>\Session Storage  +  %APPDATA%\<app>\Local Storage\leveldb
// 格式： LevelDB（.log WAL / .ldb SSTable，Snappy 压缩），值多为 UTF-16LE
// 答案： 键 map-<ns>-vuex  ->  JSON.params.paperGroupList（含 answerTxt/key/points/refText）
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { readLevelDBAll, decodeDOMValue } = require('./leveldb-read');
const { parsePaper, stripHtml } = require('./paper-parser');

/** 自动定位客户端数据目录 */
function findClientDataDirs(exclude = []) {
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const found = [];
  // 排除本助手自身的 userData 目录
  const skip = new Set(
    ['xiyou-answer-helper', 'xiyouanswerhelper', '西柚答案助手', ...exclude].map((s) => String(s).toLowerCase()),
  );
  let entries = [];
  try {
    entries = fs.readdirSync(appdata, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (skip.has(e.name.toLowerCase())) continue;
    const p = path.join(appdata, e.name);
    const hasSession = fs.existsSync(path.join(p, 'Session Storage'));
    const hasLocal = fs.existsSync(path.join(p, 'Local Storage'));
    if (!hasSession && !hasLocal) continue;
    // 需要看起来像 Electron/Chromium 配置目录
    const looksChromium =
      fs.existsSync(path.join(p, 'Cache')) || fs.existsSync(path.join(p, 'Cookies')) || fs.existsSync(path.join(p, 'Preferences'));
    if (!looksChromium) continue;
    found.push({ name: e.name, dir: p, score: (e.name === 'web-desktop' ? 100 : 0) + (hasSession ? 10 : 0) + (hasLocal ? 5 : 0) });
  }
  found.sort((a, b) => b.score - a.score);
  return found;
}

function storageDirs(dataDir) {
  const out = [];
  const session = path.join(dataDir, 'Session Storage');
  // 兼容两种布局：Session Storage/ 直接放文件，或 Session Storage/leveldb/
  if (fs.existsSync(path.join(session, 'leveldb'))) out.push(path.join(session, 'leveldb'));
  else if (fs.existsSync(session)) out.push(session);
  const local = path.join(dataDir, 'Local Storage');
  if (fs.existsSync(path.join(local, 'leveldb'))) out.push(path.join(local, 'leveldb'));
  else if (fs.existsSync(local)) out.push(local);
  return out;
}

/** 收集目录里所有版本的某个存储键 */
function collectKeyVersions(dirs, keyMatcher) {
  const hits = [];
  for (const dir of dirs) {
    let all;
    try {
      all = readLevelDBAll(dir);
    } catch {
      continue;
    }
    for (const [k, arr] of all) {
      if (!keyMatcher(k)) continue;
      for (const v of arr) {
        hits.push({ key: k, dir, ...v });
      }
    }
  }
  hits.sort((a, b) => b.seq - a.seq);
  return hits;
}

/**
 * 从存储目录中解析出最近一份「有内容的试题」
 * @returns {{paper:object, version:object}|null}
 */
function readLatestPaper(dataDir, opts = {}) {
  const dirs = storageDirs(dataDir);
  const versions = collectKeyVersions(dirs, (k) => /vuex$/.test(k));
  let best = null;
  for (const v of versions) {
    let txt;
    try {
      txt = decodeDOMValue(v.value);
    } catch {
      continue;
    }
    if (txt.length < 200) continue;
    let json;
    try {
      json = JSON.parse(txt);
    } catch {
      continue;
    }
    const params = (json && json.params) || {};
    const groupList = params.paperGroupList;
    if (!Array.isArray(groupList) || groupList.length === 0) continue;
    // 必须真的包含答案/原文，否则视为占位
    const hasContent = groupList.some((g) =>
      (g.smallList || []).some((s) => (s.processList || []).some((p) => p.oralTypeModel && (p.oralTypeModel.answerTxt || p.oralTypeModel.points || p.oralTypeModel.key || p.oralTypeModel.refText))),
    );
    if (!hasContent) continue;
    best = { groupList, version: v, json };
    break; // versions 已按 seq 降序，取第一个有效即可
  }
  if (!best) return null;

  const meta = {};
  // 尝试补充作业/试卷名（localStorage.homeworkItem）
  try {
    const hw = collectKeyVersions(dirs, (k) => /homeworkItem$/.test(k))[0];
    if (hw) {
      const o = JSON.parse(decodeDOMValue(hw.value));
      const nm = o.shortName || o.name || '';
      if (nm) {
        meta.title = stripHtml(nm);
        const full = stripHtml(o.questionsName || o.fullName || '');
        meta.subtitle = full && full !== meta.title ? full : '';
      }
    }
  } catch {
    /* 忽略 */
  }
  const paper = parsePaper(best.groupList, { ...meta, source: 'storage' });
  return { paper, version: best.version };
}

module.exports = { findClientDataDirs, storageDirs, readLatestPaper, collectKeyVersions };
