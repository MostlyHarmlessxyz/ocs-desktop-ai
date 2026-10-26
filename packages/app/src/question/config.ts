import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import * as TOML from '@iarna/toml';
import { DEFAULT_QUESTION_SETTINGS } from '@ocs-desktop/common';
import type { QuestionSettings, QuestionModelProfile, QuestionModelCatalog } from '@ocs-desktop/common';

export const EFFORTS = ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export function validateSettings(value: QuestionSettings): QuestionSettings {
	const proxyUrl = typeof value?.proxyUrl === 'string' ? value.proxyUrl.trim() : '';
	if (proxyUrl) {
		let proxy: URL;
		try {
			proxy = new URL(proxyUrl);
		} catch {
			throw new Error('代理地址必须是完整 HTTP/HTTPS URL');
		}
		if (!['http:', 'https:'].includes(proxy.protocol) || proxy.username || proxy.password) {
			throw new Error('代理仅支持不含用户名和密码的 HTTP/HTTPS 地址');
		}
	}
	if (!value || !['consensus', 'bank-first', 'model-only'].includes(value.strategy)) throw new Error('无效的答案策略');
	if (typeof value.enabled !== 'boolean') throw new Error('无效的启用状态');
	if (!Number.isInteger(value.maxConcurrent) || value.maxConcurrent < 1 || value.maxConcurrent > 8) {
		throw new Error('并发数须为 1–8');
	}
	if (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 10000 || value.timeoutMs > 600000) {
		throw new Error('调用超时须为 10–600 秒');
	}
	const profile = (p: QuestionModelProfile): QuestionModelProfile => {
		if (!p || !['inherit', 'custom'].includes(p.mode)) throw new Error('无效的模型配置模式');
		if (!EFFORTS.includes(p.reasoningEffort)) throw new Error('无效的思考强度');
		if (!['inherit', 'enabled', 'disabled'].includes(p.webSearch)) throw new Error('无效的搜索模式');
		if (typeof p.model !== 'string' || p.model.length > 200) throw new Error('无效的模型 ID');
		if (p.mode === 'custom' && !p.model.trim()) throw new Error('请填写或选择模型');
		return { mode: p.mode, model: p.model.trim(), reasoningEffort: p.reasoningEffort, webSearch: p.webSearch };
	};
	if (typeof value.command !== 'string' || value.command.length > 4096 || /[\r\n\0]/.test(value.command)) {
		throw new Error('CLI 路径无效，请提供可执行文件而非 shell 命令');
	}
	return {
		...copy(value),
		command: value.command.trim(),
		proxyUrl,
		answer: profile(value.answer),
		adjudication: value.adjudication === null ? null : profile(value.adjudication)
	};
}

export class QuestionConfiguration {
	private settings = copy(DEFAULT_QUESTION_SETTINGS);
	constructor(private readonly file?: string) {
		if (file && fs.existsSync(file)) {
			try {
				this.settings = validateSettings(JSON.parse(fs.readFileSync(file, 'utf8')));
			} catch (error) {
				console.error('智能搜题设置读取失败，使用默认设置', error);
			}
		}
	}

	get() {
		return copy(this.settings);
	}

	save(value: QuestionSettings) {
		const next = validateSettings(value);
		const catalog = modelCatalog();
		for (const profile of [next.answer, next.adjudication].filter((p): p is QuestionModelProfile => !!p)) {
			const model = catalog.models.find((m) => m.value === profile.model);
			if (
				profile.mode === 'custom' &&
				profile.reasoningEffort &&
				model?.reasoningEfforts.length &&
				!model.reasoningEfforts.includes(profile.reasoningEffort)
			)
				throw new Error('当前模型目录不支持所选思考强度');
		}
		if (this.file) {
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			fs.writeFileSync(this.file + '.tmp', JSON.stringify(next, null, 2), { mode: 0o600 });
			fs.renameSync(this.file + '.tmp', this.file);
		}
		this.settings = next;
		return this.get();
	}
}

/** Only public configuration metadata is returned; credentials never enter IPC. */
export function modelCatalog(home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')): QuestionModelCatalog {
	let config: Record<string, any> = {};
	let revision = 'missing';
	try {
		const text = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
		config = TOML.parse(text);
		revision = createHash('sha256').update(text).digest('hex');
	} catch {}
	let models: QuestionModelCatalog['models'] = [];
	let source = 'none';
	const configured = typeof config.model_catalog_json === 'string' ? path.resolve(home, config.model_catalog_json) : '';
	for (const file of [configured, path.join(home, 'models_cache.json')].filter(Boolean)) {
		try {
			const raw = fs.readFileSync(file, 'utf8');
			const entries = JSON.parse(raw).models;
			if (!Array.isArray(entries)) continue;
			const seen = new Set<string>();
			models = entries
				.filter((e) => typeof e?.slug === 'string' && e.visibility !== 'hide')
				.flatMap((e) => {
					if (seen.has(e.slug)) return [];
					seen.add(e.slug);
					return [
						{
							value: e.slug,
							label: String(e.display_name || e.slug),
							reasoningEfforts: (Array.isArray(e.supported_reasoning_levels) ? e.supported_reasoning_levels : [])
								.map((l: any) => (typeof l === 'string' ? l : l?.effort))
								.filter((l: string) => !!l && EFFORTS.includes(l)),
							defaultReasoningEffort: EFFORTS.includes(e.default_reasoning_level)
								? e.default_reasoning_level
								: undefined
						}
					];
				})
				.slice(0, 200);
			if (models.length) {
				source = file === configured ? 'configured-catalog' : 'codex-cache';
				revision = createHash('sha256')
					.update(revision + raw)
					.digest('hex');
				break;
			}
		} catch {}
	}
	const model = typeof config.model === 'string' ? config.model : undefined;
	if (model && !models.some((m) => m.value === model))
		models.unshift({ value: model, label: model, reasoningEfforts: [] });
	return {
		models,
		model,
		reasoningEffort: typeof config.model_reasoning_effort === 'string' ? config.model_reasoning_effort : undefined,
		source,
		revision
	};
}

export interface Invocation {
	command: string;
	proxyUrl?: string;
	model: string;
	effort: string;
	overrides: string[];
	args: string[];
	timeoutMs: number;
	maxConcurrent: number;
	revision: string;
}
export function invocation(settings: QuestionSettings, purpose: 'answer' | 'adjudication' = 'answer'): Invocation {
	const profile = purpose === 'adjudication' ? settings.adjudication || settings.answer : settings.answer;
	const catalog = modelCatalog();
	const env = process.env;
	const custom = profile.mode === 'custom';
	const model = env.OCS_CODEX_MODEL || (custom ? profile.model : '');
	const effort = env.OCS_CODEX_REASONING_EFFORT || (custom ? profile.reasoningEffort : '');
	const search =
		env.OCS_CODEX_WEB_SEARCH !== undefined
			? /^(0|false|no|off)$/i.test(env.OCS_CODEX_WEB_SEARCH)
				? 'disabled'
				: 'enabled'
			: custom
			? profile.webSearch
			: 'inherit';
	const args = [
		...(model ? ['--model', model] : []),
		...(effort ? ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
		...(search !== 'inherit' ? ['-c', `web_search=${JSON.stringify(search === 'enabled' ? 'live' : 'disabled')}`] : [])
	];
	const bounded = (text: string | undefined, fallback: number, min: number, max: number) => {
		const n = text === undefined ? fallback : Number(text);
		if (!Number.isFinite(n) || n < min || n > max) throw new Error('OCS_CODEX 超时或并发环境变量超出有效范围');
		return Math.floor(n);
	};
	if (effort && !EFFORTS.includes(effort)) throw new Error('OCS_CODEX_REASONING_EFFORT 无效');
	return {
		command: env.OCS_CODEX_COMMAND || settings.command || 'codex',
		proxyUrl: env.OCS_CODEX_PROXY || settings.proxyUrl || '',
		model: model || catalog.model || '跟随 Codex（未知）',
		effort: effort || catalog.reasoningEffort || '模型默认',
		args,
		timeoutMs: bounded(env.OCS_CODEX_TIMEOUT_MS, settings.timeoutMs, 10000, 600000),
		maxConcurrent: bounded(env.OCS_CODEX_MAX_CONCURRENT, settings.maxConcurrent, 1, 8),
		overrides: Object.keys(env).filter((key) => key.startsWith('OCS_CODEX_')),
		revision: createHash('sha256')
			.update(JSON.stringify([catalog.revision, settings.strategy, args, env.OCS_CODEX_COMMAND || settings.command]))
			.digest('hex')
	};
}
