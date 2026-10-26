import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import express from 'express';
import { getProjectPath } from '../src/utils';

const mocked = vi.hoisted(() => ({ getAppPath: vi.fn() }));
vi.mock('electron', () => ({
	app: { isPackaged: false, getAppPath: mocked.getAppPath, getPath: () => '/tmp' },
	dialog: {},
	BrowserWindow: class {}
}));
const cleanup: Array<() => void> = [];
afterEach(() => {
	cleanup.splice(0).forEach((fn) => fn());
});

describe('local browser navigation assets', () => {
	it('serves built index.html from the Electron app root even when cwd is elsewhere', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocs-renderer-assets-'));
		cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
		fs.mkdirSync(path.join(root, 'out/renderer'), { recursive: true });
		fs.writeFileSync(path.join(root, 'out/renderer/index.html'), '<title>OCS bookmarks</title>');
		mocked.getAppPath.mockReturnValue(root);
		expect(process.cwd()).not.toBe(root);
		const server = express()
			.use(express.static(path.join(getProjectPath(), 'out/renderer')))
			.listen(0, '127.0.0.1');
		await new Promise<void>((resolve) => server.once('listening', resolve));
		cleanup.push(() => server.close());
		const response = await new Promise<{ status?: number; body: string }>((resolve, reject) => {
			http
				.get(`http://127.0.0.1:${(server.address() as any).port}/index.html`, (res) => {
					let body = '';
					res.on('data', (data) => {
						body += data;
					});
					res.on('end', () => resolve({ status: res.statusCode, body }));
				})
				.on('error', reject);
		});
		expect(response.status).toBe(200);
		expect(response.body).toContain('OCS bookmarks');
	});
});
