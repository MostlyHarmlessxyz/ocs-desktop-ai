import { describe, expect, it, vi } from 'vitest';
import type { Frame } from 'playwright-core';
import { captureQuestion, type QuestionCaptureRequest } from '../src/question-browser/capture';
import { imageFixture } from './helpers/image-fixture';

const image = imageFixture(1, 1);
const request: QuestionCaptureRequest = {
	rootId: 'question',
	parts: [
		{ id: 'stem', role: 'stem', label: '题干', text: 'Synthetic question' },
		{ id: 'option', role: 'option', label: '选项 A', text: 'Synthetic option' }
	]
};

/** Minimal Playwright frame tree, including frames whose first navigation has
 * not happened yet. DOM/screenshot behavior is independent of URL discovery. */
function mockFrame(url: string, hasQuestion = false) {
	const state = { url, detached: false, children: [] as Frame[], parent: null as Frame | null };
	const snapshot = { evaluate: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
	const screenshot = vi.fn(async () => image);
	const locator = vi.fn((selector: string): any => {
		const id = /data-ocs-ai-capture="([^"]+)"/.exec(selector)?.[1];
		const part = request.parts.find((part) => part.id === id);
		return {
			count: async () => (hasQuestion && (id === request.rootId || part) ? 1 : 0),
			evaluate: async () => true,
			evaluateHandle: async () => snapshot,
			textContent: async () => part?.text || '',
			screenshot,
			locator
		};
	});
	const frame = {
		url: () => state.url,
		isDetached: () => state.detached,
		childFrames: () => state.children,
		parentFrame: () => state.parent,
		frameElement: async () => ({ evaluateHandle: async () => snapshot, dispose: async () => {} }),
		waitForFunction: async () => {},
		locator
	} as unknown as Frame;
	return { frame, state, locator, screenshot };
}

describe('question capture frame discovery', () => {
	it.each(['', 'http://[invalid'])(
		'ignores an unrelated frame with URL %j and captures the main question',
		async (url) => {
			const page = mockFrame('https://mooc1.chaoxing.com/work/test', true);
			const loading = mockFrame(url);
			page.state.children.push(loading.frame);
			const result = await captureQuestion(page.frame, request, () => true);
			expect(result.imageLabels).toEqual(['题干', '选项 A']);
			expect(result.images).toEqual(request.parts.map(() => 'data:image/png;base64,' + image.toString('base64')));
			expect(loading.locator).not.toHaveBeenCalled();
			expect(page.screenshot).toHaveBeenCalledTimes(2);
		}
	);
	it('finds the question in its stable child frame while a sibling is still initializing', async () => {
		const page = mockFrame('https://mooc1.chaoxing.com/knowledge/cards');
		const loading = mockFrame('');
		const question = mockFrame('https://mooc1.chaoxing.com/work/test', true);
		question.state.parent = page.frame;
		page.state.children.push(loading.frame, question.frame);
		const result = await captureQuestion(page.frame, request, () => true);
		expect(result.images).toHaveLength(2);
		expect(question.screenshot).toHaveBeenCalledTimes(2);
		expect(page.screenshot).not.toHaveBeenCalled();
		expect(loading.locator).not.toHaveBeenCalled();
	});
	it('does not inspect detached or unrelated-origin frames', async () => {
		const page = mockFrame('https://mooc1.chaoxing.com/work/test', true);
		const detached = mockFrame('https://mooc1.chaoxing.com/old', true);
		detached.state.detached = true;
		const unrelated = mockFrame('https://other.example/work/test', true);
		page.state.children.push(detached.frame, unrelated.frame);
		expect((await captureQuestion(page.frame, request, () => true)).images).toHaveLength(2);
		expect(detached.locator).not.toHaveBeenCalled();
		expect(unrelated.locator).not.toHaveBeenCalled();
	});
	it('reports an unavailable source page without throwing a URL parser exception', async () => {
		const page = mockFrame('');
		await expect(captureQuestion(page.frame, request, () => true)).rejects.toThrow('题目页面尚未加载完成或已变化');
		expect(page.locator).not.toHaveBeenCalled();
	});
});
