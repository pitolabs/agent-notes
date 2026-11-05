// The CLI as an MCP server, spawned the way a client does: over stdio (no index), and over HTTP with a Bearer token and
// an index whose embeddings come from a local OpenAI-style /embeddings stub.
import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { bagOfWords, DIMS } from "./stub-embedder.ts";

const MAIN = join(import.meta.dir, "..", "src", "cli", "main.ts");
const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function notesDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "notes-mcp-"));
	dirs.push(dir);
	writeFileSync(join(dir, "rede.md"), "---\ntitle: Rede\n---\nO roteador reinicia sozinho; o sinal cai à noite.\n");
	writeFileSync(join(dir, "cozinha.md"), "# Cozinha\nA geladeira faz barulho e o forno não acende.\n");
	return dir;
}

async function stdioClient(dir: string, extra: string[] = []) {
	const client = new Client({ name: "test", version: "0" });
	await client.connect(
		new StdioClientTransport({ command: process.execPath, args: [MAIN, "mcp", "--dir", dir, "--name", "de teste", ...extra], stderr: "pipe" }),
	);
	return client;
}

describe("agent-notes mcp over stdio", () => {
	test("four tools; write_note creates the file; search is by words without an index", async () => {
		const dir = notesDir();
		const client = await stdioClient(dir);
		try {
			expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["list_notes", "read_note", "search_notes", "write_note"]);
			// How to use the base reaches the client with the base's name, writing included.
			expect(client.getInstructions()).toContain("Base de notas de teste");
			expect(client.getInstructions()).toContain("base_sha");
			const w = await client.callTool({ name: "write_note", arguments: { path: "jardim.md", full_text: "# Jardim\nRegar às terças.", reason: "nota nova" } });
			expect(w.isError).toBe(false);
			expect(w.structuredContent).toMatchObject({ path: "jardim.md", created: true });
			expect(readFileSync(join(dir, "jardim.md"), "utf8")).toBe("# Jardim\nRegar às terças.\n");
			const s = await client.callTool({ name: "search_notes", arguments: { query: "geladeira" } });
			expect(s.structuredContent).toMatchObject({ search_mode: "words", results: [{ path: "cozinha.md", line: 2 }] });
			const bad = await client.callTool({ name: "write_note", arguments: { path: "jardim.md", full_text: "x", reason: "sem sha" } });
			expect(bad.isError).toBe(true);
		} finally {
			await client.close();
		}
	});

	test("--read-only: three tools", async () => {
		const client = await stdioClient(notesDir(), ["--read-only"]);
		try {
			expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["list_notes", "read_note", "search_notes"]);
			expect(client.getInstructions()).not.toContain("write_note");
		} finally {
			await client.close();
		}
	});
});

describe("agent-notes mcp --http", () => {
	test("with an index and a token: hybrid search through the Bearer, 401 without it, /health open", async () => {
		const embeddings = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(req) {
				const body = (await req.json()) as { input: string[] };
				return Response.json({ data: body.input.map((t, index) => ({ index, embedding: bagOfWords(t) })) });
			},
		});
		const dir = notesDir();
		const token = randomBytes(32).toString("hex");
		const proc = Bun.spawn(
			[process.execPath, MAIN, "mcp", "--dir", dir, "--name", "de teste", "--http", "--port", "0", "--db", `file:${join(dir, ".index", "notes.db")}`],
			{
				env: {
					PATH: process.env.PATH ?? "",
					EMBEDDINGS_PROVIDER: "openai-compatible",
					EMBEDDINGS_BASE_URL: `http://127.0.0.1:${embeddings.port}`,
					EMBEDDINGS_MODEL: "stub",
					EMBEDDINGS_DIMS: String(DIMS),
					AGENT_NOTES_TOKEN: token,
				},
				stderr: "pipe",
			},
		);
		try {
			let log = "";
			const reader = proc.stderr.getReader();
			let port = 0;
			while (!port) {
				const { value, done } = await reader.read();
				if (done) throw new Error(`exited: ${log}`);
				log += new TextDecoder().decode(value);
				port = Number(/listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(log)?.[1] ?? 0);
			}
			expect(log).toContain("[agent-notes de teste] notes index on: openai-compatible stub");
			const base = `http://127.0.0.1:${port}`;
			let health: { ok: boolean; index: string; stats: { indexed: number } | null } | undefined;
			// The sweep runs in the child process (first one 5 s after start), out of reach of fake timers: poll /health.
			for (let i = 0; i < 100 && health?.stats?.indexed !== 2; i++) {
				health = (await (await fetch(`${base}/health`)).json()) as typeof health;
				if (health?.stats?.indexed !== 2) await Bun.sleep(100);
			}
			expect(health).toMatchObject({ ok: true, name: "de teste", index: "on", stats: { total: 2, indexed: 2, pending: 0, failed: 0 }, model: "stub" });

			expect((await fetch(`${base}/mcp`, { method: "POST", body: "{}" })).status).toBe(401);
			expect((await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: "Bearer wrong" }, body: "{}" })).status).toBe(401);

			const client = new Client({ name: "test", version: "0" });
			await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
			try {
				const s = await client.callTool({ name: "search_notes", arguments: { query: "o sinal de internet cai" } });
				expect(s.structuredContent).toMatchObject({ notes: [{ path: "rede.md", title: "Rede" }, { path: "cozinha.md" }], total: 2, indexed: 2 });
				expect(s.structuredContent).not.toHaveProperty("search_mode");
			} finally {
				await client.close();
			}
		} finally {
			proc.kill("SIGTERM");
			await proc.exited;
			embeddings.stop(true);
		}
		expect(proc.exitCode).toBe(0);
		expect(existsSync(join(dir, ".index", "notes.db"))).toBe(true);
	}, 30_000);
});
