import { deriveMailboxId } from "../lib/mailbox-id";
import {
	getDomainByName,
	getMailbox,
	insertAlias,
	insertDomain,
	insertMailbox,
	lookupActiveAlias,
} from "../db/d1";

const DEV_SECRET = "dev-mailbox-id-secret-v1";

export async function deriveDevTestMailboxId(): Promise<string> {
	return deriveMailboxId(DEV_SECRET, "test@example.com");
}

export async function seedDevData(db: D1Database): Promise<{ mailboxId: string; seeded: boolean }> {
	const existing = await lookupActiveAlias(db, "test@example.com");
	if (existing) {
		return { mailboxId: existing.mailbox_id, seeded: false };
	}

	const mailboxId = await deriveDevTestMailboxId();
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
		const secondMailboxId = await deriveMailboxId(DEV_SECRET, "inbox@mail.example.com");
		if (!(await getMailbox(db, secondMailboxId))) {
			await insertMailbox(db, {
				mailbox_id: secondMailboxId,
				primary_address: "inbox@mail.example.com",
				display_name: "Mail Domain Inbox",
				status: "active",
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
