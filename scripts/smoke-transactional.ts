#!/usr/bin/env tsx
/**
 * `pnpm smoke:transactional` — end-to-end smoke test of the transactional API
 * against a DEPLOYED environment, through the same HTTP surface an operator
 * (session cookie, `/api/*`) and an integrator (Bearer key, `/v1/*`) use.
 *
 *   pnpm operator login --env dev --host <host>
 *   pnpm smoke:transactional --env dev --host <host> --mailbox <mbx_...> \
 *     --sender <addr on a verified sending domain> --to <recipient> [--send] [--wait-delivery 60]
 *
 * Without --send it only checks the session and that the mailbox answers, then
 * prints the plan. With --send it creates a throwaway template and live key,
 * sends ONE real message to --to, and always revokes/archives them at the end.
 * The plaintext key is held in memory only and never printed.
 *
 * Pure logic (args, bodies, assertions) is in ./lib/smoke-transactional-core.ts.
 */
import { randomBytes } from "node:crypto";
import {
	type FetchLike,
	getSessionInfo,
	OperatorAuthError,
	type OperatorSession,
	operatorFetch,
	requireSession,
	resolveHost,
	sessionPathFor,
} from "./lib/operator-session";
import {
	assessArchive,
	assessDelivery,
	assessKeyCreate,
	assessKeyListed,
	assessPolicyRejection,
	assessReplay,
	assessRevoke,
	assessRoutingDestination,
	assessSend,
	assessSenderName,
	assessStatus,
	buildIntegratorRequest,
	buildKeyBody,
	buildSendPayload,
	buildTemplateBody,
	describeResponse,
	extractKeyList,
	extractStatus,
	formatStep,
	type HttpResult,
	hasFailure,
	isTerminalDelivery,
	mailboxApiPath,
	makeRunIds,
	manualCheckLine,
	manualCleanupCommands,
	POLICY_REJECT_ADDRESS,
	parseRoutingDestinations,
	parseSmokeArgs,
	planLines,
	type RoutingDestination,
	type RoutingLookup,
	redactSecrets,
	type SendView,
	SMOKE_USAGE,
	SmokeInputError,
	type StatusView,
	type StepResult,
	step,
	summaryLine,
	toHttpResult,
} from "./lib/smoke-transactional-core";
import { wranglerCapture } from "./lib/wrangler-cli";

const POLL_INTERVAL_MS = 5_000;
const fetchImpl: FetchLike = (input, init) => fetch(input, init);

const results: StepResult[] = [];
/** Every secret that could appear in an error message: the plaintext key and the cookie. */
const secrets: string[] = [];

function report(result: StepResult): StepResult {
	results.push(result);
	console.log(redactSecrets(formatStep(result), secrets));
	return result;
}

async function operatorCall(
	session: OperatorSession,
	env: string | undefined,
	path: string,
	method: string,
	body?: unknown,
): Promise<HttpResult> {
	const response = await operatorFetch(
		session,
		path,
		{ method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
		{ fetchImpl, env },
	);
	return toHttpResult(response.status, await response.text());
}

async function integratorCall(request: { url: string; init: RequestInit }): Promise<HttpResult> {
	const response = await fetchImpl(request.url, request.init);
	return toHttpResult(response.status, await response.text());
}

function errorText(error: unknown): string {
	return redactSecrets(error instanceof Error ? error.message : String(error), secrets);
}

/** CLOUDFLARE_ACCOUNT_ID, else the single account `wrangler whoami --json` reports. */
function resolveAccountId(): { id: string } | { error: string } {
	const fromEnv = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
	if (fromEnv) return { id: fromEnv };
	const who = wranglerCapture(["whoami", "--json"]);
	if (!who.ok) return { error: "`wrangler whoami --json` failed; set CLOUDFLARE_ACCOUNT_ID" };
	try {
		const parsed = JSON.parse(who.out) as {
			account?: { id?: string };
			accounts?: Array<{ id?: string }>;
		};
		if (parsed.account?.id) return { id: parsed.account.id };
		const ids = (parsed.accounts ?? []).map((a) => a.id).filter((id): id is string => !!id);
		if (ids.length === 1 && ids[0]) return { id: ids[0] };
		return {
			error: `wrangler reports ${ids.length} accounts; set CLOUDFLARE_ACCOUNT_ID to choose one`,
		};
	} catch {
		return { error: "could not parse `wrangler whoami --json`; set CLOUDFLARE_ACCOUNT_ID" };
	}
}

/**
 * The account's Email Routing destination addresses, through the same REST
 * auth `setup:routing` uses for its Email Routing calls (CLOUDFLARE_API_TOKEN).
 * Read-only. Any failure is returned as a reason, never thrown: this only
 * guards the delivery wait.
 */
async function lookupRoutingDestinations(): Promise<RoutingLookup> {
	const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
	if (!token) {
		return {
			ok: false,
			reason: "CLOUDFLARE_API_TOKEN is not set (needs Account · Email Routing Addresses · Read)",
		};
	}
	secrets.push(token);
	const account = resolveAccountId();
	if ("error" in account) return { ok: false, reason: account.error };
	const destinations: RoutingDestination[] = [];
	try {
		for (let page = 1; page <= 20; page += 1) {
			const response = await fetchImpl(
				`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account.id)}/email/routing/addresses?per_page=50&page=${page}`,
				{ headers: { Authorization: `Bearer ${token}`, accept: "application/json" } },
			);
			const payload = (await response.json().catch(() => null)) as {
				success?: boolean;
				result?: unknown;
				result_info?: { total_pages?: number };
				errors?: Array<{ message?: string }>;
			} | null;
			if (!response.ok || payload?.success !== true) {
				const message = payload?.errors?.map((e) => e.message).join("; ") || "no error detail";
				return { ok: false, reason: `HTTP ${response.status}: ${message}` };
			}
			destinations.push(...parseRoutingDestinations(payload.result));
			if (page >= (payload.result_info?.total_pages ?? 1)) break;
		}
	} catch (error) {
		return { ok: false, reason: errorText(error) };
	}
	return { ok: true, destinations };
}

async function main(): Promise<number> {
	const opts = parseSmokeArgs(process.argv.slice(2));
	if (opts.help) {
		console.log(SMOKE_USAGE);
		return 0;
	}
	const host = resolveHost(opts.host, opts.env);
	const nowMs = Date.now();
	const ids = makeRunIds(nowMs, randomBytes(8).toString("hex"));

	for (const line of planLines(opts, host, ids)) console.log(line);
	console.log("");

	// --- Read-only preflight (both modes) ---
	const session = requireSession(host, opts.env);
	secrets.push(session.cookie);

	const info = await getSessionInfo(session, fetchImpl);
	if (!info) {
		report(
			step("operator session", "FAIL", [
				`stored session for ${host} is no longer valid; run: pnpm operator login${opts.env ? ` --env ${opts.env}` : ""} --host ${host}`,
			]),
		);
		console.log(summaryLine(results));
		return 1;
	}
	report(
		step("operator session", "PASS", [
			`signed in as ${info.email}${info.expiresAt ? ` (expires ${info.expiresAt})` : ""}`,
		]),
	);

	const keysPath = mailboxApiPath(opts.mailboxId, "/api-keys");
	const reach = await operatorCall(session, opts.env, keysPath, "GET");
	const existing = extractKeyList(reach.body);
	report(
		reach.status === 200 && existing
			? step("mailbox reachable (GET api-keys)", "PASS", [
					`HTTP 200, ${existing.length} key(s), ${existing.filter((k) => k.status === "active").length} active`,
				])
			: step("mailbox reachable (GET api-keys)", "FAIL", [describeResponse(reach, secrets)]),
	);

	// A recipient that is a verified Email Routing destination address never
	// produces a delivery event, so waiting for one could only time out.
	let skipDeliveryWait = false;
	if (opts.waitDeliverySeconds > 0) {
		const routing = assessRoutingDestination(opts.to, await lookupRoutingDestinations());
		skipDeliveryWait = routing.skipWait;
		report(routing.step);
	}

	if (!opts.send) {
		console.log("");
		console.log("Plan only: nothing was created or sent. Re-run with --send to execute steps 1-8.");
		console.log(summaryLine(results));
		return hasFailure(results) ? 1 : 0;
	}
	if (hasFailure(results)) {
		console.log("Preflight failed; not sending.");
		console.log(summaryLine(results));
		return 1;
	}
	console.log("");

	let templateCreated = false;
	let keyId: string | undefined;
	let send: SendView | undefined;
	try {
		// 1. Template
		const template = await operatorCall(
			session,
			opts.env,
			mailboxApiPath(opts.mailboxId, "/templates"),
			"POST",
			buildTemplateBody(ids),
		);
		templateCreated = template.status === 201;
		report(
			step(`create template ${ids.templateId}`, templateCreated ? "PASS" : "FAIL", [
				templateCreated ? "HTTP 201" : describeResponse(template, secrets),
			]),
		);
		if (!templateCreated) return 1;

		// 2. Live key
		const created = await operatorCall(
			session,
			opts.env,
			keysPath,
			"POST",
			buildKeyBody({ sender: opts.sender, to: opts.to, templateId: ids.templateId, nowMs }),
		);
		const assessed = assessKeyCreate(created);
		keyId = assessed.keyId;
		const plaintextKey = assessed.plaintextKey;
		if (plaintextKey) secrets.push(plaintextKey);
		report(assessed.step);
		if (!keyId || !plaintextKey || assessed.step.outcome === "FAIL") return 1;

		report(assessKeyListed(await operatorCall(session, opts.env, keysPath, "GET"), keyId));

		// 3. Sender name
		const patch = await operatorCall(
			session,
			opts.env,
			mailboxApiPath(opts.mailboxId, `/api-keys/${encodeURIComponent(keyId)}`),
			"PATCH",
			{ senderName: opts.senderName },
		);
		const afterPatch = await operatorCall(session, opts.env, keysPath, "GET");
		report(assessSenderName(patch, afterPatch, keyId, opts.senderName));

		// 4. Real send
		const payload = buildSendPayload(ids, opts.to);
		const sendRequest = buildIntegratorRequest({
			host,
			mailboxId: opts.mailboxId,
			apiKey: plaintextKey,
			method: "POST",
			idempotencyKey: ids.idempotencyKey,
			body: payload,
		});
		const sent = assessSend(await integratorCall(sendRequest), secrets);
		send = sent.send;
		report(sent.step);
		if (sent.step.outcome === "FAIL") return 1;

		// 5. Replay: identical request, identical Idempotency-Key.
		report(assessReplay(send, await integratorCall(sendRequest)));

		// 6. Off-policy recipient, new Idempotency-Key: refused before anything is reserved.
		report(
			assessPolicyRejection(
				await integratorCall(
					buildIntegratorRequest({
						host,
						mailboxId: opts.mailboxId,
						apiKey: plaintextKey,
						method: "POST",
						idempotencyKey: ids.rejectIdempotencyKey,
						body: buildSendPayload(ids, POLICY_REJECT_ADDRESS),
					}),
				),
			),
		);

		// 7. Status, and optionally wait for a delivery event.
		const statusRequest = buildIntegratorRequest({
			host,
			mailboxId: opts.mailboxId,
			apiKey: plaintextKey,
			method: "GET",
			requestId: send.requestId,
		});
		const firstStatus = await integratorCall(statusRequest);
		report(assessStatus(firstStatus, send));
		if (opts.waitDeliverySeconds > 0 && skipDeliveryWait) {
			report(
				step("delivery event", "SKIP", [
					`not waited: ${opts.to} is a verified Email Routing destination address, which produces no Email Sending event (see the WARN above)`,
				]),
			);
		} else if (opts.waitDeliverySeconds > 0 && firstStatus.status === 200) {
			let view: StatusView = extractStatus(firstStatus.body);
			const started = Date.now();
			const deadline = started + opts.waitDeliverySeconds * 1000;
			console.log(`       waiting up to ${opts.waitDeliverySeconds}s for a delivery event...`);
			while (!isTerminalDelivery(view) && Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, Math.min(POLL_INTERVAL_MS, deadline - Date.now())));
				const polled = await integratorCall(statusRequest);
				if (polled.status === 200) view = extractStatus(polled.body);
			}
			report(assessDelivery(view, Math.round((Date.now() - started) / 1000)));
		} else if (opts.waitDeliverySeconds === 0) {
			report(
				step("delivery event", "SKIP", ["not waited (pass --wait-delivery <seconds> to poll)"]),
			);
		}
		return hasFailure(results) ? 1 : 0;
	} catch (error) {
		report(step("unexpected error", "FAIL", [errorText(error)]));
		return 1;
	} finally {
		// 8. Always clean up whatever was created.
		const cleanup: StepResult[] = [];
		if (keyId) {
			try {
				cleanup.push(
					report(
						assessRevoke(
							await operatorCall(
								session,
								opts.env,
								mailboxApiPath(opts.mailboxId, `/api-keys/${encodeURIComponent(keyId)}/revoke`),
								"POST",
							),
						),
					),
				);
			} catch (error) {
				cleanup.push(report(step("cleanup: revoke key", "FAIL", [errorText(error)])));
			}
		}
		if (templateCreated) {
			try {
				cleanup.push(
					report(
						assessArchive(
							await operatorCall(
								session,
								opts.env,
								mailboxApiPath(
									opts.mailboxId,
									`/templates/${encodeURIComponent(ids.templateId)}/archive`,
								),
								"POST",
							),
							ids.templateId,
						),
					),
				);
			} catch (error) {
				cleanup.push(report(step("cleanup: archive template", "FAIL", [errorText(error)])));
			}
		}
		if (hasFailure(cleanup)) {
			const revokeFailed = cleanup.some((r) => r.name.includes("revoke") && r.outcome === "FAIL");
			const archiveFailed = cleanup.some((r) => r.name.includes("archive") && r.outcome === "FAIL");
			console.log("");
			console.log(
				`CLEANUP INCOMPLETE — key ${revokeFailed ? keyId : "(revoked)"}, template ${archiveFailed ? ids.templateId : "(archived)"}. ` +
					"The key expires on its own within 1h and can only mail the --to address. Finish by hand:",
			);
			for (const line of manualCleanupCommands({
				host,
				env: opts.env,
				mailboxId: opts.mailboxId,
				keyId: revokeFailed ? keyId : undefined,
				templateId: archiveFailed ? ids.templateId : undefined,
				sessionPath: sessionPathFor(host),
			})) {
				console.log(`  ${line}`);
			}
		}
		console.log("");
		if (send?.providerMessageId) {
			console.log(`providerMessageId: ${send.providerMessageId}`);
			console.log(manualCheckLine(opts, ids, send.providerMessageId));
		}
		console.log(summaryLine(results));
	}
}

main().then(
	(code) => {
		process.exitCode = hasFailure(results) ? 1 : code;
	},
	(error: unknown) => {
		const known = error instanceof SmokeInputError || error instanceof OperatorAuthError;
		console.error(`smoke:transactional: ${errorText(error)}`);
		if (error instanceof SmokeInputError) console.error(SMOKE_USAGE);
		if (!known && error instanceof Error && error.name !== "OperatorInputError") {
			console.error(redactSecrets(error.stack ?? "", secrets));
		}
		process.exitCode = 1;
	},
);
