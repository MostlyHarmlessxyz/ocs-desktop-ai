import { createHash } from 'crypto';
import type { QuestionInput, QuestionAnswer, QuestionBankInfo, QuestionSourceAnswer } from '@ocs-desktop/common';

/** Preserve mathematical punctuation and internal whitespace: a-b is not ab. */
const text = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ');
const optionText = (value: string) => text(value.replace(/^\s*(?:[A-Za-z]|\d{1,3})[.)、:：]\s*/, ''));
const absent = /^(?:null|undefined|n\/a|none|无答案|暂无答案|未找到答案|没有答案|不确定|无法确定|no answer)$/i;
function values(input: unknown): string[] {
	if (Array.isArray(input)) return input.flatMap(values);
	if (typeof input === 'number' || typeof input === 'boolean') return [String(input)];
	return typeof input === 'string' && text(input) && !absent.test(text(input)) ? [text(input)] : [];
}
function optionIndex(value: string, options: string[], bank = false) {
	const label = /^(?:(?:选项|答案|option|choice)\s*)?([A-Z]|\d{1,3})(?:[.)、:：]\s*(.*))?$/i.exec(value);
	if (label?.[2]) {
		const index = /^[A-Z]$/i.test(label[1]) ? label[1].toUpperCase().charCodeAt(0) - 65 : Number(label[1]) - 1;
		if (index < 0 || index >= options.length || optionText(label[2]) !== optionText(options[index])) {
			throw new Error('答案标号与选项文本不一致');
		}
		return index;
	}
	const exact = options
		.map(optionText)
		.map((v, i) => (v === optionText(value) ? i : -1))
		.filter((i) => i >= 0);
	if (label) {
		const i = /^[A-Z]$/i.test(label[1]) ? label[1].toUpperCase().charCodeAt(0) - 65 : Number(label[1]) - 1;
		if (i >= 0 && i < options.length) {
			if (bank && exact.some((index) => index !== i)) throw new Error('题库答案既可表示标号又可表示不同选项文本');
			return i;
		}
	}
	if (exact.length === 1) return exact[0];
	if (exact.length > 1) throw new Error('答案匹配到多个相同选项，请人工选择');
	throw new Error(`答案无法唯一对应选项：${value.slice(0, 100)}`);
}
function judgement(value: string): boolean | undefined {
	if (/^(true|yes|correct|right|对|正确|是|√|✓)$/i.test(optionText(value))) return true;
	if (/^(false|no|incorrect|wrong|错|错误|否|×|✕)$/i.test(optionText(value))) return false;
	return undefined;
}
export function normalizeAnswer(raw: unknown, input: QuestionInput, bank = false): QuestionAnswer {
	if (input.type === 'completion' || input.type === 'fill-blank') {
		const blanks = Array.isArray(raw) ? raw : [raw];
		if (!blanks.length || blanks.some((value) => typeof value !== 'string' || !value.trim())) {
			throw new Error('每个空位必须有完整答案，不能忽略空白空位');
		}
		const parts = blanks.map((value: string) => value.trim());
		// OCS completion options are the blank inputs; when supplied they provide the expected count.
		if (input.options.length && parts.length !== input.options.length) throw new Error('填空答案数量与空位数量不符');
		return { kind: 'completion', values: parts };
	}
	let parts = values(raw);
	if (!parts.length) throw new Error('未返回有效答案');
	if (input.type === 'judgement') {
		if (parts.length !== 1) throw new Error('判断题必须只有一个答案');
		// Legacy: visual mode is no longer created since v3.4.0, preserved for historical task records
		if (input.contentMode === 'visual' && input.options.length) {
			return { kind: 'single', index: optionIndex(parts[0], input.options, bank) };
		}
		const direct = judgement(parts[0]);
		const value = direct === undefined ? judgement(input.options[optionIndex(parts[0], input.options, bank)]) : direct;
		if (value === undefined) throw new Error('无法识别判断题答案');
		return { kind: 'judgement', value };
	}
	if (!['single', 'multiple'].includes(input.type || '')) throw new Error('当前题型尚未通过答案适配验证');
	if (!input.options.length) throw new Error('选择题缺少选项');
	if (input.type === 'multiple') {
		parts = parts.flatMap((v) => {
			if (input.options.some((o) => optionText(o) === optionText(v))) return [v];
			if (/^[A-Za-z]{2,}$/.test(v) && [...v].every((c) => c.toUpperCase().charCodeAt(0) - 65 < input.options.length))
				return [...v];
			return v
				.split(/(?:===|###|[,，;；、|\n]|\s+(?=[A-Z](?:\s|$)))/)
				.map(text)
				.filter(Boolean);
		});
		return {
			kind: 'multiple',
			indices: [...new Set(parts.map((p) => optionIndex(p, input.options, bank)))].sort((a, b) => a - b)
		};
	}
	if (parts.length !== 1) throw new Error('单选或判断题必须只有一个答案');
	return { kind: 'single', index: optionIndex(parts[0], input.options, bank) };
}
export function scriptAnswer(answer: QuestionAnswer, input: QuestionInput): string[] {
	const label = (index: number) => (index < 26 ? String.fromCharCode(65 + index) : String(index + 1));
	if (answer.kind === 'single') return [label(answer.index)];
	if (answer.kind === 'multiple') return answer.indices.map(label);
	if (answer.kind === 'completion') return answer.values.slice();
	return [input.options.find((o) => judgement(o) === answer.value) || (answer.value ? '正确' : '错误')];
}
export const sameAnswer = (a: QuestionAnswer, b: QuestionAnswer) => JSON.stringify(a) === JSON.stringify(b);
export function bankAnswers(infos: QuestionBankInfo[], input: QuestionInput) {
	const sources: QuestionSourceAnswer[] = [];
	const valid: QuestionAnswer[] = [];
	for (const info of infos.slice(0, 50)) {
		const source: QuestionSourceAnswer = {
			name: String(info.name || '题库').slice(0, 200),
			answers: [],
			error: info.error
		};
		if (!info.error) {
			for (const result of (info.results || []).slice(0, 50)) {
				try {
					const answer = normalizeAnswer(result.answer, input, true);
					valid.push(answer);
					source.answers.push(...scriptAnswer(answer, input));
				} catch (error) {
					source.error = String((error as Error).message);
				}
			}
		}
		sources.push(source);
	}
	return { sources, valid };
}
export function questionFingerprint(input: QuestionInput) {
	return createHash('sha256')
		.update(
			JSON.stringify([
				text(input.question),
				input.options.map(text),
				input.type,
				input.contentMode || 'text',
				(input.images || []).map((image) =>
					/^ocs-image:[a-f0-9]{64}$/.test(image) ? image.slice(10) : createHash('sha256').update(image).digest('hex')
				)
			])
		)
		.digest('hex');
}
export function normalizeQuestion(value: QuestionInput): QuestionInput {
	if (!value || typeof value.question !== 'string' || !value.question.trim() || value.question.length > 20000) {
		throw new Error('题干为空或超过 20000 字符');
	}
	if (
		!Array.isArray(value.options) ||
		value.options.length > 100 ||
		value.options.some((o) => typeof o !== 'string' || o.length > 5000)
	) {
		throw new Error('题目选项格式无效');
	}
	const sourceUrl = typeof value.sourceUrl === 'string' ? value.sourceUrl.slice(0, 4000) : '';
	const formalExam =
		value.formalExam === true || /\/examObject(?:[/?#]|$)|\/exam(?!-ans(?:[/?#]|$))(?:[-_/.?#]|$)/i.test(sourceUrl);
	// Legacy: visual mode is no longer created since v3.4.0, preserved for historical task records
	return {
		question: value.question.trim(),
		options: value.options.slice(),
		type: String(value.type || 'unknown').slice(0, 60),
		sourceUrl,
		browserUid: String(value.browserUid || '').slice(0, 200),
		pageId: String(value.pageId || '').slice(0, 200),
		rootId: typeof value.rootId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value.rootId) ? value.rootId : undefined,
		assessment: formalExam || value.assessment === true,
		formalExam,
		contentMode: value.contentMode === 'visual' ? 'visual' : 'text',
		imageLabels: Array.isArray(value.imageLabels) ? value.imageLabels.map((s) => String(s).slice(0, 100)) : [],
		images: Array.isArray(value.images) ? value.images.filter((i) => typeof i === 'string') : [],
		imageErrors: Array.isArray(value.imageErrors) ? value.imageErrors.map(String).map((s) => s.slice(0, 500)) : []
	};
}

export function questionInputError(input: QuestionInput): string | undefined {
	if (input.imageErrors?.length) return '题目图片不完整：' + input.imageErrors.join('；');
	if (input.contentMode === 'visual' && (!input.images?.length || input.imageLabels?.length !== input.images.length))
		return '原始字形题图或图片标签缺失，请在课程页面重新搜题';
}
