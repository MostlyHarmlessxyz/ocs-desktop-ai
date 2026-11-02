import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import { EventEmitter } from 'events';
import vm from 'vm';
import { scriptcatAdapter } from '../src/scripts/system/userscript-sync/adapters/scriptcat';
import { tampermonkeyAdapter } from '../src/scripts/system/userscript-sync/adapters/tampermonkey';

vi.mock('../src/scripts/system/utils', () => ({ sleep: async () => {} }));
const require = createRequire(import.meta.url);
const browserEnv = require('browser-env');
const windows: any[] = [];
afterEach(() => windows.splice(0).forEach((window) => window.close()));

function dashboard(html: string) {
	const window = browserEnv([], { url: 'https://example.test' });
	windows.push(window);
	window.document.body.innerHTML = html;
	const context = vm.createContext({ document: window.document });
	const page = Object.assign(new EventEmitter(), {
		evaluate: async (callback: Function, argument?: unknown) =>
			vm.runInContext(`(${callback.toString()})(${JSON.stringify(argument)})`, context)
	});
	return { window, page: page as any };
}

const tampermonkeyRows = `<table>
<tr class="scripttr"><td class="script_name">&lt;New userscript&gt;</td></tr>
<tr class="scripttr" data-script="course"><td class="script_name">
<span class="nameNname16">Course</span><span>Description</span></td>
<td><div class="enabler enabler_enabled"></div></td><td class="actions"><i class="fa-trash-alt"></i></td></tr>
<tr class="scripttr" data-script="other"><td class="script_name"><span class="nameNname16">Other</span></td>
<td><div class="enabler enabler_disabled"></div></td><td class="actions"><i class="fa-trash-alt"></i></td></tr>
</table>`;

describe('Tampermonkey 5.5.1 dashboard synchronization', () => {
	it('reads actual rows and names without treating the editor template as an installed script', async () => {
		const { page } = dashboard(tampermonkeyRows);
		expect(tampermonkeyAdapter.pagePath).toBe('options.html#nav=dashboard');
		expect(await tampermonkeyAdapter.listScripts(page)).toEqual([
			{ name: 'Course', enabled: true },
			{ name: 'Other', enabled: false }
		]);
	});

	it('changes only the requested script and leaves a matching enable state alone', async () => {
		const { page, window } = dashboard(tampermonkeyRows);
		const button = window.document.querySelector('[data-script="course"] .enabler');
		const click = vi.fn(() => button.classList.toggle('enabler_enabled'));
		button.onclick = click;
		await tampermonkeyAdapter.setEnabled(page, 'Course', false);
		await tampermonkeyAdapter.setEnabled(page, 'Course', false);
		expect(click).toHaveBeenCalledOnce();
		await tampermonkeyAdapter.setEnabled(page, 'Course', true);
		expect(click).toHaveBeenCalledTimes(2);
		expect(await tampermonkeyAdapter.listScripts(page)).toEqual([
			{ name: 'Course', enabled: true },
			{ name: 'Other', enabled: false }
		]);
	});

	it.each([false, true])('removes only the requested row with native confirmation=%s', async (confirm) => {
		const { page, window } = dashboard(tampermonkeyRows);
		const row = window.document.querySelector('[data-script="course"]');
		const accept = vi.fn(async () => row.remove());
		row.querySelector('.fa-trash-alt').onclick = () => {
			if (confirm) page.emit('dialog', { type: () => 'confirm', accept });
			else row.remove();
		};
		await tampermonkeyAdapter.remove(page, 'Course');
		expect(await tampermonkeyAdapter.listScripts(page)).toEqual([{ name: 'Other', enabled: false }]);
		expect(accept).toHaveBeenCalledTimes(confirm ? 1 : 0);
		expect(page.listenerCount('dialog')).toBe(0);
	});
});

describe('ScriptCat 1.5.0 deletion', () => {
	it('uses the row delete action and confirms it without opening the compact menu', async () => {
		const { page, window } = dashboard(`<div data-script="course">
<a href="/script/editor/course">Course</a><div data-tour="row-enable">
<button role="switch" data-state="checked"></button></div>
<div data-tour="row-action"><span style="display:none"><button><svg class="lucide-trash-2"></svg></button></span>
<button data-slot="dropdown-menu-trigger">More actions</button></div></div>`);
		const row = window.document.querySelector('[data-script="course"]');
		const menu = vi.fn();
		row.querySelector('[data-slot="dropdown-menu-trigger"]').onclick = menu;
		row.querySelector('svg').closest('button').onclick = () => {
			const dialog = window.document.createElement('div');
			dialog.setAttribute('role', 'alertdialog');
			dialog.innerHTML = '<button>Cancel</button><button>Delete</button>';
			dialog.lastChild.onclick = () => {
				row.remove();
				dialog.remove();
			};
			window.document.body.appendChild(dialog);
		};
		await scriptcatAdapter.remove(page, 'Course');
		expect(await scriptcatAdapter.listScripts(page)).toEqual([]);
		expect(menu).not.toHaveBeenCalled();
	});
});
