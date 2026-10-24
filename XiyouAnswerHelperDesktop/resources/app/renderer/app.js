'use strict';
const $ = (s) => document.querySelector(s);
let STATE = null;
let current = null;
let detailOn = localStorage.getItem('xy_detail') === '1';
let hwItems = [];
let hwMode = 'bags';

function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 1700);
}

/* ---------------- 渲染 ---------------- */

function headerHtml(paper) {
  return `<div class="paper-head">
    <div class="paper-title">${esc(paper.title)}</div>
    ${paper.subtitle ? `<div class="paper-sub">${esc(paper.subtitle)}</div>` : ''}
    <div class="paper-meta">
      <span class="tag acc">${paper.stats.answers} 道答案</span>
      <span class="tag blue">${paper.stats.groups} 个大题</span>
      <span class="tag">${esc(fmtTime(paper.capturedAt))}</span>
      <span class="tag">${esc(paper.source || '')}</span>
    </div>
  </div>`;
}

/** 简洁模式：严格按「试题标题 + 一、模仿朗读 / 二、角色扮演 三问 五答 / 三、故事复述」输出 */
function renderSimple(paper) {
  const model = AnswerFormat.build(paper, { detail: false });
  let html = headerHtml(paper);
  for (const sec of model.sections) {
    html += `<div class="simple-sec">
      <div class="simple-title">${esc(sec.no)}、${esc(sec.name)}</div>`;
    if (sec.kind === 'roleplay') {
      for (const block of sec.blocks) {
        if (block.label) html += `<div class="simple-label">${esc(block.label)}</div>`;
        block.items.forEach((it, i) => {
          const ans = AnswerFormat.firstAnswer(it);
          html += `<div class="simple-ans"><span class="sn">${i + 1}.</span><span class="st">${esc(ans || '（无答案）')}</span></div>`;
        });
      }
    } else {
      const items = (sec.blocks[0] && sec.blocks[0].items) || [];
      items.forEach((it, i) => {
        const ans = AnswerFormat.firstAnswer(it);
        if (items.length === 1) {
          html += `<div class="simple-text">${esc(ans || '（无答案）')}</div>`;
        } else {
          html += `<div class="simple-ans"><span class="sn">${i + 1}.</span><span class="st">${esc(ans || '（无答案）')}</span></div>`;
        }
      });
    }
    html += `</div>`;
  }
  return html;
}

/** 详细模式：保留原有完整结构 */
function renderDetailed(paper) {
  let html = headerHtml(paper);
  let n = 0;
  for (const g of paper.groups) {
    html += `<div class="group">
      <div class="group-head">
        <span class="group-name">${esc(g.name)}</span>
        ${g.enName ? `<span class="group-en">${esc(g.enName)}</span>` : ''}
        <span class="group-score">${g.totalScore != null ? g.totalScore + ' 分' : ''}</span>
      </div>`;
    for (const part of g.parts) {
      html += `<div class="part">`;
      html += `<div class="part-name">${esc(part.name)}${part.score != null ? ` · ${part.score} 分` : ''}</div>`;
      for (const b of part.briefs || []) html += `<div class="brief">${esc(b)}</div>`;
      if (part.media && part.media.video) {
        html += `<div class="media">📹 视频素材：${esc(part.media.video)}</div>`;
      }
      for (const it of part.items || []) {
        n++;
        html += `<div class="item">
          <div class="item-head">
            <span class="idx">${n}</span>
            <span class="type">${esc(it.type)}</span>
            ${it.score != null ? `<span class="score">${it.score} 分</span>` : ''}
          </div>`;
        if (it.question) html += `<div class="q">${esc(it.question)}</div>`;

        if (it.choices && it.choices.length) {
          for (const c of it.choices) {
            html += `<div class="choice">`;
            if (c.text) html += `<div class="choice-q">${esc(c.text)}</div>`;
            html += `<div class="opts">`;
            c.options.forEach((o, oi) => {
              const cls = o.correct ? 'opt right' : o.chosen ? 'opt chosen' : 'opt';
              html += `<div class="${cls}">
                <span class="ol">${String.fromCharCode(65 + oi)}</span>
                <span class="ot">${esc(o.text)}</span>
                ${o.correct ? '<span class="mk">✔</span>' : o.chosen ? '<span class="mk bad">✘</span>' : ''}
              </div>`;
            });
            html += `</div></div>`;
          }
        }

        if (it.answers && it.answers.length) {
          html += `<div class="sec-label">${it.answerFromRef ? '朗读原文 / 参考答案' : '参考答案'}</div><ul class="answers">`;
          it.answers.forEach((a, i) => {
            html += `<li class="${i === 0 ? 'best' : ''}" data-i="${i + 1}">${esc(a)}</li>`;
          });
          html += `</ul>`;
        }

        if (it.points && it.points.length) {
          html += `<div class="sec-label">得分要点</div><div class="chips">`;
          for (const p of it.points) html += `<span class="chip warm">${esc(p)}</span>`;
          html += `</div>`;
        }
        if (it.keys && it.keys.length) {
          html += `<div class="sec-label">关键词 / 判分要点</div><div class="chips">`;
          for (const k of it.keys) html += `<span class="chip">${esc(k)}</span>`;
          html += `</div>`;
        }
        if (it.refText && !it.answerFromRef) {
          html += `<details class="ref"><summary>展开听力 / 朗读原文</summary><div class="ref-body">${esc(it.refText)}</div></details>`;
        }
        html += `</div>`;
      }
      html += `</div>`;
    }
    html += `</div>`;
  }
  return html;
}

function render() {
  const content = $('#content');
  const paper = current;
  if (!paper || !paper.groups || paper.groups.length === 0) {
    content.innerHTML = `
      <div class="empty">
        <div class="big">📄</div>
        <div>还没有捕获到试题</div>
        <div style="font-size:12px;margin-top:8px">
          点上方 <kbd>账号</kbd> 登录可直接在线取答案；<br>
          或在「西柚英语个人版」中进入 <kbd>班级</kbd> → <kbd>作业</kbd> → <kbd>去完成</kbd> → <kbd>开始答题</kbd>
        </div>
      </div>`;
    return;
  }
  content.innerHTML = detailOn ? renderDetailed(paper) : renderSimple(paper);
}

/* ---------------- 复制 ---------------- */

function paperToText(p) {
  if (!p) return '';
  try {
    return AnswerFormat.toText(p, { detail: detailOn });
  } catch (e) {
    return '';
  }
}

/* ---------------- 状态同步 ---------------- */

function applyState(s) {
  STATE = s;
  const sel = $('#paperSelect');
  const keep = sel.value;
  sel.innerHTML =
    (s.papers || [])
      .map((p) => `<option value="${esc(p.id)}">${esc(p.title)}（${p.answers}答案 · ${esc(fmtTime(p.capturedAt))}）</option>`)
      .join('') || '<option value="">（暂无历史）</option>';
  const curId = s.paper ? s.paper.id : '';
  sel.value = curId || keep;

  current = s.paper || null;
  render();

  $('#status').textContent = s.status || '';
  $('#liveDot').classList.toggle('on', !!s.live);
  $('#liveDot').title = s.live ? '已连接客户端实时通道' : '仅文件监控（客户端未开调试端口）';
  $('#btnTop').classList.toggle('on', !!s.topMost);
  const bp = $('#btnPass');
  bp.style.color = s.clickThrough ? 'var(--acc)' : '';
  bp.style.borderColor = s.clickThrough ? 'var(--acc)' : '';
  bp.textContent = s.clickThrough ? '穿透中' : '穿透';
  bp.title =
    '智能穿透：开启后鼠标可点到下面的客户端；把鼠标移到本窗口顶部条即可点回此按钮。快捷键 Ctrl+Alt+X' +
    (s.hotkeys ? '（已注册：' + s.hotkeys + '）' : '');
  if (s.fontSize) document.documentElement.style.setProperty('--fs', s.fontSize + 'px');
}

/* ---------------- 在线账号 / 作业 ---------------- */

function showModal(which) {
  $('#modalMask').classList.remove('hidden');
  $('#loginModal').classList.toggle('hidden', which !== 'login');
  $('#hwModal').classList.toggle('hidden', which !== 'hw');
}
function hideModal() {
  $('#modalMask').classList.add('hidden');
}

async function openLogin() {
  try {
    const a = await window.helper.apiAccount();
    $('#accInput').value = a.account || '';
    $('#pwdInput').value = a.password || '';
    $('#loginMsg').textContent = a.hasSession
      ? '当前已登录：' + (a.userName || '账号') + (a.schoolName ? '（' + a.schoolName + '）' : '')
      : '';
    if (a.hasSession) {
      openHomework();
    } else {
      showModal('login');
      setTimeout(() => $('#accInput').focus(), 60);
    }
  } catch (e) {
    showModal('login');
  }
}

async function doLogin() {
  const account = $('#accInput').value.trim();
  const password = $('#pwdInput').value;
  if (!account || !password) {
    $('#loginMsg').textContent = '账号和密码都要填';
    return;
  }
  const btn = $('#loginGo');
  btn.disabled = true;
  btn.textContent = '登录中…';
  $('#loginMsg').textContent = '';
  try {
    const r = await window.helper.apiLogin({ account, password, remember: $('#rememberChk').checked });
    if (!r.ok) {
      $('#loginMsg').textContent = r.error || '登录失败';
      const list = r.accounts || [];
      if (list.length) {
        $('#loginMsg').textContent += '（该手机号下账号：' + list.map((x) => x.realName || x.loginAccount).join('、') + '）';
      }
      return;
    }
    toast('登录成功');
    openHomework();
  } catch (e) {
    $('#loginMsg').textContent = e.message || '登录失败';
  } finally {
    btn.disabled = false;
    btn.textContent = '登录';
  }
}

async function openHomework() {
  showModal('hw');
  hwMode = 'bags';
  hwItems = [];
  $('#hwTitle').textContent = '选择作业';
  $('#hwBack').classList.add('hidden');
  $('#hwList').innerHTML = '';
  $('#hwMsg').textContent = '正在获取作业列表…';
  try {
    const r = await window.helper.apiHomeworks();
    if (!r.ok) {
      $('#hwMsg').textContent = r.error || '获取作业失败';
      return;
    }
    hwItems = r.items || [];
    $('#hwMsg').textContent = hwItems.length ? '' : '没有找到作业，换个时间或点「刷新」试试';
    renderHw();
  } catch (e) {
    $('#hwMsg').textContent = e.message || '获取作业失败';
  }
}

function statusText(it) {
  const st = String(it.status === undefined || it.status === null ? '' : it.status);
  const map = {
    0: ['待完成', 'todo'],
    1: ['已完成', 'done'],
    2: ['已过期', ''],
    3: ['已过期', ''],
    6: ['未开始', ''],
    7: ['进行中', 'todo'],
    8: ['不可重做', 'done'],
    10: ['已完成', 'done'],
  };
  if (map[st]) return map[st];
  if (it.score !== undefined && it.score !== null && it.totalScore) {
    return [it.score + '/' + it.totalScore + ' 分', 'done'];
  }
  return ['', ''];
}

function renderHw() {
  const box = $('#hwList');
  if (!hwItems.length) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = hwItems
    .map((it, i) => {
      const st = statusText(it);
      const meta = [];
      if (it.sub) meta.push(`<span>${esc(it.sub)}</span>`);
      if (st[0]) meta.push(`<span class="hw-tag ${st[1]}">${esc(st[0])}</span>`);
      if (it.deadline) meta.push(`<span>截止 ${esc(String(it.deadline).slice(5, 16))}</span>`);
      return `<div class="hw" data-i="${i}">
        <div class="hw-ico">${hwMode === 'bags' ? '📦' : '📝'}</div>
        <div class="hw-main">
          <div class="hw-name">${esc(it.name)}</div>
          ${meta.length ? `<div class="hw-meta">${meta.join('')}</div>` : ''}
        </div>
        <div class="hw-arrow">›</div>
      </div>`;
    })
    .join('');
  Array.from(box.children).forEach((el) => {
    el.addEventListener('click', () => onHwClick(hwItems[Number(el.dataset.i)]));
  });
}

async function onHwClick(it) {
  if (!it) return;
  if (it.paperGroupId) {
    $('#hwMsg').textContent = '正在获取试题答案…';
    try {
      const r = await window.helper.apiPaper(it.paperGroupId);
      if (!r.ok) {
        $('#hwMsg').textContent = r.error || '取答案失败';
        return;
      }
      hideModal();
      toast('已获取 ' + (r.answers || '') + ' 条答案');
    } catch (e) {
      $('#hwMsg').textContent = e.message || '取答案失败';
    }
    return;
  }
  if (hwMode === 'bags' && it.id) {
    $('#hwMsg').textContent = '正在打开作业…';
    try {
      const r = await window.helper.apiBagItems(it.id);
      if (!r.ok) {
        $('#hwMsg').textContent = r.error || '打开失败';
        return;
      }
      hwItems = r.items || [];
      hwMode = 'items';
      $('#hwTitle').textContent = it.name;
      $('#hwBack').classList.remove('hidden');
      $('#hwMsg').textContent = hwItems.length ? '' : '这个作业里没有内容';
      renderHw();
    } catch (e) {
      $('#hwMsg').textContent = e.message || '打开失败';
    }
    return;
  }
  $('#hwMsg').textContent = '这条作业没有可用的试卷 ID';
}

/* ---------------- 事件 ---------------- */

$('#btnRefresh').onclick = async () => {
  toast('重新扫描…');
  await window.helper.refresh();
  setTimeout(async () => applyState(await window.helper.getState()), 300);
};
$('#btnTop').onclick = () => window.helper.toggleTop();
$('#btnMin').onclick = () => window.helper.min();
$('#btnClose').onclick = () => window.helper.close();
$('#btnCopyAll').onclick = async () => {
  if (!current) return toast('暂无内容');
  await window.helper.copy(paperToText(current));
  toast('已复制全部答案');
};
$('#btnFontUp').onclick = async () => {
  const v = (STATE.fontSize || 14) + 1;
  await window.helper.setFont(v);
  document.documentElement.style.setProperty('--fs', v + 'px');
};
$('#btnFontDown').onclick = async () => {
  const v = (STATE.fontSize || 14) - 1;
  await window.helper.setFont(v);
  document.documentElement.style.setProperty('--fs', v + 'px');
};
$('#opacity').oninput = (e) => window.helper.setOpacity(Number(e.target.value) / 100);
$('#paperSelect').onchange = (e) => window.helper.selectPaper(e.target.value);

$('#detailChk').checked = detailOn;
$('#detailChk').onchange = (e) => {
  detailOn = e.target.checked;
  localStorage.setItem('xy_detail', detailOn ? '1' : '0');
  render();
};

$('#btnAccount').onclick = openLogin;
$('#loginGo').onclick = doLogin;
$('#loginClose').onclick = hideModal;
$('#hwClose').onclick = hideModal;
$('#hwRefresh').onclick = openHomework;
$('#hwBack').onclick = openHomework;
$('#hwLogout').onclick = async () => {
  await window.helper.apiLogout();
  hideModal();
  toast('已退出登录');
};
$('#pwdInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doLogin();
});
$('#modalMask').addEventListener('click', (e) => {
  if (e.target === $('#modalMask')) hideModal();
});

$('#btnLaunch').onclick = async () => {
  toast('正在启动西柚英语客户端…');
  const ok = await window.helper.launchClient();
  toast(ok ? '已启动（带调试端口）' : '未找到客户端 exe');
};
$('#btnDir').onclick = () => window.helper.openDir(STATE && STATE.dataDir);
$('#btnPass').onclick = async () => {
  const on = await window.helper.togglePass();
  toast(on ? '已开启智能穿透：鼠标移到顶部即可点按钮，Ctrl+Alt+X 也可切换' : '已关闭穿透');
  if (STATE) STATE.clickThrough = on;
};

// 智能穿透：鼠标在顶部工具条区域内时临时恢复可点击
let lastHover = null;
document.addEventListener(
  'mousemove',
  (e) => {
    if (!STATE || !STATE.clickThrough) return;
    const bar = document.getElementById('statusbar');
    const bottom = bar ? bar.getBoundingClientRect().bottom : 110;
    const interactive = e.clientY <= bottom + 4;
    if (interactive !== lastHover) {
      lastHover = interactive;
      window.helper.passHover(interactive);
    }
  },
  true,
);
document.addEventListener('mouseleave', () => {
  if (!STATE || !STATE.clickThrough) return;
  lastHover = false;
  window.helper.passHover(false);
});

// 点击某条答案复制该条
document.addEventListener('click', async (e) => {
  const li = e.target.closest('.answers li');
  if (li) {
    await window.helper.copy(li.textContent.replace(/^\d+/, '').trim());
    toast('已复制该条答案');
    return;
  }
  const st = e.target.closest('.simple-ans .st, .simple-text');
  if (st) {
    await window.helper.copy(st.textContent.trim());
    toast('已复制该条答案');
  }
});

window.helper.onState(applyState);
(async () => applyState(await window.helper.getState()))();
