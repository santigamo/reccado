import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { insertMailbox } from "#/db/d1";
import {
	canonicalPrimaryAddress,
	generateMailboxId,
	mailboxIdFromPrimaryAddress,
} from "#/lib/mailbox-id";
import migration1 from "../../migrations/d1/0001_initial.sql?raw";
import migration2 from "../../migrations/d1/0002_message_index.sql?raw";
import migration3 from "../../migrations/d1/0003_mailbox_owner.sql?raw";
import { splitSqlStatements } from "../helpers/migrations";

async function applyMigrations(): Promise<void> {
	const statements = splitSqlStatements([migration1, migration2, migration3].join("\n"));
	for (const statement of statements) {
		await env.INDEX_DB.prepare(statement).run();
	}
}

describe("mailbox-id", () => {
	it("canonicalizes primary addresses", () => {
		expect(canonicalPrimaryAddress(" Test@Example.COM ")).toBe("test@example.com");
	});

	it("rejects an address with no '@' separator", () => {
		expect(() => canonicalPrimaryAddress("not-an-email")).toThrow(
			"Invalid email address: not-an-email",
		);
	});

	it("rejects an address starting with '@' (empty local part)", () => {
		expect(() => canonicalPrimaryAddress("@example.com")).toThrow();
	});

	it("rejects an address with an empty domain part", () => {
		expect(() => canonicalPrimaryAddress("test@")).toThrow();
	});

	describe("generateMailboxId", () => {
		it("produces a fixed-length mbx_ prefixed identifier", () => {
			// mbx_ (4 chars) + 26 base32url chars — the format pre-existing rows already use.
			expect(generateMailboxId()).toMatch(/^mbx_[0-9a-v]{26}$/);
		});

		it("does not repeat itself", () => {
			const ids = new Set(Array.from({ length: 200 }, () => generateMailboxId()));
			expect(ids.size).toBe(200);
		});
	});
});

describe("provisioning idempotency (D1, not derivation)", () => {
	beforeAll(async () => {
		await applyMigrations();
	});

	it("assigns a random id when insertMailbox is given none", async () => {
		const mailboxId = await insertMailbox(env.INDEX_DB, {
			primary_address: "assigned@example.com",
			display_name: null,
			status: "active",
			owner_email: null,
		});
		expect(mailboxId).toMatch(/^mbx_[0-9a-v]{26}$/);
	});

	it("returns the stored id when the same address is inserted twice", async () => {
		const row = {
			primary_address: "repeat@example.com",
			display_name: null,
			status: "active" as const,
			owner_email: null,
		};
		const first = await insertMailbox(env.INDEX_DB, row);
		const second = await insertMailbox(env.INDEX_DB, row);
		expect(second).toBe(first);

		const count = await env.INDEX_DB.prepare(
			"SELECT COUNT(*) AS n FROM mailboxes WHERE primary_address = ?",
		)
			.bind(row.primary_address)
			.first<{ n: number }>();
		expect(count?.n).toBe(1);
	});

	it("keeps the existing id even when a caller proposes a different one", async () => {
		const stored = await insertMailbox(env.INDEX_DB, {
			mailbox_id: "mbx_preexisting_row_id",
			primary_address: "preexisting@example.com",
			display_name: null,
			status: "active",
			owner_email: null,
		});
		const again = await insertMailbox(env.INDEX_DB, {
			mailbox_id: generateMailboxId(),
			primary_address: "preexisting@example.com",
			display_name: null,
			status: "active",
			owner_email: null,
		});
		expect(stored).toBe("mbx_preexisting_row_id");
		expect(again).toBe("mbx_preexisting_row_id");
	});

	it("mailboxIdFromPrimaryAddress resolves an existing address to its stored id", async () => {
		const stored = await insertMailbox(env.INDEX_DB, {
			primary_address: "resolve@example.com",
			display_name: null,
			status: "active",
			owner_email: null,
		});
		// Canonicalized before lookup, so casing/whitespace still finds the row.
		await expect(mailboxIdFromPrimaryAddress(env, "  Resolve@Example.COM ")).resolves.toBe(stored);
	});

	it("mailboxIdFromPrimaryAddress mints a fresh id for an unknown address", async () => {
		const first = await mailboxIdFromPrimaryAddress(env, "unknown@example.com");
		const second = await mailboxIdFromPrimaryAddress(env, "unknown@example.com");
		expect(first).toMatch(/^mbx_[0-9a-v]{26}$/);
		expect(second).not.toBe(first);
	});
});
