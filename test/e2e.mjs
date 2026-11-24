/*
 * 端到端测试：真的启动一个装了扩展的 Edge，用 CDP 驱动演示页。
 *
 *   node test/e2e.mjs                    # 四个场景都跑
 *   node test/e2e.mjs --scenario=multi   # 只跑其中一个（single / multi / start / nested）
 *   $env:VAN_HEADLESS="1"                # 无头模式
 *   $env:VAN_EDGE="D:\\Edge\\msedge.exe" # 指定浏览器
 *
 * 场景：
 *   single  一个视频：播完 → 倒计时 → 自动点“下一集”
 *   multi   同一小节 3 个视频：前两个只在本节内接力，第 3 个播完才跳下一节
 *   start   从第 2 个视频开始看：只往后接，第 1 个不会被翻回去播；新小节从第 1 个重新开始
 *   nested  三层 iframe（页面 → 小节页 → 视频）：中间层没有视频，也要能逐层问出来
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
const only = (argv.find((a) => a.startsWith('--scenario=')) || '').split('=')[1] || '';
const headless = process.env.VAN_HEADLESS === '1' || argv.includes('--headless');
const SHOTS = path.join(here, 'artifacts');

function log(...args) { console.log('[e2e]', ...args); }
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
 * 静态文件服务
 * ------------------------------------------------------------------ */

function startServer(root) {
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml'
  };
  const server = http.createServer((req, res) => {
    let rel = '/demo.html';
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/') rel = decodeURIComponent(u.pathname);
    } catch (e) { /* ignore */ }
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
 * 极简 CDP 客户端（Node 自带 WebSocket，够用）
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
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    }, sessionId);
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      const text = d.exception && d.exception.description ? d.exception.description : d.text;
      throw new Error('页面里执行出错：' + text);
    }
    return res.result ? res.result.value : undefined;
  }
}

/* ------------------------------------------------------------------ *
 * 浏览器启动
 * ------------------------------------------------------------------ */

function findEdge() {
  const list = [
    process.env.VAN_EDGE,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
  ].filter(Boolean);
  for (const p of list) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('没找到 Edge，请用 VAN_EDGE 环境变量指定 msedge.exe 的路径');
}

async function launchEdge() {
  const exe = findEdge();
  const port = 9200 + Math.floor(Math.random() * 600);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'van-e2e-'));
  const args = [
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    '--load-extension=' + projectRoot,
    '--disable-extensions-except=' + projectRoot,
    '--window-size=1280,800',
    '--window-position=-2400,-2400',
    'about:blank'
  ];
  if (headless) args.unshift('--headless=new', '--disable-gpu');

  const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let tail = '';
  const keepTail = (buf) => {
    tail = (tail + String(buf)).slice(-6000);
  };
  child.stdout.on('data', keepTail);
  child.stderr.on('data', keepTail);

  let version = null;
  await waitFor(async () => {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/json/version');
      if (!res.ok) return false;
      version = await res.json();
      return !!version.webSocketDebuggerUrl;
    } catch (e) {
      return false;
    }
  }, { timeout: 25000, interval: 200, label: 'Edge 的 CDP 端口可用' });

  return {
    child,
    profile,
    version,
    async close() {
      try { child.kill(); } catch (e) { /* ignore */ }
      await sleep(300);
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    },
    getTail() { return tail; }
  };
}

/* ------------------------------------------------------------------ *
 * 页面操作小工具
 * ------------------------------------------------------------------ */

function makePage(cdp, sessionId) {
  const evaluate = (expr) => cdp.evaluate(sessionId, expr);
  const wait = (expr, label, opts = {}) =>
    waitFor(() => evaluate(expr), Object.assign({ label }, opts));
  const waitTrue = async (expr, label) => {
    await wait(expr, label);
    ok(label);
  };
  const shot = async (name) => {
    const res = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.mkdirSync(SHOTS, { recursive: true });
    const file = path.join(SHOTS, name);
    fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
    log('截图：' + file);
    return file;
  };
  const goto = async (url) => {
    await cdp.send('Page.navigate', { url }, sessionId);
    await waitTrue('document.readyState === "complete"', '页面已加载：' + url);
  };
  return { evaluate, wait, waitTrue, shot, goto };
}

/* ------------------------------------------------------------------ *
 * 场景
 * ------------------------------------------------------------------ */

const VIDEO_IN = (sel) => `
  (() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const d = el.contentDocument;
    if (!d) return null;
    const v = d.querySelector('video');
    if (!v) return null;
    return { paused: v.paused, ended: v.ended, t: v.currentTime, d: v.duration || 0 };
  })()
`;

const NESTED_VIDEO = (frameSel, slotSel) => `
  (() => {
    const outer = document.querySelector(${JSON.stringify(frameSel)});
    if (!outer || !outer.contentDocument) return null;
    const slot = outer.contentDocument.querySelector(${JSON.stringify(slotSel)});
    if (!slot || !slot.contentDocument) return null;
    const v = slot.contentDocument.querySelector('video');
    if (!v) return null;
    return { paused: v.paused, ended: v.ended, t: v.currentTime, d: v.duration || 0 };
  })()
`;

const OVERLAY_SHOWN = `
  (() => {
    const o = document.getElementById('van-overlay');
    const box = o && o.shadowRoot && o.shadowRoot.querySelector('.box');
    return !!(box && box.classList.contains('show'));
  })()
`;

/** 把取状态的表达式包成“永不为空”的对象，方便拼条件。 */
const vs = (sel) => '((' + VIDEO_IN(sel) + ') || {})';
const nvs = (frameSel, slotSel) => '((' + NESTED_VIDEO(frameSel, slotSel) + ') || {})';

const scenarios = [
  {
    name: 'single',
    title: '一个视频：播完自动切下一集',
    async run(page, base) {
      await page.goto(base + '/demo.html?vanDelay=2&lesson=1');

      await page.waitTrue('!!document.getElementById("van-hud")', '扩展已注入（悬浮面板出现）');
      await page.wait(vs('#frame') + '.d > 0', '演示视频已出现');
      await page.waitTrue(vs('#frame') + '.paused === false && ' + vs('#frame') + '.t > 0.2',
        '演示视频已开始播放');
      await page.shot('hud.png');

      await page.waitTrue(OVERLAY_SHOWN, '视频结束后出现倒计时条');
      await page.shot('countdown.png');

      await page.waitTrue('window.__demo && window.__demo.lesson() === 2', '倒计时结束后自动切换到下一集');
      await page.waitTrue(vs('#frame') + '.paused === false && ' + vs('#frame') + '.ended === false',
        '下一集的视频已经开始播放');
    }
  },
  {
    name: 'multi',
    title: '同一小节 3 个视频：先在本节内接力，都播完才跳下一节',
    async run(page, base) {
      await page.goto(base + '/demo-multi.html?vanDelay=1');

      await page.waitTrue('window.__demo && window.__demo.count() === 3', '这一节里有 3 个视频');
      await page.waitTrue('(() => { const v = document.querySelectorAll("video")[0]; return v && !v.paused && v.currentTime > 0.2; })()',
        '第 1 个视频开始播放');

      await page.waitTrue('(() => { const v = document.querySelectorAll("video")[1]; return v && !v.paused && !v.ended && v.currentTime > 0.2; })()',
        '第 1 个播完后，第 2 个自动接着播');
      await page.waitTrue('window.__demo.nextClicks() === 0', '这时还没有跳到下一节');

      await page.waitTrue('(() => { const v = document.querySelectorAll("video")[2]; return v && !v.paused && !v.ended && v.currentTime > 0.2; })()',
        '第 2 个播完后，第 3 个自动接着播');
      await page.waitTrue('window.__demo.nextClicks() === 0', '第 3 个在播时，仍然没有跳到下一节');
      await page.shot('multi.png');

      await page.waitTrue('(() => window.__demo.statuses().every((t) => t === "已结束"))()',
        '离开这一节之前，3 个视频都是已结束状态');
      await page.waitTrue('window.__demo.nextClicks() === 1 && window.__demo.lesson() === 2',
        '3 个都播完，才自动点了“下一节”', { timeout: 30000 });
      await page.waitTrue('window.__demo.count() === 2', '第 2 小节换成了新的一组视频');
    }
  },
  {
    name: 'start',
    title: '从当前视频往后连播；下一小节从第 1 个视频重新开始',
    async run(page, base) {
      await page.goto(base + '/demo-multi.html?start=2&vanDelay=1');

      await page.waitTrue('window.__demo && window.__demo.count() === 3', '这一节里有 3 个视频');
      await page.waitTrue('window.__demo.startIndex() === 2', '演示页从第 2 个视频开始播');
      await page.waitTrue('window.__demo.playing().join() === "2"', '第 2 个视频在播，第 1 个没被碰');

      await page.waitTrue('window.__demo.playing().join() === "3"',
        '第 2 个播完后，接着播它后面的第 3 个');
      await page.waitTrue('window.__demo.played().join() === "2,3"',
        '第 1 个视频自始至终没有被翻回去播');
      await page.waitTrue('window.__demo.nextClicks() === 0', '这一节还没播完，没有跳下一节');

      await page.waitTrue('window.__demo.nextClicks() === 1 && window.__demo.lesson() === 2',
        '这一节播完，自动点了“下一节”', { timeout: 30000 });
      await page.waitTrue('window.__demo.count() === 2', '第 2 小节换成了新的 2 个视频');

      await page.waitTrue('window.__demo.playing().join() === "1"',
        '新小节的第 1 个视频被自动放起来了（它自己不会播）', { timeout: 20000 });
      await page.waitTrue('window.__demo.playing().join() === "2"',
        '第 1 个播完后，第 2 个接着播', { timeout: 20000 });
      await page.shot('start.png');
    }
  },
  {
    name: 'nested',
    title: '三层 iframe：中间层没有视频，逐层问出还有没播完的',
    async run(page, base) {
      await page.goto(base + '/demo-nested.html?vanDelay=1');

      await page.waitTrue('(() => { const f = document.querySelector("#frame"); return !!(f && f.contentDocument && f.contentDocument.querySelectorAll("iframe").length === 2); })()',
        '小节页里嵌入了 2 个视频 iframe');

      await page.waitTrue(nvs('#frame', '#f1') + '.paused === false && ' + nvs('#frame', '#f1') + '.t > 0.2',
        '最里层的第 1 个视频开始播放');

      await page.waitTrue(nvs('#frame', '#f2') + '.paused === false && ' + nvs('#frame', '#f2') + '.ended === false && ' + nvs('#frame', '#f2') + '.t > 0.2',
        '第 1 个播完后，中间层让第 2 个 iframe 的视频接着播');
      await page.waitTrue('window.__demo.nextClicks() === 0', '这时还没有跳到下一节');

      await page.waitTrue('window.__demo.nextClicks() === 1 && window.__demo.lesson() === 2',
        '两个都播完，才自动点了“下一节”', { timeout: 40000 });
    }
  }
];

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  const list = only ? scenarios.filter((s) => s.name === only) : scenarios;
  if (!list.length) throw new Error('未知场景：' + only + '（可选：' + scenarios.map((s) => s.name).join(' / ') + '）');

  const { server, base } = await startServer(here);
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
    cdp.on('Log.entryAdded', (p) => {
      const e = p.entry || {};
      if (e.source === 'network') return;
      if (/Failed to load resource/i.test(e.text || '')) return;
      if (e.level === 'error') errors.push('log: ' + (e.text || ''));
    });

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Log.enable', {}, sessionId);

    const page = makePage(cdp, sessionId);

    for (const s of list) {
      log('—— 场景 ' + s.name + '：' + s.title);
      const before = errors.length;
      const t0 = Date.now();
      await s.run(page, base);
      const added = errors.slice(before);
      if (added.length) {
        console.log('  运行期间出现的错误：');
        for (const e of added) console.log('   - ' + e);
        throw new Error('场景 ' + s.name + ' 出现了 JS 错误');
      }
      ok('场景 ' + s.name + ' 通过（' + ((Date.now() - t0) / 1000).toFixed(1) + 's，没有任何 JS 错误）');
    }

    console.log('');
    log('全部通过：' + list.length + ' 个场景');
    return 0;
  } catch (err) {
    console.error('');
    console.error('[e2e] ✗ 失败：' + (err && err.message ? err.message : err));
    if (browser && browser.getTail()) {
      console.error('[e2e] Edge 日志尾部：');
      console.error(browser.getTail().split('\n').slice(-25).join('\n'));
    }
    return 1;
  } finally {
    try { if (cdp) await cdp.send('Browser.close'); } catch (e) { /* ignore */ }
    if (browser) await browser.close();
    server.close();
  }
}

main().then((code) => {
  process.exitCode = code;
}).catch((err) => {
  console.error('[e2e] ✗ 未处理的错误：', err);
  process.exitCode = 1;
});
