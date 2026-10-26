import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CodexPool, executeCodex, parseAnswer, answerSchema } from '../src/question/client';
import { invocation, QuestionConfiguration, modelCatalog } from '../src/question/config';
import type { QuestionCall } from '@ocs-desktop/common';

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocs-client-test-'));
	vi.stubEnv('CODEX_HOME', dir);
});
afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(dir, { recursive: true, force: true });
});
const input = { question: '测试', options: ['甲', '乙'], type: 'single' };
const record = (): QuestionCall => ({
	id: 'test',
	taskId: 'task',
	purpose: 'test',
	status: 'running',
	startedAt: Date.now(),
	model: 'fake',
	reasoningEffort: 'medium',
	args: [],
	imageCount: 0
});

describe('Codex 参数与严格输出', () => {
	it('constrains choice output to stable option identifiers, including visual judgement', () => {
		expect(answerSchema(input).properties.answer.items).toEqual({ type: 'string', enum: ['A', 'B'] });
		expect(answerSchema(input).properties.answer.maxItems).toBe(1);
		expect(answerSchema({ ...input, type: 'judgement', contentMode: 'visual' }).properties.answer.items).toEqual({
			type: 'string',
			enum: ['A', 'B']
		});
	});
	it('浏览器图片读取失败时记录错误，不把缺图题发送给模型', async () => {
		const config = invocation(new QuestionConfiguration().get());
		const result = await executeCodex(
			{ ...input, imageErrors: ['图片读取失败 (403)'] },
			config,
			record(),
			new AbortController().signal,
			() => {}
		);
		expect(result.status).toBe('error');
		expect(result.error).toMatch(/图片不完整/);
		expect(result.args).toEqual([]);
	});
	it.skipIf(process.platform !== 'linux')(
		'退出清理忽略 SIGTERM 的实际 CLI 及其子进程',
		async () => {
			const cli = path.join(dir, 'stubborn-cli');
			const pidFile = path.join(dir, 'child.pid');
			fs.writeFileSync(
				cli,
				'#!/usr/bin/env node\n' +
					[
						"const {spawn}=require('child_process'); const fs=require('fs');",
						"process.on('SIGTERM',()=>{});",
						"const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});",
						`fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);`
					].join('\n'),
				{ mode: 0o755 }
			);
			const config = invocation(new QuestionConfiguration().get());
			config.command = cli;
			const pool = new CodexPool(() => {});
			const pending = pool.run('shutdown', input, config, 'answer', new AbortController().signal);
			await vi.waitFor(() => expect(fs.existsSync(pidFile)).toBe(true));
			const pid = Number(fs.readFileSync(pidFile, 'utf8'));
			await pool.close();
			expect((await pending).status).toBe('cancelled');
			await vi.waitFor(() => {
				const stat = `/proc/${pid}/stat`;
				expect(!fs.existsSync(stat) || /\) Z /.test(fs.readFileSync(stat, 'utf8'))).toBe(true);
			});
		},
		10000
	);
	it('CLI 路径变更使自动答案缓存失效，TUN模式默认不覆盖代理', () => {
		const settings = new QuestionConfiguration().get();
		expect(invocation(settings).proxyUrl).toBe('');
		expect(invocation({ ...settings, command: '/another/codex' }).revision).not.toBe(invocation(settings).revision);
	});
	it('退出等待共享进程完成取消及清理', async () => {
		let cleaned = false;
		const execute = vi.fn(async (_input, _config, call, signal) => {
			await new Promise<void>((resolve) =>
				signal.addEventListener('abort', () => setTimeout(resolve, 30), { once: true })
			);
			cleaned = true;
			return { ...call, status: 'cancelled' } as QuestionCall;
		});
		const pool = new CodexPool(() => {}, execute);
		const pending = pool.run(
			'a',
			input,
			invocation(new QuestionConfiguration().get()),
			'answer',
			new AbortController().signal
		);
		await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
		await pool.close();
		expect(cleaned).toBe(true);
		expect((await pending).status).toBe('cancelled');
	});
	it('继承模式不覆盖 CLI 配置，定制模式只传显式参数', () => {
		const settings = new QuestionConfiguration().get();
		expect(invocation(settings).args).toEqual([]);
		settings.answer = { mode: 'custom', model: 'my-model', reasoningEffort: 'high', webSearch: 'disabled' };
		expect(invocation(settings).args).toEqual([
			'--model',
			'my-model',
			'-c',
			'model_reasoning_effort="high"',
			'-c',
			'web_search="disabled"'
		]);
	});
	it('模型目录能力与配置修改实时生效', () => {
		fs.writeFileSync(path.join(dir, 'config.toml'), 'model="test"\nmodel_reasoning_effort="high"');
		fs.writeFileSync(
			path.join(dir, 'models_cache.json'),
			JSON.stringify({ models: [{ slug: 'test', supported_reasoning_levels: [{ effort: 'high' }] }] })
		);
		const first = modelCatalog(dir);
		expect(first.models[0].reasoningEfforts).toEqual(['high']);
		fs.writeFileSync(path.join(dir, 'config.toml'), 'model="next"');
		expect(modelCatalog(dir).revision).not.toBe(first.revision);
	});
	it('不从说明文字和过程事件猜答案', () => {
		expect(() => parseAnswer('答案是 A', input)).toThrow(/JSON/);
		expect(() => parseAnswer('{"answer":["A"]}', input)).toThrow(/结构/);
		expect(() => parseAnswer('{"answer":["C"],"explanation":""}', input)).toThrow(/选项/);
		expect(parseAnswer('{"answer":["B"],"explanation":"检查通过"}', input).answer).toEqual(['B']);
	});
	it('消费 JSONL 分片并记录最终 schema 结果和 usage', async () => {
		vi.stubEnv('CODEX_THREAD_ID', 'inherited-parent-environment');
		const cli = path.join(dir, 'fake-codex');
		fs.writeFileSync(
			cli,
			'#!/usr/bin/env node\n' +
				`
const fs = require('fs');
process.stdin.resume(); process.stdin.on('end', () => {
const args = process.argv.slice(2);
fs.writeFileSync(args[args.indexOf('--output-last-message') + 1],
JSON.stringify({answer:['B'],explanation:process.cwd()+'|'+process.env.CODEX_THREAD_ID}));
process.stdout.write(JSON.stringify({type:'error',message:'Reconnecting... 1/5'})+'\\n');
process.stdout.write('{"type":"thread.started","thread_');
setTimeout(() => {
process.stdout.write('id":"thread-test"}\\n{"type":"turn.completed","usage":{"input_tokens":10}}\\n');
}, 5);
});`,
			{ mode: 0o755 }
		);
		const config = invocation(new QuestionConfiguration().get());
		config.command = cli;
		const result = await executeCodex(input, config, record(), new AbortController().signal, () => {});
		expect(result.status).toBe('success');
		expect(result.answer).toEqual(['B']);
		expect(result.threadId).toBe('thread-test');
		expect(result.usage?.input_tokens).toBe(10);
		expect(result.explanation).toBe(process.cwd() + '|inherited-parent-environment');
		const schemaFile = result.args[result.args.indexOf('--output-schema') + 1];
		expect(fs.existsSync(path.dirname(schemaFile))).toBe(false);
		for (const isolated of ['-C', '--sandbox', '--ephemeral', '--ignore-rules', '--ignore-user-config']) {
			expect(result.args).not.toContain(isolated);
		}
	});
	it('超时中止进程并清理临时目录，图片缺失不继续作答', async () => {
		const cli = path.join(dir, 'hanging-cli');
		fs.writeFileSync(cli, '#!/usr/bin/env node\nsetInterval(() => {}, 1000);', { mode: 0o755 });
		const config = invocation(new QuestionConfiguration().get());
		config.command = cli;
		config.timeoutMs = 50;
		const result = await executeCodex(input, config, record(), new AbortController().signal, () => {});
		expect(result.status).toBe('error');
		expect(result.error).toMatch(/超时/);
		const badImage = await executeCodex(
			{ ...input, images: ['file:///etc/passwd'] },
			config,
			record(),
			new AbortController().signal,
			() => {}
		);
		expect(badImage.status).toBe('error');
		expect(badImage.args).toHaveLength(0);
	});
	it('共享调用取消一个订阅不会中断另一个', async () => {
		const execute = vi.fn(async (_input, _config, call, signal) => {
			await new Promise((resolve) => setTimeout(resolve, 25));
			return { ...call, status: signal.aborted ? 'cancelled' : 'success', answer: ['A'] } as QuestionCall;
		});
		const pool = new CodexPool(() => {}, execute);
		const config = invocation(new QuestionConfiguration().get());
		const a = new AbortController();
		const b = new AbortController();
		const first = pool.run('a', input, config, 'answer', a.signal);
		const second = pool.run('b', input, config, 'answer', b.signal);
		a.abort();
		await expect(first).rejects.toThrow(/取消/);
		expect((await second).status).toBe('success');
		expect(execute).toHaveBeenCalledTimes(1);
	});
});
