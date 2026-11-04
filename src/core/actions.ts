// The four note tools, framework-neutral: list_notes, read_note, search_notes and write_note. Each is a name, a
// description, a zod input schema and a run function; the Mastra tools (src/mastra/tools.ts) and the MCP server
// (src/mcp/server.ts) only adapt them. Paths are checked inside run, so both inherit the same rules.
//
// Descriptions and messages are in Brazilian Portuguese: they are read by the model, which answers in that language.
import { type Embedder, safeError, sha256 } from "@pitolabs/agent-docs";
import { z } from "zod";
import { fold, type NotesFolder } from "./folder.ts";
import type { NotesIndexer } from "./indexer.ts";
import type { NotesIndex } from "./store.ts";

export interface NotesActionsOptions {
	folder?: NotesFolder;
	index?: NotesIndex;
	indexer?: NotesIndexer;
	embedder?: Embedder;
	/** The base's name in the descriptions, after "base" (pt-BR): "da empresa", "de receitas". */
	kbName: string;
	/** Log prefix, e.g. "[notes]". */
	log?: string;
	/** true: no write_note (a read-only agent). Default false. */
	readOnly?: boolean;
	/** Paths read_note accepts; default: a kebab-case .md path, or "AGENTS.md". */
	readable?: (path: string) => boolean;
	/** Paths write_note accepts; default: kebab-case folders and name ending in .md (AGENTS.md never). */
	writable?: RegExp;
}

const KEBAB_MD = /^([a-z0-9][a-z0-9-]*\/)*[a-z0-9][a-z0-9-]*\.md$/;

export const ListNotesInput = z.object({ folder: z.string().max(200).optional() });
export const ReadNoteInput = z.object({ path: z.string().max(300) });
export const SearchNotesInput = z.object({
	query: z.string().min(2).max(300),
	folder: z.string().max(200).optional(),
	tag: z.string().max(60).optional(),
	limit: z.number().int().min(1).max(20).default(8),
});
export const WriteNoteInput = z.object({
	path: z.string().max(300),
	full_text: z.string().min(1).max(200_000),
	base_sha: z
		.string()
		.regex(/^[0-9a-f]{64}$/)
		.optional(),
	reason: z.string().min(3).max(200).describe("Uma frase: o que muda e por quê (vai para o log)."),
});

export interface NoteAction<I, O> {
	name: string;
	description: string;
	input: z.ZodType<I>;
	run(input: I): Promise<O>;
}

type Result = Record<string, unknown>;
const UNAVAILABLE = { error: "base de conhecimento indisponível (pasta não montada)" };
/** Errors thrown by NotesFolder.putNote with a message safe to show (built from the path only, never the text). */
const OWN_ERROR = /^(a nota mudou desde a leitura|caminho inválido|caminho fora da base)/;

/** list_notes, read_note, search_notes and (unless readOnly) write_note, in this order. */
export function notesActions(o: NotesActionsOptions): NoteAction<unknown, Result>[] {
	const log = o.log ?? "[notes]";
	const readable = o.readable ?? ((p: string) => p === "AGENTS.md" || KEBAB_MD.test(p));
	const writable = o.writable ?? KEBAB_MD;

	const list: NoteAction<z.infer<typeof ListNotesInput>, Result> = {
		name: "list_notes",
		description: `Lista os caminhos das notas da base ${o.kbName}, relativos à base (ex.: AGENTS.md, precos/2026-10.md); opcional: só as de uma pasta, ex. "precos".`,
		input: ListNotesInput,
		async run({ folder }) {
			if (!o.folder) return UNAVAILABLE;
			const prefix = folder?.replace(/\/+$/, "");
			const notes = (await o.folder.listNotes()).map((n) => n.path).filter((p) => !prefix || p.startsWith(`${prefix}/`));
			return { notes: notes.sort() };
		},
	};

	const read: NoteAction<z.infer<typeof ReadNoteInput>, Result> = {
		name: "read_note",
		description: `Lê uma nota inteira da base ${o.kbName}, pelo caminho relativo à base (como list_notes e search_notes devolvem, ex.: precos/2026-10.md). Devolve o texto e o sha, que write_note exige para alterar a nota.`,
		input: ReadNoteInput,
		async run({ path }) {
			if (!o.folder) return UNAVAILABLE;
			const p = path.normalize("NFC");
			if (!readable(p)) return { error: "caminho de nota .md (ou AGENTS.md)" };
			const note = await o.folder.readNote(p);
			return note ? { path: note.path, sha: note.sha, text: note.text } : { error: `a nota ${p} não existe` };
		},
	};

	const search: NoteAction<z.infer<typeof SearchNotesInput>, Result> = {
		name: "search_notes",
		description: `Busca notas da base ${o.kbName} por palavras e por significado (sem diferenciar maiúsculas e acentos). Devolve as notas mais relevantes com um trecho; leia a nota com read_note antes de afirmar algo.`,
		input: SearchNotesInput,
		async run({ query, folder, tag, limit }) {
			if (o.index) {
				let queryVector: number[] | undefined;
				let fallback: Result = {};
				if (o.embedder) {
					try {
						queryVector = (await o.embedder.embed([query], "query"))[0];
					} catch (e) {
						const err = safeError(e);
						await o.index.noteSemanticFailure(err).catch(() => undefined);
						console.error(`${log} search keyword-only: query embedding failed: ${err}`);
						fallback = { search_mode: "keyword-only", warning: "busca por significado indisponível agora; só palavras" };
					}
				} else fallback = { search_mode: "keyword-only" };
				const notes = await o.index.search({
					query,
					...(queryVector ? { queryVector } : {}),
					...(folder ? { folder } : {}),
					...(tag ? { tag: fold(tag.trim().replace(/^#/, "")) } : {}),
					limit,
				});
				return { notes, ...(await o.index.stats()), ...fallback };
			}
			if (o.folder) {
				const results = await o.folder.searchNotes(query);
				const prefix = folder?.replace(/\/+$/, "");
				return { results: prefix ? results.filter((r) => r.path.startsWith(`${prefix}/`)) : results, search_mode: "words" };
			}
			return UNAVAILABLE;
		},
	};

	const write: NoteAction<z.infer<typeof WriteNoteInput>, Result> = {
		name: "write_note",
		description: `Cria ou substitui UMA nota da base ${o.kbName} (caminho relativo à base, ex.: precos/2026-11.md) com o texto completo final (com frontmatter e \`modified\` atualizado). Para alterar uma nota que existe, leia-a antes com read_note e passe o \`sha\` devolvido em base_sha; se a nota mudou desde então, a escrita é recusada.`,
		input: WriteNoteInput,
		async run({ path, full_text, base_sha, reason }) {
			if (!o.folder) return UNAVAILABLE;
			const p = path.normalize("NFC");
			if (p === "AGENTS.md" || p.endsWith("/AGENTS.md") || !writable.test(p)) {
				return { error: "caminho em kebab-case terminando em .md, ex.: contatos.md ou precos/2026-11.md" };
			}
			const current = await o.folder.readNote(p);
			if (current && base_sha === undefined) return { error: "a nota já existe: leia com read_note e passe base_sha" };
			const text = full_text.endsWith("\n") ? full_text : `${full_text}\n`;
			let written: string;
			try {
				written = await o.folder.putNote(p, text, reason, base_sha);
			} catch (e) {
				const msg = e instanceof Error && OWN_ERROR.test(e.message) ? e.message : safeError(e);
				return { error: msg };
			}
			try {
				await o.indexer?.touch(written);
			} catch (e) {
				console.error(`${log} index after write failed: ${safeError(e)}`);
			}
			return { path: written, sha: sha256(Buffer.from(text)), created: !current };
		},
	};

	const actions = [list, read, search, ...(o.readOnly ? [] : [write])];
	return actions as unknown as NoteAction<unknown, Result>[];
}
