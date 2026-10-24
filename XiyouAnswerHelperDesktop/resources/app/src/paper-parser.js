// 试题 / 答案解析器
// 输入：sessionStorage['vuex'] -> params.paperGroupList（大题数组）
// 输出：统一的试卷模型，供 UI 渲染
'use strict';

const PROC_TYPE = { 1: '播放题干', 2: '播放原文', 3: '等待时间', 4: '录音作答', 5: '播放视频' };

/** 去掉 HTML 标签、blockquote 包裹 */
function stripHtml(s) {
  if (s === undefined || s === null) return '';
  let t = String(s);
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<\/p>/gi, '\n');
  t = t.replace(/<[^>]+>/g, '');
  t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return t.trim();
}

/** 按行拆分，去空、去重（保留顺序） */
function toLines(s) {
  const t = stripHtml(s);
  if (!t) return [];
  const seen = new Set();
  const out = [];
  for (const raw of t.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

/** 解析单个「录音作答」步骤 -> 一道题 */
function parseAnswerStep(step) {
  // 本地缓存里是 oralTypeModel，在线接口 /paper/module/detail 里是 oralType
  const om = step.oralTypeModel || step.oralType || {};
  let answers = toLines(om.answerTxt);
  const keys = toLines(om.key);
  const points = toLines(om.points);
  const refText = stripHtml(om.refText);
  const question = stripHtml(om.questionText || (step.infoData && step.infoData.content) || '');
  // 选择题：showType 3/4 时答案在 choiceList[].optionsTypeList[].answer
  const choices = [];
  if (Array.isArray(om.choiceList)) {
    for (const c of om.choiceList) {
      const opts = (c.optionsTypeList || []).map((o) => ({
        text: stripHtml(o.text),
        correct: !!o.answer,
        chosen: !!o.isChoice,
        fileUrl: o.fileUrl || '',
      }));
      if (!opts.length) continue;
      choices.push({ text: stripHtml(c.text), options: opts, done: !!c.isDone });
    }
    // 把正确选项并入参考答案，便于复制
    for (const c of choices) {
      const right = c.options.filter((o) => o.correct).map((o) => o.text).filter(Boolean);
      for (const r of right) if (!answers.includes(r)) answers.push(r);
    }
  }
  // 模仿朗读 / 段落朗读：没有 answerTxt，朗读原文本身就是答案
  let answerFromRef = false;
  if (answers.length === 0 && keys.length === 0 && points.length === 0 && refText) {
    answers = toLines(refText);
    answerFromRef = true;
  }
  return {
    seq: step.seq,
    processTypeId: step.processTypeId,
    type: om.name || PROC_TYPE[step.processTypeId] || '作答',
    score: typeof om.score === 'number' ? om.score : null,
    question,
    answers,
    answerFromRef,
    keys,
    points,
    refText,
    choices,
    hasAnswer:
      answers.length > 0 || keys.length > 0 || points.length > 0 || !!refText || choices.some((c) => c.options.some((o) => o.correct)),
  };
}

/** 解析一份 paperGroupList -> 试卷模型 */
function parsePaper(groupList, meta = {}) {
  const groups = [];
  let answerCount = 0;

  for (const g of groupList || []) {
    const parts = [];
    for (const small of g.smallList || []) {
      const items = [];
      const briefs = []; // 题干说明 / 素材
      const media = { video: '', audio: [] };

      for (const step of small.processList || []) {
        const info = step.infoData || {};
        const om0 = step.oralTypeModel || step.oralType;
        if (step.processTypeId === 4 || (om0 && (om0.answerTxt || om0.points || om0.key))) {
          const it = parseAnswerStep(step);
          if (it.hasAnswer) {
            items.push(it);
            answerCount++;
          }
          continue;
        }
        if (step.processTypeId === 5 && info.audioURL) {
          media.video = info.audioURL;
        } else if (info.audioURL) {
          media.audio.push(info.audioURL);
        }
        const c = stripHtml(info.content);
        if (c && c.length > 2) briefs.push(c);
      }

      parts.push({
        name: stripHtml(small.name),
        score: small.score,
        briefs: [...new Set(briefs)],
        items,
        media,
      });
    }

    let enName = g.enName || '';
    groups.push({
      name: stripHtml(g.name),
      enName,
      totalScore: g.totalScore,
      questionsName: stripHtml(g.questionsName),
      parts,
    });
  }

  return {
    id: meta.id || paperIdOf(groupList),
    title: meta.title || titleOf(groupList),
    subtitle: meta.subtitle || '',
    capturedAt: meta.capturedAt || Date.now(),
    source: meta.source || 'storage',
    groups,
    stats: {
      groups: groups.length,
      parts: groups.reduce((n, g) => n + g.parts.length, 0),
      answers: answerCount,
    },
  };
}

function titleOf(groupList) {
  // 各小题名形如「突破高中英语听说基础版模拟试题02_模仿朗读」，取公共前缀作为试卷名
  const names = (groupList || []).map((g) => stripHtml(g.questionsName)).filter(Boolean);
  if (names.length) {
    let prefix = names[0];
    for (const n of names) {
      let i = 0;
      while (i < prefix.length && i < n.length && prefix[i] === n[i]) i++;
      prefix = prefix.slice(0, i);
    }
    prefix = prefix.replace(/[_\-\s·]+$/, '');
    // 只有一道大题时，公共前缀里会带上「_模仿朗读」这类题型后缀，去掉它
    prefix = prefix
      .replace(/[_\-\s·]+(模仿朗读|角色扮演|故事复述|Reading Aloud|Role Play|Retelling)\s*$/i, '')
      .trim();
    if (prefix.length >= 3) return prefix;
    return names[0];
  }
  for (const g of groupList || []) {
    if (g.name) return stripHtml(g.name);
  }
  return '未命名试题';
}

function paperIdOf(groupList) {
  const ids = (groupList || []).map((g) => g.id).filter(Boolean);
  if (ids.length) return ids.join('_');
  return 'paper_' + titleOf(groupList).slice(0, 40);
}

module.exports = { parsePaper, stripHtml, toLines, titleOf, paperIdOf, PROC_TYPE };
