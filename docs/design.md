# Design notes

Why things are the way they are, and what is planned. How to use it is in the [guide](guide.md); exact contracts in the
[reference](reference.md).

## Why a sweep by sha, not a queue of events

The folder changes behind the process's back: Obsidian LiveSync, Obsidian Sync, Syncthing or a git pull write files
without telling anyone, and file watchers miss events across volumes, containers and restarts. So the index compares
itself with the folder: each note's sha256 against the one it indexed. New or changed → re-index; gone → remove;
equal → nothing. It runs at start, every 10 minutes, and for the one note `write_note` just wrote. A crash or a
restart only delays the next sweep; there is no queue to lose.

## Why writes are guarded by sha and not by a confirmation

The danger in an agent writing notes is not the agent writing, it is the agent overwriting: the person edited the
note on their phone a minute ago and the edit is still syncing. `write_note` on an existing note needs the `sha` the
agent read; if the file on disk has another sha, the write is refused and the agent reads again. Writes go to a hidden
temp file renamed over the note, so sync tools, which skip hidden files, only ever see a whole note. Whether an agent
writes at all is the host's decision (`readOnly`), not a prompt.

## One index per folder, pinned to the folder and the model

The database stores the folder's real path and the embeddings model in `meta`, and refuses to open for another. Two
agents never share an index, a database copied to the wrong place is refused instead of mixing notes, and vectors from
two models never end up in the same ranking. Changing the model means deleting the file; the next sweep rebuilds it.

## Why the agent-docs engine and not QMD as an SDK

| Need | QMD | This package |
|---|---|---|
| Keyword + semantic search, fused | yes, plus a reranker | FTS5 + exact cosine, reciprocal rank fusion |
| Dependencies | native `node-llama-cpp`, `sqlite-vec` | `@libsql/client` (prebuilt), no native build |
| Models | ~2 GB of GGUF models downloaded and loaded locally | any embeddings API, or a local `/embeddings` |
| Fits a 256 MB container | no | yes |
| Writes | read-only | sha-guarded writes, re-indexed at once |

The engine — `chunkText`, `ftsQuery`, the embedders, `safeError` — comes from
[`@pitolabs/agent-docs`](https://github.com/pitolabs/agent-docs), where it already ranks documents; the schema here is
its notes counterpart. On twenty real notes and ten questions phrased differently from the notes, hybrid search found
the right note in its top three for 8 questions; word search over lines found none.

## One implementation of the tools, thin adapters

`src/core/actions.ts` holds the four tools as `{ name, description, input, run }`, with every path check inside `run`.
`src/mastra/tools.ts` wraps each in `createTool`; `src/mcp/server.ts` registers each with `registerTool`. A rule
changed once holds in both, and nothing in the core imports a framework (CI checks `dist/core`, `dist/mcp` and
`dist/cli` for `@mastra`).

## Other stores

The tools and the indexer see only the `NotesIndex` interface (`src/core/store.ts`). `LibSQLNotesIndex` is
SQLite-specific (FTS5, `vector_distance_cos`); another store — Postgres with `tsvector` and pgvector, a remote search
service — is a second class implementing the same interface, with no change to the tools.

## Planned

- English tool descriptions and messages, chosen by an option.
- Wikilinks: `[[note]]` resolved to paths in `read_note`, and backlinks in search results.
