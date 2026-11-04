import { describe, expect, test } from "bun:test";
import { parseNote } from "../src/core/frontmatter.ts";

describe("parseNote", () => {
	test("an Obsidian frontmatter: title, inline and block tags folded, an unquoted date stays a string", () => {
		const inline = parseNote(
			"cozinha/pao.md",
			'---\ntitle: "Pão de fermentação natural"\naliases: ["Pão", "Levain"]\ncreated: 2026-09-28\nmodified: 2026-09-28\ntags: [Receitas, "#Pães"]\n---\n# Outro título\n\nFarinha e água.\n',
		);
		expect(inline).toMatchObject({
			title: "Pão de fermentação natural",
			tags: ["receitas", "paes"],
			modified: "2026-09-28",
			aliases: ["Pão", "Levain"],
			body: "# Outro título\n\nFarinha e água.\n",
		});
		expect(inline.frontmatter.created).toBe("2026-09-28");
		const block = parseNote("x.md", "---\ntags:\n  - casa\n  - Manutenção\nmodified: ontem\n---\ncorpo\n");
		expect(block.tags).toEqual(["casa", "manutencao"]);
		expect(block.modified).toBeUndefined();
		expect(block.title).toBe("x");
	});

	test("no frontmatter: the title comes from the first heading, the body is the whole text", () => {
		expect(parseNote("a/b.md", "texto\n# Cabeçalho\n")).toEqual({ frontmatter: {}, body: "texto\n# Cabeçalho\n", title: "Cabeçalho", tags: [], aliases: [] });
	});

	test("invalid YAML: the whole text is the body, frontmatter {}", () => {
		const text = "---\ntitle: [aberto\n---\n# Nota\n";
		expect(parseNote("nota-x.md", text)).toEqual({ frontmatter: {}, body: text, title: "Nota", tags: [], aliases: [] });
	});
});
