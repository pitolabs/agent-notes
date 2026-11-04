// An agent's notes index and its indexer in one call, or `{ off }` saying why not (a database built for another folder
// or embeddings model). The host builds the folder and the embedder, starts the indexer and decides what to log.
import type { Embedder } from "@pitolabs/agent-docs";
import type { NotesFolder } from "../core/folder.ts";
import { NotesIndexer } from "../core/indexer.ts";
import { LibSQLNotesIndex } from "../core/libsql-index.ts";
import type { NotesIndex } from "../core/store.ts";

export interface OpenAgentNotesOptions {
	/** Any @libsql/client URL: `file:/data/notes.db`, `:memory:`, `libsql://<db>.turso.io`. */
	url: string;
	authToken?: string;
	folder: NotesFolder;
	embedder: Embedder;
	/** Log prefix for the indexer, default "[notes]". */
	log?: string;
}

export async function openAgentNotes(o: OpenAgentNotesOptions): Promise<{ index: NotesIndex; indexer: NotesIndexer } | { off: string }> {
	const opened = await LibSQLNotesIndex.open({
		url: o.url,
		...(o.authToken ? { authToken: o.authToken } : {}),
		root: o.folder.root,
		model: o.embedder.model,
		dims: o.embedder.dims,
	});
	if ("off" in opened) return opened;
	return { index: opened, indexer: new NotesIndexer({ folder: o.folder, index: opened, embedder: o.embedder, log: o.log ?? "[notes]" }) };
}
