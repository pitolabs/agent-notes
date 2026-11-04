// The note actions as an MCP server: one tool per action, the result as JSON text and as structured content, and
// `isError` when the action answered with `{ error }`. The transport (stdio or HTTP) is the caller's.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type NotesActionsOptions, notesActions } from "../core/actions.ts";

export function createNotesMcpServer(o: NotesActionsOptions & { version: string }): McpServer {
	const server = new McpServer({ name: "agent-notes", version: o.version });
	for (const a of notesActions(o)) {
		server.registerTool(a.name, { description: a.description, inputSchema: a.input }, async (input: unknown) => {
			const r = await a.run(input);
			return { content: [{ type: "text" as const, text: JSON.stringify(r) }], structuredContent: r, isError: "error" in r };
		});
	}
	return server;
}
