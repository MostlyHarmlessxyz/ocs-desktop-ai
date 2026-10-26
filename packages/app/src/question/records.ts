import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import type { QuestionCall, QuestionTask } from '@ocs-desktop/common';
import { redact } from './client';

/** Single writer; snapshots use rename so interrupted writes cannot corrupt the last good state. */
export class QuestionRecords {
	private tail = Promise.resolve();
	private pendingTasks?: QuestionTask[];
	private scheduled = false;
	error?: string;
	constructor(readonly directory: string) {
		fs.mkdirSync(directory, { recursive: true });
	}

	private enqueue(work: () => Promise<void>) {
		this.tail = this.tail.then(work).catch((error) => {
			this.error = `记录保存失败：${(error as Error).message}`;
			console.error(this.error);
		});
		return this.tail;
	}

	load(): QuestionTask[] {
		try {
			const file = path.join(this.directory, 'tasks.json');
			if (!fs.existsSync(file)) return [];
			const data = JSON.parse(fs.readFileSync(file, 'utf8'));
			return Array.isArray(data) ? data.filter((t) => t?.id && t.input && Array.isArray(t.timeline)).slice(-2000) : [];
		} catch (error) {
			this.error = `记录读取失败：${(error as Error).message}`;
			return [];
		}
	}

	saveTasks(tasks: QuestionTask[]) {
		// Copy mutable metadata, but retain immutable image strings until they are
		// moved to files below. JSON-roundtripping all base64 attachments on every
		// progress event needlessly doubles the memory used by large image questions.
		this.pendingTasks = tasks.slice(-2000).map((task) => {
			const snapshot = JSON.parse(
				JSON.stringify({ ...task, input: { ...task.input, images: undefined } })
			) as QuestionTask;
			snapshot.input.images = task.input.images?.slice();
			return snapshot;
		});
		if (this.scheduled) return;
		this.scheduled = true;
		this.enqueue(async () => {
			try {
				while (this.pendingTasks) {
					const snapshot = this.pendingTasks;
					this.pendingTasks = undefined;
					for (const task of snapshot) {
						task.input.images = await Promise.all(
							(task.input.images || []).map(async (source) => {
								if (!source.startsWith('data:image/')) return source;
								const hash = createHash('sha256').update(source).digest('hex');
								const imageDir = path.join(this.directory, 'images');
								await fs.promises.mkdir(imageDir, { recursive: true });
								const imageFile = path.join(imageDir, hash + '.txt');
								if (!fs.existsSync(imageFile)) await fs.promises.writeFile(imageFile, source, { mode: 0o600 });
								return `ocs-image:${hash}`;
							})
						);
					}
					const file = path.join(this.directory, 'tasks.json');
					await fs.promises.writeFile(file + '.tmp', JSON.stringify(snapshot), { mode: 0o600 });
					await fs.promises.rename(file + '.tmp', file);
					const used = new Set(
						snapshot
							.flatMap((t) => t.input.images || [])
							.filter((s) => s.startsWith('ocs-image:'))
							.map((s) => s.slice(10) + '.txt')
					);
					const imageDir = path.join(this.directory, 'images');
					if (fs.existsSync(imageDir)) {
						for (const name of await fs.promises.readdir(imageDir)) {
							if (!used.has(name)) await fs.promises.unlink(path.join(imageDir, name));
						}
					}
				}
			} finally {
				this.scheduled = false;
			}
		});
	}

	async hydrate(task: QuestionTask): Promise<QuestionTask> {
		const result = JSON.parse(JSON.stringify(task)) as QuestionTask;
		result.input.images = await Promise.all(
			(result.input.images || []).map(async (source) => {
				if (!/^ocs-image:[a-f0-9]{64}$/.test(source)) return source;
				try {
					return await fs.promises.readFile(path.join(this.directory, 'images', source.slice(10) + '.txt'), 'utf8');
				} catch {
					return '';
				}
			})
		);
		return result;
	}

	saveCall(call: QuestionCall) {
		const line = redact(JSON.stringify(call));
		return this.enqueue(async () => {
			const file = path.join(this.directory, 'calls.jsonl');
			await fs.promises.appendFile(file, line + '\n', { mode: 0o600 });
			// Bounded archive. Keep only completed invocations; active calls live in the service.
			const all = (await fs.promises.readFile(file, 'utf8')).trim().split('\n');
			let bytes = 0;
			const retained: string[] = [];
			for (const item of all.reverse()) {
				const size = Buffer.byteLength(item) + 1;
				if (retained.length >= 2000 || bytes + size > 16 * 1024 * 1024) break;
				retained.push(item);
				bytes += size;
			}
			if (retained.length !== all.length) {
				await fs.promises.writeFile(file + '.tmp', retained.reverse().join('\n') + '\n', { mode: 0o600 });
				await fs.promises.rename(file + '.tmp', file);
			}
		});
	}

	async calls(ids: string[]) {
		await this.flush();
		try {
			const all = await fs.promises.readFile(path.join(this.directory, 'calls.jsonl'), 'utf8');
			return all.split('\n').flatMap((line) => {
				try {
					const call = JSON.parse(line) as QuestionCall;
					return ids.includes(call.id) ? [call] : [];
				} catch {
					return [];
				}
			});
		} catch {
			return [];
		}
	}

	flush() {
		return this.tail;
	}
}
