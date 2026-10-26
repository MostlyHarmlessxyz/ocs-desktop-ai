import type { QuestionDecision, QuestionInput, QuestionPhase, QuestionStrategy } from '@ocs-desktop/common';

/** This module is compiled as a browser IIFE and inserted after userscript metadata. */
type Bridge = (operation: string, data: unknown) => Promise<any>;
declare const unsafeWindow: Window & { __ocsQuestionBridge?: Bridge };
type ElementLike = HTMLElement & { value?: string; checked?: boolean; disabled?: boolean };
type OptionText = (option: ElementLike, index: number) => string;
interface Context {
	root: HTMLElement;
	type?: string;
	searchInfos?: any[];
	elements?: { title?: HTMLElement[]; options?: ElementLike[] };
}
interface WorkResult {
	ctx: Context;
	result?: any;
	error?: string;
	resolved?: boolean;
}
interface WorkerLike {
	opts: any;
	isClose?: boolean;
	totalQuestionCount?: number;
	isRunning?: boolean;
	doWork: (options?: any) => Promise<WorkResult[]>;
}
interface Session {
	taskId: string;
	strategy: QuestionStrategy;
	enabled: boolean;
	input: QuestionInput;
	decision?: QuestionDecision;
	root?: HTMLElement;
	apply?: () => Promise<any>;
	tracked?: { result: WorkResult; worker: WorkerLike; index: number; results: WorkResult[] };
	watching?: boolean;
	superseded?: boolean;
	lastApplied?: string;
	verify?: () => boolean;
}

export function createQuestionRuntime() {
	const sessions = new Map<string, Session>();
	const rootSessions = new WeakMap<HTMLElement, Session>();
	const retryRoots = new WeakSet<HTMLElement>();
	const continuations = new WeakMap<WorkerLike, () => Promise<unknown>>();
	const startingLocation = location.href;
	let disposed = false;
	let failedSubmissionRoots: HTMLElement[] | undefined;
	window.addEventListener(
		'pagehide',
		() => {
			disposed = true;
		},
		{ once: true }
	);
	const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
	const connected = () => !disposed && location.href === startingLocation;
	const clean = (value: unknown) =>
		String(value ?? '')
			.normalize('NFKC')
			.replace(/\s+/g, ' ')
			.trim();
	const bridge = (): Bridge => {
		const target = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
		const fn = (target as any).__ocsQuestionBridge;
		if (typeof fn !== 'function') throw new Error('智能搜题桥接未连接，请从 OCS Desktop AI 启动此浏览器');
		return (operation, data) => fn(operation, data);
	};
	const send = (operation: string, data: unknown) => {
		if (!connected()) return Promise.reject(new Error('题目页面已变化，已停止应用旧答案'));
		return bridge()(operation, data);
	};
	const status = (session: Session, phase: QuestionPhase, error?: string) =>
		send('status', { taskId: session.taskId, phase, error }).catch(() => {});
	function windows(extra: any[] = []): any[] {
		// An adapter's explicit question frame owns the submit function. Its
		// parent may also expose a similarly named function for a different form.
		const targets: any[] = [...extra, window];
		try {
			targets.push(window.top);
		} catch {}
		try {
			if (typeof unsafeWindow !== 'undefined') targets.push(unsafeWindow);
		} catch {}
		for (const target of [...targets]) {
			try {
				target.document
					?.querySelectorAll('iframe')
					.forEach((frame: HTMLIFrameElement) => targets.push(frame.contentWindow));
			} catch {}
		}
		return [...new Set(targets.filter(Boolean))];
	}
	function urls() {
		return windows().flatMap((target) => {
			try {
				return [target.location.href];
			} catch {
				return [];
			}
		});
	}
	function formalExam() {
		return urls().some((url) => /\/examObject(?:[/?#]|$)|\/exam(?!-ans(?:[/?#]|$))(?:[-_/.?#]|$)/i.test(url));
	}
	function assessment() {
		const urlPattern = new RegExp(
			'/(?:exam|work|test)(?:[-_/.?#]|$)|knowledge/cards|/learn/(?:quiz|examObject)|' +
				'/study/spoc(?:test|keepTest|jobTest)',
			'i'
		);
		return (
			urls().some((url) => urlPattern.test(url)) ||
			!!document.querySelector('.questionLi,.TiMu,.testTit_status,.examPaper_subject,.ans-videoquiz,.popup-test')
		);
	}
	function visible(element: ElementLike) {
		try {
			for (let node: HTMLElement | null = element; node; node = node.parentElement) {
				const style = node.ownerDocument.defaultView?.getComputedStyle(node);
				if (node.hidden || style?.display === 'none' || ['hidden', 'collapse'].includes(style?.visibility || ''))
					return false;
			}
			return true;
		} catch {
			return false;
		}
	}
	function selected(element: ElementLike | undefined): boolean {
		if (!element) return false;
		const selectedClass = new RegExp(
			'(?:^|\\s)(?:checked|selected|check_answer|check_answer_dx|checkbox_on|bg-mainBg|' +
				'is-checked|is-selected|ivu-radio-checked|ivu-checkbox-checked)(?:\\s|$)'
		);
		let node: ElementLike | null = element;
		for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
			if (
				depth > 0 &&
				(node.querySelectorAll('.answer_p').length > 1 ||
					node.querySelectorAll('.option').length > 1 ||
					node.querySelectorAll('.num_option,.num_option_dx').length > 1 ||
					node.querySelectorAll('input[type=radio],input[type=checkbox]').length > 1)
			)
				break;
			if (node.matches('input[type=radio],input[type=checkbox]') && node.checked === true) return true;
			if (node.getAttribute('aria-checked') === 'true' || node.getAttribute('aria-selected') === 'true') return true;
			if (selectedClass.test(String(node.className))) return true;
			if (
				Array.from(node.querySelectorAll<HTMLInputElement>('input[type=radio],input[type=checkbox]')).some(
					(field) => field.checked
				)
			)
				return true;
			if (node.querySelector('[class*=check_answer],.checkbox_on,[aria-checked=true]')) return true;
		}
		return false;
	}
	function fields(root: HTMLElement): ElementLike[] {
		return Array.from(
			root.querySelectorAll<ElementLike>(
				'textarea,input[type=text],input[type=number],input:not([type]),[contenteditable=true]'
			)
		).filter(
			(field) =>
				!field.disabled &&
				!/^(?:answertype|selectnum|type\d*|questionid|jobid|workid)$/i.test(
					field.id || field.getAttribute('name') || ''
				)
		);
	}
	function fieldValue(field: ElementLike) {
		return clean('value' in field ? field.value : field.textContent)
			.replace(/<[^>]*>/g, '')
			.replace(/&nbsp;/g, '')
			.trim();
	}
	function questionAnswered(root: HTMLElement): boolean {
		if (!root?.querySelectorAll || retryRoots.has(root)) return false;
		const textFields = fields(root);
		if (textFields.length) return textFields.every((field) => !!fieldValue(field));
		const type = root.querySelector<HTMLInputElement>('input[id^=answertype],input[name^=type]')?.value;
		const multiple = type === '1' || !!root.querySelector('input[type=checkbox],[role=checkbox],.num_option_dx');
		const expected =
			Number(root.querySelector<HTMLInputElement>('input[id^=selectNum],input[name^=selectNum]')?.value) ||
			(multiple ? 2 : 1);
		const checked = Array.from(
			root.querySelectorAll<HTMLInputElement>('input[type=radio],input[type=checkbox]')
		).filter((field) => field.checked).length;
		if (checked >= expected) return true;
		const choices = Array.from(
			root.querySelectorAll<ElementLike>(
				'.answer_p,.answerBg .answer_p,.num_option,.num_option_dx,.option,label[role=radio],label[role=checkbox]'
			)
		);
		if (choices.length && choices.filter((option) => selected(option)).length >= expected) return true;
		const lineInputs = Array.from(root.querySelectorAll<HTMLInputElement>('.line_answer input[name^=answer]'));
		return lineInputs.length > 0 && lineInputs.every((field) => !!field.value.trim());
	}
	function imageSources(env: any): string[] {
		const sources = new Set<string>();
		const mapped = new Map<string, string>();
		const documentUrl = new URL(location.href);
		documentUrl.hash = '';
		const normalize = (value: unknown): string | undefined => {
			if (typeof value !== 'string' || !value.trim() || value.trim().startsWith('#')) return undefined;
			try {
				const url = new URL(value.trim(), location.href);
				if (!/^(?:https?:|data:|blob:)$/.test(url.protocol)) return undefined;
				url.hash = '';
				if (url.protocol === 'http:' || url.protocol === 'https:') {
					if (url.href === documentUrl.href) return undefined;
				}
				return url.href;
			} catch {
				return undefined;
			}
		};
		if (Array.isArray(env.ocs_image_sources) && Array.isArray(env.images)) {
			env.ocs_image_sources.forEach((source: unknown, index: number) => {
				const from = normalize(source);
				const to = normalize(env.images[index]);
				if (from && to) mapped.set(from, to);
			});
		}
		const add = (value: unknown) => {
			const url = normalize(value);
			if (url) sources.add(mapped.get(url) || url);
		};
		for (const value of [
			...(Array.isArray(env.images) ? env.images : []),
			...(Array.isArray(env.ocs_image_sources) ? env.ocs_image_sources : []),
			...(Array.isArray(env.ocs_required_images) ? env.ocs_required_images : [])
		]) {
			if (typeof value === 'string') add(value);
		}
		for (const value of [env.title, env.options]) {
			const text = String(value || '');
			for (const match of text.matchAll(/(?:src\s*=\s*["']|\[image:\s*)([^"'\]\s>]+)/gi)) add(match[1]);
			for (const match of text.matchAll(/https?:\/\/[^\s"'<>]+|data:image\/[^\s"'<>]+/gi)) {
				const candidate = match[0].replace(/[),.;]+$/, '');
				if (
					/^data:image\//i.test(candidate) ||
					/\.(?:png|jpe?g|gif|webp|bmp|svg|avif)(?:[?#]|$)/i.test(candidate) ||
					/(?:image|img|picture|photo|upload|attachment|resource|formula|equation)/i.test(candidate)
				)
					add(candidate);
			}
		}
		const title = clean(env.title);
		const root = Array.from(
			document.querySelectorAll<HTMLElement>('.questionLi,.TiMu,.subject,.question,[class*=questionBody]')
		).find((element) => title && clean(element.textContent).includes(title));
		// OCS 5 supplies the exact images extracted from the stem and options,
		// including an empty list for text-only questions. Scanning its whole
		// container adds unrelated countdown/status icons to every request.
		const content = root?.querySelectorAll<HTMLElement>(
			'.mark_name,.Zy_TItle,.question-title,.question-stem,.stem,.title,.subject_describe,.answer_p,.option,.textDIV,.eidtDiv,.line_wid_half'
		);
		const domImages = content?.length
			? Array.from(content).flatMap((element) => Array.from(element.querySelectorAll<HTMLImageElement>('img')))
			: Array.isArray(env.ocs_required_images)
			? []
			: Array.from(root?.querySelectorAll<HTMLImageElement>('img') || []);
		domImages.forEach((image) => {
			// HTMLImageElement.src resolves an empty attribute to this document. Inspect explicit attributes instead.
			const source = [
				image.currentSrc,
				image.getAttribute('src'),
				image.getAttribute('data-src'),
				image.getAttribute('data-original')
			]
				.map(normalize)
				.find(Boolean);
			if (source) add(source);
		});
		return [...sources];
	}
	async function blobHeader(blob: Blob): Promise<Uint8Array> {
		const header = blob.slice(0, 32);
		const buffer =
			typeof header.arrayBuffer === 'function'
				? await header.arrayBuffer()
				: await new Promise<ArrayBuffer>((resolve, reject) => {
						const reader = new FileReader();
						reader.onload = () => resolve(reader.result as ArrayBuffer);
						reader.onerror = () => reject(new Error('图片数据读取失败'));
						reader.readAsArrayBuffer(header);
				  });
		return new Uint8Array(buffer);
	}
	function imageMime(bytes: Uint8Array): string | undefined {
		const text = (start: number, length: number) => String.fromCharCode(...bytes.slice(start, start + length));
		if (
			bytes.length >= 24 &&
			[137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value) &&
			text(12, 4) === 'IHDR' &&
			new DataView(bytes.buffer).getUint32(16) > 0 &&
			new DataView(bytes.buffer).getUint32(20) > 0
		)
			return 'image/png';
		if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
		if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(text(0, 6))) return 'image/gif';
		if (
			bytes.length >= 16 &&
			text(0, 4) === 'RIFF' &&
			text(8, 4) === 'WEBP' &&
			['VP8 ', 'VP8L', 'VP8X'].includes(text(12, 4))
		)
			return 'image/webp';
		return undefined;
	}
	async function imageBlobData(blob: Blob): Promise<string> {
		const mime = imageMime(await blobHeader(blob));
		if (!mime) {
			const declared = String(blob.type || '').split(';')[0];
			const label = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(declared) ? declared : '未知 MIME';
			throw new Error(`图片来源返回了网页/非图片响应（${label}）`);
		}
		const image = new Blob([blob], { type: mime });
		return new Promise<string>((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result));
			reader.onerror = () => reject(new Error('图片转换失败'));
			reader.readAsDataURL(image);
		});
	}
	function dataUrlBlob(source: string): Blob {
		try {
			const comma = source.indexOf(',');
			if (comma < 0) throw new Error('missing payload');
			const metadata = source.slice(5, comma);
			const payload = decodeURIComponent(source.slice(comma + 1));
			const binary = /(?:^|;)base64$/i.test(metadata) ? atob(payload) : payload;
			const bytes = Uint8Array.from(binary, (value) => value.charCodeAt(0));
			return new Blob([bytes], { type: metadata.split(';')[0] });
		} catch {
			throw new Error('图片数据格式无效');
		}
	}
	async function imageData(source: string): Promise<string> {
		if (source.startsWith('data:')) return imageBlobData(dataUrlBlob(source));
		const abort = new AbortController();
		const timeout = setTimeout(() => abort.abort(), 12000);
		try {
			try {
				const response = await fetch(source, { credentials: 'include', signal: abort.signal });
				if (!response.ok) throw new Error(`图片读取失败 (${response.status})`);
				return await imageBlobData(await response.blob());
			} catch (error) {
				const gmRequest = (globalThis as any).GM_xmlhttpRequest;
				if (typeof gmRequest !== 'function') throw error;
				const blob = await new Promise<Blob>((resolve, reject) =>
					gmRequest({
						method: 'GET',
						url: source,
						responseType: 'blob',
						timeout: 12000,
						onload: (response: any) =>
							response.status >= 200 && response.status < 300
								? resolve(response.response)
								: reject(new Error(`图片读取失败 (${response.status})`)),
						onerror: () => reject(new Error('图片读取失败')),
						ontimeout: () => reject(new Error('图片读取超时'))
					})
				);
				return await imageBlobData(blob);
			}
		} finally {
			clearTimeout(timeout);
		}
	}
	function hasSecretFont(root: HTMLElement) {
		return (
			!!root.closest('.font-cxsecret') ||
			!!root.querySelector('.font-cxsecret') ||
			/font-cxsecret/i.test(root.ownerDocument.defaultView?.getComputedStyle(root).fontFamily || '')
		);
	}
	async function visualQuestion(env: any, context?: Context): Promise<QuestionInput | undefined> {
		const root =
			context?.root ||
			Array.from(document.querySelectorAll<HTMLElement>('.questionLi,.TiMu,.subject,.question')).find(
				(element) => clean(env.title) && clean(element.textContent).includes(clean(env.title))
			);
		if (!root || !hasSecretFont(root)) return undefined;
		const input: QuestionInput = {
			question: '自定义字体题目（按原始题图识别）',
			options: [],
			type: String(context?.type || env.type || 'unknown'),
			contentMode: 'visual',
			sourceUrl: location.href,
			assessment: assessment(),
			formalExam: formalExam(),
			images: [],
			imageErrors: [],
			imageLabels: []
		};
		try {
			if (!context?.elements?.title?.length) throw new Error('无法精确定位原始题干，请重新打开题目页面');
			const mark = (element: HTMLElement) => {
				let id = element.getAttribute('data-ocs-ai-capture');
				if (!id || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) {
					id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
					element.setAttribute('data-ocs-ai-capture', id);
				}
				return id;
			};
			const isControl = (element: HTMLElement) => {
				const hint = String(element.className) + ' ' + element.id;
				return (
					/timer|countdown|remain.?time|time.?limit/i.test(hint) &&
					/^[\s\d:：时分秒倒计剩余]*$/.test(clean(element.textContent))
				);
			};
			const titles = [...new Set(context.elements.title)].filter(
				(element) =>
					element &&
					element !== root &&
					element.isConnected &&
					root.contains(element) &&
					visible(element) &&
					!isControl(element)
			);
			const stems = titles.filter((element) => !titles.some((other) => other !== element && other.contains(element)));
			const options = (context.elements.options || []).filter(Boolean);
			if (!stems.length || (!options.length && ['single', 'multiple', 'judgement'].includes(input.type || ''))) {
				throw new Error('题干或选项截图区域缺失，已停止猜测文字');
			}
			input.options = options.map(
				(_option, index) => `选项 ${index < 26 ? String.fromCharCode(65 + index) : index + 1}（见图片）`
			);
			const parts = [
				...stems.map((element, index) => ({
					id: mark(element),
					role: 'stem',
					label: `题干 ${index + 1}`,
					text: element.textContent || ''
				})),
				...options.map((element, index) => ({
					id: mark(element),
					role: 'option',
					text: element.textContent || '',
					label: `选项 ${index < 26 ? String.fromCharCode(65 + index) : index + 1}`
				}))
			];
			const capture = await send('capture', { rootId: mark(root), parts });
			if (!Array.isArray(capture?.images) || capture.images.length !== parts.length)
				throw new Error('原始字形截图不完整');
			input.images = capture.images;
			input.imageLabels = capture.imageLabels;
		} catch (error) {
			input.imageErrors = ['原始字形截图失败：' + String(error)];
		}
		return input;
	}
	async function begin(env: any, context?: Context): Promise<Session> {
		const visual = await visualQuestion(env, context);
		if (visual) {
			for (const previous of sessions.values()) if (previous.root === context?.root) previous.superseded = true;
			const created = await send('begin', visual);
			visual.images = undefined;
			const session: Session = { ...created, input: visual, root: context?.root };
			if (session.taskId) sessions.set(session.taskId, session);
			return session;
		}
		const sources = imageSources(env);
		const images: string[] = new Array(sources.length);
		const errors: Array<string | undefined> = new Array(sources.length);
		let next = 0;
		await Promise.all(
			Array.from({ length: Math.min(4, sources.length) }, async () => {
				while (next < sources.length) {
					const index = next++;
					try {
						images[index] = await imageData(sources[index]);
					} catch (error) {
						errors[index] = String(error);
						images[index] = sources[index];
					}
				}
			})
		);
		const imageErrors = errors.filter((error): error is string => typeof error === 'string');
		const input: QuestionInput = {
			question: String(env.title || '').trim(),
			options: Array.isArray(env.ocs_options)
				? env.ocs_options.map(String)
				: Array.isArray(env.options)
				? env.options.map(String)
				: String(env.options || '')
						.split('\n')
						.map((value) => value.trim())
						.filter(Boolean),
			type: String(env.type || 'unknown'),
			sourceUrl: location.href,
			assessment: assessment(),
			formalExam: formalExam(),
			images,
			imageErrors
		};
		for (const previous of sessions.values()) {
			if (
				previous.input.question === input.question &&
				previous.input.type === input.type &&
				JSON.stringify(previous.input.options) === JSON.stringify(input.options)
			)
				previous.superseded = true;
		}
		const created = await send('begin', input);
		// Image bytes are owned by the main-process task after begin; do not retain a duplicate per page attempt.
		input.images = undefined;
		const session: Session = { ...created, input };
		if (session.taskId) sessions.set(session.taskId, session);
		return session;
	}
	function searchInfo(session: Session) {
		const decision = session.decision!;
		return [
			{
				name: '智能搜题',
				homepage: '',
				url: '',
				response: decision,
				results: decision.answer?.length
					? [
							{
								question: session.input.question,
								answer: decision.answer.join('#'),
								extra_data: { taskId: session.taskId }
							}
					  ]
					: [],
				data: { ocsAISkip: !decision.answer?.length },
				error: decision.error
			}
		];
	}
	async function finish(session: Session, bankInfos: any[]) {
		if (!session.enabled) return bankInfos;
		session.decision = await send('complete', {
			taskId: session.taskId,
			bankInfos: session.input.contentMode === 'visual' ? [] : bankInfos
		});
		return searchInfo(session);
	}
	function rootActive(root: HTMLElement) {
		try {
			return root.isConnected && root.ownerDocument.defaultView?.document === root.ownerDocument;
		} catch {
			return false;
		}
	}
	function activeSession(session: Session) {
		return !session.superseded && (!session.root || rootActive(session.root));
	}
	function isBlocked() {
		// A failed attempt blocks retries for that question set, not later
		// chapters after the user submitted manually and the old frame was replaced.
		if (failedSubmissionRoots?.length && !failedSubmissionRoots.some(rootActive)) failedSubmissionRoots = undefined;
		return (
			!connected() ||
			formalExam() ||
			!!failedSubmissionRoots ||
			[...sessions.values()].some(
				(session) => activeSession(session) && session.input.assessment && session.decision?.submissionBlocked !== false
			)
		);
	}
	function optionIndex(answer: string, options: ElementLike[], toText: OptionText) {
		const value = clean(answer);
		if (/^[A-Z]$/i.test(value)) return value.toUpperCase().charCodeAt(0) - 65;
		if (/^\d+$/.test(value)) return Number(value) - 1;
		const matches = options
			.map((option, index) => ({ index, text: clean(toText(option, index)).replace(/^[A-Z][.、:：)\s]+/i, '') }))
			.filter((item) => item.text === value);
		return matches.length === 1 ? matches[0].index : -1;
	}
	function booleanValue(value: string): boolean | undefined {
		const text = clean(value).toLowerCase();
		if (/^(?:true|yes|正确|对|是|√|✓|1)$/.test(text)) return true;
		if (/^(?:false|no|错误|错|否|×|✕|0)$/.test(text)) return false;
		return undefined;
	}
	async function waitForSelection(option: ElementLike, expected = true) {
		const deadline = Date.now() + 1500;
		do {
			if (!connected() || !option.isConnected) return false;
			if (selected(option) === expected) return true;
			await sleep(50);
		} while (Date.now() < deadline);
		return selected(option) === expected;
	}
	async function ensureText(option: ElementLike, answer: string) {
		const candidates = fields(option);
		if (option.matches('textarea,input,[contenteditable=true]')) candidates.unshift(option);
		for (const field of candidates) {
			if ('value' in field) {
				const proto = field.ownerDocument.defaultView?.HTMLTextAreaElement.prototype;
				const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value')?.set;
				if (field.tagName === 'TEXTAREA' && setter) setter.call(field, answer);
				else field.value = answer;
			} else field.textContent = answer;
			const EventClass = field.ownerDocument.defaultView?.Event || Event;
			field.dispatchEvent(new EventClass('input', { bubbles: true }));
			field.dispatchEvent(new EventClass('change', { bubbles: true }));
		}
		for (const frame of Array.from(option.querySelectorAll<HTMLIFrameElement>('iframe'))) {
			try {
				if (frame.contentDocument?.body) frame.contentDocument.body.textContent = answer;
			} catch {}
		}
		return (
			candidates.some((field) => fieldValue(field) === clean(answer)) ||
			Array.from(option.querySelectorAll<HTMLIFrameElement>('iframe')).some((frame) => {
				try {
					return clean(frame.contentDocument?.body.textContent) === clean(answer);
				} catch {
					return false;
				}
			})
		);
	}
	async function apply(
		session: Session,
		ctx: Context,
		type: string,
		options: ElementLike[],
		handler: any,
		toText: OptionText
	) {
		if (!connected() || !ctx.root.isConnected || session.superseded) return { finish: false };
		const latest: QuestionDecision = await send('decision', { taskId: session.taskId });
		session.decision = latest;
		if (!latest.answer?.length || !['agree', 'manual'].includes(latest.status)) return { finish: false };
		const answers = latest.answer;
		await status(session, 'filling');
		try {
			if (type === 'completion' || type === 'fill-blank') {
				if (answers.length !== options.length) throw new Error('填空答案数量与页面空位不一致');
				for (let index = 0; index < options.length; index++) {
					if (!connected()) return { finish: false };
					await handler('completion', answers[index], options[index], ctx);
					if (!(await ensureText(options[index], answers[index]))) throw new Error('页面未确认填空已写入');
				}
				session.verify = () =>
					options.every((option, index) => {
						const candidates = fields(option);
						if (option.matches('textarea,input,[contenteditable=true]')) candidates.unshift(option);
						return (
							candidates.some((field) => fieldValue(field) === clean(answers[index])) ||
							Array.from(option.querySelectorAll<HTMLIFrameElement>('iframe')).some((frame) => {
								try {
									return clean(frame.contentDocument?.body.textContent) === clean(answers[index]);
								} catch {
									return false;
								}
							})
						);
					});
			} else {
				let indices = answers.map((answer) => optionIndex(answer, options, toText));
				if (type === 'judgement' && indices.some((index) => index < 0 || index >= options.length)) {
					const value = booleanValue(answers[0]);
					indices = [
						value === undefined
							? -1
							: options.findIndex((option, index) => booleanValue(clean(toText(option, index))) === value)
					];
				}
				indices = [...new Set(indices)];
				if (
					indices.some((index) => index < 0 || index >= options.length) ||
					(type !== 'multiple' && indices.length !== 1)
				) {
					throw new Error('答案无法唯一映射到当前页面选项');
				}
				if (type === 'multiple') {
					for (let index = 0; index < options.length; index++) {
						if (!indices.includes(index) && selected(options[index])) options[index].click();
					}
					await sleep(100);
				}
				for (const index of indices) {
					if (!connected()) return { finish: false };
					if (!selected(options[index])) await handler(type, toText(options[index], index), options[index], ctx);
					if (!(await waitForSelection(options[index]))) {
						options[index].click();
						if (!(await waitForSelection(options[index]))) throw new Error('页面未确认选项已选中');
					}
				}
				if (type === 'multiple' && options.some((option, index) => selected(option) !== indices.includes(index))) {
					throw new Error('多选题仍存在未清除的多余选项');
				}
				session.verify = () => options.every((option, index) => selected(option) === indices.includes(index));
			}
			retryRoots.delete(ctx.root);
			session.lastApplied = JSON.stringify(answers);
			await status(session, 'ready');
			return { finish: true, answers, aiVerified: true };
		} catch (error) {
			await status(session, 'error', String(error));
			return { finish: false, error: String(error) };
		}
	}
	function watchManual(session: Session) {
		if (session.watching) return;
		session.watching = true;
		(async () => {
			const deadline = Date.now() + 60 * 60 * 1000;
			while (connected() && !session.superseded && session.root?.isConnected && Date.now() < deadline) {
				await sleep(1500);
				try {
					const decision: QuestionDecision = await send('decision', { taskId: session.taskId });
					session.decision = decision;
					if (
						decision.status !== 'manual' ||
						!decision.answer?.length ||
						!session.apply ||
						JSON.stringify(decision.answer) === session.lastApplied
					)
						continue;
					const result = await session.apply();
					const tracked = session.tracked;
					if (tracked) {
						tracked.result.result = result;
						tracked.result.error = result.error;
						tracked.result.resolved = true;
						await tracked.worker.opts.onResultsUpdate?.(tracked.result, tracked.index, tracked.results);
						if (tracked.results.every(resultFinished)) await continuations.get(tracked.worker)?.();
					}
				} catch {
					return;
				}
			}
		})().catch(() => {});
	}
	function resolver(ctx: Context, optionText?: OptionText) {
		const taskId = ctx.searchInfos?.find((info) => info?.response?.taskId)?.response.taskId;
		const session = sessions.get(taskId);
		if (!session) return undefined;
		const previous = rootSessions.get(ctx.root);
		if (previous && previous !== session) previous.superseded = true;
		rootSessions.set(ctx.root, session);
		session.root = ctx.root;
		const toText: OptionText = optionText || ((option) => clean(option.textContent));
		return Object.fromEntries(
			['single', 'multiple', 'judgement', 'completion', 'fill-blank'].map((type) => [
				type,
				async (_infos: any[], options: ElementLike[], handler: any) => {
					session.apply = () => apply(session, ctx, type, options, handler, toText);
					watchManual(session);
					if (session.decision?.status === 'pending') return { finish: false };
					return session.apply();
				}
			])
		);
	}
	function trackResult(result: WorkResult, worker: WorkerLike, index: number, results: WorkResult[]) {
		const session = rootSessions.get(result.ctx.root);
		if (session) session.tracked = { result, worker, index, results };
	}
	function resultFinished(result: WorkResult) {
		if (result.result?.finish !== true) return false;
		return result.result.aiVerified === true
			? rootSessions.get(result.ctx.root)?.verify?.() === true
			: questionAnswered(result.ctx.root);
	}
	function skipRandom(result: WorkResult) {
		return result.ctx.searchInfos?.some((info) => info?.data?.ocsAISkip || info?.response?.taskId) === true;
	}
	async function retry(worker: WorkerLike, initial: WorkResult[], maxAttempts = 2) {
		let results = initial;
		if (!Array.isArray(results) || !assessment() || formalExam()) return results;
		for (let attempt = 0; attempt < Math.min(maxAttempts, 2); attempt++) {
			if (!connected() || worker.isClose) break;
			const pending = results.filter((item) => !resultFinished(item));
			if (!pending.length) break;
			const roots = pending.map((item) => item.ctx.root).filter((root) => root.isConnected);
			if (!roots.length) break;
			for (const root of roots) {
				retryRoots.add(root);
				const session = rootSessions.get(root);
				if (session) await status(session, 'retrying');
			}
			const previous = { root: worker.opts.root, thread: worker.opts.thread, total: worker.totalQuestionCount };
			try {
				worker.opts.root = roots;
				worker.opts.thread = 1;
				const fresh = await worker.doWork();
				const byRoot = new Map(fresh.map((item) => [item.ctx.root, item]));
				results = results.map((item) => byRoot.get(item.ctx.root) || item);
			} finally {
				worker.opts.root = previous.root;
				worker.opts.thread = previous.thread;
				worker.totalQuestionCount = previous.total;
			}
		}
		for (let index = 0; index < results.length; index++) trackResult(results[index], worker, index, results);
		return results;
	}
	function documents(targets: any[]): Document[] {
		return [
			...new Set(
				targets.flatMap((target) => {
					try {
						return target.document ? [target.document as Document] : [];
					} catch {
						return [];
					}
				})
			)
		];
	}
	function finalSubmissionUrl(url: string, body?: any) {
		try {
			const parsed = new URL(url, location.href);
			const temporary = /\/work\/validate|submitvalidate|submitchecktimes/i;
			const draft = /[?&](?:tempsave|draft|autosave)=1|[?&]savestatus=0/i;
			// These flags may be in jQuery's data, a form body, or the URL. A
			// successful autosave must not stop us from clicking final confirmation.
			const draftBody =
				typeof body === 'string'
					? draft.test('?' + body)
					: body &&
					  [
							['tempsave', '1'],
							['draft', '1'],
							['autosave', '1'],
							['savestatus', '0']
					  ].some(([key, value]) => String(typeof body.get === 'function' ? body.get(key) : body[key]) === value);
			return (
				/(?:^|\/)(?:addstudentwork\w*|submit\w*|submission\w*|finish|complete|workhandle)(?:\/|$)/i.test(
					parsed.pathname
				) &&
				!temporary.test(parsed.href) &&
				!draft.test(parsed.href) &&
				!draftBody
			);
		} catch {
			return false;
		}
	}
	function submissionResponse(body: unknown, httpStatus = 200): { ok?: boolean; reason?: string } {
		if (httpStatus < 200 || httpStatus >= 300) return { ok: false, reason: `提交请求失败 (${httpStatus})` };
		let value: any = body;
		if (typeof value === 'string') {
			try {
				value = JSON.parse(value);
			} catch {
				return {};
			}
		}
		if (value?.data && value.status === undefined) value = value.data;
		if ([true, 1, '1', 'true', 'success', 'ok'].includes(value?.status))
			return { ok: true, reason: '服务器已确认提交' };
		if ([false, 0, '0', 'false', 'error', 'fail'].includes(value?.status))
			return { ok: false, reason: String(value.msg || value.message || '服务器拒绝提交') };
		return {};
	}
	function observeSubmission(
		targets: any[],
		report: (result: { ok?: boolean; reason?: string; requestStarted?: boolean; responseObserved?: boolean }) => void
	) {
		const restores: Array<() => void> = [];
		const prototypes = new Set<any>();
		const jquery = new Set<any>();
		const received = (body: unknown, status = 200) =>
			report({ ...submissionResponse(body, status), responseObserved: true });
		const xhrBody = (xhr: any) => {
			try {
				return xhr.responseType === 'json' ? xhr.response : xhr.responseText;
			} catch {
				return undefined;
			}
		};
		for (const target of targets) {
			try {
				// Chaoxing's validation/submit flow uses jQuery callbacks. Observe
				// success before the native handler navigates or tears down its frame.
				const jq = target.jQuery || target.$;
				if (typeof jq?.ajax === 'function' && !jquery.has(jq)) {
					jquery.add(jq);
					const original = jq.ajax;
					const invoke = (callback: any, context: any, args: any[]) => {
						for (const fn of Array.isArray(callback) ? callback : [callback])
							if (typeof fn === 'function') fn.apply(context, args);
					};
					const ajax = function (this: any, options: any, ...rest: any[]) {
						const settings = typeof options === 'string' ? { ...rest[0], url: options } : { ...options };
						if (!finalSubmissionUrl(String(settings.url || ''), settings.data))
							return original.call(this, options, ...rest);
						report({ requestStarted: true });
						const { success, error, complete } = settings;
						settings.success = function (this: any, data: unknown, ...args: any[]) {
							received(data, args[1]?.status ?? 200);
							invoke(success, this, [data, ...args]);
						};
						settings.error = function (this: any, ...args: any[]) {
							report({ ok: false, reason: '提交网络请求失败', responseObserved: true });
							invoke(error, this, args);
						};
						settings.complete = function (this: any, xhr: any, ...args: any[]) {
							if (xhr) received(xhrBody(xhr), xhr.status);
							invoke(complete, this, [xhr, ...args]);
						};
						return original.call(this, settings);
					};
					jq.ajax = ajax;
					restores.push(() => {
						if (jq.ajax === ajax) jq.ajax = original;
					});
				}
				const prototype = target.XMLHttpRequest?.prototype;
				if (prototype && !prototypes.has(prototype)) {
					prototypes.add(prototype);
					const originalOpen = prototype.open;
					const originalSend = prototype.send;
					const requests = new WeakMap<any, string>();
					const open = function (this: any, method: string, url: string, ...args: any[]) {
						requests.set(this, String(url));
						return originalOpen.call(this, method, url, ...args);
					};
					const sendRequest = function (this: any, ...args: any[]) {
						if (finalSubmissionUrl(requests.get(this) || '', args[0])) {
							report({ requestStarted: true });
							this.addEventListener('load', () => received(xhrBody(this), this.status));
							for (const event of ['error', 'timeout', 'abort'])
								this.addEventListener(event, () =>
									report({ ok: false, reason: '提交网络请求失败', responseObserved: true })
								);
						}
						return originalSend.apply(this, args);
					};
					prototype.open = open;
					prototype.send = sendRequest;
					restores.push(() => {
						if (prototype.open === open) prototype.open = originalOpen;
						if (prototype.send === sendRequest) prototype.send = originalSend;
					});
				}
				if (typeof target.fetch === 'function') {
					const original = target.fetch;
					const fetchRequest = async function (this: any, input: any, init: any) {
						const final = finalSubmissionUrl(typeof input === 'string' ? input : input.url, init?.body);
						if (final) report({ requestStarted: true });
						try {
							const response = await original.call(this, input, init);
							if (final) received(await response.clone().text(), response.status);
							return response;
						} catch (error) {
							if (final) report({ ok: false, reason: '提交网络请求失败', responseObserved: true });
							throw error;
						}
					};
					target.fetch = fetchRequest;
					restores.push(() => {
						if (target.fetch === fetchRequest) target.fetch = original;
					});
				}
			} catch {}
		}
		return () => restores.reverse().forEach((restore) => restore());
	}
	function startSubmit(targets: any[], docs: Document[]) {
		for (const target of targets) {
			for (const name of ['btnBlueSubmit', 'submitValidate', 'form1submit', 'confirmSubmitWork']) {
				try {
					if (typeof target[name] === 'function') {
						target[name]();
						return true;
					}
				} catch {}
			}
		}
		for (const doc of docs) {
			const button = Array.from(
				doc.querySelectorAll<ElementLike>(
					'a[onclick*=submitValidate],#submitWork,.submitWork,.submit-work,.j-submit,.completeBtn,button[type=submit]'
				)
			).find(
				(element) =>
					visible(element) &&
					!element.disabled &&
					/提交|交卷|完成作业|submit/i.test(element.textContent || element.getAttribute('onclick') || '')
			);
			if (button) {
				button.click();
				return true;
			}
		}
		return false;
	}
	function confirmSubmit(docs: Document[], clicked: WeakSet<object>) {
		let count = 0;
		for (const doc of docs) {
			for (const dialog of Array.from(
				doc.querySelectorAll<HTMLElement>(
					'#workpop,#submitConfirmPop,.el-message-box,.layui-layer-dialog,[role=dialog],.modal-dialog'
				)
			)) {
				if (!visible(dialog) || !/提交|交卷|submit|submission/i.test(dialog.textContent || '')) continue;
				// #popok may be a span. Its handler is installed by the asynchronous
				// validation callback and closes over the correct question frame.
				const button = Array.from(
					dialog.querySelectorAll<ElementLike>(
						'#popok,.bluebtn,[data-action=confirm],.layui-layer-btn0,button,a,input[type=button],[role=button]'
					)
				).find((element) => {
					const label = clean(element.textContent || element.value);
					return (
						!clicked.has(element) &&
						!element.disabled &&
						element.getAttribute('aria-disabled') !== 'true' &&
						visible(element) &&
						!/取消|返回|关闭|cancel|back|close/i.test(label) &&
						(element.id === 'popok' ||
							/^(?:确定|确认|提交|确认提交|确定提交|交卷|submit|ok|confirm|confirm\s+(?:submit|submission))$/i.test(
								label
							))
					);
				});
				if (button) {
					clicked.add(button);
					button.click();
					count++;
					break;
				}
			}
		}
		return count;
	}
	async function submit(
		extra: any[] = [],
		starter?: () => Promise<boolean | { ok: boolean; reason: string }> | boolean,
		timeoutMs = 25000
	) {
		if (isBlocked()) return { ok: false, reason: '存在未完成题目或当前是正式考试，未自动提交' };
		const targets = windows(extra);
		const docs = documents(targets);
		const before = targets.map((target) => {
			try {
				return target.location.href;
			} catch {
				return '';
			}
		});
		let result: { ok?: boolean; reason?: string } = {};
		let requestStarted = false;
		let responseObserved = false;
		let confirmations = 0;
		const restore = observeSubmission(targets, (next) => {
			requestStarted ||= next.requestStarted === true;
			responseObserved ||= next.responseObserved === true;
			if (next.ok !== undefined) result = next;
		});
		const clicked = new WeakSet<object>();
		try {
			const started = await (starter ? starter() : startSubmit(targets, docs));
			// The Chaoxing callback performs its own confirmed submit. Reuse that
			// result instead of starting a second wait after the response has gone.
			if (typeof started === 'object' && typeof started.ok === 'boolean') return started;
			if (!started) result = { ok: false, reason: '未找到提交入口' };
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				if (!started || disposed) break;
				if (result.ok !== undefined) break;
				if (!requestStarted) confirmations += confirmSubmit(docs, clicked);
				if (result.ok !== undefined) break;
				const finalPage = targets.some((target, index) => {
					try {
						return (
							target.location.href !== before[index] &&
							/\/(?:work|exam)\/(?:result|finish|view)|[?&](?:submitted|finished)=true/i.test(target.location.href)
						);
					} catch {
						return false;
					}
				});
				if (finalPage) {
					result = { ok: true, reason: '已进入提交结果页' };
					break;
				}
				await sleep(150);
			}
			if (result.ok !== true) {
				failedSubmissionRoots = [...sessions.values()]
					.filter(activeSession)
					.flatMap((session) => (session.root ? [session.root] : []));
				result.reason ||= responseObserved
					? '已收到提交响应，但服务器未明确确认成功'
					: requestStarted
					? '最终提交请求超时，未收到服务器响应'
					: confirmations
					? '已点击提交确认，但未发出最终提交请求'
					: '提交校验未完成或确认窗口未出现，未发出最终提交请求';
			}
			for (const session of sessions.values()) {
				if (activeSession(session) && session.input.assessment)
					await status(
						session,
						result.ok ? 'submitted' : 'error',
						result.ok ? undefined : result.reason || '提交未获服务器确认'
					);
			}
			return { ok: result.ok === true, reason: result.reason || '提交请求超时或服务器未确认成功' };
		} finally {
			restore();
		}
	}
	async function upload(worker: WorkerLike, options: any) {
		if (options.type === 'nomove') return;
		const results = await retry(worker, options.results);
		let submitted = false;
		const continueUpload = async () => {
			if (!connected() || worker.isClose || submitted) return;
			const finished = results.filter(resultFinished).length;
			const rate = results.length ? (finished / results.length) * 100 : 0;
			const allow = results.length > 0 && finished === results.length && !isBlocked();
			if (allow) {
				submitted = true;
				return submit([], async () => {
					const result = await options.callback(rate, true);
					return result && typeof result.ok === 'boolean' ? result : true;
				});
			}
			return options.callback(rate, false);
		};
		continuations.set(worker, continueUpload);
		return continueUpload();
	}
	async function assignment(worker: WorkerLike, initial: WorkResult[], type: string) {
		const results = await retry(worker, initial);
		let submitted = false;
		const continueAssignment = async () => {
			if (
				type !== 'work' ||
				worker.isClose ||
				submitted ||
				!results.length ||
				!results.every(resultFinished) ||
				isBlocked()
			)
				return;
			submitted = true;
			const result = await submit(results.map((item) => item.ctx.root.ownerDocument.defaultView).filter(Boolean));
			if (!result.ok) console.warn('[智能搜题]', result.reason);
		};
		continuations.set(worker, continueAssignment);
		await continueAssignment();
		return results;
	}
	return {
		begin,
		finish,
		resolver,
		questionAnswered,
		trackResult,
		resultFinished,
		skipRandom,
		retry,
		isBlocked,
		submit,
		upload,
		assignment,
		finalSubmissionUrl,
		submissionResponse
	};
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
	(globalThis as any).__ocsAIRuntime = createQuestionRuntime();
}
