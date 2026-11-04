// Keeps a NotesIndex in step with its folder by sweeping it: a note that is new or whose sha changed is re-indexed, a
// note that disappeared is removed, an unchanged one is left alone. A sweep, not a queue of events: sync tools
// (Obsidian LiveSync, Syncthing, git pulls) change the folder without telling this process. Writes made through the
// tools call touch() so the note is searchable at once.
import { chunkText, type Embedder, safeError } from "@pitolabs/agent-docs";
import type { NotesFolder } from "./folder.ts";
import { parseNote } from "./frontmatter.ts";
import type { NotesIndex } from "./store.ts";

/** A note whose embedding failed this many times is left out of the vectors until its text changes. */
const MAX_ATTEMPTS = 3;

export interface NotesIndexerDeps {
	folder: NotesFolder;
	index: NotesIndex;
	embedder: Embedder;
	/** Log prefix, e.g. "[notes]". */
	log: string;
	now?: () => Date;
	/** Between sweeps; default 10 min. */
	intervalMs?: number;
	/** Before the first sweep; default 30 s. */
	bootDelayMs?: number;
}

export interface ReconcileResult {
	added: number;
	changed: number;
	removed: number;
	failed: number;
	retried: number;
}

export class NotesIndexer {
	private timers: NodeJS.Timeout[] = [];
	private sweep?: Promise<ReconcileResult>;
	private now: () => Date;

	constructor(private deps: NotesIndexerDeps) {
		this.now = deps.now ?? (() => new Date());
	}

	/** reconcile() after bootDelayMs, then every intervalMs; the timers never keep the process alive. */
	start(): void {
		const run = () => {
			this.reconcile().catch((e) => console.error(`${this.deps.log} notes sweep failed: ${safeError(e)}`));
		};
		const boot = setTimeout(run, this.deps.bootDelayMs ?? 30_000);
		const every = setInterval(run, this.deps.intervalMs ?? 10 * 60_000);
		boot.unref();
		every.unref();
		this.timers.push(boot, every);
	}

	stop(): void {
		for (const t of this.timers) clearTimeout(t);
		this.timers = [];
	}

	/** Single-flight: a call during another sweep gets the same promise. */
	reconcile(): Promise<ReconcileResult> {
		this.sweep ??= this.reconcileOnce().finally(() => {
			this.sweep = undefined;
		});
		return this.sweep;
	}

	private async reconcileOnce(): Promise<ReconcileResult> {
		const r: ReconcileResult = { added: 0, changed: 0, removed: 0, failed: 0, retried: 0 };
		const known = new Map((await this.deps.index.known()).map((k) => [k.path, k]));
		const onDisk = await this.deps.folder.listNotes();
		const seen = new Set<string>();
		// One note at a time: a folder of notes is small, and the embeddings provider sees one request at a time.
		for (const { path } of onDisk) {
			seen.add(path);
			const note = await this.deps.folder.readNote(path);
			if (!note) continue;
			const k = known.get(path);
			let kind: "added" | "changed" | "retried" | undefined;
			if (!k) kind = "added";
			else if (k.sha256 !== note.sha) kind = "changed";
			else if (k.state !== "indexed" && k.attempts < MAX_ATTEMPTS) kind = "retried";
			if (!kind) continue;
			r[kind]++;
			if (!(await this.indexOne(path, note.text, note.sha, kind === "retried"))) r.failed++;
		}
		for (const path of known.keys()) {
			if (seen.has(path)) continue;
			await this.deps.index.remove(path);
			r.removed++;
		}
		return r;
	}

	/** Re-indexes one note now (after a write); a note that no longer exists is removed from the index. */
	async touch(path: string): Promise<void> {
		const note = await this.deps.folder.readNote(path);
		if (!note) await this.deps.index.remove(path);
		else await this.indexOne(note.path, note.text, note.sha);
	}

	/**
	 * Text first (keyword search works at once), then the vectors. A retry keeps the stored text and its attempt count
	 * (the text did not change; re-storing it would reset the count). False when the vectors failed.
	 */
	private async indexOne(path: string, text: string, sha: string, retry = false): Promise<boolean> {
		const p = parseNote(path, text);
		if (!retry) {
			await this.deps.index.upsertText({
				path,
				sha256: sha,
				bytes: Buffer.byteLength(text),
				title: p.title,
				tags: p.tags,
				...(p.modified ? { modified: p.modified } : {}),
				text: p.body,
			});
		}
		try {
			const chunks = chunkText(p.body);
			const vectors = chunks.length
				? await this.deps.embedder.embed(
						chunks.map((c) => `${p.title}\n\n${c}`),
						"document",
					)
				: [];
			await this.deps.index.markIndexed(
				path,
				chunks.map((c, i) => ({ text: c, vector: vectors[i] ?? [] })),
				this.now(),
			);
			return true;
		} catch (e) {
			const err = safeError(e);
			await this.deps.index.markFailed(path, err);
			console.warn(`${this.deps.log} note index failed: ${path}: ${err}`);
			return false;
		}
	}
}
