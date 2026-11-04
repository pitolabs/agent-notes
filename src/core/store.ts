// The notes index contract. LibSQLNotesIndex is the implementation shipped here; the tools and the indexer only see
// this interface, so another store (another database, a remote service) plugs in without touching them.

/** pending: text stored (keyword search works), vectors not yet; indexed: both; failed: embedding failed (retried). */
export type NoteState = "pending" | "indexed" | "failed";

export interface NoteRow {
	path: string;
	sha256: string;
	bytes: number;
	title: string;
	tags: string[];
	modified?: string;
	/** The body (frontmatter removed). */
	text: string;
	state: NoteState;
	attempts: number;
	error?: string;
	indexedAt?: string;
}

export interface NoteSearchArgs {
	query?: string;
	queryVector?: number[];
	/** Relative folder prefix, e.g. "prices". */
	folder?: string;
	/** A folded tag (lower case, no accents, no `#`). */
	tag?: string;
	limit: number;
}

export interface NoteHit {
	path: string;
	title: string;
	tags: string[];
	modified?: string;
	snippet: string;
	state: NoteState;
}

export interface NotesIndex {
	get(path: string): Promise<NoteRow | undefined>;
	/** Everything the index knows: for the sweep to compare with the folder. */
	known(): Promise<{ path: string; sha256: string; state: NoteState; attempts: number }[]>;
	/** Stores text + FTS (keyword search works at once), state pending, attempts 0, drops old chunks. Atomic. */
	upsertText(row: Pick<NoteRow, "path" | "sha256" | "bytes" | "title" | "tags" | "modified" | "text">): Promise<void>;
	/**
	 * Stores the chunks and marks the note indexed, only if its row still has `sha256` (the text the chunks were made
	 * from): vectors of an older text never land over a newer one. Atomic. False when the row moved on (or is gone).
	 */
	markIndexed(path: string, sha256: string, chunks: { text: string; vector: number[] }[], now?: Date): Promise<boolean>;
	/** Counts a failed attempt, only if the row still has `sha256`. */
	markFailed(path: string, sha256: string, error: string): Promise<void>;
	remove(path: string): Promise<void>;
	/**
	 * Without a query: the filtered notes, most recently `modified` first. With one: keywords and, with queryVector,
	 * the closest chunk per note, merged by reciprocal rank fusion.
	 */
	search(a: NoteSearchArgs): Promise<NoteHit[]>;
	stats(): Promise<{ total: number; indexed: number; pending: number; failed: number }>;
	/** Records that a search fell back to keywords because the query could not be embedded. */
	noteSemanticFailure(error: string, now?: Date): Promise<void>;
	close(): void;
}
