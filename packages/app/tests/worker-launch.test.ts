import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import { EventEmitter } from 'events';
import { chromium } from 'playwright-core';
import { launchBrowser, ScriptWorker } from '../src/worker';
import { installQuestionBinding } from '../src/question-browser/binding';
import { runSystemScripts } from '../src/scripts/system';

vi.mock('playwright-core', () => ({ chromium: { launchPersistentContext: vi.fn() } }));
vi.mock('../src/scripts', () => ({ AutomationScripts: [], LegacyScriptMappings: {} }));
vi.mock('../src/scripts/system', () => ({ runSystemScripts: vi.fn() }));
vi.mock('../src/question-browser/binding', () => ({ installQuestionBinding: vi.fn() }));

const options = {
	executablePath: '/browser/chrome',
	headless: false,
	args: ['--load-extension=/extensions/scriptcat'],
	userDataDir: '/profiles/course',
	userscripts: ['http://localhost:15319/api/local-userscript/ai.user.js?path=ai.user.js'],
	enabledScriptCount: 1,
	extensionPaths: ['/extensions/scriptcat'],
	startPage: 'http://localhost:15319/index.html#/bookmarks',
	automationScripts: [],
	closeableExtensionHomepages: [],
	serverPort: 15319,
	authToken: 'legacy-actions-token',
	uid: 'course'
};

beforeEach(() => {
	vi.resetAllMocks();
	vi.useFakeTimers();
	vi.stubEnv('DISPLAY', undefined);
	vi.stubEnv('WAYLAND_DISPLAY', undefined);
	vi.stubEnv('XDG_RUNTIME_DIR', '/run/test');
	vi.stubEnv('XDG_SESSION_TYPE', undefined);
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(fs, 'readdirSync').mockImplementation(
		(directory: any) => (String(directory) === '/tmp/.X11-unix' ? ['X3'] : []) as any
	);
	vi.spyOn(fs, 'statSync').mockImplementation(
		(file: any) => ({ isSocket: () => String(file) === '/tmp/.X11-unix/X3' } as any)
	);
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe('managed browser launch integration', () => {
	it('passes a recovered X11 display to Chromium without forcing Wayland', async () => {
		const stopped = new Error('stop before starting Chromium');
		vi.mocked(chromium.launchPersistentContext).mockRejectedValue(stopped);
		await expect(launchBrowser(options)).rejects.toBe(stopped);
		const [profile, launch] = vi.mocked(chromium.launchPersistentContext).mock.calls[0];
		expect(profile).toBe(options.userDataDir);
		expect(launch?.env?.DISPLAY).toBe(':3');
		expect(launch?.args).toContain('--load-extension=/extensions/scriptcat');
		expect(launch?.args).not.toContain('--ozone-platform=wayland');
	});

	it('binds the worker credential before navigation and passes the store to both system phases', async () => {
		const calls: string[] = [];
		const frame = { waitForFunction: vi.fn(async () => {}), evaluate: vi.fn(async () => {}) };
		const page = Object.assign(new EventEmitter(), {
			goto: vi.fn(async () => calls.push('navigate')),
			url: () => options.startPage,
			mainFrame: () => frame
		});
		const browser = Object.assign(new EventEmitter(), {
			pages: () => [page],
			addInitScript: vi.fn(async () => {})
		});
		const session = { port: 15319, token: 'question-worker-token', enabled: true };
		const store = { render: { scripts: [{ url: 'https://cdn/ocs.user.js', enable: true }] } } as any;
		const cleanup = vi.fn(async () => {});
		const onQuestionBinding = vi.fn();
		vi.mocked(installQuestionBinding).mockImplementation(async () => {
			calls.push('bind');
			return cleanup;
		});
		vi.mocked(runSystemScripts).mockImplementation(async (_context, phase) => {
			calls.push(phase);
		});
		vi.mocked(chromium.launchPersistentContext).mockResolvedValue(browser as any);
		await launchBrowser({
			...options,
			store,
			config: { questionService: session, download_optimization: false, script_assistance: false },
			onQuestionBinding
		});
		expect(calls).toEqual(['bind', 'navigate', 'launch', 'post']);
		expect(installQuestionBinding).toHaveBeenCalledWith(browser, options.uid, session);
		expect(onQuestionBinding).toHaveBeenCalledWith(cleanup);
		for (const [context] of vi.mocked(runSystemScripts).mock.calls) {
			expect(context.store).toBe(store);
			expect(context.userscripts).toBe(options.userscripts);
		}
	});

	it('disconnects question tasks, stops resource sampling and closes the browser on disposal', async () => {
		const worker = new ScriptWorker();
		const cleanup = vi.fn(async () => {});
		const browser = { close: vi.fn(async () => {}) };
		Object.assign(worker, {
			questionBindingCleanup: cleanup,
			memoryReportTimer: setInterval(() => {}, 10000),
			browser
		});
		await worker.dispose();
		expect(cleanup).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
		expect(browser.close).toHaveBeenCalledOnce();
		expect(worker.browser).toBeUndefined();
	});
});
