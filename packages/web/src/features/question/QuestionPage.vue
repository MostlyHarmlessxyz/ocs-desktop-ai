<template>
	<div class="question-page">
		<div class="page-heading">
			<div>
				<div class="heading-eyebrow">QUESTION ASSISTANT</div>
				<h1>智能搜题</h1>
				<p>查看答题进度，核对答案来源，处理需要你确认的题目。</p>
			</div>
			<a-space wrap
				><a-button @click="router.push('/setting?panel=question')">搜题设置</a-button
				><a-button
					:loading="loading"
					@click="refresh"
					>刷新</a-button
				><a-button
					type="primary"
					:loading="controlling === 'queue'"
					@click="controlQueue"
					>{{ result.paused ? '恢复后续任务' : '暂停后续任务' }}</a-button
				></a-space
			>
		</div>
		<div class="overview">
			<div>
				<span class="overview-dot running" /><strong>{{ result.active }}</strong
				><span>正在处理</span>
			</div>
			<div>
				<span class="overview-dot pending" /><strong>{{ result.pending }}</strong
				><span>等待复核</span>
			</div>
			<span
				v-if="result.paused"
				class="paused-note"
				>后续任务已暂停，已开始的题目继续处理</span
			><span
				v-else
				class="muted"
				>任务进度自动更新</span
			>
		</div>
		<a-alert
			v-if="error"
			type="error"
			closable
			@close="error = ''"
			>{{ error }}</a-alert
		>
		<a-tabs
			v-model:active-key="tab"
			class="question-tabs"
			><a-tab-pane
				key="active"
				title="当前任务" /><a-tab-pane
				key="history"
				title="搜题记录" /><a-tab-pane
				key="review"
				:title="result.pending ? '待复核 · ' + result.pending : '待复核'"
		/></a-tabs>
		<div class="filters">
			<a-input-search
				v-model="filters.text"
				placeholder="搜索题干"
				allow-clear
				class="search-input"
			/><a-select
				v-model="filters.browserUid"
				placeholder="全部浏览器"
				allow-clear
				allow-search
				><a-option
					v-for="item in browserOptions"
					:key="item.value"
					:value="item.value"
					>{{ item.label }}</a-option
				></a-select
			><a-select
				v-model="filters.type"
				placeholder="全部题型"
				allow-clear
				><a-option
					v-for="(label, key) in typeLabels"
					:key="key"
					:value="key"
					>{{ label }}</a-option
				></a-select
			><template v-if="tab === 'history'"
				><a-select
					v-model="filters.phase"
					placeholder="全部状态"
					allow-clear
					><a-option
						v-for="(label, key) in phaseLabels"
						:key="key"
						:value="key"
						>{{ label }}</a-option
					></a-select
				><a-select
					v-model="filters.source"
					placeholder="全部答案来源"
					allow-clear
					><a-option
						v-for="(label, key) in sourceLabels"
						:key="key"
						:value="key"
						>{{ label }}</a-option
					></a-select
				></template
			>
			<div class="date-filter">
				<label
					><span>从</span
					><input
						v-model="filters.from"
						type="date"
						aria-label="开始日期" /></label
				><label
					><span>至</span
					><input
						v-model="filters.to"
						type="date"
						aria-label="结束日期"
				/></label>
			</div>
			<a-button
				v-if="hasFilters"
				type="text"
				@click="clearFilters"
				>清除筛选</a-button
			>
		</div>
		<a-spin
			:loading="loading"
			class="results-spin"
			><div
				v-if="result.items.length"
				class="task-groups"
			>
				<section
					v-for="group in groups"
					:key="group.uid"
					class="task-group"
				>
					<div
						v-if="tab === 'active'"
						class="group-heading"
					>
						<span class="group-icon">◉</span><strong>{{ browserName(group.uid) }}</strong
						><span class="muted">{{ group.items.length }} 题</span>
					</div>
					<article
						v-for="task in group.items"
						:key="task.id"
						class="task-row"
						tabindex="0"
						role="button"
						@click="openDetail(task.id)"
						@keydown.enter="openDetail(task.id)"
					>
						<div class="task-row-content">
							<div class="task-badges">
								<a-tag
									size="small"
									:color="phaseColor(task.phase)"
									>{{ phaseLabels[task.phase] }}</a-tag
								><span>{{ typeLabels[task.input.type || ''] || task.input.type || '未知题型' }}</span
								><span v-if="tab !== 'active'">{{ browserName(task.input.browserUid || '') }}</span
								><span v-if="task.input.formalExam">正式考试</span
								><span v-else-if="task.input.assessment">测试 / 作业</span><span v-if="task.expired">已过期</span>
							</div>
							<h3>{{ task.input.question }}</h3>
							<div class="task-summary">
								<span
									v-if="task.answer?.length"
									class="adopted-answer"
									>{{ task.answer.join('；') }}</span
								><span
									v-if="task.decisionSource"
									class="source-label"
									>{{ sourceLabels[task.decisionSource] }}</span
								><span
									v-if="task.error"
									class="task-error"
									>{{ task.error }}</span
								><span
									v-else-if="task.reason"
									class="muted"
									>{{ task.reason }}</span
								>
							</div>
							<div class="row-footer">
								<time>{{ formatTime(task.updatedAt) }}</time
								><span>{{ strategyLabels[task.strategy] }}</span
								><span v-if="!task.pageConnected">页面已断开</span
								><span v-if="task.callIds.length">{{ task.callIds.length }} 次模型调用</span>
							</div>
						</div>
						<div
							class="row-actions"
							@click.stop
							@keydown.stop
						>
							<a-button
								v-if="retryable(task)"
								size="small"
								:loading="controlling === task.id"
								@click="control('retry', task.id)"
								>重试</a-button
							><a-button
								v-if="cancellable(task)"
								size="small"
								:loading="controlling === task.id"
								@click="control('cancel', task.id)"
								>取消</a-button
							><a-button
								size="small"
								type="text"
								@click="openDetail(task.id)"
								>{{ task.phase === 'review' ? '去复核' : '详情' }}</a-button
							>
						</div>
					</article>
				</section>
			</div>
			<a-empty
				v-else
				:description="emptyTitle"
				class="empty-state"
				><template #image
					><span class="empty-icon">{{ tab === 'review' ? '✓' : '⌕' }}</span></template
				>
				<p>{{ emptyDescription }}</p>
				<a-button
					v-if="!hasFilters && tab === 'active'"
					@click="router.push('/browsers')"
					>前往浏览器列表</a-button
				></a-empty
			></a-spin
		>
		<div
			v-if="result.total > pageSize"
			class="pagination"
		>
			<a-pagination
				v-model:current="page"
				:total="result.total"
				:page-size="pageSize"
				show-total
			/>
		</div>
		<a-drawer
			:visible="!!selectedId"
			:width="drawerWidth"
			title="题目详情"
			:footer="false"
			unmount-on-close
			@cancel="closeDetail"
			><a-spin
				:loading="detailLoading"
				style="width: 100%"
				><a-alert
					v-if="detailError"
					type="error"
					>{{ detailError }}</a-alert
				><QuestionDetail
					v-if="detail"
					:task="detail.task"
					:calls="detail.calls"
					@updated="refreshAfterResolution" /></a-spin
		></a-drawer>
	</div>
</template>

<script setup lang="ts">
import { computed, onDeactivated, onUnmounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { QuestionCall, QuestionList, QuestionPhase, QuestionTask } from '@ocs-desktop/common/web';
import { remote } from '../../utils/remote';
import { store } from '../../store';
import QuestionDetail from './QuestionDetail.vue';
import { formatTime, phaseColor, phaseLabels, sourceLabels, strategyLabels, typeLabels } from './presentation';
import { useQuestionUpdates } from './useQuestionUpdates';

const router = useRouter();
const route = useRoute();
const tab = ref(route.query.tab === 'review' ? 'review' : route.query.tab === 'history' ? 'history' : 'active');
const filters = reactive({ text: '', browserUid: '', type: '', phase: '', source: '', from: '', to: '' });
const page = ref(1);
const pageSize = 30;
const result = ref<QuestionList>({ items: [], total: 0, active: 0, pending: 0, paused: false });
const loading = ref(false);
const error = ref('');
const controlling = ref('');
const selectedId = ref('');
const detail = ref<{ task: QuestionTask; calls: QuestionCall[] }>();
const detailError = ref('');
const detailLoading = ref(false);
const drawerWidth = 'min(760px, calc(100vw - 24px))';
let requestSequence = 0;
let detailSequence = 0;
let filterTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
const browserNames = computed(() => {
	const names = new Map<string, string>();
	const visit = (node: any) => {
		if (!node || typeof node !== 'object') return;
		if (node.uid && node.type === 'browser') names.set(String(node.uid), String(node.name || node.uid));
		for (const child of Object.values(node.children || {})) visit(child);
	};
	visit(store.render.browser.root);
	return names;
});
function browserName(uid: string) {
	return browserNames.value.get(uid) || (uid ? '浏览器 ' + uid.slice(0, 10) : '未知浏览器');
}
const browserOptions = computed(() => {
	const choices = new Map(browserNames.value);
	for (const task of result.value.items) {
		const uid = task.input.browserUid;
		if (uid && !choices.has(uid)) choices.set(uid, browserName(uid));
	}
	return [...choices].map(([value, label]) => ({ value, label }));
});
const hasFilters = computed(() => Object.values(filters).some(Boolean));
const groups = computed(() => {
	if (tab.value !== 'active') return [{ uid: 'all', items: result.value.items }];
	const grouped = new Map<string, QuestionTask[]>();
	for (const task of result.value.items) {
		const uid = task.input.browserUid || '';
		if (!grouped.has(uid)) grouped.set(uid, []);
		grouped.get(uid)!.push(task);
	}
	return [...grouped].map(([uid, items]) => ({ uid, items }));
});
const emptyTitle = computed(() =>
	hasFilters.value
		? '没有符合筛选条件的题目'
		: tab.value === 'review'
		? '暂无待复核题目'
		: tab.value === 'history'
		? '还没有搜题记录'
		: '当前没有正在处理的题目'
);
const emptyDescription = computed(() =>
	hasFilters.value
		? '调整条件或清除筛选后再试。'
		: tab.value === 'review'
		? '需要你确认答案时，会在这里集中显示。'
		: '从受管浏览器启动 OCS 答题后，进度和答案会显示在这里。'
);
function clearFilters() {
	Object.assign(filters, { text: '', browserUid: '', type: '', phase: '', source: '', from: '', to: '' });
}
function cancellable(task: QuestionTask) {
	return ['queued', 'bank', 'answering', 'comparing', 'adjudicating', 'filling', 'retrying'].includes(task.phase);
}
function retryable(task: QuestionTask) {
	return ['error', 'cancelled', 'review'].includes(task.phase) && task.pageConnected;
}
async function refresh() {
	const sequence = ++requestSequence;
	loading.value = true;
	try {
		const next = await remote.methods.call('questionList', {
			text: filters.text || undefined,
			browserUid: filters.browserUid || undefined,
			type: filters.type || undefined,
			phase:
				tab.value === 'active'
					? 'active'
					: tab.value === 'review'
					? 'review'
					: (filters.phase as QuestionPhase) || undefined,
			source: filters.source || undefined,
			from: filters.from ? new Date(filters.from + 'T00:00:00').getTime() : undefined,
			to: filters.to ? new Date(filters.to + 'T23:59:59.999').getTime() : undefined,
			page: page.value,
			pageSize
		});
		if (disposed || sequence !== requestSequence) return;
		result.value = next;
		error.value = '';
		if (page.value > 1 && !next.items.length && next.total > 0) {
			page.value = Math.max(1, Math.ceil(next.total / pageSize));
			return;
		}
		if (selectedId.value) await loadDetail(selectedId.value, false);
	} catch (cause) {
		if (!disposed && sequence === requestSequence) error.value = cause instanceof Error ? cause.message : String(cause);
	} finally {
		if (!disposed && sequence === requestSequence) loading.value = false;
	}
}
async function loadDetail(id: string, showLoading = true) {
	const sequence = ++detailSequence;
	if (showLoading) detailLoading.value = true;
	try {
		const next = await remote.methods.call('questionDetail', id);
		if (!disposed && sequence === detailSequence && selectedId.value === id) {
			detail.value = next;
			detailError.value = '';
		}
	} catch (cause) {
		if (!disposed && sequence === detailSequence)
			detailError.value = cause instanceof Error ? cause.message : String(cause);
	} finally {
		if (!disposed && sequence === detailSequence) detailLoading.value = false;
	}
}
function openDetail(id: string) {
	selectedId.value = id;
	detail.value = undefined;
	detailError.value = '';
	loadDetail(id);
}
function closeDetail() {
	selectedId.value = '';
	detail.value = undefined;
	detailSequence++;
	detailLoading.value = false;
}
async function refreshAfterResolution() {
	await refresh();
}
async function control(action: 'pause' | 'resume' | 'cancel' | 'retry', id?: string) {
	controlling.value = id || 'queue';
	try {
		await remote.methods.call('questionControl', action, id);
		await refresh();
	} catch (cause) {
		error.value = cause instanceof Error ? cause.message : String(cause);
	} finally {
		controlling.value = '';
	}
}
function controlQueue() {
	control(result.value.paused ? 'resume' : 'pause');
}
watch([tab, () => ({ ...filters })], () => {
	clearTimeout(filterTimer);
	page.value = 1;
	filterTimer = setTimeout(() => {
		if (!disposed) refresh();
	}, 300);
});
watch(tab, (value) => {
	if (route.name !== 'questions') return;
	router.replace({ query: { ...route.query, tab: value === 'active' ? undefined : value } });
});
watch(
	() => route.query.tab,
	(value) => {
		if (route.name !== 'questions') return;
		const next = value === 'review' ? 'review' : value === 'history' ? 'history' : 'active';
		if (next !== tab.value) tab.value = next;
	}
);
watch(page, () => {
	if (!disposed) refresh();
});
useQuestionUpdates(refresh);
onDeactivated(() => {
	closeDetail();
	requestSequence++;
	clearTimeout(filterTimer);
});
onUnmounted(() => {
	disposed = true;
	requestSequence++;
	detailSequence++;
	clearTimeout(filterTimer);
});
</script>

<style scoped lang="less">
.question-page {
	height: 100%;
	overflow: auto;
	padding: 28px 32px;
	color: var(--theme-text-color);
	background: var(--theme-bg-color-deep);
}
.page-heading {
	display: flex;
	justify-content: space-between;
	align-items: center;
	gap: 24px;
	margin: 0 0 24px;
}
.heading-eyebrow {
	font-size: 10px;
	letter-spacing: 2px;
	color: var(--theme-text-color-secondary);
	margin-bottom: 7px;
}
h1 {
	font-size: 25px;
	letter-spacing: 0.5px;
	margin: 0;
}
.page-heading p {
	color: var(--theme-text-color-secondary);
	margin: 8px 0 0;
	font-size: 12px;
	line-height: 1.8;
}
.overview {
	display: flex;
	gap: 24px;
	align-items: center;
	flex-wrap: wrap;
	border: 1px solid var(--theme-border-color-light);
	border-radius: 12px;
	background: var(--theme-card-bg);
	padding: 16px 20px;
	margin-bottom: 20px;
}
.overview > div {
	display: flex;
	align-items: center;
	gap: 9px;
}
.overview strong {
	font-size: 21px;
	font-weight: 600;
}
.overview > div > span:last-child {
	font-size: 12px;
	color: var(--theme-text-color-secondary);
}
.overview-dot {
	height: 7px;
	width: 7px;
	border-radius: 50%;
}
.running {
	background: rgb(var(--primary-6));
}
.pending {
	background: rgb(var(--orange-6));
}
.paused-note {
	color: rgb(var(--orange-6));
	font-size: 12px;
}
.muted {
	color: var(--theme-text-color-secondary);
	font-size: 12px;
}
.question-tabs :deep(.arco-tabs-content) {
	display: none;
}
.filters {
	display: flex;
	flex-wrap: wrap;
	gap: 10px;
	margin: 16px 0 20px;
}
.filters > :deep(.arco-select) {
	width: 150px;
}
.filters .search-input {
	width: 240px;
}
.date-filter {
	display: flex;
	gap: 10px;
}
.date-filter label {
	display: flex;
	align-items: center;
	gap: 7px;
	font-size: 12px;
	color: var(--theme-text-color-secondary);
}
.date-filter input {
	border: 1px solid var(--theme-border-color-light);
	background: var(--theme-card-bg);
	color: var(--theme-text-color);
	border-radius: 5px;
	padding: 4px 7px;
	min-width: 120px;
	color-scheme: light dark;
}
.results-spin {
	width: 100%;
	min-height: 180px;
}
.task-groups {
	display: grid;
	gap: 20px;
}
.group-heading {
	display: flex;
	align-items: center;
	gap: 8px;
	margin: 0 0 10px;
}
.group-heading strong {
	font-size: 13px;
	font-weight: 500;
}
.group-icon {
	color: var(--theme-primary-color);
}
.task-row {
	display: flex;
	justify-content: space-between;
	align-items: center;
	gap: 18px;
	background: var(--theme-card-bg);
	border: 1px solid var(--theme-border-color-light);
	border-radius: 10px;
	margin-bottom: 8px;
	padding: 16px 18px;
	cursor: pointer;
	transition: border-color 0.15s;
	outline: none;
}
.task-row:hover,
.task-row:focus-visible {
	border-color: rgb(var(--primary-4));
}
.task-row-content {
	min-width: 0;
	flex: 1;
}
.task-badges {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 10px;
	font-size: 11px;
	color: var(--theme-text-color-secondary);
}
.task-row h3 {
	font-size: 14px;
	line-height: 1.7;
	margin: 10px 0 8px;
	font-weight: 500;
	overflow: hidden;
	display: -webkit-box;
	-webkit-line-clamp: 2;
	-webkit-box-orient: vertical;
	overflow-wrap: anywhere;
}
.task-summary {
	display: flex;
	gap: 8px;
	align-items: baseline;
	flex-wrap: wrap;
	font-size: 12px;
}
.adopted-answer {
	color: var(--theme-primary-color);
	max-width: 100%;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.source-label {
	color: var(--theme-text-color-secondary);
	border-left: 1px solid var(--theme-border-color-light);
	padding-left: 8px;
}
.task-error {
	color: rgb(var(--red-6));
}
.row-footer {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 12px;
	margin-top: 10px;
	color: var(--theme-text-color-secondary);
	font-size: 10px;
}
.row-actions {
	display: flex;
	gap: 6px;
	flex-shrink: 0;
}
.empty-state {
	padding: 46px 16px;
	background: var(--theme-card-bg);
	border-radius: 12px;
	border: 1px solid var(--theme-border-color-light);
}
.empty-state p {
	color: var(--theme-text-color-secondary);
	font-size: 12px;
}
.empty-icon {
	display: inline-grid;
	place-items: center;
	width: 64px;
	height: 64px;
	border-radius: 20px;
	background: rgb(var(--primary-1));
	color: var(--theme-primary-color);
	font-size: 32px;
}
.pagination {
	display: flex;
	justify-content: flex-end;
	margin-top: 20px;
}
@media (max-width: 1000px) {
	.page-heading {
		align-items: start;
		flex-direction: column;
		gap: 16px;
	}
	.question-page {
		padding: 22px 20px;
	}
	.task-row {
		align-items: start;
	}
	.row-actions {
		flex-direction: column;
	}
}
@media (max-width: 640px) {
	.question-page {
		padding: 16px 12px;
	}
	.overview {
		gap: 14px;
		padding: 12px;
	}
	.filters .search-input {
		width: 100%;
	}
	.filters > :deep(.arco-select) {
		width: calc(50% - 5px);
	}
	.task-row {
		padding: 12px;
		gap: 8px;
	}
	.date-filter {
		flex-wrap: wrap;
	}
}
</style>
