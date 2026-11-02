/** Public, serializable contracts for the question assistant. No Node dependencies. */
export type QuestionStrategy = 'consensus' | 'bank-first' | 'model-only';
export type QuestionType = 'single' | 'multiple' | 'judgement' | 'completion' | 'fill-blank' | string;
export interface QuestionModelProfile {
	mode: 'inherit' | 'custom';
	model: string;
	reasoningEffort: string;
	webSearch: 'inherit' | 'enabled' | 'disabled';
}
export interface QuestionSettings {
	enabled: boolean;
	strategy: QuestionStrategy;
	command: string;
	proxyUrl: string;
	timeoutMs: number;
	maxConcurrent: number;
	answer: QuestionModelProfile;
	/** null uses the answer profile. */
	adjudication: QuestionModelProfile | null;
}
export const DEFAULT_QUESTION_SETTINGS: QuestionSettings = {
	enabled: true,
	strategy: 'consensus',
	command: '',
	proxyUrl: '',
	timeoutMs: 90000,
	maxConcurrent: 2,
	answer: { mode: 'inherit', model: '', reasoningEffort: '', webSearch: 'inherit' },
	adjudication: null
};
export interface QuestionInput {
	question: string;
	options: string[];
	type?: QuestionType;
	sourceUrl?: string;
	browserUid?: string;
	pageId?: string;
	rootId?: string;
	assessment?: boolean;
	formalExam?: boolean;
	images?: string[];
	imageErrors?: string[];
	/** Retained for reading historical screenshot-based records. New tasks use text. */
	contentMode?: 'text' | 'visual';
	imageLabels?: string[];
}
export interface QuestionBankInfo {
	name?: string;
	error?: string;
	results?: Array<{ question?: unknown; answer?: unknown }>;
}
export type QuestionAnswer =
	| { kind: 'single'; index: number }
	| { kind: 'multiple'; indices: number[] }
	| { kind: 'judgement'; value: boolean }
	| { kind: 'completion'; values: string[] };
export type QuestionPhase =
	| 'queued'
	| 'bank'
	| 'answering'
	| 'comparing'
	| 'adjudicating'
	| 'ready'
	| 'filling'
	| 'retrying'
	| 'submitted'
	| 'review'
	| 'error'
	| 'cancelled';
export interface QuestionTimelineEntry {
	at: number;
	phase: QuestionPhase;
	message: string;
}
export interface QuestionSourceAnswer {
	name: string;
	answers: string[];
	error?: string;
}
export interface QuestionCall {
	id: string;
	taskId: string;
	purpose: 'answer' | 'adjudication' | 'test';
	status: 'running' | 'success' | 'error' | 'cancelled';
	startedAt: number;
	finishedAt?: number;
	model: string;
	reasoningEffort: string;
	args: string[];
	answer?: string[];
	explanation?: string;
	threadId?: string;
	usage?: Record<string, number>;
	error?: string;
	raw?: string;
	imageCount: number;
}
export interface QuestionTask {
	id: string;
	input: QuestionInput;
	createdAt: number;
	updatedAt: number;
	phase: QuestionPhase;
	strategy: QuestionStrategy;
	bankAnswers: QuestionSourceAnswer[];
	modelAnswer?: string[];
	answer?: string[];
	reason?: string;
	error?: string;
	decisionSource?: 'agreement' | 'model' | 'bank' | 'adjudication' | 'manual' | 'cache';
	submissionBlocked: boolean;
	pageConnected: boolean;
	expired?: boolean;
	timeline: QuestionTimelineEntry[];
	callIds: string[];
}
export interface QuestionDecision {
	taskId: string;
	status: 'agree' | 'manual' | 'pending' | 'error';
	answer?: string[];
	recordId?: string;
	error?: string;
	submissionBlocked: boolean;
	decisionSource?: QuestionTask['decisionSource'];
}
export interface QuestionQuery {
	text?: string;
	phase?: QuestionPhase | 'active' | 'review';
	browserUid?: string;
	type?: string;
	source?: string;
	from?: number;
	to?: number;
	page?: number;
	pageSize?: number;
}
export interface QuestionList {
	items: QuestionTask[];
	total: number;
	active: number;
	pending: number;
	paused: boolean;
}
export interface QuestionModelCatalog {
	models: Array<{ value: string; label: string; reasoningEfforts: string[]; defaultReasoningEffort?: string }>;
	model?: string;
	reasoningEffort?: string;
	source: string;
	revision: string;
}
export interface QuestionHealth {
	available: boolean;
	command: string;
	version?: string;
	error?: string;
	overrides: string[];
}
export interface QuestionRemoteMethods {
	questionBridgeSession: () => { port: number; token: string; enabled: boolean };
	prepareQuestionUserscript: (input: {
		path: string;
		sourceUrl?: string;
		browserUid?: string;
	}) => Promise<{ path: string; bridgeVersion?: string; upstreamVersion?: string }>;
	questionSettings: () => QuestionSettings;
	saveQuestionSettings: (settings: QuestionSettings) => QuestionSettings;
	questionModels: () => QuestionModelCatalog;
	questionHealth: () => Promise<QuestionHealth>;
	questionTest: () => Promise<QuestionCall>;
	questionList: (query?: QuestionQuery) => QuestionList;
	questionDetail: (id: string) => Promise<{ task: QuestionTask; calls: QuestionCall[] }>;
	questionControl: (action: 'pause' | 'resume' | 'cancel' | 'retry', id?: string) => Promise<void>;
	questionResolve: (id: string, answers: string[]) => Promise<QuestionDecision>;
}
export const QUESTION_BRIDGE_VERSION = 'ai-12';
