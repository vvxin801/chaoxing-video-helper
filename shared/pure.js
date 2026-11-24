/*
 * 视频播放助手 · 纯函数层
 *
 * 这里只放不依赖 DOM 的逻辑（文本归一化、候选按钮打分、倍速换算等），
 * 目的是让“怎么判断哪个按钮是下一集”这件事可以被单元测试直接验证。
 * 通过 UMD 方式挂到 globalThis，Node 测试里 import 之后直接读 globalThis.VAN_PURE。
 */
(function (root) {
  'use strict';
  if (root.VAN_PURE) return;

  /** 出现这些字样，基本可以认定是“下一集/下一节”。 */
  var NEXT_TEXT = [
    '下一集', '下一节', '下一课', '下一章', '下一讲', '下一单元', '下一个', '下一视频', '下一段',
    '下集', '下节', '续播', '继续播放', '接着播放', '接下来播放', '播放下一',
    'next video', 'next episode', 'next lesson', 'next chapter', 'play next', 'up next', 'next'
  ];

  /** 出现这些字样说明是“上一集/设置项”，要扣分。 */
  var NEG_TEXT = [
    '上一集', '上一节', '上一课', '上一个', '上一视频', '上集', '上节',
    'previous', 'prev', 'back', '播放列表', '自动播放', '开启', '关闭',
    '倍速', '清晰度', '字幕', '登录', '购买', '广告'
  ];

  var MIN_SCORE = 55;

  /** 进度到 98.5% 以上就当这个视频看完了（有些播放器最后几秒不派发 ended）。 */
  var DONE_RATIO = 0.985;

  /** 从 [{ done }] 里挑第一个还没看完的下标，没有就 -1。 */
  function pickPendingIndex(items) {
    if (!items || !items.length) return -1;
    for (var i = 0; i < items.length; i++) {
      if (!items[i] || !items[i].done) return i;
    }
    return -1;
  }

  function countPending(items) {
    if (!items || !items.length) return 0;
    var n = 0;
    for (var i = 0; i < items.length; i++) {
      if (!items[i] || !items[i].done) n++;
    }
    return n;
  }

  function normalizeText(s) {
    return String(s == null ? '' : s)
      .replace(/[\u200b-\u200f\u2028\u2029\ufeff]/g, '')
      .replace(/[\s\u00a0\u3000]+/g, ' ')
      .trim();
  }

  function parseSelectorList(str) {
    return String(str || '')
      .split(/\r?\n/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0 && s.length < 400; });
  }

  function formatClock(seconds) {
    var s = Number(seconds);
    if (!isFinite(s) || s < 0) return '--:--';
    s = Math.floor(s);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    var mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    return (h > 0 ? h + ':' : '') + mm + ':' + String(sec).padStart(2, '0');
  }

  function clampSpeed(v) {
    var n = Number(v);
    if (!isFinite(n)) return 1;
    return Math.min(4, Math.max(0.25, Math.round(n * 100) / 100));
  }

  /** 按 SPEED_STEPS 上/下一档，dir = 1 加速，-1 减速。 */
  function stepSpeed(current, dir, steps) {
    var list = steps && steps.length ? steps : [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
    var cur = clampSpeed(current);
    var best = 0;
    var bestDist = Infinity;
    for (var i = 0; i < list.length; i++) {
      var d = Math.abs(list[i] - cur);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    var next = best + (dir > 0 ? 1 : -1);
    if (next < 0) next = 0;
    if (next >= list.length) next = list.length - 1;
    return list[next];
  }

  function isTypingTarget(target) {
    if (!target || typeof target !== 'object') return false;
    var tag = String(target.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (target.isContentEditable === true) return true;
    var role = '';
    try { role = String(target.getAttribute && target.getAttribute('role') || ''); } catch (e) { /* ignore */ }
    return role === 'textbox' || role === 'searchbox';
  }

  function matchesNextWord(s) {
    var t = normalizeText(s).toLowerCase();
    if (!t) return false;
    for (var i = 0; i < NEXT_TEXT.length; i++) {
      if (t.indexOf(NEXT_TEXT[i]) !== -1) return true;
    }
    return false;
  }

  function matchesNegWord(s) {
    var t = normalizeText(s).toLowerCase();
    if (!t) return false;
    for (var i = 0; i < NEG_TEXT.length; i++) {
      if (t.indexOf(NEG_TEXT[i]) !== -1) return true;
    }
    return false;
  }

  /**
   * 给一个候选元素打分。描述对象由 content script 的 describe() 生成：
   * { text, aria, title, id, cls, tag, rel, role, visible, hasOnclick, childCount, disabled, priority }
   * priority 是适配器给的先验分（自定义选择器 120，站内适配器 90，播放器按钮 70）。
   */
  function scoreCandidate(d) {
    if (!d) return -Infinity;
    if (d.visible === false) return -Infinity;
    var text = normalizeText(d.text);
    var meta = normalizeText([d.aria, d.title, d.id, d.cls].filter(Boolean).join(' '));
    var s = 0;

    if (d.priority) s += Number(d.priority) || 0;

    var rel = normalizeText(d.rel).toLowerCase().split(' ');
    if (rel.indexOf('next') !== -1) s += 55;

    var textHit = matchesNextWord(text);
    var metaHit = matchesNextWord(meta);
    if (textHit) s += 65;
    if (metaHit) s += 40;

    if (!textHit && matchesNegWord(text)) s -= 70;
    if (text.length > 40) s -= 35;
    if (!text) s -= 15;
    if (!text && !meta) s -= 25;

    if (d.tag === 'a' || d.tag === 'button') s += 12;
    else if (d.role === 'button' || d.role === 'link') s += 8;
    else if (d.hasOnclick) s += 4;

    if (d.childCount > 10) s -= 20;
    if (d.disabled) s -= 200;

    return s;
  }

  /** 返回 [{ i, score }]，只保留达到最低分的，按分数从高到低。 */
  function rankCandidates(descs) {
    var out = [];
    for (var i = 0; i < descs.length; i++) {
      var score = scoreCandidate(descs[i]);
      if (score >= MIN_SCORE) out.push({ i: i, score: score });
    }
    out.sort(function (a, b) { return b.score - a.score; });
    return out;
  }

  /** 直接返回最可能的候选下标，没有则 -1。 */
  function pickBestCandidate(descs) {
    var ranked = rankCandidates(descs);
    return ranked.length ? ranked[0].i : -1;
  }

  root.VAN_PURE = {
    NEXT_TEXT: NEXT_TEXT,
    NEG_TEXT: NEG_TEXT,
    MIN_SCORE: MIN_SCORE,
    DONE_RATIO: DONE_RATIO,
    pickPendingIndex: pickPendingIndex,
    countPending: countPending,
    normalizeText: normalizeText,
    parseSelectorList: parseSelectorList,
    formatClock: formatClock,
    clampSpeed: clampSpeed,
    stepSpeed: stepSpeed,
    isTypingTarget: isTypingTarget,
    matchesNextWord: matchesNextWord,
    matchesNegWord: matchesNegWord,
    scoreCandidate: scoreCandidate,
    rankCandidates: rankCandidates,
    pickBestCandidate: pickBestCandidate
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
