/*
 * 视频播放助手 · 共享常量
 * 同时被 content script 与 popup 加载（都是普通脚本，挂在 globalThis 上）。
 */
(function (root) {
  'use strict';
  if (root.VAN_CONST) return;

  /** 用户可配置项及默认值。新增字段必须同时加到 DEFAULT_SETTINGS。 */
  var DEFAULT_SETTINGS = {
    enabled: true,          // 助手总开关
    autoNext: true,         // 视频结束后自动切下一集
    delaySec: 5,            // 倒计时秒数（0 = 立即切换）
    rememberSpeed: true,    // 按站点记住倍速
    resumePosition: true,   // 记忆播放进度，下次续播
    showHud: true,          // 页面右下角悬浮面板
    visualDetect: true,     // 画面识别兜底（播放器不触发 ended 时）
    shortcuts: true,        // 键盘快捷键
    extraSelectors: '',     // 自定义“下一集”选择器，每行一个

    // —— 自动答题（默认关闭，需要用户自己开）——
    qaEnabled: false,       // 答题模块总开关
    qaAutoRun: true,        // 打开答题页后自动开始（总开关关了就不生效）
    qaAutoSubmit: true,     // 填完自动提交（考试页永远不提交）
    qaAutoNext: true        // 交完自动点“下一节”，接着做下一小节
  };

  root.VAN_CONST = {
    VERSION: '1.3.23',
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    // 倍速档位（与快捷键 [ ] 联动）
    SPEED_STEPS: [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3],
    // 播放进度存储上限，防止 storage.local 无限增长
    MAX_PROGRESS_ENTRIES: 300,
    // 进度记录超过这个时间就不再续播
    PROGRESS_TTL_MS: 7 * 24 * 60 * 60 * 1000,
    // 跨 frame 通信频道标识（postMessage 的 ch 字段）
    CHANNEL: 'van',
    // 调试用：URL 上 ?vanDelay=N 可覆盖倒计时，方便本地测试
    DELAY_OVERRIDE_PARAM: 'vanDelay'
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
