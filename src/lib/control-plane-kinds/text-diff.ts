/** Line diff (LCS) for the approval page: "- old", "+ new", "  same". Null when too large to diff. */
const MAX_CELLS = 4_000_000;

export function lineDiff(before: string, after: string): string | null {
	const a = before.split("\n");
	const b = after.split("\n");
	if (a.length * b.length > MAX_CELLS) return null;
	const width = b.length + 1;
	const table = new Uint32Array((a.length + 1) * width);
	for (let i = a.length - 1; i >= 0; i--)
		for (let j = b.length - 1; j >= 0; j--)
			table[i * width + j] =
				a[i] === b[j]
					? table[(i + 1) * width + j + 1]! + 1
					: Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
	const out: string[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			out.push(`  ${a[i]}`);
			i++;
			j++;
		} else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) out.push(`- ${a[i++]}`);
		else out.push(`+ ${b[j++]}`);
	}
	while (i < a.length) out.push(`- ${a[i++]}`);
	while (j < b.length) out.push(`+ ${b[j++]}`);
	return out.join("\n");
}
