#!/usr/bin/env node
// `agent-notes mcp`: a folder of notes as an MCP server, over stdio (one client that spawns it) or HTTP (`--http`:
// stateless Streamable HTTP on POST /mcp, an optional Bearer token, GET /health). With `--db` and EMBEDDINGS_* set,
// the folder is swept into a libSQL index (keywords + vectors); otherwise search is by words over the files.
// Logs go to stderr (over stdio, stdout is the protocol) and never carry a note's text.
import { timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createEmbedder, type Embedder, embeddingsConfig, safeError } from "@pitolabs/agent-docs";
import type { NotesActionsOptions } from "../core/actions.ts";
import { NotesFolder } from "../core/folder.ts";
import { NotesIndexer } from "../core/indexer.ts";
import { LibSQLNotesIndex } from "../core/libsql-index.ts";
import { createNotesMcpServer } from "../mcp/server.ts";

const USAGE = `Usage:
  agent-notes mcp --dir <absolute path> [--db <@libsql/client URL>] [--name "<base name>"] [--read-only]
                  [--interval-min 10] [--http] [--host 127.0.0.1] [--port 8070]
  agent-notes --help

Serves a folder of Markdown notes as MCP tools: list_notes, read_note, search_notes, write_note (not with
--read-only). Over stdio by default; --http serves POST /mcp (Streamable HTTP, stateless) and GET /health.

  --dir           the notes folder (absolute path)
  --db            index database, e.g. file:/data/notes.db; with EMBEDDINGS_* set, search is by words and meaning
  --name          the base's name in the tool descriptions, after "base" (pt-BR); default "de notas"
  --read-only     no write_note
  --interval-min  minutes between sweeps of the folder into the index; default 10

Environment:
  EMBEDDINGS_PROVIDER   bedrock | openrouter | openai-compatible (unset: no index), with EMBEDDINGS_* / OPENROUTER_API_KEY
  AGENT_NOTES_TOKEN     with --http, POST /mcp requires "Authorization: Bearer <token>"
`;

const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

function fail(msg: string): never {
	process.stderr.write(`agent-notes: ${msg}\n`);
	process.exit(2);
}

const OPTIONS = {
	dir: { type: "string" },
	db: { type: "string" },
	name: { type: "string" },
	"read-only": { type: "boolean" },
	"interval-min": { type: "string" },
	http: { type: "boolean" },
	host: { type: "string" },
	port: { type: "string" },
	help: { type: "boolean", short: "h" },
} as const;
function parse() {
	try {
		return parseArgs({ options: OPTIONS, allowPositionals: true });
	} catch (e) {
		fail(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
	}
}
const { values: args, positionals } = parse();
if (args.help || positionals.length === 0) {
	process.stdout.write(USAGE);
	process.exit(0);
}
if (positionals[0] !== "mcp" || positionals.length > 1) fail(`unknown command: ${positionals.join(" ")}\n\n${USAGE}`);

const dir = args.dir ?? "";
if (!path.isAbsolute(dir)) fail("--dir must be an absolute path");
if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) fail(`--dir ${dir} is not a directory`);
const intervalMin = Number(args["interval-min"] ?? "10");
if (!(intervalMin > 0)) fail("--interval-min must be a positive number");
const port = Number(args.port ?? "8070");
if (!Number.isInteger(port) || port < 0 || port > 65535) fail("--port must be a port number");
const host = args.host ?? "127.0.0.1";
const kbName = args.name ?? "de notas";
const log = `[agent-notes ${kbName}]`;
const say = (msg: string) => process.stderr.write(`${log} ${msg}\n`);

const folder = await NotesFolder.open({ dir }, log);
let index: LibSQLNotesIndex | undefined;
let indexer: NotesIndexer | undefined;
let embedder: Embedder | undefined;
const emb = embeddingsConfig(process.env);
if (!args.db) say("notes index off: --db not set");
else if ("off" in emb) say(`notes index off: ${emb.off}`);
else {
	const created = createEmbedder(emb);
	// A local database file's folder is created if missing (e.g. ~/.cache/agent-notes/).
	const file = args.db.startsWith("file:") ? args.db.slice("file:".length).split("?")[0] : undefined;
	const opened = await (async () => {
		if (file) fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
		return LibSQLNotesIndex.open({ url: args.db ?? "", root: folder.root, model: created.model, dims: created.dims });
	})().catch((e: unknown) => ({ off: `cannot open ${args.db}: ${safeError(e)}` }));
	if ("off" in opened) say(`notes index off: ${opened.off}`);
	else {
		index = opened;
		embedder = created;
		indexer = new NotesIndexer({ folder, index, embedder, log, bootDelayMs: 5_000, intervalMs: intervalMin * 60_000 });
		indexer.start();
		say(`notes index on: ${emb.provider} ${embedder.model}`);
	}
}

const opts: NotesActionsOptions & { version: string } = {
	folder,
	...(index ? { index } : {}),
	...(indexer ? { indexer } : {}),
	...(embedder ? { embedder } : {}),
	kbName,
	log,
	readOnly: args["read-only"] ?? false,
	version: pkg.version,
};

let closing = false;
let closeServer: () => Promise<void> = async () => undefined;
async function shutdown(): Promise<void> {
	if (closing) return;
	closing = true;
	indexer?.stop();
	await closeServer().catch(() => undefined);
	index?.close();
	process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

if (!args.http) {
	const server = createNotesMcpServer(opts);
	closeServer = () => server.close();
	process.stdin.on("end", shutdown);
	process.stdin.on("close", shutdown);
	await server.connect(new StdioServerTransport());
} else {
	const token = process.env.AGENT_NOTES_TOKEN || undefined;
	if (!token) say("no AGENT_NOTES_TOKEN: /mcp is open to anyone who reaches this port");
	const authorized = (header: string | undefined) => {
		if (!token) return true;
		const got = Buffer.from(header ?? "");
		const want = Buffer.from(`Bearer ${token}`);
		return got.length === want.length && timingSafeEqual(got, want);
	};
	const json = (res: ServerResponse, status: number, body: unknown) => {
		res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
	};
	const http = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		try {
			if (url.pathname === "/health" && req.method === "GET") {
				return json(res, 200, {
					ok: true,
					name: kbName,
					dir,
					index: index ? "on" : "off",
					stats: index ? await index.stats() : null,
					model: embedder?.model ?? null,
					semantic_last_failure: (await index?.semanticLastFailure()) ?? null,
				});
			}
			if (url.pathname === "/mcp" && req.method === "POST") {
				if (!authorized(req.headers.authorization)) return json(res, 401, { error: "unauthorized" });
				// Stateless: a server and a transport per request, closed with the response.
				const server = createNotesMcpServer(opts);
				const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
				res.on("close", () => {
					transport.close().catch(() => undefined);
					server.close().catch(() => undefined);
				});
				await server.connect(transport);
				await transport.handleRequest(req, res);
				return;
			}
			json(res, 404, { error: "not found" });
		} catch (e) {
			say(`request failed: ${safeError(e)}`);
			if (!res.headersSent) json(res, 500, { error: "internal error" });
		}
	});
	closeServer = () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		http.close(() => resolve());
		return promise;
	};
	http.listen(port, host, () => {
		const addr = http.address();
		say(`listening on http://${host}:${typeof addr === "object" && addr ? addr.port : port}`);
	});
}
