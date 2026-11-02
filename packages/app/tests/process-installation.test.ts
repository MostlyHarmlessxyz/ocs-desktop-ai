import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';
import { QUESTION_BRIDGE_VERSION } from '@ocs-desktop/common';
import { Process } from '../../web/src/utils/process';
import { remote } from '../../web/src/utils/remote';
import { store } from '../../web/src/store';
import { detectWeakNetwork } from '../../web/src/utils';
import { Message } from '@arco-design/web-vue';

vi.mock('../../web/src/utils/remote', () => ({
	remote: { methods: { call: vi.fn() }, fs: { call: vi.fn() }, path: { call: vi.fn() } }
}));
vi.mock('../../web/src/store', () => ({
	store: { server: { port: 15319 }, render: { scripts: [], setting: { browser: { forceUpdateScript: false } } } }
}));
vi.mock('vue', () => ({ reactive: (value: unknown) => value, h: vi.fn() }));
vi.mock('@arco-design/web-vue', () => ({ Message: { error: vi.fn() }, Button: {} }));
vi.mock('../../web/src/utils/node', () => ({ child_process: {}, electron: {} }));
vi.mock('../../web/src/utils/notify', () => ({ notify: vi.fn() }));
vi.mock('../../web/src/utils/statusBar', () => ({ Status: { loading: vi.fn(), clear: vi.fn() } }));
vi.mock('../../web/src/utils/ocr', () => ({ notifyOcrMissingAfterLaunch: vi.fn() }));
vi.mock('../../web/src/utils', () => ({ detectWeakNetwork: vi.fn() }));

const profile = '/profiles/course';
const aiMarker = path.join(profile, '.ocs-ai-userscripts.json');
const profileMarker = path.join(profile, '.ocs-scripts-installed.json');
const managedMarker = path.join(profile, '.ocs-scripts-managed.json');
const preparedPath = '/tmp/ocs-userscripts/ai course.user.js';
const files = new Map<string, string>();

function ocs(overrides: Record<string, unknown> = {}): any {
	return {
		id: 1,
		url: 'https://cdn.ocsjs.com/ocs.user.js',
		enable: true,
		info: { name: 'OCS 网课助手', version: '4.13.16' },
		lastInstalledVersion: '4.13.16',
		questionBridgeVersion: QUESTION_BRIDGE_VERSION,
		...overrides
	};
}

function processForProfile() {
	return new Process(
		{ uid: 'course', name: '课程浏览器', cachePath: profile } as any,
		{
			executablePath: '/browser/chrome'
		} as any
	);
}

function saveInstallation(script: any, bridgeVersion = QUESTION_BRIDGE_VERSION) {
	files.set(aiMarker, JSON.stringify({ [script.url]: { version: '4.13.16', bridgeVersion } }));
}

async function reportInstallations(instance: Process, results: { url: string; success: boolean }[]) {
	const [listener] = instance.listeners('userscript-install-result');
	await listener(results);
}

beforeEach(() => {
	vi.clearAllMocks();
	files.clear();
	files.set('/browser/chrome', '');
	store.render.scripts = [];
	vi.mocked(detectWeakNetwork).mockResolvedValue(true);
	vi.mocked(remote.path.call).mockImplementation(async (_method: any, ...parts: any[]) => path.join(...parts));
	vi.mocked(remote.fs.call).mockImplementation(async (method: any, file: any, value: any) => {
		if (method === 'existsSync') return files.has(file);
		if (method === 'readFileSync') {
			if (!files.has(file)) throw new Error('ENOENT: ' + file);
			return files.get(file);
		}
		if (method === 'writeFileSync') {
			files.set(file, value);
			return;
		}
		if (method === 'renameSync') {
			files.set(value, files.get(file)!);
			files.delete(file);
			return;
		}
		throw new Error('Unexpected filesystem operation: ' + method);
	});
	vi.mocked(remote.methods.call).mockImplementation(async (method: any, input: any) => {
		if (method === 'downloadUserscripts') {
			return input.map(() => ({ success: true, path: '/tmp/ocs-userscripts/download.user.js' }));
		}
		if (method === 'prepareQuestionUserscript') {
			return { path: preparedPath, upstreamVersion: '5.2.3', bridgeVersion: QUESTION_BRIDGE_VERSION };
		}
		throw new Error('Unexpected remote method: ' + method);
	});
});

describe('browser script installation preparation', () => {
	it.each([false, true])('installs the prepared AI script through a .user.js URL (local=%s)', async (local) => {
		const script = ocs(local ? { url: '/scripts/ocs.user.js', isLocalScript: true } : {});
		store.render.scripts = [script];
		if (local) files.set(script.url, '');
		const instance = processForProfile();
		const result = await instance.launchPreCheck();
		expect(result?.userscripts).toHaveLength(1);
		const url = new URL(result!.userscripts[0]);
		expect(decodeURIComponent(url.pathname)).toBe('/api/local-userscript/ai course.user.js');
		expect(url.searchParams.get('path')).toBe(preparedPath);
		expect(remote.methods.call).toHaveBeenCalledWith('prepareQuestionUserscript', {
			path: local ? script.url : '/tmp/ocs-userscripts/download.user.js',
			sourceUrl: script.url,
			browserUid: 'course'
		});
		await reportInstallations(
			instance,
			result!.userscripts.map((url) => ({ url, success: true }))
		);
		expect(script.lastInstalledVersion).toBe('5.2.3');
		expect(JSON.parse(files.get(aiMarker)!)).toEqual({
			[script.url]: { version: '5.2.3', bridgeVersion: QUESTION_BRIDGE_VERSION }
		});
		expect(JSON.parse(files.get(profileMarker)!)).toMatchObject({ count: 1 });
		expect(JSON.parse(files.get(managedMarker)!)).toEqual({ names: ['OCS 网课助手'] });
		expect(Message.error).not.toHaveBeenCalled();
	});

	it('invalidates a removed script before system sync and reinstalls the same URL when added again', async () => {
		const script = ocs();
		saveInstallation(script);
		files.set(profileMarker, '{}');
		expect(await processForProfile().launchPreCheck()).toEqual({ userscripts: [], enabledScriptCount: 0 });
		expect(JSON.parse(files.get(aiMarker)!)).toEqual({});
		store.render.scripts = [script];
		expect((await processForProfile().launchPreCheck())?.userscripts).toHaveLength(1);
	});

	it('retains a disabled script installation and skips reinstalling it when re-enabled', async () => {
		const script = ocs({ enable: false });
		store.render.scripts = [script];
		saveInstallation(script);
		files.set(profileMarker, '{}');
		const saved = files.get(aiMarker);
		expect((await processForProfile().launchPreCheck())?.userscripts).toEqual([]);
		expect(files.get(aiMarker)).toBe(saved);
		script.enable = true;
		expect((await processForProfile().launchPreCheck())?.userscripts).toEqual([]);
		expect(remote.methods.call).not.toHaveBeenCalled();
	});

	it('installs an AI script in an initialized profile without its own AI installation record', async () => {
		store.render.scripts = [ocs()];
		files.set(profileMarker, '{}');
		expect((await processForProfile().launchPreCheck())?.userscripts).toHaveLength(1);
	});

	it('installs ordinary scripts in a new profile even when globally marked current', async () => {
		store.render.scripts = [ocs({ url: 'https://cdn/other.user.js', info: { name: 'Other', version: '1.0' } })];
		expect((await processForProfile().launchPreCheck())?.userscripts).toHaveLength(1);
	});

	it('reinstalls an old AI adapter during weak-network startup', async () => {
		const script = ocs();
		store.render.scripts = [script];
		saveInstallation(script, 'old-adapter');
		files.set(profileMarker, '{}');
		expect((await processForProfile().launchPreCheck())?.userscripts).toHaveLength(1);
	});

	it('records only successful installations and leaves a new profile uninitialized after a failure', async () => {
		const script = ocs();
		store.render.scripts = [script];
		const instance = processForProfile();
		const result = await instance.launchPreCheck();
		await reportInstallations(
			instance,
			result!.userscripts.map((url) => ({ url, success: false }))
		);
		expect(files.has(aiMarker)).toBe(false);
		expect(files.has(profileMarker)).toBe(false);
		expect(files.has(managedMarker)).toBe(false);
		expect(script.lastInstalledVersion).toBe('4.13.16');
	});

	it('keeps a new profile uninitialized when a requested script could not be downloaded', async () => {
		store.render.scripts = [ocs(), ocs({ id: 2, url: 'https://cdn/other.user.js', info: { name: 'Other' } })];
		vi.mocked(remote.methods.call).mockImplementation(async (method: any) => {
			if (method === 'downloadUserscripts') return [{ success: true, path: '/tmp/ocs.user.js' }, { success: false }];
			if (method === 'prepareQuestionUserscript')
				return { path: preparedPath, upstreamVersion: '5.2.3', bridgeVersion: QUESTION_BRIDGE_VERSION };
			throw new Error('Unexpected remote method: ' + method);
		});
		const instance = processForProfile();
		const result = await instance.launchPreCheck();
		await reportInstallations(
			instance,
			result!.userscripts.map((url) => ({ url, success: true }))
		);
		expect(files.has(aiMarker)).toBe(true);
		expect(files.has(profileMarker)).toBe(false);
	});
});
