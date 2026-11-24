/*
 * 视频播放助手 · 自动答题（章节测验 / 作业，考试只填不交）
 *
 * 工作方式：
 *   1. 只在学习通答题页出现（或手动加 ?vanqa=1），不会打扰看视频。
 *   2. 扫描页面上的题目（题干、题型、选项），交给后台 background 取答案。
 *   3. 把答案填进页面（单选/多选点选项，填空/简答写文本框）。
 *   4. 可选自动提交：只在“作业/章节测验”里生效，考试页永远不自动交卷。
 *
 * 所有网络请求都在后台 service worker 里发，避开页面的 CORS/CSP。
 */
(function () {
  'use strict';

  var C = globalThis.VAN_CONST || {};
  var Q = globalThis.VAN_QA;
  var P = globalThis.VAN_PURE || {};
  var GUARD = '__VAN_ANSWER__';
  if (globalThis[GUARD] || !Q) return;
  globalThis[GUARD] = true;

  /* ------------------------------------------------------------------ *
   * 常量
   * ------------------------------------------------------------------ */

  var T = {
    ASK: 'vanqa:ask',
    STATUS: 'vanqa:status',
    START: 'vanqa:start',
    STOP: 'vanqa:stop',
    SUBMIT: 'vanqa:submit',
    SCAN: 'vanqa:scan'
  };

  /** 题目容器的候选选择器，按优先级尝试（不同版本学习通结构不一样）。 */
  var Q_SELECTORS = [
    '.questionLi',            // 作业页
    '.TiMu',                  // 测验/考试页
    '.questionBox',
    '.singleQuesId',
    '.q_item',
    '[data-questionid]'
  ];

  var STEM_SELECTORS = [
    '.mark_name',
    '.Zy_TItle',
    '.stem',
    '.timu',
    '.questionContent',
    '.Cy_TItle',
    '.content'
  ];

  var TYPE_SELECTORS = [
    '.newZy_TItle',
    '.Zy_TItle .fl',
    '.colorShallow',
    '.questionType',
    '.type'
  ];

  /**
   * 视频弹题（播放器里弹出来的小题）是另一套 DOM：
   * 没有 input[type=radio]，选项就是可点的 li / div，提交按钮也是普通元素。
   * 这里按学习通几个常见版本的类名先抓，抓不到再用通用兜底。
   */
  var VQ_BOX_SELECTORS = [
    '.ans-videoquiz-box',
    '.ans-videoquiz',
    '.ans-videosquiz-box',
    '.videoquiz-box',
    '.videoquiz',
    '#videoquiz'
  ];

  var VQ_OPT_SELECTORS = [
    '.ans-videoquiz-opt li',
    '.ans-videoquiz-opt-item',
    '.ans-videoquiz-option',
    '.ans-videoquiz-opt > div',
    '.ans-videosquiz-opt li',
    '.videoquiz-opt li',
    '.videoquiz-option',
    '.videoquiz-opt > div',
    '.topic-answer li'
  ];

  var VQ_STEM_SELECTORS = [
    '.ans-videoquiz-question',
    '.ans-videoquiz-tit',
    '.ans-videoquiz-title',
    '.videoquiz-question',
    '.videoquiz-title'
  ];

  var VQ_SUBMIT_SELECTORS = [
    '.ans-videoquiz-submit',
    '.ans-videosquiz-submit',
    '.ans-videoquiz-btn',
    '.videoquiz-submit',
    '.videoquiz-btn'
  ];

  // 弹题答错后最多换几种答案（单选/判断就是选项数；多选组合更多，也控制在 8 次）
  var VQ_MAX_TRIES = 8;

  var KIND_LABEL = {
    exam: '考试',
    work: '作业 / 章节测验',
    video: '视频页',
    videoquiz: '视频弹题',
    unknown: '课程页面'
  };

  /* ------------------------------------------------------------------ *
   * 状态
   * ------------------------------------------------------------------ */

  var S = {
    settings: { qaEnabled: false, qaAutoRun: true, qaAutoSubmit: true, qaAutoNext: true, showHud: true },
    cfg: null,
    running: false,
    aborted: false,
    questions: [],
    filled: 0,
    pageKind: 'unknown',
    host: null,
    shadow: null,
    logEl: null,
    badgeEl: null,
    kindEl: null,
    countEl: null,
    minimized: false,
    observer: null,
    scanTimer: 0,
    autoTimer: 0,
    everStarted: false,
    // 弹题重试：答错后记住试过的答案，换下一个再交；试满 VQ_MAX_TRIES 次才停手
    vqTries: Object.create(null),
    vqWrong: Object.create(null),
    vqTried: Object.create(null),
    vqFillTries: Object.create(null),
    vqSubmitting: false,
    vqLastSubmitAt: 0,
    confirmWatching: false,
    confirmBusy: false,
    confirmHinted: false,
    confirmSkipped: false,
    // 子页面在 iframe 里交卷时，会在外层弹确认框；外层记一笔，用来判断该不该点
    childSubmit: null,
    nextSentAt: 0,
    lastSubmitAt: 0,
    submitScheduledAt: 0,
    // 刚点过“提交”的时间（写进 storage.local，所有 frame 都能看到）。
    // 有了它，确认框弹在哪个 frame 都不用再靠“猜这一层是不是答题层”。
    confirmAt: 0
  };

  /* ------------------------------------------------------------------ *
   * 基础工具
   * ------------------------------------------------------------------ */

  function isTop() {
    try { return window.top === window; } catch (e) { return false; }
  }

  function onChaoxing() {
    var h = location.hostname || '';
    return /(^|\.)chaoxing\.com$/i.test(h) || /(^|\.)chaoxing\.com\./i.test(h);
  }

  function forceOn() {
    return /[?&]vanqa=1(&|$)/.test(location.search);
  }

  function pageKind() {
    var u = location.href;
    if (/\/exam[-/]/i.test(u) || /exam-ans/i.test(u) || /\/exam\b/i.test(u)) return 'exam';
    if (/doHomeWorkNew|\/work\//i.test(u) || /homework/i.test(u)) return 'work';
    if (/\/knowledge\/|ananas\/modules\/video/i.test(u)) return 'video';
    var title = document.title || '';
    if (/考试/.test(title) && !/作业/.test(title)) return 'exam';
    if (/作业|测验|测试/.test(title)) return 'work';
    return 'unknown';
  }

  function textOf(el) {
    return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }

  function log(msg) {
    if (S.logEl) {
      var line = document.createElement('div');
      line.className = 'line';
      var time = new Date();
      line.textContent = ('0' + time.getHours()).slice(-2) + ':' + ('0' + time.getMinutes()).slice(-2) + ' ' + msg;
      S.logEl.appendChild(line);
      while (S.logEl.childNodes.length > 40) S.logEl.removeChild(S.logEl.firstChild);
      S.logEl.scrollTop = S.logEl.scrollHeight;
    } else if (window.console && console.log) {
      // 没有面板的 frame（比如只负责弹确认框的外层）也留个痕迹，方便排查
      console.log('[van-qa] ' + msg);
    }
  }

  /** 给外层发消息：直属父页面和最外层都发一份。
      题目有时嵌在两层 iframe 里，确认框可能挂在中间那层。 */
  function postUp(msg) {
    try {
      if (window.parent && window.parent !== window) window.parent.postMessage(msg, '*');
    } catch (e) { /* ignore */ }
    try {
      if (window.top && window.top !== window && window.top !== window.parent) window.top.postMessage(msg, '*');
    } catch (e) { /* ignore */ }
  }

  function setStatus(state, msg) {
    if (!S.shadow) return;
    var dot = S.shadow.querySelector('.dot');
    if (dot) {
      dot.className = 'dot ' + state;
      dot.title = msg || state;
    }
  }

  function updateMeta() {
    if (S.countEl) S.countEl.textContent = S.questions.length + ' 题 · 已填 ' + S.filled;
    if (S.kindEl) S.kindEl.textContent = KIND_LABEL[S.pageKind] || S.pageKind;
    if (S.badgeEl) S.badgeEl.textContent = String(S.questions.length);
  }

  /* ------------------------------------------------------------------ *
   * 扫题
   * ------------------------------------------------------------------ */

  function pickContainers() {
    for (var i = 0; i < Q_SELECTORS.length; i++) {
      var list = [];
      var nodes = document.querySelectorAll(Q_SELECTORS[i]);
      for (var j = 0; j < nodes.length; j++) {
        var el = nodes[j];
        if (!el.querySelector('input[type=radio],input[type=checkbox],input[type=text],textarea')) continue;
        // 只要最外层，避免父子重复
        var dup = false;
        for (var k = 0; k < list.length; k++) {
          if (list[k].contains(el)) { dup = true; break; }
          if (el.contains(list[k])) list.splice(k, 1);
        }
        if (!dup) list.push(el);
      }
      if (list.length) return list;
    }
    return [];
  }

  function stemOf(el) {
    // 页面里“1.（单选题, 2.0分）”这类小标签和真正的题干常常是两个节点，
    // 所以把候选都清洗一遍，取信息量最大的那个，而不是取第一个命中。
    var best = '';
    for (var i = 0; i < STEM_SELECTORS.length; i++) {
      var node = el.querySelector(STEM_SELECTORS[i]);
      if (!node) continue;
      var t = Q.cleanStem(textOf(node));
      if (/^[\d\s.、．，,（）()]+$/.test(t)) continue; // 只有编号的节点不要
      if (t.length > best.length) best = t;
    }
    if (best.length > 2) return best;
    // 兜底：克隆一份，去掉选项和输入框，取前 300 字
    try {
      var clone = el.cloneNode(true);
      var junk = clone.querySelectorAll('ul,ol,label,input,textarea,.answerList,.Zy_ulTop');
      for (var j = 0; j < junk.length; j++) junk[j].parentNode && junk[j].parentNode.removeChild(junk[j]);
      return Q.cleanStem(textOf(clone).slice(0, 300));
    } catch (e) {
      return Q.cleanStem(textOf(el).slice(0, 300));
    }
  }

  function labelFor(input) {
    if (input.id) {
      try {
        var sel = 'label[for="' + (window.CSS && CSS.escape ? CSS.escape(input.id) : input.id) + '"]';
        var byFor = document.querySelector(sel);
        if (byFor && textOf(byFor)) return byFor;
      } catch (e) { /* id 里有特殊字符就跳过，走后面的兜底 */ }
    }
    var p = input.parentNode;
    var guard = 0;
    while (p && guard++ < 4) {
      if (p.tagName === 'LABEL') return p;
      p = p.parentNode;
    }
    var next = input.nextElementSibling;
    if (next && next.tagName === 'LABEL') return next;
    return null;
  }

  function optionLabelText(input, label, index) {
    var raw = '';
    if (label) raw = textOf(label);
    if (!raw) {
      var li = input.closest ? input.closest('li') : null;
      if (li) raw = textOf(li);
    }
    if (!raw) raw = String(input.value || '');
    return Q.cleanOptionText(raw, String.fromCharCode(65 + index));
  }

  function collectOptions(el) {
    var inputs = el.querySelectorAll('input[type=radio],input[type=checkbox]');
    var out = [];
    for (var i = 0; i < inputs.length; i++) {
      var input = inputs[i];
      if (input.disabled) continue;
      var label = labelFor(input);
      var key = String(input.value || '');
      if (!/^[A-Za-z]$/.test(key)) key = String.fromCharCode(65 + out.length);
      key = key.toUpperCase();
      out.push({
        key: key,
        text: optionLabelText(input, label, out.length),
        input: input,
        label: label,
        li: input.closest ? input.closest('li') : null
      });
    }
    return out;
  }

  function collectTextInputs(el, options) {
    var out = [];
    var nodes = el.querySelectorAll('textarea, input[type=text]');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.disabled || n.readOnly) continue;
      // 跳过选项区的输入框
      var inOption = false;
      for (var j = 0; j < options.length; j++) {
        if (options[j].input === n || (options[j].label && options[j].label.contains(n))) { inOption = true; break; }
      }
      if (inOption) continue;
      out.push(n);
    }
    return out;
  }

  function typeHintOf(el) {
    for (var i = 0; i < TYPE_SELECTORS.length; i++) {
      var node = el.querySelector(TYPE_SELECTORS[i]);
      if (node) {
        var t = textOf(node);
        if (t && t.length < 40) return t;
      }
    }
    var attr = el.getAttribute && (el.getAttribute('data-type') || el.getAttribute('data-qtype'));
    if (attr) return String(attr);
    return '';
  }

  /* ------------------ 新版测验（无 input 的通用解析） ------------------ *
   * 学习通新版把题目渲染成一堆 div：题干写成“2【多选题】…”，
   * 选项是“A  红色传递…”这样的一行行，没有 input。
   * 这里不猜类名，只用文本结构找题干、找选项行。
   */

  var QMARK_RE = /【(单选题|多选题|判断题|填空题|简答题|论述题)】/g;

  function typeMarkCount(el) {
    if (!el || !el.textContent) return 0;
    var m = el.textContent.match(QMARK_RE);
    return m ? m.length : 0;
  }

  function isOptionRow(el) {
    if (!el || el.children.length > 3) return false;
    var t = textOf(el);
    if (t.length < 2 || t.length > 220) return false;
    var m = /^([A-H])\s*[、.．:：)）]?\s*([\u4e00-\u9fa5A-Za-z0-9（(][\s\S]*)$/.exec(t);
    if (!m) return false;
    // 子节点里已经有选项行的，说明自己是包着一排选项的容器，跳过
    for (var i = 0; i < el.children.length; i++) {
      var c = el.children[i];
      if (c.children.length <= 3 && /^([A-H])\s*[、.．:：)）]?\s*[\u4e00-\u9fa5A-Za-z0-9（(]/.test(textOf(c))) return false;
    }
    return true;
  }

  function genericOptionRows(box) {
    var nodes = box.querySelectorAll('div,li,p,label,span,a');
    var rows = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!isOptionRow(el)) continue;
      var t = textOf(el);
      var m = /^([A-H])\s*[、.．:：)）]?\s*([\u4e00-\u9fa5A-Za-z0-9（(][\s\S]*)$/.exec(t);
      var key = m[1].toUpperCase();
      var dup = false;
      for (var j = 0; j < rows.length; j++) if (rows[j].key === key) { dup = true; break; }
      if (dup) continue;
      rows.push({
        key: key,
        text: Q.cleanOptionText(t, key),
        el: el,
        singleClick: true   // 新版页面点一下就是选中/取消，不能补第二下
      });
    }
    rows.sort(function (a, b) { return a.key < b.key ? -1 : 1; });
    return rows;
  }

  /* 有些题型的选项字母画在圆圈里（伪元素/背景图），DOM 文本只有选项内容本身，
   * 比如“实验室最常用的一种纯水”。这时按“同一排、同样宽的几个块”来认选项，
   * 顺序就是 A、B、C…；只用来兜底，要求这一排里没有别的题干、宽度也比较整齐。 */
  function looseOptionRows(box, stemEl) {
    var noText = /^(提交|保存|暂存|解析|答案|我的答案|正确答案|查看|收起|展开|答题卡)/;
    var lists = box.querySelectorAll('ul,ol,div,dl');
    for (var l = 0; l < lists.length; l++) {
      var L = lists[l];
      if (L.contains(stemEl)) continue;
      if (L.children.length < 2 || L.children.length > 8) continue;
      var kids = [];
      var ok = true;
      for (var i = 0; i < L.children.length; i++) {
        var k = L.children[i];
        var t = textOf(k).replace(/\s+/g, ' ').trim();
        if (!t || t.length < 2 || t.length > 300) { ok = false; break; }
        if (/【/.test(t) || noText.test(t)) { ok = false; break; }
        if (k.children.length > 5) { ok = false; break; }
        kids.push({ el: k, text: t, w: (k.getBoundingClientRect() || {}).width || 0 });
      }
      if (!ok) continue;
      var w0 = kids[0].w;
      if (w0 > 0) {
        for (var j = 0; j < kids.length; j++) {
          if (Math.abs(kids[j].w - w0) > Math.max(24, w0 * 0.25)) { ok = false; break; }
        }
      }
      if (!ok) continue;
      var rows = [];
      for (var r = 0; r < kids.length; r++) {
        rows.push({
          key: String.fromCharCode(65 + r),
          text: Q.cleanOptionText(kids[r].text),
          el: kids[r].el,
          singleClick: true
        });
      }
      return rows;
    }
    return [];
  }

  /* 学习通有些章节页把测验塞进 iframe（同源），顶层页面里抓不到题目。
     这里把同源 iframe 的 document 也当成一个可读的“页面”来扫。 */
  function quizFrames() {
    var out = [];
    var nodes = document.querySelectorAll('iframe');
    for (var i = 0; i < nodes.length; i++) {
      var d = null;
      try { d = nodes[i].contentDocument; } catch (e) { d = null; }
      if (d && d.body) out.push(d);
    }
    return out;
  }

  function docHasQuizText(d) {
    try {
      return /【(单选题|多选题|判断题|填空题|简答题|论述题)】/.test(String((d.body && d.body.innerText) || ''));
    } catch (e) { return false; }
  }

  /* 当前“有题目”的文档列表：主文档 + 同源且含题目文字的 iframe。 */
  function quizDocs() {
    var out = [document];
    var frames = quizFrames();
    for (var i = 0; i < frames.length; i++) {
      if (docHasQuizText(frames[i])) out.push(frames[i]);
    }
    return out;
  }

  function genericQuestions(root) {
    root = root || document;
    var stop = root.body || document.body;
    var all = root.querySelectorAll('div,p,li,section,article,h1,h2,h3,h4,h5,span');
    var raw = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.closest && el.closest('#van-qa')) continue;
      if (typeMarkCount(el) !== 1) continue;
      var t = textOf(el);
      if (t.length < 6 || t.length > 600) continue;
      raw.push(el);
    }
    // 只留“最内层”的题干节点，避免外层容器重复算题
    var stems = [];
    for (var a = 0; a < raw.length; a++) {
      var inside = false;
      for (var b = 0; b < raw.length; b++) {
        if (a !== b && raw[a].contains(raw[b])) { inside = true; break; }
      }
      if (!inside) stems.push(raw[a]);
    }
    var seen = Object.create(null);
    var out = [];
    for (var s = 0; s < stems.length; s++) {
      var stemEl = stems[s];
      var stemText = textOf(stemEl);
      var clean = Q.cleanStem(stemText.replace(/^\s*\d+\s*/, ''));
      if (!clean || seen[clean]) continue;
      seen[clean] = true;
      var box = stemEl.parentElement;
      var rows = null;
      var loose = false;
      for (var d = 0; d < 6 && box && box !== stop; d++) {
        var r = genericOptionRows(box);
        if (r.length < 2) r = looseOptionRows(box, stemEl);
        if (r.length >= 2) {
          var clash = false;
          for (var c = 0; c < stems.length; c++) {
            if (stems[c] !== stemEl && box.contains(stems[c])) { clash = true; break; }
          }
          if (!clash) {
            rows = r;
            loose = !isOptionRow(r[0].el);
            break;
          }
        }
        box = box.parentElement;
      }
      if (!rows) continue;
      out.push({
        id: 0,
        el: box,
        index: 0,
        generic: true,
        loose: loose,
        type: Q.detectType(stemText, {}),
        stem: clean,
        options: rows,
        texts: [],
        hint: (stemText.match(QMARK_RE) || [''])[0]
      });
    }
    return out;
  }

  /* 还有一类页面：题目和选项都排版成一行行的纯文字，选项之间没有共同容器
   * （题干和四个选项是平级的 div），按“包含关系”找不到题块。
   * 这时退一步读页面的文字流：按 【题型】 切题，按行首 A/B/C 切选项，
   * 再按选项文字反查页面上能点的那个元素。 */
  function clickableByText(txt, scope) {
    scope = scope || document;
    var nodes = scope.querySelectorAll('div,li,p,label,span,a');
    var best = null;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!visible(el)) continue;
      var t = textOf(el).replace(/\s+/g, ' ').trim();
      if (t !== txt) continue;
      if (el.children.length > 6) continue;
      var hasSameChild = false;
      for (var j = 0; j < el.children.length; j++) {
        if (textOf(el.children[j]).replace(/\s+/g, ' ').trim() === txt) { hasSameChild = true; break; }
      }
      if (hasSameChild) continue;
      var cls = String(el.className || '');
      if (/opt|answer|choice|item|option|select/i.test(cls)) return el;
      if (!best) best = el;
    }
    return best;
  }

  function textQuestions(root) {
    root = root || document;
    var body = root.body || document.body;
    if (!body) return [];
    var lines = String(body.innerText || '').split(/\n+/);
    var qRe = /^(\d+)?\s*【(单选题|多选题|判断题|填空题|简答题|论述题)】/;
    var stopRe = /^(提交|保存|暂存|上一题|下一题|答题卡|返回|查看答案)/;
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/\s+/g, ' ').trim();
      var m = qRe.exec(line);
      if (!m || line.length > 600) continue;
      var opts = [];
      for (var j = i + 1; j < lines.length && j <= i + 24; j++) {
        var L = lines[j].replace(/\s+/g, ' ').trim();
        if (!L) continue;
        if (qRe.test(L) || stopRe.test(L)) break;
        var om = /^([A-H])\s*[、.．:：)）]?\s*(\S[\s\S]*)$/.exec(L);
        if (om && L.length <= 220) { opts.push({ key: om[1].toUpperCase(), text: om[2].trim(), full: L }); continue; }
        if (opts.length) break;   // 选项结束，后面是解析
      }
      if (opts.length < 2) continue;
      var q = {
        id: 0,
        el: null,
        index: 0,
        generic: true,
        loose: true,
        textFlow: true,
        type: Q.detectType(line, {}),
        stem: Q.cleanStem(line.replace(/^\s*\d+\s*/, '')),
        options: [],
        texts: [],
        hint: m[0]
      };
      var okAll = true;
      for (var k = 0; k < opts.length; k++) {
        // 页面上的选项行通常带“A ”前缀，先按整行文字找，找不到再按选项正文找
        var el = clickableByText(opts[k].full, root) || clickableByText(opts[k].text, root);
        if (!el) { okAll = false; break; }
        q.options.push({ key: opts[k].key, text: opts[k].text, el: el, singleClick: true });
      }
      if (!okAll || !q.options.length) continue;
      out.push(q);
    }
    return out;
  }

  /* -------------------------- 视频弹题 -------------------------- */

  function visible(el) {
    if (!el) return false;
    if (el.offsetParent !== null) return true;
    var r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    return !!r && (r.width > 0 || r.height > 0);
  }

  function findVideoQuiz() {
    for (var i = 0; i < VQ_BOX_SELECTORS.length; i++) {
      var nodes = document.querySelectorAll(VQ_BOX_SELECTORS[i]);
      for (var j = 0; j < nodes.length; j++) {
        if (visible(nodes[j]) && textOf(nodes[j])) return nodes[j];
      }
    }
    return null;
  }

  function vqOptionEls(box) {
    for (var i = 0; i < VQ_OPT_SELECTORS.length; i++) {
      var nodes = box.querySelectorAll(VQ_OPT_SELECTORS[i]);
      var out = [];
      for (var j = 0; j < nodes.length; j++) {
        var n = nodes[j];
        if (!visible(n)) continue;
        var t = textOf(n);
        if (t && t.length <= 200) out.push(n);
      }
      if (out.length >= 2) return out;
    }
    // 兜底：弹题里可见的 li
    var lis = box.querySelectorAll('li');
    var fallback = [];
    for (var k = 0; k < lis.length; k++) {
      if (visible(lis[k]) && textOf(lis[k])) fallback.push(lis[k]);
    }
    if (fallback.length >= 2) return fallback;
    // 再兜底：带 opt/answer 类名的可点块
    var all = box.querySelectorAll('[class*="opt"],[class*="answer"],[class*="choice"]');
    var blocks = [];
    for (var m = 0; m < all.length; m++) {
      var el = all[m];
      if (!visible(el)) continue;
      var tx = textOf(el);
      if (tx && tx.length >= 1 && tx.length <= 200 && !el.querySelector('li')) blocks.push(el);
    }
    return blocks.length >= 2 ? blocks : [];
  }

  function vqTitleHint(box) {
    var nodes = box.querySelectorAll('div,span,p,h1,h2,h3,h4,b,strong,label');
    for (var i = 0; i < nodes.length; i++) {
      var t = textOf(nodes[i]);
      if (t && t.length <= 14 && /判断题|单选题|多选题|填空题|简答题|论述题/.test(t)) return t;
    }
    return '';
  }

  function scanVideoQuiz(box) {
    var els = vqOptionEls(box);
    if (els.length < 2) return null;
    var options = [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var raw = textOf(el);
      var m = /^([A-Ha-h])\s*[、.．:：)）]/.exec(raw);
      var key = m ? m[1].toUpperCase() : String.fromCharCode(65 + i);
      var text = Q.cleanOptionText ? Q.cleanOptionText(raw, key) : raw;
      // 有些弹题把序号写在 li 里但没有冒号，兜底再削一次
      text = text.replace(/^[A-Ha-h]\s*[、.．:：)）]\s*/, '');
      // 弹题选项里可能藏着原生 radio（视觉上是圆圈），能拿到就优先用它
      var inp = null, lab = null;
      try {
        inp = el.querySelector('input[type=radio],input[type=checkbox]');
        lab = el.querySelector('label');
        if (!lab && inp) lab = inp.closest('label');
        if (!inp && lab) inp = lab.querySelector('input');
      } catch (e) { /* ignore */ }
      options.push({
        key: key,
        text: text,
        input: inp,
        label: lab,
        li: el,
        el: el
      });
    }
    var stem = '';
    for (var j = 0; j < VQ_STEM_SELECTORS.length; j++) {
      var node = box.querySelector(VQ_STEM_SELECTORS[j]);
      if (!node) continue;
      var s = Q.cleanStem(textOf(node));
      if (s && s.length > stem.length && !/^\d+[.、]?$/.test(s)) stem = s;
    }
    if (!stem) {
      var clone = box.cloneNode(true);
      var junk = clone.querySelectorAll('ul,ol,li,button,a,input,label,[class*="opt"]');
      for (var k = 0; k < junk.length; k++) junk[k].remove();
      stem = Q.cleanStem(textOf(clone));
    }
    var hint = vqTitleHint(box);
    var type = Q.detectType(hint, { optionTexts: options.map(function (o) { return o.text; }) });
    return {
      id: 1,
      el: box,
      box: box,
      vq: true,
      type: type,
      stem: stem,
      options: options,
      texts: [],
      hint: hint
    };
  }

  function optSelected(o) {
    if (o.input) return !!o.input.checked;
    var el = o.el || o.li;
    if (!el) return false;
    // 选项里藏着原生 radio/checkbox 的，直接看它
    try {
      var inner = el.querySelector && el.querySelector('input[type=radio],input[type=checkbox]');
      if (inner) return !!inner.checked;
    } catch (e) { /* ignore */ }
    var nodes = [el];
    try {
      var kids = el.querySelectorAll('*');
      for (var i = 0; i < kids.length && i < 12; i++) nodes.push(kids[i]);
    } catch (e) { /* ignore */ }
    for (var j = 0; j < nodes.length; j++) {
      var n = nodes[j];
      if (!n.getAttribute) continue;
      if (n.getAttribute('aria-checked') === 'true' || n.getAttribute('data-checked') === 'true') return true;
      var cls = ' ' + String(n.getAttribute('class') || '') + ' ';
      if (/(\bactive\b|\bselected\b|\bchecked\b|\bchosen\b|\bcur\b|ans-videoquiz-opt-active|check_answer|is-checked)/i.test(cls)) return true;
    }
    // 选中样式有时加在选项行外面那层（li / label / 带 opt 的块）上
    var up = el.parentElement;
    for (var k = 0; k < 3 && up; k++, up = up.parentElement) {
      if (!up.getAttribute) break;
      if (up.getAttribute('aria-checked') === 'true' || up.getAttribute('data-checked') === 'true') return true;
      var ucls = ' ' + String(up.getAttribute('class') || '') + ' ';
      if (/(\bactive\b|\bselected\b|\bchecked\b|\bchosen\b|\bcur\b|ans-videoquiz-opt-active|check_answer|is-checked)/i.test(ucls)) return true;
    }
    return false;
  }

  function vqSubmitButton(box) {
    for (var i = 0; i < VQ_SUBMIT_SELECTORS.length; i++) {
      var node = box.querySelector(VQ_SUBMIT_SELECTORS[i]);
      if (node && visible(node)) return node;
    }
    var nodes = box.querySelectorAll('button, a, div, span');
    for (var j = 0; j < nodes.length; j++) {
      var n = nodes[j];
      var t = textOf(n);
      if (t && t.length <= 6 && /^(提交|确定|确认|提交答案)$/.test(t) && visible(n)) return n;
    }
    return null;
  }

  function vqKey(q) {
    try { return Q.hashQuestion(q.stem, q.options); } catch (e) { return ''; }
  }

  /** 弹题提交后的页面反馈（“回答错误 / 正确答案是…”），用来判断是不是答错了。 */
  function vqFeedback(box) {
    var parts = [];
    if (box && document.contains(box)) parts.push(textOf(box));
    var nodes = document.querySelectorAll('[class*="error"],[class*="wrong"],[class*="result"],[class*="toast"],[class*="message"],[class*="tip"]');
    for (var i = 0; i < nodes.length && i < 24; i++) {
      var t = textOf(nodes[i]);
      if (t && t.length <= 60) parts.push(t);
    }
    return parts.join(' | ');
  }

  function vqBlocked(q) {
    var key = vqKey(q);
    if (!key) return false;
    var tried = (S.vqTried[key] || []).length;
    return !!S.vqWrong[key] || tried >= VQ_MAX_TRIES || (S.vqTries[key] || 0) >= 2;
  }

  function vqSig(keys) {
    return keys.slice().sort().join('');
  }

  function vqCurrentKeys(q) {
    var out = [];
    for (var i = 0; i < q.options.length; i++) {
      if (optSelected(q.options[i])) out.push(q.options[i].key);
    }
    return out;
  }

  /* 选择题的候选答案：单选/判断按顺序换一个；多选把各种组合都列出来（太多就只试单选项）。 */
  function vqCandidates(q, tried) {
    var keys = q.options.map(function (o) { return o.key; });
    var out = [];
    if (q.type === 'multi' && keys.length <= 4) {
      var total = 1 << keys.length;
      for (var mask = total - 1; mask > 0; mask--) {
        var one = [];
        for (var i = 0; i < keys.length; i++) {
          if (mask & (1 << i)) one.push(keys[i]);
        }
        out.push(one);
      }
    } else if (q.type === 'multi') {
      keys.forEach(function (k) { out.push([k]); });
    } else {
      keys.forEach(function (k) { out.push([k]); });
    }
    return out.filter(function (c) { return tried.indexOf(vqSig(c)) < 0; });
  }

  /* 把弹题选项点成指定答案，并确认选中状态真的对上了。 */
  function applyVqAnswer(q, keys) {
    for (var i = 0; i < q.options.length; i++) {
      var o = q.options[i];
      var want = keys.indexOf(o.key) >= 0;
      if (optSelected(o) !== want) choose(o);
    }
    for (var j = 0; j < q.options.length; j++) {
      var w = keys.indexOf(q.options[j].key) >= 0;
      if (optSelected(q.options[j]) !== w) return false;
    }
    return true;
  }

  function verifyVqSubmit(box, q) {
    S.vqSubmitting = false;
    var key = q ? vqKey(q) : '';
    var still = box && document.contains(box) && visible(box);
    if (!still) {
      if (key) {
        delete S.vqTries[key];
        delete S.vqTried[key];
        delete S.vqWrong[key];
      }
      log('弹题已提交');
      setStatus('done', '弹题已提交');
      return;
    }
    var fb = vqFeedback(box);
    if (/回答错误|答错|答案错误|选错|正确答案/.test(fb)) {
      var tried = key ? (S.vqTried[key] || []) : [];
      var cur = q ? vqCurrentKeys(q) : [];
      if (key && cur.length) {
        var sig = vqSig(cur);
        if (tried.indexOf(sig) < 0) tried.push(sig);
        S.vqTried[key] = tried;
      }
      // 答错了就把这次答案记下来，换一个没试过的再交，直到答对或用完次数
      var next = key && q ? vqCandidates(q, tried)[0] : null;
      if (next && tried.length <= VQ_MAX_TRIES) {
        log('弹题答错了，换成 ' + next.join('') + ' 再试（已试 ' + tried.length + ' 次）…');
        setStatus('busy', '答错了，换答案重试');
        setTimeout(function () {
          if (!document.contains(box)) return;
          // 换答案的这段时间先占住“提交中”，别让页面观察器又拿旧答案交一次
          S.vqSubmitting = true;
          if (!applyVqAnswer(q, next)) {
            S.vqSubmitting = false;
            S.vqWrong[key] = true;
            log('换答案没点上，先停手，请手动选一下');
            return;
          }
          setTimeout(function () {
            S.vqSubmitting = false;
            submitVideoQuiz(box);
          }, 600);
        }, 800);
        return;
      }
      if (key) S.vqWrong[key] = true;
      setStatus('error', '弹题答错了');
      log('这道弹题能试的答案都试过了，先停手，请手动选一下');
      return;
    }
    if (key) {
      S.vqTries[key] = (S.vqTries[key] || 0) + 1;
      if (S.vqTries[key] >= 2) {
        S.vqWrong[key] = true;
        setStatus('error', '弹题提交没生效');
        log('弹题提交后没消失，先停手，避免一直重复提交');
      } else {
        log('弹题提交后还停在页面上，等页面反应…');
      }
    }
  }

  function submitVideoQuiz(box) {
    if (S.vqSubmitting) return false;
    if (Date.now() - S.vqLastSubmitAt < 2500) return false;
    var btn = vqSubmitButton(box);
    if (!btn) { log('弹题没找到提交按钮'); return false; }
    var q = scanVideoQuiz(box);
    if (q && vqBlocked(q)) {
      log('这道弹题能试的答案都试过了，不再自动重试，请手动选');
      return false;
    }
    log('提交弹题…');
    S.vqSubmitting = true;
    S.vqLastSubmitAt = Date.now();
    try {
      fire(btn, 'mousedown');
      fire(btn, 'mouseup');
      btn.click();
    } catch (e) {
      S.vqSubmitting = false;
      log('弹题提交出错：' + String(e && e.message || e));
      return false;
    }
    setStatus('busy', '已提交弹题');
    setTimeout(function () { verifyVqSubmit(box, q); }, 1800);
    setTimeout(function () { scan(); }, 600);
    return true;
  }

  function scan() {
    var list = [];
    var vq = findVideoQuiz();
    if (vq) {
      var vqQ = scanVideoQuiz(vq);
      if (vqQ) {
        vqQ.index = 0;
        list.push(vqQ);
        // 弹题优先；如果整页是考试/作业，保留原类型给提交逻辑判断
        if (S.pageKind !== 'exam' && S.pageKind !== 'work') S.pageKind = 'videoquiz';
      }
    }
    var containers = pickContainers();
    var genericList = [];
    var frames = quizFrames();
    if (!containers.length && !vq) {
      genericList = genericQuestions();
      // 主文档没认出来，再翻同源 iframe（章节内容有时整块塞在 iframe 里）
      if (!genericList.length) {
        for (var f = 0; f < frames.length; f++) {
          if (!docHasQuizText(frames[f])) continue;
          var inside = genericQuestions(frames[f]);
          if (inside.length) {
            genericList = inside;
            log('题目在 iframe 里，认出 ' + inside.length + ' 题');
            break;
          }
        }
      }
      if (genericList.length) {
        var looseN = 0;
        for (var g = 0; g < genericList.length; g++) if (genericList[g].loose) looseN++;
        log('按文本结构认出 ' + genericList.length + ' 题（新版页面）' +
          (looseN ? '，其中 ' + looseN + ' 题选项没有 A/B 前缀，按排列顺序认' : ''));
      } else {
        // 题干和选项是平级 div、没有公共容器时，按文字流再试一次
        var flow = textQuestions();
        if (!flow.length && frames.length) {
          for (var ff = 0; ff < frames.length; ff++) {
            if (!docHasQuizText(frames[ff])) continue;
            flow = textQuestions(frames[ff]);
            if (flow.length) { log('题目在 iframe 里（按文字流），认出 ' + flow.length + ' 题'); break; }
          }
        }
        if (flow.length) {
          genericList = flow;
          log('按文字顺序认出 ' + flow.length + ' 题（没有 A/B 前缀，按行首字母认）');
        } else if (document.querySelectorAll('iframe').length) {
          log('主页没认出题目；页面里有 ' + document.querySelectorAll('iframe').length +
            ' 个 iframe，' + frames.length + ' 个同源可读（跨域子页面会自己接管）');
        }
      }
    }
    for (var i = 0; i < containers.length; i++) {
      var el = containers[i];
      if (vq && vq.contains(el)) continue;
      var options = collectOptions(el);
      var texts = collectTextInputs(el, options);
      var hint = typeHintOf(el);
      var type = Q.detectType(hint, {
        radio: el.querySelectorAll('input[type=radio]').length,
        checkbox: el.querySelectorAll('input[type=checkbox]').length,
        textarea: el.querySelectorAll('textarea').length,
        text: texts.length,
        optionTexts: options.map(function (o) { return o.text; })
      });
      list.push({
        id: 0,
        el: el,
        index: 0,
        type: type,
        stem: stemOf(el),
        options: options,
        texts: texts,
        hint: hint
      });
    }
    for (var g = 0; g < genericList.length; g++) list.push(genericList[g]);
    if (!vq) S.pageKind = pageKind();
    for (var n = 0; n < list.length; n++) {
      list[n].id = n + 1;
      list[n].index = n;
    }
    S.questions = list;
    // 已经填过的重新计数
    S.filled = list.filter(function (q) { return isFilled(q); }).length;
    updateMeta();
    return list;
  }

  function isFilled(q) {
    if (q.vq || q.type === 'single' || q.type === 'multi' || q.type === 'judge') {
      if (!q.options.length) return false;
      for (var i = 0; i < q.options.length; i++) if (optSelected(q.options[i])) return true;
      return false;
    }
    for (var j = 0; j < q.texts.length; j++) {
      if (String(q.texts[j].value || '').trim()) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ *
   * 填答
   * ------------------------------------------------------------------ */

  function nativeSet(el, value) {
    var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    try {
      if (desc && desc.set) desc.set.call(el, value);
      else el.value = value;
    } catch (e) {
      el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function fire(node, type) {
    if (!node) return;
    try {
      node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    } catch (e) {
      try { node.click(); } catch (e2) { /* ignore */ }
    }
  }

  /** 点选项：优先 label，其次 input，最后 li；弹题没有 input，直接点元素。 */
  function choose(opt) {
    if (!opt.input) {
      var el = opt.el || opt.li;
      if (!el) return false;
      try {
        fire(el, 'mousedown');
        fire(el, 'mouseup');
        el.click();
        if (optSelected(opt)) return true;
        // 新版测验点一下就是切换选中，补点第二下反而会取消，所以只点一次
        if (!opt.singleClick) {
          el.click();
          if (optSelected(opt)) return true;
        }
        // 有的弹题把 radio 藏在 li 里，点 li 不触发，得点里面的 label/圆圈
        var inner = el.querySelector('label,input,i,span[class*="radio"],span[class*="circle"],span[class*="check"]');
        if (inner && inner !== el) {
          try { inner.click(); } catch (e) { /* ignore */ }
          if (optSelected(opt)) return true;
        }
        // 里面真有 radio 的话，直接置 checked 再补发事件（有些框架只监听 change）
        var inp = el.querySelector && el.querySelector('input[type=radio],input[type=checkbox]');
        if (inp) {
          try {
            inp.checked = true;
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
          } catch (e) { /* ignore */ }
          if (optSelected(opt)) return true;
        }
        // 最后再点一层父 li（选项行可能只是 li 里的一个 span）
        var p = el.closest && el.closest('li');
        if (p && p !== el) {
          try { p.click(); } catch (e) { /* ignore */ }
          if (optSelected(opt)) return true;
        }
        return false;
      } catch (e) {
        return false;
      }
    }
    var ok = false;
    try {
      if (opt.label) { opt.label.click(); ok = opt.input.checked; }
      if (!ok) { opt.input.click(); ok = opt.input.checked; }
      if (!ok) {
        var target = opt.li || opt.label || opt.input.parentNode;
        fire(target, 'mousedown'); fire(target, 'mouseup'); fire(target, 'click');
        ok = opt.input.checked;
      }
      if (!ok) {
        // 有些版本用 change 事件代理
        opt.input.checked = true;
        opt.input.dispatchEvent(new Event('change', { bubbles: true }));
        ok = opt.input.checked;
      }
    } catch (e) { ok = false; }
    return ok;
  }

  function fillChoice(q, parsed) {
    var keys = parsed.keys || [];
    if (!keys.length) return 0;
    if (q.type === 'multi') {
      // 多选：先把不该选的取消掉
      for (var i = 0; i < q.options.length; i++) {
        var o = q.options[i];
        if (keys.indexOf(o.key) === -1 && optSelected(o)) choose(o);
      }
    }
    var done = 0;
    for (var k = 0; k < keys.length; k++) {
      for (var j = 0; j < q.options.length; j++) {
        if (q.options[j].key !== keys[k]) continue;
        var opt = q.options[j];
        // 点完要真的看到选中状态才算数，否则“已填”会虚报
        if (!optSelected(opt) && !(choose(opt) && optSelected(opt))) break;
        done++;
        break;
      }
    }
    return done;
  }

  function fillText(q, parsed) {
    var value = parsed.text || '';
    if (!value) return 0;
    var parts = value.split(/\s*\|\s*|\s*；\s*/).filter(Boolean);
    var used = 0;
    for (var i = 0; i < q.texts.length; i++) {
      var v = parts.length > 1 && parts[i] != null ? parts[i] : (i === 0 ? value : '');
      if (!v) continue;
      nativeSet(q.texts[i], v);
      used++;
    }
    if (!used && q.texts[0]) {
      nativeSet(q.texts[0], value);
      used = 1;
    }
    return used;
  }

  function fillOne(q, answer) {
    if (!answer || answer.answer == null || answer.answer === '') return false;
    var parsed = Q.parseAnswer(answer.answer, q.options, q.type);
    var n = 0;
    if (parsed.kind === 'choice') n = fillChoice(q, parsed);
    else n = fillText(q, parsed);

    // 文字流题目没有整题容器，用第一个选项行当标记；再不行就不标记
    var mark = q.el || (q.options[0] && q.options[0].el) || null;
    if (mark && mark.style) {
      if (n > 0) {
        mark.style.outline = '2px solid rgba(52,211,153,.55)';
        mark.style.outlineOffset = '2px';
        mark.setAttribute('data-van-qa', 'ok');
      } else {
        mark.style.outline = '2px solid rgba(251,191,36,.5)';
        mark.style.outlineOffset = '2px';
        mark.setAttribute('data-van-qa', 'miss');
      }
    }
    return n > 0;
  }

  /* ------------------------------------------------------------------ *
   * 取答案
   * ------------------------------------------------------------------ */

  function send(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (res) {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(res || { ok: false, error: '后台没有响应' });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e && e.message || e) });
      }
    });
  }

  function payloadOf(questions) {
    return questions.map(function (q) {
      return {
        id: q.id,
        type: q.type,
        stem: q.stem,
        options: q.options.map(function (o) { return { key: o.key, text: o.text }; }),
        hash: Q.hashQuestion(q.stem, q.options)
      };
    });
  }

  async function runStart() {
    if (S.running) { log('已经在跑了'); return; }
    S.running = true;
    S.aborted = false;
    S.filled = 0;
    updateMeta();
    setStatus('busy', '取答案中');
    log('扫描题目…');

    scan();
    if (!S.questions.length) {
      log(S.pageKind === 'video' || S.pageKind === 'unknown'
        ? '这个页面暂时没扫到题目；视频弹题出现后会自动识别'
        : '没认出题目结构：新版页面可以点下面的“复制结构”，把页面发出来适配');
      // 有些新版页面是异步渲染的，等它一下再扫一次
      setTimeout(function () {
        scan();
        if (S.questions.length) {
          log('页面加载完了，认出 ' + S.questions.length + ' 题，重新开始…');
          S.running = false;
          start();
        }
      }, 1500);
      S.running = false;
      setStatus('idle', '没有题目');
      return;
    }
    // 每次开始都重新读一遍配置：用户可能刚在设置里填完 Key，页面还开着
    await readConfig();
    log('共 ' + S.questions.length + ' 题，' + (S.cfg && S.cfg.provider === 'bank' ? '查本地题库' : '请求答案'));
    S.everStarted = true;

    var unanswered = [];
    for (var i = 0; i < S.questions.length; i++) {
      if (S.aborted) break;
      if (isFilled(S.questions[i])) continue;
      unanswered.push(S.questions[i]);
    }

    if (!unanswered.length) {
      log('题目都填好了，不用重复答');
      S.running = false;
      setStatus('done', '已填满');
      maybeSubmit();
      return;
    }

    // 正常情况不传配置，后台直接读 storage 里的最新值；只有调试参数才临时覆盖
    var res = await send({ type: T.ASK, questions: payloadOf(unanswered), config: forceOn() ? (S.cfg || {}) : null });
    if (S.aborted) { S.running = false; return; }

    if (!res || !res.ok) {
      var msg = (res && res.error) || '后台取答案失败';
      log('失败：' + msg);
      setStatus('error', msg);
      S.running = false;
      return;
    }

    var byId = Object.create(null);
    (res.answers || []).forEach(function (a) { byId[String(a.id)] = a; });

    var okCount = 0;
    var missCount = 0;
    for (var j = 0; j < unanswered.length; j++) {
      var q = unanswered[j];
      var ans = byId[String(q.id)];
      var ok = ans ? fillOne(q, ans) : false;
      if (ok) {
        okCount++;
        S.filled++;
        log('#' + q.id + ' ' + (Q.TYPE_LABEL[q.type] || q.type) + ' → ' + String(ans.answer).slice(0, 30));
      } else {
        missCount++;
        log('#' + q.id + ' 没拿到答案或没填上');
      }
      updateMeta();
      if (j % 3 === 2) await sleep(120);
    }

    if (res.errors && res.errors.length) log('提示：' + res.errors.slice(0, 2).join('；'));

    // 弹题的选中态由页面异步渲染，等一拍再重扫，避免“填了却显示 0”
    var hadVq = false;
    for (var v = 0; v < unanswered.length; v++) if (unanswered[v].vq) { hadVq = true; break; }
    if (hadVq) {
      await sleep(300);
      scan();
    }

    S.running = false;
    if (okCount) setStatus('done', '填好 ' + okCount + ' 题');
    else setStatus('error', '没填上');

    if (missCount) log('有 ' + missCount + ' 题没填上，可以点“重新答题”或手动补');
    maybeSubmit();
  }

  function start() {
    return runStart().catch(function (e) {
      S.running = false;
      log('答题出错：' + String(e && e.message || e));
      setStatus('error', '出错了');
    });
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /* ------------------------------------------------------------------ *
   * 提交
   * ------------------------------------------------------------------ */

  /* 页面上“提交”可能是一个 div 外壳，真正绑事件的是里面的 button/span；
     所以收集所有候选，优先最深、最像按钮的那个，点不动再换下一个。 */
  function findSubmitButtons() {
    var words = ['提交作业', '提交答案', '交卷', '保存并提交', '提交'];
    var docs = quizDocs();
    var out = [];
    for (var d = 0; d < docs.length; d++) {
      var doc = docs[d];
      var nodes = doc.querySelectorAll(
        'button, a, input[type=button], input[type=submit], .btnSubmit, #submitBtn, ' +
        '[role=button], div[class*="btn"], span[class*="btn"], div[class*="submit"], span[class*="submit"], ' +
        'div, span'
      );
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (n.tagName === 'DIV' || n.tagName === 'SPAN') {
          // 纯 div/span 兜底范围太大，只留下“自己是叶子或只有行内内容”的
          var direct = '';
          for (var c = 0; c < n.childNodes.length; c++) {
            if (n.childNodes[c].nodeType === 3) direct += n.childNodes[c].nodeValue;
          }
          if (direct.replace(/\s+/g, '').length === 0 && n.children.length > 1) continue;
        }
        var label = n.tagName === 'INPUT' ? (n.value || '') : textOf(n);
        label = label.trim();
        if (!label || label.length > 8) continue;
        var hitWord = false;
        for (var w = 0; w < words.length; w++) {
          if (label.indexOf(words[w]) !== -1) { hitWord = true; break; }
        }
        if (!hitWord) continue;
        if (n.disabled) continue;
        if (/保存|暂存/.test(label)) continue;
        if (!visible(n)) continue;
        var onclick = String(n.getAttribute('onclick') || '');
        if (/confirm\s*\(|alert\s*\(/i.test(onclick)) continue;
        out.push({ el: n, label: label });
      }
    }
    // 去掉“祖先包着后代”的重复项，保留更深、更具体的那个
    out = out.filter(function (x) {
      return !out.some(function (y) {
        return y !== x && x.el !== y.el && x.el.contains(y.el) && textOf(x.el).trim() === textOf(y.el).trim();
      });
    });
    out.sort(function (a, b) {
      function rank(n) {
        if (n.tagName === 'BUTTON' || n.tagName === 'INPUT') return 0;
        if (n.tagName === 'A') return 1;
        if (n.getAttribute('role') === 'button') return 2;
        return 3;
      }
      return rank(a.el) - rank(b.el);
    });
    return out;
  }

  function findSubmitButton() {
    var list = findSubmitButtons();
    return list.length ? list[0].el : null;
  }

  /* 新版页面的按钮多半绑着 mousedown/pointerdown，光 el.click() 不一定触发。 */
  function clickEl(el) {
    if (!el) return;
    try { el.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }
    var opts = { bubbles: true, cancelable: true, view: window };
    try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (e) { /* ignore */ }
    try { el.dispatchEvent(new MouseEvent('mousedown', opts)); } catch (e) { /* ignore */ }
    try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (e) { /* ignore */ }
    try { el.dispatchEvent(new MouseEvent('mouseup', opts)); } catch (e) { /* ignore */ }
    // click 只走 el.click()，别再手动 dispatch 一次：那会让页面收到两个 click，
    // “提交”被执行两次（作业重复交、弹题重复答）。
    try { if (typeof el.click === 'function') el.click(); } catch (e) { /* ignore */ }
  }

  /* 点完“提交”后，怎么算真的有反应：弹了确认框、按钮消失/变灰、出现“提交成功”。 */
  function submitReacted(el) {
    if (confirmDialog()) return true;
    if (el && el.isConnected === false) return true;
    if (el && !visible(el)) return true;
    var t = (document.body && document.body.innerText) || '';
    return /提交成功|交卷成功|已提交|已完成/.test(t.slice(0, 20000));
  }

  /* 平台点“提交”后常弹一个自己画的确认框（layui / element / 学习通自己的 popDiv 都有）。
     它不是浏览器原生 confirm，所以能直接找到里面的“提交/确定”按钮点掉，
     这样“自动交卷”才真的交得出去。 */
  var CONFIRM_BOX_SEL = [
    '.layui-layer-dialog', '.layui-layer', '.el-message-box', '.el-dialog',
    '.ant-modal', '.ant-modal-confirm', '.van-dialog', '.ui-dialog',
    // 学习通“确认提交？”的原生弹层：#workpop > .popDiv（实测 2026-11 结构）
    '.popDiv', '.maskDiv .popDiv', '#workpop', '.popBox', '.pop-win',
    '[role=dialog]', '[role=alertdialog]', '.dialog', '.modal', '.popup', '.confirm', '.confirm-box'
  ].join(',');
  var CONFIRM_TEXT_RE = /确认提交|确定提交|确认交卷|是否提交|是否交卷|提交作业|提交试卷|确认要提交|提交后不可修改/;
  var CONFIRM_BTN_WORDS = ['提交', '确定', '确认', '是', '交卷'];
  var CONFIRM_BTN_SKIP = /取消|关闭|返回|再想想|暂不|放弃/;

  function confirmDialog() {
    var docs = quizDocs();
    for (var d = 0; d < docs.length; d++) {
      var boxes = docs[d].querySelectorAll(CONFIRM_BOX_SEL);
      for (var i = 0; i < boxes.length; i++) {
        var b = boxes[i];
        if (!visible(b)) continue;
        var t = textOf(b).replace(/\s+/g, ' ').trim();
        if (!t || t.length > 300) continue;
        if (!CONFIRM_TEXT_RE.test(t)) continue;
        return b;
      }
    }
    return null;
  }

  function confirmButton(box) {
    var nodes = box.querySelectorAll(
      'button, a, [role=button], input[type=button], .layui-layer-btn a, ' +
      'div[class*="btn"], span[class*="btn"], div[class*="button"], span[class*="button"], ' +
      'div[class*="primary"], span[class*="primary"], div[class*="submit"], span[class*="submit"]'
    );
    var best = null;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (!visible(n)) continue;
      var label = (n.tagName === 'INPUT' ? n.value : textOf(n)).replace(/\s+/g, '').trim();
      if (!label || label.length > 6) continue;
      if (CONFIRM_BTN_SKIP.test(label)) continue;
      var hit = false;
      for (var w = 0; w < CONFIRM_BTN_WORDS.length; w++) {
        if (label.indexOf(CONFIRM_BTN_WORDS[w]) !== -1) { hit = true; break; }
      }
      if (!hit) continue;
      // “提交”两个字的最优先，其次“确定/确认”
      if (!best || label === '提交' || (best.label !== '提交' && label !== '取消')) best = { el: n, label: label };
      if (label === '提交') break;
    }
    // 有些平台的按钮把文字放在子 span 里、外层是 a：往上找 3 层，
    // 取文字仍然只有“提交/确定”的最小可点祖先，避免点到整块弹层。
    if (!best) {
      var all = box.querySelectorAll('a,button,span,div,em,strong');
      for (var j = 0; j < all.length; j++) {
        var e = all[j];
        if (!visible(e)) continue;
        var tx = textOf(e).replace(/\s+/g, '').trim();
        if (!tx || tx.length > 6 || CONFIRM_BTN_SKIP.test(tx)) continue;
        for (var k = 0; k < CONFIRM_BTN_WORDS.length; k++) {
          if (tx.indexOf(CONFIRM_BTN_WORDS[k]) !== -1) { best = { el: e, label: tx }; break; }
        }
        if (best) break;
      }
    }
    return best;
  }

  /* 等确认框出现并点掉；最多等 6 秒（平台慢的时候 2.5 秒不够）。 */
  function acceptConfirm() {
    return new Promise(function (resolve) {
      // 交给本函数处理时，先占住 confirmBusy，免得常驻监听同时再点一次确认框
      S.confirmBusy = true;
      function finish(v) {
        S.confirmBusy = false;
        resolve(v);
      }
      var tries = 0;
      function tick() {
        var box = confirmDialog();
        if (box) {
          var b = confirmButton(box);
          if (b) {
            clickEl(b.el);
            log('点了确认框里的「' + b.label + '」');
            setTimeout(function () { finish(!confirmDialog()); }, 1200);
            return;
          }
          log('弹出了确认框，但没找到确认按钮，请手动点一下');
          finish(false);
          return;
        }
        if (++tries >= 24) { finish(false); return; }
        setTimeout(tick, 250);
      }
      tick();
    });
  }

  /* 用户自己点“提交”也会弹确认框；只要开了自动提交，就不该让人再手动点一次。
     这个监听独立于“谁点的提交”，所以手动交卷时也能自动确认。 */
  function watchConfirm() {
    if (S.confirmWatching || !document.body) return;
    S.confirmWatching = true;
    var timer = 0;

    function poll() {
      if (S.confirmBusy) return;
      var box = confirmDialog();
      if (!box) {
        S.confirmHinted = false;
        S.confirmSkipped = false;
        return;
      }
      if (pageKind() === 'exam') return;
      // 这个 frame 自己没题（常见于“内容 iframe 的父页面”），但只要刚有子页面说它交了卷，
      // 弹出来的“确认提交?”就是需要我们点的那个。
      var ownQuiz = hasQuizText();
      var fromChild = S.childSubmit && Date.now() - S.childSubmit.at < 60000 && !S.childSubmit.exam;
      // 光看“有没有题目/有没有收到交卷消息”不够：确认框可能由同级的另一个 iframe 弹出。
      // 但“确认提交 / 确认交卷”这类文字已经足够明确——用户开了自动提交，就是想让它点。
      var submitDialog = /确认提交|确定提交|确认交卷|是否提交|是否交卷|确认要提交|提交后不可修改/.test(textOf(box) || '');
      // 最硬的一条线索：刚刚有人（本层或任何一层）点过“提交”，90 秒内弹出的
      // “确认提交?”就一定是这次交卷的确认框，不用再管这一层有没有题目。
      var justSubmitted = S.confirmAt && Date.now() - S.confirmAt < 90000;
      // 但也不能在完全无关的网站上见到“确认提交”就点——至少得是学习通、调试模式、
      // 这层有题、刚有子页面交过卷，或刚点过提交。
      if (!onChaoxing() && !forceOn() && !ownQuiz && !fromChild && !justSubmitted) return;
      if (!ownQuiz && !fromChild && !(justSubmitted && submitDialog)) {
        // 说明清楚为什么没动：不是漏了，是这层看起来跟答题无关
        if (!S.confirmSkipped) {
          S.confirmSkipped = true;
          log('页面弹了确认框，但这一层没有题目、也没收到交卷消息，先不动');
        }
        return;
      }
      S.confirmSkipped = false;
      if (!S.settings.qaAutoSubmit) {
        if (!S.confirmHinted) {
          S.confirmHinted = true;
          log('弹出了确认框；要自动确认，请在设置里打开“自动提交”');
        }
        return;
      }
      var b = confirmButton(box);
      if (!b) return;
      S.confirmBusy = true;
      clickEl(b.el);
      log('检测到确认框，自动点了「' + b.label + '」');
      // 有些平台的确认按钮绑在 pointerdown 上、或点了要等异步校验：
      // 1.2 秒后框还在就再点一次（同一层最多重试 2 次，避免死循环）。
      var retry = 0;
      (function again() {
        setTimeout(function () {
          if (!confirmDialog()) {
            S.confirmBusy = false;
            if (S.settings.qaAutoNext && pageKind() !== 'exam') autoNextSection();
            return;
          }
          if (retry++ < 2) {
            var b2 = confirmButton(confirmDialog());
            if (b2) { clickEl(b2.el); log('确认框还开着，再点一次「' + b2.label + '」'); }
            again();
            return;
          }
          S.confirmBusy = false;
          log('确认框没点掉，请手动点一下“提交”');
        }, 1200);
      })();
    }

    var mo = new MutationObserver(function () {
      if (timer) return;
      timer = setTimeout(function () {
        timer = 0;
        poll();
      }, 400);
    });
    mo.observe(document.body, {
      childList: true,
      subtree: true,
      // 不少平台的确认框是页面加载时就渲染好、靠改 class/style 显示出来的
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden']
    });
    // 兜底轮询：body 被 SPA 换掉、或确认框在观察器冷却/别的路径处理期间才出现时，
    // 只靠 MutationObserver 会永远错过它。轮询不重，1.5 秒一次，没框就直接返回。
    setInterval(poll, 1500);
  }

  async function submit() {
    // 视频弹题有自己的提交按钮，先处理它，避免拿整页的“提交”去交卷
    var vq = findVideoQuiz();
    if (vq) return submitVideoQuiz(vq);
    if (S.pageKind === 'exam') {
      log('考试页不自动交卷，答案已经填好了，请自己检查后手动提交');
      setStatus('error', '考试不自动交卷');
      return false;
    }
    // 刚点过就等页面反应，别一分钟点两次
    if (S.lastSubmitAt && Date.now() - S.lastSubmitAt < 15000) {
      log('刚点过提交，先等页面反应…');
      return false;
    }
    var list = findSubmitButtons();
    if (!list.length) { log('没找到提交按钮，可能是自动保存的作业'); return false; }
    S.lastSubmitAt = Date.now();
    var href0 = location.href;
    // 告诉外层：这次是我们自己交的卷，外层弹的确认框可以点
    postUp({ type: 'vanqa:will-submit', exam: S.pageKind === 'exam' });
    // 再往 storage 广播一次：确认框如果弹在收不到 postMessage 的层（跨域兄弟 iframe、
    // 提交后新开的 about:blank 覆盖层），那一层的轮询也能凭这个时间戳认领它。
    try {
      S.confirmAt = Date.now();
      chrome.storage.local.set({ vanConfirmAt: S.confirmAt });
    } catch (e) { /* ignore */ }

    var reacted = false;
    var used = null;
    for (var i = 0; i < list.length && i < 3; i++) {
      var item = list[i];
      log('点击「' + item.label + '」…' + (i ? '（换一个按钮再试）' : ''));
      clickEl(item.el);
      setStatus('busy', '已点提交');
      // 同一个按钮只点一次：平台可能要 1~2 秒才弹确认框，等够再判断，
      // 否则会连点三次、重复交卷。
      for (var waited = 0; waited < 3600; waited += 300) {
        await sleep(300);
        if (submitReacted(item.el) || location.href !== href0) { reacted = true; used = item.el; break; }
      }
      if (reacted) break;
    }
    if (!reacted) {
      // 还有一种“没反应”：按钮其实是好的，只是确认框弹得慢。这种情况照样去等确认框。
      log('点了提交，暂时没看到反应，继续等确认框…');
    }
    // 平台弹出“确认提交?”时顺手点掉，不弹就不用管
    var confirmed = await acceptConfirm();
    if (confirmed) log('提交完成');
    if (!confirmed && !reacted) {
      log('提交后页面没反应；可能按钮不是这个元素，点“复制结构”发我');
      setStatus('error', '提交没反应');
      return false;
    }
    // 只有确认框被点掉、或页面确实跳走了，才切下一节；没交成功就别跳
    if (S.settings.qaAutoNext && (confirmed || location.href !== href0)) {
      setTimeout(function () {
        if (confirmDialog()) { log('确认框还开着，先不切下一节'); return; }
        autoNextSection();
      }, 2600);
    }
    return true;
  }

  var NEXT_TEXT_RE = /^(下一节|下一章|下一讲|下一课|下一单元|下一个|下节)$/;

  function nextSectionButton() {
    var docs = quizDocs();
    for (var d = 0; d < docs.length; d++) {
      var nodes = docs[d].querySelectorAll('a,button,div,span,li,input[type=button]');
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (S.host && S.host.contains(n)) continue;
        if (!visible(n)) continue;
        if (n.disabled) continue;
        var label = (n.tagName === 'INPUT' ? n.value : textOf(n)).replace(/\s+/g, '').trim();
        if (!label || label.length > 8) continue;
        if (!NEXT_TEXT_RE.test(label)) continue;
        // 菜单/目录里的“下一节”不算，只认按钮/链接样子的
        if (n.tagName === 'DIV' || n.tagName === 'SPAN') {
          var cls = ' ' + String(n.className || '') + ' ';
          if (!/btn|button|next|prev|chapter|section/i.test(cls) && !n.getAttribute('onclick')) continue;
        }
        return n;
      }
    }
    return null;
  }

  function autoNextSection() {
    if (!S.settings.qaAutoNext) return;
    if (pageKind() === 'exam' || S.pageKind === 'exam') return;
    // 提交路径和“外层帮忙”可能同时触发，别连点两节
    if (S.nextSentAt && Date.now() - S.nextSentAt < 6000) return;
    S.nextSentAt = Date.now();
    var btn = nextSectionButton();
    if (!btn) {
      // 章节内容在 iframe 里时，“下一节”按钮通常在外层页面上，让它帮忙点
      if (!isTop()) {
        postUp({ type: 'vanqa:next' });
        log('没找到“下一节”，已让外层页面继续下一节');
      } else if (window.frames && window.frames.length) {
        // 顶层自己也可能是“只有 iframe 的包装层”：按钮在跨域子页面里，
        // 顶层读不到 DOM，只能广播，让每个子页面自己找自己那层的按钮。
        var msg = { type: 'vanqa:next-please' };
        for (var i = 0; i < window.frames.length; i++) {
          try { window.frames[i].postMessage(msg, '*'); } catch (e) { /* ignore */ }
        }
        log('没找到“下一节”按钮，已让子页面各自找一下');
      } else {
        log('没找到“下一节”按钮，答题已完成，手动点一下继续');
      }
      return;
    }
    var label = btn.tagName === 'INPUT' ? btn.value : textOf(btn);
    log('答题完成，点「' + label.trim() + '」继续下一节…');
    // 新的小节多半是视频任务点，点开后就停在那里等人按播放。
    // 记一个时间戳，视频那一层的 content.js 看到后自己按播放。
    try { chrome.storage.local.set({ vanAutoPlayAt: Date.now() }); } catch (e) { /* ignore */ }
    clickEl(btn);
  }

  function maybeSubmit() {
    // 弹题不交就一直卡着视频，填好就直接交（受自动答题开关控制）
    var vq = findVideoQuiz();
    if (vq) {
      if (!(S.settings.qaAutoSubmit || S.settings.qaAutoRun)) return;
      if (S.vqSubmitting || Date.now() - S.vqLastSubmitAt < 2500) return;
      var vqQ = scanVideoQuiz(vq);
      if (vqQ && vqBlocked(vqQ)) return;
      var vqTotal = S.questions.length;
      if (!vqTotal || S.filled < vqTotal) return;
      log('弹题填好了，提交…');
      setTimeout(function () { submitVideoQuiz(vq); }, 600);
      return;
    }
    if (!S.settings.qaAutoSubmit) return;
    if (S.pageKind === 'exam') return;
    var total = S.questions.length;
    if (!total) return;
    if (S.filled < total) {
      log('还有 ' + (total - S.filled) + ' 题没填，先不自动提交');
      return;
    }
    // 观察器可能连着触发好几次，只安排一次提交
    if (S.submitScheduledAt && Date.now() - S.submitScheduledAt < 12000) return;
    S.submitScheduledAt = Date.now();
    log('全部填好，2 秒后自动提交…');
    setTimeout(function () {
      if (!S.running && S.filled >= total) submit();
    }, 2000);
  }

  /* ------------------------------------------------------------------ *
   * 面板
   * ------------------------------------------------------------------ */

  var PANEL_CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}',
    '.wrap{position:fixed;left:16px;bottom:16px;z-index:2147483646;width:272px;background:#0f1420;color:#e8eef9;',
    'border:1px solid #263148;border-radius:14px;box-shadow:0 12px 34px rgba(0,0,0,.45);overflow:hidden;',
    'font-size:13px;line-height:1.45}',
    '.head{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#141b29;border-bottom:1px solid #263148;cursor:default}',
    '.dot{width:8px;height:8px;border-radius:50%;background:#64748b;flex:0 0 auto;box-shadow:0 0 0 3px rgba(100,116,139,.15)}',
    '.dot.busy{background:#fbbf24;box-shadow:0 0 0 3px rgba(251,191,36,.18);animation:pulse 1s infinite}',
    '.dot.done{background:#34d399;box-shadow:0 0 0 3px rgba(52,211,153,.18)}',
    '.dot.error{background:#f87171;box-shadow:0 0 0 3px rgba(248,113,113,.18)}',
    '@keyframes pulse{50%{opacity:.45}}',
    '.title{font-weight:600;letter-spacing:.2px;flex:1}',
    '.badge{min-width:20px;text-align:center;padding:1px 6px;border-radius:999px;background:#1f2a3d;color:#93a4bd;font-size:11px}',
    '.icon{width:24px;height:24px;border:0;border-radius:6px;background:transparent;color:#93a4bd;cursor:pointer;font-size:14px;line-height:1}',
    '.icon:hover{background:#1f2a3d;color:#e8eef9}',
    '.body{padding:10px 12px 12px}',
    '.meta{display:flex;justify-content:space-between;color:#93a4bd;font-size:11.5px;margin:2px 0 8px}',
    '.row{display:flex;gap:8px}',
    'button.act{flex:1;border:1px solid #2f3d57;background:#182032;color:#dbe6f5;border-radius:9px;padding:7px 8px;',
    'font-size:12.5px;cursor:pointer;transition:background .15s,border-color .15s}',
    'button.act:hover{background:#1f2a3d;border-color:#3b4c6b}',
    'button.primary{background:linear-gradient(135deg,#34d399,#22c55e);border-color:transparent;color:#06231a;font-weight:600}',
    'button.primary:hover{filter:brightness(1.05)}',
    'button.act:disabled{opacity:.45;cursor:not-allowed}',
    '.log{margin-top:9px;max-height:132px;overflow:auto;background:#0b101a;border:1px solid #1e2839;border-radius:9px;',
    'padding:6px 8px;font-size:11.5px;color:#9fb0c8;font-family:ui-monospace,Consolas,monospace}',
    '.log:empty{display:none}',
    '.line{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:1px 0}',
    '.tip{margin-top:8px;font-size:11px;color:#6f8099}',
    '.diag{margin-left:6px;border:0;background:transparent;color:#7aa2ff;font-size:11px;cursor:pointer;padding:0;text-decoration:underline}',
    '.diag:hover{color:#a9c2ff}',
    '.wrap.min .body{display:none}'
  ].join('');

  var PANEL_HTML =
    '<div class="wrap" part="wrap">' +
      '<div class="head">' +
        '<span class="dot" title="idle"></span>' +
        '<span class="title">自动答题</span>' +
        '<span class="badge">0</span>' +
        '<button class="icon" data-act="min" title="收起">–</button>' +
      '</div>' +
      '<div class="body">' +
        '<div class="meta"><span class="kind">…</span><span class="count">0 题</span></div>' +
        '<div class="row">' +
          '<button class="act primary" data-act="start">开始答题</button>' +
          '<button class="act" data-act="submit">提交</button>' +
        '</div>' +
        '<div class="log"></div>' +
        '<div class="tip">答案由后台按你的设置获取；考试页只填不交。' +
          '<button class="diag" data-act="diag" title="复制页面结构，发给作者适配">复制结构</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  function copyText(txt) {
    var ta = document.createElement('textarea');
    ta.value = txt;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.documentElement.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.documentElement.removeChild(ta);
    return ok;
  }

  var FRAME_DIAG = [];

  /** 子页面自己的一份结构摘要；外层读不到跨域 iframe 的 DOM，只能让子页面自己说。 */
  function frameDiagText() {
    if (!hasQuizText() && !findVideoQuiz() && !S.questions.length) return '';
    var lines = [];
    lines.push('URL: ' + location.href);
    lines.push('KIND: ' + pageKind() + ' / ' + S.pageKind);
    var html = document.body ? String(document.body.innerHTML || '') : '';
    var at = html.indexOf('【');
    if (at >= 0) lines.push('HTML: ' + html.slice(Math.max(0, at - 300), at + 2000));
    else lines.push('HTML: ' + html.slice(0, 1600));
    return lines.join('\n');
  }

  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.ch !== 'van') return;
    if (d.type === 'vanqa:diag:req') {
      var txt = '';
      try { txt = frameDiagText(); } catch (e) { txt = '读取失败：' + String(e && e.message || e); }
      if (!txt) return;
      try {
        (ev.source || window.parent).postMessage(
          { ch: 'van', type: 'vanqa:diag:res', url: location.href, text: txt }, '*');
      } catch (e) { /* ignore */ }
    } else if (d.type === 'vanqa:diag:res') {
      if (d.text) FRAME_DIAG.push(String(d.text));
    }
  });

  /** “复制结构”：把页面上像题目的节点的 class/HTML 片段复制出来，方便适配新版 DOM。 */
  function copyDiag() {
    var lines = [];
    lines.push('URL: ' + location.href);
    lines.push('TITLE: ' + (document.title || ''));
    lines.push('KIND: ' + pageKind() + ' / ' + S.pageKind);
    // 章节内容常在 iframe 里，先看有几个、是不是同源、里面有没有题
    var ifr = document.querySelectorAll('iframe');
    lines.push('IFRAMES: ' + ifr.length);
    for (var f = 0; f < ifr.length && f < 5; f++) {
      var fd = null;
      try { fd = ifr[f].contentDocument; } catch (e) { fd = null; }
      if (!fd || !fd.body) {
        lines.push('  iframe#' + f + ' ' + (ifr[f].src || '') + ' → 读不到（跨域）');
        continue;
      }
      lines.push('  iframe#' + f + ' ' + (ifr[f].src || '') + ' → 同源，含题型文字=' + docHasQuizText(fd));
      if (docHasQuizText(fd)) {
        var fhtml = '';
        try { fhtml = fd.body.innerHTML || ''; } catch (e) { fhtml = ''; }
        lines.push('  HTML: ' + fhtml.slice(0, 1800));
      }
    }
    // 主文档 / 子页面各有多少视频，以及最近一次切节催播的结果（content.js 写在同一个隔离世界里）
    var topSt = null;
    try { topSt = window.__VAN_TOP_STATUS__; } catch (e) { topSt = null; }
    if (topSt) {
      lines.push('TOP: 主文档视频=' + topSt.videos + '，子页面视频=' + topSt.childVideos +
        '，子页面帧=' + topSt.childFrames);
      if (topSt.kick) lines.push('KICK: ok=' + !!topSt.kick.ok + ' hasVideo=' + !!topSt.kick.hasVideo +
        ' url=' + topSt.kick.url + (topSt.kick.err ? ' err=' + (topSt.kick.err.name || '') + ':' + (topSt.kick.err.message || '') : ''));
    }
    // 视频弹题的 DOM 单独抓一份，它的类名和章节测验完全不同
    var vq = findVideoQuiz();
    if (vq) {
      var vqHtml = '';
      try { vqHtml = vq.outerHTML || ''; } catch (e) { vqHtml = ''; }
      lines.push('');
      lines.push('--- 视频弹题 ---');
      lines.push('TAG: ' + vq.tagName.toLowerCase() + '  CLASS: ' + String(vq.className || '') + '  ID: ' + String(vq.id || ''));
      lines.push('HTML: ' + vqHtml.slice(0, 4000));
    }
    // 弹出来但没点掉的确认框也抓一份：这是“为什么没自动交卷”最直接的证据
    var cd = null;
    try { cd = confirmDialog(); } catch (e) { cd = null; }
    if (cd) {
      lines.push('');
      lines.push('--- 确认框 ---');
      lines.push('HTML: ' + String(cd.outerHTML || '').slice(0, 3000));
      var cdBtn = confirmButton(cd);
      lines.push('识别到的确认按钮: ' + (cdBtn ? cdBtn.label + ' <' + cdBtn.el.tagName.toLowerCase() + '>' : '没找到'));
    }
    // 题目可能在主文档，也可能在同源 iframe 里：两边都找，标注来源
    var scanDocs = [{ d: document, src: '(top)' }];
    var ifrAll = document.querySelectorAll('iframe');
    for (var fa = 0; fa < ifrAll.length; fa++) {
      var fda = null;
      try { fda = ifrAll[fa].contentDocument; } catch (e) { fda = null; }
      if (fda && fda.body) scanDocs.push({ d: fda, src: String(ifrAll[fa].src || '').slice(0, 160) });
    }
    var picked = [];
    for (var sd = 0; sd < scanDocs.length && picked.length < 3; sd++) {
      var all = scanDocs[sd].d.querySelectorAll('div,li,p,section,article,span,h3,h4');
      for (var i = 0; i < all.length && picked.length < 3; i++) {
        var el = all[i];
        var own = '';
        for (var c = el.firstChild; c; c = c.nextSibling) {
          if (c.nodeType === 3) own += c.nodeValue;
        }
        own = own.replace(/\s+/g, ' ').trim();
        if (own.length < 6 || own.length > 240) continue;
        if (!/(单选题|多选题|判断题|填空题|简答题|论述题)/.test(own)) continue;
        picked.push({ el: el, src: scanDocs[sd].src });
      }
    }
    for (var j = 0; j < picked.length; j++) {
      var n = picked[j].el;
      var html = '';
      try { html = n.outerHTML || ''; } catch (e) { html = ''; }
      lines.push('');
      lines.push('--- 候选 ' + (j + 1) + '（来自 ' + picked[j].src + '）---');
      lines.push('TAG: ' + n.tagName.toLowerCase() + '  CLASS: ' + String(n.className || '') + '  ID: ' + String(n.id || ''));
      lines.push('TEXT: ' + ownText(n).slice(0, 160));
      lines.push('HTML: ' + html.slice(0, 1800));
      var parent = n.parentElement;
      if (parent) {
        lines.push('PARENT: ' + parent.tagName.toLowerCase() + '.' + String(parent.className || ''));
      }
    }
    if (!picked.length) {
      lines.push('未找到带题型标记的节点，附 body 片段：');
      var html2 = document.body ? document.body.innerHTML : '';
      var at = html2.indexOf('【');
      lines.push(html2.slice(Math.max(0, at - 400), at + 2000));
    }
    // 跨域 iframe 的 DOM 外层读不到，让子页面把自己的结构发过来
    FRAME_DIAG.length = 0;
    var frames = window.frames;
    for (var fi = 0; fi < frames.length; fi++) {
      try { frames[fi].postMessage({ ch: 'van', type: 'vanqa:diag:req' }, '*'); } catch (e) { /* ignore */ }
    }
    var finish = function () {
      for (var q = 0; q < FRAME_DIAG.length; q++) {
        lines.push('');
        lines.push('=== 子页面 ' + (q + 1) + ' ===');
        lines.push(FRAME_DIAG[q]);
      }
      var ok = copyText(lines.join('\n'));
      log(ok ? '页面结构已复制（含 ' + FRAME_DIAG.length + ' 个子页面），粘贴发给作者即可适配'
             : '复制失败，请在控制台手动复制');
    };
    if (frames.length) setTimeout(finish, 1000);
    else finish();
  }

  function ownText(el) {
    var s = '';
    for (var c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) s += c.nodeValue;
      else if (c.nodeType === 1 && c.children.length === 0) s += c.textContent || '';
    }
    return s.replace(/\s+/g, ' ').trim();
  }

  function ensurePanel() {
    if (S.host) return;
    S.host = document.createElement('div');
    S.host.id = 'van-qa';
    S.host.style.cssText = 'all:initial;position:fixed;left:0;bottom:0;width:0;height:0;z-index:2147483646';
    S.shadow = S.host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = PANEL_CSS;
    S.shadow.appendChild(style);
    var box = document.createElement('div');
    box.innerHTML = PANEL_HTML;
    S.shadow.appendChild(box.firstChild);

    var wrap = S.shadow.querySelector('.wrap');
    S.logEl = S.shadow.querySelector('.log');
    S.badgeEl = S.shadow.querySelector('.badge');
    S.kindEl = S.shadow.querySelector('.kind');
    S.countEl = S.shadow.querySelector('.count');

    wrap.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('[data-act]') : null;
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      if (act === 'start') start();
      else if (act === 'submit') submit();
      else if (act === 'diag') copyDiag();
      else if (act === 'min') {
        S.minimized = !S.minimized;
        wrap.classList.toggle('min', S.minimized);
        btn.textContent = S.minimized ? '+' : '–';
      }
    });

    document.documentElement.appendChild(S.host);
    S.pageKind = pageKind();
    updateMeta();
  }

  function removePanel() {
    if (S.host && S.host.parentNode) S.host.parentNode.removeChild(S.host);
    S.host = null;
    S.shadow = null;
  }

  /* ------------------------------------------------------------------ *
   * 观察 DOM
   * ------------------------------------------------------------------ */

  function armObserver() {
    if (S.observer || !document.body) return;
    S.observer = new MutationObserver(function () {
      if (S.scanTimer) return;
      S.scanTimer = setTimeout(function () {
        S.scanTimer = 0;
        var before = S.questions.length;
        scan();
        if (S.questions.length !== before) {
          log('页面变化，重新扫描：' + S.questions.length + ' 题');
        }
        maybeAutoVideoQuiz();
        maybeAutoRunQuiz();
      }, 600);
    });
    S.observer.observe(document.body, { childList: true, subtree: true });
  }

  /* ------------------------------------------------------------------ *
   * 设置
   * ------------------------------------------------------------------ */

  function readSettings() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.sync.get({ qaEnabled: false, qaAutoRun: true, qaAutoSubmit: true, qaAutoNext: true, showHud: true }, function (v) {
          S.settings = Object.assign({}, S.settings, v || {});
          // 调试页上可以用 ?vanqaSubmit=1 打开自动交卷，不用改设置
          if (forceOn() && /[?&]vanqaSubmit=1(?:&|$)/.test(location.search)) S.settings.qaAutoSubmit = true;
          resolve(S.settings);
        });
      } catch (e) { resolve(S.settings); }
    });
  }

  /**
   * 只在 ?vanqa=1 的调试页上生效：允许用 URL 参数临时指定答题接口，
   * 方便 test/e2e-quiz.mjs 在没有真实 Key 的情况下跑通填答流程。
   * 不写 storage，不影响正常使用。
   */
  function debugConfig(cfg) {
    if (!forceOn()) return cfg;
    var p;
    try { p = new URLSearchParams(location.search); } catch (e) { return cfg; }
    var provider = p.get('vanqaProvider');
    var ai = p.get('vanqaAi');
    if (!provider && !ai) return cfg;
    var base = cfg || (window.VAN_QA && VAN_QA.DEFAULT_QA_CONFIG) || {};
    var out = JSON.parse(JSON.stringify(base));
    if (ai) {
      out.provider = 'ai';
      out.ai = Object.assign({}, out.ai || {}, {
        baseUrl: ai,
        apiKey: p.get('vanqaKey') || 'debug-key',
        model: p.get('vanqaModel') || 'mock'
      });
    }
    if (provider) out.provider = provider;
    return out;
  }

  function readConfig() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get({ qaConfig: null }, function (v) {
          S.cfg = debugConfig(v && v.qaConfig ? v.qaConfig : null);
          resolve(S.cfg);
        });
      } catch (e) { resolve(null); }
    });
  }

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local') {
      if (changes.qaConfig) S.cfg = debugConfig(changes.qaConfig.newValue || null);
      return;
    }
    if (area !== 'sync') return;
    var touched = false;
    ['qaEnabled', 'qaAutoRun', 'qaAutoSubmit', 'showHud'].forEach(function (k) {
      if (changes[k]) { S.settings[k] = changes[k].newValue; touched = true; }
    });
    if (!touched) return;
    if (S.settings.qaEnabled || forceOn()) {
      ensurePanel();
      armObserver();
    } else {
      removePanel();
    }
  });

  /* ------------------------------------------------------------------ *
   * 消息接口（给 popup 用）
   * ------------------------------------------------------------------ */

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg !== 'object') return false;
    switch (msg.type) {
      case T.STATUS:
        sendResponse({
          ok: true,
          answered: true,
          running: S.running,
          pageKind: S.pageKind,
          kindLabel: KIND_LABEL[S.pageKind] || S.pageKind,
          count: S.questions.length,
          filled: S.filled,
          enabled: !!S.settings.qaEnabled
        });
        return false;
      case T.START:
        ensurePanel();
        start();
        sendResponse({ ok: true });
        return false;
      case T.STOP:
        S.aborted = true;
        S.running = false;
        setStatus('idle', '已停止');
        log('已停止');
        sendResponse({ ok: true });
        return false;
      case T.SUBMIT:
        submit().then(function (r) { sendResponse({ ok: r !== false }); });
        return true;
      case T.SCAN:
        scan();
        sendResponse({ ok: true, count: S.questions.length });
        return false;
      default:
        return false;
    }
  });

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */

  /** 页面文字里有没有“【单选题】”这类题型标记——题目异步渲染时靠它补判断。 */
  function hasQuizText() {
    if (!document.body) return false;
    var t = document.body.innerText || '';
    return /【(单选题|多选题|判断题|填空题|简答题|论述题)】/.test(t);
  }

  function looksLikeQuiz() {
    if (forceOn()) return true;
    // 先看内容：about:blank / srcdoc 的 iframe 里 location 不是 chaoxing，但确实是测验
    if (hasQuizText()) return true;
    if (!onChaoxing()) return false;
    // 视频弹题优先级最高：它可能出现在任何课程页
    if (findVideoQuiz()) return true;
    var kind = pageKind();
    if (kind === 'exam' || kind === 'work') return true;
    // URL 不认得时，看 DOM：有 2 个以上带选项的题目容器才算
    var n = 0;
    for (var i = 0; i < Q_SELECTORS.length; i++) {
      n = document.querySelectorAll(Q_SELECTORS[i]).length;
      if (n >= 2) return true;
    }
    return false;
  }

  /** 页面异步渲染出题目后，只要还没自动跑过，就补一次自动开始。 */
  function maybeAutoRunQuiz() {
    if (!S.settings.qaAutoRun || S.running || S.autoTimer || S.everStarted) return;
    if (!S.questions.length || S.filled >= S.questions.length) return;
    autoStart('检测到题目，自动开始…');
  }

  function autoStart(why) {
    if (S.autoTimer) return;
    S.autoTimer = setTimeout(function () {
      S.autoTimer = 0;
      if (!S.settings.qaEnabled && !forceOn()) return;
      log(why);
      start();
    }, 900);
  }

  /** 视频页上发现没答的弹题时，按设置自动开始。 */
  function maybeAutoVideoQuiz() {
    if (!S.settings.qaAutoRun || S.running || S.autoTimer) return;
    if (S.vqSubmitting || Date.now() - S.vqLastSubmitAt < 2500) return;
    var box = findVideoQuiz();
    if (!box) return;
    var q = scanVideoQuiz(box);
    if (!q || isFilled(q) || vqBlocked(q)) return;
    // 同一道弹题点了几次都没生效，就别无限重试了
    var key = vqKey(q);
    var tries = S.vqFillTries[key] || 0;
    if (tries >= 2) {
      if (tries === 2) {
        S.vqFillTries[key] = 3;
        log('这道弹题点了两次都没选中，先停手；点“复制结构”把弹题结构发我');
      }
      return;
    }
    S.vqFillTries[key] = tries + 1;
    log('发现视频弹题');
    autoStart('已开启自动答题，开始答弹题…');
  }

  /** 页面先静默观察，等弹题或异步渲染的测验出现再挂面板，免得看视频时一直有个框。 */
  function watchVideoQuiz() {
    if (!document.body) return;
    var mo = new MutationObserver(function () {
      var vq = findVideoQuiz();
      var quiz = hasQuizText() || looksLikeQuiz();
      if (!vq && !quiz) return;
      mo.disconnect();
      ensurePanel();
      armObserver();
      scan();
      if (vq) {
        if (S.settings.qaAutoRun) maybeAutoVideoQuiz();
        else log('发现视频弹题，点“开始答题”即可');
        return;
      }
      log('检测到题目，共 ' + S.questions.length + ' 题');
      if (S.settings.qaAutoRun) autoStart('已开启自动答题，开始…');
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  /* 不管这个 frame 里有没有题目，都要接住两种消息：
     - 子页面交了卷 → 外层弹的“确认提交?”归我们点（watchConfirm）
     - 子页面找不到“下一节” → 外层帮忙点 */
  function initFrameHooks() {
    if (!document.body) return;
    var mark = function (k, v) {
      try { document.documentElement.setAttribute('data-vanqa-' + k, String(v)); } catch (e) { /* ignore */ }
    };
    if (forceOn()) {
      // 调试模式顺带把扩展 id 放出来，e2e 用它往 chrome.storage 里写开关
      try { mark('id', chrome.runtime.id); } catch (e) { /* ignore */ }
    }
    var nextAt = 0;
    // 顶层把“有人交卷了”转给所有子 frame：确认框常常不在交卷的那个 frame，
    // 也不在它的祖先里，而是由同级的另一个 iframe 弹出来的。
    var relaySubmit = function (exam) {
      if (!isTop()) return;
      var msg = { type: 'vanqa:child-submit', exam: !!exam };
      var fs = window.frames || [];
      for (var i = 0; i < fs.length; i++) {
        try { fs[i].postMessage(msg, '*'); } catch (e) { /* ignore */ }
      }
    };
    window.addEventListener('message', function (ev) {
      var d = ev && ev.data;
      if (!d || typeof d !== 'object' || !d.type) return;
      if (d.type === 'vanqa:will-submit') {
        S.childSubmit = { at: Date.now(), exam: !!d.exam };
        relaySubmit(d.exam);
        log('收到子页面交卷消息，确认框如果弹在这一层，会自动点掉');
        return;
      }
      if (d.type === 'vanqa:child-submit') {
        // 同级 iframe 看完消息也记一笔，它那边如果弹了确认框就会自动点
        S.childSubmit = { at: Date.now(), exam: !!d.exam };
        return;
      }
      if (d.type === 'vanqa:next' || d.type === 'vanqa:next-please') {
        setTimeout(function () {
          if (!S.settings.qaEnabled && !forceOn()) return;
          var btn = nextSectionButton();
          if (!btn) {
            // 中间层没有按钮，转给最外层；最外层可能已经直接收到过，用时间去重
            if (d.type === 'vanqa:next' && !isTop()) {
              try { window.top.postMessage({ type: 'vanqa:next' }, '*'); } catch (e) { /* ignore */ }
            }
            return;
          }
          if (Date.now() - nextAt < 6000) return;
          nextAt = Date.now();
          var label = btn.tagName === 'INPUT' ? btn.value : textOf(btn);
          try {
            clickEl(btn);
            log('帮子页面点了「' + String(label || '').trim() + '」继续下一节');
          } catch (e) { /* ignore */ }
        }, 400);
      }
    });
    try {
      chrome.storage.sync.get(C.DEFAULT_SETTINGS, function (s) {
        if (!s) return;
        S.settings = Object.assign({}, S.settings, s);
        if (s.qaEnabled || forceOn()) watchConfirm();
      });
    } catch (e) {
      // 没有 storage 权限时也别让确认框卡住（默认设置里自动提交是开的）
      watchConfirm();
    }
    // “刚刚点过提交”的时间戳放在 local，任何一层都能读到，
    // 不依赖 postMessage 是否送到、也不依赖这一层有没有题目。
    try {
      chrome.storage.local.get({ vanConfirmAt: 0 }, function (r) {
        S.confirmAt = (r && r.vanConfirmAt) || 0;
        if (S.confirmAt && Date.now() - S.confirmAt < 90000) watchConfirm();
      });
      chrome.storage.onChanged.addListener(function (ch, area) {
        if (area !== 'local' || !ch || !ch.vanConfirmAt) return;
        S.confirmAt = ch.vanConfirmAt.newValue || 0;
        if (S.confirmAt) watchConfirm();
      });
    } catch (e) { /* ignore */ }
  }

  function boot() {
    // 章节内容可能在 about:blank / srcdoc 的 iframe 里，那里 location 不是 chaoxing，
    // 但页面本身有题目文字，就照样接管（match_origin_as_fallback 负责注入）。
    if (!onChaoxing() && !forceOn() && !hasQuizText()) return;
    readSettings().then(function () {
      if (!S.settings.qaEnabled && !forceOn()) return;
      readConfig();
      watchConfirm();
      if (looksLikeQuiz()) {
        ensurePanel();
        armObserver();
        scan();
        log('检测到' + (KIND_LABEL[S.pageKind] || '答题页') + '，共 ' + S.questions.length + ' 题');
        if (!S.questions.length && hasQuizText()) {
          // 题目文字已经在了但结构还没解析出来，等页面渲染完再补一次
          setTimeout(function () {
            scan();
            log('补扫一次：' + S.questions.length + ' 题');
            if (S.questions.length && S.settings.qaAutoRun) autoStart('已开启自动答题，开始…');
          }, 1500);
        }
        if (S.settings.qaAutoRun) autoStart('已开启自动答题，开始…');
        return;
      }
      watchVideoQuiz();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { initFrameHooks(); boot(); }, { once: true });
  } else {
    initFrameHooks();
    boot();
  }
})();
