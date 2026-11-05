// `@pitolabs/agent-notes`: the framework-neutral core. The notes folder, the frontmatter parser, the index (libSQL),
// the indexer that sweeps the folder into it, and the four note tools as plain actions. Nothing here imports a
// framework; the Mastra tools are in `@pitolabs/agent-notes/mastra`, the MCP server is the `agent-notes` CLI.
// The embedders come from @pitolabs/agent-docs (the same engine); re-exported so a host needs one import.
export { createEmbedder, type Embedder, type EmbeddingsConfig, embeddingsConfig } from "@pitolabs/agent-docs";
export {
	ListNotesInput,
	type NoteAction,
	type NotesActionsOptions,
	notesActions,
	notesInstructions,
	ReadNoteInput,
	SearchNotesInput,
	WriteNoteInput,
} from "./actions.ts";
export { fold, type Note, type NotesConfig, NotesFolder, notesConfig } from "./folder.ts";
export { type ParsedNote, parseNote } from "./frontmatter.ts";
export { NotesIndexer, type NotesIndexerDeps, type ReconcileResult } from "./indexer.ts";
export { LibSQLNotesIndex, type OpenNotesIndexOptions } from "./libsql-index.ts";
export type { NoteHit, NoteRow, NoteSearchArgs, NoteState, NotesIndex } from "./store.ts";
