import { describe, expect, it, vi } from 'vitest';
import { QUESTION_BRIDGE_VERSION } from '@ocs-desktop/common';
import {
	filterScriptsNeedingInstall,
	questionScriptsForProfile,
	readQuestionInstallations
} from '../../web/src/utils/script-version';
import { remote } from '../../web/src/utils/remote';

vi.mock('../../web/src/utils/remote', () => ({ remote: { methods: { call: vi.fn() }, fs: { call: vi.fn() } } }));
vi.mock('../../web/src/store', () => ({ store: { render: { setting: { browser: { forceUpdateScript: false } } } } }));

const ocs: any = {
	id: 1,
	url: 'https://cdn.ocsjs.com/ocs.user.js',
	enable: true,
	info: { name: 'OCS 网课助手', version: '4.13.16' },
	lastInstalledVersion: '4.13.16',
	questionBridgeVersion: QUESTION_BRIDGE_VERSION
};
describe('per-browser OCS script installation', () => {
	it('treats a missing profile marker as a first install without a failing remote read', async () => {
		const call = vi.mocked(remote.fs.call);
		call.mockReset();
		call.mockResolvedValueOnce(false);
		expect(await readQuestionInstallations('/new/profile/.ocs-ai-userscripts.json')).toEqual({});
		expect(call).toHaveBeenCalledTimes(1);
		expect(call).toHaveBeenCalledWith('existsSync', '/new/profile/.ocs-ai-userscripts.json');
	});
	it('loads successful installation versions from an existing marker', async () => {
		const saved = { 'ocs.user.js': { version: '5.2.3', bridgeVersion: QUESTION_BRIDGE_VERSION } };
		const call = vi.mocked(remote.fs.call);
		call.mockReset();
		call.mockResolvedValueOnce(true).mockResolvedValueOnce(JSON.stringify(saved));
		expect(await readQuestionInstallations('/profile/.ocs-ai-userscripts.json')).toEqual(saved);
	});
	it('installs OCS in a new profile even when another profile has already installed it', async () => {
		const secondProfile = questionScriptsForProfile([ocs], {});
		expect(await filterScriptsNeedingInstall(secondProfile, { skipRemoteCheck: true })).toHaveLength(1);
		expect(ocs.questionBridgeVersion).toBe(QUESTION_BRIDGE_VERSION);
	});
	it('keeps the existing profile current during weak-network startup', async () => {
		const profile = questionScriptsForProfile([ocs], {
			[ocs.url]: { version: '4.13.16', bridgeVersion: QUESTION_BRIDGE_VERSION }
		});
		expect(await filterScriptsNeedingInstall(profile, { skipRemoteCheck: true })).toEqual([]);
	});
	it('reinstalls an old adapter even when its upstream version is unchanged', async () => {
		const profile = questionScriptsForProfile([ocs], {
			[ocs.url]: { version: '4.13.16', bridgeVersion: 'older-adapter' }
		});
		expect(await filterScriptsNeedingInstall(profile, { skipRemoteCheck: true })).toHaveLength(1);
	});
	it('preserves unrelated userscripts and their existing version rules', async () => {
		const other: any = { ...ocs, id: 2, url: 'https://cdn/x.user.js', info: { name: 'Other', version: '4.13.16' } };
		const profile = questionScriptsForProfile([other], {});
		expect(profile[0]).toBe(other);
		expect(await filterScriptsNeedingInstall(profile, { skipRemoteCheck: true })).toEqual([]);
	});
});
