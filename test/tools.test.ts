// The four note actions as an agent sees them: writes guarded by the note's sha, paths checked, search falling back
// to words when the query cannot be embedded or there is no index.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type NotesActionsOptions, notesActions } from "../src/core/actions.ts";
import { NotesFolder } from "../src/core/folder.ts";
import { NotesIndexer } from "../src/core/indexer.ts";
import { LibSQLNotesIndex } from "../src/core/libsql-index.ts";
import { notesTools } from "../src/mastra/tools.ts";
import { DIMS, MODEL, stubEmbedder } from "./stub-embedder.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup(opts: { index?: boolean; fail?: { on: boolean } } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "notes-tools-"));
	dirs.push(dir);
	writeFileSync(join(dir, "AGENTS.md"), "# Regras\n");
	writeFileSync(join(dir, "rede.md"), "# Rede\nO roteador reinicia sozinho.\n");
	const folder = await NotesFolder.open({ dir }, "[test]");
	const o: NotesActionsOptions = { folder, kbName: "de teste", log: "[test]" };
	let index: LibSQLNotesIndex | undefined;
	if (opts.index !== false) {
		const opened = await LibSQLNotesIndex.open({ url: ":memory:", root: folder.root, model: MODEL, dims: DIMS });
		if ("off" in opened) throw new Error(opened.off);
		index = opened;
		const embedder = stubEmbedder(opts.fail);
		const indexer = new NotesIndexer({ folder, index, embedder: stubEmbedder(), log: "[test]" });
		await indexer.reconcile();
		Object.assign(o, { index, indexer, embedder });
	}
	const run = Object.fromEntries(notesActions(o).map((a) => [a.name, (input: unknown) => a.run(a.input.parse(input))]));
	return { dir, o, index, run };
}

describe("write_note", () => {
	test("creates a note, which the index has at once", async () => {
		const { dir, o, run } = await setup();
		const r = await run.write_note?.({ path: "precos/2026-11.md", full_text: "# Novembro\nDiária de 500.", reason: "preços de novembro" });
		expect(r).toMatchObject({ path: "precos/2026-11.md", created: true });
		expect(readFileSync(join(dir, "precos/2026-11.md"), "utf8")).toBe("# Novembro\nDiária de 500.\n");
		expect(await o.index?.get("precos/2026-11.md")).toMatchObject({ state: "indexed", title: "Novembro" });
	});

	test("an existing note needs its sha: missing or stale is refused and the file is untouched; the read sha writes", async () => {
		const { dir, run } = await setup();
		const before = readFileSync(join(dir, "rede.md"), "utf8");
		expect(await run.write_note?.({ path: "rede.md", full_text: "x", reason: "teste" })).toEqual({
			error: "a nota já existe: leia com read_note e passe base_sha",
		});
		expect(await run.write_note?.({ path: "rede.md", full_text: "x", base_sha: "0".repeat(64), reason: "teste" })).toEqual({
			error: "a nota mudou desde a leitura; leia de novo com read_note",
		});
		expect(readFileSync(join(dir, "rede.md"), "utf8")).toBe(before);
		const read = await run.read_note?.({ path: "rede.md" });
		const w = await run.write_note?.({ path: "rede.md", full_text: "# Rede\nTrocamos o roteador.\n", base_sha: String(read?.sha), reason: "roteador novo" });
		expect(w).toMatchObject({ path: "rede.md", created: false });
		expect((await run.read_note?.({ path: "rede.md" }))?.sha).toBe(w?.sha);
	});

	test("AGENTS.md and paths outside the folder are refused", async () => {
		const { dir, run } = await setup();
		for (const path of ["AGENTS.md", "../x.md", "Nota Com Espaço.md", ".oculta.md"]) {
			expect(await run.write_note?.({ path, full_text: "x", reason: "teste" })).toMatchObject({ error: expect.stringMatching(/kebab-case/) });
		}
		expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe("# Regras\n");
		expect(existsSync(join(dir, "..", "x.md"))).toBe(false);
	});

	test("readOnly leaves write_note out", async () => {
		const { o } = await setup({ index: false });
		expect(Object.keys(notesTools({ ...o, readOnly: true }))).toEqual(["list_notes", "read_note", "search_notes"]);
		expect(Object.keys(notesTools(o))).toEqual(["list_notes", "read_note", "search_notes", "write_note"]);
	});
});

describe("read_note and list_notes", () => {
	test("reads AGENTS.md and kebab-case notes; refuses other paths", async () => {
		const { run } = await setup({ index: false });
		expect(await run.read_note?.({ path: "AGENTS.md" })).toMatchObject({ path: "AGENTS.md", text: "# Regras\n" });
		expect(await run.read_note?.({ path: "../etc/passwd" })).toEqual({ error: "caminho de nota .md (ou AGENTS.md)" });
		expect(await run.read_note?.({ path: "nada.md" })).toEqual({ error: "a nota nada.md não existe" });
		expect(await run.list_notes?.({})).toEqual({ notes: ["AGENTS.md", "rede.md"] });
	});
});

describe("search_notes", () => {
	test("with the index: notes with a snippet, no search_mode", async () => {
		const { run } = await setup();
		const r = await run.search_notes?.({ query: "roteador" });
		expect(r).toMatchObject({ total: 2, indexed: 2 });
		expect(r?.notes).toMatchObject([{ path: "rede.md", title: "Rede", snippet: expect.stringContaining("[roteador]") }, { path: "AGENTS.md" }]);
		expect(r).not.toHaveProperty("search_mode");
	});

	test("the query cannot be embedded: keyword-only, with a warning, and the failure is recorded", async () => {
		const { index, run } = await setup({ fail: { on: true } });
		const r = await run.search_notes?.({ query: "roteador" });
		expect(r).toMatchObject({ notes: [{ path: "rede.md" }], search_mode: "keyword-only", warning: "busca por significado indisponível agora; só palavras" });
		expect(await index?.semanticLastFailure()).toMatch(/ Embeddings 503$/);
	});

	test("without an index: words over the files", async () => {
		const { run } = await setup({ index: false });
		expect(await run.search_notes?.({ query: "ROTEADOR" })).toEqual({
			results: [{ path: "rede.md", line: 2, text: "O roteador reinicia sozinho." }],
			search_mode: "words",
		});
	});
});
