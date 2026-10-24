/* 西柚答案排版器（桌面端 / Android 端共用）
 *
 * 输入：paper-parser.js 解析出的试卷模型
 *   { title, subtitle, groups:[ { name, enName, totalScore,
 *       parts:[ { name, items:[ { type, question, answers[], answerFromRef,
 *                                keys[], points[], refText, choices[], score } ] } ] } ] }
 *
 * 输出：
 *   简洁模式（默认）严格按用户指定格式：
 *     （试题标题）
 *     一、模仿朗读
 *     <第一条答案>
 *
 *     二、角色扮演
 *     三问：
 *     1. <第一条答案>
 *     2. ...
 *     3. ...
 *     五答：
 *     1. ...
 *     ...
 *     三、故事复述
 *     <第一条答案>
 *
 *   详细模式额外给出：题干、全部参考答案、关键词、得分要点、听力/朗读原文、选择题选项。
 */
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AnswerFormat = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];

  function stripHtml(s) {
    if (s === undefined || s === null) return '';
    var t = String(s);
    t = t.replace(/<br\s*\/?>/gi, '\n');
    t = t.replace(/<\/p>/gi, '\n');
    t = t.replace(/<\/blockquote>/gi, '\n');
    t = t.replace(/<[^>]+>/g, '');
    t = t
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    return t;
  }

  /** 合并空白、去首尾，保留换行结构 */
  function tidy(s) {
    var t = stripHtml(s);
    return t
      .split(/\r?\n/)
      .map(function (line) {
        return line.replace(/[\t\u00a0 ]+/g, ' ').trim();
      })
      .filter(function (line, i, arr) {
        return line !== '' || (i > 0 && arr[i - 1] !== '');
      })
      .join('\n')
      .trim();
  }

  /** 首段（用于朗读原文这种整段文本） */
  function firstParagraph(s) {
    var t = tidy(s);
    if (!t) return '';
    return t.split(/\n{2,}/)[0].trim();
  }

  /** 去掉答案开头可能带的中英序号，例如 "1." "1、" "①" */
  function dropIndexPrefix(s) {
    return String(s || '')
      .replace(/^\s*[（(]?\s*\d{1,2}\s*[.、)）:：]\s*/, '')
      .replace(/^\s*[①②③④⑤⑥⑦⑧⑨⑩]\s*/, '')
      .trim();
  }

  /** 一道题目的“第一项答案” */
  function firstAnswer(item) {
    if (!item) return '';
    var list = item.answers || [];
    for (var i = 0; i < list.length; i++) {
      var a = tidy(list[i]);
      if (a) return dropIndexPrefix(a);
    }
    if (item.answerFromRef && item.refText) return firstParagraph(item.refText);
    if (item.points && item.points.length) return dropIndexPrefix(tidy(item.points[0]));
    if (item.refText) return firstParagraph(item.refText);
    if (item.choices && item.choices.length) {
      for (var c = 0; c < item.choices.length; c++) {
        var opts = item.choices[c].options || [];
        for (var o = 0; o < opts.length; o++) {
          if (opts[o].correct) return tidy(opts[o].text);
        }
      }
    }
    return '';
  }

  function flattenItems(group) {
    var out = [];
    (group.parts || []).forEach(function (part) {
      (part.items || []).forEach(function (it) {
        out.push(it);
      });
    });
    return out;
  }

  /** 角色扮演：拆成三问 / 五答 */
  function splitRolePlay(items) {
    var ask = [];
    var answer = [];
    items.forEach(function (it) {
      var type = String(it.type || '');
      if (/翻译|提问|问句|translate/i.test(type)) ask.push(it);
      else if (/问答|回答|answer/i.test(type)) answer.push(it);
      else {
        // 未知类型：先按数量兜底
        ask.push(it);
      }
    });
    if ((!ask.length || !answer.length) && items.length) {
      ask = [];
      answer = [];
      if (items.length === 8) {
        ask = items.slice(0, 3);
        answer = items.slice(3);
      } else if (items.length === 3) {
        ask = items.slice(0);
      } else if (items.length === 5) {
        answer = items.slice(0);
      } else {
        var cut = Math.min(3, items.length);
        ask = items.slice(0, cut);
        answer = items.slice(cut);
      }
    }
    return { ask: ask, answer: answer };
  }

  function isRolePlay(group) {
    return /角色扮演|role\s*play/i.test(String(group.name || '') + ' ' + String(group.enName || ''));
  }

  function isReading(group) {
    return /模仿朗读|reading\s*aloud/i.test(String(group.name || '') + ' ' + String(group.enName || ''));
  }

  function isRetelling(group) {
    return /故事复述|retell/i.test(String(group.name || '') + ' ' + String(group.enName || ''));
  }

  function normTitle(paper) {
    var t = tidy((paper && paper.title) || '');
    if (!t) t = '未命名试题';
    return t;
  }

  /**
   * 构建可渲染结构。
   * opts.detail = true 时带上完整明细。
   */
  function build(paper, opts) {
    opts = opts || {};
    var detail = !!opts.detail;
    var groups = (paper && paper.groups) || [];
    var sections = [];

    groups.forEach(function (g, gi) {
      var items = flattenItems(g);
      var sec = {
        no: CN_NUM[gi] || String(gi + 1),
        name: tidy(g.name) || '试题',
        enName: g.enName || '',
        totalScore: g.totalScore,
        kind: 'plain',
        blocks: [],
        items: items,
      };

      if (isRolePlay(g) && items.length) {
        var split = splitRolePlay(items);
        sec.kind = 'roleplay';
        if (split.ask.length) sec.blocks.push({ label: '三问：', items: split.ask });
        if (split.answer.length) sec.blocks.push({ label: '五答：', items: split.answer });
        if (!sec.blocks.length) sec.blocks.push({ label: '', items: items });
      } else {
        var one = [];
        items.forEach(function (it) {
          one.push({ text: firstAnswer(it), item: it });
        });
        sec.blocks.push({ label: '', items: items, simple: one });
      }
      sections.push(sec);
    });

    return {
      title: normTitle(paper),
      subtitle: paper && paper.subtitle ? tidy(paper.subtitle) : '',
      capturedAt: (paper && paper.capturedAt) || Date.now(),
      detail: detail,
      sections: sections,
    };
  }

  function itemLabel(it, idx) {
    var type = tidy(it && it.type) || '作答';
    var score = it && it.score != null ? '（' + it.score + '分）' : '';
    return type + score;
  }

  /** 生成纯文本（复制 / 分享用），严格套用用户给的格式 */
  function toText(paper, opts) {
    opts = opts || {};
    var model = build(paper, opts);
    var out = [];
    out.push('（' + model.title + '）');

    model.sections.forEach(function (sec) {
      out.push('');
      out.push(sec.no + '、' + sec.name);
      if (sec.kind === 'roleplay') {
        sec.blocks.forEach(function (block) {
          if (block.label) out.push(block.label);
          block.items.forEach(function (it, i) {
            var ans = firstAnswer(it);
            out.push(i + 1 + '. ' + (ans || '（无答案）'));
            if (opts.detail) appendDetail(out, it);
          });
        });
      } else {
        sec.blocks.forEach(function (block) {
          block.items.forEach(function (it, i) {
            var ans = firstAnswer(it);
            if (sec.items.length === 1) {
              out.push(ans || '（无答案）');
            } else {
              out.push(i + 1 + '. ' + (ans || '（无答案）'));
            }
            if (opts.detail) appendDetail(out, it);
          });
        });
      }
    });
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  function appendDetail(out, it) {
    if (!it) return;
    if (it.question) out.push('   题干：' + tidy(it.question));
    var all = (it.answers || [])
      .map(function (a) {
        return tidy(a);
      })
      .filter(Boolean);
    if (all.length > 1) {
      out.push('   全部参考答案：');
      all.forEach(function (a, i) {
        out.push('     ' + (i + 1) + ') ' + a);
      });
    }
    if (it.keys && it.keys.length) out.push('   关键词：' + it.keys.map(tidy).filter(Boolean).join(' / '));
    if (it.points && it.points.length) out.push('   得分要点：\n     ' + it.points.map(tidy).filter(Boolean).join('\n     '));
    if (it.choices && it.choices.length) {
      it.choices.forEach(function (c) {
        if (c.text) out.push('   选择：' + tidy(c.text));
        (c.options || []).forEach(function (o, i) {
          if (o.correct) out.push('     ✔ ' + String.fromCharCode(65 + i) + '. ' + tidy(o.text));
        });
      });
    }
    if (it.refText && !it.answerFromRef) out.push('   听力/朗读原文：\n     ' + tidy(it.refText).replace(/\n/g, '\n     '));
  }

  return {
    build: build,
    toText: toText,
    firstAnswer: firstAnswer,
    stripHtml: stripHtml,
    tidy: tidy,
    firstParagraph: firstParagraph,
    itemLabel: itemLabel,
    isRolePlay: isRolePlay,
    isReading: isReading,
    isRetelling: isRetelling,
  };
});
