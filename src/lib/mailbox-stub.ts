/**
 * The single place that decides which Durable Object a mailbox id resolves to.
 *
 * Mailboxes are pinned to Cloudflare's `eu` jurisdiction so that message content
 * at rest stays in the EU. The reason this is a function rather than a convention
 * is the failure mode: jurisdiction changes Durable Object id derivation, so code
 * that calls `MAILBOX_DO.getByName()` directly gets a *different, empty* Durable
 * Object. It does not throw and it does not warn — it presents as a mailbox that
 * lost its mail. `tests/unit/mailbox-stub.test.ts` fails if a raw `getByName`
 * reappears anywhere in `src/`.
 *
 * Uniformity is what makes that survivable. Because every mailbox is EU, a call
 * site that bypasses this helper breaks the first time anyone opens any inbox,
 * loudly and immediately. Under a per-mailbox rule the same mistake would work
 * for most mailboxes and fail silently for one, which is the version nobody finds
 * for months.
 *
 * ## Why the jurisdiction is declared rather than assumed
 *
 * `jurisdiction()` is not implemented in workerd, so it throws in local dev and in
 * `vitest`. The residency guarantee therefore cannot be exercised anywhere except
 * a deployed Worker — which is precisely the kind of unobservable property this
 * codebase has been eliminating, so it is at least made *visible*:
 * `MAILBOX_JURISDICTION` is set to `eu` in `wrangler.jsonc` for every deployed
 * environment and overridden to `none` in `.dev.vars` for local work.
 *
 * The two accepted values are exhaustive and anything else throws, including the
 * variable being unset. That is deliberate: a missing declaration in a deployed
 * environment fails loudly on the first request rather than quietly serving from
 * an unpinned Durable Object, which is the one outcome worth engineering against.
 */

/** Structurally typed so tests and callers need not construct a full `Env`. */
export type MailboxDoEnv = {
	MAILBOX_DO: DurableObjectNamespace;
	MAILBOX_JURISDICTION?: string;
};

export function mailboxStub(env: MailboxDoEnv, mailboxId: string): DurableObjectStub {
	const declared = env.MAILBOX_JURISDICTION;
	if (declared === "none") {
		// Local dev and tests: workerd has no jurisdictions, and there is no real
		// mail here to keep in any particular country.
		return env.MAILBOX_DO.getByName(mailboxId);
	}
	if (declared !== "eu") {
		throw new Error(
			`MAILBOX_JURISDICTION must be "eu" (deployed) or "none" (local); got ${
				declared === undefined ? "unset" : JSON.stringify(declared)
			}. Refusing to resolve a mailbox from an undeclared jurisdiction.`,
		);
	}
	return env.MAILBOX_DO.jurisdiction("eu").getByName(mailboxId);
}
