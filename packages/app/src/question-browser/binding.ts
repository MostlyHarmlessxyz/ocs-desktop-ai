import http from 'http';
import { randomUUID } from 'crypto';
import type { BrowserContext, Frame, Page } from 'playwright-core';
import { captureQuestion, QuestionCaptureRequest } from './capture';

export interface QuestionBridgeSession {
	port: number;
	token: string;
	enabled: boolean;
}
type Operation = 'begin' | 'complete' | 'status' | 'decision' | 'decisions' | 'disconnect';
interface FrameState {
	pageId: string;
	url: string;
	tasks: Set<string>;
	active: boolean;
}

/** Keep the local credential in the Node worker; installed userscripts only see this binding. */
export function isAllowedQuestionPage(url: string): boolean {
	try {
		const parsed = new URL(url);
		if (!['http:', 'https:'].includes(parsed.protocol)) return false;
		const domains = [
			'chaoxing.com',
			'xuexi365.com',
			'smjyxy.cn',
			'gdufemooc.cn',
			'xueyinonline.com',
			'zhihuishu.com',
			'icve.com.cn',
			'icourse163.org',
			'yuketang.cn',
			'hike-teaching-center.polymas.com',
			'edu.cn',
			'org.cn',
			'hnsyu.net',
			'qutjxjy.cn',
			'ynny.cn',
			'hnvist.cn',
			'fjlecb.cn',
			'gdhkmooc.com',
			'cugbonline.cn',
			'zjelib.cn',
			'cqrspx.cn',
			'neauce.com',
			'zhihui-yun.com',
			'cqie.cn',
			'ccqmxx.com',
			'jxgmxy.com',
			'jnzyjsxy.cn',
			'sslibrary.com',
			'courshare.cn',
			'webtrn.cn'
		];
		return domains.some((domain) => parsed.hostname === domain || parsed.hostname.endsWith('.' + domain));
	} catch {
		return false;
	}
}

export function postQuestionBridge(session: QuestionBridgeSession, operation: Operation, data: unknown): Promise<any> {
	return new Promise((resolve, reject) => {
		const body = JSON.stringify(data);
		const request = http.request(
			{
				hostname: '127.0.0.1',
				port: session.port,
				path: `/api/question/bridge/${operation}`,
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'content-length': Buffer.byteLength(body),
					'x-ocs-question-token': session.token
				}
			},
			(response) => {
				const chunks: Buffer[] = [];
				let bytes = 0;
				response.on('data', (chunk: Buffer) => {
					bytes += chunk.length;
					if (bytes > 2 * 1024 * 1024) {
						request.destroy(new Error('智能搜题响应超过大小限制'));
						return;
					}
					chunks.push(chunk);
				});
				response.on('end', () => {
					try {
						const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
						if ((response.statusCode || 500) >= 400) reject(new Error(String(value.error || '智能搜题请求失败')));
						else resolve(value);
					} catch (error) {
						reject(error);
					}
				});
				response.on('error', reject);
			}
		);
		request.setTimeout(operation === 'complete' ? 61 * 60 * 1000 : 10000, () =>
			request.destroy(new Error('智能搜题请求超时'))
		);
		request.on('error', reject);
		request.end(body);
	});
}

export async function installQuestionBinding(
	browser: BrowserContext,
	uid: string,
	session?: QuestionBridgeSession
): Promise<() => Promise<void>> {
	if (!session?.token) return async () => {};
	const states = new Map<Frame, FrameState>();
	const captureQueues = new WeakMap<Page, Promise<void>>();
	const cleanups: Array<() => void> = [];
	let closing = false;
	const disconnect = async (frame: Frame) => {
		const state = states.get(frame);
		if (!state) return;
		state.active = false;
		states.delete(frame);
		await postQuestionBridge(session, 'disconnect', { pageId: state.pageId }).catch(() => {});
	};
	const attach = (page: Page) => {
		const navigated = (frame: Frame) => {
			disconnect(frame).catch(() => {});
		};
		const detached = (frame: Frame) => {
			disconnect(frame).catch(() => {});
		};
		const closed = () => {
			for (const frame of [...states.keys()]) if (frame.page() === page) disconnect(frame).catch(() => {});
		};
		page.on('framenavigated', navigated);
		page.on('framedetached', detached);
		page.on('close', closed);
		cleanups.push(() => {
			page.off('framenavigated', navigated);
			page.off('framedetached', detached);
			page.off('close', closed);
		});
	};
	for (const page of browser.pages()) attach(page);
	browser.on('page', attach);
	cleanups.push(() => browser.off('page', attach));
	await browser.exposeBinding('__ocsQuestionBridge', async ({ page, frame }, operation: unknown, data: any) => {
		if (
			closing ||
			page.isClosed() ||
			frame.isDetached() ||
			page.context() !== browser ||
			!isAllowedQuestionPage(frame.url())
		) {
			throw new Error('当前页面无法使用智能搜题桥接');
		}
		if (!['begin', 'complete', 'status', 'decision', 'decisions', 'capture'].includes(String(operation)))
			throw new Error('不支持的智能搜题操作');
		let state = states.get(frame);
		if (!state) {
			state = { pageId: `${uid}:${randomUUID()}`, url: frame.url(), tasks: new Set(), active: true };
			states.set(frame, state);
		}
		if (!state.active || state.url !== frame.url()) throw new Error('题目页面已变化');
		if (operation === 'capture') {
			const current = state;
			let expired = false;
			let timer: ReturnType<typeof setTimeout>;
			const timeout = new Promise<never>((resolve, reject) => {
				timer = setTimeout(() => {
					expired = true;
					reject(new Error('题目采集排队超时，请稍后重新搜题'));
				}, 30000);
			});
			const pending = (captureQueues.get(page) || Promise.resolve()).then(() => {
				if (expired) throw new Error('题目采集请求已过期');
				if (closing || !current.active || current.url !== frame.url()) throw new Error('题目页面已变化');
				return captureQuestion(
					frame,
					data as QuestionCaptureRequest,
					() => !expired && !closing && current.active && current.url === frame.url()
				);
			});
			captureQueues.set(
				page,
				pending.then(
					() => {},
					() => {}
				)
			);
			try {
				return await Promise.race([pending, timeout]);
			} finally {
				clearTimeout(timer!);
			}
		}
		if (operation === 'decisions') {
			const current = state;
			if (
				!Array.isArray(data?.taskIds) ||
				data.taskIds.length > 500 ||
				data.taskIds.some((id: unknown) => typeof id !== 'string' || !current.tasks.has(id))
			)
				throw new Error('题目任务不属于当前页面');
			const result = await postQuestionBridge(session, 'decisions', { taskIds: data.taskIds });
			if (!current.active || current.url !== frame.url()) throw new Error('题目页面已变化');
			return result;
		}
		if (operation === 'begin') {
			const result = await postQuestionBridge(session, 'begin', {
				question: data?.question,
				options: data?.options,
				type: data?.type,
				images: data?.images,
				imageErrors: data?.imageErrors,
				contentMode: data?.contentMode,
				imageLabels: data?.imageLabels,
				rootId: data?.rootId,
				assessment: data?.assessment,
				formalExam: data?.formalExam,
				browserUid: uid,
				pageId: state.pageId,
				sourceUrl: frame.url()
			});
			if (!state.active || state.url !== frame.url()) {
				await postQuestionBridge(session, 'disconnect', { pageId: state.pageId });
				throw new Error('题目页面已变化，结果不会回填');
			}
			if (typeof result.taskId === 'string' && result.taskId) state.tasks.add(result.taskId);
			return result;
		}
		if (!state.tasks.has(String(data?.taskId))) throw new Error('题目任务不属于当前页面');
		const payload =
			operation === 'complete'
				? { taskId: data.taskId, bankInfos: data.bankInfos }
				: operation === 'status'
				? { taskId: data.taskId, phase: data.phase, error: data.error }
				: { taskId: data.taskId };
		const result = await postQuestionBridge(session, operation as Operation, payload);
		if (!state.active || state.url !== frame.url()) throw new Error('题目页面已变化，结果不会回填');
		return result;
	});
	return async () => {
		closing = true;
		for (const cleanup of cleanups) cleanup();
		await Promise.all([...states.keys()].map(disconnect));
	};
}
