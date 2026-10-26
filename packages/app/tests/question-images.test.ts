import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { createHash } from 'crypto';
import express from 'express';
import { imageFixture } from './helpers/image-fixture';
import { questionJsonBody, questionBodyError } from '../src/question/request-body';
import { QuestionConfiguration, invocation } from '../src/question/config';
import { QuestionRecords } from '../src/question/records';
import { QuestionService } from '../src/question/service';
import { executeCodex } from '../src/question/client';

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
	vi.unstubAllEnvs();
});
function directory() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocs-image-test-'));
	cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
	vi.stubEnv('CODEX_HOME', dir);
	return dir;
}
async function serve(app: express.Express) {
	const server = app.listen(0, '127.0.0.1');
	await new Promise<void>((resolve) => server.once('listening', resolve));
	cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
	return `http://127.0.0.1:${(server.address() as any).port}`;
}
async function post(url: string, body: unknown) {
	return new Promise<{ status: number; data: any }>((resolve, reject) => {
		const data = typeof body === 'string' ? body : JSON.stringify(body);
		const request = http.request(
			url,
			{ method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
			(res) => {
				let text = '';
				res.on('data', (chunk) => {
					text += chunk;
				});
				res.on('end', () => resolve({ status: res.statusCode!, data: JSON.parse(text) }));
			}
		);
		request.on('error', reject);
		request.end(data);
	});
}
function fixtureCli(dir: string) {
	const command = path.join(dir, 'inspect-images');
	fs.writeFileSync(
		command,
		'#!/usr/bin/env node\n' +
			[
				"const fs=require('fs'),crypto=require('crypto'); let prompt='';",
				"process.stdin.on('data',d=>prompt+=d);process.stdin.on('end',()=>{",
				"const args=process.argv.slice(2),images=args.flatMap((a,i)=>a==='--image'?[args[i+1]]:[]);",
				"const attachments=images.map(file=>{const b=fs.readFileSync(file);return {bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')};});",
				"const result={answer:['B'],explanation:JSON.stringify(attachments)};",
				"fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(result));",
				"process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}})+'\\n');});"
			].join('\n'),
		{ mode: 0o755 }
	);
	return command;
}
describe('image attachments through local transport and CLI', () => {
	it('delivers nine real PNGs including >8 MiB files and >24 MiB total, beyond the old 36 MiB JSON limit', async () => {
		const dir = directory();
		const configuration = new QuestionConfiguration();
		configuration.save({ ...configuration.get(), strategy: 'model-only', command: fixtureCli(dir) });
		const records = new QuestionRecords(path.join(dir, 'records'));
		const service = new QuestionService(configuration, records);
		cleanup.push(() => service.close());
		const pngs = [
			...[20, 80, 140].map((green) => imageFixture(2048, 1200, [255, green, 0])),
			...[1, 2, 3, 4, 5, 6].map((red) => imageFixture(1, 1, [red, 0, 0]))
		];
		expect(pngs[0].length).toBeGreaterThan(8 * 1024 * 1024);
		expect(pngs.reduce((n, b) => n + b.length, 0)).toBeGreaterThan(24 * 1024 * 1024);
		const input = {
			question: 'Synthetic attachment test',
			type: 'single',
			options: ['first', 'second'],
			images: pngs.map((b) => 'data:image/png;base64,' + b.toString('base64'))
		};
		expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(36 * 1024 * 1024);
		const app = express();
		app.post(
			'/begin',
			questionJsonBody(),
			(req, res) => {
				res.json(service.begin(req.body));
			},
			questionBodyError
		);
		const origin = await serve(app);
		const started = await post(origin + '/begin', input);
		expect(started.status).toBe(200);
		const decision = await service.complete(started.data.taskId, []);
		expect(decision.answer).toEqual(['B']);
		const detail = await service.detail(started.data.taskId);
		expect(detail.calls).toHaveLength(1);
		expect(detail.calls[0].status).toBe('success');
		expect(detail.calls[0].imageCount).toBe(9);
		expect(JSON.parse(detail.calls[0].explanation!)).toEqual(
			pngs.map((b) => ({ bytes: b.length, sha256: createHash('sha256').update(b).digest('hex') }))
		);
		const imageFile = detail.calls[0].args[detail.calls[0].args.indexOf('--image') + 1];
		expect(fs.existsSync(imageFile)).toBe(false);
		const stored = JSON.parse(fs.readFileSync(path.join(dir, 'records', 'tasks.json'), 'utf8'));
		expect(stored[0].input.images.every((s: string) => s.startsWith('ocs-image:'))).toBe(true);
	}, 20000);
	it('downloads an HTTP image larger than 8 MiB without Axios rejecting it', async () => {
		const dir = directory();
		const png = imageFixture(2048, 1200);
		const app = express();
		app.get('/large.png', (_req, res) => res.type('application/octet-stream').send(png));
		const origin = await serve(app);
		const settings = new QuestionConfiguration().get();
		settings.command = fixtureCli(dir);
		const result = await executeCodex(
			{ question: 'Synthetic download', type: 'single', options: ['A', 'B'], images: [origin + '/large.png'] },
			invocation(settings),
			{
				id: 'download',
				taskId: 'download',
				purpose: 'test',
				status: 'running',
				startedAt: Date.now(),
				model: 'fixture',
				reasoningEffort: '',
				args: [],
				imageCount: 0
			},
			new AbortController().signal,
			() => {}
		);
		expect(result.status).toBe('success');
		expect(JSON.parse(result.explanation!)[0].bytes).toBe(png.length);
	}, 10000);
	it('returns a precise transport error for its configurable request bound, not a fake image-format error', async () => {
		const app = express();
		app.post('/begin', questionJsonBody(0.001), (_req, res) => res.json({ ok: true }), questionBodyError);
		const origin = await serve(app);
		const oversized = await post(origin + '/begin', { text: 'x'.repeat(2000) });
		expect(oversized.status).toBe(413);
		expect(oversized.data.error).toContain('本地传输容量');
		const malformed = await post(origin + '/begin', '{');
		expect(malformed.status).toBe(400);
		expect(malformed.data.error).toContain('JSON');
	});
});
