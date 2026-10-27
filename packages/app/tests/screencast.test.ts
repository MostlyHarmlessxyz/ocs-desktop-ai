import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import vm from 'vm';

// Execute the production method without starting the worker's IPC/bootstrap code.
const source = fs.readFileSync(path.resolve(__dirname, '../src/worker/index.ts'), 'utf8');
const parsed = ts.createSourceFile('worker.ts', source, ts.ScriptTarget.ES2020, true);
const worker = parsed.statements.find(
	(node) => ts.isClassDeclaration(node) && node.name?.text === 'ScriptWorker'
) as ts.ClassDeclaration;
const method = worker.members.find((node) => node.name?.getText(parsed) === 'startScreencast')!;
const code = ts.transpileModule(`class TestWorker { ${method.getText(parsed)} }`, {
	compilerOptions: { target: ts.ScriptTarget.ES2020 }
}).outputText;

describe('preview stream startup', () => {
	it.each([false, true])('receives the first frame before startScreencast settles (failure=%s)', async (fail) => {
		const pushed = vi.fn();
		const Worker = new vm.Script(code + '\nTestWorker;').runInNewContext({ send: pushed, setTimeout });
		const instance = new Worker();
		let onFrame: (frame: any) => void = () => {};
		const session = {
			on: (_name: string, callback: typeof onFrame) => {
				onFrame = callback;
			},
			detach: vi.fn(async () => {}),
			send: async () => {
				onFrame({ data: 'synthetic-frame', sessionId: 1 });
				if (fail) throw new Error('synthetic start failure');
			}
		};
		const page = {
			isClosed: () => false,
			on: () => {},
			url: () => 'https://example.test',
			waitForLoadState: async () => {},
			context: () => ({ newCDPSession: async () => session })
		};
		Object.assign(instance, {
			uid: 'test',
			browser: {},
			screencastInFlight: 0,
			screencastAckQueue: [],
			stopScreencastInternal: async () => {},
			setupScreencastTracking: () => {},
			pickScreencastPage: () => page,
			isInternalScreencastPage: () => false,
			captureScreencastFirstFrame: async () => {},
			flushScreencastAcks: vi.fn(),
			info: () => {},
			warn: () => {}
		});
		await instance.startScreencast();
		expect(pushed).toHaveBeenCalledWith('screencast-frame', 'test', 'synthetic-frame');
		expect(instance.flushScreencastAcks).toHaveBeenCalledOnce();
		if (fail) {
			expect(session.detach).toHaveBeenCalledOnce();
			expect(instance.screencastSession).toBeUndefined();
		} else expect(instance.screencastSession).toBe(session);
	});
});
