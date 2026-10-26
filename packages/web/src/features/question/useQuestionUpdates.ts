import { onActivated, onDeactivated, onMounted, onUnmounted } from 'vue';
import { electron } from '../../utils/node';

/** Subscribe before the initial read so an update cannot be missed during navigation. */
export function useQuestionUpdates(refresh: () => Promise<void>) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;
	let listening = false;
	const onChanged = () => {
		if (disposed || !listening || timer) return;
		timer = setTimeout(() => {
			timer = undefined;
			if (!disposed && listening) refresh();
		}, 250);
	};
	const start = () => {
		if (disposed || listening) return;
		listening = true;
		electron.ipcRenderer.on('question-changed', onChanged);
		refresh();
	};
	const stop = () => {
		listening = false;
		clearTimeout(timer);
		timer = undefined;
		electron.ipcRenderer.removeListener?.('question-changed', onChanged);
	};
	onMounted(start);
	onActivated(start);
	onDeactivated(stop);
	onUnmounted(() => {
		disposed = true;
		stop();
	});
}
