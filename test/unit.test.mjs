/*
 * 纯函数单元测试：node --test test/
 * 只测 shared/pure.js 里不依赖 DOM 的部分——尤其是“哪个按钮才是下一集”的打分规则。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

require(path.join(here, '..', 'shared', 'pure.js'));
require(path.join(here, '..', 'shared', 'constants.js'));

const P = globalThis.VAN_PURE;
const C = globalThis.VAN_CONST;

test('pure.js / constants.js 都已挂到 globalThis', () => {
  assert.ok(P, 'VAN_PURE 应该存在');
  assert.ok(C, 'VAN_CONST 应该存在');
});

test('normalizeText 去掉零宽字符并折叠空白', () => {
  assert.equal(P.normalizeText('\u200b 下一集\u3000 \n '), '下一集');
  assert.equal(P.normalizeText(null), '');
});

test('matchesNextWord 认得各种“下一集”写法', () => {
  for (const s of ['下一集', '播放下一节', 'Next Video', 'up next', '继续播放']) {
    assert.equal(P.matchesNextWord(s), true, s);
  }
  assert.equal(P.matchesNextWord('上一集'), false);
  assert.equal(P.matchesNextWord('随机播放'), false);
});

test('matchesNegWord 认出容易误点的按钮', () => {
  for (const s of ['上一集', '播放列表', '倍速', '广告']) {
    assert.equal(P.matchesNegWord(s), true, s);
  }
  assert.equal(P.matchesNegWord('下一集'), false);
});

test('不可见候选直接判负分', () => {
  assert.equal(P.scoreCandidate({ text: '下一集', visible: false }), -Infinity);
});

test('“下一集”按钮胜过“上一集 / 播放列表”', () => {
  const descs = [
    { text: '上一集', tag: 'button', visible: true },
    { text: '播放列表', tag: 'button', visible: true },
    { text: '下一集', tag: 'button', visible: true }
  ];
  assert.equal(P.pickBestCandidate(descs), 2);
  const ranked = P.rankCandidates(descs);
  assert.equal(ranked.length, 1, '只有“下一集”应该过线');
});

test('没有可信候选时返回 -1，绝不乱点', () => {
  const descs = [
    { text: '确定', tag: 'button', visible: true },
    { text: '收藏', tag: 'button', visible: true }
  ];
  assert.deepEqual(P.rankCandidates(descs), []);
  assert.equal(P.pickBestCandidate(descs), -1);
});

test('自定义选择器的高先验分能压过文本命中', () => {
  const descs = [
    { text: '下一集', tag: 'button', visible: true },
    { text: '继续学习', tag: 'div', role: 'button', visible: true, priority: 120 }
  ];
  assert.equal(P.pickBestCandidate(descs), 1);
});

test('rel=next 加分但不足以单独过线', () => {
  const withRel = { text: '', tag: 'a', rel: 'next', visible: true };
  assert.ok(P.scoreCandidate(withRel) < P.MIN_SCORE);
  assert.ok(P.scoreCandidate({ text: '下一集', tag: 'a', rel: 'next', visible: true }) >= P.MIN_SCORE);
});

test('disabled 候选不会被选中', () => {
  assert.ok(P.scoreCandidate({ text: '下一集', tag: 'button', visible: true, disabled: true }) < P.MIN_SCORE);
});

test('formatClock 的正常与异常输入', () => {
  assert.equal(P.formatClock(0), '0:00');
  assert.equal(P.formatClock(65), '1:05');
  assert.equal(P.formatClock(3725), '1:02:05');
  assert.equal(P.formatClock(NaN), '--:--');
  assert.equal(P.formatClock(-3), '--:--');
});

test('clampSpeed 限制在 0.25 ~ 4 之间', () => {
  assert.equal(P.clampSpeed(0), 0.25);
  assert.equal(P.clampSpeed(99), 4);
  assert.equal(P.clampSpeed('1.5'), 1.5);
  assert.equal(P.clampSpeed('abc'), 1);
});

test('stepSpeed 按档位加减且在边界停住', () => {
  assert.equal(P.stepSpeed(1, 1), 1.25);
  assert.equal(P.stepSpeed(1, -1), 0.75);
  assert.equal(P.stepSpeed(0.5, -1), 0.5);
  assert.equal(P.stepSpeed(3, 1), 3);
  assert.equal(P.stepSpeed(1.37, 1), 1.5);
});

test('isTypingTarget 判断输入焦点', () => {
  assert.equal(P.isTypingTarget({ tagName: 'INPUT' }), true);
  assert.equal(P.isTypingTarget({ tagName: 'TEXTAREA' }), true);
  assert.equal(P.isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(P.isTypingTarget({ tagName: 'DIV' }), false);
  assert.equal(P.isTypingTarget(null), false);
});

test('parseSelectorList 逐行解析并丢弃空行', () => {
  assert.deepEqual(
    P.parseSelectorList('\n#nextBtn\n  .player .next  \n\n'),
    ['#nextBtn', '.player .next']
  );
  assert.deepEqual(P.parseSelectorList(''), []);
});

test('DONE_RATIO 用来判定“已经看完”', () => {
  assert.ok(P.DONE_RATIO > 0.9 && P.DONE_RATIO < 1);
});

test('pickPendingIndex 挑第一个没看完的', () => {
  assert.equal(P.pickPendingIndex([{ done: false }, { done: false }]), 0);
  assert.equal(P.pickPendingIndex([{ done: true }, { done: false }]), 1);
  assert.equal(P.pickPendingIndex([{ done: true }, { done: true }]), -1);
  assert.equal(P.pickPendingIndex([]), -1);
  assert.equal(P.pickPendingIndex(null), -1);
  // 缺字段的视频当成“还没看完”，宁可多播一遍也别漏
  assert.equal(P.pickPendingIndex([{}, { done: true }]), 0);
});

test('countPending 数出还有几个没看完', () => {
  assert.equal(P.countPending([{ done: false }, { done: true }, { done: false }]), 2);
  assert.equal(P.countPending([{ done: true }]), 0);
  assert.equal(P.countPending([]), 0);
  assert.equal(P.countPending(null), 0);
});

test('默认设置与设计一致', () => {
  assert.equal(C.DEFAULT_SETTINGS.autoNext, true);
  assert.equal(C.DEFAULT_SETTINGS.delaySec, 5);
  assert.equal(C.DEFAULT_SETTINGS.enabled, true);
  assert.ok(C.SPEED_STEPS.includes(1));
  assert.equal(C.CHANNEL, 'van');
});

test('答题模块默认关闭，打开总开关后默认自动运行', () => {
  assert.equal(C.DEFAULT_SETTINGS.qaEnabled, false);
  assert.equal(C.DEFAULT_SETTINGS.qaAutoRun, true);
  assert.equal(C.DEFAULT_SETTINGS.qaAutoSubmit, true);
});
