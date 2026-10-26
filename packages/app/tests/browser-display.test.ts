import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import { browserDisplayOptions } from '../src/utils/browser-display';

afterEach(() => vi.restoreAllMocks());
function sockets(files: string[]) {
	vi.spyOn(fs, 'readdirSync').mockImplementation(
		(directory: any) =>
			files
				.filter(
					(file) => file.startsWith(String(directory) + '/') && !file.slice(String(directory).length + 1).includes('/')
				)
				.map((file) => file.slice(String(directory).length + 1)) as any
	);
	vi.spyOn(fs, 'statSync').mockImplementation((file: any) => ({ isSocket: () => files.includes(String(file)) } as any));
}
describe('managed browser display environment', () => {
	it('discovers the user Wayland socket when the desktop launcher omitted all display variables', () => {
		const runtime = `/run/user/${process.getuid?.()}`;
		sockets([`${runtime}/wayland-1`, '/tmp/.X11-unix/X0']);
		const original = { PATH: '/usr/bin', CODEX_THREAD_ID: 'unchanged' };
		const result = browserDisplayOptions(original, ['--load-extension=/tmp/ext'], false, 'linux');
		expect(result.backend).toBe('wayland');
		expect(result.env.WAYLAND_DISPLAY).toBe('wayland-1');
		expect(result.env.XDG_RUNTIME_DIR).toBe(runtime);
		expect(result.args).toContain('--ozone-platform=wayland');
		expect(original).toEqual({ PATH: '/usr/bin', CODEX_THREAD_ID: 'unchanged' });
	});
	it('keeps explicit session and browser backend choices', () => {
		sockets(['/run/test/wayland-2', '/tmp/.X11-unix/X0']);
		const result = browserDisplayOptions(
			{ XDG_RUNTIME_DIR: '/run/test', WAYLAND_DISPLAY: 'wayland-2', DISPLAY: ':9' },
			['--ozone-platform=x11'],
			false,
			'linux'
		);
		expect(result.backend).toBe('x11');
		expect(result.env.DISPLAY).toBe(':9');
		expect(result.args).toEqual(['--ozone-platform=x11']);
	});
	it('supports an X11-only session without hard-coding :0', () => {
		sockets(['/tmp/.X11-unix/X3']);
		expect(browserDisplayOptions({}, [], false, 'linux').env.DISPLAY).toBe(':3');
	});
	it('reports absent or ambiguous sessions rather than silently using a different desktop', () => {
		sockets(['/run/test/wayland-1', '/run/test/wayland-2']);
		expect(() => browserDisplayOptions({ XDG_RUNTIME_DIR: '/run/test' }, [], false, 'linux')).toThrow(/显示会话/);
	});
	it('does not require a display for headless or non-Linux browsers', () => {
		sockets([]);
		expect(browserDisplayOptions({}, [], true, 'linux').args).toEqual([]);
		expect(browserDisplayOptions({}, [], false, 'win32').env).toEqual({});
	});
});
