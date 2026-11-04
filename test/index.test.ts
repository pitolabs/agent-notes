// The index and its sweep, end to end over a temporary folder, an in-memory libSQL and a bag-of-words embedder.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotesFolder } from "../src/core/folder.ts";
import { NotesIndexer } from "../src/core/indexer.ts";
import { LibSQLNotesIndex } from "../src/core/libsql-index.ts";
import { bagOfWords, DIMS, MODEL, stubEmbedder } from "./stub-embedder.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup(files: Record<string, string>, fail = { on: false }) {
	const dir = mkdtempSync(join(tmpdir(), "notes-index-"));
	dirs.push(dir);
	for (const [p, text] of Object.entries(files)) {
		mkdirSync(join(dir, p, ".."), { recursive: true });
		writeFileSync(join(dir, p), text);
	}
	const folder = await NotesFolder.open({ dir }, "[test]");
	const index = await LibSQLNotesIndex.open({ url: ":memory:", root: folder.root, model: MODEL, dims: DIMS });
	if ("off" in index) throw new Error(index.off);
	const embedder = stubEmbedder(fail);
	const indexer = new NotesIndexer({ folder, index, embedder, log: "[test]" });
	return { dir, folder, index, embedder, indexer };
}

const NOTES = {
	"precos/2026-10.md": "---\ntitle: Preços de outubro\nmodified: 2026-10-01\ntags: [precos]\n---\nA diária em outubro é de 400 por noite.\n",
	"rede.md": "---\ntitle: Rede\nmodified: 2026-09-01\ntags: [casa, rede]\n---\nO roteador reinicia sozinho; o sinal cai à noite.\n",
};

describe("NotesIndexer.reconcile", () => {
	test("new notes are added, an edited one changed, a deleted one removed; stats follow", async () => {
		const { dir, index, indexer } = await setup(NOTES);
		expect(await indexer.reconcile()).toEqual({ added: 2, changed: 0, removed: 0, failed: 0, retried: 0 });
		expect(await index.stats()).toEqual({ total: 2, indexed: 2, pending: 0, failed: 0 });
		expect(await indexer.reconcile()).toEqual({ added: 0, changed: 0, removed: 0, failed: 0, retried: 0 });
		writeFileSync(join(dir, "rede.md"), "# Rede\nTrocamos o roteador.\n");
		expect(await indexer.reconcile()).toMatchObject({ changed: 1, added: 0 });
		expect((await index.get("rede.md"))?.title).toBe("Rede");
		unlinkSync(join(dir, "precos/2026-10.md"));
		expect(await indexer.reconcile()).toMatchObject({ removed: 1 });
		expect(await index.stats()).toEqual({ total: 1, indexed: 1, pending: 0, failed: 0 });
		expect(await index.search({ query: "diária", limit: 5 })).toEqual([]);
	});

	test("concurrent calls share one sweep", async () => {
		const { indexer, embedder } = await setup(NOTES);
		const [a, b] = await Promise.all([indexer.reconcile(), indexer.reconcile()]);
		expect(a).toBe(b);
		expect(embedder.calls).toBe(2);
	});

	test("a failing embedder: failed, still found by words, retried until 3 attempts, then left alone; recovers when it works", async () => {
		const fail = { on: true };
		const { index, indexer, embedder } = await setup({ "rede.md": NOTES["rede.md"] }, fail);
		expect(await indexer.reconcile()).toMatchObject({ added: 1, failed: 1 });
		expect(await index.get("rede.md")).toMatchObject({ state: "failed", attempts: 1, error: "Embeddings 503" });
		expect((await index.search({ query: "roteador", limit: 5 })).map((h) => h.path)).toEqual(["rede.md"]);
		await indexer.reconcile();
		await indexer.reconcile();
		expect(await index.get("rede.md")).toMatchObject({ state: "failed", attempts: 3 });
		const calls = embedder.calls;
		expect(await indexer.reconcile()).toEqual({ added: 0, changed: 0, removed: 0, failed: 0, retried: 0 });
		expect(embedder.calls).toBe(calls);

		const again = await setup({ "rede.md": NOTES["rede.md"] }, fail);
		await again.indexer.reconcile();
		fail.on = false;
		expect(await again.indexer.reconcile()).toMatchObject({ retried: 1, failed: 0 });
		expect(await again.index.get("rede.md")).toMatchObject({ state: "indexed" });
	});
});

describe("LibSQLNotesIndex.search", () => {
	test("by word, accents folded, with a snippet", async () => {
		const { index, indexer } = await setup(NOTES);
		await indexer.reconcile();
		const hits = await index.search({ query: "precos", limit: 5 });
		expect(hits[0]).toMatchObject({ path: "precos/2026-10.md", title: "Preços de outubro", tags: ["precos"], modified: "2026-10-01", state: "indexed" });
		expect(hits[0]?.snippet).toContain("[Preços]");
	});

	test("by vector: the note whose chunk shares the most words comes first", async () => {
		const { index, indexer } = await setup(NOTES);
		await indexer.reconcile();
		const hits = await index.search({ queryVector: bagOfWords("roteador sinal noite"), limit: 5 });
		expect(hits.map((h) => h.path)).toEqual(["rede.md", "precos/2026-10.md"]);
		expect(hits[0]?.snippet).toContain("roteador");
	});

	test("folder and tag filters; without a query, most recently modified first", async () => {
		const { index, indexer } = await setup({ ...NOTES, "precos-antigos.md": "---\ntags: [precos]\n---\nnoite antiga\n" });
		await indexer.reconcile();
		expect((await index.search({ query: "noite", folder: "precos/", limit: 5 })).map((h) => h.path)).toEqual(["precos/2026-10.md"]);
		expect((await index.search({ query: "noite", tag: "rede", limit: 5 })).map((h) => h.path)).toEqual(["rede.md"]);
		expect((await index.search({ limit: 5 })).map((h) => h.path)).toEqual(["precos/2026-10.md", "rede.md", "precos-antigos.md"]);
		expect((await index.search({ tag: "precos", limit: 5 })).map((h) => h.path)).toEqual(["precos/2026-10.md", "precos-antigos.md"]);
	});
});

describe("LibSQLNotesIndex.open", () => {
	test("a database built for another folder or model is refused", async () => {
		const dir = mkdtempSync(join(tmpdir(), "notes-db-"));
		dirs.push(dir);
		const url = `file:${join(dir, "notes.db")}`;
		const first = await LibSQLNotesIndex.open({ url, root: "/a", model: MODEL, dims: DIMS });
		if ("off" in first) throw new Error(first.off);
		first.close();
		expect(await LibSQLNotesIndex.open({ url, root: "/b", model: MODEL, dims: DIMS })).toEqual({ off: "index built for /a, got /b" });
		expect(await LibSQLNotesIndex.open({ url, root: "/a", model: "other", dims: DIMS })).toMatchObject({
			off: expect.stringMatching(/^index built for stub-embed/),
		});
		const reopened = await LibSQLNotesIndex.open({ url, root: "/a", model: MODEL, dims: DIMS });
		expect("off" in reopened).toBe(false);
		if (!("off" in reopened)) reopened.close();
	});
});
