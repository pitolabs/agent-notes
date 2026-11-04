// A folder of Markdown notes (an Obsidian vault, or one folder of it) as an agent's knowledge base. The root is fixed
// when the folder is opened; callers pass paths relative to it and every path is checked against what is on disk.
import { createHash, randomBytes } from "node:crypto";
import * as fsSync from "node:fs";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface Note {
	path: string;
	sha: string;
	text: string;
}

/** Lower case, accents removed: how names, tags and words are compared. */
export const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export interface NotesConfig {
	/** The folder's absolute path. */
	dir: string;
	/** Any @libsql/client URL for the index (`file:/data/notes.db`, `:memory:`, `libsql://…`); unset: no index. */
	db?: string;
}

/** <PREFIX>_NOTES_DIR (required, absolute, an existing directory) and <PREFIX>_NOTES_DB (optional, an @libsql/client URL). */
export function notesConfig(prefix: string, env: NodeJS.ProcessEnv = process.env): NotesConfig | { off: string } {
	const dir = env[`${prefix}_NOTES_DIR`] ?? "";
	if (!path.isAbsolute(dir)) return { off: `${prefix}_NOTES_DIR not set` };
	if (!fsSync.existsSync(dir) || !fsSync.statSync(dir).isDirectory()) return { off: `${dir} is not a directory (notes folder not mounted)` };
	const db = env[`${prefix}_NOTES_DB`] || undefined;
	return db ? { dir, db } : { dir };
}

export class NotesFolder {
	private writes: Promise<unknown> = Promise.resolve();
	private constructor(
		private realRoot: string,
		private log: string,
	) {}

	/** The root's real path (symlinks resolved) is the boundary. */
	static async open(cfg: { dir: string }, log: string): Promise<NotesFolder> {
		return new NotesFolder(await fs.realpath(cfg.dir), log);
	}

	/** The folder's real path, resolved when it was opened: an index is pinned to it. */
	get root(): string {
		return this.realRoot;
	}

	/** Every .md under the root. Dot entries and symlinks are skipped, so nothing listed points outside. */
	async listNotes(): Promise<{ path: string }[]> {
		const out: { path: string }[] = [];
		const walk = async (rel: string) => {
			for (const e of await fs.readdir(path.join(this.realRoot, rel), { withFileTypes: true })) {
				if (e.name.startsWith(".")) continue;
				const r = rel ? `${rel}/${e.name}` : e.name;
				if (e.isDirectory()) await walk(r);
				else if (e.isFile() && e.name.endsWith(".md")) out.push({ path: r });
			}
		};
		await walk("");
		return out;
	}

	/** Only listed notes are read; names match in either Unicode form (a Mac may write them decomposed). */
	async readNote(rel: string): Promise<Note | undefined> {
		const want = rel.normalize("NFC");
		const hit = (await this.listNotes()).find((n) => n.path.normalize("NFC") === want);
		if (!hit) return undefined;
		const fh = await fs.open(path.join(this.realRoot, hit.path), constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const text = await fh.readFile("utf8");
			return { path: hit.path, sha: createHash("sha256").update(text).digest("hex"), text };
		} finally {
			await fh.close();
		}
	}

	/** Case- and accent-insensitive; every word must match a line; at most `limit` hits, 300 chars each. */
	async searchNotes(query: string, limit = 40): Promise<{ path: string; line: number; text: string }[]> {
		const words = fold(query).split(/\s+/).filter(Boolean);
		const hits: { path: string; line: number; text: string }[] = [];
		if (!words.length) return hits;
		for (const { path: p } of await this.listNotes()) {
			const note = await this.readNote(p);
			note?.text.split("\n").forEach((text, i) => {
				if (hits.length < limit && words.every((w) => fold(text).includes(w))) hits.push({ path: p, line: i + 1, text: text.slice(0, 300) });
			});
			if (hits.length >= limit) break;
		}
		return hits;
	}

	/**
	 * Create or replace one note. `baseSha` is the content the change was made against (undefined for a new note); if
	 * this copy changed since, the save is refused. Saves in this folder run one at a time, so check and rename never
	 * interleave. Best effort only: an edit still travelling from another device to this folder is not seen.
	 * Returns the path written.
	 */
	putNote(rel: string, text: string, message: string, baseSha: string | undefined): Promise<string> {
		const run = this.writes.then(() => this.write(rel, text, message, baseSha));
		this.writes = run.catch(() => undefined);
		return run;
	}

	private async write(rel: string, text: string, message: string, baseSha: string | undefined): Promise<string> {
		const parts = rel.normalize("NFC").split("/");
		if (parts.some((p) => !p || p === "." || p === ".." || p.startsWith(".")) || !rel.endsWith(".md")) throw new Error(`caminho inválido: ${rel}`);
		const current = await this.readNote(rel);
		if (current ? current.sha !== baseSha : baseSha !== undefined) throw new Error("a nota mudou desde a leitura; leia de novo com read_note");
		const target = path.join(this.realRoot, ...(current ? current.path.split("/") : parts));
		// Walk down from the root one folder at a time, creating what is missing: every existing step must be a real
		// folder, never a symlink, so nothing is created or written outside the root.
		let realDir = this.realRoot;
		for (const seg of path.relative(this.realRoot, path.dirname(target)).split(path.sep).filter(Boolean)) {
			realDir = path.join(realDir, seg);
			const st = await fs.lstat(realDir).catch(() => undefined);
			if (!st) await fs.mkdir(realDir);
			else if (!st.isDirectory()) throw new Error(`caminho fora da base: ${rel}`);
		}
		// A dot temp file in the same folder, renamed over the note: sync tools (Obsidian LiveSync, Syncthing) skip
		// hidden files, so they only ever see the whole note.
		const tmp = path.join(realDir, `.${path.basename(target)}.${randomBytes(4).toString("hex")}.tmp`);
		await fs.writeFile(tmp, text, { flag: "wx" });
		await fs.rename(tmp, path.join(realDir, path.basename(target)));
		const written = current?.path ?? parts.join("/");
		console.error(`${this.log} wrote ${written}: ${message}`);
		return written;
	}
}
