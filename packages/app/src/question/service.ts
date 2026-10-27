import { randomUUID } from 'crypto';
import type {
	QuestionInput,
	QuestionTask,
	QuestionCall,
	QuestionSettings,
	QuestionDecision,
	QuestionBankInfo,
	QuestionQuery,
	QuestionList,
	QuestionPhase
} from '@ocs-desktop/common';
import { QuestionConfiguration, invocation, Invocation } from './config';
import { CodexPool, abortError } from './client';
import {
	bankAnswers,
	normalizeAnswer,
	scriptAnswer,
	sameAnswer,
	normalizeQuestion,
	questionFingerprint,
	questionInputError
} from './answers';
import { QuestionRecords } from './records';

const ACTIVE = new Set<QuestionPhase>([
	'queued',
	'bank',
	'answering',
	'comparing',
	'adjudicating',
	'filling',
	'retrying'
]);
interface Runtime {
	admitted?: boolean;
	controller: AbortController;
	settings: QuestionSettings;
	config: Invocation;
	adjudication: Invocation;
	model?: Promise<QuestionCall>;
	decision?: Promise<QuestionDecision>;
	banks?: QuestionBankInfo[];
}
export class QuestionService {
	private tasks = new Map<string, QuestionTask>();
	private runtime = new Map<string, Runtime>();
	private calls = new Map<string, QuestionCall>();
	private paused = false;
	private saveScheduled = false;
	private wake = new Set<() => void>();
	private cache = new Map<string, { answer: string[]; manual: boolean }>();
	private pool: CodexPool;
	constructor(
		readonly configuration: QuestionConfiguration,
		private records: QuestionRecords,
		private notify: () => void = () => {},
		pool?: CodexPool
	) {
		this.pool = pool || new CodexPool((call) => this.onCall(call));
		for (const task of records.load()) {
			task.pageConnected = false;
			if (task.phase === 'review') {
				task.expired = true;
				if (questionInputError(task.input)) task.phase = 'error';
			}
			if (ACTIVE.has(task.phase)) {
				task.phase = 'error';
				task.error = '应用已重启，原任务已停止';
				task.submissionBlocked = true;
			}
			this.tasks.set(task.id, task);
			if (task.decisionSource === 'manual' && task.answer) {
				this.cache.set(this.cacheKey(task), { answer: task.answer, manual: true });
			}
		}
		if (this.tasks.size) this.records.saveTasks([...this.tasks.values()]);
	}

	private onCall(call: QuestionCall) {
		this.calls.set(call.id, { ...call });
		if (this.calls.size > 2000) {
			const oldest = [...this.calls.values()].find((c) => c.status !== 'running');
			if (oldest) this.calls.delete(oldest.id);
		}
		const task = this.tasks.get(call.taskId);
		if (task && !task.callIds.includes(call.id)) task.callIds.push(call.id);
		if (call.status !== 'running')
			this.records.saveCall(call).then(() => {
				const saved = this.calls.get(call.id);
				if (saved) delete saved.raw;
			});
		this.notify();
	}

	private changed() {
		if (this.saveScheduled) return;
		this.saveScheduled = true;
		// A page disconnect can change hundreds of tasks; save and notify once.
		queueMicrotask(() => {
			this.saveScheduled = false;
			const reviews = [...this.tasks.values()].filter((t) => t.phase === 'review' && !t.expired);
			for (const t of reviews.slice(0, Math.max(0, reviews.length - 500))) t.expired = true;
			while (this.tasks.size > 2000) {
				const candidate = [...this.tasks.values()].find((t) => !ACTIVE.has(t.phase));
				if (!candidate) break;
				this.tasks.delete(candidate.id);
				this.runtime.delete(candidate.id);
			}
			this.records.saveTasks([...this.tasks.values()]);
			this.notify();
		});
	}

	private phase(task: QuestionTask, phase: QuestionPhase, message: string) {
		task.phase = phase;
		task.updatedAt = Date.now();
		task.timeline.push({ at: task.updatedAt, phase, message });
		task.timeline = task.timeline.slice(-100);
		this.changed();
	}

	private get(id: string) {
		const task = this.tasks.get(id);
		if (!task) throw new Error('题目记录不存在');
		return task;
	}

	private async wait(runtime: Runtime) {
		if (runtime.admitted) {
			if (runtime.controller.signal.aborted) throw abortError();
			return;
		}
		while (this.paused && !runtime.controller.signal.aborted) {
			await new Promise<void>((resolve) => {
				const done = () => {
					this.wake.delete(done);
					runtime.controller.signal.removeEventListener('abort', done);
					resolve();
				};
				this.wake.add(done);
				runtime.controller.signal.addEventListener('abort', done, { once: true });
			});
		}
		if (runtime.controller.signal.aborted) throw abortError();
		runtime.admitted = true;
	}

	private startModel(task: QuestionTask, runtime: Runtime) {
		if (!runtime.model) {
			runtime.model = (async () => {
				await this.wait(runtime);
				if (this.runtime.get(task.id) !== runtime) throw abortError();
				this.phase(task, 'answering', '正在调用本地 Codex');
				const call = await this.pool.run(task.id, task.input, runtime.config, 'answer', runtime.controller.signal);
				if (!task.callIds.includes(call.id)) task.callIds.push(call.id);
				return call;
			})();
			runtime.model.catch(() => {});
		}
		return runtime.model;
	}

	begin(value: QuestionInput) {
		const settings = this.configuration.get();
		if (!settings.enabled) return { taskId: '', strategy: settings.strategy, enabled: false };
		const input = normalizeQuestion(value);
		const fingerprint = questionFingerprint(input);
		const config = invocation(settings);
		const adjudication = invocation(settings, 'adjudication');
		for (const previous of this.tasks.values()) {
			if (
				previous.pageConnected &&
				input.pageId &&
				previous.input.pageId === input.pageId &&
				(input.rootId
					? previous.input.rootId === input.rootId
					: !previous.input.rootId && questionFingerprint(previous.input) === fingerprint)
			) {
				const previousRuntime = this.runtime.get(previous.id);
				if (
					questionFingerprint(previous.input) === fingerprint &&
					previousRuntime &&
					JSON.stringify([previousRuntime.config, previousRuntime.adjudication]) ===
						JSON.stringify([config, adjudication]) &&
					!['error', 'cancelled', 'review'].includes(previous.phase)
				)
					return { taskId: previous.id, strategy: previous.strategy, enabled: true };
				previous.pageConnected = false;
				previous.expired = true;
				this.runtime.get(previous.id)?.controller.abort();
				this.runtime.delete(previous.id);
				if (ACTIVE.has(previous.phase)) {
					previous.submissionBlocked = true;
					this.phase(previous, 'cancelled', '同题已开始新一轮查询，此记录不再回填页面');
				}
			}
		}
		const now = Date.now();
		const task: QuestionTask = {
			id: randomUUID(),
			input,
			createdAt: now,
			updatedAt: now,
			phase: 'queued',
			strategy: settings.strategy,
			bankAnswers: [],
			submissionBlocked: true,
			pageConnected: !!input.pageId,
			timeline: [],
			callIds: []
		};
		const runtime: Runtime = {
			controller: new AbortController(),
			settings,
			config,
			admitted: !this.paused,
			adjudication
		};
		this.tasks.set(task.id, task);
		this.runtime.set(task.id, runtime);
		this.phase(task, 'queued', this.paused ? '任务已排队，等待恢复' : '已接收题目');
		const inputError = questionInputError(input);
		if (inputError) {
			task.error = inputError;
			this.phase(task, 'error', inputError);
			return { taskId: task.id, strategy: settings.strategy, enabled: true };
		}
		const cached = this.cached(task, runtime);
		if (cached) this.accept(task, cached.answer, 'cache', cached.manual ? '复用人工确认答案' : '复用当前配置下的答案');
		else if (settings.strategy !== 'bank-first') this.startModel(task, runtime);
		else this.phase(task, 'bank', '等待题库结果');
		return { taskId: task.id, strategy: settings.strategy, enabled: true };
	}

	private cacheKey(task: QuestionTask, runtime?: Runtime) {
		return (
			questionFingerprint(task.input) +
			':' +
			(runtime ? runtime.config.revision + ':' + runtime.adjudication.revision : 'manual')
		);
	}

	private cached(task: QuestionTask, runtime: Runtime) {
		if (task.input.imageErrors?.length) return undefined;
		return this.cache.get(this.cacheKey(task)) || this.cache.get(this.cacheKey(task, runtime));
	}

	private accept(task: QuestionTask, answer: string[], source: QuestionTask['decisionSource'], reason: string) {
		if (task.input.contentMode === 'visual') reason = '依据页面原始字形图片作答。' + reason;
		task.answer = answer;
		task.reason = reason;
		task.decisionSource = source;
		task.error = undefined;
		task.submissionBlocked = task.input.formalExam === true;
		const runtime = this.runtime.get(task.id);
		if (source !== 'cache' && runtime) {
			this.cache.set(this.cacheKey(task, source === 'manual' ? undefined : runtime), {
				answer,
				manual: source === 'manual'
			});
			if (this.cache.size > 2000) this.cache.delete(this.cache.keys().next().value!);
		}
		this.phase(task, 'ready', reason);
		return this.decision(task.id);
	}

	complete(id: string, banks: QuestionBankInfo[] = []): Promise<QuestionDecision> {
		const task = this.get(id);
		const runtime = this.runtime.get(id);
		if (!runtime) return Promise.resolve(this.decision(id));
		if (questionInputError(task.input)) return Promise.resolve(this.decision(id));
		if (task.answer && task.phase !== 'error') return Promise.resolve(this.decision(id));
		if (!runtime.decision) {
			runtime.banks = banks;
			runtime.decision = this.decide(task, runtime).catch((error) => {
				if (task.decisionSource === 'manual' && task.answer) return this.decision(id);
				if (this.runtime.get(id) !== runtime) return this.decision(id);
				if (runtime.controller.signal.aborted) {
					task.submissionBlocked = true;
					this.phase(task, 'cancelled', '任务已取消');
				} else {
					task.error = (error as Error).message;
					task.submissionBlocked = true;
					this.phase(task, 'error', task.error);
				}
				return this.decision(id);
			});
		}
		return runtime.decision;
	}

	private async decide(task: QuestionTask, runtime: Runtime): Promise<QuestionDecision> {
		await this.wait(runtime);
		if (this.runtime.get(task.id) !== runtime) throw abortError();
		const banks = bankAnswers(
			runtime.settings.strategy === 'model-only' || task.input.contentMode === 'visual' ? [] : runtime.banks || [],
			task.input
		);
		task.bankAnswers = banks.sources;
		const bankAgreement = banks.valid.length > 0 && banks.valid.every((answer) => sameAnswer(answer, banks.valid[0]));
		if (runtime.settings.strategy === 'bank-first' && bankAgreement) {
			return this.accept(task, scriptAnswer(banks.valid[0], task.input), 'bank', '有效题库答案一致');
		}
		const first = await this.startModel(task, runtime);
		if (runtime.controller.signal.aborted || this.runtime.get(task.id) !== runtime) throw abortError();
		if (first.status !== 'success' || !first.answer) throw new Error(first.error || '模型没有返回有效答案');
		task.modelAnswer = first.answer;
		const model = normalizeAnswer(first.answer, task.input);
		if (!banks.valid.length)
			return this.accept(task, first.answer, 'model', first.explanation || '采用通过题型校验的模型答案');
		this.phase(task, 'comparing', '正在比对模型与题库答案');
		if (banks.valid.every((answer) => sameAnswer(answer, model))) {
			return this.accept(task, first.answer, 'agreement', '模型与全部有效题库答案一致');
		}
		const unique = new Map(
			[model, ...banks.valid].map((answer) => [JSON.stringify(answer), scriptAnswer(answer, task.input)])
		);
		this.phase(task, 'adjudicating', '答案存在冲突，正在独立裁决');
		const call = await this.pool.run(
			task.id,
			task.input,
			runtime.adjudication,
			'adjudication',
			runtime.controller.signal,
			[...unique.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
		);
		if (!task.callIds.includes(call.id)) task.callIds.push(call.id);
		if (runtime.controller.signal.aborted || this.runtime.get(task.id) !== runtime) throw abortError();
		if (call.status !== 'success' || !call.answer) throw new Error(call.error || '二次裁决失败');
		const answer = scriptAnswer(normalizeAnswer(call.answer, task.input), task.input);
		return this.accept(task, answer, 'adjudication', call.explanation || '采用独立二次裁决结果');
	}

	decision(id: string): QuestionDecision {
		const task = this.get(id);
		const valid = !!task.answer && !['cancelled', 'error', 'review'].includes(task.phase);
		return {
			taskId: id,
			recordId: id,
			status: valid
				? task.decisionSource === 'manual'
					? 'manual'
					: 'agree'
				: task.phase === 'review' || ACTIVE.has(task.phase)
				? 'pending'
				: 'error',
			answer: valid ? task.answer : undefined,
			error: task.error,
			submissionBlocked: task.submissionBlocked,
			decisionSource: task.decisionSource
		};
	}

	decisions(ids: string[]): QuestionDecision[] {
		if (!Array.isArray(ids) || ids.length > 500 || ids.some((id) => typeof id !== 'string'))
			throw new Error('题目状态请求无效');
		return ids.map((id) =>
			this.tasks.has(id)
				? this.decision(id)
				: {
						taskId: id,
						status: 'error',
						submissionBlocked: true,
						error: '题目记录已过期'
				  }
		);
	}

	status(id: string, phase: QuestionPhase, error?: string) {
		const task = this.get(id);
		if (!task.pageConnected || task.phase === 'cancelled') return;
		if (!['filling', 'retrying', 'submitted', 'review', 'error', 'ready'].includes(phase))
			throw new Error('无效的页面任务状态');
		if (phase === 'submitted' && (task.submissionBlocked || !task.answer)) throw new Error('当前题目不可提交');
		if (phase === 'review' || phase === 'error') {
			task.error = error || '页面操作未完成';
			task.submissionBlocked = true;
		}
		const messages: Partial<Record<QuestionPhase, string>> = {
			filling: '正在填写答案',
			retrying: '正在补答',
			submitted: '已确认提交',
			ready: '页面填写已完成',
			review: '需要人工复核',
			error: '页面操作失败'
		};
		this.phase(task, phase, error || messages[phase] || phase);
	}

	disconnect(pageId: string) {
		for (const task of this.tasks.values()) {
			if (task.input.pageId !== pageId || !task.pageConnected) continue;
			task.pageConnected = false;
			task.expired = true;
			this.runtime.get(task.id)?.controller.abort();
			this.runtime.delete(task.id);
			if (ACTIVE.has(task.phase)) {
				task.submissionBlocked = true;
				this.phase(task, 'cancelled', '原页面已关闭或切换');
			}
		}
		this.changed();
	}

	list(query: QuestionQuery = {}): QuestionList {
		const tasks = [...this.tasks.values()];
		for (const task of tasks) {
			if (task.phase === 'review' && Date.now() - task.updatedAt > 3600000) task.expired = true;
		}
		const active = tasks.filter((t) => ACTIVE.has(t.phase)).length;
		const pending = tasks.filter((t) => t.phase === 'review' && !t.expired && t.pageConnected).length;
		const filtered = tasks
			.filter(
				(t) =>
					(!query.text || t.input.question.toLowerCase().includes(query.text.toLowerCase())) &&
					(!query.phase || (query.phase === 'active' ? ACTIVE.has(t.phase) : t.phase === query.phase)) &&
					(!query.browserUid || t.input.browserUid === query.browserUid) &&
					(!query.type || t.input.type === query.type) &&
					(!query.source || t.decisionSource === query.source) &&
					(!query.from || t.createdAt >= query.from) &&
					(!query.to || t.createdAt <= query.to)
			)
			.sort((a, b) => b.createdAt - a.createdAt);
		const size = Math.max(1, Math.min(100, query.pageSize || 30));
		const page = Math.max(1, query.page || 1);
		return {
			items: filtered
				.slice((page - 1) * size, page * size)
				.map((t) => ({ ...t, input: { ...t.input, images: [] }, timeline: [], callIds: [...t.callIds] })),
			total: filtered.length,
			active,
			pending,
			paused: this.paused
		};
	}

	async detail(id: string) {
		const task = this.get(id);
		const archived = await this.records.calls(task.callIds);
		const calls = new Map(archived.map((c) => [c.id, c]));
		for (const callId of task.callIds)
			if (!calls.has(callId) && this.calls.has(callId)) calls.set(callId, this.calls.get(callId)!);
		return { task: await this.records.hydrate(task), calls: [...calls.values()] };
	}

	async resolve(id: string, raw: string[]) {
		const task = this.get(id);
		const answer = scriptAnswer(normalizeAnswer(raw, task.input), task.input);
		this.runtime.get(id)?.controller.abort();
		task.expired = false;
		return this.accept(
			task,
			answer,
			'manual',
			task.pageConnected ? '人工确认，将在原页面应用并继续' : '人工确认已保存；原页面已断开，未回填'
		);
	}

	async control(action: 'pause' | 'resume' | 'cancel' | 'retry', id?: string) {
		if (action === 'pause' || action === 'resume') {
			this.paused = action === 'pause';
			if (!this.paused) [...this.wake].forEach((wake) => wake());
			this.notify();
			return;
		}
		const task = this.get(id || '');
		const previous = this.runtime.get(task.id);
		if (action === 'cancel') {
			previous?.controller.abort();
			task.submissionBlocked = true;
			this.phase(task, 'cancelled', '用户取消了任务');
			return;
		}
		if (!task.pageConnected) throw new Error('原页面已断开，请在课程页面重新启动搜题');
		if (questionInputError(task.input)) throw new Error('题目采集失败，请在课程页面重新搜题以读取最新题图');
		if (ACTIVE.has(task.phase)) throw new Error('任务正在运行');
		previous?.controller.abort();
		const settings = this.configuration.get();
		const runtime: Runtime = {
			controller: new AbortController(),
			settings,
			config: invocation(settings),
			adjudication: invocation(settings, 'adjudication'),
			banks: previous?.banks || []
		};
		this.runtime.set(task.id, runtime);
		task.answer = undefined;
		task.error = undefined;
		task.expired = false;
		task.submissionBlocked = true;
		this.phase(task, 'retrying', '用户重新查询当前题目');
		this.complete(task.id, runtime.banks).catch(() => {});
	}

	async test() {
		const config = invocation(this.configuration.get());
		return this.pool.run(
			'connection-test',
			{ question: '1 + 1 等于多少？', options: ['1', '2', '3'], type: 'single' },
			config,
			'test',
			new AbortController().signal
		);
	}

	async close() {
		for (const runtime of this.runtime.values()) runtime.controller.abort();
		await this.pool.close();
		await this.records.flush();
	}
}
