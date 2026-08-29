import { describe, expect, it } from "vitest";
import { splitSqlStatements } from "../helpers/migrations";

// The failure this guards against is not hypothetical: every suite that replays
// migrations used to cut on a bare `split(";")`, so one semicolon inside a
// migration comment broke all of them at once and the comment got reworded to
// keep the tests green.
describe("splitSqlStatements", () => {
	it("splits on statement terminators", () => {
		expect(splitSqlStatements("CREATE TABLE a (id TEXT);\nCREATE TABLE b (id TEXT);\n")).toEqual([
			"CREATE TABLE a (id TEXT)",
			"CREATE TABLE b (id TEXT)",
		]);
	});

	it("ignores a semicolon inside a -- line comment", () => {
		const sql =
			"-- owner_email is NULL for legacy rows; MCP fails closed on that\nALTER TABLE mailboxes ADD COLUMN owner_email TEXT;";
		const statements = splitSqlStatements(sql);
		expect(statements).toHaveLength(1);
		expect(statements[0]).toContain("ALTER TABLE mailboxes ADD COLUMN owner_email TEXT");
	});

	it("ignores a semicolon inside a block comment", () => {
		const sql = "/* one statement; not two */ CREATE INDEX idx ON mailboxes (owner_email);";
		expect(splitSqlStatements(sql)).toEqual([
			"/* one statement; not two */ CREATE INDEX idx ON mailboxes (owner_email)",
		]);
	});

	it("ignores a semicolon inside a string literal", () => {
		const sql = "INSERT INTO runtime_config (key, value) VALUES ('a;b', 'c');";
		expect(splitSqlStatements(sql)).toEqual([
			"INSERT INTO runtime_config (key, value) VALUES ('a;b', 'c')",
		]);
	});

	it("ignores a semicolon inside a quoted identifier and honours doubled quotes", () => {
		expect(splitSqlStatements(`CREATE TABLE "odd;name" (v TEXT DEFAULT 'it''s; fine');`)).toEqual([
			`CREATE TABLE "odd;name" (v TEXT DEFAULT 'it''s; fine')`,
		]);
	});

	it("drops chunks that are only comments or whitespace", () => {
		const sql =
			"-- migration 0011\n\nCREATE TABLE a (id TEXT);\n\n-- trailing note; nothing follows\n";
		expect(splitSqlStatements(sql)).toEqual(["-- migration 0011\n\nCREATE TABLE a (id TEXT)"]);
	});

	it("keeps an unterminated literal whole instead of splitting inside it", () => {
		expect(splitSqlStatements("SELECT 'unterminated; still one chunk")).toEqual([
			"SELECT 'unterminated; still one chunk",
		]);
	});
});
