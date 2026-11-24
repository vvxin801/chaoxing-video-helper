/*
 * 本地演示播放器：不依赖任何素材文件，用 canvas + MediaRecorder 现场录一段 WebM
 * 当作“课程视频”，这样演示页可以离线跑。
 *
 * 参数：
 *   ?lesson=3      标题显示“第 3 集”
 *   ?dur=4         视频时长（秒，默认 5）
 *   ?autoplay=0    不在加载后自动播放（模拟“等待点播”的播放器，交给扩展来启动）
 */
(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  const lesson = params.get('lesson') || '1';
  const DURATION = Math.max(2, Number(params.get('dur')) || 5);
  const AUTOPLAY = params.get('autoplay') !== '0';

  const video = document.getElementById('v');
  const lessonEl = document.getElementById('lesson');
  const statusEl = document.getElementById('status');
  const innerNext = document.getElementById('innerNext');

  lessonEl.textContent = lesson;

  if (params.get('inner') === '1') {
    document.body.classList.add('inner');
    innerNext.addEventListener('click', () => {
      try { parent.postMessage({ ch: 'demo', t: 'next' }, '*'); } catch (e) { /* ignore */ }
    });
  }

  function setStatus(text) {
    statusEl.textContent = text;
    try { parent.postMessage({ type: 'van-demo-status', text: text, paused: video.paused, t: video.currentTime, dur: video.duration }, '*'); } catch (e) { /* ignore */ }
  }

  async function start() {
    if (!window.__clip || !window.__clip.supported) {
      setStatus('当前浏览器不支持现场生成视频');
      return;
    }
    try {
      setStatus('生成中…');
      const blob = await window.__clip.makeClip(DURATION, '第 ' + lesson + ' 集');
      video.src = URL.createObjectURL(blob);
      video.muted = true;

      window.__events = [];
      ['play', 'playing', 'pause', 'ended', 'canplay', 'loadedmetadata'].forEach(function (name) {
        video.addEventListener(name, function () {
          window.__events.push(name + '@' + Math.round(video.currentTime * 10) / 10);
          try { parent.postMessage({ type: 'van-demo-event', name: name }, '*'); } catch (e) { /* ignore */ }
        });
      });
      video.addEventListener('play', () => {
        setStatus('播放中（' + DURATION + 's）');
      });
      video.addEventListener('playing', () => {
        try { parent.postMessage({ type: 'van-demo-playing' }, '*'); } catch (e) { /* ignore */ }
      });
      video.addEventListener('ended', () => setStatus('已结束'));

      if (AUTOPLAY) {
        await video.play();
      } else {
        setStatus('等待播放');
      }
    } catch (e) {
      setStatus('播放失败：' + (e && e.message ? e.message : e));
    }
  }

  start();
})();
