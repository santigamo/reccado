export function rawEmailR2Key(input: {
	env?: string;
	mailboxId: string;
	receivedAt: Date;
	rawSha256: string;
}): string {
	const env = input.env ?? "dev";
	const year = input.receivedAt.getUTCFullYear().toString();
	const month = String(input.receivedAt.getUTCMonth() + 1).padStart(2, "0");
	const day = String(input.receivedAt.getUTCDate()).padStart(2, "0");
	return `raw/${env}/${input.mailboxId}/${year}/${month}/${day}/${input.receivedAt.getTime()}-${input.rawSha256}.eml`;
}

export function bodyTextR2Key(input: {
	env?: string;
	mailboxId: string;
	messageLocalId: string;
}): string {
	const env = input.env ?? "dev";
	return `body/${env}/${input.mailboxId}/${input.messageLocalId}/text.txt`;
}

export function bodyHtmlR2Key(input: {
	env?: string;
	mailboxId: string;
	messageLocalId: string;
}): string {
	const env = input.env ?? "dev";
	return `body/${env}/${input.mailboxId}/${input.messageLocalId}/html.html`;
}

export function attachmentR2Key(input: {
	env?: string;
	mailboxId: string;
	messageLocalId: string;
	attachmentSha256: string;
	safeFilename: string;
}): string {
	const env = input.env ?? "dev";
	return `attachments/${env}/${input.mailboxId}/${input.messageLocalId}/${input.attachmentSha256}-${input.safeFilename}`;
}

export function exportR2Key(input: {
	env?: string;
	mailboxId: string;
	date: string;
	exportId: string;
}): string {
	const env = input.env ?? "dev";
	return `exports/${env}/${input.mailboxId}/${input.date}/${input.exportId}.ndjson`;
}

export function backupManifestR2Key(input: { env?: string; date: string; mailboxId: string }): string {
	const env = input.env ?? "dev";
	return `backups/${env}/${input.date}/${input.mailboxId}.manifest.json`;
}

export function sanitizeFilename(filename: string | null | undefined): string {
	if (!filename?.trim()) {
		return "attachment.bin";
	}
	const safe = filename.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
	return safe || "attachment.bin";
}
