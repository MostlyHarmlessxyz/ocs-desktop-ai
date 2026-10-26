const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const releases = path.join(root, 'releases');
const output = path.join(releases, `build-${Date.now()}`);
const directoryOnly = process.argv.includes('--dir');
const result = spawnSync(
	'pnpm',
	[
		'--filter',
		'@ocs-desktop/app',
		'exec',
		'electron-builder',
		'--config',
		'./electron.builder.json',
		'--linux',
		...(directoryOnly ? ['--dir'] : ['AppImage']),
		'--x64',
		'--publish',
		'never',
		`--config.directories.output=${output}`
	],
	{ cwd: root, stdio: 'inherit', env: process.env }
);
if (result.error || result.status !== 0) {
	if (result.error) console.error(result.error.message);
	process.exit(result.status || 1);
}
const executable = path.join(output, 'linux-unpacked', 'ocs-desktop-ai');
fs.accessSync(executable, fs.constants.X_OK);
// Keep files belonging to a running app in place. Only the next launch switches.
const link = path.join(releases, `.current-${process.pid}`);
fs.symlinkSync(path.relative(releases, path.dirname(executable)), link, 'dir');
fs.renameSync(link, path.join(releases, 'current'));
for (const name of fs.readdirSync(output).filter((name) => name.endsWith('.AppImage'))) {
	const temporary = path.join(releases, `.${name}-${process.pid}`);
	fs.copyFileSync(path.join(output, name), temporary);
	fs.chmodSync(temporary, 0o755);
	fs.renameSync(temporary, path.join(releases, name));
}
console.log(`已同步 ./ocs：${executable}`);
