/*
 * 答题纯函数单元测试：node --test test/
 * 覆盖“题干清洗 / 题型识别 / 答案归一化 / 题库匹配 / AI 回复解析”这些
 * 最容易出错又不需要浏览器的规则。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

require(path.join(here, '..', 'shared', 'qa.js'));

const Q = globalThis.VAN_QA;

const OPTIONS = [
  { key: 'A', text: '甲方案' },
  { key: 'B', text: '乙方案' },
  { key: 'C', text: '丙方案' },
  { key: 'D', text: '丁方案' }
];

const JUDGE_OPTIONS = [
  { key: 'A', text: '正确' },
  { key: 'B', text: '错误' }
];

test('qa.js 已挂到 globalThis', () => {
  assert.ok(Q, 'VAN_QA 应该存在');
  assert.equal(typeof Q.parseAnswer, 'function');
});

/* ---------------- 文本清洗 ---------------- */

test('cleanStem 去掉题号与题型标记', () => {
  assert.equal(Q.cleanStem('（单选题）1. 下列说法正确的是（ ）'), '下列说法正确的是（ ）');
  assert.equal(Q.cleanStem('3、马克思主义的三个组成部分是'), '马克思主义的三个组成部分是');
  assert.equal(Q.cleanStem('  （2.0分）下列哪项属于需求'), '下列哪项属于需求');
  assert.equal(Q.cleanStem('下列哪项属于需求（2.0分）'), '下列哪项属于需求');
  // 学习通常见格式：题型和分值写在同一个括号里，后面还跟着题号
  assert.equal(Q.cleanStem('（单选题, 2.0分）1. 中华人民共和国成立于哪一年？'), '中华人民共和国成立于哪一年？');
  assert.equal(Q.cleanStem('（多选题，3.0分）2、下列哪些属于需求侧管理？'), '下列哪些属于需求侧管理？');
});

test('normalizeQuestion 只留内容，方便比对', () => {
  assert.equal(Q.normalizeQuestion('  下列，哪项 属于需求？ '), '下列哪项属于需求');
  assert.equal(Q.normalizeQuestion(null), '');
});

test('cleanOptionText 去掉选项前缀', () => {
  assert.equal(Q.cleanOptionText('A. 甲方案', 'A'), '甲方案');
  assert.equal(Q.cleanOptionText('B、乙方案', 'B'), '乙方案');
  assert.equal(Q.cleanOptionText('丙方案', 'C'), '丙方案');
});

/* ---------------- 题型识别 ---------------- */

test('detectType 优先看括号里的题型', () => {
  assert.equal(Q.detectType('（单选题, 2.0分）', { radio: 3 }), 'single');
  assert.equal(Q.detectType('(多选题, 4.0分)', { checkbox: 3 }), 'multi');
  // 没有控件时也要能从“题型+分值”的括号里认出来
  assert.equal(Q.detectType('（判断题, 2.0分）', {}), 'judge');
  assert.equal(Q.detectType('【判断题】', { radio: 2 }), 'judge');
  assert.equal(Q.detectType('填空题', { text: 2 }), 'fill');
});

test('detectType 没有标记时看控件', () => {
  assert.equal(Q.detectType('', { checkbox: 3 }), 'multi');
  assert.equal(Q.detectType('', { textarea: 1 }), 'short');
  assert.equal(Q.detectType('', { text: 1 }), 'fill');
  assert.equal(Q.detectType('', { radio: 2 }), 'single');
});

test('两个选项是“正确/错误”时判为判断题', () => {
  assert.equal(Q.detectType('', { radio: 2, optionTexts: ['正确', '错误'] }), 'judge');
  assert.equal(Q.detectType('', { radio: 4, optionTexts: ['甲', '乙', '丙', '丁'] }), 'single');
});

/* ---------------- 答案归一化 ---------------- */

test('单选：字母、带分隔符、字母大小写都能认', () => {
  assert.deepEqual(Q.parseAnswer('B', OPTIONS, 'single').keys, ['B']);
  assert.deepEqual(Q.parseAnswer('b', OPTIONS, 'single').keys, ['B']);
  assert.deepEqual(Q.parseAnswer('答案：C', OPTIONS, 'single').keys, ['C']);
  assert.deepEqual(Q.parseAnswer('“A”', OPTIONS, 'single').keys, ['A']);
});

test('多选：连续字母和顿号分隔都拆得开', () => {
  assert.deepEqual(Q.parseAnswer('ABD', OPTIONS, 'multi').keys, ['A', 'B', 'D']);
  assert.deepEqual(Q.parseAnswer('A、C', OPTIONS, 'multi').keys, ['A', 'C']);
  assert.deepEqual(Q.parseAnswer('A,B', OPTIONS, 'multi').keys, ['A', 'B']);
  assert.deepEqual(Q.parseAnswer('ABD', OPTIONS, 'multi').keys.length, 3);
});

test('直接给选项原文也能匹配', () => {
  assert.deepEqual(Q.parseAnswer('乙方案', OPTIONS, 'single').keys, ['B']);
  assert.deepEqual(Q.parseAnswer('乙方案。', OPTIONS, 'single').keys, ['B']);
});

test('判断题：正确/错误、对/错、√/× 都归一', () => {
  assert.deepEqual(Q.parseAnswer('正确', JUDGE_OPTIONS, 'judge').keys, ['A']);
  assert.deepEqual(Q.parseAnswer('错误', JUDGE_OPTIONS, 'judge').keys, ['B']);
  assert.deepEqual(Q.parseAnswer('对', JUDGE_OPTIONS, 'judge').keys, ['A']);
  assert.deepEqual(Q.parseAnswer('×', JUDGE_OPTIONS, 'judge').keys, ['B']);
});

test('填空题保留原文，按 | 分空由调用方处理', () => {
  const r = Q.parseAnswer('光合作用|叶绿体', [], 'fill');
  assert.equal(r.kind, 'text');
  assert.equal(r.text, '光合作用|叶绿体');
});

test('空答案 / 不确定答案不会被误填', () => {
  assert.equal(Q.parseAnswer('', OPTIONS, 'single').kind, 'empty');
  assert.equal(Q.parseAnswer('无', OPTIONS, 'single').kind, 'empty');
  assert.equal(Q.parseAnswer('不知道', OPTIONS, 'single').kind, 'empty');
});

/* ---------------- 哈希与相似度 ---------------- */

test('hashQuestion 同题同哈希、不同题不同哈希', () => {
  const a = Q.hashQuestion('下列哪项属于需求', OPTIONS);
  const b = Q.hashQuestion('下列哪项属于需求', OPTIONS);
  const c = Q.hashQuestion('下列哪项属于供给', OPTIONS);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('similarity 忽略标点空白，完全一致返回 1', () => {
  assert.equal(Q.similarity('中华人民共和国成立于哪一年', '中华人民共和国成立于哪一年？'), 1);
  assert.ok(Q.similarity('马克思主义哲学', '西方经济学导论') < 0.2);
});

/* ---------------- 题库 ---------------- */

test('parseBankFile 支持 JSON 数组与对象', () => {
  const fromArr = Q.parseBankFile('[{"q":"题目一","a":"A"},{"question":"题目二","answer":"正确"}]');
  assert.equal(fromArr.length, 2);
  assert.equal(fromArr[0].a, 'A');
  assert.equal(fromArr[1].q, '题目二');

  const fromObj = Q.parseBankFile('{"题目一":"A","题目二":"B"}');
  assert.equal(fromObj.length, 2);
  assert.equal(fromObj[0].a, 'A');
});

test('parseBankFile 支持 Tab / 破折号 / CSV 文本', () => {
  const tab = Q.parseBankFile('题目一\tA\n题目二\tB');
  assert.equal(tab.length, 2);
  assert.equal(tab[1].a, 'B');

  const dash = Q.parseBankFile('题目一----A\n题目二----正确');
  assert.equal(dash.length, 2);
  assert.equal(dash[1].a, '正确');

  const csv = Q.parseBankFile('中华人民共和国成立于哪一年,1949年');
  assert.equal(csv.length, 1);
  assert.equal(csv[0].a, '1949年');
});

test('parseBankFile 忽略表头和坏行', () => {
  const bank = Q.parseBankFile('题目\t答案\n\n没有分隔符的一行\n题目三\tC');
  assert.equal(bank.length, 1);
  assert.equal(bank[0].q, '题目三');
});

test('findInBank 精确命中优先，模糊命中带分数', () => {
  const bank = [
    { q: '中华人民共和国成立于哪一年？', a: '1949年' },
    { q: '马克思主义哲学认为世界的本原是物质', a: '唯物主义' }
  ];
  const exact = Q.findInBank(bank, { stem: '中华人民共和国成立于哪一年' });
  assert.equal(exact.a, '1949年');
  assert.equal(exact.score, 1);

  const fuzzy = Q.findInBank(bank, { stem: '马克思主义哲学认为世界的本原是物质。' }, 0.8);
  assert.equal(fuzzy.a, '唯物主义');
  assert.ok(fuzzy.score >= 0.8);
});

test('findInBank 对无关题目不乱给答案', () => {
  const bank = [{ q: '中华人民共和国成立于哪一年？', a: '1949年' }];
  assert.equal(Q.findInBank(bank, { stem: '光合作用的场所是什么' }, 0.9), null);
  assert.equal(Q.findInBank([], { stem: '任意' }), null);
  assert.equal(Q.findInBank(null, { stem: '任意' }), null);
});

/* ---------------- AI 请求 / 回复 ---------------- */

test('buildAiRequest 带系统提示、题目和输出格式', () => {
  const msgs = Q.buildAiRequest([{
    id: 1, type: 'single', stem: '中华人民共和国成立于哪一年？', options: OPTIONS
  }]);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'system');
  assert.ok(msgs[1].content.includes('中华人民共和国成立于哪一年'));
  assert.ok(msgs[1].content.includes('A. 甲方案'));
  assert.ok(msgs[1].content.includes('{"answers"'));
});

test('parseAiReply 兼容标准包装、代码围栏和纯数组', () => {
  const std = Q.parseAiReply('{"answers":[{"id":1,"answer":"B","confidence":0.9,"reason":"常识"}]}');
  assert.equal(std.length, 1);
  assert.equal(std[0].answer, 'B');
  assert.equal(std[0].confidence, 0.9);

  const fenced = Q.parseAiReply('```json\n{"answers":[{"id":2,"answer":"正确"}]}\n```');
  assert.equal(fenced[0].id, 2);
  assert.equal(fenced[0].answer, '正确');

  const arr = Q.parseAiReply('[{"id":1,"answer":"A"},{"id":2,"answer":"C"}]');
  assert.equal(arr.length, 2);
  assert.equal(arr[1].answer, 'C');
});

test('parseAiReply 兼容 {id: answer} 映射和单对象', () => {
  const map = Q.parseAiReply('{"1":"A","2":"AB"}');
  assert.equal(map.length, 2);
  assert.equal(map[1].answer, 'AB');

  const single = Q.parseAiReply('{"answer":"错误","confidence":1}');
  assert.equal(single[0].answer, '错误');
});

test('parseAiReply 遇到垃圾文本返回空数组而不是抛错', () => {
  assert.deepEqual(Q.parseAiReply('抱歉，我无法回答'), []);
  assert.deepEqual(Q.parseAiReply(''), []);
  assert.deepEqual(Q.parseAiReply(null), []);
});

test('extractJson 能从带前后废话的回复里抠出 JSON', () => {
  const obj = Q.extractJson('好的，结果如下：{"answers":[]} 以上。');
  assert.deepEqual(obj, { answers: [] });
});

/* ---------------- 默认配置 ---------------- */

test('DEFAULT_QA_CONFIG 是安全的默认值', () => {
  assert.equal(Q.DEFAULT_QA_CONFIG.provider, 'ai');
  assert.equal(Q.DEFAULT_QA_CONFIG.bankFirst, true);
  assert.equal(Q.DEFAULT_QA_CONFIG.maxBatch, 6);
  assert.equal(Q.DEFAULT_QA_CONFIG.api.method, 'POST');
  assert.ok(Q.DEFAULT_QA_CONFIG.ai.baseUrl.includes('deepseek.com'));
  assert.equal(Q.DEFAULT_QA_CONFIG.ai.apiKey, '');
});

test('每种题型都有中文标签', () => {
  for (const t of ['single', 'multi', 'judge', 'fill', 'short', 'essay', 'other']) {
    assert.ok(Q.TYPE_LABEL[t], t + ' 应该有标签');
  }
});
