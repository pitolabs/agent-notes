# Reference

What each entry point accepts and does. How to wire it in is in the [guide](guide.md); why it is built this way, in the
[design notes](design.md).

## Entry points

| Import | What |
|---|---|
| `@pitolabs/agent-notes` | Core, no framework: `NotesFolder`, `notesConfig`, `parseNote`, `LibSQLNotesIndex`, `NotesIndexer`, `notesActions` and the input schemas, and `createEmbedder` / `embeddingsConfig` |
| `@pitolabs/agent-notes/mastra` | The core plus `notesTools` and `openAgentNotes` (peer `@mastra/core >= 1.79`) |
| `agent-notes` (bin) | `agent-notes mcp …`, the MCP server |

The embedders (`createEmbedder`, `embeddingsConfig`, the `Embedder` interface) are
[`@pitolabs/agent-docs`](https://github.com/pitolabs/agent-docs)'s, re-exported here.

## CLI

```text
agent-notes mcp --dir <abs> [--db <url>] [--name "<base name>"] [--read-only] [--interval-min 10]
                [--http] [--host 127.0.0.1] [--port 8070]
```

| Flag | Default | Meaning |
|---|---|---|
| `--dir` | required | The notes folder, absolute; missing or not a directory: exit 2 |
| `--db` | none | `@libsql/client` URL (`file:/data/notes.db`, `libsql://…`); a `file:` folder is created if missing |
| `--name` | `de notas` | The base's name in tool descriptions and log lines (`[agent-notes <name>]`) |
| `--read-only` | off | No `write_note` |
| `--interval-min` | `10` | Minutes between sweeps (the first runs 5 s after start) |
| `--http` | off (stdio) | Serve `POST /mcp` and `GET /health` |
| `--host`, `--port` | `127.0.0.1`, `8070` | HTTP bind; `--port 0` picks a free port (logged) |

SIGTERM, SIGINT or the end of stdin stop the sweep, close the index and exit 0. All logs go to stderr.

## Environment

| Variable | Used for |
|---|---|
| `EMBEDDINGS_PROVIDER` | `bedrock`, `openrouter` or `openai-compatible`; unset: no index (word search) |
| `EMBEDDINGS_BASE_URL`, `EMBEDDINGS_MODEL`, `EMBEDDINGS_API_KEY`, `EMBEDDINGS_DIMS` | `openai-compatible` |
| `OPENROUTER_API_KEY` | `openrouter` (OpenAI `text-embedding-3-small`, 1024 dims, providers that do not keep data) |
| `EMBEDDINGS_REGION`, `EMBEDDINGS_AWS_ACCESS_KEY_ID`, `EMBEDDINGS_AWS_SECRET_ACCESS_KEY`, `EMBEDDINGS_MODEL` | `bedrock` (Cohere multilingual v3 or Titan v2) |
| `AGENT_NOTES_TOKEN` | With `--http`: `POST /mcp` requires `Authorization: Bearer <token>`, else 401 |

## `GET /health`

```json
{ "ok": true, "name": "de notas", "dir": "/notes", "index": "on",
  "stats": { "total": 20, "indexed": 20, "pending": 0, "failed": 0 },
  "model": "openai/text-embedding-3-small", "semantic_last_failure": null }
```

`stats` and `model` are `null` with the index off. `semantic_last_failure` is `"<ISO time> <reason>"` for the last
search whose query could not be embedded.

## Tools

| Tool | Input | Output |
|---|---|---|
| `list_notes` | `folder?` | `{ notes: string[] }` |
| `read_note` | `path` | `{ path, sha, text }` or `{ error }` |
| `search_notes` | `query` (2–300), `folder?`, `tag?`, `limit` (1–20, default 8) | with index: `{ notes: [{ path, title, tags, modified?, snippet, state }], total, indexed, pending, failed }`; without: `{ results: [{ path, line, text }], search_mode: "words" }` |
| `write_note` | `path`, `full_text`, `base_sha?`, `reason` | `{ path, sha, created }` or `{ error }` |

- `search_notes` whose query embedding fails falls back to keywords and adds `search_mode: "keyword-only"` and a
  `warning`.
- `write_note` on an existing note needs `base_sha` (from `read_note`); a different sha on disk refuses the write. A
  final newline is added when missing. `reason` goes to the log, never the text.
- Over MCP, each result is JSON text plus `structuredContent`; `isError` is true when the result has `error`.

## The sweep

For every `.md` in the folder (hidden entries and symlinks skipped): unknown or a different sha → index it; same sha but
`pending` or `failed` with fewer than 3 attempts → try again; same sha and indexed → nothing. Every note the index
knows that is no longer on disk is removed. One note at a time. Indexing a note stores its text and FTS row first
(keyword search works at once), then embeds its chunks (paragraphs merged up to 1,400 characters, each prefixed with
the note's title) and stores them; an embedding failure leaves the note `failed`, still findable by keywords.

A sweep's step on one note and a `write_note` re-index never run at the same time, and the vectors are stored only if
the note's row still has the sha they were made from: a slow embedding of an old text never lands over a newer one,
even with two processes on one database.

## What is stored

One libSQL database per folder: `notes` (path, sha256, bytes, title, tags, modified, body, state, attempts, error),
`notes_fts` (FTS5 over title, tags and body, `unicode61 remove_diacritics 2`), `chunks` (text and `F32_BLOB` vector)
and `meta` (schema version, the folder's real path, the embeddings model and dims, query-embedding failures). Opening
a database built for another folder or model is refused: delete the file to re-index.

## Where text goes

Note text goes to the embeddings provider, once per changed note, and each search query once. Errors keep only a
class name and an HTTP status (`Embeddings 503`); logs carry paths, never note text.
