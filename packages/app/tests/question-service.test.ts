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
	const records = new QuestionRecords(dir);
	const service = new QuestionService(config, records, undefined, pool);
	services.push(service);
	return { service, run, config, records };
}
describe('搜题任务策略与状态', () => {
	it('一次页面断开合并保存全部排队任务，避免反复序列化完整历史', async () => {
		const { service, records, run } = setup();
		const save = vi.spyOn(records, 'saveTasks');
		await service.control('pause');
		for (let i = 0; i < 50; i++) service.begin({ ...input, rootId: 'q-' + i });
		await Promise.resolve();
		save.mockClear();
		service.disconnect(input.pageId);
		await Promise.resolve();
		expect(save).toHaveBeenCalledOnce();
		expect(save.mock.calls[0][0]).toHaveLength(50);
		expect(save.mock.calls[0][0].every((task) => task.phase === 'cancelled' && !task.pageConnected)).toBe(true);
		expect(run).not.toHaveBeenCalled();
	});
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
		expect(result.status).toBe('error');
		expect(result.submissionBlocked).toBe(true);
		expect(service.list().pending).toBe(0);
		expect(() => service.status(taskId, 'submitted')).toThrow();
	});
	it('采集失败不调用模型、不进入复核，也不使用缺图数据重试', async () => {
		const { service, run } = setup();
		const { taskId } = service.begin({
			...input,
			rootId: 'q-one',
			contentMode: 'visual',
			images: [],
			imageErrors: ['截图超时']
		});
		expect((await service.complete(taskId)).status).toBe('error');
		expect(run).not.toHaveBeenCalled();
		expect(service.list().pending).toBe(0);
		expect((await service.detail(taskId)).task.callIds).toEqual([]);
		await expect(service.control('retry', taskId)).rejects.toThrow('重新搜题');
	});
	it('旧版 visual 题在页面仍连接时可重试，重试保留图片输入', async () => {
		const { service, run } = setup('consensus', 'A', '首次调用失败');
		const visual = {
			...input,
			question: '旧版截图题',
			rootId: 'legacy-visual',
			contentMode: 'visual' as const,
			imageLabels: ['题干与选项'],
			images: ['data:image/png;base64,aGVsbG8=']
		};
		const { taskId } = service.begin(visual);
		await service.complete(taskId);
		expect((await service.detail(taskId)).task.input).toMatchObject({
			contentMode: 'visual',
			imageLabels: ['题干与选项'],
			images: visual.images
		});
		run.mockImplementation(
			async (id, _input, _config, purpose) =>
				({
					id: `${purpose}-retry`,
					taskId: id,
					purpose,
					status: 'success',
					startedAt: Date.now(),
					finishedAt: Date.now(),
					model: 'fake',
					reasoningEffort: 'medium',
					args: [],
					imageCount: 1,
					answer: ['B']
				} as QuestionCall)
		);
		await service.control('retry', taskId);
		await vi.waitFor(() => expect(service.decision(taskId).answer).toEqual(['B']));
		expect(run.mock.calls.at(-1)?.[1]).toMatchObject({ contentMode: 'visual', images: visual.images });
	});
	it('同一页面同一题的重复请求复用任务，不同空题图不互相取消', async () => {
		const { service, run } = setup();
		const first = service.begin({ ...input, rootId: 'q-one' });
		expect(service.begin({ ...input, rootId: 'q-one' }).taskId).toBe(first.taskId);
		await service.complete(first.taskId);
		expect(run).toHaveBeenCalledTimes(1);
		const failed = { ...input, contentMode: 'visual' as const, images: [], imageErrors: ['截图超时'] };
		const a = service.begin({ ...failed, rootId: 'q-two' });
		service.begin({ ...failed, rootId: 'q-three' });
		expect((await service.detail(a.taskId)).task.pageConnected).toBe(true);
	});
	it('修改调用配置后，同一题不复用正在运行的旧配置任务', async () => {
		const { service, config } = setup();
		await service.control('pause');
		const first = service.begin({ ...input, rootId: 'q-one' });
		config.save({ ...config.get(), proxyUrl: 'http://127.0.0.1:18080' });
		const next = service.begin({ ...input, rootId: 'q-one' });
		expect(next.taskId).not.toBe(first.taskId);
		expect((await service.detail(first.taskId)).task.phase).toBe('cancelled');
	});
	it('断开的待复核任务退出待处理计数，旧截图错误在重启时保留为失败记录', async () => {
		const { service } = setup();
		const { taskId } = service.begin(input);
		await service.complete(taskId);
		service.status(taskId, 'review');
		expect(service.list().pending).toBe(1);
		service.disconnect(input.pageId);
		expect(service.list().pending).toBe(0);
		await service.close();
		const record = JSON.parse(fs.readFileSync(path.join(dir, 'tasks.json'), 'utf8'));
		record[0].phase = 'review';
		record[0].expired = false;
		record[0].input.imageErrors = ['旧截图超时'];
		fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify(record));
		const reloaded = new QuestionService(new QuestionConfiguration(), new QuestionRecords(dir));
		services.push(reloaded);
		expect(reloaded.list().items[0].phase).toBe('error');
		expect(reloaded.list().pending).toBe(0);
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
	it('visual 历史图和答案在重启后可读取，断开页面需重新搜题', async () => {
		const { service } = setup();
		const visual = {
			...input,
			question: '持久化旧截图题',
			contentMode: 'visual' as const,
			imageLabels: ['题目原图'],
			images: ['data:image/png;base64,aGVsbG8=']
		};
		const { taskId } = service.begin(visual);
		await service.complete(taskId);
		await service.close();
		const reloaded = new QuestionService(new QuestionConfiguration(), new QuestionRecords(dir));
		services.push(reloaded);
		const detail = await reloaded.detail(taskId);
		expect(detail.task.input).toMatchObject({
			contentMode: 'visual',
			imageLabels: visual.imageLabels,
			images: visual.images
		});
		expect(detail.task.answer).toEqual(['A']);
		await expect(reloaded.control('retry', taskId)).rejects.toThrow(/原页面已断开/);
		const fresh = reloaded.begin({ ...input, pageId: 'page-1', rootId: 'legacy-visual' });
		expect(fresh.taskId).not.toBe(taskId);
		expect((await reloaded.detail(taskId)).task.input.contentMode).toBe('visual');
	});
});
