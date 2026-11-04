// The note actions as Mastra tools, one createTool per action; the logic lives in src/core/actions.ts.
import { createTool, type Tool } from "@mastra/core/tools";
import { type NotesActionsOptions, notesActions } from "../core/actions.ts";

export type NotesToolsOptions = NotesActionsOptions;

/** list_notes, read_note, search_notes and (unless readOnly) write_note, keyed by id. */
export function notesTools(o: NotesToolsOptions): Record<string, Tool> {
	return Object.fromEntries(
		notesActions(o).map((a) => [a.name, createTool({ id: a.name, description: a.description, inputSchema: a.input, execute: (input) => a.run(input) })]),
	);
}
