<template>
	<div class="question-settings">
		<div class="settings-heading">
			<div>
				<h2>智能搜题</h2>
				<p>连接本地 Codex，设置搜题与答案采用方式。</p>
			</div>
			<a-switch
				v-model="settings.enabled"
				checked-text="开启"
				unchecked-text="关闭"
			/>
		</div>
		<a-alert
			v-if="error"
			type="error"
			closable
			@close="error = ''"
			>{{ error }}</a-alert
		>
		<a-spin
			:loading="loading"
			style="width: 100%"
		>
			<a-form
				:model="settings"
				layout="vertical"
			>
				<section class="settings-section">
					<div class="section-heading">
						<h3>本地连接</h3>
						<a-tag
							v-if="health"
							:color="health.available ? 'green' : 'red'"
							>{{ health.available ? health.version || '可用' : '不可用' }}</a-tag
						>
					</div>
					<a-form-item label="Codex 可执行文件"
						><a-input
							v-model="settings.command"
							placeholder="自动查找 codex，或填写绝对路径"
							allow-clear
						/><template #extra
							>桌面启动找不到命令时，可指定路径，例如 /home/用户名/.local/bin/codex。</template
						></a-form-item
					>
					<a-form-item label="模型请求代理（可选）">
						<a-input
							v-model="settings.proxyUrl"
							placeholder="例如 http://127.0.0.1:7890，留空继承进程环境"
							allow-clear
						/>
						<template #extra
							>支持 HTTP / HTTPS 代理，仅影响后续 Codex 子进程，不修改系统代理。浏览器和题库保持原有网络配置。</template
						>
					</a-form-item>
					<a-space wrap
						><a-button
							:loading="checking"
							:disabled="dirty"
							@click="checkConnection"
							>检测 CLI</a-button
						><a-button
							:loading="testing"
							:disabled="dirty"
							@click="testConnection"
							>发送测试题</a-button
						><span
							v-if="dirty"
							class="muted"
							>保存后可测试当前配置</span
						></a-space
					>
					<p
						v-if="health?.command"
						class="mono connection-path"
					>
						{{ health.command }}
					</p>
					<a-alert
						v-if="health?.error"
						type="warning"
						>{{ health.error }}</a-alert
					>
					<a-alert
						v-if="health?.overrides.length"
						type="warning"
						>环境变量正在覆盖：{{ health.overrides.join('、') }}。实际调用以环境变量为准。</a-alert
					>
					<div
						v-if="testCall"
						class="test-result"
					>
						<a-tag :color="testCall.status === 'success' ? 'green' : 'red'">{{
							testCall.status === 'success' ? '测试成功' : '测试失败'
						}}</a-tag
						><span>{{ testCall.answer?.join('；') || testCall.error || '无有效答案' }}</span
						><span class="muted">{{
							testCall.finishedAt ? ((testCall.finishedAt - testCall.startedAt) / 1000).toFixed(1) + ' 秒' : ''
						}}</span>
					</div>
				</section>
				<section class="settings-section">
					<div class="section-heading">
						<h3>模型与思考强度</h3>
						<a-button
							size="small"
							:loading="refreshingModels"
							@click="refreshModels"
							>刷新模型目录</a-button
						>
					</div>
					<p class="muted">目录来源：{{ catalog.source || '尚未读取' }}。未知能力不会当作已支持。</p>
					<h4>首次作答</h4>
					<ModelProfile
						v-model="settings.answer"
						:catalog="catalog"
					/>
					<div class="adjudication-heading">
						<h4>二次裁决</h4>
						<a-checkbox
							:model-value="settings.adjudication === null"
							@change="toggleAdjudication"
							>沿用首次作答配置</a-checkbox
						>
					</div>
					<ModelProfile
						v-if="settings.adjudication"
						v-model="settings.adjudication"
						:catalog="catalog"
					/>
				</section>
				<section class="settings-section">
					<h3>答案策略</h3>
					<a-radio-group
						v-model="settings.strategy"
						direction="vertical"
						class="strategy-options"
					>
						<a-radio value="consensus"
							><strong>双源校验</strong><span>题库与模型并行，一致时采用，冲突时独立裁决。</span></a-radio
						>
						<a-radio value="bank-first"
							><strong>题库优先</strong><span>题库答案一致时直接采用，缺失或冲突时调用模型。</span></a-radio
						>
						<a-radio value="model-only"
							><strong>仅模型</strong><span>跳过题库，保留答案校验、复核和填写流程。</span></a-radio
						>
					</a-radio-group>
					<a-alert class="policy-notice"
						>章节测试和作业最多追加两轮补答，确认全部填写后自动提交；正式考试保留手动提交。未解决题目会阻止自动提交。</a-alert
					>
				</section>
				<section class="settings-section">
					<h3>运行参数</h3>
					<div class="runtime-grid">
						<a-form-item label="模型并发上限"
							><a-input-number
								v-model="settings.maxConcurrent"
								:min="1"
								:max="8"
								:precision="0" /></a-form-item
						><a-form-item label="单次超时（秒）"
							><a-input-number
								v-model="timeoutSeconds"
								:min="10"
								:max="600"
								:precision="0"
						/></a-form-item>
					</div>
					<p class="muted">设置对后续调用生效，正在运行的任务保留原配置。</p>
				</section>
			</a-form>
		</a-spin>
		<div class="save-bar">
			<span :class="dirty ? 'unsaved' : 'muted'">{{
				dirty ? '有未保存的更改' : savedAt ? '已保存 · ' + formatTime(savedAt) : '设置已载入'
			}}</span
			><a-space
				><a-button
					:disabled="!dirty || saving"
					@click="reload"
					>撤销更改</a-button
				><a-button
					type="primary"
					:loading="saving"
					:disabled="loading || !dirty"
					@click="save"
					>保存设置</a-button
				></a-space
			>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Message } from '@arco-design/web-vue';
import { DEFAULT_QUESTION_SETTINGS } from '@ocs-desktop/common/web';
import type { QuestionCall, QuestionHealth, QuestionModelCatalog, QuestionSettings } from '@ocs-desktop/common/web';
import { remote } from '../../utils/remote';
import ModelProfile from './ModelProfile.vue';
import { formatTime } from './presentation';

function copy<T>(value: T): T {
	return JSON.parse(JSON.stringify(value));
}
const settings = ref<QuestionSettings>(copy(DEFAULT_QUESTION_SETTINGS));
const saved = ref('');
const loading = ref(true);
const saving = ref(false);
const checking = ref(false);
const testing = ref(false);
const refreshingModels = ref(false);
const error = ref('');
const savedAt = ref(0);
const health = ref<QuestionHealth>();
const testCall = ref<QuestionCall>();
const catalog = ref<QuestionModelCatalog>({ models: [], source: '', revision: '' });
const dirty = computed(() => saved.value !== '' && JSON.stringify(settings.value) !== saved.value);
const timeoutSeconds = computed({
	get: () => settings.value.timeoutMs / 1000,
	set: (value: number) => {
		settings.value.timeoutMs = value * 1000;
	}
});
function failure(cause: unknown) {
	error.value = cause instanceof Error ? cause.message : String(cause);
}
async function reload() {
	loading.value = true;
	try {
		settings.value = copy(await remote.methods.call('questionSettings'));
		saved.value = JSON.stringify(settings.value);
		error.value = '';
	} catch (cause) {
		failure(cause);
	} finally {
		loading.value = false;
	}
}
async function refreshModels() {
	refreshingModels.value = true;
	try {
		catalog.value = await remote.methods.call('questionModels');
	} catch (cause) {
		failure(cause);
	} finally {
		refreshingModels.value = false;
	}
}
async function checkConnection() {
	checking.value = true;
	try {
		health.value = await remote.methods.call('questionHealth');
	} catch (cause) {
		failure(cause);
	} finally {
		checking.value = false;
	}
}
function toggleAdjudication(value: boolean | (string | number | boolean)[]) {
	settings.value.adjudication = value === true ? null : copy(settings.value.answer);
}
async function save() {
	saving.value = true;
	try {
		settings.value = copy(await remote.methods.call('saveQuestionSettings', copy(settings.value)));
		saved.value = JSON.stringify(settings.value);
		savedAt.value = Date.now();
		error.value = '';
		Message.success('搜题设置已保存，后续调用生效');
		await checkConnection();
	} catch (cause) {
		failure(cause);
	} finally {
		saving.value = false;
	}
}
async function testConnection() {
	testing.value = true;
	testCall.value = undefined;
	try {
		testCall.value = await remote.methods.call('questionTest');
	} catch (cause) {
		failure(cause);
	} finally {
		testing.value = false;
	}
}
onMounted(async () => {
	await reload();
	await Promise.all([refreshModels(), checkConnection()]);
});
</script>

<style scoped lang="less">
.question-settings {
	color: var(--theme-text-color);
	padding: 12px 24px 0;
	max-width: 800px;
	margin: 0 auto;
}
.settings-heading,
.section-heading,
.adjudication-heading,
.save-bar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
}
h2 {
	margin: 0;
	font-size: 20px;
}
h3 {
	margin: 0 0 16px;
	font-size: 15px;
}
h4 {
	font-size: 13px;
	margin: 16px 0 12px;
}
.settings-heading {
	margin-bottom: 20px;
}
.settings-heading p,
.muted {
	color: var(--theme-text-color-secondary);
	font-size: 12px;
	line-height: 1.7;
}
.settings-heading p {
	margin: 6px 0 0;
}
.settings-section {
	padding: 22px 0;
	border-bottom: 1px solid var(--theme-border-color-light);
}
.section-heading h3 {
	margin-bottom: 10px;
}
.connection-path {
	font-size: 11px;
	margin: 10px 0;
	overflow-wrap: anywhere;
}
.mono {
	font-family: monospace;
}
.test-result {
	display: flex;
	flex-wrap: wrap;
	gap: 10px;
	align-items: center;
	margin-top: 12px;
}
.strategy-options {
	width: 100%;
}
.strategy-options :deep(.arco-radio) {
	margin: 0 0 12px;
	align-items: start;
}
.strategy-options strong {
	display: block;
	font-size: 13px;
}
.strategy-options span {
	display: block;
	font-size: 12px;
	color: var(--theme-text-color-secondary);
	margin-top: 4px;
}
.policy-notice {
	margin-top: 8px;
}
.runtime-grid {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 24px;
}
.save-bar {
	position: sticky;
	bottom: 0;
	background: var(--theme-card-bg);
	padding: 16px 0;
	border-top: 1px solid var(--theme-border-color-light);
	z-index: 2;
	font-size: 12px;
}
.unsaved {
	color: rgb(var(--orange-6));
}
@media (max-width: 680px) {
	.question-settings {
		padding: 12px 16px 0;
	}
	.runtime-grid {
		grid-template-columns: 1fr;
		gap: 0;
	}
	.save-bar,
	.adjudication-heading {
		flex-wrap: wrap;
	}
}
</style>
