/*
 * 演示用“视频素材”生成器：不依赖任何素材文件，用 canvas + MediaRecorder
 * 现场录一段 WebM，同一段素材会被缓存起来重复使用，避免每个视频都录一遍。
 *
 *   const blob = await window.__clip.makeClip(4, '任务点');
 *   video.src = URL.createObjectURL(blob);
 */
(() => {
  'use strict';

  const cache = new Map();
  const supported = typeof MediaRecorder !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream;

  if (!supported) {
    window.__clip = {
      supported: false,
      makeClip: async () => { throw new Error('当前浏览器不支持现场生成视频'); }
    };
    return;
  }

  function drawFrame(ctx, canvas, t, total, label) {
    const w = canvas.width;
    const h = canvas.height;
    const hue = (label.length * 53 + t * 16) % 360;

    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, 'hsl(' + hue + ', 62%, 24%)');
    g.addColorStop(1, 'hsl(' + ((hue + 70) % 360) + ', 68%, 12%)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // 缓慢移动的光斑，保证画面一直在变、不会被判成“卡住”
    const cx = w / 2 + Math.sin(t * 0.9) * w * 0.22;
    const cy = h / 2 + Math.cos(t * 0.7) * h * 0.18;
    const rg = ctx.createRadialGradient(cx, cy, 10, cx, cy, w * 0.45);
    rg.addColorStop(0, 'hsla(' + ((hue + 30) % 360) + ', 90%, 62%, .55)');
    rg.addColorStop(1, 'hsla(' + ((hue + 30) % 360) + ', 90%, 62%, 0)');
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, w, h);

    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,.95)';
    ctx.font = '700 54px system-ui, "Microsoft YaHei", sans-serif';
    ctx.fillText(label, w / 2, h / 2 - 4);

    ctx.fillStyle = 'rgba(255,255,255,.62)';
    ctx.font = '400 17px system-ui, "Microsoft YaHei", sans-serif';
    ctx.fillText('本地模拟课程视频 · 自动连播测试', w / 2, h / 2 + 34);

    const pad = 46;
    const barW = w - pad * 2;
    ctx.fillStyle = 'rgba(255,255,255,.18)';
    ctx.fillRect(pad, h - 54, barW, 5);
    ctx.fillStyle = '#4ade80';
    ctx.fillRect(pad, h - 54, barW * Math.min(1, t / total), 5);

    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,.5)';
    ctx.font = '400 13px ui-monospace, Consolas, monospace';
    ctx.fillText(Math.max(0, total - t).toFixed(1) + 's', w - pad, h - 62);
  }

  async function record(total, label) {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');

    const stream = canvas.captureStream(30);
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
      ? 'video/webm;codecs=vp8'
      : 'video/webm';
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 900000 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

    const stopped = new Promise((resolve) => { rec.onstop = () => resolve(); });
    rec.start(120);

    const t0 = performance.now();
    await new Promise((resolve) => {
      const tick = () => {
        const t = (performance.now() - t0) / 1000;
        drawFrame(ctx, canvas, Math.min(t, total), total, label);
        if (t < total) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });

    rec.stop();
    stream.getTracks().forEach((tr) => { try { tr.stop(); } catch (e) { /* ignore */ } });
    await stopped;

    return new Blob(chunks, { type: 'video/webm' });
  }

  window.__clip = {
    supported: true,
    /** 录一段 total 秒的片段，同样的 total+label 只会录一次。 */
    makeClip(total, label) {
      const key = total + '|' + label;
      if (!cache.has(key)) {
        cache.set(key, record(total, label).catch((err) => {
          cache.delete(key);
          throw err;
        }));
      }
      return cache.get(key);
    }
  };
})();
