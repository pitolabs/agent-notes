// A note's YAML frontmatter (Obsidian's properties) and what the index keeps from it. Never throws: a note whose
// frontmatter does not parse is indexed whole, as plain text.
import { parse } from "yaml";
import { fold } from "./folder.ts";

export interface ParsedNote {
	frontmatter: Record<string, unknown>;
	/** The text after the frontmatter (the whole text when there is none). */
	body: string;
	title: string;
	/** Folded (lower case, no accents), without `#`. */
	tags: string[];
	/** `modified` when it is a YYYY-MM-DD date. */
	modified?: string;
	aliases: string[];
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : []);

export function parseNote(path: string, text: string): ParsedNote {
	let frontmatter: Record<string, unknown> = {};
	let body = text;
	const m = FRONTMATTER.exec(text);
	if (m) {
		try {
			// The core schema has no timestamp type: `created: 2026-09-28` stays a string, never a Date.
			const v: unknown = parse(m[1] ?? "", { schema: "core" });
			if (v && typeof v === "object" && !Array.isArray(v)) {
				frontmatter = v as Record<string, unknown>;
				body = text.slice(m[0].length);
			}
		} catch {
			// Invalid YAML: the whole text is the body. The error is not logged: it may quote the note.
		}
	}
	const title =
		(typeof frontmatter.title === "string" && frontmatter.title.trim()) ||
		/^# (.+)$/m.exec(body)?.[1]?.trim() ||
		(path.split("/").at(-1) ?? path).replace(/\.md$/, "");
	const tags = [...new Set(strings(frontmatter.tags).map((t) => fold(t.trim().replace(/^#/, ""))))].filter(Boolean);
	const mod = frontmatter.modified;
	const modified = mod !== undefined && mod !== null && /^\d{4}-\d{2}-\d{2}$/.test(String(mod)) ? String(mod) : undefined;
	const aliases = Array.isArray(frontmatter.aliases) ? strings(frontmatter.aliases) : [];
	return { frontmatter, body, title, tags, ...(modified ? { modified } : {}), aliases };
}
