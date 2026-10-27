import { app, BrowserWindow } from 'electron';
import path from 'path';
import fs from 'fs';
import { randomBytes, createHash, timingSafeEqual } from 'crypto';
import type express from 'express';
import { DEFAULT_SERVER_PORT, QUESTION_BRIDGE_VERSION } from '@ocs-desktop/common';
import type { QuestionRemoteMethods, QuestionPhase } from '@ocs-desktop/common';
import { QuestionConfiguration, invocation, modelCatalog } from './config';
import { checkCli } from './client';
import { QuestionRecords } from './records';
import { QuestionService } from './service';
import { questionJsonBody, questionBodyError } from './request-body';
import { store, getDecryptedRenderData } from '../store';
import { isAllowedUserscriptPath } from '../utils/server.security';
import { isQuestionBridgeCandidate, patchQuestionScript } from '../question-browser/patch';
import runtimeSource from '../question-browser/runtime.ts?question-runtime';

const token = randomBytes(32).toString('hex');
let instance: QuestionService | undefined;
function service() {
	if (!instance) {
		const directory = path.join(app.getPath('userData'), 'question-assistant');
		instance = new QuestionService(
			new QuestionConfiguration(path.join(directory, 'settings.json')),
			new QuestionRecords(directory),
			() => {
				for (const window of BrowserWindow.getAllWindows()) {
					if (!window.isDestroyed()) window.webContents.send('question-changed');
				}
			}
		);
	}
	return instance;
}
export const questionMethods: QuestionRemoteMethods = {
	questionSettings: () => service().configuration.get(),
	saveQuestionSettings: (settings) => service().configuration.save(settings),
	questionModels: () => modelCatalog(),
	questionHealth: () => checkCli(invocation(service().configuration.get())),
	questionTest: () => service().test(),
	questionList: (query) => service().list(query),
	questionDetail: (id) => service().detail(id),
	questionControl: (action, id) => service().control(action, id),
	questionResolve: (id, answers) => service().resolve(id, answers),
	questionBridgeSession: () => ({
		port: store.store.server?.port || DEFAULT_SERVER_PORT,
		token,
		enabled: service().configuration.get().enabled
	}),
	prepareQuestionUserscript: async ({ path: file, sourceUrl }) => {
		const directory = path.join(app.getPath('temp'), 'ocs-userscripts');
		const scripts = getDecryptedRenderData(store)?.scripts || [];
		if (!isAllowedUserscriptPath(file, directory, scripts)) throw new Error('脚本路径未经授权');
		const source = await fs.promises.readFile(file, 'utf8');
		const name = source.match(/\/\/\s*@name\s+([^\r\n]+)/)?.[1];
		if (!isQuestionBridgeCandidate(sourceUrl, name)) return { path: file };
		const patched = patchQuestionScript(source, runtimeSource);
		const hash = createHash('sha256').update(patched).digest('hex').slice(0, 24);
		const dest = path.join(directory, `ai-${hash}.user.js`);
		await fs.promises.mkdir(directory, { recursive: true });
		await fs.promises.writeFile(dest, patched, { mode: 0o600 });
		return {
			path: dest,
			bridgeVersion: QUESTION_BRIDGE_VERSION,
			upstreamVersion: source.match(/\/\/\s*@version\s+([^\r\n]+)/)?.[1].trim()
		};
	}
};

/** Worker-only API: the token is separate from legacy public /get-actions-key. */
export function registerQuestionRoutes(server: express.Express) {
	server.post(
		'/api/question/bridge/:action',
		(req: express.Request, res: express.Response, next: express.NextFunction) => {
			const provided = req.headers['x-ocs-question-token'];
			if (
				typeof provided !== 'string' ||
				!/^[a-f0-9]{64}$/.test(provided) ||
				!timingSafeEqual(Buffer.from(provided), Buffer.from(token))
			) {
				res.status(401).json({ error: '未授权的题目服务请求' });
				return;
			}
			next();
		},
		questionJsonBody(),
		async (req: express.Request, res: express.Response) => {
			try {
				const input = req.body || {};
				let result: unknown;
				switch (req.params.action) {
					case 'begin':
						result = service().begin(input);
						break;
					case 'complete':
						result = await service().complete(
							String(input.taskId),
							Array.isArray(input.bankInfos) ? input.bankInfos : []
						);
						break;
					case 'decision':
						result = service().decision(String(input.taskId));
						break;
					case 'decisions':
						result = service().decisions(input.taskIds);
						break;
					case 'status':
						service().status(String(input.taskId), input.phase as QuestionPhase, input.error);
						result = { ok: true };
						break;
					case 'disconnect':
						service().disconnect(String(input.pageId));
						result = { ok: true };
						break;
					default:
						res.status(404).json({ error: '未知的题目操作' });
						return;
				}
				res.json(result);
			} catch (error) {
				res.status(400).json({ error: (error as Error).message });
			}
		},
		questionBodyError
	);
}
let shutdown: Promise<void> | undefined;
export function shutdownQuestionService(): Promise<void> {
	if (!shutdown) shutdown = instance ? instance.close() : Promise.resolve();
	return shutdown;
}

let quitting = false;
app.on('before-quit', (event) => {
	if (quitting || !instance) return;
	quitting = true;
	event.preventDefault();
	shutdownQuestionService().finally(() => app.quit());
});
