/*
 * 视频播放助手 · 答题后台
 *
 * 为什么需要后台：content script 直接 fetch 第三方 AI / 题库接口会被页面的
 * CORS 和 CSP 拦掉（学习通页面 CSP 很严）。MV3 service worker 里发请求不受
 * 页面 CSP 限制，只要 manifest 里有 host_permissions 就行。
 *
 * 职责：
 *   - 统一收口“取答案”：本地题库 → AI → 自定义题库接口（按配置顺序）
 *   - 答案缓存（同一道题不重复花钱）
 *   - 题库的存取
 *   - 连通性自检（popup 里的“测试连接”）
 */
'use strict';

importScripts('/shared/constants.js', '/shared/qa.js');

var C = self.VAN_CONST || {};
var Q = self.VAN_QA;
var DEFAULT_QA = Q.DEFAULT_QA_CONFIG;

var CACHE_KEY = 'qaCache';
var BANK_KEY = 'qaBank';
var CONFIG_KEY = 'qaConfig';
var CACHE_MAX = 2000;

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function storageGet(area, keys) {
  return new Promise(function (resolve) {
    try {
      chrome.storage[area].get(keys, function (v) { resolve(v || {}); });
    } catch (e) { resolve({}); }
  });
}

function storageSet(area, obj) {
  return new Promise(function (resolve) {
    try {
      chrome.storage[area].set(obj, function () { resolve(!chrome.runtime.lastError); });
    } catch (e) { resolve(false); }
  });
}

function mergeConfig(raw, base) {
  var cfg = JSON.parse(JSON.stringify(base || DEFAULT_QA));
  raw = raw || {};
  Object.keys(raw).forEach(function (k) {
    if (k === 'ai' || k === 'api') {
      if (raw[k] && typeof raw[k] === 'object') {
        Object.keys(raw[k]).forEach(function (k2) { cfg[k][k2] = raw[k][k2]; });
      }
    } else if (raw[k] !== undefined) {
      cfg[k] = raw[k];
    }
  });
  cfg.maxBatch = Math.max(1, Math.min(20, Number(cfg.maxBatch) || 6));
  cfg.timeoutMs = Math.max(3000, Math.min(180000, Number(cfg.timeoutMs) || 60000));
  if (cfg.provider !== 'api' && cfg.provider !== 'bank') cfg.provider = 'ai';
  return cfg;
}

/* 以 storage 里的 qaConfig 为准，msg.config 只当临时覆盖（调试参数 / 设置页点“测试”）。
 * 这样页面先打开、后填 Key 也没问题，不用刷新。 */
async function resolvedConfig(override) {
  var v = await storageGet('local', CONFIG_KEY);
  var cfg = mergeConfig(v && v[CONFIG_KEY]);
  if (override && typeof override === 'object') cfg = mergeConfig(override, cfg);
  return cfg;
}

function errText(e) {
  if (!e) return '未知错误';
  if (e.name === 'AbortError') return '请求超时';
  var m = e.message || String(e);
  if (/Failed to fetch/i.test(m)) return '网络请求失败（接口不可达、被墙或被拦截）';
  return m;
}

function trimSlash(s) {
  return String(s || '').trim().replace(/\/+$/, '');
}

/** 把 baseUrl 补成完整的 /chat/completions 地址。 */
function aiEndpoint(baseUrl) {
  var base = trimSlash(baseUrl) || DEFAULT_QA.ai.baseUrl;
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v\d+$/i.test(base)) return base + '/chat/completions';
  return base + '/v1/chat/completions';
}

/** 带超时和一次重试的 fetch；返回 {status, text} */
async function requestJson(url, opts, timeoutMs) {
  var lastErr = null;
  for (var attempt = 0; attempt < 2; attempt++) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs) : null;
    try {
      var o = Object.assign({}, opts);
      if (ctrl) o.signal = ctrl.signal;
      var res = await fetch(url, o);
      var body = await res.text();
      if (timer) clearTimeout(timer);
      if (!res.ok) {
        lastErr = new Error('HTTP ' + res.status + '：' + String(body || '').slice(0, 300));
        // 4xx 基本是配置/密钥问题，重试没意义
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          var e4 = lastErr; e4.fatal = true; throw e4;
        }
      } else {
        return body;
      }
    } catch (e) {
      if (timer) clearTimeout(timer);
      if (e && e.fatal) throw e;
      lastErr = e;
    }
    if (attempt === 0) await new Promise(function (r) { setTimeout(r, 700); });
  }
  throw lastErr || new Error('请求失败');
}

/* ------------------------------------------------------------------ *
 * 缓存
 * ------------------------------------------------------------------ */

var cacheMem = null;

async function loadCache() {
  if (cacheMem) return cacheMem;
  var v = await storageGet('local', CACHE_KEY);
  cacheMem = v[CACHE_KEY] && typeof v[CACHE_KEY] === 'object' ? v[CACHE_KEY] : {};
  return cacheMem;
}

async function cachePut(hash, entry) {
  var c = await loadCache();
  c[hash] = entry;
  var keys = Object.keys(c);
  if (keys.length > CACHE_MAX) {
    keys.sort(function (a, b) { return (c[a].t || 0) - (c[b].t || 0); });
    for (var i = 0; i < keys.length - CACHE_MAX; i++) delete c[keys[i]];
  }
  var o = {}; o[CACHE_KEY] = c;
  await storageSet('local', o);
}

async function cacheClear() {
  cacheMem = {};
  var o = {}; o[CACHE_KEY] = {};
  await storageSet('local', o);
}

/* ------------------------------------------------------------------ *
 * 各答题来源
 * ------------------------------------------------------------------ */

/** 本地题库：模糊匹配，命中返回答案原文。 */
async function answerFromBank(questions, cfg) {
  var v = await storageGet('local', BANK_KEY);
  var bank = Array.isArray(v[BANK_KEY]) ? v[BANK_KEY] : [];
  var out = [];
  for (var i = 0; i < questions.length; i++) {
    var q = questions[i];
    var hit = Q.findInBank(bank, q, 0.9);
    out.push(hit ? { id: q.id, answer: hit.a, source: 'bank', confidence: hit.score, reason: '本地题库' } : null);
  }
  return { list: out, bankSize: bank.length };
}

/** AI（OpenAI 兼容 /chat/completions）。 */
async function answerFromAi(questions, cfg) {
  var ai = cfg.ai || {};
  if (!ai.apiKey) throw new Error('还没填 API Key（浏览器工具栏点扩展图标 → 答题 → AI；填好保存后，页面不用刷新，重新点“开始答题”即可）');
  var url = aiEndpoint(ai.baseUrl);
  var messages = Q.buildAiRequest(questions);
  var body = JSON.stringify({
    model: ai.model || DEFAULT_QA.ai.model,
    messages: messages,
    temperature: 0.2,
    max_tokens: 2000,
    stream: false
  });
  var text = await requestJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + String(ai.apiKey).trim()
    },
    body: body
  }, cfg.timeoutMs);

  var data = null;
  try { data = JSON.parse(text); } catch (e) {
    throw new Error('AI 返回的不是 JSON：' + String(text).slice(0, 160));
  }
  if (data && data.error) throw new Error('接口报错：' + (data.error.message || JSON.stringify(data.error).slice(0, 160)));
  var content = data && data.choices && data.choices[0] &&
    (data.choices[0].message ? data.choices[0].message.content : data.choices[0].text);
  if (!content) throw new Error('AI 没有返回内容');

  var parsed = Q.parseAiReply(content);
  var byId = Object.create(null);
  parsed.forEach(function (p) { byId[String(p.id)] = p; });

  var list = questions.map(function (q, i) {
    var p = byId[String(q.id)] || parsed[i];
    if (!p || p.answer == null || p.answer === '') return null;
    return {
      id: q.id,
      answer: String(p.answer),
      source: 'ai',
      confidence: p.confidence || 0,
      reason: p.reason || ''
    };
  });
  return { list: list };
}

function pickByPath(obj, path) {
  if (!path) return obj;
  var parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  var cur = obj;
  for (var i = 0; i < parts.length; i++) {
    if (cur == null) return undefined;
    cur = cur[parts[i]];
  }
  return cur;
}

/**
 * 自动猜答案字段：在返回的 JSON 里找像“答案”的键。
 * 支持的常见形态：{answer}、{data:{answer}}、{data:{list:[{answer}]}}
 */
function huntAnswer(node, depth) {
  if (node == null || depth > 5) return undefined;
  if (Array.isArray(node)) {
    for (var i = 0; i < node.length; i++) {
      var r = huntAnswer(node[i], depth + 1);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  if (typeof node !== 'object') {
    if (typeof node === 'string' && node.trim()) return node;
    return undefined;
  }
  var prefer = ['answer', 'answers', 'correct', 'key', 'result', 'value', 'data', 'msg', 'content'];
  for (var p = 0; p < prefer.length; p++) {
    var k = prefer[p];
    if (node[k] !== undefined) {
      var v = huntAnswer(node[k], depth + 1);
      if (v !== undefined) return v;
    }
  }
  return undefined;
}

/** 自定义题库接口：URL/body 里用 {{q}} {{o}} {{t}} {{token}} 占位。 */
async function answerFromApi(questions, cfg) {
  var api = cfg.api || {};
  if (!api.url) throw new Error('还没填题库接口地址（设置 → 答题 → 题库接口）');
  var headers = { 'Content-Type': 'application/json' };
  if (api.headers) {
    String(api.headers).split(/\r?\n/).forEach(function (line) {
      var m = line.match(/^\s*([^:：]+)\s*[:：]\s*(.+)$/);
      if (m) headers[m[1].trim()] = m[2].trim();
    });
  }
  if (api.token) {
    headers['Authorization'] = /^Bearer\s/i.test(api.token) ? api.token : 'Bearer ' + api.token;
  }

  var out = [];
  for (var i = 0; i < questions.length; i++) {
    var q = questions[i];
    var optionText = (q.options || []).map(function (o) { return o.key + '. ' + o.text; }).join('\n');
    function fill(s) {
      return String(s == null ? '' : s)
        .replace(/\{\{\s*q(?:uestion)?\s*\}\}/gi, q.stem)
        .replace(/\{\{\s*o(?:ptions)?\s*\}\}/gi, optionText)
        .replace(/\{\{\s*t(?:ype)?\s*\}\}/gi, q.type || '')
        .replace(/\{\{\s*token\s*\}\}/gi, api.token || '');
    }
    var url = fill(api.url);
    var method = String(api.method || 'POST').toUpperCase();
    var opts = { method: method, headers: headers };
    if (method !== 'GET' && method !== 'HEAD') {
      opts.body = fill(api.body || '{"question":"{{q}}","options":"{{o}}"}');
    }
    var text = await requestJson(url, opts, cfg.timeoutMs);
    var data = null;
    try { data = JSON.parse(text); } catch (e) { data = text; }
    var ans = api.answerPath ? pickByPath(data, api.answerPath) : huntAnswer(data, 0);
    if (Array.isArray(ans)) ans = ans.join('');
    if (ans == null || ans === '') {
      out.push(null);
    } else {
      out.push({ id: q.id, answer: String(ans).trim().slice(0, 500), source: 'api', confidence: 0.8, reason: '题库接口' });
    }
  }
  return { list: out };
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

var queue = Promise.resolve();

/** 串行执行，避免用户连点两次把额度打光。 */
function serialize(task) {
  var run = queue.then(task, task);
  queue = run.catch(function () {});
  return run;
}

async function resolveOne(questions, cfg, cache) {
  var result = Object.create(null);   // id -> answer entry
  var pending = [];

  questions.forEach(function (q) {
    var h = q.hash || Q.hashQuestion(q.stem, q.options);
    var hit = cache[h];
    if (hit && hit.a) {
      result[q.id] = { id: q.id, answer: hit.a, source: hit.s || 'cache', confidence: hit.c || 0, reason: '缓存' };
    } else {
      pending.push(q);
    }
  });

  var errors = [];
  var needFetch = pending.slice();

  // 1) 先查本地题库（可关）
  if (cfg.bankFirst || cfg.provider === 'bank') {
    try {
      var banked = await answerFromBank(needFetch, cfg);
      var rest = [];
      needFetch.forEach(function (q, i) {
        var hit = banked.list[i];
        if (hit) {
          result[q.id] = hit;
          cachePut(q.hash || Q.hashQuestion(q.stem, q.options), { a: hit.answer, s: 'bank', c: hit.confidence, t: Date.now() });
        } else {
          rest.push(q);
        }
      });
      needFetch = rest;
    } catch (e) { errors.push('题库：' + errText(e)); }
  }

  // 2) 按 provider 取剩下的
  if (needFetch.length && cfg.provider !== 'bank') {
    for (var i = 0; i < needFetch.length; i += cfg.maxBatch) {
      var chunk = needFetch.slice(i, i + cfg.maxBatch);
      try {
        var got = cfg.provider === 'api'
          ? await answerFromApi(chunk, cfg)
          : await answerFromAi(chunk, cfg);
        chunk.forEach(function (q, j) {
          var it = got.list[j];
          if (!it) return;
          result[q.id] = it;
          cachePut(q.hash || Q.hashQuestion(q.stem, q.options), { a: it.answer, s: it.source, c: it.confidence || 0, t: Date.now() });
        });
      } catch (e) {
        errors.push(errText(e));
      }
    }
  } else if (needFetch.length && cfg.provider === 'bank' && !cfg.bankFirst) {
    errors.push('题库里没找到答案');
  }

  var list = questions.map(function (q) { return result[q.id] || null; });
  return { list: list, errors: errors };
}

async function handleAsk(msg) {
  var cfg = await resolvedConfig(msg.config);
  var questions = Array.isArray(msg.questions) ? msg.questions : [];
  if (!questions.length) return { ok: true, answers: [], errors: [] };

  var cache = await loadCache();
  var out = await serialize(function () { return resolveOne(questions, cfg, cache); });
  var answers = out.list.filter(Boolean);
  var missing = questions.filter(function (q) { return !out.list.filter(Boolean).some(function (a) { return a.id === q.id; }); }).map(function (q) { return q.id; });

  return {
    ok: true,
    answers: answers,
    missing: missing,
    errors: out.errors,
    provider: cfg.provider
  };
}

async function handleTest(msg) {
  var cfg = await resolvedConfig(msg.config);
  var demo = [{
    id: 1,
    type: 'single',
    stem: '中华人民共和国成立于哪一年？',
    options: [{ key: 'A', text: '1945年' }, { key: 'B', text: '1949年' }, { key: 'C', text: '1978年' }]
  }];
  try {
    var r = null;
    if (cfg.provider === 'bank') {
      var banked = await answerFromBank(demo, cfg);
      if (!banked.list[0]) throw new Error('题库里没有命中测试题（这是正常的，题库匹配需要真实题目）');
      r = banked.list[0];
    } else if (cfg.provider === 'api') {
      var got = await answerFromApi(demo, cfg);
      if (!got.list[0]) throw new Error('接口返回里没找到答案字段，可尝试填写“答案字段路径”');
      r = got.list[0];
    } else {
      var aiGot = await answerFromAi(demo, cfg);
      r = aiGot.list[0];
      if (!r) throw new Error('AI 返回里没有解析到答案');
    }
    return { ok: true, answer: r.answer, source: r.source };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

/* ------------------------------------------------------------------ *
 * 消息路由
 * ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg !== 'object' || !msg.type) return false;

  var run = null;

  switch (msg.type) {
    case 'vanqa:ask':
      run = handleAsk(msg);
      break;
    case 'vanqa:test':
      run = handleTest(msg);
      break;
    case 'vanqa:bank:get':
      run = storageGet('local', BANK_KEY).then(function (v) {
        return { ok: true, bank: Array.isArray(v[BANK_KEY]) ? v[BANK_KEY] : [] };
      });
      break;
    case 'vanqa:bank:set':
      run = (function () {
        var bank = Array.isArray(msg.bank) ? msg.bank : [];
        var o = {}; o[BANK_KEY] = bank;
        return storageSet('local', o).then(function (ok) { return { ok: ok, count: bank.length }; });
      })();
      break;
    case 'vanqa:bank:clear':
      run = storageSet('local', (function () { var o = {}; o[BANK_KEY] = []; return o; })())
        .then(function () { return { ok: true, count: 0 }; });
      break;
    case 'vanqa:cache:clear':
      run = cacheClear().then(function () { return { ok: true }; });
      break;
    case 'vanqa:state':
      run = Promise.all([storageGet('local', [BANK_KEY, CACHE_KEY]), storageGet('sync', ['qaEnabled'])])
        .then(function (arr) {
          var bank = Array.isArray(arr[0][BANK_KEY]) ? arr[0][BANK_KEY] : [];
          var cache = arr[0][CACHE_KEY] || {};
          return { ok: true, bankSize: bank.length, cacheSize: Object.keys(cache).length };
        });
      break;
    default:
      return false;
  }

  run.then(function (res) {
    try { sendResponse(res); } catch (e) { /* 页面已关闭 */ }
  }).catch(function (e) {
    try { sendResponse({ ok: false, error: errText(e) }); } catch (e2) { /* ignore */ }
  });
  return true;   // 异步回复
});

/* 首次安装时把默认配置写进去，方便用户直接改。 */
chrome.runtime.onInstalled.addListener(function (details) {
  if (details.reason !== 'install') return;
  storageGet('local', CONFIG_KEY).then(function (v) {
    if (v[CONFIG_KEY]) return;
    var o = {}; o[CONFIG_KEY] = DEFAULT_QA;
    storageSet('local', o);
  });
});

/* 1.3.3：以前开了自动答题、却没开“自动运行”的，升级后默认改成自动跑一次。
 * 放在后台每次启动时检查（不只 onInstalled），因为解压加载的扩展重载不一定会触发 update。
 * 只迁移一次：用户后来手动关掉就听用户的。 */
function migrateAutoRun() {
  storageGet('sync', { qaEnabled: false, qaAutoRun: false }).then(function (v) {
    if (!v.qaEnabled || v.qaAutoRun) return;
    return storageGet('local', { qaAutoRunMigrated: false }).then(function (l) {
      if (l.qaAutoRunMigrated) return;
      return storageSet('sync', { qaAutoRun: true }).then(function () {
        return storageSet('local', { qaAutoRunMigrated: true });
      });
    });
  }).catch(function () { /* ignore */ });
}

/* 1.3.9：老用户如果当初没开过“自动提交”，升级后默认帮他们打开一次，
 * 否则填完题还得自己点提交、自己点确认。只迁一次，用户手动关掉就听用户的。 */
function migrateAutoSubmit() {
  storageGet('sync', { qaEnabled: false, qaAutoSubmit: false }).then(function (v) {
    if (!v.qaEnabled || v.qaAutoSubmit) return;
    return storageGet('local', { qaAutoSubmitMigrated: false }).then(function (l) {
      if (l.qaAutoSubmitMigrated) return;
      return storageSet('sync', { qaAutoSubmit: true }).then(function () {
        return storageSet('local', { qaAutoSubmitMigrated: true });
      });
    });
  }).catch(function () { /* ignore */ });
}

migrateAutoRun();
migrateAutoSubmit();
