/*
 * 视频播放助手 · 画面识别兜底
 *
 * 解决一类播放器：视频播完后不派发 ended 事件（自绘播放器、直播壳、或把 video 藏起来换封面）。
 * 做法是把 video 当前帧缩小画到 96x54 的离屏 canvas 上，比较相邻帧：
 *   - 画面在临近结尾时连续 3 次几乎不变  -> 判定为已结束
 *   - 临近结尾时连续多帧接近全黑          -> 判定为片尾黑场
 *   - currentTime 卡住不动超过 2.8 秒      -> 判定为停住
 *
 * 注意：如果视频源是跨域且没给 CORS 头，canvas 会被污染，getImageData 抛 SecurityError。
 * 这时自动停用画面识别（onUnavailable 回调一次），其余逻辑照常工作，不会报错刷屏。
 */
(function (root) {
  'use strict';
  if (root.VAN_VISUAL) return;

  var W = 96;
  var H = 54;
  var SAMPLE_MS = 700;

  function now() { return Date.now(); }

  /**
   * @param {HTMLVideoElement} video
   * @param {{ onLikelyEnd?: (why: string) => void, onUnavailable?: (err: Error) => void }} cb
   * @returns {{ stop: () => void } | null}
   */
  function attach(video, cb) {
    if (!video || typeof document === 'undefined') return null;
    cb = cb || {};
    var canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    var ctx = null;
    try {
      ctx = canvas.getContext('2d', { willReadFrequently: true });
    } catch (e) {
      ctx = null;
    }
    if (!ctx) return null;

    var prevLuma = null;
    var stillCount = 0;
    var darkCount = 0;
    var stallCount = 0;
    var lastVideoTime = -1;
    var lastFire = 0;
    var stopped = false;
    var timer = 0;

    function stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = 0; }
    }

    function fire(why) {
      var t = now();
      if (t - lastFire < 10000) return;
      lastFire = t;
      stillCount = 0;
      darkCount = 0;
      stallCount = 0;
      if (typeof cb.onLikelyEnd === 'function') cb.onLikelyEnd(why);
    }

    function tick() {
      if (stopped) return;
      if (!video.isConnected) { stop(); return; }

      var playing = !video.paused && !video.ended && video.readyState >= 2;
      if (!playing) {
        prevLuma = null;
        stallCount = 0;
        timer = setTimeout(tick, 1000);
        return;
      }

      var px;
      try {
        ctx.drawImage(video, 0, 0, W, H);
        px = ctx.getImageData(0, 0, W, H).data;
      } catch (e) {
        // 跨域污染：画面识别不可用，静默退出
        stop();
        if (typeof cb.onUnavailable === 'function') cb.onUnavailable(e);
        return;
      }

      var n = W * H;
      var luma = new Float32Array(n);
      var sum = 0;
      for (var i = 0; i < n; i++) {
        var o = i * 4;
        var l = px[o] * 0.299 + px[o + 1] * 0.587 + px[o + 2] * 0.114;
        luma[i] = l;
        sum += l;
      }
      var mean = sum / n;

      var meanDiff = 0;
      if (prevLuma) {
        var acc = 0;
        for (var j = 0; j < n; j++) acc += Math.abs(luma[j] - prevLuma[j]);
        meanDiff = acc / n;
      }
      prevLuma = luma;

      var duration = Number(video.duration);
      var nearEnd = isFinite(duration) && duration > 0 && duration - video.currentTime < 10;

      var frozen = meanDiff < 1.2;
      stillCount = frozen ? stillCount + 1 : 0;
      darkCount = mean < 10 ? darkCount + 1 : 0;

      var advanced = Math.abs(video.currentTime - lastVideoTime) >= 0.05;
      lastVideoTime = video.currentTime;
      if (!advanced && nearEnd) {
        stallCount += 1;
      } else {
        stallCount = 0;
      }

      if (nearEnd && stillCount >= 3) {
        fire('frozen-frame');
      } else if (nearEnd && darkCount >= 3) {
        fire('black-frame');
      } else if (nearEnd && stallCount >= 4) {
        fire('stalled');
      }

      timer = setTimeout(tick, SAMPLE_MS + Math.random() * 200);
    }

    timer = setTimeout(tick, SAMPLE_MS);
    return { stop: stop };
  }

  root.VAN_VISUAL = { attach: attach };
})(typeof globalThis !== 'undefined' ? globalThis : window);
