<template>
	<div class="model-profile">
		<a-radio-group
			:model-value="modelValue.mode"
			type="button"
			@change="changeMode"
		>
			<a-radio value="inherit">跟随 Codex / CC Switch</a-radio>
			<a-radio value="custom">OCS 单独指定</a-radio>
		</a-radio-group>
		<div
			v-if="modelValue.mode === 'inherit'"
			class="inherit-preview"
		>
			<div>模型：{{ catalog.model || '由 Codex 决定' }}</div>
			<div>思考强度：{{ catalog.reasoningEffort || '本机配置未显式指定' }} · 联网搜索：跟随本机配置</div>
			<p>每次新调用读取本机配置，供应商切换无需重新启动。OCS 不修改 Codex 或 CC Switch 的配置。</p>
		</div>
		<template v-else>
			<a-form-item label="模型">
				<a-select
					:model-value="modelValue.model"
					allow-create
					allow-search
					placeholder="选择模型或输入自定义模型 ID"
					@change="changeModel"
				>
					<a-option
						v-for="model in catalog.models"
						:key="model.value"
						:value="model.value"
						>{{ model.label }}</a-option
					>
				</a-select>
			</a-form-item>
			<a-alert
				v-if="modelValue.model && !knownModel"
				type="warning"
				class="profile-notice"
				>自定义模型的能力尚未验证。空强度会继承本机 Codex 配置；手动指定的强度需通过连接测试确认。</a-alert
			>
			<a-form-item label="思考强度">
				<a-select
					:model-value="modelValue.reasoningEffort"
					@change="changeEffort"
				>
					<a-option value="">跟随 Codex 配置</a-option>
					<a-option
						v-for="effort in availableEfforts"
						:key="effort"
						:value="effort"
						>{{ effort }}{{ efforts.length ? '' : '（未验证）' }}</a-option
					>
				</a-select>
				<template #extra>{{
					efforts.length
						? '只显示此模型目录中声明的强度；留空则继承本机配置。'
						: '目录未提供能力列表。可手动指定强度，但这些选项不代表模型已声明支持；留空则继承本机配置。'
				}}</template>
			</a-form-item>
			<a-form-item label="联网搜索">
				<a-select
					:model-value="modelValue.webSearch"
					@change="changeSearch"
				>
					<a-option value="inherit">跟随本机配置</a-option>
					<a-option value="enabled">允许联网搜索</a-option>
					<a-option value="disabled">关闭联网搜索</a-option>
				</a-select>
			</a-form-item>
		</template>
	</div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { QuestionModelCatalog, QuestionModelProfile } from '@ocs-desktop/common/web';
import { effortsFor, selectModel } from './presentation';

const props = defineProps<{ modelValue: QuestionModelProfile; catalog: QuestionModelCatalog }>();
const emit = defineEmits<{ (event: 'update:modelValue', value: QuestionModelProfile): void }>();
const knownModel = computed(() => props.catalog.models.some((entry) => entry.value === props.modelValue.model));
const efforts = computed(() => effortsFor(props.catalog, props.modelValue.model));
const availableEfforts = computed(() =>
	efforts.value.length ? efforts.value : ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
);
function changeMode(value: string | number | boolean) {
	emit('update:modelValue', { ...props.modelValue, mode: value === 'custom' ? 'custom' : 'inherit' });
}
function changeModel(value: unknown) {
	emit('update:modelValue', selectModel(props.modelValue, String(value || ''), props.catalog));
}
function changeEffort(value: unknown) {
	emit('update:modelValue', { ...props.modelValue, reasoningEffort: String(value || '') });
}
function changeSearch(value: unknown) {
	const mode = value === 'enabled' || value === 'disabled' ? value : 'inherit';
	emit('update:modelValue', { ...props.modelValue, webSearch: mode });
}
</script>

<style scoped lang="less">
.model-profile {
	display: grid;
	gap: 16px;
}
.inherit-preview {
	background: var(--theme-bg-color-deep);
	padding: 14px 16px;
	border-radius: 10px;
	line-height: 1.9;
	color: var(--theme-text-color-secondary);
}
.inherit-preview p {
	margin: 6px 0 0;
	font-size: 12px;
}
.profile-notice {
	margin-top: -4px;
}
.model-profile :deep(.arco-form-item) {
	margin-bottom: 0;
}
@media (max-width: 680px) {
	.model-profile :deep(.arco-radio-group) {
		display: flex;
		flex-wrap: wrap;
	}
}
</style>
