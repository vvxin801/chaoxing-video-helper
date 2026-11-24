/*
 * 视频播放助手 · 内容脚本
 *
 * 设计要点：
 * 1. 每个 frame 都会注入（manifest 里 all_frames: true）。视频常常在跨域 iframe 里，
 *    而“下一集”按钮往往在外层页面，所以用 postMessage 在 frame 之间协作：
 *    视频所在 frame 报告 ended → 顶层 frame 显示倒计时 → 广播 GO → 每个 frame 各自找“下一集”并点击。
 * 2. 判定“下一集”不靠单一选择器，而是收集候选元素后统一打分（见 shared/pure.js），
 *    再对最高分的 3 个候选依次“点击 + 验证”，验证是根据 URL 变化 / 视频重载来判断的。
 * 3. 不伪造任何平台进度上报：只读取视频状态、写自己的本地记录。
 */
(() => {
  'use strict';

  const C = globalThis.VAN_CONST;
  const P = globalThis.VAN_PURE;
  const V = globalThis.VAN_VISUAL;
  if (!C || !P) return;
  if (globalThis.__VAN_CONTENT__) return;
  globalThis.__VAN_CONTENT__ = { version: C.VERSION };

  const CH = C.CHANNEL;
  const T = {
    ENDED: 'ended',
    GO: 'go',
    STOP: 'stop',
    CLICKED: 'clicked',
    NONE: 'none',
    MEDIA: 'media',
    MANUAL: 'manual',
    // 一个小节里有多个视频时需要的一层协商：
    // STATE 子→父心跳、PROBE/PROBE_RES 父→子问状态、PLAY_NEXT 父让子播下一个、
    // SUB_DONE 子树播完了往上报
    STATE: 'state',
    PROBE: 'probe',
    PROBE_RES: 'probeRes',
    PLAY_NEXT: 'playNext',
    SUB_DONE: 'subDone',
    KICK: 'kick'
  };
  const isTop = (() => {
    try { return window.top === window; } catch (e) { return false; }
  })();
  const frameTag = isTop ? 'top' : 'f' + Math.random().toString(36).slice(2, 6);

  const hasChrome = typeof chrome !== 'undefined' && !!(chrome.storage && chrome.storage.sync);

  const S = {
    settings: Object.assign({}, C.DEFAULT_SETTINGS),
    videos: new Set(),
    attached: new WeakSet(),
    media: null,
    speedCache: Object.create(null),
    posMap: null,
    positionsLoaded: false,
    posDirty: false,
    posTimer: 0,
    endedGuard: 0,
    lastEndedAt: 0,
    guardUntil: 0,
    clicking: false,
    unloading: false,
    pendingToken: null,
    lastKick: null,
    lastPlayErr: null,
    kickWarnAt: 0,
    countdownState: null,
    hud: null,
    overlay: null,
    observer: null,
    lastDeepAt: 0,
    children: new Map(),     // 子 frame 状态：WindowProxy -> { ownCount, ownPending, subPending, ts, askedAt }
    lastPlayNextAt: 0,
    wantPlay: null,          // 还没加载出数据源、等 metadata 到了再播的视频
    lastPlayingAt: 0,        // 最近一次确认“有视频真的在播”的时间
    kickTimer: 0,            // 切到新小节后催它开始播的定时器
    kickUntil: 0             // 催播的截止时间
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ------------------------------------------------------------------ *
   * 存储
   * ------------------------------------------------------------------ */

  function readSettings() {
    return new Promise((resolve) => {
      const fallback = Object.assign({}, C.DEFAULT_SETTINGS);
      if (!hasChrome) { resolve(fallback); return; }
      try {
        chrome.storage.sync.get(C.DEFAULT_SETTINGS)
          .then((got) => resolve(Object.assign(fallback, got || {})))
          .catch(() => resolve(fallback));
      } catch (e) {
        resolve(fallback);
      }
    });
  }

  function localGet(keys) {
    return new Promise((resolve) => {
      try { chrome.storage.local.get(keys).then((r) => resolve(r || {})).catch(() => resolve({})); }
      catch (e) { resolve({}); }
    });
  }

  function localSet(obj) {
    if (!hasChrome) return;
    try { chrome.storage.local.set(obj).catch(() => {}); } catch (e) { /* ignore */ }
  }

  function saveSettings(patch) {
    S.settings = Object.assign({}, S.settings, patch);
    if (hasChrome) {
      try { chrome.storage.sync.set(patch).catch(() => {}); } catch (e) { /* ignore */ }
    }
    applySettingsToDom();
    updateHud();
  }

  /* ------------------------------------------------------------------ *
   * 页面标识 / 进度记忆
   * ------------------------------------------------------------------ */

  function pageKey() {
    try {
      const u = new URL(location.href);
      return (u.host + u.pathname + u.search).slice(0, 300);
    } catch (e) {
      return String(location.href).slice(0, 300);
    }
  }

  function speedKey() {
    return 'speed::' + location.host;
  }

  /** 同一页可能挂着好几个视频，进度按“页面 + 第几个视频”分开存。 */
  function videoPosKey(video) {
    const base = pageKey();
    let idx = 0;
    try {
      const own = ownVideos();
      const found = own.indexOf(video);
      if (found >= 0) idx = found;
    } catch (e) { /* ignore */ }
    return base + '#' + idx;
  }

  function loadPositions() {
    if (S.positionsLoaded) return Promise.resolve();
    S.positionsLoaded = true;
    return localGet('positions').then((got) => {
      S.posMap = (got && got.positions && typeof got.positions === 'object') ? got.positions : {};
    });
  }

  function schedulePositionsFlush() {
    if (S.posDirty) return;
    S.posDirty = true;
    S.posTimer = setTimeout(() => {
      S.posDirty = false;
      if (!S.posMap) return;
      prunePositions();
      localSet({ positions: S.posMap });
    }, 2500);
  }

  function prunePositions() {
    const keys = Object.keys(S.posMap);
    const max = C.MAX_PROGRESS_ENTRIES;
    if (keys.length <= max) return;
    keys.sort((a, b) => (S.posMap[a].ts || 0) - (S.posMap[b].ts || 0));
    keys.slice(0, keys.length - max).forEach((k) => { delete S.posMap[k]; });
  }

  function saveProgress(video) {
    if (!S.settings.resumePosition || !video || !S.posMap) return;
    const t = video.currentTime;
    const d = Number(video.duration) || 0;
    if (!isFinite(t) || t < 1) return;
    const key = videoPosKey(video);
    const prev = S.posMap[key];
    if (prev && Math.abs(prev.t - t) < 0.8 && Math.abs((prev.d || 0) - d) < 0.5) return;
    S.posMap[key] = { t: Math.round(t * 10) / 10, d: Math.round(d * 10) / 10, ts: Date.now() };
    schedulePositionsFlush();
  }

  function flushPositionsNow() {
    if (S.posTimer) { clearTimeout(S.posTimer); S.posTimer = 0; }
    if (!S.posMap) return;
    S.posDirty = false;
    prunePositions();
    localSet({ positions: S.posMap });
  }

  async function maybeRestore(video) {
    if (!S.settings.resumePosition || !video) return;
    if (video.__vanRestored) return;
    await loadPositions();
    const rec = S.posMap[videoPosKey(video)];
    if (!rec || !rec.t || rec.t < 5) return;
    if (Date.now() - (rec.ts || 0) > C.PROGRESS_TTL_MS) return;
    if (rec.d > 0 && rec.t >= rec.d - 3) return;
    if (video.currentTime > 2) return;
    video.__vanRestored = true;
    try {
      video.currentTime = rec.t;
      flash('已续播到 ' + P.formatClock(rec.t));
    } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------------ *
   * 倍速记忆
   * ------------------------------------------------------------------ */

  async function loadSpeed() {
    const key = speedKey();
    const got = await localGet(key);
    const v = Number(got[key]);
    if (isFinite(v) && v > 0) S.speedCache[location.host] = P.clampSpeed(v);
  }

  function applySavedSpeed(video) {
    if (!S.settings.rememberSpeed || !video) return;
    const rate = S.speedCache[location.host];
    if (!rate) return;
    if (Math.abs(video.playbackRate - rate) < 0.01) return;
    try { video.playbackRate = rate; } catch (e) { /* ignore */ }
  }

  function setSpeed(rate) {
    const video = currentVideo();
    const next = P.clampSpeed(rate);
    if (video) {
      try { video.playbackRate = next; } catch (e) { /* ignore */ }
    }
    if (S.settings.rememberSpeed) {
      S.speedCache[location.host] = next;
      localSet({ [speedKey()]: next });
    }
    updateHud();
    return next;
  }

  /* ------------------------------------------------------------------ *
   * 视频发现与挂载
   * ------------------------------------------------------------------ */

  function currentVideo() {
    const alive = [];
    for (const v of S.videos) {
      if (v.isConnected) alive.push(v);
      else S.videos.delete(v);
    }
    if (!alive.length) return null;
    const playing = alive.find((v) => !v.paused && !v.ended && v.readyState >= 2);
    if (playing) return playing;
    const playingAny = alive.find((v) => !v.paused);
    if (playingAny) return playingAny;
    alive.sort((a, b) => (b.currentTime || 0) - (a.currentTime || 0));
    return alive[0];
  }

  function attach(video) {
    if (!video || S.attached.has(video)) return;
    S.attached.add(video);
    S.videos.add(video);

    video.addEventListener('timeupdate', onTimeUpdate, { passive: true });
    video.addEventListener('pause', () => saveProgress(video));
    video.addEventListener('loadedmetadata', () => {
      applySavedSpeed(video);
      maybeRestore(video);
      updateHud();
      // 之前让这个视频播，但那时它还没有数据源（比如懒加载的播放器）
      if (S.wantPlay === video) {
        S.wantPlay = null;
        activateVideo(video, null);
      }
    });
    video.addEventListener('play', () => {
      applySavedSpeed(video);
      reportMedia();
    });
    video.addEventListener('seeking', () => { video.__vanRestored = true; });

    if (video.readyState >= 1) {
      applySavedSpeed(video);
      maybeRestore(video);
    }

    if (V && S.settings.visualDetect) {
      try {
        video.__vanVisual = V.attach(video, {
          onLikelyEnd: (why) => onVideoEnded(video, why),
          onUnavailable: () => { /* 跨域画布污染：静默降级 */ }
        });
      } catch (e) { /* ignore */ }
    }
    if (!isTop) postState();
    updateHud();
  }

  function stopVisual() {
    for (const v of S.videos) {
      if (v.__vanVisual) {
        try { v.__vanVisual.stop(); } catch (e) { /* ignore */ }
        v.__vanVisual = null;
      }
    }
  }

  function rearmVisual() {
    if (!V) return;
    for (const v of S.videos) {
      if (v.__vanVisual) continue;
      try {
        v.__vanVisual = V.attach(v, {
          onLikelyEnd: (why) => onVideoEnded(v, why),
          onUnavailable: () => {}
        });
      } catch (e) { /* ignore */ }
    }
  }

  /** 只在页面确实没有 <video> 时才做 shadow DOM 深度遍历，避免大页面卡顿。 */
  function deepScan() {
    const t = Date.now();
    if (t - S.lastDeepAt < 5000) return;
    S.lastDeepAt = t;
    let count = 0;
    try {
      const all = document.querySelectorAll('*');
      for (const el of all) {
        if (!el.shadowRoot) continue;
        const inner = el.shadowRoot.querySelectorAll('video');
        for (const v of inner) { attach(v); count++; }
      }
    } catch (e) { /* ignore */ }
    if (count) updateHud();
  }

  /** 页面里可能没有 <video>，而是藏在自定义元素的 open shadow root 里。 */
  function firstVideoEl() {
    try {
      const v = document.querySelector('video');
      if (v) return v;
    } catch (e) { /* ignore */ }
    try {
      const all = document.querySelectorAll('*');
      for (const el of all) {
        const root = el.shadowRoot;
        if (!root) continue;
        const v = root.querySelector('video');
        if (v) return v;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function scan() {
    let list = [];
    try { list = document.querySelectorAll('video'); } catch (e) { list = []; }
    for (const v of list) attach(v);
    if (!list.length) deepScan();
    return list.length;
  }

  function onTimeUpdate(e) {
    const v = e.target;
    if (!v || v.tagName !== 'VIDEO') return;
    const t = Date.now();
    if (t - (v.__vanT || 0) > 1500) {
      v.__vanT = t;
      saveProgress(v);
    }
    if (t - (S.lastReportAt || 0) > 1000) {
      S.lastReportAt = t;
      reportMedia();
    }
  }

  function reportMedia() {
    const v = currentVideo();
    if (!v) return;
    const payload = {
      ch: CH,
      t: T.MEDIA,
      frame: frameTag,
      speed: v.playbackRate || 1,
      current: Math.round((v.currentTime || 0) * 10) / 10,
      duration: isFinite(v.duration) ? Math.round(v.duration * 10) / 10 : 0,
      paused: !!v.paused,
      ended: !!v.ended
    };
    if (isTop) onMedia(payload);
    else postToTop(payload);
  }

  /* ------------------------------------------------------------------ *
   * 同一小节里的多个视频
   *
   * 学习通的一个小节经常挂着好几个视频任务点：可能是一个文档里的多个 <video>，
   * 也可能一个视频一个 iframe（甚至嵌套一层）。所以“这个视频播完了”之后要先问：
   *   1) 本 frame 还有没播完的视频吗？   → 直接接着播它
   *   2) 某个子 frame 里还有没播完的吗？ → 让它播（父 frame 把它滚进视野）
   *   3) 都没有了，才算这一节结束，把 SUB_DONE 往上抛，最顶层才去点“下一节”
   * 子 frame 每 2 秒心跳一次自己的状态；父 frame 信息不够时再主动 PROBE 一次。
   * ------------------------------------------------------------------ */

  const CH_STALE_MS = 6000;

  function videoSignature(v) {
    const src = String((v && (v.currentSrc || v.src)) || '').slice(-80);
    const d = v && isFinite(v.duration) ? Math.round(v.duration) : 0;
    return src + '|' + d;
  }

  function isVideoDone(v) {
    if (!v) return false;
    if (v.__vanDoneSig && v.__vanDoneSig === videoSignature(v)) return true;
    if (v.ended) return true;
    const d = Number(v.duration) || 0;
    if (d > 1 && v.currentTime / d >= P.DONE_RATIO) return true;
    return false;
  }

  function markDone(v) {
    if (!v) return;
    try { v.__vanDoneSig = videoSignature(v); } catch (e) { /* ignore */ }
  }

  /** 本 frame 里的视频，按 DOM 顺序。 */
  function ownVideos() {
    const list = [];
    for (const v of S.videos) {
      if (!v.isConnected) { S.videos.delete(v); continue; }
      list.push(v);
    }
    list.sort((a, b) => {
      if (a === b) return 0;
      try {
        const pos = a.compareDocumentPosition(b);
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      } catch (e) { /* ignore */ }
      return 0;
    });
    return list;
  }

  function pendingLocal(exclude) {
    const out = [];
    for (const v of ownVideos()) {
      if (v === exclude) continue;
      if (isVideoDone(v)) continue;
      out.push(v);
    }
    return out;
  }

  function childFrames() {
    const out = [];
    let list = [];
    try { list = document.querySelectorAll('iframe, frame'); } catch (e) { list = []; }
    for (const el of list) {
      let win = null;
      try { win = el.contentWindow; } catch (e) { win = null; }
      if (win) out.push({ el, win });
    }
    return out;
  }

  function childRecord(win) {
    let rec = S.children.get(win);
    if (!rec) {
      rec = { ownCount: 0, ownPending: false, subPending: false, ts: 0, askedAt: 0 };
      S.children.set(win, rec);
    }
    return rec;
  }

  function livePendingChildren() {
    const now = Date.now();
    const out = [];
    for (const entry of S.children) {
      const rec = entry[1];
      if (now - rec.ts > CH_STALE_MS) continue;
      if (rec.ownPending || rec.subPending) out.push(entry[0]);
    }
    return out;
  }

  /* 子 frame 里有多少个视频：弹窗里的“本页”只算顶层文档，
     学习通的播放器又常在跨域 iframe 里，所以这里单独汇总一份。 */
  function childVideoStats() {
    const now = Date.now();
    let videos = 0;
    let frames = 0;
    for (const entry of S.children) {
      const rec = entry[1];
      if (now - rec.ts > CH_STALE_MS) continue;
      frames += 1;
      videos += Number(rec.ownCount) || 0;
    }
    return { videos, frames };
  }

  /* 给答题面板/“复制结构”留一份顶层视角的快照（同一个隔离世界，answer.js 能读到）。 */
  function publishTopStatus() {
    if (!isTop) return;
    const st = childVideoStats();
    try {
      window.__VAN_TOP_STATUS__ = {
        videos: S.videos.size,
        childVideos: st.videos,
        childFrames: st.frames,
        kick: S.lastKick || null,
        at: Date.now()
      };
    } catch (e) { /* ignore */ }
  }

  function frameStatus() {
    const own = ownVideos();
    return {
      ownCount: own.length,
      ownPending: own.some((v) => !isVideoDone(v)),
      subPending: livePendingChildren().length > 0
    };
  }

  function postState() {
    if (isTop) return;
    const st = frameStatus();
    try {
      window.parent.postMessage({
        ch: CH,
        t: T.STATE,
        ownCount: st.ownCount,
        ownPending: st.ownPending,
        subPending: st.subPending
      }, '*');
    } catch (e) { /* ignore */ }
  }

  /** 给一批子 frame 发 PROBE，等它们的回复（带超时，超时就用手上已有的信息）。 */
  function probeFrames(frames, timeoutMs) {
    return new Promise((resolve) => {
      const nonce = Math.random().toString(36).slice(2, 10);
      const replies = [];
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        resolve(replies);
      };
      const onMsg = (e) => {
        const d = e.data;
        if (!d || typeof d !== 'object' || d.ch !== CH || d.t !== T.PROBE_RES || d.nonce !== nonce) return;
        const frame = frames.find((f) => f.win === e.source);
        if (!frame) return;
        const rec = childRecord(frame.win);
        rec.ownCount = Number(d.ownCount) || 0;
        rec.ownPending = !!d.ownPending;
        rec.subPending = !!d.subPending;
        rec.ts = Date.now();
        replies.push({ frame, ownPending: rec.ownPending, subPending: rec.subPending });
        if (replies.length >= frames.length) finish();
      };
      const timer = setTimeout(finish, timeoutMs);
      window.addEventListener('message', onMsg);
      for (const f of frames) {
        try { f.win.postMessage({ ch: CH, t: T.PROBE, nonce }, '*'); } catch (err) { /* ignore */ }
      }
    });
  }

  function askChildPlay(frame) {
    if (!frame || !frame.el) return false;
    try { frame.el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' }); } catch (e) { /* ignore */ }
    try {
      frame.win.postMessage({ ch: CH, t: T.PLAY_NEXT }, '*');
      const rec = childRecord(frame.win);
      rec.askedAt = Date.now();
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ---- 播放顺序：本 frame 的视频与子 frame 按它们在页面里出现的位置混排 ---- */

  function domOrder(a, b) {
    if (a === b) return 0;
    try {
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    } catch (e) { /* ignore */ }
    return 0;
  }

  /**
   * 一个课件的播放顺序：自己的 <video> 和“装着视频的子 frame”放在一起，
   * 按 DOM 位置排。这样“我现在是第几个”和“下一个是谁”才有地方算。
   */
  function frameItems() {
    const items = [];
    for (const v of ownVideos()) items.push({ kind: 'video', el: v });
    for (const f of childFrames()) items.push({ kind: 'frame', el: f.el, frame: f });
    items.sort((a, b) => domOrder(a.el, b.el));
    return items;
  }

  function itemIndex(el) {
    const items = frameItems();
    for (let i = 0; i < items.length; i++) {
      if (items[i].el === el) return i;
    }
    return -1;
  }

  function frameIndexForWindow(win) {
    const items = frameItems();
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === 'frame' && items[i].frame.win === win) return i;
    }
    return -1;
  }

  /** 子 frame 现在还有没有没播完的：true / false，不知道就 null。 */
  function framePendingNow(frame) {
    const rec = S.children.get(frame.win);
    if (!rec) return null;
    if (Date.now() - rec.ts > CH_STALE_MS) return null;
    return !!(rec.ownPending || rec.subPending);
  }

  function countPendingAfter(idx) {
    const items = frameItems();
    let n = 0;
    for (let i = idx + 1; i < items.length; i++) {
      const it = items[i];
      if (it.kind === 'video') {
        if (!isVideoDone(it.el)) n++;
      } else if (framePendingNow(it.frame) === true) {
        n++;
      }
    }
    return n;
  }

  /**
   * 从 items[idx] 之后接着播。**只往后找，绝不回头**：
   * 用户从第 3 个视频开始看，播完就接第 4 个，前面的 1、2 不会突然自己播起来。
   * 返回 true 表示已经让某个视频或子 frame 动起来了。
   */
  async function continueAfter(idx, why) {
    const items = frameItems();
    let probed = null;   // 只问一次：WindowProxy -> 还有没有待播
    for (let i = idx + 1; i < items.length; i++) {
      const it = items[i];
      if (it.kind === 'video') {
        if (isVideoDone(it.el)) continue;
        if (S.wantPlay === it.el) return true;   // 已经在启动中，别重复搓
        activateVideo(it.el, why || null);
        return true;
      }
      let pending = framePendingNow(it.frame);
      if (pending === null) {
        if (!probed) {
          const unknown = [];
          for (let j = i; j < items.length; j++) {
            const x = items[j];
            if (x.kind === 'frame' && framePendingNow(x.frame) === null) unknown.push(x.frame);
          }
          probed = new Map();
          const res = await probeFrames(unknown, 700);
          for (const r of res) probed.set(r.frame.win, !!(r.ownPending || r.subPending));
        }
        pending = probed.get(it.frame.win) === true;   // 没回话的就当没有，省得空等
      }
      if (pending) {
        askChildPlay(it.frame);
        if (why) flash(why);
        return true;
      }
    }
    return false;
  }

  /**
   * 没有明确的“刚播完的那一个”时（比如刚切到新小节、被父 frame 要求继续），
   * 就从最后一段已经播完的内容之后开始；一个都没播完，那就从第一个开始。
   */
  async function startOrContinue(why) {
    const playing = currentVideo();
    if (playing && !playing.paused && !playing.ended) return true;   // 已经在播，不动
    const items = frameItems();
    let lastDone = -1;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === 'video') {
        if (isVideoDone(it.el)) lastDone = i;
      } else if (framePendingNow(it.frame) === false) {
        lastDone = i;
      }
    }
    return continueAfter(lastDone, why);
  }

  /** 本 frame 的播放顺序走到头了：往上抛，或者由最顶层去点“下一节”。 */
  function onAllDone(why) {
    if (isTop) { handleEnded({ why: why || 'subtree' }); return; }
    try { window.parent.postMessage({ ch: CH, t: T.SUB_DONE, why: why || 'subtree' }, '*'); } catch (e) { /* ignore */ }
  }

  /** 父 frame 让我继续播：从“最后播完的位置”往后接，绝不回头。 */
  async function onPlayNextRequest() {
    const now = Date.now();
    if (now - S.lastPlayNextAt < 1500) return;
    S.lastPlayNextAt = now;
    const played = await startOrContinue('继续播放这一节的下一个视频');
    if (!played) {
      try { window.parent.postMessage({ ch: CH, t: T.SUB_DONE }, '*'); } catch (e) { /* ignore */ }
    }
  }

  function onChildState(e, d) {
    if (!e.source) return;
    const rec = childRecord(e.source);
    rec.ownCount = Number(d.ownCount) || 0;
    rec.ownPending = !!d.ownPending;
    rec.subPending = !!d.subPending;
    rec.ts = Date.now();
    publishTopStatus();
  }

  async function onChildSubDone(e, d) {
    if (e.source) {
      const rec = childRecord(e.source);
      rec.ownPending = false;
      rec.subPending = false;
      rec.ts = Date.now();
    }
    // 子 frame 播完了：从它所在的位置往后找，而不是从本 frame 的开头重来
    const idx = e.source ? frameIndexForWindow(e.source) : -1;
    const played = await continueAfter(idx, null);
    if (!played) onAllDone(d && d.why);
  }

  /* 子页面把催播结果报给顶层：成功不吵，失败说清楚卡在哪一步。 */
  function postKickResult(ok) {
    if (isTop) return;
    try {
      window.top.postMessage({
        ch: CH,
        t: T.KICK,
        ok: !!ok,
        hasVideo: !!firstVideoEl(),
        url: location.href,
        err: S.lastPlayErr || null
      }, '*');
    } catch (e) { /* ignore */ }
  }

  /* 子页面催播的结果只在这里汇总成一个提示：成功不吵，失败说清楚卡在哪一步。 */
  function onChildKick(d) {
    if (!isTop) return;
    if (d && d.ok) {
      if (Date.now() - (S.kickWarnAt || 0) > 8000) {
        S.kickWarnAt = Date.now();
        flash('子页面里的视频已自动播放');
      }
      return;
    }
    if (Date.now() - (S.kickWarnAt || 0) < 8000) return;
    S.kickWarnAt = Date.now();
    if (!d || !d.hasVideo) {
      flash('子页面里还没找到视频，先等等看');
      return;
    }
    var name = d.err && d.err.name;
    if (name === 'NotAllowedError') {
      // 这层 iframe 的权限策略不允许脚本启动播放，合成点击也不算用户手势
      flash('浏览器不允许子页面自动播放，得在视频上点一下');
    } else if (name === 'NotSupportedError' || name === 'AbortError') {
      flash('子页面视频还没加载好，会继续重试');
    } else {
      flash('子页面有视频，但没能自动播放，需要手动点一下');
    }
  }

  function answerProbe(e, d) {    if (!e.source) return;
    const st = frameStatus();
    try {
      e.source.postMessage({
        ch: CH,
        t: T.PROBE_RES,
        nonce: d.nonce,
        ownCount: st.ownCount,
        ownPending: st.ownPending,
        subPending: st.subPending
      }, '*');
    } catch (err) { /* ignore */ }
  }

  /**
   * 播本 frame 里的下一个视频：先滚进视野，再尝试 play()。
   * 浏览器不给自动播放时，先退化为静音播放，再退化为“点画面中间/播放按钮”。
   * 返回 true 表示真的播起来了（不是“已经发起”）。
   */
  async function activateVideo(v, why) {
    if (!v) return false;
    S.wantPlay = v;
    try { v.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' }); } catch (e) { /* ignore */ }
    if (why) flash(why);
    await sleep(450);
    if (!v.isConnected) { S.wantPlay = null; return false; }

    let err = null;
    try { await v.play(); } catch (e) { err = e; }
    await sleep(700);
    if (!v.paused && !v.ended) {
      S.wantPlay = null;
      S.lastPlayErr = null;
      updateHud();
      return true;
    }

    // 被自动播放策略拦下时，静音播放一定是允许的
    try {
      v.muted = true;
      await v.play();
      await sleep(250);
      if (!v.paused) {
        S.wantPlay = null;
        S.lastPlayErr = null;
        flash('浏览器拦下了自动播放，已静音继续；点一下视频就能恢复声音');
        const unmute = () => {
          try { v.muted = false; } catch (e2) { /* ignore */ }
          document.removeEventListener('pointerdown', unmute, true);
        };
        document.addEventListener('pointerdown', unmute, true);
        updateHud();
        return true;
      }
    } catch (e) { if (!err) err = e; }

    // 有些播放器只认点击：先点画面正中间（用户看到的就是那块），再点播放按钮
    try { clickVideoCenter(v); } catch (e) { /* ignore */ }
    await sleep(450);
    if (v.paused) {
      const btn = findPlayButton(v);
      if (btn) { try { clickElement(btn); } catch (e) { /* ignore */ } }
      await sleep(650);
    }
    const ok = !v.paused && !v.ended;
    if (ok) {
      S.wantPlay = null;
      S.lastPlayErr = null;
      updateHud();
      return true;
    }
    // 失败也要清掉“启动中”，否则下一次 continueAfter 会以为它已经在启动了
    S.wantPlay = null;
    S.lastPlayErr = {
      name: (err && err.name) || '',
      message: String((err && err.message) || '').slice(0, 160)
    };
    if (!isTop) postKickResult(false);
    else flash('这一节的下一个视频已定位好，点一下就能接着看');
    updateHud();
    return false;
  }

  /* 点画面正中间：拦在视频上的那层（海报/大播放键）才是用户真正点到的元素。 */
  function clickVideoCenter(v) {
    let r = null;
    try { r = v.getBoundingClientRect(); } catch (e) { r = null; }
    if (!r || r.width < 2 || r.height < 2) return;
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    let target = null;
    try { target = document.elementFromPoint(x, y); } catch (e) { target = null; }
    clickElement(target || v);
    if (target && target !== v) clickElement(v);
  }

  /* 播放按钮可能在视频外层、也可能在整页别处，这里放宽到整个文档。 */
  function findPlayButton(v) {
    const selectors = [
      '.vjs-big-play-button', '.xgplayer-start', '.prism-play-btn', '.video-play',
      '[class*="big-play"]', '[class*="bigplay"]', '[class*="play-btn"]', '[class*="playBtn"]',
      '[class*="play_btn"]', '[class*="start-btn"]', '[class*="startBtn"]',
      '[aria-label*="播放"]', '[title*="播放"]', '[aria-label*="play"]'
    ];
    const roots = [document];
    for (const el of document.querySelectorAll('*')) {
      if (el.shadowRoot) roots.push(el.shadowRoot);
    }
    for (const root of roots) {
      for (const sel of selectors) {
        let list = [];
        try { list = root.querySelectorAll(sel); } catch (e) { list = []; }
        for (const el of list) {
          if (!el || el === v) continue;
          let r = null;
          try { r = el.getBoundingClientRect(); } catch (e) { continue; }
          if (r.width < 4 || r.height < 4) continue;
          return el;
        }
      }
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * 结束判定与自动连播
   * ------------------------------------------------------------------ */

  async function onVideoEnded(video, why) {
    const t = Date.now();
    if (video && video.ended) markDone(video);   // 只有真的 ended 才记成“看完”
    if (!isTop) postState();
    if (t - S.endedGuard < 3000) return;
    S.endedGuard = t;
    saveProgress(video);
    if (!S.settings.enabled) return;
    if (!S.settings.autoNext) {
      if (isTop) flash('这个视频结束了（自动连播已关闭）');
      return;
    }
    markDone(video);
    postState();

    // 同一小节里，“刚播完的这个”之后还有别的视频 → 接着往后播；前面的不回头
    // （如果播放器把 <video> 换掉了、找不到它的位置，就当这一节已经到头，绝不再从头扫）
    const idx = video ? itemIndex(video) : -1;
    const left = countPendingAfter(idx);
    const why2 = left > 0 ? '这一节还有 ' + left + ' 个视频，继续播放' : null;
    const played = idx >= 0 ? await continueAfter(idx, why2) : false;
    if (!played) onAllDone(why || 'event');
  }

  function effectiveDelay() {
    let d = Number(S.settings.delaySec);
    if (!isFinite(d)) d = C.DEFAULT_SETTINGS.delaySec;
    d = Math.max(0, Math.min(30, d));
    if (isTop) {
      try {
        const q = new URLSearchParams(location.search).get(C.DELAY_OVERRIDE_PARAM);
        if (q !== null && q !== '') {
          const n = Number(q);
          if (isFinite(n) && n >= 0) d = Math.min(30, n);
        }
      } catch (e) { /* ignore */ }
    }
    return d;
  }

  function handleEnded(msg) {
    if (!isTop) return;
    const t = Date.now();
    if (t - S.lastEndedAt < 4000) return;
    S.lastEndedAt = t;
    if (!S.settings.enabled) return;
    if (!S.settings.autoNext) { flash('本集已结束'); return; }
    const delay = effectiveDelay();
    if (delay <= 0) { goNext('auto'); return; }
    showCountdown(delay, () => goNext('auto'));
  }

  /**
   * 刚点完“下一节”：新小节的内容通常是异步加载的，而且不会自己开始播。
   * 所以在接下来的一段时间里反复看一眼，等第一个视频出现就把它放起来；
   * 一旦确认已经有视频在播，就收手（用户中途手动点了别的视频也一样收手）。
   */
  function startLessonKick() {
    if (!S.settings.enabled) return;
    // 视频经常在跨域 iframe 里：顶层看不到它的 <video>，只有这一层自己能按播放。
    // 所以每个 frame 都可以催播；这层暂时没视频也不急着退出——新小节的内容是异步加载的，
    // 可能几百毫秒后才出现 <video>，退出太早就会永远等不到它。
    S.kickUntil = Date.now() + 25000;
    S.kickRewound = false;
    if (S.kickTimer) return;
    const tick = async () => {
      S.kickTimer = 0;
      if (Date.now() > S.kickUntil) return;
      const v0 = firstVideoEl();
      if (!v0) {
        // 这一层还没有视频：新小节是异步加载的，等下一轮再看。
        S.kickTimer = setTimeout(tick, 900);
        return;
      }
      if (Date.now() - S.lastPlayingAt < 2000) {   // 已经有视频在播了，稍后再确认
        S.kickTimer = setTimeout(tick, 800);
        return;
      }
      try { attach(v0); } catch (e) { /* ignore */ }
      // 有些小节上次已经看到最后一两秒，续播会直接停在结尾，看着像“没播”。
      // 这种视频从头放一遍，别让它卡在最后一帧。
      if (!S.kickRewound && v0.paused && v0.duration > 8 && v0.currentTime > v0.duration - 5) {
        S.kickRewound = true;
        try { v0.currentTime = 0; } catch (e) { /* ignore */ }
        flash('这节的视频之前已经看到结尾，已从头播放');
      }
      // 这是“切完小节，把这一节的视频放起来”，不该被“已看完”的记录挡住；
      // 也不该沿用上一次没清掉的“启动中”状态。
      S.wantPlay = null;
      let played = false;
      try { played = await activateVideo(v0, null); } catch (e) { played = false; }
      S.lastKick = {
        at: Date.now(),
        ok: !!played,
        hasVideo: true,
        url: location.href,
        err: S.lastPlayErr || null
      };
      publishTopStatus();
      if (!isTop) postKickResult(!!played);
      if (Date.now() > S.kickUntil) return;
      S.kickTimer = setTimeout(tick, played ? 1500 : 900);
    };
    S.kickTimer = setTimeout(tick, 900);
  }

  /**
   * 答题模块点完“下一节”后，新页面不会自己播视频（播放按钮停在画面中间）。
   * 它只留一个时间戳，这里看到就复用 startLessonKick 的催播逻辑，
   * 等这一节的视频加载出来自动按播放。
   */
  function maybeKickFromSwitch() {
    try {
      chrome.storage.local.get({ vanAutoPlayAt: 0 }, (r) => {
        const at = (r && r.vanAutoPlayAt) || 0;
        if (!at || Date.now() - at > 120000) return;
        startLessonKick();
      });
    } catch (e) { /* ignore */ }
  }

  function goNext(trigger) {    if (!S.settings.enabled) return;
    if (Date.now() < S.guardUntil) return;
    S.guardUntil = Date.now() + 8000;
    const token = Math.random().toString(36).slice(2, 10);
    S.pendingToken = token;
    hideCountdown();
    flash(trigger === 'manual' ? '正在切换下一集…' : '正在切换到下一集…');
    broadcast({ ch: CH, t: T.GO, token });
    localTryNext(token);
    setTimeout(() => {
      if (S.pendingToken === token) {
        S.pendingToken = null;
        flash('没找到“下一集”按钮，请手动切换（若已自动切换可忽略）');
      }
    }, 6000);
  }

  function requestNext() {
    if (isTop) goNext('manual');
    else postToTop({ ch: CH, t: T.MANUAL });
  }

  /* ------------------------------------------------------------------ *
   * 跨 frame 通信
   * ------------------------------------------------------------------ */

  function postToTop(msg) {
    if (isTop) { handleMessage(msg); return; }
    try { window.top.postMessage(msg, '*'); } catch (e) { /* ignore */ }
  }

  function broadcast(msg) {
    if (!isTop) { postToTop(msg); return; }
    deliverToChildren(msg);
  }

  function deliverToChildren(msg) {
    let frames = [];
    try { frames = document.querySelectorAll('iframe, frame'); } catch (e) { frames = []; }
    for (const f of frames) {
      try { f.contentWindow.postMessage(msg, '*'); } catch (e) { /* ignore */ }
    }
  }

  function handleMessage(d, e) {
    if (!d || typeof d !== 'object' || d.ch !== CH) return;
    switch (d.t) {
      case T.GO:
        if (Date.now() < S.guardUntil) { deliverToChildren(d); return; }
        S.guardUntil = Date.now() + 8000;
        deliverToChildren(d);
        localTryNext(d.token);
        break;
      case T.STOP:
        S.guardUntil = Date.now() + 5000;
        deliverToChildren(d);
        break;
      case T.CLICKED:
        if (isTop) onNextClicked(d);
        break;
      case T.ENDED:
        if (isTop) handleEnded(d);
        break;
      case T.MEDIA:
        if (isTop) onMedia(d);
        break;
      case T.MANUAL:
        if (isTop) goNext('manual');
        break;
      case T.NONE:
        break;
      case T.STATE:
        onChildState(e, d);
        break;
      case T.PROBE:
        answerProbe(e, d);
        break;
      case T.PROBE_RES:
        // 由 probeFrames() 里的临时监听器消费
        break;
      case T.PLAY_NEXT:
        onPlayNextRequest();
        break;
      case T.SUB_DONE:
        onChildSubDone(e, d);
        break;
      case T.KICK:
        onChildKick(d);
        break;
      default:
        break;
    }
  }

  function onNextClicked(d) {
    if (S.pendingToken && d.token && S.pendingToken !== d.token) return;
    S.pendingToken = null;
    S.guardUntil = Date.now() + 4000;
    deliverToChildren({ ch: CH, t: T.STOP });
    const label = (d.label || '').replace(/\s+/g, ' ').trim();
    flash(label ? '已切换到：' + label : '已切换到下一集');
    // 新小节不会自己开始播：盯一会儿，等它的第一个视频出现就放起来
    startLessonKick();
  }

  function onMedia(d) {
    if (!isTop) return;
    S.media = d;
    if (d && !d.paused) S.lastPlayingAt = Date.now();
    updateHud();
  }

  /* ------------------------------------------------------------------ *
   * 找“下一集”候选
   * ------------------------------------------------------------------ */

  const GENERIC_SELECTOR = 'a, button, [role="button"], [role="link"], [onclick]';

  const PLAYER_NEXT_SELECTORS = [
    '.next-btn', '.btn-next', '.next-video', '.nextVideo', '.nextChapter', '.next-chapter',
    '[class*="nextBtn"]', '[class*="next-btn"]', '[class*="next_video"]',
    '.vjs-next-button', '.xgplayer .next',
    '[aria-label*="下一"]', '[title*="下一"]'
  ];

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    let r;
    try { r = el.getBoundingClientRect(); } catch (e) { return false; }
    if (r.width < 1 || r.height < 1) return false;
    let cs;
    try { cs = getComputedStyle(el); } catch (e) { return true; }
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    if (Number(cs.opacity) === 0) return false;
    return true;
  }

  function describe(el, priority) {
    return {
      text: (el.innerText || el.textContent || '').trim().slice(0, 80),
      aria: el.getAttribute('aria-label') || '',
      title: el.getAttribute('title') || '',
      id: el.id || '',
      cls: typeof el.className === 'string' ? el.className.slice(0, 200) : '',
      tag: (el.tagName || '').toLowerCase(),
      rel: el.getAttribute('rel') || '',
      role: el.getAttribute('role') || '',
      href: el.href || '',
      visible: true,
      hasOnclick: el.hasAttribute('onclick'),
      childCount: el.children ? el.children.length : 0,
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      priority: priority || 0
    };
  }

  function isActiveCatalogItem(el) {
    if (el.getAttribute('aria-selected') === 'true') return true;
    const cn = typeof el.className === 'string' ? el.className : '';
    if (/(^|[\s_-])(active|current|selected|on)([\s_-]|$)/i.test(cn)) return true;
    try {
      if (el.querySelector('.posCatalog_active, .active, [class*="active"]')) return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  /** 学习通：优先找播放器里的“下一节”，其次找左侧目录里当前章的下一条。 */
  function collectChaoxing(push) {
    const strong = [
      'a[title*="下一节"]', 'a[title*="下一集"]', 'span[title*="下一节"]',
      '.nextChapter', '#nextChapter', '[class*="nextChapter"]',
      '[class*="next_chapter"]', 'a[class*="next"]'
    ];
    for (const sel of strong) {
      try { document.querySelectorAll(sel).forEach((el) => push(el, 90)); } catch (e) { /* ignore */ }
    }

    let items = [];
    try {
      items = Array.from(document.querySelectorAll(
        '.posCatalog_select, .chapter_item, .catalog_item, [class*="posCatalog_select"]'
      ));
    } catch (e) { items = []; }
    if (items.length < 2) return;

    const idx = items.findIndex(isActiveCatalogItem);
    if (idx < 0 || idx >= items.length - 1) return;
    push(items[idx + 1], 95);
  }

  function collectCandidates() {
    const out = [];
    const seen = new Set();

    const push = (el, priority) => {
      if (!el || seen.has(el)) return;
      if (el.closest && el.closest('#van-hud, #van-overlay')) return;
      if (!isVisible(el)) return;
      seen.add(el);
      out.push({ el, desc: describe(el, priority) });
    };

    for (const sel of P.parseSelectorList(S.settings.extraSelectors)) {
      try { document.querySelectorAll(sel).forEach((el) => push(el, 120)); } catch (e) { /* ignore */ }
    }

    try {
      document.querySelectorAll('a[rel="next"], [data-van-next], [data-video-next]')
        .forEach((el) => push(el, 110));
    } catch (e) { /* ignore */ }

    if (/(^|\.)chaoxing\.com$/i.test(location.hostname)) collectChaoxing(push);

    for (const sel of PLAYER_NEXT_SELECTORS) {
      try { document.querySelectorAll(sel).forEach((el) => push(el, 70)); } catch (e) { /* ignore */ }
    }

    let generic = [];
    try { generic = Array.from(document.querySelectorAll(GENERIC_SELECTOR)).slice(0, 600); } catch (e) { generic = []; }
    for (const el of generic) {
      const cls = typeof el.className === 'string' ? el.className : '';
      const text = (el.textContent || '').slice(0, 60);
      const meta = (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.id || '') + ' ' + cls;
      if (!P.matchesNextWord(text) && !P.matchesNextWord(meta)) continue;
      push(el, 0);
    }

    return out;
  }

  function clickElement(el) {
    let rect = { left: 0, top: 0, width: 0, height: 0 };
    try { rect = el.getBoundingClientRect(); } catch (e) { /* ignore */ }
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const base = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, button: 0
    };
    try { el.dispatchEvent(new PointerEvent('pointerover', Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, base))); } catch (e) { /* ignore */ }
    try { el.dispatchEvent(new MouseEvent('mouseover', base)); } catch (e) { /* ignore */ }
    try { el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 1 }, base))); } catch (e) { /* ignore */ }
    try { el.dispatchEvent(new MouseEvent('mousedown', Object.assign({ buttons: 1 }, base))); } catch (e) { /* ignore */ }
    try { el.dispatchEvent(new PointerEvent('pointerup', Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, base))); } catch (e) { /* ignore */ }
    try { el.dispatchEvent(new MouseEvent('mouseup', base)); } catch (e) { /* ignore */ }
    try { el.dispatchEvent(new MouseEvent('click', base)); } catch (e) { /* ignore */ }
  }

  async function clickAndVerify(el) {
    const beforeHref = location.href;
    const before = currentVideo();
    const beforeTime = before ? before.currentTime : -1;

    try { clickElement(el); } catch (e) { return false; }

    const deadline = Date.now() + 2600;
    while (Date.now() < deadline) {
      await sleep(200);
      if (S.unloading) return true;
      if (location.href !== beforeHref) return true;
      const now = currentVideo();
      if (now && before && now !== before && !now.paused) return true;
      if (now && before && now === before && beforeTime > 3 && now.currentTime < 1.5) return true;
    }
    return false;
  }

  async function localTryNext(token) {
    if (S.clicking) return;
    let cands = [];
    try { cands = collectCandidates(); } catch (e) { cands = []; }
    if (!cands.length) { postToTop({ ch: CH, t: T.NONE, token }); return; }

    const ranked = P.rankCandidates(cands.map((c) => c.desc));
    if (!ranked.length) { postToTop({ ch: CH, t: T.NONE, token }); return; }

    S.clicking = true;
    try {
      for (const r of ranked.slice(0, 3)) {
        if (S.unloading) return;
        const item = cands[r.i];
        const ok = await clickAndVerify(item.el);
        if (ok) {
          postToTop({
            ch: CH,
            t: T.CLICKED,
            token,
            label: (item.desc.text || '').slice(0, 40)
          });
          return;
        }
      }
      postToTop({ ch: CH, t: T.NONE, token });
    } finally {
      S.clicking = false;
    }
  }

  /* ------------------------------------------------------------------ *
   * 悬浮面板
   * ------------------------------------------------------------------ */

  const HUD_CSS = `
    * { box-sizing: border-box; }
    .wrap {
      font: 12px/1.5 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      color: #e5e7eb; user-select: none; -webkit-font-smoothing: antialiased;
      display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
    }
    .bar {
      display: flex; align-items: center; gap: 8px; padding: 7px 12px; border-radius: 999px;
      background: rgba(17, 24, 39, .88); border: 1px solid rgba(255,255,255,.10);
      box-shadow: 0 10px 30px rgba(0,0,0,.35); cursor: pointer; backdrop-filter: blur(10px);
      transition: transform .15s ease, background .15s ease;
    }
    .bar:hover { background: rgba(31, 41, 55, .94); }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: #6b7280; flex: none; }
    .dot.on { background: #34d399; box-shadow: 0 0 8px #34d399; }
    .dot.off { background: #f87171; }
    .speed { font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: .2px; }
    .label { opacity: .78; }
    .caret { opacity: .5; font-size: 10px; }
    .panel {
      width: 236px; padding: 10px 12px 12px; border-radius: 14px;
      background: rgba(17, 24, 39, .94); border: 1px solid rgba(255,255,255,.10);
      box-shadow: 0 16px 44px rgba(0,0,0,.42); backdrop-filter: blur(12px);
      display: none;
    }
    .panel.show { display: block; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 5px 0; }
    .row.small { font-size: 11px; opacity: .72; padding: 2px 0; }
    .row + .row { border-top: 1px solid rgba(255,255,255,.06); }
    .sw { position: relative; width: 34px; height: 19px; flex: none; }
    .sw input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
    .sw i { position: absolute; inset: 0; border-radius: 999px; background: #374151; transition: background .16s; }
    .sw i::after {
      content: ""; position: absolute; width: 13px; height: 13px; border-radius: 50%;
      background: #fff; top: 3px; left: 3px; transition: transform .16s;
    }
    .sw input:checked + i { background: #10b981; }
    .sw input:checked + i::after { transform: translateX(15px); }
    .btns { display: flex; align-items: center; gap: 6px; }
    .btns button {
      width: 22px; height: 22px; border-radius: 7px; border: 1px solid rgba(255,255,255,.14);
      background: rgba(255,255,255,.06); color: #e5e7eb; cursor: pointer; font-size: 13px; line-height: 1;
    }
    .btns button:hover { background: rgba(255,255,255,.14); }
    .btns b { min-width: 44px; text-align: center; font-variant-numeric: tabular-nums; }
    .msg {
      max-width: 260px; padding: 6px 10px; border-radius: 9px; font-size: 11px;
      background: rgba(17, 24, 39, .9); border: 1px solid rgba(255,255,255,.08);
      color: #fde68a; opacity: 0; transform: translateY(-3px); transition: opacity .18s, transform .18s;
      pointer-events: none;
    }
    .msg.show { opacity: 1; transform: none; }
  `;

  function removeHud() {
    if (S.hud && S.hud.host) {
      try { S.hud.host.remove(); } catch (e) { /* ignore */ }
      S.hud = null;
    }
  }

  function ensureHud() {
    if (!isTop || !S.settings.showHud) return;
    if (S.hud && S.hud.host && S.hud.host.isConnected) return;

    const host = document.createElement('div');
    host.id = 'van-hud';
    host.style.cssText =
      'position:fixed!important;right:16px!important;bottom:16px!important;left:auto!important;top:auto!important;' +
      'z-index:2147483647!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;' +
      'width:auto!important;height:auto!important;display:block!important;';

    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${HUD_CSS}</style>
      <div class="wrap">
        <div class="msg" data-role="msg"></div>
        <div class="panel" data-role="panel">
          <div class="row"><span>自动连播</span>
            <label class="sw"><input type="checkbox" data-set="autoNext"><i></i></label></div>
          <div class="row"><span>助手总开关</span>
            <label class="sw"><input type="checkbox" data-set="enabled"><i></i></label></div>
          <div class="row"><span>倍速</span>
            <span class="btns"><button data-act="slower">−</button><b data-role="speed2">1×</b><button data-act="faster">+</button></span></div>
          <div class="row small" data-role="progress">—</div>
          <div class="row small" data-role="keys">N 下一集 · [ ] 倍速 · J L 快退/快进</div>
        </div>
        <div class="bar" data-role="bar">
          <span class="dot" data-role="dot"></span>
          <span class="speed" data-role="speed">1×</span>
          <span class="label" data-role="label">自动连播</span>
          <span class="caret">▾</span>
        </div>
      </div>`;
    document.documentElement.appendChild(host);

    S.hud = { host, root };

    const bar = root.querySelector('[data-role="bar"]');
    const panel = root.querySelector('[data-role="panel"]');
    bar.addEventListener('click', () => panel.classList.toggle('show'));

    root.querySelectorAll('input[data-set]').forEach((input) => {
      input.addEventListener('change', () => {
        const key = input.getAttribute('data-set');
        const patch = {};
        patch[key] = input.checked;
        saveSettings(patch);
      });
    });

    root.querySelectorAll('button[data-act]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = btn.getAttribute('data-act');
        const cur = currentVideo() ? currentVideo().playbackRate : 1;
        if (act === 'faster') setSpeed(P.stepSpeed(cur, 1, C.SPEED_STEPS));
        if (act === 'slower') setSpeed(P.stepSpeed(cur, -1, C.SPEED_STEPS));
      });
    });

    updateHud();
  }

  function formatSpeed(v) {
    const n = Math.round((Number(v) || 1) * 100) / 100;
    return (Number.isInteger(n) ? String(n) : String(n)) + '×';
  }

  function updateHud() {
    if (!S.hud || !S.hud.root) return;
    const r = S.hud.root;
    const speedEl = r.querySelector('[data-role="speed"]');
    const speed2 = r.querySelector('[data-role="speed2"]');
    const dot = r.querySelector('[data-role="dot"]');
    const label = r.querySelector('[data-role="label"]');
    const prog = r.querySelector('[data-role="progress"]');

    const media = S.media || (currentVideo() ? {
      speed: currentVideo().playbackRate,
      current: currentVideo().currentTime,
      duration: currentVideo().duration
    } : null);

    const speed = media && media.speed ? media.speed : 1;
    if (speedEl) speedEl.textContent = formatSpeed(speed);
    if (speed2) speed2.textContent = formatSpeed(speed);
    if (dot) {
      dot.className = 'dot ' + (!S.settings.enabled ? 'off' : media ? 'on' : '');
    }
    if (label) {
      label.textContent = S.settings.enabled
        ? (S.settings.autoNext ? '自动连播' : '连播已关')
        : '助手已关';
    }
    if (prog) {
      const pend = pendingLocal(null).length;
      const base = media && media.duration
        ? P.formatClock(media.current) + ' / ' + P.formatClock(media.duration)
        : '等待视频…';
      prog.textContent = base + (pend > 1 ? ' · 本节还有 ' + pend + ' 个' : '');
    }

    r.querySelectorAll('input[data-set]').forEach((input) => {
      const k = input.getAttribute('data-set');
      input.checked = !!S.settings[k];
    });
  }

  function flash(text, ms) {
    if (S.hud && S.hud.root) {
      const msg = S.hud.root.querySelector('[data-role="msg"]');
      if (msg) {
        msg.textContent = text;
        msg.classList.add('show');
        clearTimeout(msg.__t);
        msg.__t = setTimeout(() => msg.classList.remove('show'), ms || 3200);
      }
    }
    try { console.log('[视频助手]', text); } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------------ *
   * 倒计时条
   * ------------------------------------------------------------------ */

  const OVERLAY_CSS = `
    .box {
      position: fixed; left: 50%; top: 22px; transform: translate(-50%, -14px);
      width: min(420px, calc(100vw - 40px));
      font: 13px/1.55 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      color: #f9fafb; background: rgba(17, 24, 39, .94);
      border: 1px solid rgba(255,255,255,.12); border-radius: 14px;
      box-shadow: 0 18px 50px rgba(0,0,0,.45); padding: 14px 16px 12px;
      opacity: 0; pointer-events: none; transition: opacity .18s ease, transform .18s ease;
      backdrop-filter: blur(12px);
    }
    .box.show { opacity: 1; transform: translate(-50%, 0); pointer-events: auto; }
    .title { font-weight: 700; font-size: 14px; }
    .sub { opacity: .7; font-size: 11.5px; margin-top: 2px; }
    .track { height: 3px; border-radius: 999px; background: rgba(255,255,255,.14); margin: 10px 0 10px; overflow: hidden; }
    .fill { height: 100%; width: 0; background: linear-gradient(90deg, #34d399, #22d3ee); transition: width .1s linear; }
    .actions { display: flex; justify-content: flex-end; }
    .cancel {
      border: 1px solid rgba(255,255,255,.16); background: rgba(255,255,255,.06); color: #f9fafb;
      border-radius: 8px; padding: 5px 11px; font-size: 12px; cursor: pointer;
    }
    .cancel:hover { background: rgba(255,255,255,.14); }
  `;

  function ensureOverlay() {
    if (S.overlay && S.overlay.host && S.overlay.host.isConnected) return S.overlay;
    const host = document.createElement('div');
    host.id = 'van-overlay';
    host.style.cssText = 'position:fixed!important;inset:0!important;z-index:2147483646!important;pointer-events:none!important;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${OVERLAY_CSS}</style>
      <div class="box">
        <div class="title"></div>
        <div class="sub">按 Esc 或点击“取消”可以停在当前页面</div>
        <div class="track"><div class="fill"></div></div>
        <div class="actions"><button class="cancel">取消自动切换</button></div>
      </div>`;
    document.documentElement.appendChild(host);
    S.overlay = { host, root };
    return S.overlay;
  }

  function showCountdown(seconds, onDone) {
    if (!isTop) return;
    hideCountdown();
    const o = ensureOverlay();
    const box = o.root.querySelector('.box');
    const title = o.root.querySelector('.title');
    const fill = o.root.querySelector('.fill');
    const cancel = o.root.querySelector('.cancel');
    box.classList.add('show');

    const total = Math.max(1, seconds) * 1000;
    const started = Date.now();
    const state = { timer: 0 };
    S.countdownState = state;

    const finish = () => {
      hideCountdown();
      try { onDone(); } catch (e) { /* ignore */ }
    };

    const tick = () => {
      const left = Math.max(0, total - (Date.now() - started));
      const sec = Math.ceil(left / 1000);
      title.textContent = sec > 0 ? sec + ' 秒后播放下一集' : '正在切换…';
      fill.style.width = Math.min(100, (1 - left / total) * 100).toFixed(1) + '%';
      if (left <= 0) { finish(); return; }
      state.timer = setTimeout(tick, 100);
    };

    cancel.addEventListener('click', () => {
      hideCountdown();
      flash('已取消自动切换');
    }, { once: true });

    tick();
  }

  function hideCountdown() {
    if (S.countdownState && S.countdownState.timer) clearTimeout(S.countdownState.timer);
    S.countdownState = null;
    if (S.overlay && S.overlay.root) {
      const box = S.overlay.root.querySelector('.box');
      if (box) box.classList.remove('show');
      const fill = S.overlay.root.querySelector('.fill');
      if (fill) fill.style.width = '0%';
    }
  }

  /* ------------------------------------------------------------------ *
   * 键盘快捷键
   * ------------------------------------------------------------------ */

  function onKeyDown(e) {
    if (e.key === 'Escape' && S.countdownState) {
      hideCountdown();
      flash('已取消自动切换');
      return;
    }
    if (!S.settings.enabled || !S.settings.shortcuts) return;
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (P.isTypingTarget(e.target)) return;

    const v = currentVideo();
    let handled = true;

    switch (e.key) {
      case ']':
        if (v) setSpeed(P.stepSpeed(v.playbackRate, 1, C.SPEED_STEPS));
        break;
      case '[':
        if (v) setSpeed(P.stepSpeed(v.playbackRate, -1, C.SPEED_STEPS));
        break;
      case '\\':
        setSpeed(1);
        break;
      case 'j':
        if (v) try { v.currentTime = Math.max(0, v.currentTime - 10); } catch (err) { /* ignore */ }
        break;
      case 'l':
        if (v) try { v.currentTime = Math.min(v.duration || 1e9, v.currentTime + 10); } catch (err) { /* ignore */ }
        break;
      case 'k':
        if (v) { if (v.paused) { v.play().catch(() => {}); } else { v.pause(); } }
        break;
      case 'm':
        if (v) v.muted = !v.muted;
        break;
      case 'f':
        if (v && document.fullscreenElement) { document.exitFullscreen().catch(() => {}); }
        else if (v && v.requestFullscreen) { v.requestFullscreen().catch(() => {}); }
        break;
      case 'n':
        requestNext();
        break;
      default:
        handled = false;
    }

    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  /* ------------------------------------------------------------------ *
   * 消息（popup）
   * ------------------------------------------------------------------ */

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || !msg.type) return;
      if (msg.type === 'van:status') {
        if (!isTop) return;
        const child = childVideoStats();
        publishTopStatus();
        sendResponse({
          ok: true,
          version: C.VERSION,
          videos: S.videos.size,
          childVideos: child.videos,
          childFrames: child.frames,
          pending: pendingLocal(null).length,
          media: S.media,
          settings: S.settings
        });
        return true;
      }
      if (msg.type === 'van:test-next') {
        requestNext();
        sendResponse({ ok: true });
        return true;
      }
      return false;
    });
  }

  /* ------------------------------------------------------------------ *
   * 设置变化 & 生命周期
   * ------------------------------------------------------------------ */

  function applySettingsToDom() {
    if (isTop && S.settings.showHud) ensureHud();
    else removeHud();
    if (S.settings.visualDetect) rearmVisual();
    else stopVisual();
    updateHud();
  }

  function armObserver() {
    if (S.observer || !document.documentElement) return;
    let scheduled = false;
    try {
      S.observer = new MutationObserver(() => {
        if (scheduled) return;
        scheduled = true;
        setTimeout(() => { scheduled = false; scan(); }, 600);
      });
      S.observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) { /* ignore */ }
  }

  document.addEventListener('play', (e) => {
    if (e.target && e.target.tagName === 'VIDEO') attach(e.target);
  }, true);

  document.addEventListener('ended', (e) => {
    if (e.target && e.target.tagName === 'VIDEO') onVideoEnded(e.target, 'event');
  }, true);

  document.addEventListener('ratechange', (e) => {
    const v = e.target;
    if (!v || v.tagName !== 'VIDEO') return;
    if (!S.settings.rememberSpeed) return;
    const rate = P.clampSpeed(v.playbackRate || 1);
    S.speedCache[location.host] = rate;
    if (Date.now() - (S.lastSpeedSave || 0) > 1500) {
      S.lastSpeedSave = Date.now();
      localSet({ [speedKey()]: rate });
    }
    updateHud();
  }, true);

  document.addEventListener('keydown', onKeyDown, true);

  window.addEventListener('message', (e) => handleMessage(e.data, e));

  window.addEventListener('pagehide', () => {
    S.unloading = true;
    flushPositionsNow();
  });

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !changes) return;
      const next = Object.assign({}, S.settings);
      let touched = false;
      for (const k in changes) {
        if (Object.prototype.hasOwnProperty.call(changes, k)) {
          next[k] = changes[k].newValue;
          touched = true;
        }
      }
      if (!touched) return;
      S.settings = Object.assign({}, C.DEFAULT_SETTINGS, next);
      applySettingsToDom();
      updateHud();
      scan();
    });
  }

  async function init() {
    S.settings = await readSettings();
    await loadPositions();
    if (S.settings.rememberSpeed) await loadSpeed();

    applySettingsToDom();

    // 首屏与延迟渲染的播放器各扫一次
    scan();
    setTimeout(() => scan(), 1200);
    setTimeout(() => deepScan(), 2500);
    armObserver();

    // 刚由答题模块点了“下一节”：新页面的视频要自己按播放
    setTimeout(maybeKickFromSwitch, 800);
    try {
      if (chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area !== 'local' || !changes || !changes.vanAutoPlayAt) return;
          startLessonKick();
        });
      }
    } catch (e) { /* ignore */ }

    // 定期心跳：顶层刷 HUD；子 frame 把“还有没有视频”报给父 frame
    if (isTop) {
      setInterval(() => {
        if (S.settings.showHud) updateHud();
      }, 1500);
    } else {
      setTimeout(postState, 1200);
      setInterval(postState, 2000);
    }
  }

  init().catch(() => { /* 任何初始化异常都不应该影响页面本身 */ });
})();
