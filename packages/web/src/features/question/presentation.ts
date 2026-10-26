import type { QuestionModelCatalog, QuestionModelProfile, QuestionPhase } from '@ocs-desktop/common/web';

export const phaseLabels: Record<QuestionPhase, string> = {
	queued: '排队中',
	bank: '查询题库',
	answering: '模型作答',
	comparing: '比对答案',
	adjudicating: '二次裁决',
	ready: '答案就绪',
	filling: '填写中',
	retrying: '补答中',
	submitted: '提交已确认',
	review: '待复核',
	error: '失败',
	cancelled: '已取消'
};
export const typeLabels: Record<string, string> = {
	single: '单选',
	multiple: '多选',
	judgement: '判断',
	completion: '填空',
	'fill-blank': '填空'
};
export const sourceLabels: Record<string, string> = {
	agreement: '双源一致',
	model: '模型答案',
	bank: '题库答案',
	adjudication: '二次裁决',
	manual: '人工确认',
	cache: '缓存复用'
};
export const strategyLabels: Record<string, string> = {
	consensus: '双源校验',
	'bank-first': '题库优先',
	'model-only': '仅模型'
};
export function phaseColor(phase: QuestionPhase) {
	if (phase === 'review') return 'orange';
	if (phase === 'error') return 'red';
	if (phase === 'cancelled') return 'gray';
	if (phase === 'ready' || phase === 'submitted') return 'green';
	return 'arcoblue';
}
export function formatTime(value?: number) {
	return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
}
export function optionLabel(index: number) {
	return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}
/** Preserve blank positions and repeated values; never treat a fill answer as a set. */
export function manualAnswers(type: string | undefined, selected: string[], blanks: string[]): string[] {
	if (type === 'completion' || type === 'fill-blank' || !type || type === 'unknown') {
		if (!blanks.length || blanks.some((value) => !value.trim())) throw new Error('请填写每一个空位的答案');
		return blanks.map((value) => value.trim());
	}
	if (!selected.length) throw new Error('请选择答案');
	if (type !== 'multiple' && selected.length !== 1) throw new Error('该题只能选择一个答案');
	return [...selected];
}
export function effortsFor(catalog: QuestionModelCatalog, model: string) {
	return catalog.models.find((entry) => entry.value === model)?.reasoningEfforts || [];
}
/** A model change must not silently carry an unsupported effort into a new call. */
export function selectModel(profile: QuestionModelProfile, model: string, catalog: QuestionModelCatalog) {
	const entry = catalog.models.find((item) => item.value === model);
	return {
		...profile,
		model,
		reasoningEffort:
			profile.reasoningEffort && entry?.reasoningEfforts.includes(profile.reasoningEffort)
				? profile.reasoningEffort
				: entry?.defaultReasoningEffort && entry.reasoningEfforts.includes(entry.defaultReasoningEffort)
				? entry.defaultReasoningEffort
				: ''
	};
}
