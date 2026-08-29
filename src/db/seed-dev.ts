import {
	getDomainByName,
	getMailbox,
	insertAlias,
	insertDomain,
	insertMailbox,
	lookupActiveAlias,
} from "../db/d1";

/**
 * Frozen literals, not generated ids: the dev seed, the debug endpoint and the smoke scripts
 * all have to agree on one id without talking to each other, and a local D1 seeded before this
 * file existed must keep resolving. These are the ids the retired HMAC derivation produced for
 * the dev secret, so existing local databases need no reseed.
 */
export const DEV_TEST_MAILBOX_ID = "mbx_9geg4pksn6eh4urfa7stv70pkg";
const DEV_MAIL_DOMAIN_MAILBOX_ID = "mbx_2t26m1fn8ov353e3p7n8rco60i";

export function deriveDevTestMailboxId(): string {
	return DEV_TEST_MAILBOX_ID;
}

/**
 * DEV ONLY. Seeds a fixed `test@example.com` mailbox (plus a second
 * multi-domain fixture) into the D1 control plane. This is scaffolding for
 * local/dev environments and must never run against a production database.
 *
 * Safe by default: callers MUST explicitly opt in via `opts.force`. Without
 * it, this is a no-op that only reports the fixed dev mailbox id,
 * so an accidental/forgotten call site (e.g. left on a production code path)
 * can't scaffold fake mailbox/domain/alias rows into a real database.
 */
export async function seedDevData(
	db: D1Database,
	opts: { force?: boolean } = {},
): Promise<{ mailboxId: string; seeded: boolean }> {
	if (!opts.force) {
		return { mailboxId: DEV_TEST_MAILBOX_ID, seeded: false };
	}

	const existing = await lookupActiveAlias(db, "test@example.com");
	if (existing) {
		return { mailboxId: existing.mailbox_id, seeded: false };
	}

	const mailboxId = DEV_TEST_MAILBOX_ID;
	const domainName = "example.com";
	let domain = await getDomainByName(db, domainName);
	if (!domain) {
		const domainId = "dom_example_dev";
		await insertDomain(db, {
			id: domainId,
			domain: domainName,
			zone_id: "dev-zone-placeholder",
			status: "active",
		});
		domain = await getDomainByName(db, domainName);
	}
	if (!domain) {
		throw new Error("Failed to seed domain");
	}

	if (!(await getMailbox(db, mailboxId))) {
		await insertMailbox(db, {
			mailbox_id: mailboxId,
			primary_address: "test@example.com",
			display_name: "Dev Test Mailbox",
			status: "active",
			owner_email: "dev@local",
		});
	}

	await insertAlias(db, {
		alias_address: "test@example.com",
		mailbox_id: mailboxId,
		domain_id: domain.id,
		status: "active",
	});

	// Second domain seed for Milestone 1.8 multi-domain validation.
	const secondDomainName = "mail.example.com";
	let secondDomain = await getDomainByName(db, secondDomainName);
	if (!secondDomain) {
		const secondDomainId = "dom_mail_example_dev";
		await insertDomain(db, {
			id: secondDomainId,
			domain: secondDomainName,
			zone_id: "dev-zone-mail-placeholder",
			status: "active",
		});
		secondDomain = await getDomainByName(db, secondDomainName);
	}
	if (secondDomain) {
		const secondMailboxId = DEV_MAIL_DOMAIN_MAILBOX_ID;
		if (!(await getMailbox(db, secondMailboxId))) {
			await insertMailbox(db, {
				mailbox_id: secondMailboxId,
				primary_address: "inbox@mail.example.com",
				display_name: "Mail Domain Inbox",
				status: "active",
				owner_email: "dev@local",
			});
		}
		const secondAlias = await lookupActiveAlias(db, "inbox@mail.example.com");
		if (!secondAlias) {
			await insertAlias(db, {
				alias_address: "inbox@mail.example.com",
				mailbox_id: secondMailboxId,
				domain_id: secondDomain.id,
				status: "active",
			});
		}
	}

	return { mailboxId, seeded: true };
}
