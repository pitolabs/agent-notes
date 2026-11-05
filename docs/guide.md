# Guide

How to wire agent-notes in: as an MCP server (stdio, HTTP, Docker), as Mastra tools, or as an SDK. The flags,
variables and tool contracts are in the [reference](reference.md); the reasons behind them in the
[design notes](design.md).

```text
notes folder (.md) ──sweep by sha──► libSQL file (FTS5 + vectors) ◄── search_notes
      ▲                                                                  │
      └──── write_note (sha-guarded) ◄── your agent ─── list/read/search ┘
```

## One folder per agent

Give each agent the folder it needs and nothing more: a server (or a `NotesFolder`) never reads outside its `--dir`,
skips hidden files and symlinks, and its index is pinned to that folder. Two agents, two servers, two database files.

## MCP over stdio

The client starts the server. Embeddings are optional: without `--db` and `EMBEDDINGS_*`, `search_notes` searches the
files by words.

Claude Code:

```bash
claude mcp add notes -e EMBEDDINGS_PROVIDER=openrouter -e OPENROUTER_API_KEY=sk-or-... \
  -- npx -y @pitolabs/agent-notes mcp --dir ~/notes --db file:$HOME/.cache/agent-notes/notes.db --name "de notas"
```

Cursor (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "notes": {
      "command": "npx",
      "args": ["-y", "@pitolabs/agent-notes", "mcp", "--dir", "/home/me/notes", "--db", "file:/home/me/.cache/agent-notes/notes.db"],
      "env": { "EMBEDDINGS_PROVIDER": "openai-compatible", "EMBEDDINGS_BASE_URL": "http://localhost:11434/v1", "EMBEDDINGS_MODEL": "bge-m3" }
    }
  }
}
```

OpenCode (`opencode.json`):

```json
{
  "mcp": {
    "notes": {
      "type": "local",
      "command": ["npx", "-y", "@pitolabs/agent-notes", "mcp", "--dir", "/home/me/notes", "--read-only"],
      "environment": {}
    }
  }
}
```

A local model's vector length must match what the index expects: set `EMBEDDINGS_DIMS` to the model's size (1024 for
`bge-m3`), or leave it unset for 1024.

## MCP over HTTP

```bash
AGENT_NOTES_TOKEN=$(openssl rand -hex 32) EMBEDDINGS_PROVIDER=openrouter OPENROUTER_API_KEY=sk-or-... \
  npx -y @pitolabs/agent-notes mcp --http --port 8070 --dir ~/notes --db file:$HOME/.cache/agent-notes/notes.db
```

Clients connect to `http://<host>:8070/mcp` (Streamable HTTP, stateless) with `Authorization: Bearer <token>`.
`GET /health` needs no token and returns counts only (no note text): use it for health checks. `--host` defaults to
`127.0.0.1`; bind `0.0.0.0` only on a network you control.

## Docker

The repository's `Dockerfile` runs the HTTP server on port 8070 with the folder at `/notes` and the index at
`/data/notes.db`:

```bash
docker build -t agent-notes .
docker run -d --name notes -p 127.0.0.1:8070:8070 \
  -v ~/notes:/notes -v agent-notes-data:/data \
  -e AGENT_NOTES_TOKEN=... -e EMBEDDINGS_PROVIDER=openrouter -e OPENROUTER_API_KEY=... \
  agent-notes
```

The container runs as uid 1000: the folder must be writable by it for `write_note` (or add `--read-only` to the
command, and mount the folder `:ro`). It runs fine with `--read-only` root filesystem, all capabilities dropped and 256
MB of memory. To re-index (another model, a corrupt file): remove the `/data` volume.

## Mastra, over MCP (the server in its own container)

No client from this package is needed: Mastra's own `MCPClient` plugs the server in. Discover its tools on every run
(`tools` and `instructions` as functions), so a server that goes down drops its tools and the agent can say so, and
they come back on the first run after it returns:

```ts
import { Agent } from "@mastra/core/agent";
import { MCPClient } from "@mastra/mcp";

const notes = new MCPClient({
	id: "clerk-notes",
	servers: {
		notes: {
			url: new URL("http://notes:8070/mcp"),
			requestInit: { headers: { Authorization: `Bearer ${process.env.NOTES_TOKEN}` } },
			// The server says how to use the base (search, read before stating, base_sha on writes): into the prompt.
			forwardInstructions: true,
			instructionsMaxLength: 2000,
		},
	},
});
const discover = () => notes.listToolsWithErrors({ perServerTimeoutMs: 3000 });

export const clerk = new Agent({
	id: "clerk",
	name: "Clerk",
	model: "openai/gpt-4o-mini",
	instructions: async () => ("notes" in (await discover()).errors ? "The notes base is down right now: say so." : "You answer the company's questions."),
	tools: async () => (await discover()).tools, // notes_list_notes, notes_read_note, notes_search_notes, notes_write_note
});
```

The agent's own prompt carries only what is its own: who it is, who it talks to, whether it asks before writing. How
to work with the base and how a note is built (kebab-case path, frontmatter `title`, `aliases`, `created`, `modified`,
`tags`, wikilinks, small edits) come from the server (`notesInstructions`); what the base holds, and any fields and
tags of its own, from the base's `AGENTS.md`, which those instructions tell the agent to read first.

Avoid `tools: await notes.listTools()` at module load: it snapshots the tools once, so a server down at start leaves
the agent without them until a restart, and one that stops later leaves tools whose every call fails.

## Mastra, in process

`notesTools(options)` returns the four tools keyed by id, and `notesInstructions(options)` the same how-to the MCP
server advertises, to append to the agent's instructions. Options:

- `folder` (`NotesFolder.open({ dir }, log)`) — without it, every tool answers "base indisponível".
- `index`, `indexer`, `embedder` — from `openAgentNotes({ url, folder, embedder })`; without them, word search.
- `kbName` — the base's name in the descriptions, after "base" (pt-BR): `"da empresa"`.
- `readOnly` — no `write_note`.
- `readable` / `writable` — which paths `read_note` and `write_note` accept (default: kebab-case `.md`; `AGENTS.md`
  readable, never writable).

Call `indexer.start()` once; it sweeps 30 s after start and every 10 min, and `write_note` re-indexes the note it
wrote at once. `indexer.stop()` and `index.close()` on shutdown.

## SDK, any framework

`notesActions(options)` returns the same four tools as `{ name, description, input (zod), run(input) }`: adapt them to
your framework in a few lines, as `src/mastra/tools.ts` and `src/mcp/server.ts` do. `NotesFolder`, `LibSQLNotesIndex`
and `NotesIndexer` are usable on their own.
