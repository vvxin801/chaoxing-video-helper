/* 视频播放助手 · popup 逻辑 */
(() => {
  'use strict';

  const C = globalThis.VAN_CONST;
  const QA = globalThis.VAN_QA;
  const DEFAULTS = C.DEFAULT_SETTINGS;
  const CHECKBOXES = [
    'enabled', 'autoNext', 'rememberSpeed', 'resumePosition',
    'visualDetect', 'showHud', 'shortcuts'
  ];
  const QA_CHECKBOXES = ['qaEnabled', 'qaAutoRun', 'qaAutoSubmit', 'qaAutoNext'];
  const QA_FIELDS = [
    'aiBaseUrl', 'aiApiKey', 'aiModel',
    'apiUrl', 'apiMethod', 'apiToken', 'apiBody', 'apiAnswerPath', 'apiHeaders'
  ];

  const $ = (id) => document.getElementById(id);

  let toastTimer = 0;
  function toast(text) {
    const el = $('toast');
    if (!el) return;
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  function save(patch) {
    try {
      chrome.storage.sync.set(patch).then(() => toast('已保存')).catch(() => toast('保存失败'));
    } catch (e) {
      toast('保存失败');
    }
  }

  function fmtClock(seconds) {
    const s = Math.floor(Number(seconds) || 0);
    const m = Math.floor(s / 60);
    return m + ':' + String(s % 60).padStart(2, '0');
  }

  async function activeTab() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      return tabs && tabs[0] ? tabs[0] : null;
    } catch (e) {
      return null;
    }
  }

  /* ================================================================== *
   * 自动连播
   * ================================================================== */

  async function load() {
    let s;
    try {
      s = Object.assign({}, DEFAULTS, await chrome.storage.sync.get(DEFAULTS));
    } catch (e) {
      s = Object.assign({}, DEFAULTS);
    }

    for (const key of CHECKBOXES) {
      const el = $(key);
      if (el) el.checked = !!s[key];
    }
    for (const key of QA_CHECKBOXES) {
      const el = $(key);
      if (el) el.checked = !!s[key];
    }
    if ($('delaySec')) $('delaySec').value = String(s.delaySec);
    if ($('delayVal')) $('delayVal').textContent = s.delaySec + 's';
    if ($('extraSelectors')) $('extraSelectors').value = s.extraSelectors || '';
    if ($('ver')) $('ver').textContent = '自动连播 · v' + C.VERSION;

    refreshStatus();
  }

  async function refreshStatus() {
    const tab = await activeTab();
    if (!tab || !tab.id) return;
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'van:status' });
      if (!res || !res.ok) throw new Error('no response');
      const total = res.videos || 0;
      const childVideos = res.childVideos || 0;
      const pending = typeof res.pending === 'number' ? res.pending : 0;
      if (total) {
        $('status').textContent = '检测到 ' + total + ' 个视频' + (pending ? ' · 还有 ' + pending + ' 个没播完' : ' · 这一节都播完了');
      } else if (childVideos) {
        // 学习通的播放器常在跨域 iframe 里，顶层读不到它，但子页面会把自己的视频数报上来
        $('status').textContent = '视频在子页面里（' + childVideos + ' 个），本页只统计主文档';
      } else {
        $('status').textContent = '本页暂无视频';
      }
      $('media').textContent = res.media && res.media.duration
        ? res.media.speed + '× · ' + fmtClock(res.media.current) + ' / ' + fmtClock(res.media.duration)
        : '—';
      $('badge').textContent = '运行中';
    } catch (e) {
      $('status').textContent = '本页未注入（刷新页面后生效）';
      $('media').textContent = '—';
      $('badge').textContent = '未注入';
    }
  }

  /* ================================================================== *
   * 自动答题设置
   * ================================================================== */

  function deepClone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function mergeQa(raw) {
    const base = deepClone(QA ? QA.DEFAULT_QA_CONFIG : {
      provider: 'ai', bankFirst: true, maxBatch: 6, timeoutMs: 60000,
      ai: { baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-chat' },
      api: { url: '', method: 'POST', headers: '', body: '', answerPath: '', token: '' }
    });
    if (!raw || typeof raw !== 'object') return base;
    for (const k of Object.keys(raw)) {
      if (k === 'ai' || k === 'api') {
        if (raw[k] && typeof raw[k] === 'object') Object.assign(base[k], raw[k]);
      } else if (raw[k] !== undefined) {
        base[k] = raw[k];
      }
    }
    return base;
  }

  let qaConfig = null;

  function fillQaForm() {
    const c = qaConfig;
    if ($('qaProvider')) $('qaProvider').value = c.provider;
    if ($('bankFirst')) $('bankFirst').checked = !!c.bankFirst;
    if ($('aiBaseUrl')) $('aiBaseUrl').value = c.ai.baseUrl || '';
    if ($('aiApiKey')) $('aiApiKey').value = c.ai.apiKey || '';
    if ($('aiModel')) $('aiModel').value = c.ai.model || '';
    if ($('apiUrl')) $('apiUrl').value = c.api.url || '';
    if ($('apiMethod')) $('apiMethod').value = c.api.method || 'POST';
    if ($('apiToken')) $('apiToken').value = c.api.token || '';
    if ($('apiBody')) $('apiBody').value = c.api.body || '';
    if ($('apiAnswerPath')) $('apiAnswerPath').value = c.api.answerPath || '';
    if ($('apiHeaders')) $('apiHeaders').value = c.api.headers || '';
    toggleQaPanels();
  }

  function collectQaForm() {
    const c = qaConfig;
    c.provider = $('qaProvider') ? $('qaProvider').value : c.provider;
    c.bankFirst = $('bankFirst') ? $('bankFirst').checked : c.bankFirst;
    c.ai.baseUrl = $('aiBaseUrl') ? $('aiBaseUrl').value.trim() : c.ai.baseUrl;
    c.ai.apiKey = $('aiApiKey') ? $('aiApiKey').value.trim() : c.ai.apiKey;
    c.ai.model = $('aiModel') ? $('aiModel').value.trim() : c.ai.model;
    c.api.url = $('apiUrl') ? $('apiUrl').value.trim() : c.api.url;
    c.api.method = $('apiMethod') ? $('apiMethod').value : c.api.method;
    c.api.token = $('apiToken') ? $('apiToken').value.trim() : c.api.token;
    c.api.body = $('apiBody') ? $('apiBody').value : c.api.body;
    c.api.answerPath = $('apiAnswerPath') ? $('apiAnswerPath').value.trim() : c.api.answerPath;
    c.api.headers = $('apiHeaders') ? $('apiHeaders').value : c.api.headers;
    return c;
  }

  function saveQa() {
    try {
      chrome.storage.local.set({ qaConfig: collectQaForm() }).catch(() => {});
    } catch (e) { /* ignore */ }
  }

  function toggleQaPanels() {
    const p = $('qaProvider') ? $('qaProvider').value : 'ai';
    if ($('qaAi')) $('qaAi').hidden = p !== 'ai';
    if ($('qaApi')) $('qaApi').hidden = p !== 'api';
  }

  async function loadQa() {
    let raw = null;
    try {
      const v = await chrome.storage.local.get({ qaConfig: null });
      raw = v.qaConfig;
    } catch (e) { raw = null; }
    qaConfig = mergeQa(raw);
    fillQaForm();
    refreshQaStat();
  }

  function sendBg(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(res || { ok: false, error: '后台无响应' });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e && e.message || e) });
      }
    });
  }

  async function refreshQaStat() {
    const res = await sendBg({ type: 'vanqa:state' });
    if ($('qaStat')) {
      $('qaStat').textContent = res && res.ok
        ? '题库 ' + res.bankSize + ' · 缓存 ' + res.cacheSize
        : '—';
    }
  }

  async function refreshQaPage() {
    const tab = await activeTab();
    if (!tab || !tab.id || !$('qaPage')) return;
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'vanqa:status' });
      if (res && res.ok) {
        $('qaPage').textContent = res.count
          ? res.kindLabel + ' · ' + res.count + ' 题 · 已填 ' + res.filled
          : res.kindLabel + ' · 未发现题目';
      } else {
        $('qaPage').textContent = '—';
      }
    } catch (e) {
      $('qaPage').textContent = '非答题页';
    }
  }

  async function importBank(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const bank = QA.parseBankFile(text);
      if (!bank.length) {
        toast('没解析到题目，检查一下格式');
        return;
      }
      const res = await sendBg({ type: 'vanqa:bank:set', bank });
      if (res && res.ok) {
        toast('已导入 ' + bank.length + ' 条');
        refreshQaStat();
      } else {
        toast('导入失败：' + (res && res.error || '未知原因'));
      }
    } catch (e) {
      toast('读文件失败：' + (e && e.message || e));
    }
  }

  function bindQa() {
    for (const key of QA_CHECKBOXES) {
      const el = $(key);
      if (!el) continue;
      el.addEventListener('change', () => {
        const patch = {};
        patch[key] = el.checked;
        save(patch);
      });
    }

    if ($('qaProvider')) {
      $('qaProvider').addEventListener('change', () => { toggleQaPanels(); saveQa(); });
    }
    if ($('bankFirst')) {
      $('bankFirst').addEventListener('change', saveQa);
    }
    for (const id of QA_FIELDS) {
      const el = $(id);
      if (!el) continue;
      el.addEventListener('change', saveQa);
      el.addEventListener('blur', saveQa);
    }

    if ($('qaStart')) {
      $('qaStart').addEventListener('click', async () => {
        const tab = await activeTab();
        if (!tab || !tab.id) { toast('找不到当前标签页'); return; }
        collectQaForm();
        saveQa();
        try {
          const res = await chrome.tabs.sendMessage(tab.id, { type: 'vanqa:start' });
          toast(res && res.ok ? '已开始，看页面左下角' : '这个页面没有答题脚本');
        } catch (e) {
          toast('请在答题页使用（或刷新页面）');
        }
      });
    }

    if ($('qaTest')) {
      $('qaTest').addEventListener('click', async () => {
        collectQaForm();
        saveQa();
        toast('正在测试…');
        const res = await sendBg({ type: 'vanqa:test', config: $('qaProvider').value === 'bank' ? Object.assign({}, qaConfig, { provider: 'bank' }) : qaConfig });
        if (res && res.ok) toast('连接正常，示例答案：' + String(res.answer).slice(0, 20));
        else toast('失败：' + String(res && res.error || '未知错误').slice(0, 60));
      });
    }

    if ($('qaCacheClear')) {
      $('qaCacheClear').addEventListener('click', async () => {
        const res = await sendBg({ type: 'vanqa:cache:clear' });
        toast(res && res.ok ? '缓存已清空' : '清空失败');
        refreshQaStat();
      });
    }

    if ($('qaBankFile')) {
      $('qaBankFile').addEventListener('change', () => {
        const file = $('qaBankFile').files && $('qaBankFile').files[0];
        importBank(file);
        $('qaBankFile').value = '';
      });
    }

    if ($('qaBankClear')) {
      $('qaBankClear').addEventListener('click', async () => {
        if (!confirm('确定清空本地题库？')) return;
        const res = await sendBg({ type: 'vanqa:bank:set', bank: [] });
        toast(res && res.ok ? '题库已清空' : '清空失败');
        refreshQaStat();
      });
    }
  }

  /* ================================================================== *
   * 通用绑定
   * ================================================================== */

  function bind() {
    for (const key of CHECKBOXES) {
      const el = $(key);
      if (!el) continue;
      el.addEventListener('change', () => {
        const patch = {};
        patch[key] = el.checked;
        save(patch);
      });
    }

    const range = $('delaySec');
    if (range) {
      range.addEventListener('input', () => {
        $('delayVal').textContent = range.value + 's';
      });
      range.addEventListener('change', () => save({ delaySec: Number(range.value) }));
    }

    const extra = $('extraSelectors');
    if (extra) {
      extra.addEventListener('change', () => save({ extraSelectors: extra.value }));
    }

    const test = $('testNext');
    if (test) {
      test.addEventListener('click', async () => {
        const tab = await activeTab();
        if (!tab || !tab.id) { toast('找不到当前标签页'); return; }
        try {
          await chrome.tabs.sendMessage(tab.id, { type: 'van:test-next' });
          toast('已发送，注意页面顶部提示');
        } catch (e) {
          toast('当前页面不支持');
        }
      });
    }
  }

  load();
  bind();
  loadQa().then(refreshQaPage);
  bindQa();
})();
