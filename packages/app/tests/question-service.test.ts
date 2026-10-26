import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { QuestionConfiguration } from '../src/question/config';
import { QuestionRecords } from '../src/question/records';
import { QuestionService } from '../src/question/service';
import { CodexPool } from '../src/question/client';
import type { QuestionCall } from '@ocs-desktop/common';

let dir: string;
let services: QuestionService[];
const input = {
	question: '测试题',
	options: ['甲', '乙'],
	type: 'single',
	pageId: 'page-1',
	browserUid: 'browser-1',
	assessment: true
};
const bank = (answer: string) => [{ name: '题库', results: [{ answer }] }];
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocs-service-test-'));
	services = [];
	vi.stubEnv('CODEX_HOME', dir);
});
afterEach(async () => {
	for (const service of services) await service.close();
	vi.unstubAllEnvs();
	fs.rmSync(dir, { recursive: true, force: true });
});
function setup(strategy: 'consensus' | 'bank-first' | 'model-only' = 'consensus', answer = 'A', error?: string) {
	const config = new QuestionConfiguration();
	config.save({ ...config.get(), strategy });
	const run = vi.fn(
		async (taskId, _input, _config, purpose) =>
			({
				id: `${purpose}-1`,
				taskId,
				purpose,
				status: error ? 'error' : 'success',
				startedAt: Date.now(),
				finishedAt: Date.now(),
				model: 'fake',
				reasoningEffort: 'medium',
				args: [],
				imageCount: 0,
				answer: [purpose === 'adjudication' ? 'B' : answer],
				error
			} as QuestionCall)
	);
	const pool = { run, close: () => {} } as unknown as CodexPool;
	const service = new QuestionService(config, new QuestionRecords(dir), undefined, pool);
	services.push(service);
	return { service, run, config };
}
describe('搜题任务策略与状态', () => {
	it('重试淘汰旧调用，旧结果不得把新任务置为可填写', async () => {
		const { service, run } = setup();
		const releases: Array<(value: QuestionCall) => void> = [];
		run.mockImplementation(() => new Promise((resolve) => releases.push(resolve)));
		const { taskId } = service.begin(input);
		const first = service.complete(taskId, []);
		await vi.waitFor(() => expect(releases).toHaveLength(1));
		service.status(taskId, 'review');
		await service.control('retry', taskId);
		await vi.waitFor(() => expect(releases).toHaveLength(2));
		const call = {
			id: 'old',
			taskId,
			purpose: 'answer',
			status: 'success',
			answer: ['A'],
			args: [],
			imageCount: 0
		} as QuestionCall;
		releases[0](call);
		expect((await first).answer).toBeUndefined();
		expect(service.decision(taskId).submissionBlocked).toBe(true);
		releases[1]({ ...call, id: 'new', answer: ['B'] });
		await vi.waitFor(() => expect(service.decision(taskId).answer).toEqual(['B']));
	});
	it('一致结果不二次调用，题库缺失采用模型', async () => {
		const { service, run } = setup();
		const { taskId } = service.begin(input);
		expect((await service.complete(taskId, bank('A'))).decisionSource).toBe('agreement');
		expect(run).toHaveBeenCalledTimes(1);
		const next = service.begin({ ...input, question: '另一题' });
		expect((await service.complete(next.taskId, [])).decisionSource).toBe('model');
	});
	it('冲突调用匿名独立裁决，采用通过校验的结果', async () => {
		const { service, run } = setup();
		const { taskId } = service.begin(input);
		const result = await service.complete(taskId, bank('B'));
		expect(result.answer).toEqual(['B']);
		expect(result.decisionSource).toBe('adjudication');
		expect(run).toHaveBeenCalledTimes(2);
		expect(run.mock.calls[1][3]).toBe('adjudication');
	});
	it('题库优先时一致来源不消耗模型调用', async () => {
		const { service, run } = setup('bank-first');
		const { taskId } = service.begin(input);
		expect((await service.complete(taskId, bank('A'))).decisionSource).toBe('bank');
		expect(run).not.toHaveBeenCalled();
	});
	it('仅模型忽略题库结果', async () => {
		const { service, run } = setup('model-only');
		const { taskId } = service.begin(input);
		expect((await service.complete(taskId, bank('B'))).answer).toEqual(['A']);
		expect(run).toHaveBeenCalledTimes(1);
	});
	it('模型失败不降级采用题库，阻止测试提交', async () => {
		const { service } = setup('consensus', 'A', '网络断开');
		const { taskId } = service.begin(input);
		const result = await service.complete(taskId, bank('B'));
		expect(result.status).toBe('pending');
		expect(result.submissionBlocked).toBe(true);
		expect(service.list().pending).toBe(1);
		expect(() => service.status(taskId, 'submitted')).toThrow();
	});
	it('正式考试有答案仍然禁止自动提交', async () => {
		const { service } = setup();
		const { taskId } = service.begin({ ...input, formalExam: true });
		expect((await service.complete(taskId, bank('A'))).submissionBlocked).toBe(true);
		expect(() => service.status(taskId, 'submitted')).toThrow();
	});
	it('暂停后新任务排队，恢复后继续', async () => {
		const { service, run } = setup();
		await service.control('pause');
		const { taskId } = service.begin(input);
		const result = service.complete(taskId, bank('A'));
		await Promise.resolve();
		expect(run).not.toHaveBeenCalled();
		await service.control('resume');
		expect((await result).answer).toEqual(['A']);
	});
	it('取消排队任务不运行模型', async () => {
		const { service, run } = setup();
		await service.control('pause');
		const { taskId } = service.begin(input);
		const result = service.complete(taskId, bank('A'));
		await service.control('cancel', taskId);
		expect((await result).status).toBe('error');
		expect(run).not.toHaveBeenCalled();
	});
	it('页面断开后不回填，人工答案仍可保存', async () => {
		const { service } = setup();
		const { taskId } = service.begin(input);
		await service.complete(taskId, bank('A'));
		service.disconnect(input.pageId);
		expect((await service.resolve(taskId, ['B'])).answer).toEqual(['B']);
		expect((await service.detail(taskId)).task.pageConnected).toBe(false);
		await expect(service.control('retry', taskId)).rejects.toThrow(/断开/);
	});
	it('人工确认不会被尚未结束的调用取消结果覆盖', async () => {
		const { service } = setup();
		await service.control('pause');
		const { taskId } = service.begin(input);
		const pending = service.complete(taskId, bank('A'));
		await service.resolve(taskId, ['B']);
		await pending;
		expect(service.decision(taskId)).toMatchObject({ status: 'manual', answer: ['B'] });
	});
	it('重启不恢复执行，历史可按题干分页查询', async () => {
		const { service } = setup();
		const { taskId } = service.begin(input);
		await service.complete(taskId, bank('A'));
		await service.close();
		const reloaded = new QuestionService(new QuestionConfiguration(), new QuestionRecords(dir));
		services.push(reloaded);
		const result = reloaded.list({ text: '测试', pageSize: 1 });
		expect(result.total).toBe(1);
		expect(result.items[0].pageConnected).toBe(false);
	});
});
