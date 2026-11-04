import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotesFolder, notesConfig } from "../src/core/folder.ts";

const tmp = mkdtempSync(join(tmpdir(), "notes-"));
const base = join(tmp, "base");
const other = join(tmp, "other");
let folder: NotesFolder;

beforeAll(async () => {
	mkdirSync(join(base, "precos"), { recursive: true });
	mkdirSync(other);
	writeFileSync(join(other, "exame.md"), "SEGREDO\n");
	writeFileSync(join(base, "precos", "2026-11.md"), "# Preços\n");
	writeFileSync(join(base, `${"referência".normalize("NFD")}.md`), "# Referência\n");
	symlinkSync(join(other, "exame.md"), join(base, "link.md"));
	symlinkSync(other, join(base, "dir"));
	folder = await NotesFolder.open({ dir: base }, "[test]");
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("NotesFolder", () => {
	test("config is off without a directory; the db is optional", () => {
		expect(notesConfig("CLERK", {})).toEqual({ off: "CLERK_NOTES_DIR not set" });
		expect(notesConfig("CLERK", { CLERK_NOTES_DIR: join(tmp, "missing") })).toEqual({
			off: `${join(tmp, "missing")} is not a directory (notes folder not mounted)`,
		});
		expect(notesConfig("CLERK", { CLERK_NOTES_DIR: base })).toEqual({ dir: base });
		expect(notesConfig("CLERK", { CLERK_NOTES_DIR: base, CLERK_NOTES_DB: "file:/tmp/n.db" })).toEqual({ dir: base, db: "file:/tmp/n.db" });
	});

	test("listNotes returns only the two notes inside", async () => {
		const paths = (await folder.listNotes()).map((n) => n.path.normalize("NFC")).sort();
		expect(paths).toEqual(["precos/2026-11.md", "referência.md"]);
	});

	test("readNote finds an NFD file by its NFC name", async () => {
		expect((await folder.readNote("referência.md"))?.text).toBe("# Referência\n");
	});

	test("readNote refuses paths outside the root and symlinks", async () => {
		for (const p of ["../other/exame.md", join(other, "exame.md"), "link.md", "dir/exame.md"]) {
			expect(await folder.readNote(p)).toBeUndefined();
		}
	});

	test("searchNotes never reaches outside", async () => {
		expect(await folder.searchNotes("segredo")).toEqual([]);
	});

	test("putNote creates, checks the base sha and leaves no temp file", async () => {
		expect(await folder.putNote("cozinha.md", "nova\n", "t", undefined)).toBe("cozinha.md");
		expect(readdirSync(base).filter((f) => f.endsWith(".tmp"))).toEqual([]);
		await expect(folder.putNote("cozinha.md", "outra\n", "t", "deadbeef")).rejects.toThrow(/mudou desde a leitura/);
		const cur = await folder.readNote("cozinha.md");
		expect(await folder.putNote("cozinha.md", "outra\n", "t", cur?.sha)).toBe("cozinha.md");
		expect(readFileSync(join(base, "cozinha.md"), "utf8")).toBe("outra\n");
	});

	test("putNote refuses a path through a symlinked folder and `..`", async () => {
		await expect(folder.putNote("dir/novo/x.md", "x\n", "t", undefined)).rejects.toThrow(/fora da base/);
		expect(readdirSync(other)).toEqual(["exame.md"]);
		await expect(folder.putNote("../other/x.md", "x\n", "t", undefined)).rejects.toThrow(/caminho inválido/);
		expect(existsSync(join(other, "x.md"))).toBe(false);
	});

	test("two saves against the same base: one wins, the other is refused", async () => {
		await folder.putNote("corrida.md", "base\n", "t", undefined);
		const sha = (await folder.readNote("corrida.md"))?.sha;
		const r = await Promise.allSettled([folder.putNote("corrida.md", "primeiro\n", "t", sha), folder.putNote("corrida.md", "segundo\n", "t", sha)]);
		expect(r.map((x) => x.status)).toEqual(["fulfilled", "rejected"]);
		expect(readFileSync(join(base, "corrida.md"), "utf8")).toBe("primeiro\n");
	});

	test("putNote creates missing folders", async () => {
		expect(await folder.putNote("precos/2027/01.md", "# 2027\n", "t", undefined)).toBe("precos/2027/01.md");
		expect(readFileSync(join(base, "precos", "2027", "01.md"), "utf8")).toBe("# 2027\n");
	});
});
