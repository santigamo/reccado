import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApiKey, updateApiKeySenderName } from "#/do/transactional-key-ops";
import { resolveSenderIdentity } from "#/lib/sender-identity";
import {
	isValidSenderName,
	MAX_SENDER_NAME_LENGTH,
	normalizeSenderName,
} from "#/lib/transactional-keys";

const testEnv = env as unknown as Env;
const PEPPER = "test-pepper-for-display-names";

async function withMailbox<T>(
	name: string,
	fn: (state: DurableObjectState) => Promise<T>,
): Promise<T> {
	const stub = testEnv.MAILBOX_DO.getByName(name);
	return runInDurableObject(stub, async (_instance, state) => fn(state));
}

// ---------------------------------------------------------------------------
// The security boundary
// ---------------------------------------------------------------------------

describe("sender name validation", () => {
	// This is why the validation exists. A display name is operator-supplied text
	// that lands in a mail header; a newline in it would append headers to EVERY
	// message the key sends — a second Bcc, a different Reply-To — with nothing
	// else to show it happened.
	it.each([
		["a line feed", "Eccos\nBcc: attacker@example.com"],
		["a carriage return", "Eccos\rBcc: attacker@example.com"],
		["a CRLF pair", "Eccos\r\nX-Injected: yes"],
		["a NUL byte", `Eccos${String.fromCharCode(0)}`],
		["another control character", `Eccos${String.fromCharCode(1)}`],
		["a DEL character", `Eccos${String.fromCharCode(127)}`],
	])("refuses %s", (_label, value) => {
		expect(isValidSenderName(value)).toBe(false);
		expect(() => normalizeSenderName(value)).toThrow();
	});

	// The address-form delimiters. A name containing them would either be escaped
	// into something the operator did not intend, or produce a header that parses
	// as a different address entirely.
	it.each([
		["an opening angle bracket", "Eccos <hello@evil.test"],
		["a closing angle bracket", "Eccos>"],
		["a double quote", 'Ecc"os'],
	])("refuses %s", (_label, value) => {
		expect(isValidSenderName(value)).toBe(false);
	});

	it("refuses a name longer than the cap", () => {
		expect(isValidSenderName("a".repeat(MAX_SENDER_NAME_LENGTH + 1))).toBe(false);
		expect(isValidSenderName("a".repeat(MAX_SENDER_NAME_LENGTH))).toBe(true);
	});

	// Provisional, and the comment on isValidSenderName explains why. RFC 5322 does
	// not allow raw UTF-8 in a header — a non-ASCII name needs RFC 2047 encoded-word
	// encoding — and the builder is resolved inside a closed service, so neither the
	// docs nor workerd's source says whether it does that. Accepting it would fail
	// SILENTLY: correct in whichever client you tested, mojibake in others, on mail
	// already sent.
	//
	// Do not delete this on the strength of one green wire check. A pass is a
	// snapshot of current service behaviour, not a contract, so lifting the
	// restriction means accepting a silent regression whenever that behaviour
	// changes. The durable fix is the raw-MIME overload, costed in that comment.
	it("refuses non-ASCII until the wire encoding is verified", () => {
		expect(isValidSenderName("Café Ñandú")).toBe(false);
		expect(() => normalizeSenderName("Café")).toThrow();
	});

	it("accepts the printable ASCII a brand name actually needs", () => {
		for (const name of ["Eccos", "Acme Inc.", "Foo & Bar", "Support (EU)", "A-B_C 123"]) {
			expect(isValidSenderName(name)).toBe(true);
		}
		expect(normalizeSenderName("  Acme Inc.  ")).toBe("Acme Inc.");
	});

	it("treats empty and whitespace-only as absent rather than as a name", () => {
		// Null and "" must not be two states: an empty-string name renders as a
		// stray space before the address instead of a bare address.
		expect(normalizeSenderName("")).toBeNull();
		expect(normalizeSenderName("   ")).toBeNull();
		expect(normalizeSenderName(null)).toBeNull();
		expect(normalizeSenderName(undefined)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Transactional: per-key names
// ---------------------------------------------------------------------------

describe("transactional key sender names", () => {
	it("stores a name given at creation and returns it in the projection", async () => {
		const result = await withMailbox("mbx-name-create", async (state) =>
			createApiKey(state.storage.sql, PEPPER, "mbx-name-create", {
				environment: "test",
				sender: "hello@notify.example.test",
				senderName: "Eccos",
				scopes: ["transactional:send", "transactional:templates:use"],
				templateAllowlist: ["verify-email"],
			}),
		);
		expect(result.key.senderName).toBe("Eccos");
		expect(result.projection.senderName).toBe("Eccos");
	});

	it("leaves the name null when none is given, which is what existing keys do", async () => {
		const result = await withMailbox("mbx-name-absent", async (state) =>
			createApiKey(state.storage.sql, PEPPER, "mbx-name-absent", {
				environment: "test",
				sender: "hello@notify.example.test",
				scopes: ["transactional:status"],
			}),
		);
		expect(result.key.senderName).toBeNull();
	});

	it("sets a name on an existing key without touching the secret", async () => {
		const outcome = await withMailbox("mbx-name-patch", async (state) => {
			const created = await createApiKey(state.storage.sql, PEPPER, "mbx-name-patch", {
				environment: "test",
				sender: "hello@notify.example.test",
				scopes: ["transactional:status"],
			});
			const updated = updateApiKeySenderName(state.storage.sql, created.key.keyId, "Eccos");
			return { created, updated };
		});
		expect(outcome.updated?.key.senderName).toBe("Eccos");
		// The whole point of a PATCH over a reissue: the credential is unchanged.
		expect(outcome.updated?.key.keyHash).toBe(outcome.created.key.keyHash);
		expect(outcome.updated?.key.displaySuffix).toBe(outcome.created.key.displaySuffix);
		expect(outcome.updated?.key.sender).toBe(outcome.created.key.sender);
	});

	it("clears the name back to the bare address", async () => {
		const updated = await withMailbox("mbx-name-clear", async (state) => {
			const created = await createApiKey(state.storage.sql, PEPPER, "mbx-name-clear", {
				environment: "test",
				sender: "hello@notify.example.test",
				senderName: "Eccos",
				scopes: ["transactional:status"],
			});
			return updateApiKeySenderName(state.storage.sql, created.key.keyId, null);
		});
		expect(updated?.key.senderName).toBeNull();
	});

	it("records both sides of the change, because that is what an audit log is asked", async () => {
		const events = await withMailbox("mbx-name-audit", async (state) => {
			const created = await createApiKey(state.storage.sql, PEPPER, "mbx-name-audit", {
				environment: "test",
				sender: "hello@notify.example.test",
				senderName: "Old",
				scopes: ["transactional:status"],
			});
			updateApiKeySenderName(state.storage.sql, created.key.keyId, "New");
			return state.storage.sql
				.exec(
					"SELECT event_type, metadata_json FROM api_key_events WHERE key_id = ? AND event_type = 'sender_name_updated'",
					created.key.keyId,
				)
				.toArray() as Array<{ event_type: string; metadata_json: string }>;
		});
		expect(events).toHaveLength(1);
		expect(JSON.parse(events[0]!.metadata_json)).toEqual({ from: "Old", to: "New" });
	});

	it("refuses a name that cannot go in a header", async () => {
		await expect(
			withMailbox("mbx-name-inject", async (state) => {
				const created = await createApiKey(state.storage.sql, PEPPER, "mbx-name-inject", {
					environment: "test",
					sender: "hello@notify.example.test",
					scopes: ["transactional:status"],
				});
				return updateApiKeySenderName(
					state.storage.sql,
					created.key.keyId,
					"Eccos\nBcc: attacker@example.com",
				);
			}),
		).rejects.toThrow(/invalid_sender_name/);
	});

	it("returns null for a key that does not exist", async () => {
		const result = await withMailbox("mbx-name-missing", async (state) =>
			updateApiKeySenderName(state.storage.sql, "key_does_not_exist", "Eccos"),
		);
		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Conversational: the mailbox's own name
// ---------------------------------------------------------------------------

describe("conversational sender identity", () => {
	const baseEnv = {
		MAIL_FROM_ADDRESS: "noreply@mail.imsanti.dev",
		MAIL_SENDING_DOMAINS: "imsanti.dev",
	};

	it("carries the name when the mailbox sends as itself", () => {
		expect(resolveSenderIdentity(baseEnv, "hello@imsanti.dev", "Santi")).toEqual({
			from: "hello@imsanti.dev",
			fromName: "Santi",
			replyTo: null,
		});
	});

	it("keeps the name when relaying through the fallback sender", () => {
		// The name describes the mailbox, and the mailbox is who will read the
		// reply — so naming it on the relay address is the honest rendering.
		expect(resolveSenderIdentity(baseEnv, "hello@unverified.test", "Santi")).toEqual({
			from: "noreply@mail.imsanti.dev",
			fromName: "Santi",
			replyTo: "hello@unverified.test",
		});
	});

	it("stays bare when the mailbox has no name", () => {
		expect(resolveSenderIdentity(baseEnv, "hello@imsanti.dev").fromName).toBeNull();
	});

	it("drops an unusable name rather than refusing to send", () => {
		// Deliberately different from the transactional path, which throws. This one
		// runs on the send path: failing to deliver a reply because a mailbox has an
		// odd display name would be a worse outcome than sending it bare.
		expect(
			resolveSenderIdentity(baseEnv, "hello@imsanti.dev", "Santi\nBcc: attacker@example.com")
				.fromName,
		).toBeNull();
		expect(resolveSenderIdentity(baseEnv, "hello@imsanti.dev", "   ").fromName).toBeNull();
		// Including a name that is merely un-encodable rather than dangerous: the
		// reply still goes out, just without the name.
		expect(resolveSenderIdentity(baseEnv, "hello@imsanti.dev", "Café").fromName).toBeNull();
	});
});
