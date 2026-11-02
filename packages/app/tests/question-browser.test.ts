import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import http from 'http';
import { EventEmitter } from 'events';
import { createRequire } from 'module';
import ts from 'typescript';
import { gunzipSync, deflateSync, inflateSync } from 'zlib';
import { createHash } from 'crypto';
import { QUESTION_BRIDGE_VERSION } from '@ocs-desktop/common';
import { patchQuestionScript, isQuestionBridgeCandidate } from '../src/question-browser/patch';
import { installQuestionBinding, isAllowedQuestionPage, postQuestionBridge } from '../src/question-browser/binding';

const require = createRequire(import.meta.url);
const browserEnv = require('browser-env');

function pngChunk(type: string, data: Buffer) {
	const content = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	let crc = 0xffffffff;
	for (const byte of content) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
	return Buffer.concat([length, content, checksum]);
}

/** A real one-pixel RGBA PNG, enlarged only with a valid tEXt metadata chunk. */
function syntheticPng(totalBytes = 706) {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(1, 0);
	header.writeUInt32BE(1, 4);
	header[8] = 8;
	header[9] = 6;
	const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
	const ihdr = pngChunk('IHDR', header);
	const pixels = deflateSync(Buffer.from([0, 110, 90, 70, 255]));
	const idat = pngChunk('IDAT', pixels);
	const iend = pngChunk('IEND', Buffer.alloc(0));
	const text = Buffer.alloc(totalBytes - signature.length - ihdr.length - idat.length - iend.length - 12, 'x');
	text.write('note\0', 0, 'latin1');
	return Buffer.concat([signature, ihdr, pngChunk('tEXt', text), idat, iend]);
}

const png = syntheticPng();
const pngData = 'data:image/png;base64,' + png.toString('base64');
// Generated from a 1x1 RGB pixel and independently decoded with Pillow before embedding.
const rasterSamples = [
	[
		'image/jpeg',
		'/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDnaKKK4zrP/9k='
	],
	['image/gif', 'R0lGODdhAQABAIEAAG5aRgAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw=='],
	['image/webp', 'UklGRjAAAABXRUJQVlA4ICQAAABQAQCdASoBAAEAAUAmJQBOgCgAAP7vdtdetLc3CfAkrVmEAAA=']
];
const original = fs.readFileSync(path.resolve(__dirname, '../../web/node_modules/ocsjs/dist/ocs.user.js'), 'utf8');
const latest = gunzipSync(fs.readFileSync(path.resolve(__dirname, 'fixtures/ocs-5.2.3.user.js.gz'))).toString('utf8');
const runtimeTS = fs.readFileSync(path.resolve(__dirname, '../src/question-browser/runtime.ts'), 'utf8');
const runtimeJS = ts
	.transpileModule(runtimeTS, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } })
	.outputText.replace(/export (?=function)/, '')
	.replace(/^export \{\};\s*$/gm, '');
const cleanup: Array<() => void> = [];
afterEach(() => {
	cleanup.splice(0).forEach((fn) => fn());
});

function page(
	html = '<div class="questionLi"></div>',
	decisions: any = {},
	url = 'https://mooc1.chaoxing.com/work/doHomeWorkNew'
) {
	const window = browserEnv([], { url, pretendToBeVisual: true });
	window.document.body.innerHTML = html;
	const calls: any[] = [];
	let sequence = 0;
	window.__ocsQuestionBridge = async (operation: string, data: any) => {
		calls.push({ operation, data: JSON.parse(JSON.stringify(data)) });
		if (operation === 'begin') return { taskId: `task-${++sequence}`, enabled: true, strategy: 'consensus' };
		if (operation === 'decisions')
			return data.taskIds.map(
				(taskId: string) =>
					decisions[taskId] || {
						taskId,
						status: 'agree',
						answer: ['A'],
						submissionBlocked: false
					}
			);
		if (operation === 'complete' || operation === 'decision')
			return (
				decisions[data.taskId] || {
					taskId: data.taskId,
					status: 'agree',
					answer: ['A'],
					submissionBlocked: false
				}
			);
		return { ok: true };
	};
	const context = vm.createContext({
		window,
		document: window.document,
		location: window.location,
		unsafeWindow: window,
		console,
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		URL,
		Node: window.Node,
		NodeFilter: window.NodeFilter,
		Event: window.Event,
		FileReader: window.FileReader,
		Blob: window.Blob,
		atob: (value: string) => window.atob(value),
		AbortController,
		fetch
	});
	new vm.Script(runtimeJS).runInContext(context);
	cleanup.push(() => {
		window.dispatchEvent(new window.Event('pagehide'));
		window.close();
	});
	return { window, runtime: (context as any).__ocsAIRuntime, calls, decisions, context };
}

function questionContext(
	fixture: ReturnType<typeof page>,
	root = fixture.window.document.querySelector('.questionLi,.TiMu,#root')
) {
	expect(root).not.toBeNull();
	const options = [...root.querySelectorAll('.answer_p,.blank')];
	return {
		root,
		elements: {
			title: [...root.querySelectorAll('.title,.mark_name')],
			options: options.length ? options : [...root.querySelectorAll('textarea,input[type=text]')]
		}
	};
}

/** Execute the actual patched upstream Worker/search/helper definitions, with browser UI services stubbed. */
function upstreamFive(fixture: ReturnType<typeof page>) {
	const source = patchQuestionScript(latest, runtimeJS);
	const section = (start: string, end: string) => {
		const first = source.indexOf(start);
		const last = source.indexOf(end, first);
		if (first < 0 || last < 0) throw new Error(`Upstream test section missing: ${start}`);
		return source.slice(first, last);
	};
	Object.assign(fixture.context, {
		lib: { CommonEventEmitter: EventEmitter, $message: { warn: () => {} } },
		$: { sleep: async () => {} },
		BackgroundProject: {
			scripts: { data: { methods: { searchAnswerInCaches: async (_title: string, callback: any) => callback() } } }
		},
		CommonProject: { scripts: { settings: { cfg: { imageOptimize: false } } } }
	});
	const definitions = [
		section('  function domSearchAll(', '  var src = '),
		section('  function createDefaultQuestionResolver(', '  const AnswerWrapperHandlerConfig'),
		section('  const AnswerWrapperHandlerConfig', '  class AnswerWrapperParser'),
		section('  class OCSWorker extends ', '  class CustomOCSWorker extends '),
		section('  function extractTextWithImages(', '  function simplifyWorkResult('),
		section('  async function buildAnswererEnv(', '  const IMAGE_OPTIMIZE_PLACEHOLDERS'),
		section('  function createCommonAnswerer(', '  function workPreCheckMessage(')
	].join('\n');
	return new vm.Script(
		definitions +
			'\n({ Worker: OCSWorker, answerer: createCommonAnswerer, build: buildAnswererEnv, extract: extractTextWithImages })'
	).runInContext(fixture.context);
}

function fiveWorker(fixture: ReturnType<typeof page>, type: string, extra: any = {}) {
	const upstream = upstreamFive(fixture);
	const updates: any[] = [];
	let initialized = false;
	const worker = new upstream.Worker({
		root: '.questionLi',
		elements: { title: '.title', options: '.answer_p' },
		thread: 1,
		answerSeparators: ['#'],
		answerer: upstream.answerer({
			titleTransform: (elements: any) => upstream.extract(elements.title[0]),
			optionsTransform: (elements: any, ctx: any) => {
				ctx.type = type;
				const extracted = elements.options.map((option: any) => upstream.extract(option));
				return {
					text: extracted.map((entry: any) => entry.text).join('\n'),
					images: extracted.flatMap((entry: any) => entry.images)
				};
			},
			answererWrappers: [],
			period: 0
		}),
		work: {
			type,
			optionText: (option: any) => option.getAttribute('data-option-text') || option.textContent,
			handler: async (_type: string, _answer: string, option: any) => option.click()
		},
		onResultsInit: () => {
			initialized = true;
		},
		onResultsUpdate: (result: any) => updates.push({ searching: result.searching, resolved: result.resolved }),
		...extra
	});
	cleanup.push(() => {
		worker.emit('close');
		worker.stopRootObserver();
	});
	return { worker, updates, initialized: () => initialized, upstream };
}

function fontAdapter(fixture: ReturnType<typeof page>, source = latest) {
	const patched = patchQuestionScript(source, runtimeJS);
	const start = patched.indexOf('  function mappingRecognize(');
	const end = patched.indexOf('  const CXAnalyses', start);
	const fontStart = patched.indexOf('    getSecretFont(doc = document)', end);
	const fontEnd = patched.indexOf('    isCurrentChapterFinished()', fontStart);
	let definitions = patched.slice(start, end) + '\nconst CXAnalyses = {' + patched.slice(fontStart, fontEnd) + '\n};';
	if (source === latest) {
		definitions += patched.slice(
			patched.indexOf('  function decryptText('),
			patched.indexOf('  function findFontUrls(')
		);
	}
	fixture.window.document.head.innerHTML =
		"<style>@font-face { font-family: font-cxsecret; src:url('data:font/ttf;base64,AA=='); }</style>";
	fixture.window.typrMapping = { 19968: 19969, 19969: 19970 };
	let decodes = 0;
	Object.assign(fixture.context, {
		$console: { log() {}, info() {}, warn() {}, error() {} },
		top$1: fixture.window,
		extractFontFromStyle: () => new ArrayBuffer(1),
		CX_SECRET_REF_TABLE_URL: 'https://example.test/font.bin',
		crackFont: async () => {
			decodes++;
			return { map: { 一: '丁', 丁: '丂' }, details: [] };
		},
		typr_js: {
			parse: () => {
				decodes++;
				return {};
			},
			U: {
				codeToGlyph: (_font: any, code: number) => (code === 19968 || code === 19969 ? code : 0),
				glyphToPath: (_font: any, glyph: number) => ({ glyph })
			}
		},
		md5: (value: string) => '0'.repeat(24) + JSON.parse(value).glyph
	});
	fixture.context.lib ||= {};
	fixture.context.lib.$message ||= {};
	fixture.context.lib.$message.error = () => {};
	const recognize = new vm.Script(definitions + '\nmappingRecognize;').runInContext(fixture.context);
	return { recognize: (doc = fixture.window.document) => recognize(doc), decodes: () => decodes };
}

describe('OCS 4.13.16 compatibility adapter', () => {
	it('patches the locked upstream bundle into syntactically valid JavaScript, without embedding credentials', () => {
		const patched = patchQuestionScript(original, runtimeJS);
		// Script managers evaluate userscripts in a function (OCS has a top-level environment-check return).
		expect(() => new vm.Script('(function () {\n' + patched + '\n})')).not.toThrow();
		expect(patched).toContain('@version');
		expect(patched.match(/\/\/\s*@version\s+([^\r\n]+)/)?.[1].trim()).toBe('4.13.16');
		expect(patched).toContain(`OCS_AI_BRIDGE_${QUESTION_BRIDGE_VERSION}`);
		expect(patched).not.toContain('x-ocs-question-token');
		expect(patchQuestionScript(patched, runtimeJS)).toBe(patched);
		const crlf = original.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
		expect(patchQuestionScript(crlf, runtimeJS)).toBe(patched);
	});
	it('rejects unknown versions and missing or ambiguous required anchors', () => {
		expect(() => patchQuestionScript(original.replace('4.13.16', '4.13.17'), runtimeJS)).toThrow('尚未通过');
		expect(() =>
			patchQuestionScript(original.replace('class AnswerWrapperParser', 'class ChangedParser'), runtimeJS)
		).toThrow('边界');
		expect(() => patchQuestionScript(original + '\nfunction createDefaultQuestionResolver(ctx) {}', runtimeJS)).toThrow(
			'命中 2 次'
		);
	});
	it('identifies local and remote OCS scripts, leaving unrelated userscripts alone', () => {
		expect(isQuestionBridgeCandidate('/tmp/ocs.user.js')).toBe(true);
		expect(isQuestionBridgeCandidate('https://cdn/x.user.js', 'OCS 网课助手')).toBe(true);
		expect(isQuestionBridgeCandidate('https://cdn/not-ocs.user.js')).toBe(false);
	});
});

describe('OCS 5.2.3 version-specific adapter', () => {
	it('uses the complete licensed production fixture and preserves its valid upstream version', () => {
		expect(createHash('sha256').update(latest).digest('hex')).toBe(
			'254802aec93a17ba6b4092eee8074ab9a8fe9a76fa86522a1469f2d729ee94de'
		);
		expect(latest).toMatch(/@license\s+MIT/);
		const patched = patchQuestionScript(latest, runtimeJS);
		expect(() => new vm.Script('(function () {\n' + patched + '\n})')).not.toThrow();
		expect(patched.match(/\/\/\s*@version\s+([^\r\n]+)/)?.[1].trim()).toBe('5.2.3');
		expect(patched).toContain('resolver(ctx, optionText)');
		expect(patched).not.toContain('x-ocs-question-token');
		expect(patchQuestionScript(patched, runtimeJS)).toBe(patched);
	});
	it('rejects structural changes in the new resolver and additional submit callback', () => {
		expect(() =>
			patchQuestionScript(
				latest.replace('createDefaultQuestionResolver(ctx, optionText)', 'createDefaultQuestionResolver(ctx, changed)'),
				runtimeJS
			)
		).toThrow('兼容检查');
		expect(() =>
			patchQuestionScript(
				latest.replace('lib.$message.success({ content, duration: 10 });', 'changedToast();'),
				runtimeJS
			)
		).toThrow('兼容检查');
		expect(() => patchQuestionScript(latest.replace('5.2.3', '5.2.4'), runtimeJS)).toThrow('尚未通过');
	});
	it('runs the actual 5.2.3 Worker and common answerer with empty banks and searching lifecycle updates', async () => {
		const fixture = page(
			'<div class="questionLi"><span class="title">Choose one</span><label class="answer_p"><input type="radio" name="q">A</label><label class="answer_p"><input type="radio" name="q">B</label></div>'
		);
		const { worker, initialized, updates } = fiveWorker(fixture, 'single');
		const results = await worker.doWork();
		expect(initialized()).toBe(true);
		expect(updates.some((update) => update.searching === true)).toBe(true);
		expect(results[0]).toMatchObject({
			requested: true,
			resolved: true,
			searching: false,
			result: { finish: true, aiVerified: true }
		});
		expect(fixture.calls.find((call) => call.operation === 'begin').data.options).toEqual(['A', 'B']);
		expect(fixture.window.document.querySelector('input').checked).toBe(true);
	});
	it('skips already-filled roots without leaving the new searching flag stuck', async () => {
		const fixture = page(
			'<div class="questionLi"><span class="title">Already answered</span><label class="answer_p"><input type="radio" checked>A</label></div>'
		);
		const { worker } = fiveWorker(fixture, 'single');
		const results = await worker.doWork();
		expect(results[0]).toMatchObject({
			searching: false,
			requested: true,
			result: { finish: true, alreadyAnswered: true }
		});
		expect(fixture.calls.filter((call) => call.operation === 'begin')).toHaveLength(0);
	});
	it('preserves duplicate and multiline options through the real 5.x answerer environment', async () => {
		const fixture = page(
			'<div class="questionLi"><span class="title">Duplicate choices</span><label class="answer_p"><input type="radio" name="q">same</label><label class="answer_p"><input type="radio" name="q">same</label></div>'
		);
		const { worker, upstream } = fiveWorker(fixture, 'single');
		await worker.doWork();
		expect(fixture.calls.find((call) => call.operation === 'begin').data.options).toEqual(['same', 'same']);
		expect(
			(await upstream.build({ title: 'q', options: ['same', 'same'], enableImageOptimize: false })).env.options
		).toBe('same\nsame');
		const session = await fixture.runtime.begin(
			{
				title: 'multiline',
				type: 'single',
				options: 'line\none\nline\ntwo',
				ocs_options: ['line\none', 'line\ntwo']
			},
			questionContext(fixture)
		);
		expect(session.input.options).toEqual(['line\none', 'line\ntwo']);
	});
	it('uses optionText for image/formula choices and accepts upstream image data without redownloading it', async () => {
		const fixture = page(
			'<div id="root"><label class="answer_p" data-answer="formula"><input type="radio"><img src="https://images.test/formula.png"></label></div>',
			{
				'task-1': { taskId: 'task-1', status: 'agree', answer: ['formula'], submissionBlocked: false }
			}
		);
		const data = pngData;
		const session = await fixture.runtime.begin(
			{
				title: 'image https://images.test/formula.png',
				type: 'single',
				options: 'formula',
				images: [data],
				ocs_image_sources: ['https://images.test/formula.png'],
				ocs_required_images: ['https://images.test/formula.png']
			},
			questionContext(fixture)
		);
		expect(fixture.calls.find((call) => call.operation === 'begin').data.images).toEqual([data]);
		const infos = await fixture.runtime.finish(session, []);
		const root = fixture.window.document.querySelector('#root');
		const result = await fixture.runtime
			.resolver({ root, searchInfos: infos }, (option: any) => option.getAttribute('data-answer'))
			.single(infos, [...root.querySelectorAll('.answer_p')], async (_type: string, text: string, option: any) => {
				expect(text).toBe('formula');
				option.click();
			});
		expect(result.finish).toBe(true);
	});
	it('retries only unfinished roots for two rounds with the real Worker before confirmed submission', async () => {
		const fixture = page(
			'<div class="questionLi"><span class="title">Retry question</span><label class="answer_p"><input type="radio" name="q">A</label><label class="answer_p"><input type="radio" name="q">B</label></div>',
			{
				'task-1': { taskId: 'task-1', status: 'pending', submissionBlocked: true },
				'task-2': { taskId: 'task-2', status: 'pending', submissionBlocked: true },
				'task-3': { taskId: 'task-3', status: 'agree', answer: ['B'], submissionBlocked: false }
			}
		);
		const { worker } = fiveWorker(fixture, 'single');
		const results = await worker.doWork();
		const originalRoot = worker.opts.root;
		fixture.window.fetch = async () => ({ status: 200, clone: () => ({ text: async () => '{"status":true}' }) });
		const callbacks: boolean[] = [];
		await worker.uploadHandler({
			type: 'force',
			results,
			callback: async (_rate: number, allow: boolean) => {
				callbacks.push(allow);
				if (allow) await fixture.window.fetch('/work/addStudentWorkNew');
			}
		});
		expect(fixture.calls.filter((call) => call.operation === 'begin')).toHaveLength(3);
		expect(callbacks).toEqual([true]);
		expect(worker.opts.root).toBe(originalRoot);
		expect(worker.totalQuestionCount).toBe(1);
		expect(fixture.calls.some((call) => call.operation === 'status' && call.data.phase === 'submitted')).toBe(true);
	});
	it('stops a 5.x root observer when its question disappears', async () => {
		const fixture = page(
			'<div class="questionLi"><span class="title">observer</span><label class="answer_p"><input type="radio">A</label></div>'
		);
		let lost = false;
		const { worker } = fiveWorker(fixture, 'single', {
			rootObserver: {
				enabled: true,
				checkIntervalMs: 10,
				lostTimeoutMs: 0,
				onRootLost: () => {
					lost = true;
				}
			}
		});
		await worker.doWork();
		fixture.window.document.querySelector('.questionLi').remove();
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(lost).toBe(true);
		expect(worker.isClose).toBe(true);
		expect(worker.rootObserverTimer).toBeUndefined();
	});
	it('keeps unresolved 5.x assessments unsubmitted, then resumes the same Worker after manual review', async () => {
		const fixture = page(
			'<div class="questionLi"><span class="title">Manual review</span><label class="answer_p"><input type="radio" name="q">A</label><label class="answer_p"><input type="radio" name="q">B</label></div>',
			{
				'task-1': { taskId: 'task-1', status: 'pending', submissionBlocked: true },
				'task-2': { taskId: 'task-2', status: 'pending', submissionBlocked: true },
				'task-3': { taskId: 'task-3', status: 'pending', submissionBlocked: true }
			}
		);
		const { worker } = fiveWorker(fixture, 'single');
		const results = await worker.doWork();
		fixture.window.fetch = async () => ({ status: 200, clone: () => ({ text: async () => '{"status":true}' }) });
		const callbacks: boolean[] = [];
		await worker.uploadHandler({
			type: 'force',
			results,
			callback: async (_rate: number, allow: boolean) => {
				callbacks.push(allow);
				if (allow) await fixture.window.fetch('/work/addStudentWorkNew');
			}
		});
		expect(callbacks).toEqual([false]);
		expect(fixture.calls.filter((call) => call.operation === 'begin')).toHaveLength(3);
		fixture.decisions['task-3'] = { taskId: 'task-3', status: 'manual', answer: ['B'], submissionBlocked: false };
		await new Promise((resolve) => setTimeout(resolve, 2000));
		expect(callbacks).toEqual([false, true]);
		expect(fixture.window.document.querySelectorAll('input')[1].checked).toBe(true);
	});
	it('fills a formal exam using the real 5.x Worker without retrying or auto-submitting', async () => {
		const fixture = page(
			'<div class="questionLi"><span class="title">Formal exam</span><label class="answer_p"><input type="radio">A</label></div>',
			{},
			'https://mooc1.chaoxing.com/exam-ans/exam/test'
		);
		const { worker } = fiveWorker(fixture, 'single');
		const results = await worker.doWork();
		const callbacks: boolean[] = [];
		await worker.uploadHandler({
			type: 'force',
			results,
			callback: (_rate: number, allow: boolean) => callbacks.push(allow)
		});
		expect(results[0].result.finish).toBe(true);
		expect(fixture.calls.filter((call) => call.operation === 'begin')).toHaveLength(1);
		expect(fixture.calls.find((call) => call.operation === 'begin').data.formalExam).toBe(true);
		expect(callbacks).toEqual([false]);
	});
});

describe('question browser runtime', () => {
	it('uses one batched watcher per page and stops watching removed question roots', async () => {
		const fixture = page(
			Array.from(
				{ length: 12 },
				(_v, i) => `<div class="questionLi"><label><input type="radio">${i}</label></div>`
			).join('')
		);
		for (const [index, root] of [...fixture.window.document.querySelectorAll('.questionLi')].entries()) {
			const session = await fixture.runtime.begin(
				{ title: 'Question ' + index, type: 'single', options: ['A'] },
				questionContext(fixture, root)
			);
			const searchInfos = await fixture.runtime.finish(session, []);
			await fixture.runtime
				.resolver({ root, searchInfos })
				.single(searchInfos, [...root.querySelectorAll('label')], async (_type: string, _text: string, option: any) => {
					option.querySelector('input').checked = true;
				});
		}
		await new Promise((resolve) => setTimeout(resolve, 1700));
		const batches = fixture.calls.filter((call) => call.operation === 'decisions');
		expect(batches).toHaveLength(1);
		expect(batches[0].data.taskIds).toHaveLength(12);
		fixture.window.document.body.innerHTML = '';
		await new Promise((resolve) => setTimeout(resolve, 1700));
		expect(fixture.calls.filter((call) => call.operation === 'decisions')).toHaveLength(1);
	});
	it('serializes overlapping answer application for the same question', async () => {
		const fixture = page('<div id="root"><label><input type="radio">A</label></div>');
		const session = await fixture.runtime.begin(
			{ title: 'One question', type: 'single', options: ['A'] },
			questionContext(fixture)
		);
		const searchInfos = await fixture.runtime.finish(session, []);
		const root = fixture.window.document.querySelector('#root');
		const options = [...root.querySelectorAll('label')];
		const resolver = fixture.runtime.resolver({ root, searchInfos });
		let calls = 0;
		const handler = async () => {
			calls++;
			await new Promise((resolve) => setTimeout(resolve, 60));
			root.querySelector('input').checked = true;
		};
		const results = await Promise.all([
			resolver.single(searchInfos, options, handler),
			resolver.single(searchInfos, options, handler)
		]);
		expect(calls).toBe(1);
		expect(results.every((result) => result.finish)).toBe(true);
	});
	it('recognizes a selected letter badge beside its answer text without clicking it again', async () => {
		const fixture = page(
			'<div class="questionLi"><div class="choice"><span class="num_option check_answer">A</span>' +
				'<div class="answer_p">first</div></div><div class="choice"><span class="num_option">B</span>' +
				'<div class="answer_p">second</div></div></div>'
		);
		const session = await fixture.runtime.begin(
			{ title: 'Choice', options: ['first', 'second'], type: 'single' },
			questionContext(fixture)
		);
		const infos = await fixture.runtime.finish(session, []);
		const root = fixture.window.document.querySelector('.questionLi');
		let clicks = 0;
		root.addEventListener('click', () => clicks++);
		const result = await fixture.runtime
			.resolver({ root, searchInfos: infos })
			.single(infos, [...root.querySelectorAll('.answer_p')], async () => {
				clicks++;
			});
		expect(result.finish).toBe(true);
		expect(clicks).toBe(0);
	});
	it('runs both native font converters once, clears parent font styles, and preserves form/image nodes', async () => {
		for (const source of [original, latest]) {
			const fixture = page(
				'<div class="font-cxsecret"><div class="after font-cxsecret"><span class="font-cxsecret">一丁</span><img src="/一.png" alt="一"><textarea></textarea></div></div>'
			);
			const image = fixture.window.document.querySelector('img');
			const field = fixture.window.document.querySelector('textarea');
			field.value = 'retained';
			const native = fontAdapter(fixture, source);
			await Promise.all([native.recognize(), native.recognize()]);
			await native.recognize();
			expect(native.decodes()).toBe(1);
			expect(fixture.window.document.querySelector('span').textContent).toBe('丁丂');
			expect(fixture.window.document.querySelector('.font-cxsecret')).toBeNull();
			expect(fixture.window.document.querySelector('img')).toBe(image);
			expect(image.getAttribute('src')).toBe('/一.png');
			expect(field.value).toBe('retained');
		}
	});
	it('waits for native font conversion before the real Worker extracts question text', async () => {
		const fixture = page(
			'<div class="questionLi"><h3 class="title font-cxsecret">一丁</h3><label class="answer_p"><input type="radio">A</label></div>'
		);
		const { worker } = fiveWorker(fixture, 'single');
		fontAdapter(fixture);
		let release!: (value: any) => void;
		fixture.context.crackFont = () =>
			new Promise((resolve) => {
				release = resolve;
			});
		const pending = worker.doWork();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(fixture.calls.some((call) => call.operation === 'begin')).toBe(false);
		expect(worker.isRunning).toBe(false);
		release({ map: { 一: '丁', 丁: '丂' }, details: [] });
		expect((await pending)[0].result.finish).toBe(true);
		const input = fixture.calls.find((call) => call.operation === 'begin').data;
		expect(input.question).toBe('丁丂');
		expect(input.images).toEqual([]);
		expect(input.rootId).toBe(
			fixture.window.document.querySelector('.questionLi').getAttribute('data-ocs-ai-question')
		);
	});
	it('keeps encrypted text intact on font failure, shows recovery guidance and can retry the Worker', async () => {
		const fixture = page(
			'<div class="questionLi"><h3 class="title font-cxsecret">一丁</h3><label class="answer_p"><input type="radio">A</label></div>'
		);
		const { worker } = fiveWorker(fixture, 'single');
		fontAdapter(fixture);
		const errors: any[] = [];
		fixture.context.lib.$message.error = (message: any) => errors.push(message);
		fixture.context.crackFont = async () => {
			throw new Error('font table unavailable');
		};
		await expect(worker.doWork()).rejects.toThrow('字体转换未完成');
		expect(fixture.calls).toEqual([]);
		expect(errors.some((error) => error.content?.includes('在课程页重新开始答题'))).toBe(true);
		expect(fixture.window.document.querySelector('.font-cxsecret').textContent).toBe('一丁');
		await expect(fixture.runtime.begin({ title: '一丁' }, questionContext(fixture))).rejects.toThrow(
			'字体转换尚未启动但存在加密文字'
		);
		fixture.context.crackFont = async () => ({ map: { 一: '丁', 丁: '丂' }, details: [] });
		expect((await worker.doWork())[0].result.finish).toBe(true);
		expect(fixture.calls.find((call) => call.operation === 'begin').data.question).toBe('丁丂');
	});
	it('shares pending font conversion between concurrent question requests and rejects incomplete conversion', async () => {
		const fixture = page(
			'<div class="questionLi font-cxsecret">一</div><div class="questionLi font-cxsecret">丁</div>'
		);
		const roots = [...fixture.window.document.querySelectorAll('.questionLi')];
		let release!: (roots: any[]) => void;
		const conversion = fixture.runtime.decodeFonts(
			fixture.window.document,
			() =>
				new Promise((resolve) => {
					release = resolve;
				})
		);
		const pending = roots.map((root, index) =>
			fixture.runtime.begin({ title: ['丁', '丂'][index] }, questionContext(fixture, root))
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(fixture.calls).toEqual([]);
		roots.forEach((root, index) => {
			root.textContent = ['丁', '丂'][index];
		});
		release(roots);
		await conversion;
		expect((await Promise.all(pending)).map((session) => session.input.question)).toEqual(['丁', '丂']);
		expect(fixture.calls.filter((call) => call.operation === 'begin')).toHaveLength(2);

		roots[0].classList.add('font-cxsecret');
		const incomplete = fixture.runtime.decodeFonts(fixture.window.document, async () => []);
		await expect(fixture.runtime.begin({ title: '一' }, questionContext(fixture, roots[0]))).rejects.toThrow(
			'仍存在加密文字'
		);
		await incomplete;
		expect(fixture.calls.filter((call) => call.operation === 'begin')).toHaveLength(2);
	});
	it('shares native decoding with a multi-question Worker and extracts decoded text plus lazy images', async () => {
		const fixture = page(
			'<div class="questionLi"><h3 class="title font-cxsecret">一<img src="" data-src="/stem.png"></h3><label class="answer_p"><input type="radio">A</label></div>' +
				'<div class="questionLi"><h3 class="title font-cxsecret">丁</h3><label class="answer_p"><input type="radio"><img data-original="/option.png">A</label></div>'
		);
		const { worker } = fiveWorker(fixture, 'single', { thread: 2 });
		const native = fontAdapter(fixture);
		let release!: (value: any) => void;
		let decodes = 0;
		fixture.context.crackFont = () => {
			decodes++;
			return new Promise((resolve) => {
				release = resolve;
			});
		};
		const requested: string[] = [];
		fixture.context.fetch = async (url: string) => {
			requested.push(url);
			return { ok: true, blob: async () => new fixture.window.Blob([png]) };
		};
		const conversion = native.recognize();
		const pending = worker.doWork();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(fixture.calls).toEqual([]);
		expect(requested).toEqual([]);
		release({ map: { 一: '丁', 丁: '丂' }, details: [] });
		await conversion;
		expect((await pending).every((result: any) => result.result.finish)).toBe(true);
		expect(decodes).toBe(1);
		const inputs = fixture.calls.filter((call) => call.operation === 'begin').map((call) => call.data);
		expect(inputs.map((input) => input.question)).toEqual(['丁 https://mooc1.chaoxing.com/stem.png', '丂']);
		expect(inputs.map((input) => input.images)).toEqual([[pngData], [pngData]]);
		expect(requested.sort()).toEqual(['https://mooc1.chaoxing.com/option.png', 'https://mooc1.chaoxing.com/stem.png']);
	});
	it('decodes iframe roots in their own document and resolves image URLs against that document', async () => {
		const fixture = page('<div class="font-cxsecret">Parent 一</div><iframe></iframe>');
		const doc = fixture.window.document.querySelector('iframe').contentDocument;
		doc.open();
		doc.write(
			'<html><head><base href="https://mooc1.chaoxing.com/nested/frame/test"></head><body><div class="questionLi"><h3 class="title font-cxsecret">一</h3><label class="answer_p"><input type="radio">A</label></div></body></html>'
		);
		doc.close();
		const root = doc.querySelector('.questionLi');
		const { worker } = fiveWorker(fixture, 'single', { root: [root] });
		const native = fontAdapter(fixture);
		const results = await worker.doWork();
		expect(results[0].ctx.root.ownerDocument).toBe(doc);
		expect(results[0].result.finish).toBe(true);
		expect(native.decodes()).toBe(1);
		expect(fixture.window.document.querySelector('.font-cxsecret').textContent).toBe('Parent 一');
		expect(fixture.calls.find((call) => call.operation === 'begin').data.question).toBe('丁');
		root.querySelector('h3').insertAdjacentHTML('beforeend', '<img src="./formula.png">');
		const requested: string[] = [];
		fixture.context.fetch = async (url: string) => {
			requested.push(url);
			return { ok: true, blob: async () => new fixture.window.Blob([png]) };
		};
		await fixture.runtime.begin({ title: '丁' }, questionContext(fixture, root));
		expect(requested).toEqual(['https://mooc1.chaoxing.com/nested/frame/formula.png']);
	});
	it('reuses an inner submit confirmation without waiting a second time', async () => {
		const fixture = page();
		const result = await fixture.runtime.submit([], async () => ({ ok: false, reason: 'confirmed inner failure' }), 20);
		expect(result).toEqual({ ok: false, reason: 'confirmed inner failure' });
	});
	it('preserves fill-blank ordering and repeated values when applying to live fields', async () => {
		const fixture = page(
			'<div id="root"><div class="blank"><textarea></textarea></div><div class="blank"><textarea></textarea></div></div>',
			{
				'task-1': { taskId: 'task-1', status: 'agree', answer: ['second', 'second'], submissionBlocked: false }
			}
		);
		const session = await fixture.runtime.begin({ title: 'two blanks', type: 'completion' }, questionContext(fixture));
		const infos = await fixture.runtime.finish(session, []);
		const root = fixture.window.document.querySelector('#root');
		const options = [...root.querySelectorAll('.blank')];
		const result = await fixture.runtime
			.resolver({ root, searchInfos: infos })
			.completion(infos, options, async () => {});
		expect(result.finish).toBe(true);
		expect(options.map((option: any) => option.querySelector('textarea').value)).toEqual(['second', 'second']);
	});
	it.each(['completion', 'fill-blank'])(
		'reads %s text and blank count without capturing hidden editor fields',
		async (type) => {
			const fixture = page(
				'<div class="TiMu"><h3 class="title">Synthetic ___ and ___</h3>' +
					'<ul><li><textarea style="display:none"></textarea><iframe></iframe></li>' +
					'<li><textarea style="display:none"></textarea><iframe></iframe></li></ul></div>'
			);
			const root = fixture.window.document.querySelector('.TiMu');
			const options = [...root.querySelectorAll('textarea')];
			await fixture.runtime.begin(
				{ title: 'Synthetic ___ and ___', type, options: '' },
				{ root, type, elements: { title: [root.querySelector('h3')], options } }
			);
			const input = fixture.calls.find((call) => call.operation === 'begin').data;
			expect(input.imageErrors).toEqual([]);
			expect(input.question).toBe('Synthetic ___ and ___');
			expect(input.images).toHaveLength(0);
			expect(input.options).toEqual(['第 1 空', '第 2 空']);
			expect(input.rootId).toBe(root.getAttribute('data-ocs-ai-question'));
		}
	);
	it('preserves blank count through the actual 5.x answerer when blank text is empty', async () => {
		const fixture = page(
			'<div class="questionLi"><h3 class="title">Synthetic two blanks</h3>' +
				'<textarea class="answer_p"></textarea><textarea class="answer_p"></textarea></div>',
			{
				'task-1': { taskId: 'task-1', status: 'agree', answer: ['first', 'second'], submissionBlocked: false }
			}
		);
		const { worker } = fiveWorker(fixture, 'completion');
		const results = await worker.doWork();
		expect(fixture.calls.find((call) => call.operation === 'begin').data.options).toEqual(['第 1 空', '第 2 空']);
		expect(results[0].result.finish).toBe(true);
		expect([...fixture.window.document.querySelectorAll('textarea')].map((field: any) => field.value)).toEqual([
			'first',
			'second'
		]);
	});
	it('removes extra multiple-choice selections and verifies all requested choices', async () => {
		const fixture = page(
			'<div id="root"><div class="answerBg"><label class="answer_p"><input type="checkbox" checked>A</label><label class="answer_p"><input type="checkbox">B</label><label class="answer_p"><input type="checkbox" checked>C</label></div></div>',
			{
				'task-1': { taskId: 'task-1', status: 'agree', answer: ['B', 'C'], submissionBlocked: false }
			}
		);
		const session = await fixture.runtime.begin(
			{ title: 'choose', type: 'multiple', options: 'A\nB\nC' },
			questionContext(fixture)
		);
		const infos = await fixture.runtime.finish(session, []);
		const root = fixture.window.document.querySelector('#root');
		const options = [...root.querySelectorAll('.answer_p')];
		const result = await fixture.runtime
			.resolver({ root, searchInfos: infos })
			.multiple(infos, options, async (_type: string, _answer: string, option: any) => option.click());
		expect(result.finish).toBe(true);
		expect(options.map((option: any) => option.querySelector('input').checked)).toEqual([false, true, true]);
		expect(fixture.runtime.resultFinished({ ctx: { root }, result })).toBe(true);
		options[0].querySelector('input').checked = true;
		expect(fixture.runtime.resultFinished({ ctx: { root }, result })).toBe(false);
	});
	it('continues watching an already-filled answer and applies a later manual correction', async () => {
		const fixture = page(
			'<div id="root"><label class="answer_p"><input type="radio" name="one">A</label><label class="answer_p"><input type="radio" name="one">B</label></div>'
		);
		const session = await fixture.runtime.begin(
			{ title: 'one', type: 'single', options: 'A\nB' },
			questionContext(fixture)
		);
		const infos = await fixture.runtime.finish(session, []);
		const root = fixture.window.document.querySelector('#root');
		const options = [...root.querySelectorAll('.answer_p')];
		await fixture.runtime
			.resolver({ root, searchInfos: infos })
			.single(infos, options, async (_type: string, _answer: string, option: any) => option.click());
		expect(options[0].querySelector('input').checked).toBe(true);
		fixture.decisions['task-1'] = { taskId: 'task-1', status: 'manual', answer: ['B'], submissionBlocked: false };
		await new Promise((resolve) => setTimeout(resolve, 1900));
		expect(options.map((option: any) => option.querySelector('input').checked)).toEqual([false, true]);
	});
	it.each([[['one']], [['one', 'two', 'three']]])(
		'rejects a blank mismatch for %j without modifying fields',
		async (answers) => {
			const fixture = page('<div id="root"><textarea></textarea><textarea></textarea></div>', {
				'task-1': { taskId: 'task-1', status: 'agree', answer: answers, submissionBlocked: false }
			});
			const session = await fixture.runtime.begin({ title: 'two', type: 'completion' }, questionContext(fixture));
			expect(session.input.options).toEqual(['第 1 空', '第 2 空']);
			const infos = await fixture.runtime.finish(session, []);
			const root = fixture.window.document.querySelector('#root');
			const result = await fixture.runtime
				.resolver({ root, searchInfos: infos })
				.completion(infos, [...root.querySelectorAll('textarea')], async () => {});
			expect(result.finish).toBe(false);
			expect(result.error).toContain('数量');
			expect([...root.querySelectorAll('textarea')].map((field: any) => field.value)).toEqual(['', '']);
		}
	);
	it('does not treat stale checked attributes or partially-filled blanks as complete', () => {
		const fixture = page(
			'<div id="root"><input type="radio" checked></div><div id="blanks"><textarea>done</textarea><textarea></textarea></div>'
		);
		const root = fixture.window.document.querySelector('#root');
		root.querySelector('input').checked = false;
		expect(fixture.runtime.questionAnswered(root)).toBe(false);
		expect(fixture.runtime.questionAnswered(fixture.window.document.querySelector('#blanks'))).toBe(false);
	});
	it('uses only final submission endpoints and explicit application-level success', () => {
		const { runtime } = page();
		expect(runtime.finalSubmissionUrl('/work/addStudentWorkNew')).toBe(true);
		expect(runtime.finalSubmissionUrl('/work/validate')).toBe(false);
		expect(runtime.finalSubmissionUrl('/work/submitValidate')).toBe(false);
		expect(runtime.finalSubmissionUrl('/work/addStudentWorkNew?tempsave=1')).toBe(false);
		expect(runtime.finalSubmissionUrl('/work/addStudentWorkNew', 'tempsave=1')).toBe(false);
		expect(runtime.finalSubmissionUrl('/work/addStudentWorkNew', { savestatus: 0 })).toBe(false);
		expect(runtime.finalSubmissionUrl('/work/addStudentWorkNew', { savestatus: 1 })).toBe(true);
		expect(runtime.submissionResponse('{}', 200)).toEqual({});
		expect(runtime.submissionResponse('{"status":true}', 200).ok).toBe(true);
		expect(runtime.submissionResponse('{"status":true}', 500).ok).toBe(false);
	});
	it('confirms a matching final fetch response and restores the original page fetch', async () => {
		const fixture = page();
		const fetchResponse = async () => ({ status: 200, clone: () => ({ text: async () => '{"status":true}' }) });
		fixture.window.fetch = fetchResponse;
		const result = await fixture.runtime.submit(
			[],
			async () => {
				await fixture.window.fetch('/work/addStudentWorkNew');
				return true;
			},
			20
		);
		expect(result.ok).toBe(true);
		expect(fixture.window.fetch).toBe(fetchResponse);
	});
	it('submits a chapter test through its delayed parent #popok callback, including English span buttons', async () => {
		const parent = page(
			'<div id="workpop" style="display:none">Submit this assignment? <span id="popok">Submit</span></div>'
		);
		const child = page();
		let wrongEntry = 0;
		let confirmations = 0;
		let requests = 0;
		parent.window.btnBlueSubmit = () => wrongEntry++;
		child.window.fetch = async () => {
			requests++;
			return { status: 200, clone: () => ({ text: async () => '{"status":true}' }) };
		};
		child.window.btnBlueSubmit = () => {
			setTimeout(() => {
				parent.window.document.querySelector('#popok').onclick = () => {
					confirmations++;
					child.window.fetch('/work/addStudentWorkNew');
				};
				parent.window.document.querySelector('#workpop').style.display = 'block';
			}, 20);
		};
		const result = await parent.runtime.submit([child.window], undefined, 500);
		expect(result.ok).toBe(true);
		expect(wrongEntry).toBe(0);
		expect(confirmations).toBe(1);
		expect(requests).toBe(1);
	});
	it('uses the registered confirmation handler instead of calling submitCheckTimes directly', async () => {
		const fixture = page('<div id="workpop" style="display:none">确定提交作业？<span id="popok">确定</span></div>');
		let directCalls = 0;
		let confirmations = 0;
		fixture.window.submitCheckTimes = () => directCalls++;
		fixture.window.fetch = async () => ({ status: 200, clone: () => ({ text: async () => '{"status":true}' }) });
		fixture.window.btnBlueSubmit = () => {
			fixture.window.document.querySelector('#popok').onclick = () => {
				confirmations++;
				fixture.window.fetch('/work/addStudentWorkNew');
			};
			fixture.window.document.querySelector('#workpop').style.display = 'block';
		};
		const result = await fixture.runtime.submit([], undefined, 400);
		expect(result.ok).toBe(true);
		expect(directCalls).toBe(0);
		expect(confirmations).toBe(1);
	});
	it('observes jQuery final responses before the native success callback and restores ajax', async () => {
		const fixture = page();
		let nativeCallbacks = 0;
		const ajax = (settings: any) => {
			settings.success({ status: true }, 'success', { status: 200 });
			return { readyState: 4 };
		};
		fixture.window.jQuery = { ajax };
		const result = await fixture.runtime.submit(
			[],
			() => {
				fixture.window.jQuery.ajax({ url: '/work/addStudentWorkNew', success: () => nativeCallbacks++ });
				return true;
			},
			20
		);
		expect(result.ok).toBe(true);
		expect(nativeCallbacks).toBe(1);
		expect(fixture.window.jQuery.ajax).toBe(ajax);
	});
	it('ignores autosave responses while waiting for a visible submit confirmation', async () => {
		const fixture = page(
			'<div id="submitConfirmPop" style="display:none">Confirm submission? <span class="bluebtn" role="button">Confirm</span></div>'
		);
		const urls: string[] = [];
		fixture.window.fetch = async (url: string) => {
			urls.push(url);
			return { status: 200, clone: () => ({ text: async () => '{"status":true}' }) };
		};
		const button = fixture.window.document.querySelector('.bluebtn');
		button.onclick = () => {
			fixture.window.fetch('/work/addStudentWorkNew');
		};
		const result = await fixture.runtime.submit(
			[],
			async () => {
				await fixture.window.fetch('/work/addStudentWorkNew', { body: 'tempsave=1' });
				fixture.window.document.querySelector('#submitConfirmPop').style.display = 'block';
				return true;
			},
			300
		);
		expect(result.ok).toBe(true);
		expect(urls).toHaveLength(2);
	});
	it('does not click hidden confirmations or unrelated dialogs, and explains the missing final request', async () => {
		const fixture = page(
			'<div style="display:none"><div id="workpop">Submit?<span id="popok">OK</span></div></div><div role="dialog">Delete this item?<button>Confirm</button></div>'
		);
		let clicks = 0;
		fixture.window.document.body.addEventListener('click', () => clicks++);
		const result = await fixture.runtime.submit([], () => true, 20);
		expect(clicks).toBe(0);
		expect(result.ok).toBe(false);
		expect(result.reason).toContain('未发出最终提交请求');
	});
	it('distinguishes a final request without a response from a missing confirmation', async () => {
		const fixture = page();
		fixture.window.fetch = () => new Promise(() => {});
		const result = await fixture.runtime.submit(
			[],
			() => {
				fixture.window.fetch('/work/addStudentWorkNew');
				return true;
			},
			20
		);
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('最终提交请求超时，未收到服务器响应');
	});
	it('does not let a previous chapter timeout block a new question set after the old root is removed', async () => {
		const fixture = page('<div class="questionLi">Previous chapter</div>');
		const root = fixture.window.document.querySelector('.questionLi');
		const session = await fixture.runtime.begin(
			{ title: 'Previous chapter', type: 'single', options: ['A'] },
			questionContext(fixture)
		);
		const searchInfos = await fixture.runtime.finish(session, []);
		fixture.runtime.resolver({ root, searchInfos });
		expect((await fixture.runtime.submit([], () => true, 20)).ok).toBe(false);
		expect(fixture.runtime.isBlocked()).toBe(true);
		root.remove();
		expect(fixture.runtime.isBlocked()).toBe(false);
		fixture.window.fetch = async () => ({ status: 200, clone: () => ({ text: async () => '{"status":true}' }) });
		const result = await fixture.runtime.submit(
			[],
			async () => {
				await fixture.window.fetch('/work/addStudentWorkNew');
				return true;
			},
			20
		);
		expect(result.ok).toBe(true);
	});
	it('does not infer submission success from an HTTP 200 with an unknown response body', async () => {
		const fixture = page();
		fixture.window.fetch = async () => ({ status: 200, clone: () => ({ text: async () => '{}' }) });
		const result = await fixture.runtime.submit(
			[],
			async () => {
				await fixture.window.fetch('/work/addStudentWorkNew');
				return true;
			},
			1
		);
		expect(result.ok).toBe(false);
	});
	it('does not auto-submit formal exams or an incomplete question set', async () => {
		const fixture = page('', {}, 'https://mooc1.chaoxing.com/exam-ans/exam/test');
		expect(
			(
				await fixture.runtime.submit(
					[],
					() => {
						throw new Error('must not run');
					},
					1
				)
			).ok
		).toBe(false);
		const called: boolean[] = [];
		await page().runtime.upload(
			{ opts: {}, doWork: async () => [] },
			{
				type: 'force',
				results: [],
				callback: (_rate: number, allow: boolean) => called.push(allow)
			}
		);
		expect(called).toEqual([false]);
	});
});

describe('browser image collection and decoding', () => {
	it('does not attach the exam countdown icon to a text-only OCS 5 question', async () => {
		const fixture = page(
			'<div class="questionLi"><div class="countdown"><img src="https://images.example.test/clock.png"></div>' +
				'<span class="title">Synthetic text question</span><label class="answer_p">A</label></div>'
		);
		let requests = 0;
		fixture.context.fetch = async () => {
			requests++;
			throw new Error('Unexpected clock download');
		};
		const upstream = upstreamFive(fixture);
		const built = await upstream.build({
			title: 'Synthetic text question',
			options: ['A'],
			titleImages: [],
			optionsImages: [],
			enableImageOptimize: false
		});
		await fixture.runtime.begin(built.env, questionContext(fixture));
		const input = fixture.calls.find((call) => call.operation === 'begin').data;
		expect(input.images).toEqual([]);
		expect(input.imageErrors).toEqual([]);
		expect(requests).toBe(0);
	});
	it('keeps a clock diagram when it really belongs to the question instead of blacklisting clock filenames', async () => {
		const fixture = page(
			'<div class="questionLi">Clock diagram question<img src="https://images.example.test/ui-clock.png"></div>'
		);
		const requested: string[] = [];
		fixture.context.fetch = async (url: string) => {
			requested.push(url);
			return { ok: true, blob: async () => new fixture.window.Blob([png], { type: 'image/png' }) };
		};
		await fixture.runtime.begin(
			{
				title: 'Clock diagram question',
				ocs_required_images: ['https://images.example.test/question-clock.png']
			},
			questionContext(fixture)
		);
		expect(requested).toEqual(['https://images.example.test/question-clock.png']);
		expect(fixture.calls.find((call) => call.operation === 'begin').data.images).toEqual([pngData]);
	});
	it('trusts an explicit empty upstream image list even when stem/option containers have icons', async () => {
		const fixture = page(
			'<div class="questionLi"><div class="countdown"><img src="https://images.example.test/clock.png"></div>' +
				'<div class="mark_name">Lazy stem<img src="" data-src="https://images.example.test/diagram.png"></div></div>'
		);
		const requested: string[] = [];
		fixture.context.fetch = async (url: string) => {
			requested.push(url);
			return { ok: true, blob: async () => new fixture.window.Blob([png], { type: 'image/png' }) };
		};
		await fixture.runtime.begin({ title: 'Lazy stem', ocs_required_images: [] }, questionContext(fixture));
		expect(requested).toEqual([]);
		expect(fixture.calls.find((call) => call.operation === 'begin').data.images).toEqual([]);
	});
	it('limits legacy DOM fallback to available stem and option containers', async () => {
		const fixture = page(
			'<div class="questionLi"><div class="countdown"><img src="https://images.example.test/clock.png"></div>' +
				'<div class="mark_name">Legacy question<img src="https://images.example.test/formula.png"></div>' +
				'<label class="answer_p">A<img src="https://images.example.test/option.png"></label></div>'
		);
		const requested: string[] = [];
		fixture.context.fetch = async (url: string) => {
			requested.push(url);
			return { ok: true, blob: async () => new fixture.window.Blob([png], { type: 'image/png' }) };
		};
		await fixture.runtime.begin({ title: 'Legacy question' }, questionContext(fixture));
		expect(requested).toEqual(['https://images.example.test/formula.png', 'https://images.example.test/option.png']);
	});
	it('uses a valid 706-byte PNG with a compressed pixel stream and proper PNG chunks', () => {
		expect(png.length).toBe(706);
		let offset = 8;
		const types: string[] = [];
		while (offset < png.length) {
			const size = png.readUInt32BE(offset);
			const type = png.subarray(offset + 4, offset + 8).toString('ascii');
			types.push(type);
			if (type === 'IDAT')
				expect([...inflateSync(png.subarray(offset + 8, offset + 8 + size))]).toEqual([0, 110, 90, 70, 255]);
			offset += size + 12;
		}
		expect(types).toEqual(['IHDR', 'tEXt', 'IDAT', 'IEND']);
		expect(offset).toBe(png.length);
	});
	it('filters empty, missing, fragment and current-document URLs before any fetch', async () => {
		const url = 'https://mooc1.chaoxing.com/exam-ans/mooc2/exam/preview?synthetic=1';
		const fixture = page(
			'<div class="questionLi">Synthetic question' +
				'<img><img src=""><img src=" "><img src="#"><img src="#answer">' +
				`<img src="${url}"><img src="${url}#answer"></div>`,
			{},
			url
		);
		let requests = 0;
		fixture.context.fetch = async () => {
			requests++;
			throw new Error('must not fetch the page');
		};
		await fixture.runtime.begin(
			{
				title: 'Synthetic question',
				images: ['', ' ', '#', '#answer', url, url + '#answer'],
				ocs_image_sources: ['', ' ', '#', '#answer', url, url + '#answer'],
				ocs_required_images: ['', ' ', '#', '#answer', url, url + '#answer']
			},
			questionContext(fixture)
		);
		const input = fixture.calls.find((call) => call.operation === 'begin').data;
		expect(requests).toBe(0);
		expect(input.images).toEqual([]);
		expect(input.imageErrors).toEqual([]);
	});
	it('keeps the real PNG when upstream image arrays also contain this exam document', async () => {
		const url = 'https://mooc1.chaoxing.com/exam-ans/mooc2/exam/preview';
		const fixture = page(`<div class="questionLi">Synthetic question<img src=""><img src="${url}"></div>`, {}, url);
		let requests = 0;
		fixture.context.fetch = async () => {
			requests++;
			throw new Error('must not fetch');
		};
		await fixture.runtime.begin(
			{
				title: 'Synthetic question',
				images: [pngData, url],
				ocs_image_sources: ['https://images.example.test/synthetic.png', url],
				ocs_required_images: ['https://images.example.test/synthetic.png', url, url + '#answer']
			},
			questionContext(fixture)
		);
		const input = fixture.calls.find((call) => call.operation === 'begin').data;
		expect(requests).toBe(0);
		expect(input.images).toEqual([pngData]);
		expect(input.imageErrors).toEqual([]);
	});
	it('uses lazy image attributes when currentSrc/src are absent or refer to this document', async () => {
		const fixture = page(
			'<div class="questionLi">Lazy question' +
				'<img src="" data-src="https://images.example.test/first.png">' +
				'<img src="#answer" data-original="https://images.example.test/second.png"></div>'
		);
		const first = fixture.window.document.querySelector('img');
		Object.defineProperty(first, 'currentSrc', { value: fixture.window.location.href + '#answer' });
		const requested: string[] = [];
		fixture.context.fetch = async (url: string) => {
			requested.push(url);
			return { ok: true, blob: async () => new fixture.window.Blob([png], { type: 'image/png' }) };
		};
		await fixture.runtime.begin({ title: 'Lazy question' }, questionContext(fixture));
		expect(requested).toEqual(['https://images.example.test/first.png', 'https://images.example.test/second.png']);
		expect(fixture.calls.find((call) => call.operation === 'begin').data.imageErrors).toEqual([]);
	});
	it.each(['', 'application/octet-stream'])('recognizes PNG bytes with response MIME %j', async (type) => {
		const fixture = page();
		let credentials: string | undefined;
		fixture.context.fetch = async (_url: string, options: any) => {
			credentials = options.credentials;
			return { ok: true, blob: async () => new fixture.window.Blob([png], { type }) };
		};
		await fixture.runtime.begin(
			{ title: 'Synthetic PNG', images: ['https://images.example.test/synthetic.png'] },
			questionContext(fixture)
		);
		const input = fixture.calls.find((call) => call.operation === 'begin').data;
		expect(credentials).toBe('include');
		expect(input.images).toEqual([pngData]);
		expect(input.imageErrors).toEqual([]);
	});
	it.each(rasterSamples)('recognizes a complete %s image regardless of octet-stream MIME', async (mime, base64) => {
		const fixture = page();
		fixture.context.fetch = async () => ({
			ok: true,
			blob: async () => new fixture.window.Blob([Buffer.from(base64, 'base64')], { type: 'application/octet-stream' })
		});
		await fixture.runtime.begin(
			{ title: 'Raster sample', images: ['https://images.example.test/sample'] },
			questionContext(fixture)
		);
		const input = fixture.calls.find((call) => call.operation === 'begin').data;
		expect(input.images).toEqual([`data:${mime};base64,${base64}`]);
		expect(input.imageErrors).toEqual([]);
	});
	it('retains a real mapping source even when its preconverted image is missing', async () => {
		const fixture = page();
		const requested: string[] = [];
		fixture.context.fetch = async (url: string) => {
			requested.push(url);
			return { ok: true, blob: async () => new fixture.window.Blob([png], { type: 'image/png' }) };
		};
		await fixture.runtime.begin(
			{
				title: 'Mapping without preconverted data',
				ocs_image_sources: ['https://images.example.test/required.png'],
				images: []
			},
			questionContext(fixture)
		);
		expect(requested).toEqual(['https://images.example.test/required.png']);
		expect(fixture.calls.find((call) => call.operation === 'begin').data.images).toEqual([pngData]);
	});
	it('reports HTML as a page/non-image response without a misleading size error or sensitive URL', async () => {
		const fixture = page();
		const source = 'https://images.example.test/synthetic.png';
		fixture.context.fetch = async () => ({
			ok: true,
			blob: async () => new fixture.window.Blob(['<!doctype html><title>Sign in</title>'], { type: 'text/html' })
		});
		await fixture.runtime.begin({ title: 'Missing real image', images: [source] }, questionContext(fixture));
		const input = fixture.calls.find((call) => call.operation === 'begin').data;
		expect(input.images).toEqual([source]);
		expect(input.imageErrors).toHaveLength(1);
		expect(input.imageErrors[0]).toContain('网页/非图片响应');
		expect(input.imageErrors[0]).toContain('text/html');
		expect(input.imageErrors[0]).not.toMatch(/8|MiB|example\.test/);
	});
	it('tries GM fallback when fetch returns HTTP 200 HTML but the real image is available there', async () => {
		const fixture = page();
		fixture.context.fetch = async () => ({
			ok: true,
			blob: async () => new fixture.window.Blob(['<html>sign in</html>'], { type: 'text/html' })
		});
		let fallback = false;
		fixture.context.GM_xmlhttpRequest = (options: any) => {
			fallback = true;
			options.onload({ status: 200, response: new fixture.window.Blob([png], { type: 'application/octet-stream' }) });
		};
		await fixture.runtime.begin(
			{ title: 'GM image', images: ['https://images.example.test/synthetic.png'] },
			questionContext(fixture)
		);
		const input = fixture.calls.find((call) => call.operation === 'begin').data;
		expect(fallback).toBe(true);
		expect(input.images).toEqual([pngData]);
		expect(input.imageErrors).toEqual([]);
	});
	it('keeps more than eight images in source order with at most four concurrent downloads', async () => {
		const fixture = page();
		const sources = Array.from({ length: 13 }, (_, index) => `https://images.example.test/${index}.png`);
		const pictures = sources.map((_, index) => syntheticPng(706 + index));
		let active = 0;
		let maximum = 0;
		fixture.context.fetch = async (url: string) => {
			const index = sources.indexOf(url);
			active++;
			maximum = Math.max(maximum, active);
			await new Promise((resolve) => setTimeout(resolve, ((13 - index) % 5) * 5));
			active--;
			return { ok: true, blob: async () => new fixture.window.Blob([pictures[index]], { type: 'image/png' }) };
		};
		await fixture.runtime.begin({ title: 'Many synthetic images', images: sources }, questionContext(fixture));
		const input = fixture.calls.find((call) => call.operation === 'begin').data;
		expect(maximum).toBe(4);
		expect(input.images).toEqual(pictures.map((picture) => 'data:image/png;base64,' + picture.toString('base64')));
		expect(input.imageErrors).toEqual([]);
	});
	it('keeps valid PNGs larger than 8 MiB and a total larger than 24 MiB', async () => {
		const fixture = page();
		const picture = syntheticPng(9 * 1024 * 1024);
		fixture.context.fetch = async () => ({
			ok: true,
			blob: async () => new fixture.window.Blob([picture], { type: 'application/octet-stream' })
		});
		await fixture.runtime.begin(
			{
				title: 'Large synthetic PNGs',
				images: [0, 1, 2].map((index) => `https://images.example.test/large-${index}.png`)
			},
			questionContext(fixture)
		);
		const input = fixture.calls.find((call) => call.operation === 'begin').data;
		expect(input.images).toHaveLength(3);
		expect(input.images.reduce((length: number, value: string) => length + value.length, 0)).toBeGreaterThan(
			32 * 1024 * 1024
		);
		expect(input.images.every((value: string) => value.startsWith('data:image/png;base64,'))).toBe(true);
		expect(input.imageErrors).toEqual([]);
	}, 20000);
});

describe('worker-owned bridge', () => {
	it('limits origins to supported course sites, rejecting host spoofing and non-web schemes', () => {
		expect(isAllowedQuestionPage('https://mooc1.chaoxing.com/work/a')).toBe(true);
		expect(isAllowedQuestionPage('https://chaoxing.com.attacker.net/')).toBe(false);
		expect(isAllowedQuestionPage('file:///tmp/chaoxing.com')).toBe(false);
	});
	it('keeps the credential in the worker, overrides caller identity and rejects foreign task IDs', async () => {
		const requests: any[] = [];
		const server = http.createServer((req, res) => {
			let body = '';
			req.on('data', (chunk) => {
				body += chunk;
			});
			req.on('end', () => {
				requests.push({ token: req.headers['x-ocs-question-token'], data: JSON.parse(body), url: req.url });
				res.setHeader('content-type', 'application/json');
				res.end(
					JSON.stringify(
						req.url?.endsWith('begin') ? { taskId: 'owned', enabled: true, strategy: 'consensus' } : { ok: true }
					)
				);
			});
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		cleanup.push(() => server.close());
		const session = { port: (server.address() as any).port, token: 'worker-secret', enabled: true };
		const browser: any = new EventEmitter();
		const coursePage: any = new EventEmitter();
		let url = 'https://mooc1.chaoxing.com/work/a';
		const frame: any = { url: () => url, isDetached: () => false, page: () => coursePage };
		coursePage.isClosed = () => false;
		coursePage.context = () => browser;
		browser.pages = () => [coursePage];
		let callback: any;
		browser.exposeBinding = async (_name: string, handler: any) => {
			callback = handler;
		};
		const dispose = await installQuestionBinding(browser, 'browser-owner', session);
		const source = { page: coursePage, frame };
		await callback(source, 'begin', {
			question: 'q',
			options: [],
			browserUid: 'spoofed',
			pageId: 'spoofed',
			sourceUrl: 'https://attacker.net'
		});
		expect(requests[0].token).toBe('worker-secret');
		expect(requests[0].data.browserUid).toBe('browser-owner');
		expect(requests[0].data.pageId).not.toBe('spoofed');
		expect(requests[0].data.sourceUrl).toBe(url);
		await expect(callback(source, 'decision', { taskId: 'foreign' })).rejects.toThrow('不属于');
		await expect(callback(source, 'capture', {})).rejects.toThrow('不支持');
		await expect(callback(source, 'decisions', { taskIds: ['owned', 'foreign'] })).rejects.toThrow('不属于');
		await callback(source, 'decisions', { taskIds: ['owned'] });
		expect(requests.at(-1).data.taskIds).toEqual(['owned']);
		url = 'https://mooc1.chaoxing.com/work/b';
		await expect(callback(source, 'decision', { taskId: 'owned' })).rejects.toThrow('已变化');
		await dispose();
		expect(requests.some((item) => item.url.endsWith('disconnect'))).toBe(true);
	});
	it('propagates server authorization failures', async () => {
		const server = http.createServer((_req, res) => {
			res.writeHead(401);
			res.end('{"error":"unauthorized"}');
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		cleanup.push(() => server.close());
		await expect(
			postQuestionBridge({ port: (server.address() as any).port, token: 'bad', enabled: true }, 'decision', {})
		).rejects.toThrow('unauthorized');
	});
});
