/* global ScrollBehavior */
import type { Frame, JSHandle } from 'playwright-core';

export interface QuestionCaptureRequest {
	rootId: string;
	parts: Array<{ id: string; label: string; role: 'stem' | 'option'; text?: string }>;
}

/** Capture only explicitly marked question content in the invoking frame or a
 * same-origin child frame (Chaoxing chapter tests are rendered in an iframe). The
 * original font/text stays untouched; no OCR guess is written back to the page. */
export async function captureQuestion(frame: Frame, request: QuestionCaptureRequest, isCurrent: () => boolean) {
	const deadline = Date.now() + 15000;
	const timeout = () => {
		if (!isCurrent()) throw new Error('题目页面已变化，截图已停止');
		if (Date.now() >= deadline) throw new Error('题目采集超时，请重新搜题');
		return Math.max(1, deadline - Date.now());
	};
	const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
	if (
		!validId(request?.rootId) ||
		!Array.isArray(request.parts) ||
		!request.parts.length ||
		request.parts.length > 200
	) {
		throw new Error('题目截图上下文无效');
	}
	if (request.parts.some((part) => !validId(part?.id) || !['stem', 'option'].includes(part.role))) {
		throw new Error('题目截图区域无效');
	}
	const frameOrigin = (target: Frame) => {
		try {
			return new URL(target.url()).origin;
		} catch {
			// Playwright exposes newly attached frames before their first URL is
			// available. An unrelated loading frame must not abort this question.
			return undefined;
		}
	};
	const frames = [frame];
	const origin = frameOrigin(frame);
	if (!isCurrent() || frame.isDetached() || origin === undefined)
		throw new Error('题目页面尚未加载完成或已变化，请重新搜题');
	for (const parent of frames) {
		for (const child of parent.childFrames()) {
			if (!child.isDetached() && frameOrigin(child) === origin) frames.push(child);
		}
	}
	const matches = (
		await Promise.all(
			frames.map(async (candidate) =>
				(await candidate
					.locator(`[data-ocs-ai-capture="${request.rootId}"]`)
					.count()
					.catch(() => 0)) === 1
					? candidate
					: undefined
			)
		)
	).filter((candidate): candidate is Frame => !!candidate);
	if (matches.length !== 1) throw new Error('无法唯一定位题目所在页面，请重新搜题');
	frame = matches[0];
	const capturedUrl = frame.url();
	const active = () => isCurrent() && !frame.isDetached() && frame.url() === capturedUrl;
	const locator = (id: string) => frame.locator(`[data-ocs-ai-capture="${id}"]`);
	const root = locator(request.rootId);
	if (!active() || (await root.count()) !== 1) throw new Error('题目页面已变化，无法读取原始字形');
	if (
		!(await root.evaluate(
			(element) =>
				!element.matches('html,body,iframe') &&
				(!!element.closest('.font-cxsecret') ||
					!!element.querySelector('.font-cxsecret') ||
					/font-cxsecret/i.test(getComputedStyle(element).fontFamily)),
			undefined,
			{ timeout: timeout() }
		))
	)
		throw new Error('该区域不是待识别的自定义字体题目');
	await frame.waitForFunction(() => document.fonts.status === 'loaded', undefined, { timeout: timeout() });
	const snapshotScroll = (element: Element) => {
		const entries: Array<{ element: Element; top: number; left: number }> = [];
		for (let parent: Element | null = element; parent; parent = parent.parentElement) {
			entries.push({ element: parent, top: parent.scrollTop, left: parent.scrollLeft });
		}
		return { entries, x: window.scrollX, y: window.scrollY };
	};
	const element = await root.elementHandle({ timeout: timeout() });
	if (!element) throw new Error('题目页面已变化，无法保存截图位置');
	const snapshot = await element.evaluateHandle(snapshotScroll).finally(() => element.dispose());
	const snapshots: JSHandle[] = [snapshot];
	const images: string[] = [];
	const imageLabels: string[] = [];
	try {
		// Scrolling an iframe element into view can also move its parent page.
		for (let child = frame; child.parentFrame(); child = child.parentFrame()!) {
			const element = await child.frameElement();
			try {
				snapshots.push(await element.evaluateHandle(snapshotScroll));
			} finally {
				await element.dispose();
			}
		}
		const before: Array<string | null> = [];
		for (const part of request.parts) {
			if (!active()) throw new Error('题目页面已变化，截图已停止');
			const target = locator(part.id);
			if (
				(await target.count()) !== 1 ||
				!(await target.evaluate(
					(element, rootId) => {
						const root = document.querySelector(`[data-ocs-ai-capture="${rootId}"]`);
						return !!root && root.contains(element) && !element.matches('html,body,iframe,object,embed,video');
					},
					request.rootId,
					{ timeout: timeout() }
				))
			)
				throw new Error('截图区域不属于当前题目');
			const text = await target.textContent({ timeout: timeout() });
			if (part.text !== undefined && text !== part.text) throw new Error('题目内容已变化，已停止读取过期题目');
			before.push(text);
			// Element screenshots wait for animation frames, which stop in background tabs.
			await target.evaluate(
				(element) =>
					element.scrollIntoView({ behavior: 'instant' as ScrollBehavior, block: 'center', inline: 'nearest' }),
				undefined,
				{ timeout: timeout() }
			);
			const box = await target.boundingBox({ timeout: timeout() });
			if (!box || box.width <= 0 || box.height <= 0)
				throw new Error(`${part.label || '题目'}区域不可见，请检查课程页面`);
			const page = frame.page();
			const offset = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
			const image = await page.screenshot({
				type: 'png',
				fullPage: true,
				clip: { ...box, x: box.x + offset.x, y: box.y + offset.y },
				timeout: timeout(),
				mask: [target.locator('iframe')]
			});
			images.push('data:image/png;base64,' + image.toString('base64'));
			imageLabels.push(String(part.label || (part.role === 'stem' ? '题干' : '选项')).slice(0, 100));
		}
		const after = await Promise.all(request.parts.map((part) => locator(part.id).textContent({ timeout: timeout() })));
		if (!active() || after.some((text, index) => text !== before[index])) {
			throw new Error('题目内容在截图时发生变化，请重新搜题');
		}
		return { images, imageLabels };
	} finally {
		for (const snapshot of snapshots) {
			if (active())
				await snapshot
					.evaluate((state) => {
						for (const item of state.entries) {
							if (item.element.isConnected) {
								item.element.scrollTo({ top: item.top, left: item.left, behavior: 'instant' });
							}
						}
						window.scrollTo({ left: state.x, top: state.y, behavior: 'instant' as ScrollBehavior });
					})
					.catch(() => {});
			await snapshot.dispose();
		}
	}
}
