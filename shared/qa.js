/*
 * 视频播放助手 · 答题纯函数层
 *
 * 和 shared/pure.js 一样，这里只放不依赖 DOM 的逻辑：
 *   - 题干清洗、题型识别
 *   - 把“模型/题库给的答案”归一化成选项下标（A/B/C、正确/错误、选项原文）
 *   - 题库文件解析、题库模糊匹配
 *   - 拼 AI 请求、解析 AI 回复
 * 好处是这些最容易出错的规则可以用 Node 单测直接验证（test/qa.test.mjs）。
 */
(function (root) {
  'use strict';
  if (root.VAN_QA) return;

  /* ------------------------------------------------------------------ *
   * 常量
   * ------------------------------------------------------------------ */

  /** 题型短标签（面板上显示用）。 */
  var TYPE_LABEL = {
    single: '单选',
    multi: '多选',
    judge: '判断',
    fill: '填空',
    short: '简答',
    essay: '论述',
    other: '其他'
  };

  /**
   * 题型关键词。顺序很重要：先多选再单选（“多选题”里也含“选题”），
   * 判断题排在最后，因为“判断”这个词也可能出现在题干里。
   */
  var TYPE_HINTS = [
    ['multi', ['多选题', '多项选择', '不定项选择', '不定项', '多选']],
    ['single', ['单选题', '单项选择', '单选']],
    ['fill', ['填空题', '填空']],
    ['short', ['简答题', '简答']],
    ['essay', ['论述题', '论述', '分析题', '名词解释', '计算题', '问答题', '材料题']],
    ['judge', ['判断题', '判断']]
  ];

  /** 题目里常见的“(单选题)”“[多选]”标记。 */
  var TYPE_BRACKET_SRC =
    '[（(\\[【]\\s*(?:单选题?|多选题?|判断题?|填空题?|简答题?|论述题?|名词解释|计算题|分析题|问答题|材料题|其他)\\s*[）)\\]】]';

  /** 括号里同时写了题型和分值，例如“(单选题, 2.0分)”。 */
  var TYPE_SCORE_BRACKET_SRC =
    '[（(\\[【][^）)\\]】]{0,24}?(?:单选题?|多选题?|判断题?|填空题?|简答题?|论述题?|名词解释|计算题|分析题|问答题|材料题|其他|\\d+(?:\\.\\d+)?\\s*分)[^）)\\]】]{0,24}?[）)\\]】]';

  var INVIS = /[\u200b-\u200f\u2028\u2029\ufeff]/g;

  /** 归一化时直接删掉的字符（标点、空白、括号），只留“内容”。 */
  var STRIP = /[\s\u00a0\u3000\u200b-\u200f\ufeff，。、；：？！“”‘’（）()《》〈〉【】\[\]{}·…—\-_.,;:!?'"`~@#$%^&*+=|\\\/<>～]/g;

  /** 默认答题配置（存在 chrome.storage.local 的 qaConfig 里）。 */
  var DEFAULT_QA_CONFIG = {
    v: 1,
    provider: 'ai',            // ai | api | bank
    bankFirst: true,           // 先查本地题库，再走 AI/接口
    maxBatch: 6,               // 一次 AI 请求带几道题
    timeoutMs: 60000,
    ai: {
      baseUrl: 'https://api.deepseek.com',
      apiKey: '',
      model: 'deepseek-chat'
    },
    api: {
      url: '',
      method: 'POST',
      headers: '',
      body: '',
      answerPath: '',
      token: ''
    }
  };

  /* ------------------------------------------------------------------ *
   * 文本
   * ------------------------------------------------------------------ */

  function text(v) {
    return String(v == null ? '' : v)
      .replace(INVIS, '')
      .replace(/[\s\u00a0\u3000]+/g, ' ')
      .trim();
  }

  /** 只留内容、去掉标点空白并小写——用于哈希、模糊匹配。 */
  function normalizeQuestion(v) {
    return text(v).replace(STRIP, '').toLowerCase();
  }

  /** 选项文字：去掉开头的“A.”“A、”之类。 */
  function cleanOptionText(v, key) {
    var s = text(v);
    var k = String(key == null ? '' : key).trim();
    if (k && s.charAt(0).toUpperCase() === k.toUpperCase()) {
      s = s.slice(1).replace(/^[.、．)）:：\s]+/, '');
    }
    return text(s);
  }

  /**
   * 题干清洗：去掉“1.”“（单选题）”“（2.0分）”这些噪音。
   * 只用于给 AI/题库看，不改页面。
   */
  function cleanStem(v) {
    var s = text(v);
    // 先去掉“(单选题, 2.0分)”这种题型+分值混写的括号，再去掉纯题型括号
    s = s.replace(new RegExp(TYPE_SCORE_BRACKET_SRC, 'g'), ' ');
    s = s.replace(new RegExp(TYPE_BRACKET_SRC, 'g'), ' ');
    s = s.replace(/^\s*\d+\s*[.、．)）]\s*/, '');
    s = s.replace(/^\s*[（(]\s*\d+(?:\.\d+)?\s*分\s*[)）]\s*/, '');
    s = s.replace(/[（(]\s*\d+(?:\.\d+)?\s*分\s*[)）]\s*$/, '');
    s = s.replace(/\s+([，。；：？！、])/g, '$1');
    return text(s);
  }

  /* ------------------------------------------------------------------ *
   * 题型
   * ------------------------------------------------------------------ */

  function typeFromWord(word) {
    var w = String(word || '');
    for (var i = 0; i < TYPE_HINTS.length; i++) {
      var list = TYPE_HINTS[i][1];
      for (var j = 0; j < list.length; j++) {
        if (w.indexOf(list[j]) !== -1) return TYPE_HINTS[i][0];
      }
    }
    return '';
  }

  function isJudgeOption(v) {
    var s = normalizeQuestion(v);
    return /^(正确|错误|对|错|是|否|√|✓|×|✗|true|false|t|f)$/.test(s);
  }

  /**
   * 推断题型。
   * @param {string} label 题目头部文字（通常含“(单选题)”）
   * @param {{radio?:number, checkbox?:number, text?:number, textarea?:number, optionTexts?:string[]}} kinds
   */
  function detectType(label, kinds) {
    kinds = kinds || {};
    var s = text(label);

    // 1) 括号标记最可靠（含“(单选题, 2.0分)”这种题型+分值）
    var m = s.match(new RegExp(TYPE_SCORE_BRACKET_SRC)) || s.match(new RegExp(TYPE_BRACKET_SRC));
    if (m) {
      var byBracket = typeFromWord(m[0]);
      if (byBracket) return byBracket;
    }

    // 2) 开头就是类型词（先去掉开头的括号）
    var lead = s.replace(/^[（(\[【\s]+/, '');
    for (var i = 0; i < TYPE_HINTS.length; i++) {
      var list = TYPE_HINTS[i][1];
      for (var j = 0; j < list.length; j++) {
        if (lead.slice(0, 12).indexOf(list[j]) === 0) return TYPE_HINTS[i][0];
      }
    }

    // 3) 看控件
    if (kinds.checkbox) return 'multi';
    if (kinds.radio) {
      var opts = kinds.optionTexts || [];
      var allJudge = opts.length > 0;
      for (var k = 0; k < opts.length; k++) {
        if (!isJudgeOption(opts[k])) { allJudge = false; break; }
      }
      return allJudge ? 'judge' : 'single';
    }
    if (kinds.textarea) return 'short';
    if (kinds.text) return 'fill';
    return 'other';
  }

  /* ------------------------------------------------------------------ *
   * 答案归一化
   * ------------------------------------------------------------------ */

  function dedupe(arr) {
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] != null && out.indexOf(arr[i]) === -1) out.push(arr[i]);
    }
    return out;
  }

  function letterIndex(ch) {
    var c = String(ch).toUpperCase().charCodeAt(0);
    return c >= 65 && c <= 90 ? c - 65 : -1;
  }

  /** 在选项里找字母对应的 key：优先按 key 匹配，其次按位置。 */
  function keyForLetter(options, ch) {
    var L = String(ch).toUpperCase();
    var i;
    for (i = 0; i < options.length; i++) {
      if (String(options[i].key || '').toUpperCase() === L) return options[i].key;
    }
    var idx = letterIndex(L);
    if (idx >= 0 && idx < options.length) return options[idx].key;
    return '';
  }

  /** “正确/错误/对/错/√/×/T/F” → true/false/null。 */
  function judgeBool(v) {
    var s = normalizeQuestion(v);
    if (!s) return null;
    if (/^(对|正确|是|√|✓|真|t|true|yes|y|a)$/.test(s)) return true;
    if (/^(错|错误|否|×|✗|假|f|false|no|n|b)$/.test(s)) return false;
    if (s.indexOf('正确') !== -1 && s.indexOf('错误') === -1) return true;
    if (s.indexOf('错误') !== -1 && s.indexOf('正确') === -1) return false;
    if (s.indexOf('不对') !== -1) return false;
    return null;
  }

  /** 在选项文字里做精确/模糊匹配，返回命中的选项。 */
  function matchOptionText(s, options) {
    var ns = normalizeQuestion(s);
    if (!ns) return null;
    var i;
    for (i = 0; i < options.length; i++) {
      if (normalizeQuestion(options[i].text) === ns) return options[i];
    }
    var best = null;
    var bestScore = 0.72;
    for (i = 0; i < options.length; i++) {
      var sc = similarity(options[i].text, s);
      if (sc > bestScore) { bestScore = sc; best = options[i]; }
    }
    return best;
  }

  /**
   * 把一段“答案文本”解析成选项 key（选择题）或纯文本（填空/简答）。
   * @param {string} raw 例如 "B"、"ABD"、"正确"、"A、C"
   * @param {Array<{key:string,text:string}>} options
   * @param {string} type single|multi|judge|fill|short|essay|other
   * @returns {{kind:'choice'|'text'|'empty', keys:string[], text:string}}
   */
  function parseAnswer(raw, options, type) {
    options = options || [];
    var s = text(raw)
      .replace(/^(?:正确答案|参考答案|答案)\s*[:：]\s*/, '')
      .replace(/^[“"']([\s\S]*)[”"']$/, '$1');
    if (!s || /^(无|空|不确定|不知道|n\/a)$/i.test(s)) return { kind: 'empty', keys: [], text: '' };

    var isChoice = type === 'single' || type === 'multi' || type === 'judge';

    if (isChoice && options.length) {
      // 1) 纯字母（含 A,B / A、B / ABD / A B）
      var letters = s.replace(/[^A-Za-z]/g, '').toUpperCase();
      var pureLetters = /^[A-Za-z](?:[\s,，、;；\/]*[A-Za-z])*$/.test(s);
      if (pureLetters && letters.length && letters.length <= options.length) {
        var keys = [];
        for (var i = 0; i < letters.length; i++) {
          var key = keyForLetter(options, letters[i]);
          if (key) keys.push(key);
        }
        if (keys.length) return { kind: 'choice', keys: dedupe(keys), text: letters };
      }

      // 2) “正确/错误”这类判断语义
      if (type === 'judge') {
        var b = judgeBool(s);
        if (b !== null) {
          for (var j = 0; j < options.length; j++) {
            if (judgeBool(options[j].text) === b) {
              return { kind: 'choice', keys: [options[j].key], text: text(options[j].text) };
            }
          }
        }
      }

      // 3) 直接给了选项原文
      var hit = matchOptionText(s, options);
      if (hit) return { kind: 'choice', keys: [hit.key], text: text(hit.text) };
    }

    return { kind: type === 'fill' || type === 'short' || type === 'essay' ? 'text' : 'text', keys: [], text: s };
  }

  /* ------------------------------------------------------------------ *
   * 哈希与相似度
   * ------------------------------------------------------------------ */

  /** 32 位 FNV-1a + 长度，够用来做缓存键（碰撞概率极低）。 */
  function hashQuestion(stem, options) {
    var base = normalizeQuestion(stem) + '|' +
      (options || []).map(function (o) { return normalizeQuestion(o && o.text); }).join('|');
    var h = 0x811c9dc5;
    for (var i = 0; i < base.length; i++) {
      h ^= base.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8) + '-' + base.length.toString(36);
  }

  function bigrams(s) {
    var m = Object.create(null);
    for (var i = 0; i < s.length - 1; i++) {
      var g = s.substr(i, 2);
      m[g] = (m[g] || 0) + 1;
    }
    return m;
  }

  /** Dice 系数（0~1），对长题干比较稳。 */
  function similarity(a, b) {
    var x = normalizeQuestion(a);
    var y = normalizeQuestion(b);
    if (!x || !y) return 0;
    if (x === y) return 1;
    if (x.length < 2 || y.length < 2) return 0;
    var A = bigrams(x);
    var B = bigrams(y);
    var inter = 0;
    var na = 0;
    var nb = 0;
    var k;
    for (k in A) { na += A[k]; if (B[k]) inter += Math.min(A[k], B[k]); }
    for (k in B) nb += B[k];
    if (!na || !nb) return 0;
    return (2 * inter) / (na + nb);
  }

  /* ------------------------------------------------------------------ *
   * 本地题库
   * ------------------------------------------------------------------ */

  /**
   * 在题库里找答案。先精确（去掉标点空白后相等），再 Dice 模糊。
   * 题库条目形如 { q: '题目', a: 'A', type?: 'single' }。
   * @returns {{a:string, score:number, q:string}|null}
   */
  function findInBank(bank, q, threshold) {
    if (!bank || !bank.length) return null;
    threshold = threshold || 0.9;
    var stem = q && q.stem != null ? q.stem : String(q || '');
    var nq = normalizeQuestion(stem);
    if (!nq) return null;

    var best = null;
    for (var i = 0; i < bank.length; i++) {
      var e = bank[i];
      if (!e || !e.q || e.a == null || e.a === '') continue;
      var ne = normalizeQuestion(e.q);
      if (ne === nq) return { a: String(e.a), score: 1, q: e.q };
      if (Math.abs(ne.length - nq.length) > Math.max(12, nq.length * 0.4)) continue;
      var sc = similarity(ne, nq);
      if (sc >= threshold && (!best || sc > best.score)) best = { a: String(e.a), score: sc, q: e.q };
    }
    return best;
  }

  function bankEntryFromJson(entry) {
    if (entry == null) return null;
    if (Array.isArray(entry)) {
      if (entry.length < 2) return null;
      return { q: text(entry[0]), a: text(entry[1]), type: text(entry[2] || '') };
    }
    if (typeof entry === 'object') {
      var q = entry.q != null ? entry.q : (entry.question != null ? entry.question : (entry.stem != null ? entry.stem : entry.title));
      var a = entry.a != null ? entry.a : (entry.answer != null ? entry.answer : (entry.ans != null ? entry.ans : entry.key));
      if (q == null || a == null) return null;
      return { q: text(q), a: text(a), type: text(entry.type || '') };
    }
    return null;
  }

  /**
   * 解析用户导入的题库文件。支持：
   *   1. JSON 数组：[{"q":"题目","a":"A"}] / [["题目","A"]]
   *   2. JSON 对象：{"题目":"A"}
   *   3. 文本：每行“题目<Tab>答案”“题目----答案”“题目|||答案”“题目,答案”
   * @returns {Array<{q:string,a:string,type:string}>}
   */
  function parseBankFile(raw) {
    var out = [];
    var t = String(raw == null ? '' : raw).replace(/^\uFEFF/, '').trim();
    if (!t) return out;

    function push(q, a, type) {
      q = text(q);
      a = text(a);
      if (q && a) out.push({ q: q, a: a, type: text(type || '') });
    }

    if (t.charAt(0) === '[' || t.charAt(0) === '{') {
      var data = null;
      try { data = JSON.parse(t); } catch (e) { data = null; }
      if (data != null) {
        if (Array.isArray(data)) {
          for (var i = 0; i < data.length; i++) {
            var e = bankEntryFromJson(data[i]);
            if (e) push(e.q, e.a, e.type);
          }
        } else if (typeof data === 'object') {
          var keys = Object.keys(data);
          for (var j = 0; j < keys.length; j++) {
            var v = data[keys[j]];
            if (Array.isArray(v)) { var e2 = bankEntryFromJson(v); if (e2) push(keys[j], e2.a, e2.type); }
            else if (v != null && typeof v !== 'object') push(keys[j], v, '');
          }
        }
        return out;
      }
    }

    var lines = t.split(/\r?\n/);
    for (var k = 0; k < lines.length; k++) {
      var line = lines[k].trim();
      if (!line) continue;
      // 表头（题目 / 答案）
      if (/^\s*(题目|问题|question)\s*[\t,，|]/i.test(line) && /(答案|answer)/i.test(line)) continue;
      var parts = null;
      if (line.indexOf('\t') !== -1) parts = line.split('\t');
      else if (/-{2,}/.test(line)) parts = line.split(/-{2,}/);
      else if (line.indexOf('|||') !== -1) parts = line.split(/\|\|\|/);
      else if (/^[^,]{6,},[^,]{1,60}$/.test(line)) parts = line.split(',');
      if (!parts || parts.length < 2) continue;
      push(parts[0], parts.slice(1).join(' '), '');
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * AI 请求 / 回复
   * ------------------------------------------------------------------ */

  var AI_SYSTEM =
    '你是一名严谨的中国高校课程助教，负责解答超星学习通上的章节测验、作业和考试题。' +
    '你只输出 JSON，不输出任何解释性文字、Markdown 代码块或多余标点。';

  /**
   * 拼一次 chat.completions 的 messages。
   * @param {Array<{id:number,type:string,stem:string,options:Array<{key:string,text:string}>}>} questions
   */
  function buildAiRequest(questions) {
    var payload = (questions || []).map(function (q, i) {
      return {
        id: q.id != null ? q.id : i + 1,
        type: TYPE_LABEL[q.type] || q.type || '其他',
        question: q.stem,
        options: (q.options || []).map(function (o) { return o.key + '. ' + o.text; })
      };
    });

    var user =
      '请逐题作答。规则：\n' +
      '1. 单选题只返回一个选项字母，例如 "B"。\n' +
      '2. 多选题返回全部正确选项字母，按字母顺序拼接，例如 "ABD"。\n' +
      '3. 判断题返回 "正确" 或 "错误"。\n' +
      '4. 填空题按空的顺序用 "|" 分隔；只有一个空就直接写答案。\n' +
      '5. 简答题/论述题给出可以直接提交的简洁答案，不超过 120 字。\n' +
      '6. 没有把握时也要给最可能的答案，并降低 confidence。\n\n' +
      '题目：\n' + JSON.stringify(payload, null, 1) + '\n\n' +
      '只输出这样的 JSON：{"answers":[{"id":1,"answer":"B","confidence":0.92,"reason":"一句话理由"}]}';

    return [
      { role: 'system', content: AI_SYSTEM },
      { role: 'user', content: user }
    ];
  }

  function tryJson(s) {
    try { return JSON.parse(s); } catch (e) { return undefined; }
  }

  /** 从一段可能带 ```json 围栏、前后有废话的文本里抠出 JSON。 */
  function extractJson(s) {
    var t = String(s || '').trim();
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/,'').trim();
    var direct = tryJson(t);
    if (direct !== undefined) return direct;

    var first = t.indexOf('{');
    var last = t.lastIndexOf('}');
    if (first !== -1 && last > first) {
      var obj = tryJson(t.slice(first, last + 1));
      if (obj !== undefined) return obj;
    }
    var a1 = t.indexOf('[');
    var a2 = t.lastIndexOf(']');
    if (a1 !== -1 && a2 > a1) {
      var arr = tryJson(t.slice(a1, a2 + 1));
      if (arr !== undefined) return arr;
    }
    return null;
  }

  /**
   * 解析 AI 回复，统一成 [{id, answer, confidence, reason}]。
   * 兼容 {"answers":[...]}、[...]、{"1":"A","2":"B"}、单个 {"answer":"A"}。
   */
  function parseAiReply(raw) {
    var data = extractJson(raw);
    var list = [];
    if (data == null) return list;

    if (Array.isArray(data)) list = data;
    else if (data && Array.isArray(data.answers)) list = data.answers;
    else if (data && Array.isArray(data.data)) list = data.data;
    else if (data && data.answer != null) list = [data];
    else if (data && data.data && data.data.answer != null) list = [data.data];
    else if (data && typeof data === 'object') {
      var keys = Object.keys(data);
      for (var i = 0; i < keys.length; i++) {
        var v = data[keys[i]];
        if (v != null && typeof v !== 'object') list.push({ id: keys[i], answer: v });
      }
    }

    var out = [];
    for (var j = 0; j < list.length; j++) {
      var x = list[j];
      if (x == null) continue;
      if (typeof x !== 'object') { out.push({ id: j + 1, answer: String(x), confidence: 0, reason: '' }); continue; }
      var ans = x.answer != null ? x.answer : (x.a != null ? x.a : x.value);
      if (ans == null) continue;
      out.push({
        id: x.id != null ? x.id : j + 1,
        answer: Array.isArray(ans) ? ans.join('') : String(ans),
        confidence: Number(x.confidence != null ? x.confidence : x.score) || 0,
        reason: text(x.reason || x.explain || '')
      });
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 导出
   * ------------------------------------------------------------------ */

  root.VAN_QA = {
    TYPE_LABEL: TYPE_LABEL,
    TYPE_HINTS: TYPE_HINTS,
    DEFAULT_QA_CONFIG: DEFAULT_QA_CONFIG,
    text: text,
    normalizeQuestion: normalizeQuestion,
    cleanOptionText: cleanOptionText,
    cleanStem: cleanStem,
    detectType: detectType,
    typeFromWord: typeFromWord,
    isJudgeOption: isJudgeOption,
    judgeBool: judgeBool,
    parseAnswer: parseAnswer,
    matchOptionText: matchOptionText,
    keyForLetter: keyForLetter,
    hashQuestion: hashQuestion,
    similarity: similarity,
    findInBank: findInBank,
    parseBankFile: parseBankFile,
    buildAiRequest: buildAiRequest,
    parseAiReply: parseAiReply,
    extractJson: extractJson
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
