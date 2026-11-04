// The libSQL NotesIndex: one database per notes folder (a `file:`, `:memory:`, or a remote `libsql://` URL with an
// auth token). It holds each note's body and frontmatter fields, an FTS5 table for keyword search (accents folded) and
// chunk embeddings for semantic search (exact cosine scan; a folder of notes is small). The folder stays the source of
// truth: the database is derived state, rebuilt by deleting it (the indexer's sweep re-reads the folder).
//
// The meta table pins the folder's real path and the embeddings model: opening a database built for another folder or
// model is refused (delete the file to re-index).
import { type Client, createClient, type InStatement, type Row } from "@libsql/client";
import { ftsQuery } from "@pitolabs/agent-docs";
import type { NoteHit, NoteRow, NoteSearchArgs, NoteState, NotesIndex } from "./store.ts";

export interface OpenNotesIndexOptions {
	/** Any @libsql/client URL: `file:/data/notes.db`, `:memory:`, `libsql://<db>.turso.io`. */
	url: string;
	/** For remote (`libsql://`) databases. */
	authToken?: string;
	/** The folder's real path: the database is pinned to it. */
	root: string;
	model: string;
	dims: number;
}

const SCHEMA_VERSION = "1";
/** Candidates each ranked list (keywords, vectors) contributes to the fusion. */
const CANDIDATES = 20;
/** Reciprocal rank fusion constant. */
const RRF_K = 60;

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

function toRow(r: Row): NoteRow {
	let tags: string[] = [];
	try {
		tags = JSON.parse(String(r.tags)) as string[];
	} catch {}
	return {
		path: String(r.path),
		sha256: String(r.sha256),
		bytes: Number(r.bytes),
		title: String(r.title),
		tags,
		modified: str(r.modified),
		text: String(r.text),
		state: String(r.state) as NoteState,
		attempts: Number(r.attempts),
		error: str(r.error),
		indexedAt: str(r.indexed_at),
	};
}

export class LibSQLNotesIndex implements NotesIndex {
	private constructor(private db: Client) {}

	static async open(o: OpenNotesIndexOptions): Promise<LibSQLNotesIndex | { off: string }> {
		if (!Number.isInteger(o.dims) || o.dims <= 0) throw new Error(`invalid dims ${o.dims}`);
		const db = createClient({ url: o.url, ...(o.authToken ? { authToken: o.authToken } : {}) });
		try {
			// Readers never block the writer, and a busy file waits instead of failing. Only for a local file: a remote
			// database manages its own journal, and :memory: has none.
			if (o.url.startsWith("file:")) {
				await db.execute("PRAGMA journal_mode=WAL");
				await db.execute("PRAGMA busy_timeout=5000");
			}
			await db.batch(
				[
					"CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
					`CREATE TABLE IF NOT EXISTS notes (path TEXT PRIMARY KEY, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, title TEXT NOT NULL,
						tags TEXT NOT NULL DEFAULT '[]', modified TEXT, text TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending','indexed','failed')),
						attempts INTEGER NOT NULL DEFAULT 0, error TEXT, indexed_at TEXT)`,
					"CREATE INDEX IF NOT EXISTS notes_state ON notes(state)",
					"CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(path UNINDEXED, title, tags, text, tokenize='unicode61 remove_diacritics 2')",
					`CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY, path TEXT NOT NULL, position INTEGER NOT NULL, text TEXT NOT NULL, embedding F32_BLOB(${o.dims}) NOT NULL)`,
					"CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path)",
				],
				"write",
			);
			const meta = new Map((await db.execute("SELECT key, value FROM meta")).rows.map((r) => [String(r.key), String(r.value)]));
			const root = meta.get("root");
			if (root !== undefined && root !== o.root) {
				db.close();
				return { off: `index built for ${root}, got ${o.root}` };
			}
			const model = meta.get("embeddings_model");
			const dims = meta.get("dims");
			if ((model !== undefined && model !== o.model) || (dims !== undefined && dims !== String(o.dims))) {
				db.close();
				return { off: `index built for ${model ?? "?"} (${dims ?? "?"} dims), got ${o.model} (${o.dims} dims); delete the file to re-index` };
			}
			await db.batch(
				[
					["schema_version", SCHEMA_VERSION],
					["root", o.root],
					["embeddings_model", o.model],
					["dims", String(o.dims)],
				].map(([k, v]) => ({
					sql: "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
					args: [k ?? "", v ?? ""],
				})),
				"write",
			);
			return new LibSQLNotesIndex(db);
		} catch (e) {
			db.close();
			throw e;
		}
	}

	async get(path: string): Promise<NoteRow | undefined> {
		const r = (await this.db.execute({ sql: "SELECT * FROM notes WHERE path = ?", args: [path] })).rows[0];
		return r ? toRow(r) : undefined;
	}

	async known(): Promise<{ path: string; sha256: string; state: NoteState; attempts: number }[]> {
		const { rows } = await this.db.execute("SELECT path, sha256, state, attempts FROM notes ORDER BY path");
		return rows.map((r) => ({ path: String(r.path), sha256: String(r.sha256), state: String(r.state) as NoteState, attempts: Number(r.attempts) }));
	}

	async upsertText(row: Pick<NoteRow, "path" | "sha256" | "bytes" | "title" | "tags" | "modified" | "text">): Promise<void> {
		const tags = JSON.stringify(row.tags);
		await this.db.batch(
			[
				{
					sql: `INSERT INTO notes (path, sha256, bytes, title, tags, modified, text, state, attempts, error, indexed_at)
						VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL)
						ON CONFLICT(path) DO UPDATE SET sha256 = excluded.sha256, bytes = excluded.bytes, title = excluded.title, tags = excluded.tags,
						modified = excluded.modified, text = excluded.text, state = 'pending', attempts = 0, error = NULL`,
					args: [row.path, row.sha256, row.bytes, row.title, tags, row.modified ?? null, row.text],
				},
				{ sql: "DELETE FROM notes_fts WHERE path = ?", args: [row.path] },
				{ sql: "INSERT INTO notes_fts (path, title, tags, text) VALUES (?, ?, ?, ?)", args: [row.path, row.title, row.tags.join(" "), row.text] },
				{ sql: "DELETE FROM chunks WHERE path = ?", args: [row.path] },
			],
			"write",
		);
	}

	async markIndexed(path: string, chunks: { text: string; vector: number[] }[], now = new Date()): Promise<void> {
		const stmts: InStatement[] = [
			{ sql: "DELETE FROM chunks WHERE path = ?", args: [path] },
			...chunks.map((c, i) => ({
				sql: "INSERT INTO chunks (path, position, text, embedding) VALUES (?, ?, ?, vector32(?))",
				args: [path, i, c.text, JSON.stringify(c.vector)],
			})),
			{ sql: "UPDATE notes SET state = 'indexed', indexed_at = ?, error = NULL WHERE path = ?", args: [now.toISOString(), path] },
		];
		await this.db.batch(stmts, "write");
	}

	async markFailed(path: string, error: string): Promise<void> {
		await this.db.execute({ sql: "UPDATE notes SET state = 'failed', attempts = attempts + 1, error = ? WHERE path = ?", args: [error.slice(0, 500), path] });
	}

	async remove(path: string): Promise<void> {
		await this.db.batch(
			[
				{ sql: "DELETE FROM chunks WHERE path = ?", args: [path] },
				{ sql: "DELETE FROM notes_fts WHERE path = ?", args: [path] },
				{ sql: "DELETE FROM notes WHERE path = ?", args: [path] },
			],
			"write",
		);
	}

	private filters(a: NoteSearchArgs): { sql: string; args: string[] } {
		const where: string[] = [];
		const args: string[] = [];
		const folder = a.folder?.replace(/\/+$/, "");
		if (folder) {
			where.push("(n.path = ? OR n.path LIKE ? || '/%')");
			args.push(folder, folder);
		}
		if (a.tag) {
			where.push("EXISTS (SELECT 1 FROM json_each(n.tags) WHERE value = ?)");
			args.push(a.tag);
		}
		return { sql: where.length ? where.join(" AND ") : "1", args };
	}

	private async rowsByPath(paths: string[]): Promise<Map<string, NoteRow>> {
		if (!paths.length) return new Map();
		const { rows } = await this.db.execute({ sql: `SELECT * FROM notes WHERE path IN (${paths.map(() => "?").join(", ")})`, args: paths });
		return new Map(rows.map((r) => [String(r.path), toRow(r)]));
	}

	private static hit(n: NoteRow, snippet: string): NoteHit {
		return { path: n.path, title: n.title, tags: n.tags, ...(n.modified ? { modified: n.modified } : {}), snippet, state: n.state };
	}

	async search(a: NoteSearchArgs): Promise<NoteHit[]> {
		const f = this.filters(a);
		const expr = a.query ? ftsQuery(a.query) : "";
		if (!expr && !a.queryVector) {
			const { rows } = await this.db.execute({
				sql: `SELECT * FROM notes n WHERE ${f.sql} ORDER BY COALESCE(n.modified, '') DESC, n.path LIMIT ?`,
				args: [...f.args, a.limit],
			});
			return rows.map((r) => {
				const n = toRow(r);
				return LibSQLNotesIndex.hit(n, n.text.slice(0, 300));
			});
		}
		const lists: string[][] = [];
		const snippets = new Map<string, string>();
		const best = new Map<string, string>();
		if (expr) {
			const { rows } = await this.db.execute({
				sql: `SELECT f.path AS path, bm25(notes_fts) AS s, snippet(notes_fts, -1, '[', ']', '…', 12) AS snippet
					FROM notes_fts f JOIN notes n ON n.path = f.path WHERE notes_fts MATCH ? AND ${f.sql} ORDER BY s LIMIT ${CANDIDATES}`,
				args: [expr, ...f.args],
			});
			lists.push(rows.map((r) => String(r.path)));
			for (const r of rows) if (typeof r.snippet === "string" && r.snippet) snippets.set(String(r.path), r.snippet);
		}
		if (a.queryVector) {
			const v = JSON.stringify(a.queryVector);
			const { rows } = await this.db.execute({
				sql: `SELECT c.path AS path, MIN(vector_distance_cos(c.embedding, vector32(?))) AS dist,
					(SELECT text FROM chunks WHERE path = c.path ORDER BY vector_distance_cos(embedding, vector32(?)) LIMIT 1) AS best
					FROM chunks c JOIN notes n ON n.path = c.path WHERE ${f.sql} GROUP BY c.path ORDER BY dist LIMIT ${CANDIDATES}`,
				args: [v, v, ...f.args],
			});
			lists.push(rows.map((r) => String(r.path)));
			for (const r of rows) if (typeof r.best === "string") best.set(String(r.path), r.best);
		}
		const score = new Map<string, number>();
		for (const list of lists) {
			list.forEach((p, rank) => {
				score.set(p, (score.get(p) ?? 0) + 1 / (RRF_K + rank + 1));
			});
		}
		const top = [...score]
			.sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
			.slice(0, a.limit)
			.map(([p]) => p);
		const notes = await this.rowsByPath(top);
		return top.flatMap((p) => {
			const n = notes.get(p);
			return n ? [LibSQLNotesIndex.hit(n, snippets.get(p) ?? best.get(p)?.slice(0, 300) ?? n.text.slice(0, 300))] : [];
		});
	}

	async stats(): Promise<{ total: number; indexed: number; pending: number; failed: number }> {
		const { rows } = await this.db.execute("SELECT state, COUNT(*) AS n FROM notes GROUP BY state");
		const by = new Map(rows.map((r) => [String(r.state), Number(r.n)]));
		const indexed = by.get("indexed") ?? 0;
		const pending = by.get("pending") ?? 0;
		const failed = by.get("failed") ?? 0;
		return { total: indexed + pending + failed, indexed, pending, failed };
	}

	/** Counted in `meta` (semantic_failures), with the last time and reason (semantic_last_failure). */
	async noteSemanticFailure(error: string, now = new Date()): Promise<void> {
		await this.db.batch(
			[
				{
					sql: "INSERT INTO meta (key, value) VALUES ('semantic_failures', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)",
					args: [],
				},
				{
					sql: "INSERT INTO meta (key, value) VALUES ('semantic_last_failure', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
					args: [`${now.toISOString()} ${error.slice(0, 200)}`],
				},
			],
			"write",
		);
	}

	/** The last query-embedding failure ("<ISO time> <reason>"), for health reports; undefined when there was none. */
	async semanticLastFailure(): Promise<string | undefined> {
		const r = (await this.db.execute("SELECT value FROM meta WHERE key = 'semantic_last_failure'")).rows[0];
		return r ? String(r.value) : undefined;
	}

	close(): void {
		this.db.close();
	}
}
