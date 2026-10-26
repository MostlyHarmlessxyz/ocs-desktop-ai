import fs from 'fs';
import path from 'path';

const socket = (file: string) => {
	try {
		return fs.statSync(file).isSocket();
	} catch {
		return false;
	}
};
const entries = (directory: string) => {
	try {
		return fs.readdirSync(directory);
	} catch {
		return [];
	}
};

/** Electron can discover a Wayland socket even when its launcher omitted display
 * variables. Chromium 137 cannot: resolve the current user's desktop for this
 * browser child only, leaving the application and Codex environment unchanged. */
export function browserDisplayOptions(
	environment: Record<string, string | undefined>,
	args: string[],
	headless: boolean,
	platform = process.platform
) {
	const env = Object.fromEntries(
		Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined)
	);
	if (platform !== 'linux' || headless) return { env, args: args.slice(), backend: 'default' };
	const explicit = args.find((arg) => arg.startsWith('--ozone-platform='))?.split('=')[1];
	const runtime = env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}`;
	const namedWayland = env.WAYLAND_DISPLAY;
	const available = entries(runtime).filter((name) => /^wayland-\d+$/.test(name) && socket(path.join(runtime, name)));
	const wayland = namedWayland
		? socket(path.isAbsolute(namedWayland) ? namedWayland : path.join(runtime, namedWayland))
			? namedWayland
			: undefined
		: available.length === 1
		? available[0]
		: undefined;
	if (explicit !== 'x11' && wayland && (explicit === 'wayland' || env.XDG_SESSION_TYPE !== 'x11' || !env.DISPLAY)) {
		env.XDG_RUNTIME_DIR = runtime;
		env.WAYLAND_DISPLAY = wayland;
		env.XDG_SESSION_TYPE = 'wayland';
		return { env, args: explicit ? args.slice() : [...args, '--ozone-platform=wayland'], backend: 'wayland' };
	}
	if (explicit === 'wayland') throw new Error('未找到指定的 Wayland 显示套接字，请从当前桌面会话重新启动 OCS');
	if (!env.DISPLAY) {
		const displays = entries('/tmp/.X11-unix').filter(
			(name) => /^X\d+$/.test(name) && socket(path.join('/tmp/.X11-unix', name))
		);
		if (displays.length === 1) env.DISPLAY = ':' + displays[0].slice(1);
	}
	if (!env.DISPLAY) {
		throw new Error('未找到可用的桌面显示会话；请在图形桌面中运行 ./ocs，或指定 DISPLAY / WAYLAND_DISPLAY');
	}
	return { env, args: args.slice(), backend: 'x11' };
}
