/**
 * Classifies a provider error as ambiguous (the provider may have accepted the
 * message before the error surfaced) vs. definitely-not-delivered (the provider
 * explicitly rejected the message). Only known non-delivery signals return false;
 * everything else — network timeout, DNS failure, unknown error code — is
 * ambiguous and must NOT be auto-retried.
 *
 * Duplicated from mailbox-do.ts for shared use in the transactional send path.
 * The mailbox-do.ts version should eventually import from here instead of
 * defining its own copy, but that is left for a follow-up refactor to avoid
 * disrupting the existing, validated code.
 */
export function isAmbiguousProviderError(error: unknown): boolean {
	if (!(error instanceof Error)) return true;
	const message = error.message.toLowerCase();
	// Known non-delivery signals — the provider definitely did not accept the message.
	if (
		message.includes("permanent") ||
		message.includes("rejected") ||
		message.includes("invalid") ||
		message.includes("not found") ||
		message.includes("does not exist") ||
		message.includes("address rejected") ||
		message.includes("mailbox unavailable") ||
		message.includes("user unknown") ||
		message.includes("spam blocked") ||
		message.includes("policy rejection")
	) {
		return false;
	}
	// Everything else — timeout, temporary failure, unknown error code — is ambiguous.
	return true;
}
