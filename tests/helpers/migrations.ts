/**
 * Applying a migration in a test means cutting the file into statements, and
 * `split(";")` is not that cut: a semicolon inside a comment or a string literal
 * is text, and slicing there hands D1 two syntax errors instead of one statement.
 * Several test files each carried their own naive split, so a single semicolon in
 * a migration comment broke all of them at once -- and the fix that time was to
 * reword the comment. The split lives here now, and it honours the same
 * delimiters SQLite does.
 */

/** Index just past the closing quote; a doubled quote ('' / "") escapes, not ends. */
function endOfQuoted(sql: string, start: number, quote: string): number {
	let i = start + 1;
	while (i < sql.length) {
		if (sql.charAt(i) === quote) {
			if (sql.charAt(i + 1) === quote) {
				i += 2;
				continue;
			}
			return i + 1;
		}
		i += 1;
	}
	// Unterminated literal: hand the rest back whole so the driver reports the real
	// error, instead of inventing statement boundaries inside it.
	return sql.length;
}

/**
 * Splits SQL on statement-terminating semicolons only. Line comments, block
 * comments and quoted text ('…', "…", `…`) are copied through verbatim.
 * Chunks holding nothing but comments and whitespace are dropped: they are not
 * statements, and D1 rejects them.
 */
export function splitSqlStatements(sql: string): string[] {
	const statements: string[] = [];
	let current = "";
	let hasSql = false;
	let i = 0;
	while (i < sql.length) {
		const char = sql.charAt(i);
		const next = sql.charAt(i + 1);
		if (char === "-" && next === "-") {
			const newline = sql.indexOf("\n", i);
			const end = newline === -1 ? sql.length : newline;
			current += sql.slice(i, end);
			i = end;
			continue;
		}
		if (char === "/" && next === "*") {
			const close = sql.indexOf("*/", i + 2);
			const end = close === -1 ? sql.length : close + 2;
			current += sql.slice(i, end);
			i = end;
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			const end = endOfQuoted(sql, i, char);
			current += sql.slice(i, end);
			hasSql = true;
			i = end;
			continue;
		}
		if (char === ";") {
			if (hasSql) statements.push(current.trim());
			current = "";
			hasSql = false;
			i += 1;
			continue;
		}
		current += char;
		if (!/\s/.test(char)) hasSql = true;
		i += 1;
	}
	if (hasSql) statements.push(current.trim());
	return statements.filter((statement) => statement.length > 0);
}

/**
 * The vitest-pool-workers D1 binding starts schema-less -- it does not auto-apply
 * migrations/d1/*.sql -- and D1Database#exec() only accepts one statement per
 * line, which the multi-line CREATE TABLEs in those files are not. So every suite
 * that needs a schema replays the migrations through prepare().run().
 */
export async function applyMigrations(db: D1Database, ...sql: string[]): Promise<void> {
	for (const statement of splitSqlStatements(sql.join("\n"))) {
		await db.prepare(statement).run();
	}
}
