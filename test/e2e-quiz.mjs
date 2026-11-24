/*
 * 端到端测试（自动答题）：启动装了扩展的 Edge，打开模仿学习通章节测验的
 * test/demo-quiz.html，用 CDP 驱动“开始答题”，再检查答案是否填对、交卷是否符合预期。
 *
 *   node test/e2e-quiz.mjs
 *   $env:VAN_HEADLESS="1"                 # 无头模式
 *   $env:VAN_EDGE="D:\\Edge\\msedge.exe"  # 指定浏览器
 *
 * 不需要真实 API Key：脚本自带一个 /mock-ai 接口，页面通过
 * ?vanqa=1&vanqaAi=<mock> 的调试参数指过去（见 content/answer.js 的 debugConfig）。
 *
 * 注意：Chromium 的进程间通信要用命名管道，DSH 的受限沙箱会拒绝（mojo 报 0x5），
 * 所以这个脚本必须在放开沙箱的环境里跑（例如 shell 工具 + danger-full-access）。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const argv = process.argv.slice(2);
const headless = process.env.VAN_HEADLESS === '1' || argv.includes('--headless');
const SHOTS = path.join(here, 'artifacts');

function log(...args) { console.log('[e2e-quiz]', ...args); }
function ok(text) { console.log('  ✓ ' + text); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(fn, { timeout = 20000, interval = 200, label = '条件' } = {}) {
  const t0 = Date.now();
  let lastErr = null;
  for (;;) {
    try {
      if (await fn()) return true;
      lastErr = null;
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() - t0 > timeout) {
      throw new Error('等待超时（' + Math.round((Date.now() - t0) / 1000) + 's）：' + label +
        (lastErr ? '；最后一次错误：' + lastErr.message : ''));
    }
    await sleep(interval);
  }
}

/* ------------------------------------------------------------------ *
 * 静态服务 + 假 AI 接口
 * ------------------------------------------------------------------ */

const MOCK_ANSWERS = [
  { id: 1, answer: 'B', confidence: 0.97, reason: '1949 年 10 月 1 日建国' },
  { id: 2, answer: 'ABD', confidence: 0.9, reason: '价格、补贴、阶梯电价都是需求侧手段' },
  { id: 3, answer: '正确', confidence: 0.95, reason: '标准大气压下水沸点 100℃' },
  { id: 4, answer: '叶绿体|葡萄糖', confidence: 0.86, reason: '光合作用在叶绿体，产物主要是葡萄糖' },
  { id: 5, answer: '需求价格弹性是指需求量变动百分比与价格变动百分比的比值，反映需求量对价格变化的敏感程度。', confidence: 0.8, reason: '定义题' }
];

function serveMockAi(req, res) {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let payload = null;
    try { payload = JSON.parse(body); } catch (e) { /* ignore */ }
    const content = ((payload && payload.messages) || []).map((m) => String(m.content || '')).join('\n');
    if (/地球是平的/.test(content)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: JSON.stringify({ answers: [{ id: 1, answer: '错', confidence: 0.99, reason: '地球近似球体' }] }) } }]
      }));
      return;
    }
    if (/可燃性气体/.test(content)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: JSON.stringify({
          answers: [
            { id: 1, answer: 'D', confidence: 0.9, reason: '汽油蒸气爆炸极限不是 60%-65%' },
            { id: 2, answer: 'B', confidence: 0.92, reason: '低于爆炸下限不会爆炸' }
          ]
        }) } }]
      }));
      return;
    }
    if (/四种安全色/.test(content)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: JSON.stringify({
          answers: [
            { id: 1, answer: 'D', confidence: 0.9, reason: '蓝色表示指令/安全信息，不是“安全状态”' },
            { id: 2, answer: '错', confidence: 0.95, reason: '警告标志共 39 种的说法不对' }
          ]
        }) } }]
      }));
      return;
    }
    if (/蒸馏水/.test(content)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: JSON.stringify({
          answers: [{ id: 1, answer: 'C', confidence: 0.88, reason: '蒸馏不能去除挥发性杂质' }]
        }) } }]
      }));
      return;
    }
    if (/水能变成油/.test(content)) {
      // 故意给错：让插件先交“对”，页面判错后自己换“错”再交
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: JSON.stringify({
          answers: [{ id: 1, answer: '对', confidence: 0.9, reason: 'mock 故意给错' }]
        }) } }]
      }));
      return;
    }
    if (!/中华人民共和国/.test(content)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'mock：请求里没看到题目内容' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: JSON.stringify({ answers: MOCK_ANSWERS }) } }]
    }));
  });
}

function startServer(root) {
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8'
  };
  const server = http.createServer((req, res) => {
    let u = null;
    try { u = new URL(req.url, 'http://127.0.0.1'); } catch (e) { /* ignore */ }
    if (u && u.pathname.indexOf('/mock-ai') === 0) { serveMockAi(req, res); return; }

    let rel = '/demo.html';
    if (u && u.pathname !== '/') rel = decodeURIComponent(u.pathname);
    const file = path.join(root, rel);
    if (!file.startsWith(root)) { res.writeHead(403); res.end('forbidden'); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, {
        'content-type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store'
      });
      res.end(buf);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, base: 'http://127.0.0.1:' + server.address().port });
    });
  });
}

/* ------------------------------------------------------------------ *
 * 极简 CDP 客户端
 * ------------------------------------------------------------------ */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => this.onMessage(String(ev.data)));
  }

  static async connect(url, timeoutMs = 15000) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接 CDP 超时：' + url)), timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('连接 CDP 失败：' + url)); }, { once: true });
    });
    return new CDP(ws);
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  onMessage(text) {
    let msg = null;
    try { msg = JSON.parse(text); } catch (e) { return; }
    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message + (msg.error.data ? '：' + msg.error.data : '')));
      else p.resolve(msg.result);
      return;
    }
    if (!msg.method) return;
    for (const fn of this.listeners.get(msg.method) || []) {
      try { fn(msg.params, msg.sessionId); } catch (e) { /* ignore */ }
    }
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CDP 调用超时：' + method));
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify(payload)); } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  async evaluate(sessionId, expression) {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      const text = d.exception && d.exception.description ? d.exception.description : d.text;
      throw new Error('页面里执行出错：' + text);
    }
    return res.result ? res.result.value : undefined;
  }
}

/* ------------------------------------------------------------------ *
 * 浏览器启动 / 页面操作
 * ------------------------------------------------------------------ */

function findEdge() {
  const list = [
    process.env.VAN_EDGE,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
  ].filter(Boolean);
  for (const p of list) if (fs.existsSync(p)) return p;
  throw new Error('没找到 Edge，请用 VAN_EDGE 环境变量指定 msedge.exe 的路径');
}

async function launchEdge() {
  const exe = findEdge();
  const port = 9200 + Math.floor(Math.random() * 600);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'van-e2e-qa-'));
  const args = [
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    '--load-extension=' + projectRoot,
    '--disable-extensions-except=' + projectRoot,
    '--window-size=1280,900',
    '--window-position=-2400,-2400',
    'about:blank'
  ];
  if (headless) args.unshift('--headless=new', '--disable-gpu');

  const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let tail = '';
  const keepTail = (buf) => { tail = (tail + String(buf)).slice(-6000); };
  child.stdout.on('data', keepTail);
  child.stderr.on('data', keepTail);

  let version = null;
  await waitFor(async () => {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/json/version');
      if (!res.ok) return false;
      version = await res.json();
      return !!version.webSocketDebuggerUrl;
    } catch (e) { return false; }
  }, { timeout: 25000, interval: 200, label: 'Edge 的 CDP 端口可用' });

  return {
    child,
    profile,
    version,
    getTail() { return tail; },
    async close() {
      try { child.kill(); } catch (e) { /* ignore */ }
      await sleep(300);
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
  };
}

/** 页面里内容脚本所在的 isolated world 的 origin 就是扩展 id，导航时顺手记下来。 */
let extensionId = null;

function makePage(cdp, sessionId) {  const evaluate = (expr) => cdp.evaluate(sessionId, expr);
  const wait = (expr, label, opts = {}) => waitFor(() => evaluate(expr), Object.assign({ label }, opts));
  const waitTrue = async (expr, label, opts) => { await wait(expr, label, opts); ok(label); };
  const shot = async (name) => {
    const res = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.mkdirSync(SHOTS, { recursive: true });
    const file = path.join(SHOTS, name);
    fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
    log('截图：' + file);
  };
  const goto = async (url) => {
    await cdp.send('Page.navigate', { url }, sessionId);
    await waitTrue('document.readyState === "complete"', '页面已加载：' + url);
  };
  return { evaluate, wait, waitTrue, shot, goto };
}

const START_BTN = `
  (() => {
    const host = document.getElementById('van-qa');
    const box = host && host.shadowRoot && host.shadowRoot.querySelector('[data-act="start"]');
    if (!box) return false;
    box.click();
    return true;
  })()
`;

/* ------------------------------------------------------------------ *
 * 场景
 * ------------------------------------------------------------------ */

const scenarios = [
  {
    name: 'work',
    title: '章节测验：抓题 → 取答案 → 填答 → 自动交卷',
    async run(page, base, mockUrl) {
      await page.goto(base + '/demo-quiz.html?vanqa=1&vanqaAi=' + encodeURIComponent(mockUrl) + '&vanqaSubmit=1');

      await page.waitTrue('window.__quiz && window.__quiz.count() === 5', '演示页有 5 道题');
      await page.waitTrue('!!document.getElementById("van-qa")', '答题面板已注入');
      await page.shot('qa-panel.png');

      await page.waitTrue(START_BTN, '点了“开始答题”');
      await page.waitTrue('window.__quiz.filled() === 5', '5 道题都已填上', { timeout: 30000 });

      const values = await page.evaluate('JSON.stringify(window.__quiz.values())');
      const v = JSON.parse(values);
      const assert = (cond, text) => { if (!cond) throw new Error('答案不对：' + text); ok(text); };

      assert(v[0].picked.join('') === 'B', '单选选中 B（1949年）');
      assert(v[1].picked.join('') === 'ABD', '多选选中 A、B、D');
      assert(v[2].picked.join('') === 'A', '判断题选中“正确”');
      assert(v[3].texts[0] === '叶绿体' && v[3].texts[1] === '葡萄糖', '填空题两个空分别填对');
      assert(v[4].texts[0].indexOf('需求价格弹性') !== -1, '简答题写了答案');

      await page.waitTrue('window.__quiz.submitted() === 1', '填完后自动点了“提交”', { timeout: 15000 });
      await page.waitTrue('window.__nextClicked === 1', '交完后自动点了“下一节”', { timeout: 15000 });
      ok('交完自动切到下一节');
      await page.shot('qa-filled.png');
    }
  },
  {
    name: 'slowconfirm',
    title: '确认框晚 1.8 秒才弹：等它、点掉，再自动下一节',
    async run(page, base, mockUrl) {
      await page.goto(base + '/demo-quiz.html?vanqa=1&vanqaAi=' + encodeURIComponent(mockUrl) + '&vanqaSubmit=1&slow=1');
      await page.waitTrue('window.__quiz && window.__quiz.count() === 5', '演示页有 5 道题');
      await page.waitTrue(START_BTN, '点了“开始答题”');
      await page.waitTrue('window.__quiz.filled() === 5', '5 道题都已填上', { timeout: 30000 });
      // 提交按钮点下去后，确认框 1.8 秒才出现；插件不能在这之前就判“没反应”
      await page.waitTrue('window.__quiz.submitted() === 1', '晚到的确认框也被点掉了', { timeout: 20000 });
      await page.waitTrue('window.__nextClicked === 1', '交完后自动点了“下一节”', { timeout: 20000 });
      await page.shot('qa-slow-confirm.png');
    }
  },
  {
    name: 'cqconfirm',
    title: '学习通原生 .popDiv 弹层：认出“确认提交？”并点掉',
    async run(page, base, mockUrl) {
      await page.goto(base + '/demo-quiz.html?vanqa=1&vanqaAi=' + encodeURIComponent(mockUrl) + '&vanqaSubmit=1&cq=1');
      await page.waitTrue('window.__quiz && window.__quiz.count() === 5', '演示页有 5 道题');
      await page.waitTrue(START_BTN, '点了“开始答题”');
      await page.waitTrue('window.__quiz.filled() === 5', '5 道题都已填上', { timeout: 30000 });
      await page.waitTrue('window.__quiz.submitted() === 1', '.popDiv 里的“提交”被自动点了', { timeout: 20000 });
      await page.waitTrue('window.__nextClicked === 1', '交完后自动点了“下一节”', { timeout: 20000 });
      await page.shot('qa-popdiv-confirm.png');
    }
  },
  {
    name: 'videoquiz',
    title: '视频弹题：无 input 的选项 → 点选 → 提交弹题',
    async run(page, base, mockUrl) {
      await page.goto(base + '/demo-videoquiz.html?vanqa=1&vanqaAi=' + encodeURIComponent(mockUrl) + '&vanqaSubmit=1');

      await page.waitTrue('!!(window.__quiz && window.__quiz.shown())', '弹题已经弹出来');
      await page.waitTrue('!!document.getElementById("van-qa")', '弹题出现后面板自动挂上');
      await page.shot('qa-videoquiz-panel.png');

      await page.waitTrue(`
        (() => {
          const host = document.getElementById('van-qa');
          const el = host && host.shadowRoot && host.shadowRoot.querySelector('.kind');
          return !!el && el.textContent.indexOf('弹题') !== -1;
        })()
      `, '面板识别为“视频弹题”', { timeout: 10000 });

      const kind = await page.evaluate(`
        (() => {
          const host = document.getElementById('van-qa');
          const el = host && host.shadowRoot && host.shadowRoot.querySelector('.kind');
          return el ? el.textContent : '';
        })()
      `);
      ok('面板显示类型：' + kind.trim());

      await page.waitTrue(START_BTN, '点了“开始答题”');
      await page.waitTrue('window.__quiz.filled()', '弹题选项被选中', { timeout: 30000 });

      const picked = await page.evaluate('window.__quiz.selected()');
      if (picked.indexOf('错') === -1) throw new Error('选错了选项：' + picked);
      ok('选中了“' + picked + '”');

      await page.waitTrue('window.__quiz.submitted() >= 1', '弹题已提交', { timeout: 15000 });
      await page.shot('qa-videoquiz-done.png');
    }
  },
  {
    name: 'videoquizretry',
    title: '视频弹题答错：自动换一个选项再交，直到答对',
    async run(page, base, mockUrl) {
      await page.goto(base + '/demo-videoquiz-retry.html?vanqa=1&vanqaAi=' + encodeURIComponent(mockUrl) + '&vanqaSubmit=1');

      await page.waitTrue('!!(window.__quiz && window.__quiz.shown())', '弹题已经弹出来');
      await page.waitTrue('!!document.getElementById("van-qa")', '弹题出现后面板自动挂上');
      await page.waitTrue(START_BTN, '点了“开始答题”');

      // AI 给的是“对”，页面判错；插件应该换“错”再交
      await page.waitTrue('window.__quiz.attempts() >= 2', '答错后自动换答案重交', { timeout: 30000 });
      const picked = await page.evaluate('window.__quiz.selected()');
      if (picked.indexOf('错') === -1) throw new Error('没有换到正确选项：' + picked);
      ok('换到了“' + picked + '”并答对');
      await page.waitTrue('window.__quiz.submitted() >= 1', '最终答对、弹题关闭', { timeout: 15000 });
      await page.shot('qa-videoquiz-retry.png');
    }
  },
  {
    name: 'newquiz',
    title: '新版章节测验：无 input、靠文本结构解析',
    async run(page, base, mockUrl) {
      await page.goto(base + '/demo-newquiz.html?vanqa=1&vanqaAi=' + encodeURIComponent(mockUrl) + '&vanqaSubmit=1');

      await page.waitTrue('window.__quiz && window.__quiz.count() === 2', '新版演示页有 2 道题');
      await page.waitTrue('!!document.getElementById("van-qa")', '答题面板已注入');
      await page.waitTrue(START_BTN, '点了“开始答题”');
      await page.waitTrue('window.__quiz.filled() === 2', '2 道题都已填上', { timeout: 30000 });

      const values = JSON.parse(await page.evaluate('JSON.stringify(window.__quiz.values())'));
      if (values[0].picked.join('') !== 'D') throw new Error('多选没选中 D：' + JSON.stringify(values[0]));
      ok('多选选中 D');
      if (values[1].picked.join('') !== 'B') throw new Error('判断没选中“错”：' + JSON.stringify(values[1]));
      ok('判断选中“错”');

      await page.waitTrue('window.__quiz.submitted() === 1', '填完后自动点了“提交”', { timeout: 15000 });
      await page.shot('qa-newquiz-filled.png');
      await page.shot('qa-newquiz-filled.png');
    }
  },
  {
    name: 'textquiz',
    title: '文字流页面：题干和选项是平级 div，按文字顺序解析',
    async run(page, base, mockUrl) {
      await page.goto(base + '/demo-textquiz.html?vanqa=1&vanqaAi=' + encodeURIComponent(mockUrl) + '&vanqaSubmit=1');

      await page.waitTrue('window.__quiz && window.__quiz.count() === 2', '演示页有 2 道题');
      await page.waitTrue('!!document.getElementById("van-qa")', '答题面板已注入');
      await page.waitTrue(START_BTN, '点了“开始答题”');
      await page.waitTrue('window.__quiz.filled() === 2', '2 道题都已填上', { timeout: 30000 });

      const values = JSON.parse(await page.evaluate('JSON.stringify(window.__quiz.values())'));
      if (values[0].picked.join('') !== 'D') throw new Error('单选没选中 D：' + JSON.stringify(values[0]));
      ok('单选选中 D');
      if (values[1].picked.join('') !== 'B') throw new Error('判断没选中“错”：' + JSON.stringify(values[1]));
      ok('判断选中“错”');

      await page.waitTrue('window.__quiz.submitted() === 1', '填完后自动点了“提交”', { timeout: 15000 });
      await page.shot('qa-textquiz.png');
    }
  },
  {
    name: 'iframequiz',
    title: '跨域 iframe 里的测验：外层读不到 DOM，子页面自己作答并提交',
    async run(page, base, mockUrl) {
      await page.goto(base + '/demo-iframe-cross.html?vanqa=1&vanqaAi=' + encodeURIComponent(mockUrl) + '&vanqaSubmit=1');
      await page.waitTrue(
        'document.getElementById("quizFrame") && document.getElementById("quizFrame").src.indexOf("localhost") !== -1',
        'iframe 已指向跨域地址'
      );
      await page.waitTrue('window.__childSubmitted >= 1', '子页面里自动答完并提交', { timeout: 40000 });
      await page.shot('qa-iframe-cross.png');
    }
  },
  {
    name: 'parentconfirm',
    title: '确认框在外层：题目在 iframe 里，外层没有题目文字也要能点掉',
    async run(page, base, mockUrl, ctx) {
      // 外层不带 vanqa 参数，只能靠 chrome.storage 里的开关起作用（和真实页面一样）
      await ctx.ensureQaEnabled();
      await page.goto(base + '/demo-parent-confirm.html?vanqaAi=' + encodeURIComponent(mockUrl));
      await page.waitTrue('window.__layerShown >= 1', '子页面交卷后外层弹出确认框', { timeout: 40000 });
      const hasPanel = await page.evaluate('!!document.getElementById("van-qa")');
      if (hasPanel) throw new Error('外层没有题目，不该挂答题面板');
      try {
        await page.waitTrue('window.__submitted === 1', '外层的确认框被自动点掉', { timeout: 20000 });
      } catch (e) {
        const st = await page.evaluate('JSON.stringify(document.documentElement.dataset)');
        throw new Error(e.message + '；外层状态：' + st);
      }
      ok('外层的“确认提交?”被自动点了（外层自己没有题目）');
      await page.waitTrue('window.__nextClicked === 1', '外层帮忙点了“下一节”', { timeout: 20000 });
      ok('外层帮忙点了“下一节”');
      await page.shot('qa-parent-confirm.png');
    }
  },
  {
    name: 'siblingconfirm',
    title: '确认框在兄弟 iframe：题目在左边，弹框在右边，靠顶层转发消息点掉',
    async run(page, base, mockUrl, ctx) {
      // 外层和“弹框 iframe”都没有 vanqa 参数，全靠扩展设置
      await ctx.ensureQaEnabled();
      await page.goto(base + '/demo-sibling-confirm.html?vanqaAi=' + encodeURIComponent(mockUrl));
      await page.waitTrue('window.__layerShown >= 1', '题目提交后兄弟 iframe 弹出确认框', { timeout: 40000 });
      await page.waitTrue(
        'document.getElementById("layer").contentDocument && document.getElementById("layer").contentDocument.defaultView.__shown >= 1',
        '兄弟 iframe 里的确认框已显示'
      );
      await page.waitTrue('window.__confirmed === 1', '兄弟 iframe 的确认框被自动点掉', { timeout: 20000 });
      ok('兄弟 iframe 的“确认提交?”被自动点了');
      await page.shot('qa-sibling-confirm.png');
    }
  },
  {
    name: 'autoplay',
    title: '答题切到下一节后，新页面的视频自动开始播放',
    async run(page, base, mockUrl, ctx) {
      // 播放器 autoplay=0，只有扩展“催播”才会动
      await ctx.ensureQaEnabled(true);
      await page.goto(base + '/demo-waiting-video.html');
      await page.waitTrue('!!document.getElementById("van-hud")', '扩展已注入（悬浮面板出现）');
      await page.waitTrue('window.__playing === true', '视频自动开始播放（不用手点播放按钮）', { timeout: 25000 });
      ok('视频页不用手点，自己按了播放');
      await page.shot('qa-autoplay.png');
    }
  },
  {
    name: 'autoplaycross',
    title: '播放器在跨域 iframe 里：切节后也要自己按播放',
    async run(page, base, mockUrl, ctx) {
      await ctx.ensureQaEnabled(true);
      await page.goto(base + '/demo-waiting-video-cross.html');
      await page.waitTrue('window.__childLoaded === true', '跨域播放器已加载');
      try {
        await page.waitTrue('window.__playing === true', '跨域 iframe 里的视频自动开播', { timeout: 30000 });
      } catch (e) {
        const st = await page.evaluate('String(window.__childStatus || "")');
        const msgs = await page.evaluate('JSON.stringify(window.__msgs || [])');
        const evs = await page.evaluate('JSON.stringify(window.__childEvents || [])');
        throw new Error(e.message + '；播放器状态：' + st + '；事件：' + evs + '；消息：' + msgs);
      }
      ok('跨域播放器自己按了播放');
      await page.shot('qa-autoplay-cross.png');
    }
  },
  {
    name: 'circlequiz',
    title: '单选题：选项字母是伪元素、没有 input，按排列顺序认选项',
    async run(page, base, mockUrl) {
      await page.goto(base + '/demo-circlequiz.html?vanqa=1&vanqaAi=' + encodeURIComponent(mockUrl) + '&vanqaSubmit=1');

      await page.waitTrue('window.__quiz && window.__quiz.count() === 1', '演示页有 1 道单选题');
      await page.waitTrue('!!document.getElementById("van-qa")', '答题面板已注入');
      await page.waitTrue(START_BTN, '点了“开始答题”');
      await page.waitTrue('window.__quiz.filled() === 1', '单选题填上了', { timeout: 30000 });

      const picked = JSON.parse(await page.evaluate('JSON.stringify(window.__picked)'));
      if (picked.join('') !== 'C') throw new Error('没选中第三项 C：' + JSON.stringify(picked));
      ok('单选选中 C（第三行）');

      await page.waitTrue('window.__quiz.submitted() >= 1', '填完后自动提交', { timeout: 15000 });
      await page.shot('qa-circlequiz.png');
    }
  },
  {
    name: 'exam',
    title: '考试页：只填答案，绝不自动交卷',
    async run(page, base, mockUrl) {
      await page.goto(base + '/demo-quiz.html?mode=exam&vanqa=1&vanqaAi=' + encodeURIComponent(mockUrl) + '&vanqaSubmit=1');

      await page.waitTrue('window.__quiz && window.__quiz.exam === true', '演示页是考试模式');
      await page.waitTrue('!!document.getElementById("van-qa")', '考试页也出现了答题面板');
      await page.waitTrue(START_BTN, '点了“开始答题”');
      await page.waitTrue('window.__quiz.filled() === 5', '5 道题都已填上', { timeout: 30000 });

      await sleep(3000);
      const submitted = await page.evaluate('window.__quiz.submitted()');
      if (submitted !== 0) throw new Error('考试页居然自动交卷了（submitted=' + submitted + '）');
      const nextClicked = await page.evaluate('window.__nextClicked');
      if (nextClicked !== 0) throw new Error('考试页居然自动切下一节了（nextClicked=' + nextClicked + '）');
      ok('等了 3 秒，考试页没有自动交卷，也没有切下一节');

      const logText = await page.evaluate(`
        (() => {
          const host = document.getElementById('van-qa');
          const box = host && host.shadowRoot && host.shadowRoot.querySelector('.log');
          return box ? box.textContent : '';
        })()
      `);
      if (!/考试/.test(logText)) throw new Error('面板日志里没有提示“考试”字样：' + logText);
      ok('面板说明了考试页不自动交卷');
    }
  }
];

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  const { server, base } = await startServer(here);
  const mockUrl = base + '/mock-ai/v1/chat/completions';
  log('静态服务：' + base);
  log('扩展目录：' + projectRoot);
  log('模式：' + (headless ? '无头' : '有窗口'));

  let browser = null;
  let cdp = null;
  const errors = [];

  try {
    browser = await launchEdge();
    log('Edge：' + (browser.version.Browser || '?'));
    cdp = await CDP.connect(browser.version.webSocketDebuggerUrl);

    cdp.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails || {};
      errors.push((d.exception && d.exception.description) || d.text || '未捕获异常');
    });
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type !== 'error' && p.type !== 'assert') return;
      const text = (p.args || []).map((a) => a.value || a.description || '').join(' ');
      if (/Failed to load resource/i.test(text)) return;
      errors.push('console.error: ' + text);
    });

    // 真实用户是在设置里打开的；e2e 里没有“设置页”可点，个别场景需要它
    // （外层确认框那个页面没有 vanqa 调试参数），就临时打开扩展 popup 写一次 storage。
    async function ensureQaEnabled(withAutoPlay) {
      if (!extensionId) {
        // 内容脚本在 ?vanqa=1 时会把扩展 id 写到 <html data-vanqa-id>，借它拿 id。
        const tab = await cdp.send('Target.createTarget', { url: base + '/demo-quiz.html?vanqa=1' });
        const { sessionId: probeSession } = await cdp.send('Target.attachToTarget', { targetId: tab.targetId, flatten: true });
        await cdp.send('Runtime.enable', {}, probeSession);
        let gotId = '';
        await waitFor(async () => {
          const r = await cdp.send('Runtime.evaluate', {
            expression: 'document.documentElement.dataset.vanqaId || ""',
            returnByValue: true
          }, probeSession);
          gotId = (r.result && r.result.value) || '';
          return !!gotId;
        }, { timeout: 15000, label: '内容脚本写出的扩展 id' });
        await cdp.send('Target.closeTarget', { targetId: tab.targetId });
        extensionId = gotId;
        log('扩展 id：' + extensionId);
      }
      const popup = await cdp.send('Target.createTarget', { url: 'chrome-extension://' + extensionId + '/popup/popup.html' });
      const { sessionId: popupSession } = await cdp.send('Target.attachToTarget', { targetId: popup.targetId, flatten: true });
      await cdp.send('Runtime.enable', {}, popupSession);
      await waitFor(async () => {
        const r = await cdp.send('Runtime.evaluate', {
          expression: 'typeof chrome !== "undefined" && !!chrome.storage && !!chrome.storage.sync',
          returnByValue: true
        }, popupSession);
        return !!(r.result && r.result.value);
      }, { timeout: 10000, label: '扩展 popup 里的 chrome.storage 可用' });
      await cdp.send('Runtime.evaluate', {
        expression: 'chrome.storage.sync.set({qaEnabled:true,qaAutoRun:true,qaAutoSubmit:true,qaAutoNext:true})',
        awaitPromise: true
      }, popupSession);
      if (withAutoPlay) {
        // 模拟答题模块刚点完“下一节”，视频模块据此自动按播放
        await cdp.send('Runtime.evaluate', {
          expression: 'chrome.storage.local.set({vanAutoPlayAt: Date.now()})',
          awaitPromise: true
        }, popupSession);
      }
      await cdp.send('Target.closeTarget', { targetId: popup.targetId });
      log('已把答题开关写进扩展 storage');
    }

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);

    const page = makePage(cdp, sessionId);

    for (const s of scenarios) {
      log('—— 场景 ' + s.name + '：' + s.title);
      const before = errors.length;
      const t0 = Date.now();
      await s.run(page, base, mockUrl, { ensureQaEnabled });
      const added = errors.slice(before);
      if (added.length) {
        console.log('  运行期间出现的错误：');
        for (const e of added) console.log('   - ' + e);
        throw new Error('场景 ' + s.name + ' 出现了 JS 错误');
      }
      ok('场景 ' + s.name + ' 通过（' + ((Date.now() - t0) / 1000).toFixed(1) + 's）');
    }

    log('全部通过：' + scenarios.length + ' 个场景');
    return 0;
  } catch (err) {
    console.error('[e2e-quiz] ✗ 失败：' + (err && err.message ? err.message : err));
    if (browser && browser.getTail()) {
      console.error('[e2e-quiz] Edge 日志尾部：');
      console.error(browser.getTail().split('\n').slice(-20).join('\n'));
    }
    return 1;
  } finally {
    try { if (cdp) await cdp.send('Browser.close'); } catch (e) { /* ignore */ }
    if (browser) await browser.close();
    server.close();
  }
}

main().then((code) => { process.exitCode = code; }).catch((err) => {
  console.error('[e2e-quiz] ✗ 未处理的错误：', err);
  process.exitCode = 1;
});
