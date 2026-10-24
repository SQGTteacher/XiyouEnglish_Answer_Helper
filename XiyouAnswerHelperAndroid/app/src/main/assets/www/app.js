'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const state = {
  view: 'login',
  user: null,
  detail: false,
  list: [],
  listMode: 'bags',
  bagId: '',
  bagName: '',
  currentPaper: null,
};

/* ------------------------------------------------------------------ 工具 */

function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

function setLoading(on, text) {
  const el = $('#loading');
  if (on) {
    $('#loadingText').textContent = text || '请稍候…';
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

function showMsg(sel, msg, isError) {
  const el = $(sel);
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('error', !!isError);
}

function showView(name) {
  state.view = name;
  ['login', 'home', 'answer', 'session'].forEach((v) => {
    $('#view-' + v).classList.toggle('hidden', v !== name);
  });
  // 告诉原生层当前视图，决定返回键行为
  let nativeView = name;
  if (name === 'home' && state.listMode === 'items') nativeView = 'home-items';
  if (window.AndroidApi && AndroidApi.setView) {
    try {
      AndroidApi.setView(nativeView);
    } catch (e) {}
  }
  window.scrollTo(0, 0);
}

/* ------------------------------------------------------------------ 原生桥 */

let nativeSeq = 0;
const nativePending = {};

function nativeCall(method, args) {
  return new Promise((resolve, reject) => {
    if (!window.AndroidApi || !AndroidApi.call) {
      reject(new Error('请在 App 内使用'));
      return;
    }
    const id = 'n' + ++nativeSeq;
    const timer = setTimeout(() => {
      delete nativePending[id];
      reject(new Error('请求超时，请检查网络后重试'));
    }, 60000);
    nativePending[id] = {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    };
    try {
      AndroidApi.call(id, method, JSON.stringify(args || {}));
    } catch (e) {
      clearTimeout(timer);
      delete nativePending[id];
      reject(e);
    }
  });
}

window.__nativeResult = function (id, payload) {
  const p = nativePending[id];
  if (!p) return;
  delete nativePending[id];
  let o = payload;
  if (typeof payload === 'string') {
    try {
      o = JSON.parse(payload);
    } catch (e) {
      o = { ok: false, error: payload };
    }
  }
  if (o && o.ok) p.resolve(o);
  else p.reject(Object.assign(new Error((o && o.error) || '操作失败'), { payload: o }));
};

/* ------------------------------------------------------------------ 登录 */

async function doLogin() {
  const account = $('#account').value.trim();
  const password = $('#password').value;
  if (!account) return showMsg('#loginMsg', '请输入账号', true);
  if (!password) return showMsg('#loginMsg', '请输入密码', true);

  showMsg('#loginMsg', '');
  setLoading(true, '正在登录…');
  try {
    const res = await nativeCall('login', {
      account,
      password,
      remember: $('#remember').checked,
    });
    const u = res.data || {};
    state.user = u;
    $('#hello').textContent = (u.name || '同学') + '，你好';
    $('#subline').textContent = [u.schoolName, u.className].filter(Boolean).join(' · ') || '选择一份作业开始';
    showView('home');
    await loadHomeworks();
  } catch (e) {
    if (e.payload && e.payload.accounts && e.payload.accounts.length) {
      const names = e.payload.accounts.map((a) => a.realName || a.loginAccount).join('、');
      showMsg('#loginMsg', '该手机号绑定了多个账号（' + names + '），请直接使用对应学生账号登录', true);
    } else {
      showMsg('#loginMsg', e.message || '登录失败', true);
    }
  } finally {
    setLoading(false);
  }
}

async function doLogout() {
  try {
    await nativeCall('logout', {});
  } catch (e) {}
  state.user = null;
  state.list = [];
  state.currentPaper = null;
  $('#password').value = '';
  showView('login');
  showMsg('#loginMsg', '');
}

/* ------------------------------------------------------------------ 作业列表 */

function pickArray(d) {
  if (!d) return [];
  if (Array.isArray(d)) return d;
  const keys = [
    'list',
    'records',
    'rows',
    'itemList',
    'bagList',
    'homeworkList',
    'data',
    'content',
    'result',
    'items',
  ];
  for (const k of keys) {
    if (Array.isArray(d[k])) return d[k];
  }
  return [];
}

function normalizeItem(raw) {
  raw = raw || {};
  const name =
    raw.name ||
    raw.shortName ||
    raw.homeworkName ||
    raw.title ||
    raw.bagName ||
    '未命名作业';
  const sub =
    raw.className ||
    raw.teacherName ||
    raw.schoolName ||
    raw.teacherRealName ||
    raw.remark ||
    '';
  return {
    raw,
    name: String(name),
    sub: String(sub || ''),
    status: raw.status,
    score: raw.score,
    totalScore: raw.totalScore,
    paperGroupId: String(raw.paperGroupId || raw.paperGroupID || raw.groupId || ''),
    id: raw.id,
    bagId: raw.bagId || raw.id,
    itemId: raw.itemId || raw.id,
    category: raw.category,
    deadline: raw.endTime || raw.deadline || raw.finishTime || '',
  };
}

function statusText(it) {
  const st = String(it.status === undefined || it.status === null ? '' : it.status);
  const map = {
    '0': ['待完成', 'todo'],
    '1': ['已完成', 'done'],
    '2': ['已过期', ''],
    '3': ['已过期', ''],
    '6': ['未开始', ''],
    '7': ['进行中', 'todo'],
    '8': ['不可重做', 'done'],
    '10': ['已完成', 'done'],
  };
  if (map[st]) return map[st];
  if (it.score !== undefined && it.score !== null && it.totalScore) {
    return [it.score + '/' + it.totalScore + ' 分', 'done'];
  }
  return ['', ''];
}

function renderList() {
  const box = $('#homeworkList');
  const empty = $('#emptyTip');
  if (!state.list.length) {
    box.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  box.innerHTML = state.list
    .map((it, i) => {
      const st = statusText(it);
      const icon = state.listMode === 'bags' ? '📦' : '📝';
      const meta = [];
      if (it.sub) meta.push(`<span>${esc(it.sub)}</span>`);
      if (st[0]) meta.push(`<span class="tag ${st[1]}">${esc(st[0])}</span>`);
      if (it.score !== undefined && it.score !== null && it.totalScore) {
        meta.push(`<span class="tag">${esc(it.score)}/${esc(it.totalScore)} 分</span>`);
      }
      if (it.deadline) meta.push(`<span>截止 ${esc(String(it.deadline).slice(5, 16))}</span>`);
      return `<div class="hw" data-i="${i}">
        <div class="ico">${icon}</div>
        <div class="main">
          <div class="name">${esc(it.name)}</div>
          ${meta.length ? `<div class="meta">${meta.join('')}</div>` : ''}
        </div>
        <div class="arrow">›</div>
      </div>`;
    })
    .join('');

  Array.from(box.children).forEach((el) => {
    el.addEventListener('click', () => {
      const it = state.list[Number(el.dataset.i)];
      if (it) onItemTap(it);
    });
  });
}

async function loadHomeworks() {
  showMsg('#homeMsg', '');
  setLoading(true, '正在获取作业列表…');
  try {
    const res = await nativeCall('homeworks', {});
    const items = pickArray(res.data).map(normalizeItem);
    state.list = items;
    state.listMode = 'bags';
    state.bagId = '';
    state.bagName = '';
    $('#btnListBack').classList.add('hidden');
    $('#subline').textContent = items.length ? '共 ' + items.length + ' 个作业' : '暂无作业';
    renderList();
  } catch (e) {
    showMsg('#homeMsg', e.message || '获取作业失败', true);
    state.list = [];
    renderList();
  } finally {
    setLoading(false);
  }
}

async function openBag(bagId, name) {
  setLoading(true, '正在打开作业…');
  try {
    const res = await nativeCall('bagItems', { bagId: String(bagId) });
    const items = pickArray(res.data).map(normalizeItem);
    state.list = items;
    state.listMode = 'items';
    state.bagId = String(bagId);
    state.bagName = name;
    if (window.AndroidApi && AndroidApi.setView) {
      try {
        AndroidApi.setView('home-items');
      } catch (e) {}
    }
    $('#btnListBack').classList.remove('hidden');
    $('#subline').textContent = name + ' · ' + items.length + ' 项';
    renderList();
    if (!items.length) showMsg('#homeMsg', '这个作业本里没有内容', true);
  } catch (e) {
    showMsg('#homeMsg', e.message || '打开失败', true);
  } finally {
    setLoading(false);
  }
}

function backToList() {
  state.listMode = 'bags';
  state.bagId = '';
  if (window.AndroidApi && AndroidApi.setView) {
    try {
      AndroidApi.setView('home');
    } catch (e) {}
  }
  $('#btnListBack').classList.add('hidden');
  loadHomeworks();
}

function onItemTap(it) {
  if (it.paperGroupId) {
    openPaper(it.paperGroupId, it.name);
    return;
  }
  if (state.listMode === 'bags' && it.id) {
    openBag(it.id, it.name);
    return;
  }
  toast('这条作业没有试卷 ID，可尝试手动输入');
}

/* ------------------------------------------------------------------ 取答案 */

async function openPaper(groupId, name) {
  setLoading(true, '正在获取试题答案…');
  try {
    const res = await nativeCall('paper', { groupId: String(groupId) });
    const result = res.data;
    if (!Array.isArray(result) || !result.length) throw new Error('服务器没有返回试题内容');
    const paper = PaperParser.parsePaper(result, {
      id: 'online:' + groupId,
      capturedAt: Date.now(),
      source: '在线',
    });
    state.currentPaper = paper;
    state.rawResult = result;
    renderAnswer();
    showView('answer');
  } catch (e) {
    toast(e.message || '获取答案失败');
  } finally {
    setLoading(false);
  }
}

/* ------------------------------------------------------------------ 渲染答案 */

function answerRow(no, text) {
  return `<div class="ans"><span class="n">${no}.</span><span class="t">${esc(text || '（无答案）')}</span></div>`;
}

function detailHtml(it) {
  const rows = [];
  if (it.question) rows.push(`<div class="row"><span class="k">题干</span>${esc(it.question)}</div>`);

  const all = (it.answers || []).map((x) => AnswerFormat.tidy(x)).filter(Boolean);
  if (all.length > 1) {
    rows.push(
      `<div class="row"><span class="k">全部参考答案</span><ol class="sub-list">${all
        .map((a) => `<li>${esc(a)}</li>`)
        .join('')}</ol></div>`,
    );
  }
  if (it.choices && it.choices.length) {
    it.choices.forEach((c) => {
      const right = (c.options || [])
        .map((o, i) => (o.correct ? String.fromCharCode(65 + i) + '. ' + esc(AnswerFormat.tidy(o.text)) : ''))
        .filter(Boolean)
        .join('　');
      if (right) rows.push(`<div class="row"><span class="k">正确选项</span>${right}</div>`);
    });
  }
  if (it.keys && it.keys.length) {
    rows.push(`<div class="row"><span class="k">关键词</span>${esc(it.keys.map(AnswerFormat.tidy).filter(Boolean).join(' / '))}</div>`);
  }
  if (it.points && it.points.length) {
    rows.push(
      `<div class="row"><span class="k">得分要点</span><ul class="sub-list">${it.points
        .map((p) => AnswerFormat.tidy(p))
        .filter(Boolean)
        .map((p) => `<li>${esc(p)}</li>`)
        .join('')}</ul></div>`,
    );
  }
  if (it.refText && !it.answerFromRef) {
    rows.push(`<div class="row"><span class="k">听力/朗读原文</span><br>${esc(AnswerFormat.tidy(it.refText)).replace(/\n/g, '<br>')}</div>`);
  }
  return rows.length ? `<div class="detail">${rows.join('')}</div>` : '';
}

function renderAnswer() {
  const paper = state.currentPaper;
  if (!paper) return;
  $('#answerTitle').textContent = paper.title;
  const model = AnswerFormat.build(paper, { detail: state.detail });
  let html = `<div class="ans-title">（${esc(model.title)}）</div>`;
  if (state.rawResult) {
    html += `<button id="btnStartSession" class="btn primary session-start" type="button">开始作答</button>`;
  }

  model.sections.forEach((sec) => {
    html += `<div class="sec">
      <div class="sec-head">
        <span class="sec-name">${esc(sec.no)}、${esc(sec.name)}</span>
        ${sec.totalScore !== undefined && sec.totalScore !== null ? `<span class="sec-score">${esc(sec.totalScore)} 分</span>` : ''}
      </div>`;

    if (sec.kind === 'roleplay') {
      sec.blocks.forEach((block) => {
        if (block.label) html += `<div class="block-label">${esc(block.label)}</div>`;
        block.items.forEach((it, i) => {
          html += answerRow(i + 1, AnswerFormat.firstAnswer(it));
          if (state.detail) html += detailHtml(it);
        });
      });
    } else {
      const items = (sec.blocks[0] && sec.blocks[0].items) || [];
      items.forEach((it, i) => {
        const ans = AnswerFormat.firstAnswer(it);
        if (items.length === 1) html += `<div class="plain-ans">${esc(ans || '（无答案）')}</div>`;
        else html += answerRow(i + 1, ans);
        if (state.detail) html += detailHtml(it);
      });
    }
    html += `</div>`;
  });

  $('#answerBody').innerHTML = html;

  const startBtn = $('#btnStartSession');
  if (startBtn) startBtn.onclick = startSession;

  // 点击单条答案复制
  $('#answerBody').addEventListener('click', (e) => {
    const t = e.target.closest('.t, .plain-ans');
    if (!t) return;
    copyText(t.textContent.trim());
  });
}

function copyText(text) {
  if (!text) return;
  if (window.AndroidApi && AndroidApi.copy) {
    try {
      AndroidApi.copy(text);
      toast('已复制');
      return;
    } catch (e) {}
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    toast('已复制');
  } catch (e) {
    toast('复制失败');
  }
  document.body.removeChild(ta);
}

/* ------------------------------------------------------------------ 作答 */

const session = {
  steps: [],
  index: 0,
  countdown: null,
  recording: false,
  showAnswer: localStorage.getItem('xy_session_answer') !== '0',
};

const audioEl = $('#audioEl');
const videoEl = $('#videoEl');

function bindClick(sel, fn) {
  const el = $(sel);
  if (el) el.addEventListener('click', fn);
}

function fmtSec(n) {
  n = Math.max(0, Math.round(Number(n) || 0));
  const m = Math.floor(n / 60);
  const s = n % 60;
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
}

function plainText(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/** 把试卷 processList 展开成「播放 → 等待 → 录音」的作答步骤 */
function buildSessionSteps(raw) {
  const steps = [];
  (raw || []).forEach((g) => {
    (g.smallList || []).forEach((sm) => {
      (sm.processList || []).forEach((p) => {
        const info = p.infoData || {};
        const type = Number(p.processTypeId);
        // infoData.audioURL 多是「文件名」，需要补成 CDN 完整地址
        let media = info.audioURL || '';
        if (media && !/^https?:/i.test(media)) {
          media = 'https://image.xiyouyingyu.com/product/group/' + media;
        }
        if (!media) {
          try {
            const c = JSON.parse(p.content || '{}');
            const list = c.processMaterialList || [];
            const m = list.find((x) => x && x.mediaUrl);
            if (m) media = 'https://image.xiyouyingyu.com/product/group/' + m.mediaUrl;
          } catch (e) {}
        }
        let text = '';
        if (type === 1) text = info.content || info.showTxt || '';
        else if (type === 2) text = '听原文';
        else if (type === 3 || type === 4) text = info.showTxt || '';
        else if (type === 5) text = '观看视频';
        text = plainText(text);

        const om = p.oralType || p.oralTypeModel || {};
        let answer = '';
        if (om.answerTxt) answer = plainText(om.answerTxt);
        else if (om.points) answer = plainText(om.points);
        else if (om.refText) answer = plainText(om.refText);

        if (type === 4 && (!text || /\.(mp3|mp4|wav)$/i.test(text))) {
          text = om.name === '段落' && answer ? answer : '点击「开始录音」开始作答';
        }
        if (!media && !text) return;
        steps.push({
          group: g.name || '',
          small: sm.name || '',
          type,
          media,
          text,
          answer,
          time: Number(info.timeCount || 0) || (type === 4 ? 60 : type === 3 ? 20 : 0),
        });
      });
    });
  });
  return steps;
}

function startSession() {
  if (!state.rawResult) {
    toast('请先获取这份试题');
    return;
  }
  const steps = buildSessionSteps(state.rawResult);
  if (!steps.length) {
    toast('这份试题没有可作答的步骤');
    return;
  }
  session.steps = steps;
  session.index = 0;
  session.recording = false;
  $('#answerSwitch').checked = session.showAnswer;
  showView('session');
  try {
    if (window.AndroidApi && AndroidApi.askAudioPerm) AndroidApi.askAudioPerm();
  } catch (e) {}
  renderStep();
}

function exitSession() {
  stopCountdown();
  session.recording = false;
  stopMedia();
  try {
    if (window.AndroidApi) AndroidApi.audio('stopAll', '');
  } catch (e) {}
  showView('answer');
}

function stopCountdown() {
  if (session.countdown) {
    clearInterval(session.countdown);
    session.countdown = null;
  }
}

function startCountdown(seconds, done) {
  stopCountdown();
  let left = Math.max(1, Number(seconds) || 1);
  const el = $('#sessionTimer');
  if (!el) return;
  el.classList.remove('hidden');
  el.textContent = fmtSec(left);
  session.countdown = setInterval(() => {
    left -= 1;
    el.textContent = fmtSec(Math.max(0, left));
    if (left <= 0) {
      stopCountdown();
      if (done) done();
    }
  }, 1000);
}

function showMedia(isVideo) {
  const box = $('#mediaBox');
  if (box) box.classList.toggle('hidden', !isVideo);
  const info = $('#mediaInfo');
  if (info) info.classList.remove('hidden');
}

function stopMedia() {
  try {
    audioEl.pause();
    audioEl.removeAttribute('src');
    audioEl.load();
  } catch (e) {}
  try {
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load();
  } catch (e) {}
  const box = $('#mediaBox');
  if (box) box.classList.add('hidden');
  const info = $('#mediaInfo');
  if (info) {
    info.classList.add('hidden');
    info.textContent = '';
  }
}

function mediaInfoText(label, cur, dur) {
  if (!dur || !isFinite(dur) || dur <= 0) return label + ' 正在加载…';
  return (
    label + ' 总时长 ' + fmtSec(dur) + ' · 已播 ' + fmtSec(cur) + ' · 剩余 ' + fmtSec(dur - cur)
  );
}

function playAudioInPage(url) {
  if (!url) return;
  showMedia(false);
  try {
    audioEl.src = url;
    audioEl.currentTime = 0;
    const p = audioEl.play();
    if (p && p.catch) p.catch(() => {});
  } catch (e) {}
}

function playVideoInPage(url) {
  if (!url) return;
  showMedia(true);
  try {
    videoEl.src = url;
    videoEl.currentTime = 0;
    const p = videoEl.play();
    if (p && p.catch) p.catch(() => {});
  } catch (e) {}
}

function renderStep() {
  stopCountdown();
  stopMedia();
  const s = session.steps[session.index];
  if (!s) return;
  const kindMap = { 1: '播放题干', 2: '播放原文', 3: '准备时间', 4: '录音作答', 5: '播放视频' };
  $('#sessionTitle').textContent = s.group || '作答';
  $('#sessionMeta').textContent =
    '第 ' + (session.index + 1) + ' / ' + session.steps.length + ' 步' + (s.small ? ' · ' + s.small : '');
  $('#sessionBar').style.width = ((session.index + 1) / session.steps.length) * 100 + '%';
  $('#sessionKind').textContent = kindMap[s.type] || '作答';
  $('#sessionText').textContent = s.text || '';
  const action = $('#sessionAction');
  action.innerHTML = '';
  $('#sessionTimer').classList.add('hidden');
  $('#answerBox').classList.add('hidden');

  if (s.type === 5) {
    playVideoInPage(s.media);
  } else if (s.type === 1 || s.type === 2) {
    playAudioInPage(s.media);
  } else if (s.type === 3) {
    action.innerHTML = '<button class="btn ghost" id="btnSkipWait" type="button">跳过等待</button>';
    bindClick('#btnSkipWait', nextStep);
    startCountdown(s.time || 20, nextStep);
  } else if (s.type === 4) {
    action.innerHTML =
      '<button class="btn primary" id="btnRec" type="button">开始录音</button>' +
      '<button class="btn ghost" id="btnRecPlay" type="button" disabled>回放录音</button>';
    bindClick('#btnRec', toggleRecord);
    bindClick('#btnRecPlay', () => {
      if (window.AndroidApi) AndroidApi.audio('recPlay', '');
    });
    if (session.showAnswer && s.answer) {
      const box = $('#answerBox');
      box.textContent = s.answer;
      box.classList.remove('hidden');
    }
  }
}

function toggleRecord() {
  const s = session.steps[session.index];
  if (!s || !window.AndroidApi) return;
  if (session.recording) {
    AndroidApi.audio('recStop', '');
    return;
  }
  // 原流程：录音前先「叮」一声
  AndroidApi.audio('beep', '');
  session.recording = true;
  const btn = $('#btnRec');
  if (btn) {
    btn.textContent = '准备录音…';
    btn.classList.add('rec-on');
  }
  setTimeout(() => {
    if (!session.recording) return;
    AndroidApi.audio('recStart', String(s.time || 60));
    AndroidApi.audio('recMark', String(session.index));
    if (btn) btn.textContent = '停止录音';
    startCountdown(s.time || 60, () => AndroidApi.audio('recStop', ''));
  }, 320);
}

function nextStep() {
  stopCountdown();
  if (session.recording && window.AndroidApi) AndroidApi.audio('recStop', '');
  if (session.index >= session.steps.length - 1) {
    finishSession();
    return;
  }
  session.index += 1;
  renderStep();
}

function prevStep() {
  stopCountdown();
  if (session.recording && window.AndroidApi) AndroidApi.audio('recStop', '');
  if (session.index > 0) session.index -= 1;
  renderStep();
}

function finishSession() {
  stopCountdown();
  if (session.recording && window.AndroidApi) AndroidApi.audio('recStop', '');
  stopMedia();
  try {
    if (window.AndroidApi) AndroidApi.audio('stopAll', '');
  } catch (e) {}
  if (!window.AndroidApi || !AndroidApi.uploadRecords) {
    toast('本次作答完成');
    showView('answer');
    return;
  }
  setLoading(true, '正在上传作答语音包…');
  AndroidApi.uploadRecords();
}

function autoNext() {
  const at = session.index;
  setTimeout(() => {
    if (session.index === at && state.view === 'session') nextStep();
  }, 380);
}

/* 音视频进度与结束事件 */
(function bindMediaEvents() {
  function onTime(label, el) {
    if (!el) return;
    el.addEventListener('timeupdate', function () {
      const info = $('#mediaInfo');
      if (!info) return;
      if (label === '音频' && !el.duration) return;
      info.textContent = mediaInfoText(label, el.currentTime, el.duration);
    });
    el.addEventListener('loadedmetadata', function () {
      const info = $('#mediaInfo');
      if (info) info.textContent = mediaInfoText(label, 0, el.duration);
    });
  }
  onTime('音频', audioEl);
  onTime('视频', videoEl);

  if (audioEl) {
    audioEl.addEventListener('ended', function () {
      const s = session.steps[session.index];
      if (s && (s.type === 1 || s.type === 2)) autoNext();
    });
    audioEl.addEventListener('error', function () {
      toast('音频加载失败，可直接点「下一步」');
    });
  }
  if (videoEl) {
    videoEl.addEventListener('ended', function () {
      const s = session.steps[session.index];
      if (s && s.type === 5) autoNext();
    });
    videoEl.addEventListener('error', function () {
      toast('视频加载失败，可直接点「下一步」');
    });
  }
})();

window.__audioEvent = function (type, data) {
  data = data || {};
  if (type === 'recStop') {
    session.recording = false;
    stopCountdown();
    const btn = $('#btnRec');
    if (btn) {
      btn.textContent = '重新录音';
      btn.classList.remove('rec-on');
    }
    const p = $('#btnRecPlay');
    if (p) p.disabled = false;
    const t = $('#sessionTimer');
    if (t) t.classList.add('hidden');
    // 录音结束停在本步，方便回放/重录，用户点「下一步」继续
  } else if (type === 'permission') {
    if (!data.granted) toast('需要麦克风权限才能录音，请在系统设置里允许');
  } else if (type === 'uploadProgress') {
    setLoading(true, '正在上传语音包 ' + (data.done || 0) + ' / ' + (data.total || 0) + '…');
  } else if (type === 'uploadDone') {
    setLoading(false);
    toast(data.total ? '已送达 ' + data.total + ' 个作答语音包' : '本次作答完成（没有录音）');
    showView('answer');
  } else if (type === 'uploadError') {
    setLoading(false);
    toast('语音包上传失败：' + (data.message || '网络错误'));
    showView('answer');
  } else if (type === 'error') {
    session.recording = false;
    stopCountdown();
    toast(data.message || '音频出错');
  }
};

/* ------------------------------------------------------------------ 事件 */

$('#btnLogin').addEventListener('click', doLogin);
$('#togglePwd').addEventListener('click', () => {
  const p = $('#password');
  const on = p.type === 'password';
  p.type = on ? 'text' : 'password';
  $('#togglePwd').textContent = on ? '隐藏' : '显示';
});
$('#password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doLogin();
});
$('#account').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#password').focus();
});

$('#btnLogout').addEventListener('click', doLogout);
$('#btnRefresh').addEventListener('click', loadHomeworks);
$('#btnListBack').addEventListener('click', backToList);
$('#btnBack').addEventListener('click', () => showView('home'));

$('#btnManual').addEventListener('click', () => {
  $('#manualBox').classList.toggle('hidden');
});
$('#btnManualGo').addEventListener('click', () => {
  const id = $('#manualId').value.trim();
  if (!id) return toast('请输入试卷 ID');
  openPaper(id, '');
});

$('#detailSwitch').addEventListener('change', (e) => {
  state.detail = e.target.checked;
  if (window.AndroidApi && AndroidApi.prefSet) {
    try {
      AndroidApi.prefSet('detail', state.detail ? '1' : '0');
    } catch (err) {}
  }
  renderAnswer();
});

$('#btnCopy').addEventListener('click', () => {
  if (!state.currentPaper) return;
  copyText(AnswerFormat.toText(state.currentPaper, { detail: state.detail }));
});

$('#btnSessionExit').addEventListener('click', exitSession);
$('#btnSessionDone').addEventListener('click', finishSession);
$('#btnPrevStep').addEventListener('click', prevStep);
$('#btnNextStep').addEventListener('click', nextStep);
$('#answerSwitch').addEventListener('change', (e) => {
  session.showAnswer = e.target.checked;
  localStorage.setItem('xy_session_answer', session.showAnswer ? '1' : '0');
  const s = session.steps[session.index];
  if (s && s.type === 4) {
    const box = $('#answerBox');
    if (session.showAnswer && s.answer) {
      box.textContent = s.answer;
      box.classList.remove('hidden');
    } else {
      box.classList.add('hidden');
    }
  }
});

window.__androidBack = function () {
  if (state.view === 'session') {
    exitSession();
  } else if (state.view === 'answer') {
    showView('home');
  } else if (state.view === 'home' && state.listMode === 'items') {
    backToList();
  }
};

/* ------------------------------------------------------------------ 启动 */

(function init() {
  if (!window.AndroidApi || !AndroidApi.initial) {
    showMsg('#loginMsg', '请使用安装的 App 打开', true);
    return;
  }
  let d = {};
  try {
    const raw = AndroidApi.initial();
    d = (typeof raw === 'string' ? JSON.parse(raw) : raw).data || {};
  } catch (e) {}
  $('#account').value = d.account || '';
  $('#password').value = d.password || '';
  $('#remember').checked = !!d.remember;
  state.detail = !!d.detail;
  $('#detailSwitch').checked = state.detail;

  if (d.hasSession) {
    state.user = { name: d.userName };
    $('#hello').textContent = (d.userName || '同学') + '，你好';
    showView('home');
    loadHomeworks();
  } else {
    showView('login');
  }
})();
