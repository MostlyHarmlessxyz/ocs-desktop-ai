<template>
	<div class="question-detail">
		<div class="detail-meta">
			<a-tag :color="phaseColor(task.phase)">{{ phaseLabels[task.phase] }}</a-tag
			><a-tag>{{ typeLabels[task.input.type || ''] || task.input.type || '未知题型' }}</a-tag
			><a-tag
				v-if="task.input.formalExam"
				color="orange"
				>正式考试 · 手动提交</a-tag
			><a-tag v-else-if="task.input.assessment">测试 / 作业</a-tag
			><span class="muted">{{ formatTime(task.createdAt) }}</span>
		</div>
		<h3 class="question-text">{{ task.input.question }}</h3>
		<a-alert
			v-if="task.input.contentMode === 'visual'"
			type="info"
		>
			题目按页面原始字形截图识别。请查看下方题干和选项图片。
		</a-alert>
		<div
			v-if="task.input.images?.length"
			class="question-images"
		>
			<img
				v-for="(src, index) in task.input.images"
				:key="index"
				:src="src"
				:alt="task.input.imageLabels?.[index] || '题目图片 ' + (index + 1)"
				:title="task.input.imageLabels?.[index]"
				loading="lazy"
			/>
		</div>
		<ol
			v-if="task.input.options.length"
			class="question-options"
		>
			<li
				v-for="(option, index) in task.input.options"
				:key="index"
			>
				<span class="option-label">{{ optionLabel(index) }}</span
				><span>{{ option }}</span>
			</li>
		</ol>
		<div
			v-if="task.input.sourceUrl"
			class="source-link"
		>
			<span class="muted">来源页面</span><button @click="openSource">{{ task.input.sourceUrl }}</button>
		</div>
		<a-alert
			v-if="task.error"
			type="warning"
			>{{ task.error }}</a-alert
		>
		<section class="detail-section">
			<h4>答案对比</h4>
			<div class="answer-comparison">
				<div
					v-for="(bank, index) in task.bankAnswers"
					:key="index"
					class="answer-source"
				>
					<span>{{ bank.name || '题库' }}</span
					><strong>{{ bank.answers.join('；') || '无有效答案' }}</strong
					><small v-if="bank.error">{{ bank.error }}</small>
				</div>
				<div class="answer-source">
					<span>模型首次作答</span><strong>{{ task.modelAnswer?.join('；') || '尚无结果' }}</strong>
				</div>
				<div class="answer-source final-answer">
					<span
						>最终采用
						<a-tag
							v-if="task.decisionSource"
							size="small"
							>{{ sourceLabels[task.decisionSource] }}</a-tag
						></span
					><strong>{{ task.answer?.join('；') || '尚未确定' }}</strong
					><small v-if="task.reason">{{ task.reason }}</small>
				</div>
			</div>
		</section>
		<section class="detail-section">
			<h4>人工复核</h4>
			<a-alert
				v-if="task.expired"
				type="warning"
				>该复核记录已过期，请重新搜题后处理。</a-alert
			><a-alert
				v-else-if="!task.pageConnected"
				type="warning"
				>原页面已断开，确认结果可保存为后续参考，本次无法直接回填。</a-alert
			>
			<p
				v-else
				class="muted"
			>
				确认后将应用到原页面并继续处理。页面内容变化时会停止回填。
			</p>
			<div
				v-if="isFill"
				class="blank-editor"
			>
				<div
					v-for="(_, index) in blanks"
					:key="index"
					class="blank-row"
				>
					<span>第 {{ index + 1 }} 空</span
					><a-textarea
						v-model="blanks[index]"
						:auto-size="{ minRows: 1, maxRows: 5 }"
						:disabled="task.expired"
						placeholder="填写此空答案"
					/><a-button
						:disabled="blanks.length <= 1 || task.expired"
						size="small"
						@click="blanks.splice(index, 1)"
						>移除</a-button
					>
				</div>
				<a-button
					size="small"
					:disabled="task.expired"
					@click="blanks.push('')"
					>添加空位</a-button
				>
			</div>
			<a-checkbox-group
				v-else-if="task.input.type === 'multiple'"
				v-model="selected"
				direction="vertical"
				class="answer-editor"
				:disabled="task.expired"
				><a-checkbox
					v-for="(option, index) in task.input.options"
					:key="index"
					:value="optionLabel(index)"
					>{{ optionLabel(index) }} · {{ option }}</a-checkbox
				></a-checkbox-group
			>
			<a-radio-group
				v-else
				v-model="single"
				direction="vertical"
				class="answer-editor"
				:disabled="task.expired"
				><template v-if="task.input.options.length"
					><a-radio
						v-for="(option, index) in task.input.options"
						:key="index"
						:value="optionLabel(index)"
						>{{ optionLabel(index) }} · {{ option }}</a-radio
					></template
				><template v-else
					><a-radio value="正确">正确</a-radio><a-radio value="错误">错误</a-radio></template
				></a-radio-group
			>
			<a-alert
				v-if="resolveError"
				type="error"
				>{{ resolveError }}</a-alert
			><a-button
				class="apply-answer"
				type="primary"
				:loading="resolving"
				:disabled="task.expired"
				@click="applyAnswer"
				>{{ task.pageConnected ? '应用并继续' : '保存确认答案' }}</a-button
			>
		</section>
		<section class="detail-section">
			<h4>处理过程</h4>
			<ol class="timeline">
				<li
					v-for="(entry, index) in task.timeline"
					:key="index"
				>
					<span class="timeline-dot" />
					<div>
						<strong>{{ phaseLabels[entry.phase] }}</strong
						><span class="muted">{{ formatTime(entry.at) }}</span>
						<p>{{ entry.message }}</p>
					</div>
				</li>
			</ol>
		</section>
		<section class="detail-section">
			<h4>
				模型调用 <span class="muted">{{ calls.length }} 次</span>
			</h4>
			<a-empty
				v-if="!calls.length"
				description="未启动模型调用"
			/><a-collapse v-else
				><a-collapse-item
					v-for="call in calls"
					:key="call.id"
					:header="callTitle(call)"
					><div class="call-summary">
						<div>
							<span>模型</span><strong>{{ call.model || '由 Codex 决定' }}</strong>
						</div>
						<div>
							<span>思考强度</span><strong>{{ call.reasoningEffort || '模型默认' }}</strong>
						</div>
						<div>
							<span>耗时 / 图片</span><strong>{{ duration(call) }} / {{ call.imageCount }} 张</strong>
						</div>
						<div>
							<span>调用 ID</span><code>{{ call.id }}</code>
						</div>
						<div v-if="call.threadId">
							<span>Thread ID</span><code>{{ call.threadId }}</code>
						</div>
					</div>
					<a-alert
						v-if="call.error"
						type="error"
						>{{ call.error }}</a-alert
					>
					<p v-if="call.explanation">{{ call.explanation }}</p>
					<details>
						<summary>CLI 参数与 usage</summary>
						<pre>{{ call.args.join('\n') }}</pre>
						<pre v-if="call.usage">{{ JSON.stringify(call.usage, null, 2) }}</pre>
					</details>
					<details v-if="call.raw">
						<summary>原始输出</summary>
						<pre>{{ call.raw }}</pre>
					</details></a-collapse-item
				></a-collapse
			>
		</section>
		<div class="record-id muted">任务 {{ task.id }} · 浏览器 {{ task.input.browserUid || '未知' }}</div>
	</div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Message } from '@arco-design/web-vue';
import type { QuestionCall, QuestionTask } from '@ocs-desktop/common/web';
import { remote } from '../../utils/remote';
import { electron } from '../../utils/node';
import {
	formatTime,
	manualAnswers,
	optionLabel,
	phaseColor,
	phaseLabels,
	sourceLabels,
	typeLabels
} from './presentation';

const props = defineProps<{ task: QuestionTask; calls: QuestionCall[] }>();
const emit = defineEmits<{ (event: 'updated'): void }>();
const selected = ref<string[]>([]);
const single = ref('');
const blanks = ref<string[]>(['']);
const resolving = ref(false);
const resolveError = ref('');
const isFill = computed(
	() =>
		['completion', 'fill-blank', 'unknown', ''].includes(props.task.input.type || '') ||
		(props.task.input.type !== 'judgement' && !props.task.input.options.length)
);
watch(
	() => props.task.id,
	() => {
		selected.value = [...(props.task.answer || [])];
		single.value = props.task.answer?.[0] || '';
		blanks.value = props.task.answer?.length ? [...props.task.answer] : [''];
		resolveError.value = '';
	},
	{ immediate: true }
);
function openSource() {
	const url = props.task.input.sourceUrl;
	if (url && /^https?:\/\//i.test(url)) electron.shell.openExternal(url);
}
function duration(call: QuestionCall) {
	return call.finishedAt ? ((call.finishedAt - call.startedAt) / 1000).toFixed(1) + ' 秒' : '运行中';
}
function callTitle(call: QuestionCall) {
	const purpose = call.purpose === 'adjudication' ? '二次裁决' : call.purpose === 'test' ? '连接测试' : '首次作答';
	const status = { running: '进行中', success: '成功', error: '失败', cancelled: '已取消' }[call.status];
	return `${purpose} · ${status} · ${call.model || '跟随 Codex'} · ${duration(call)}`;
}
async function applyAnswer() {
	resolving.value = true;
	resolveError.value = '';
	try {
		const answers = manualAnswers(
			isFill.value ? 'completion' : props.task.input.type,
			props.task.input.type === 'multiple' ? selected.value : single.value ? [single.value] : [],
			blanks.value
		);
		const result = await remote.methods.call('questionResolve', props.task.id, answers);
		if (result.status === 'error') throw new Error(result.error || '无法保存复核答案');
		Message.success(props.task.pageConnected ? '答案已确认，等待原页面应用' : '确认答案已保存');
		emit('updated');
	} catch (cause) {
		resolveError.value = cause instanceof Error ? cause.message : String(cause);
	} finally {
		resolving.value = false;
	}
}
</script>

<style scoped lang="less">
.question-detail {
	color: var(--theme-text-color);
}
.detail-meta {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 8px;
}
.muted {
	color: var(--theme-text-color-secondary);
	font-size: 12px;
}
.question-text {
	font-size: 17px;
	line-height: 1.8;
	margin: 20px 0 16px;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}
.question-images {
	display: flex;
	flex-wrap: wrap;
	gap: 10px;
}
.question-images img {
	max-height: 240px;
	max-width: 100%;
	object-fit: contain;
	border-radius: 8px;
	background: white;
}
.question-options {
	list-style: none;
	padding: 0;
	margin: 14px 0;
	display: grid;
	gap: 8px;
}
.question-options li {
	display: flex;
	align-items: start;
	gap: 10px;
	padding: 10px 12px;
	border: 1px solid var(--theme-border-color-light);
	border-radius: 8px;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}
.option-label {
	flex-shrink: 0;
	color: var(--theme-primary-color);
	font-weight: 600;
}
.source-link {
	margin: 16px 0;
	display: grid;
	gap: 4px;
}
.source-link button {
	border: 0;
	background: none;
	color: var(--theme-primary-color);
	padding: 0;
	text-align: left;
	font-size: 12px;
	overflow-wrap: anywhere;
	cursor: pointer;
}
.detail-section {
	border-top: 1px solid var(--theme-border-color-light);
	padding-top: 20px;
	margin-top: 24px;
}
h4 {
	font-size: 14px;
	margin: 0 0 14px;
}
.answer-comparison {
	display: grid;
	gap: 8px;
}
.answer-source {
	display: grid;
	gap: 6px;
	padding: 12px 14px;
	background: var(--theme-bg-color-deep);
	border-radius: 9px;
}
.answer-source > span {
	color: var(--theme-text-color-secondary);
	font-size: 12px;
}
.answer-source strong {
	font-size: 14px;
	font-weight: 500;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}
.answer-source small {
	color: var(--theme-text-color-secondary);
	line-height: 1.7;
}
.final-answer {
	border: 1px solid rgb(var(--primary-3));
}
.answer-editor {
	margin: 14px 0;
	width: 100%;
}
.answer-editor :deep(.arco-checkbox),
.answer-editor :deep(.arco-radio) {
	white-space: normal;
	align-items: start;
	margin: 0 0 10px;
}
.blank-editor {
	margin: 14px 0;
}
.blank-row {
	display: flex;
	align-items: center;
	gap: 10px;
	margin-bottom: 10px;
}
.blank-row > span {
	flex-shrink: 0;
	font-size: 12px;
}
.apply-answer {
	margin-top: 14px;
}
.timeline {
	list-style: none;
	padding: 0;
}
.timeline li {
	display: flex;
	gap: 12px;
	position: relative;
	padding: 0 0 18px;
}
.timeline li:not(:last-child):before {
	content: '';
	position: absolute;
	left: 4px;
	top: 11px;
	bottom: 0;
	width: 1px;
	background: var(--theme-border-color-light);
}
.timeline-dot {
	flex-shrink: 0;
	height: 9px;
	width: 9px;
	background: rgb(var(--primary-5));
	border-radius: 50%;
	margin-top: 5px;
}
.timeline strong {
	font-size: 12px;
	margin-right: 10px;
}
.timeline p {
	margin: 5px 0 0;
	font-size: 12px;
	line-height: 1.7;
	color: var(--theme-text-color-secondary);
}
.call-summary {
	display: grid;
	gap: 10px;
	margin-bottom: 14px;
}
.call-summary > div {
	display: flex;
	flex-wrap: wrap;
	gap: 10px;
	font-size: 12px;
}
.call-summary span {
	color: var(--theme-text-color-secondary);
	min-width: 90px;
}
.call-summary strong {
	font-weight: 500;
}
code,
pre {
	font-family: monospace;
	font-size: 11px;
	overflow-wrap: anywhere;
}
pre {
	white-space: pre-wrap;
	max-height: 320px;
	overflow: auto;
	padding: 12px;
	background: var(--theme-bg-color-deep);
	border-radius: 8px;
}
details {
	margin: 12px 0;
}
summary {
	cursor: pointer;
	color: var(--theme-primary-color);
	font-size: 12px;
}
.record-id {
	overflow-wrap: anywhere;
	margin-top: 24px;
}
</style>
