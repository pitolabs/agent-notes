import type { Embedder } from "@pitolabs/agent-docs";

export const MODEL = "stub-embed";
export const DIMS = 1024;

/** Words folded like FTS (lower case, no accents), each hashed into one of 1024 dimensions; unit length. */
export function bagOfWords(t: string): number[] {
	const v = new Array<number>(DIMS).fill(0);
	for (const w of t
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)) {
		if (w.length < 2) continue;
		let h = 0;
		for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
		v[h % DIMS] = (v[h % DIMS] ?? 0) + 1;
	}
	const norm = Math.hypot(...v) || 1;
	return v.map((x) => x / norm);
}

/** The bag-of-words embedder; `fail.on` true makes every call throw like a provider error ("Embeddings 503"). */
export function stubEmbedder(fail = { on: false }): Embedder & { calls: number } {
	const e = {
		model: MODEL,
		dims: DIMS,
		calls: 0,
		embed: async (texts: string[]) => {
			e.calls++;
			if (fail.on) throw new Error("Embeddings 503");
			return texts.map(bagOfWords);
		},
	};
	return e;
}
