// `@pitolabs/agent-notes/mastra`: the note tools as Mastra tools (notesTools) and openAgentNotes. Everything from the
// core is re-exported, so one import serves a Mastra host.
export * from "../core/index.ts";
export { type OpenAgentNotesOptions, openAgentNotes } from "./open-index.ts";
export { type NotesToolsOptions, notesTools } from "./tools.ts";
