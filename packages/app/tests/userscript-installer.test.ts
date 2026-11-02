import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import vm from 'vm';
import { userscriptInstallerScript } from '../src/scripts/system/userscript-installer';

const require = createRequire(import.meta.url);
const browserEnv = require('browser-env');
const windows: any[] = [];
const scriptUrl = 'http://localhost:15319/api/local-userscript/ocs.user.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.useRealTimers();
	windows.splice(0).forEach((window) => window.close());
});

async function install(html: string, onClick: (window: any) => void) {
	const window = browserEnv([], { url: 'https://example.test' });
	windows.push(window);
	window.document.body.innerHTML = html;
	window.HTMLElement.prototype.scrollIntoView = () => {};
	onClick(window);
	const context = vm.createContext({ document: window.document });
	const installPage = {
		url: () => 'chrome-extension://tampermonkey/ask.html?aid=installation',
		isClosed: () => false,
		bringToFront: vi.fn(async () => {}),
		close: vi.fn(async () => {}),
		locator: (selector: string) => ({ count: async () => window.document.querySelectorAll(selector).length }),
		evaluate: async (callback: Function) => vm.runInContext(`(${callback.toString()})()`, context),
		waitForFunction: async (callback: Function, argument: string) =>
			vm.runInContext(`(${callback.toString()})(${JSON.stringify(argument)})`, context)
	};
	const trigger = { goto: vi.fn(async () => {}), close: vi.fn(async () => {}) };
	let triggered = false;
	const browser = {
		pages: () => (triggered ? [installPage] : []),
		newPage: async () => {
			triggered = true;
			return trigger;
		}
	};
	const send = vi.fn();
	const run = userscriptInstallerScript.run({
		browser,
		userscripts: [scriptUrl],
		enabledScriptCount: 1,
		step: vi.fn(async () => {}),
		send
	} as any);
	await vi.runAllTimersAsync();
	await run;
	return send.mock.calls.find(([event]) => event === 'userscript-install-result')?.[1][0];
}

describe('bundled script manager installation controls', () => {
	it.each(['Install', 'Update', 'Reinstall', '安装', '更新'])(
		'clicks Tampermonkey 5.5.1 %s in its action container',
		async (label) => {
			const cancel = vi.fn();
			const action = vi.fn();
			const result = await install(
				`<div id="div_aW5zdGFsbF9idXR0b25zX3VuZGVmaW5lZA" class="ask_action_buttons">
				<input class="button install" type="button" value="${label}">
				<input class="button install" type="button" value="Cancel">
			</div>`,
				(window) => {
					const [button, cancelButton] = window.document.querySelectorAll('input');
					button.onclick = () => {
						action();
						button.disabled = true;
					};
					cancelButton.onclick = cancel;
				}
			);
			expect(action).toHaveBeenCalledOnce();
			expect(cancel).not.toHaveBeenCalled();
			expect(result).toEqual({ url: scriptUrl, success: true, reason: undefined });
		}
	);

	it('keeps the ScriptCat install control separate from the script enable switch', async () => {
		const toggle = vi.fn();
		const result = await install(
			'<button role="switch">Enabled</button><button data-testid="install-primary">Install</button>',
			(window) => {
				window.document.querySelector('[role="switch"]').onclick = toggle;
				window.document.querySelector('[data-testid="install-primary"]').onclick = () => {
					window.document.body.insertAdjacentHTML('beforeend', '<div data-testid="install-success-ribbon"></div>');
				};
			}
		);
		expect(toggle).not.toHaveBeenCalled();
		expect(result.success).toBe(true);
	});

	it('does not click an unrelated page button', async () => {
		const clicked = vi.fn();
		const result = await install('<button>Install</button>', (window) => {
			window.document.querySelector('button').onclick = clicked;
		});
		expect(clicked).not.toHaveBeenCalled();
		expect(result).toEqual({ url: scriptUrl, success: false, reason: '未找到安装按钮' });
	});
});
