import type { Dialog } from 'playwright-core';
import type { ScriptManagerAdapter } from './types';
import { sleep } from '../../utils';

/**
 * Tampermonkey 5.5.x dashboard 适配器：
 * - 列表行为 tr.scripttr，脚本名在 .script_name .nameNname16；
 * - 启用开关为 .enabler，启用状态类为 enabler_enabled；
 * - 删除为行内 .actions .fa-trash-alt，关闭回收站时弹出原生确认框。
 */

export const tampermonkeyAdapter: ScriptManagerAdapter = {
	id: 'tampermonkey',
	pagePath: 'options.html#nav=dashboard',

	async listScripts(page) {
		return page.evaluate(() => {
			const out: { name: string; enabled: boolean }[] = [];
			for (const row of Array.from(document.querySelectorAll<HTMLElement>('tr.scripttr'))) {
				const nameEl = row.querySelector<HTMLElement>('.script_name .nameNname16');
				const name = (nameEl?.textContent || '').trim();
				if (!name) continue;
				const enabler = row.querySelector<HTMLElement>('.enabler');
				out.push({
					name,
					enabled: !!enabler && enabler.className.includes('enabler_enabled')
				});
			}
			return out;
		});
	},

	async setEnabled(page, name, enabled) {
		await page.evaluate(
			({ scriptName, targetEnabled }) => {
				for (const row of Array.from(document.querySelectorAll<HTMLElement>('tr.scripttr'))) {
					const nameEl = row.querySelector<HTMLElement>('.script_name .nameNname16');
					if ((nameEl?.textContent || '').trim() !== scriptName) continue;
					const enabler = row.querySelector<HTMLElement>('.enabler');
					if (!enabler) return;
					const on = enabler.className.includes('enabler_enabled');
					if (on !== targetEnabled) enabler.click();
					return;
				}
			},
			{ scriptName: name, targetEnabled: enabled }
		);
	},

	async remove(page, name) {
		const confirmDelete = async (dialog: Dialog) => {
			if (dialog.type() === 'confirm') await dialog.accept();
			else await dialog.dismiss();
		};
		page.on('dialog', confirmDelete);
		try {
			await page.evaluate((scriptName) => {
				for (const row of Array.from(document.querySelectorAll<HTMLElement>('tr.scripttr'))) {
					const nameEl = row.querySelector<HTMLElement>('.script_name .nameNname16');
					if ((nameEl?.textContent || '').trim() !== scriptName) continue;
					row.querySelector<HTMLElement>('.actions .fa-trash-alt')?.click();
					return;
				}
			}, name);
			await sleep(400);
		} finally {
			page.off('dialog', confirmDelete);
		}
	}
};
