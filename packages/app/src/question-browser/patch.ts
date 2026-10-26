import { QUESTION_BRIDGE_VERSION } from '@ocs-desktop/common';

const marker = `OCS_AI_BRIDGE_${QUESTION_BRIDGE_VERSION}`;
const runtime = 'globalThis.__ocsAIRuntime';

const adapters = {
	'4.13.16': {
		resolver: 'function createDefaultQuestionResolver(ctx) {',
		optionText: '',
		chapterGuard: 'opts.workOptions',
		assignmentCall: 'worker.doWork()',
		extraSubmitPaths: 1
	},
	'5.2.3': {
		resolver: 'function createDefaultQuestionResolver(ctx, optionText) {',
		optionText: ', optionText',
		chapterGuard: 'workOptions',
		assignmentCall: 'worker.doWork({ enable_debug: BackgroundProject.scripts.dev.cfg.enable_answerer_debug })',
		extraSubmitPaths: 2
	}
} as const;

export function isQuestionBridgeCandidate(url = '', name = '') {
	return /(?:^|[/\\])ocs(?:\.common)?\.user\.js(?:$|[?#])/i.test(url) || /ocs\s*网课助手/i.test(name);
}

/** Every required edit checks its match count before returning a modified script. */
function edit(source: string, anchor: string | RegExp, replacement: string, expected = 1): string {
	const count =
		typeof anchor === 'string'
			? source.split(anchor).length - 1
			: [...source.matchAll(new RegExp(anchor.source, anchor.flags.includes('g') ? anchor.flags : anchor.flags + 'g'))]
					.length;
	if (count !== expected)
		throw new Error(`OCS 兼容检查失败：${String(anchor).slice(0, 90)} 命中 ${count} 次，预期 ${expected} 次`);
	return source.replace(anchor, replacement);
}

/** Version-specific adapters validate every structural change, including all known submission paths. */
export function patchQuestionScript(original: string, runtimeSource: string): string {
	if (original.includes(`/* ${marker} */`)) return original;
	if (original.includes('OCS_AI_BRIDGE_')) throw new Error('请使用上游原始脚本更新智能搜题适配器');
	const version = original.match(/\/\/\s*@version\s+([^\r\n]+)/)?.[1]?.trim();
	if (version !== '4.13.16' && version !== '5.2.3')
		throw new Error(`OCS 脚本 ${version || '未知版本'} 尚未通过智能搜题兼容验证（支持 4.13.16、5.2.3）`);
	const adapter = adapters[version];
	const chapterWrappers = `${adapter.chapterGuard}.answererWrappers`;
	if (!runtimeSource.includes('__ocsAIRuntime')) throw new Error('智能搜题运行时构建缺失');
	let source = original.replace(/\r\n/g, '\n');
	source = edit(source, /\/\/\s*==\/UserScript==/, `$&\n/* ${marker} */\n${runtimeSource}\n`);
	// Keep a valid upstream semver. Per-profile bridgeVersion markers force reinstall
	// when this adapter changes; a fourth numeric segment breaks OCS's own version check.

	// The original bank requests remain in OCS's own execution context, preserving credentials and parsers.
	source = edit(
		source,
		'async function defaultAnswerWrapperHandler(answererWrappers, env) {',
		`async function defaultAnswerWrapperHandler(answererWrappers, env) {\n` +
			'    const __ocsAIContext = env.ocs_question_context; delete env.ocs_question_context;\n' +
			`    const __ocsAISession = await ${runtime}.begin(env, __ocsAIContext);\n` +
			'    answererWrappers = answererWrappers || [];\n' +
			'    if (__ocsAISession.strategy === "model-only" || __ocsAISession.input.contentMode === "visual") answererWrappers = [];'
	);
	source = edit(
		source,
		'    if (temp.length === 0) {\n      throw new Error("题库配置不能为空，请配置后重新开始自动答题。");\n    }',
		''
	);
	const handlerStart = source.indexOf('async function defaultAnswerWrapperHandler(');
	const handlerEnd = source.indexOf('  class AnswerWrapperParser', handlerStart);
	if (handlerEnd < 0) throw new Error('OCS 搜题函数边界无法确认');
	const handler = edit(
		source.slice(handlerStart, handlerEnd),
		'    return searchInfos;',
		`    return await ${runtime}.finish(__ocsAISession, searchInfos);`
	);
	source = source.slice(0, handlerStart) + handler + source.slice(handlerEnd);

	// Exact answer application bypasses OCS's fuzzy matching only for responses owned by this feature.
	source = edit(
		source,
		adapter.resolver,
		`${adapter.resolver}\n    const ai = ${runtime}.resolver(ctx${adapter.optionText});\n    if (ai) return ai;`
	);
	// OCS's cache is keyed by title alone. The main-process cache also includes type, options, images and settings.
	source = edit(
		source,
		'searchAnswerInCaches: async (title, whenSearchEmpty) => {',
		'searchAnswerInCaches: async (title, whenSearchEmpty) => {\n              return await whenSearchEmpty();\n              /* OCS title-only cache is intentionally bypassed. */'
	);

	const workerStart = source.indexOf('  class OCSWorker extends ');
	const workerEnd = source.indexOf('  class CustomOCSWorker extends ', workerStart);
	if (workerStart < 0 || workerEnd < 0) throw new Error('OCS Worker 边界无法确认');
	let worker = source.slice(workerStart, workerEnd);
	worker = edit(
		worker,
		/^([ \t]*)ctx\.searchInfos = \[\];$/m,
		`$&\n$1if (${runtime}.questionAnswered(ctx.root)) {\n` +
			'$1  result.alreadyAnswered = true; result.searching = false; result.requested = true; return;\n$1}'
	);
	worker = edit(
		worker,
		'            if (result.ctx && result.ctx.searchInfos.length !== 0) {',
		'            if (result.alreadyAnswered) {\n              res = { finish: true, alreadyAnswered: true };\n' +
			'            } else if (result.ctx && result.ctx.searchInfos.length !== 0) {'
	);
	worker = edit(
		worker,
		'          result.resolved = true;',
		`          result.resolved = true;\n          ${runtime}.trackResult(result, this, index, results);`
	);
	worker = edit(
		worker,
		'(AnswerWrapperHandlerConfig.timeout_seconds + 10) * 1e3',
		'Math.max(AnswerWrapperHandlerConfig.timeout_seconds + 10, 3600) * 1e3'
	);
	worker = edit(
		worker,
		/ {4}uploadHandler\(options\) \{[\s\S]*?\n {4}\}\n {2}\}\n$/,
		`    async uploadHandler(options) {\n      return ${runtime}.upload(this, options);\n    }\n  }\n`
	);
	source = source.slice(0, workerStart) + worker + source.slice(workerEnd);

	// Empty banks are valid in model-only and fallback modes, including the chapter-test prechecks.
	source = edit(
		source,
		'if (opts.answererWrappers.length === 0) {',
		'if (false && opts.answererWrappers.length === 0) {'
	);
	source = edit(
		source,
		'if (CommonProject.scripts.settings.cfg.answererWrappers.length === 0) {',
		'if (false && CommonProject.scripts.settings.cfg.answererWrappers.length === 0) {'
	);
	source = edit(
		source,
		`if (${chapterWrappers} === void 0 || ${chapterWrappers}.length === 0) {`,
		`if (false && (${chapterWrappers} === void 0 || ${chapterWrappers}.length === 0)) {`
	);
	source = edit(
		source,
		'if (answererWrappers === void 0 || answererWrappers.length === 0) {\n        return answerWrapperEmptyWarning(0);\n      }',
		'answererWrappers = answererWrappers || [];'
	);
	source = edit(
		source,
		/if \(commonSetting\["randomWork-choice"\] &&/g,
		`if (!${runtime}.skipRandom(curr) && commonSetting["randomWork-choice"] &&`
	);
	source = edit(
		source,
		/else if \(commonSetting\["randomWork-complete"\] &&/g,
		`else if (!${runtime}.skipRandom(curr) && commonSetting["randomWork-complete"] &&`
	);
	// Some adapters save an individual field before uploadHandler; keep unresolved/formal assessments blocked there too.
	for (const statement of [
		'(_c = lib.$el("[onclick*=saveQuestion]", (_b = option == null ? void 0 : option.parentElement) == null ? void 0 : _b.parentElement)) == null ? void 0 : _c.click();',
		'(_g = lib.$el("[onclick*=saveQuestion]", option.parentElement.parentElement)) == null ? void 0 : _g.click();',
		'(_b = lib.$el(\'[name="save_btn"]\', el)) == null ? void 0 : _b.click();',
		'(_a = submitBtn()) == null ? void 0 : _a.click();'
	]) {
		source = edit(source, statement, `if (!${runtime}.isBlocked()) { ${statement} }`);
	}
	if (version === '5.2.3') source = patchFiveImageAndPrechecks(source);
	else {
		// Legacy adapters build their request inline instead of using createCommonAnswerer.
		source = edit(
			source,
			/return defaultAnswerWrapperHandler\(answererWrappers, \{/g,
			'$&\n              ocs_question_context: ctx,',
			13
		);
	}
	// Keep the real page and its original custom font intact. Approximate glyph
	// matching must not overwrite the text the user can already read correctly.
	source = edit(
		source,
		/async function mappingRecognize\(([^)]*)\) \{/,
		'$&\n    return; /* OCS AI preserves original custom-font rendering. */'
	);

	// Assignment preview and chapter-test callbacks are different paths in OCS and are adapted separately.
	source = edit(
		source,
		`      ${adapter.assignmentCall}.then(() => {\n` +
			'        lib.$message.info({ content: "作业/考试完成，请自行检查后保存或提交。", duration: 0 });',
		`      ${adapter.assignmentCall}.then(async (results) => {\n` +
			`        await ${runtime}.assignment(worker, results, type);\n` +
			'        lib.$message.info({ content: type === "exam" ? "正式考试已填写，请自行检查并提交。" : "答题流程已结束，可在智能搜题中查看填写及提交状态。", duration: 0 });'
	);
	source = edit(
		source,
		'          if (uploadable) {\n            frameWindow.btnBlueSubmit();\n            await $.sleep(3e3);\n            frameWindow.submitCheckTimes();\n            top$1.$("#workpop").hide();\n          } else {',
		`          if (uploadable && !${runtime}.isBlocked()) {\n` +
			`            const confirmation = await ${runtime}.submit([frameWindow, top$1]);\n` +
			'            if (confirmation.ok) { top$1.$("#workpop").hide(); }\n' +
			'            else { $console.warn(confirmation.reason); frameWindow.noSubmit(); }\n' +
			'            return confirmation;\n          } else {'
	);
	// Generic platform submit paths keep their native handler, behind the shared assessment gate.
	source = edit(
		source,
		/if \(uploadable\) \{/g,
		`if (uploadable && !${runtime}.isBlocked()) {`,
		adapter.extraSubmitPaths
	);
	source = edit(
		source,
		/lib\.\$message\.success\(\{ content: msg22, duration: 3 \}\);/g,
		'lib.$message.info({ content: msg22 + "（等待服务器确认）", duration: 3 });'
	);
	source = edit(
		source,
		/lib\.\$message\.success\(\{ content, duration: type === "chapter-test" \? 10 : 0 \}\);/g,
		'lib.$message.info({ content: content + "（等待服务器确认）", duration: type === "chapter-test" ? 10 : 0 });'
	);
	return source;
}

function patchFiveImageAndPrechecks(source: string): string {
	// 5.x added an iframe-only precheck, a second Chaoxing work handler, and a new MOOC chapter UI.
	source = edit(
		source,
		'if (workOptions.answererWrappers.length === 0) {',
		'if (false && workOptions.answererWrappers.length === 0) {'
	);
	const fieldSave =
		'(_c = lib.$el("[onclick*=saveQuestion]", (_b2 = option == null ? void 0 : option.parentElement) == null ? void 0 : _b2.parentElement)) == null ? void 0 : _c.click();';
	source = edit(source, fieldSave, `if (!${runtime}.isBlocked()) { ${fieldSave} }`);
	source = edit(
		source,
		'lib.$message.success({ content, duration: 10 });',
		'lib.$message.info({ content: content + "（等待服务器确认）", duration: 10 });'
	);
	// Deduplication changes choice indices when two options have identical text or images.
	source = edit(source, 'const options = dedupeLines(rawOptions);', 'const options = rawOptions;');
	source = edit(
		source,
		'env.suggestion_options = dedupeLines(suggestion.suggestion_options);',
		'env.suggestion_options = suggestion.suggestion_options;'
	);
	source = edit(
		source,
		'    return { env, imageUrls };',
		'    env.ocs_image_sources = imageUrls;\n' +
			'    env.ocs_required_images = [...(params.titleImages || []), ...(params.optionsImages || [])];\n' +
			'    return { env, imageUrls };'
	);
	source = edit(
		source,
		'        const searchInfos = await defaultAnswerWrapperHandler(options.answererWrappers, env);',
		'        env.ocs_question_context = ctx;\n' +
			'        if (["single", "multiple", "judgement"].includes(ctx.type)) {\n' +
			'          env.ocs_options = (ctx.elements.options || []).filter(Boolean).map((option) => extractTextWithImages(option).text);\n' +
			'        }\n' +
			'        const searchInfos = await defaultAnswerWrapperHandler(options.answererWrappers, env);'
	);
	return source;
}
