import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { installQuestionBinding } from '../src/question-browser/binding';
import { captureQuestion } from '../src/question-browser/capture';

vi.mock('../src/question-browser/capture', () => ({ captureQuestion: vi.fn() }));
const capture = vi.mocked(captureQuestion);
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
	vi.useFakeTimers();
	capture.mockReset();
});
afterEach(async () => {
	vi.useRealTimers();
	for (const close of cleanups.splice(0)) await close();
});
async function fixture() {
	const page: any = new EventEmitter();
	const browser: any = new EventEmitter();
	const frame: any = { url: () => 'https://mooc1.chaoxing.com/work/test', isDetached: () => false, page: () => page };
	page.isClosed = () => false;
	page.context = () => browser;
	browser.pages = () => [page];
	let binding: any;
	browser.exposeBinding = async (_name: string, callback: any) => {
		binding = callback;
	};
	cleanups.push(await installQuestionBinding(browser, 'synthetic', { port: 1, token: 'test', enabled: true }));
	return { page, frame, run: () => binding({ page, frame }, 'capture', { rootId: 'question', parts: [] }) };
}

describe('bounded capture queue', () => {
	it('expires queued captures, does not start their work later, and accepts a fresh request', async () => {
		const f = await fixture();
		let release!: (value: { images: string[]; imageLabels: string[] }) => void;
		capture.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				})
		);
		const first = f.run().catch((error: Error) => error.message);
		const queued = f.run().catch((error: Error) => error.message);
		await vi.advanceTimersByTimeAsync(0);
		expect(capture).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(30001);
		expect(await first).toContain('超时');
		expect(await queued).toContain('超时');
		expect(capture.mock.calls[0][2]()).toBe(false);
		release({ images: [], imageLabels: [] });
		await vi.advanceTimersByTimeAsync(0);
		expect(capture).toHaveBeenCalledOnce();
		capture.mockResolvedValueOnce({ images: ['fresh'], imageLabels: ['题干'] });
		expect(await f.run()).toEqual({ images: ['fresh'], imageLabels: ['题干'] });
	});
	it('a failed capture releases the queue for the next question', async () => {
		const f = await fixture();
		capture.mockRejectedValueOnce(new Error('synthetic screenshot failure'));
		capture.mockResolvedValueOnce({ images: ['next'], imageLabels: ['题干'] });
		const failed = f.run().catch((error: Error) => error.message);
		const next = f.run();
		expect(await failed).toContain('synthetic');
		expect((await next).images).toEqual(['next']);
	});
});
