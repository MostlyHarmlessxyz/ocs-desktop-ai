import { describe, expect, it } from 'vitest';
import { manualAnswers, selectModel } from '../../web/src/features/question/presentation';
import type { QuestionModelCatalog, QuestionModelProfile } from '@ocs-desktop/common/web';

describe('question answer editor', () => {
	it('preserves the order and duplicate values of a multi-blank answer', () => {
		expect(manualAnswers('completion', [], ['B', 'A', 'B'])).toEqual(['B', 'A', 'B']);
	});
	it('rejects a partially completed answer instead of shifting later blanks', () => {
		expect(() => manualAnswers('fill-blank', [], ['first', '', 'third'])).toThrow('每一个空位');
	});
	it('does not allow multiple selections for a single-choice question', () => {
		expect(() => manualAnswers('single', ['A', 'B'], [])).toThrow('只能选择一个');
		expect(manualAnswers('multiple', ['C', 'A'], [])).toEqual(['C', 'A']);
	});
});

describe('model and reasoning effort selection', () => {
	const catalog: QuestionModelCatalog = {
		models: [
			{ value: 'deep', label: 'Deep', reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low' },
			{ value: 'fast', label: 'Fast', reasoningEfforts: ['minimal'] }
		],
		source: 'test',
		revision: '1'
	};
	const profile: QuestionModelProfile = {
		mode: 'custom',
		model: 'deep',
		reasoningEffort: 'high',
		webSearch: 'inherit'
	};
	it('clears an unsupported effort when moving to a different model', () => {
		expect(selectModel(profile, 'fast', catalog).reasoningEffort).toBe('');
	});
	it('does not invent capabilities for an unknown custom model', () => {
		expect(selectModel(profile, 'custom-provider-model', catalog)).toEqual({
			...profile,
			model: 'custom-provider-model',
			reasoningEffort: ''
		});
	});
	it('keeps supported user preferences and accepts only declared defaults', () => {
		expect(selectModel(profile, 'deep', catalog).reasoningEffort).toBe('high');
		expect(selectModel({ ...profile, reasoningEffort: 'ultra' }, 'deep', catalog).reasoningEffort).toBe('low');
	});
});
