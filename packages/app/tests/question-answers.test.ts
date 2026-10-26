import { describe, expect, it } from 'vitest';
import {
	normalizeAnswer,
	scriptAnswer,
	bankAnswers,
	sameAnswer,
	normalizeQuestion,
	questionFingerprint
} from '../src/question/answers';

const single = { question: '选择正确表达式', type: 'single', options: ['A. a-b', 'B. ab', 'C. a+b'] };
describe('答案按题型规范化', () => {
	it('明确模型/人工标号优先于恰好同名的选项文本；题库歧义拒绝', () => {
		const input = { question: '字母题', type: 'single', options: ['B', 'A'] };
		expect(scriptAnswer(normalizeAnswer(['A'], input), input)).toEqual(['A']);
		expect(() => normalizeAnswer(['A'], input, true)).toThrow(/既可表示/);
	});
	it('缺少空位元数据时也不压缩空白，None 可作为合法填空', () => {
		const input = { question: 'Python', type: 'completion', options: [] };
		expect(() => normalizeAnswer(['first', '', 'third'], input)).toThrow(/空位/);
		expect(scriptAnswer(normalizeAnswer(['None'], input), input)).toEqual(['None']);
	});
	it('没有选项的判断题仍校验真假，不把任意文字当填空', () => {
		const input = { question: '判断', type: 'judgement', options: [] };
		expect(normalizeAnswer(['错误'], input)).toEqual({ kind: 'judgement', value: false });
		expect(() => normalizeAnswer(['anything'], input)).toThrow();
		expect(() => normalizeAnswer(['A'], { ...input, type: 'single' })).toThrow(/缺少选项/);
	});
	it('保留数学标点，不把 a-b 与 ab 合并', () => {
		expect(normalizeAnswer(['a-b'], single)).toEqual({ kind: 'single', index: 0 });
		expect(normalizeAnswer(['ab'], single)).toEqual({ kind: 'single', index: 1 });
	});
	it('映射字母、序号和完整选项，拒绝部分匹配及矛盾标号', () => {
		for (const raw of ['A', '1', 'A. a-b']) expect(scriptAnswer(normalizeAnswer(raw, single), single)).toEqual(['A']);
		for (const raw of ['a-', 'A. ab', 'D']) {
			expect(() => normalizeAnswer(raw, single)).toThrow();
		}
	});
	it('单选不接受多个答案，重复文本不能任意选第一个', () => {
		expect(() => normalizeAnswer(['A', 'B'], single)).toThrow();
		expect(() => normalizeAnswer('重复', { ...single, options: ['重复', '重复'] })).toThrow();
	});
	it('多选比较忽略顺序，保留完整选项文本', () => {
		const input = { ...single, type: 'multiple' };
		expect(sameAnswer(normalizeAnswer(['C', 'A', 'A'], input), normalizeAnswer('AC', input))).toBe(true);
		expect(scriptAnswer(normalizeAnswer(['a-b', 'a+b'], input), input)).toEqual(['A', 'C']);
	});
	it('填空保留重复值和空位顺序，数量不符会失败', () => {
		const input = { question: '三个空', type: 'completion', options: ['', '', ''] };
		expect(scriptAnswer(normalizeAnswer(['乙', '甲', '乙'], input), input)).toEqual(['乙', '甲', '乙']);
		expect(() => normalizeAnswer(['甲'], input)).toThrow(/数量/);
		expect(sameAnswer(normalizeAnswer(['乙', '甲', '乙'], input), normalizeAnswer(['甲', '乙', '乙'], input))).toBe(
			false
		);
	});
	it('判断值映射回当前页面文本', () => {
		const input = { question: '判断', type: 'judgement', options: ['A. 错误', 'B. 正确'] };
		expect(scriptAnswer(normalizeAnswer('true', input), input)).toEqual(['B. 正确']);
		expect(normalizeAnswer('A', input)).toEqual({ kind: 'judgement', value: false });
	});
	it('题库错误和无答案占位不会成为有效来源', () => {
		const result = bankAnswers(
			[
				{ name: '失效', error: '离线', results: [{ answer: 'A' }] },
				{ name: '未知', results: [{ answer: '暂无答案' }] },
				{ name: '有效', results: [{ answer: 'A' }] }
			],
			single
		);
		expect(result.valid).toHaveLength(1);
	});
	it('指纹区分选项顺序及图片，正式考试地址不可自动提交', () => {
		expect(questionFingerprint(single)).not.toBe(
			questionFingerprint({ ...single, options: [...single.options].reverse() })
		);
		expect(questionFingerprint(single)).not.toBe(
			questionFingerprint({ ...single, images: ['https://example.com/a.png'] })
		);
		expect(
			normalizeQuestion({ ...single, sourceUrl: 'https://mooc1.chaoxing.com/exam-ans/exam/test' }).formalExam
		).toBe(true);
	});
});
