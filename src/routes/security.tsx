import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useState } from "react";

export const Route = createFileRoute("/security")({ component: SecurityPage });

const FIELD_CLASS =
	"mt-1 w-full rounded-xl border border-[rgba(50,143,151,0.3)] bg-transparent px-3 py-2 text-sm text-[var(--sea-ink)] outline-none focus:border-[rgba(79,184,178,0.6)]";
const PRIMARY_BUTTON_CLASS =
	"w-full rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-5 py-2.5 text-sm font-semibold text-[var(--lagoon-deep)] transition hover:bg-[rgba(79,184,178,0.24)] disabled:opacity-50";

async function postJson(url: string, body: Record<string, unknown>): Promise<Response> {
	return fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

/**
 * Where the two factors are set up, from inside a session that already exists.
 *
 * The order is forced by the issuer and worth stating: a password can only be
 * set on an account that has none (better-auth refuses to overwrite one here,
 * and the way back from a forgotten password is the reset mail), and TOTP
 * enrolment needs that password to authorise it. So the sequence for a fresh
 * deployment is: sign in with an emailed code or a pairing code, set a password,
 * then enrol the authenticator.
 *
 * The setup URI is shown as text rather than a QR on purpose — a password
 * manager takes the URI directly, and rendering a QR would mean a dependency
 * whose only job is to encode a string this page already has.
 */
function SecurityPage(): ReactElement {
	const [password, setPassword] = useState("");
	const [passwordState, setPasswordState] = useState<"idle" | "done">("idle");
	const [passwordError, setPasswordError] = useState<string | null>(null);

	const [enrolPassword, setEnrolPassword] = useState("");
	const [totpUri, setTotpUri] = useState<string | null>(null);
	const [backupCodes, setBackupCodes] = useState<string[]>([]);
	const [confirmCode, setConfirmCode] = useState("");
	const [enrolError, setEnrolError] = useState<string | null>(null);
	const [enrolled, setEnrolled] = useState(false);
	const [busy, setBusy] = useState(false);

	async function submitPassword(event: React.FormEvent): Promise<void> {
		event.preventDefault();
		setBusy(true);
		setPasswordError(null);
		try {
			const response = await postJson("/api/account/password", { newPassword: password });
			const body = (await response.json().catch(() => null)) as {
				reason?: string;
				minLength?: number;
			} | null;
			if (response.ok) {
				setPasswordState("done");
				setEnrolPassword(password);
				setPassword("");
				return;
			}
			if (body?.reason === "too_short") {
				setPasswordError(`Use at least ${body.minLength ?? 16} characters — generate one.`);
				return;
			}
			if (body?.reason === "already_set") {
				setPasswordError(
					"This account already has a password. To replace it, use the reset link from the sign-in page.",
				);
				return;
			}
			setPasswordError(`Could not set the password (HTTP ${response.status}).`);
		} catch {
			setPasswordError("The request never reached the server.");
		} finally {
			setBusy(false);
		}
	}

	async function startEnrolment(event: React.FormEvent): Promise<void> {
		event.preventDefault();
		setBusy(true);
		setEnrolError(null);
		try {
			const response = await postJson("/api/auth/two-factor/enable", { password: enrolPassword });
			if (!response.ok) {
				setEnrolError("That password was not accepted.");
				return;
			}
			const body = (await response.json()) as { totpURI?: string; backupCodes?: string[] };
			setTotpUri(body.totpURI ?? null);
			setBackupCodes(body.backupCodes ?? []);
		} catch {
			setEnrolError("The request never reached the server.");
		} finally {
			setBusy(false);
		}
	}

	async function confirmEnrolment(event: React.FormEvent): Promise<void> {
		event.preventDefault();
		setBusy(true);
		setEnrolError(null);
		try {
			const response = await postJson("/api/auth/two-factor/verify-totp", {
				code: confirmCode,
				trustDevice: true,
			});
			if (!response.ok) {
				setEnrolError("That code was not accepted. Check your authenticator and retry.");
				return;
			}
			setEnrolled(true);
		} catch {
			setEnrolError("The request never reached the server.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<main className="page-wrap px-4 pb-8 pt-14">
			<section className="island-shell rise-in mx-auto max-w-md rounded-[2rem] px-6 py-10">
				<p className="island-kicker mb-3">Reccado</p>
				<h1 className="mb-5 text-2xl font-bold tracking-tight text-[var(--sea-ink)]">
					Sign-in security
				</h1>

				<h2 className="mb-2 text-sm font-semibold text-[var(--sea-ink)]">1. Password</h2>
				{passwordState === "done" ? (
					<p className="text-sm text-[var(--sea-ink-soft)]">Password set.</p>
				) : (
					<form onSubmit={submitPassword} className="space-y-3">
						<label className="block text-sm text-[var(--sea-ink-soft)]">
							New password (generate it, do not invent it)
							<input
								type="password"
								autoComplete="new-password"
								required
								value={password}
								onChange={(event) => setPassword(event.target.value)}
								className={FIELD_CLASS}
							/>
						</label>
						<button type="submit" disabled={busy} className={PRIMARY_BUTTON_CLASS}>
							Set password
						</button>
						{passwordError && <p className="text-sm text-red-500">{passwordError}</p>}
					</form>
				)}

				<div className="my-6 border-t border-[rgba(50,143,151,0.2)]" />

				<h2 className="mb-2 text-sm font-semibold text-[var(--sea-ink)]">2. Authenticator</h2>
				{enrolled ? (
					<p className="text-sm text-[var(--sea-ink-soft)]">
						Two-factor authentication is on. This browser is trusted for 30 days; a new one will ask
						for a code.
					</p>
				) : totpUri ? (
					<div className="space-y-4">
						<div>
							<p className="text-sm text-[var(--sea-ink-soft)]">
								Add this setup URI to your authenticator or password manager:
							</p>
							<code className="mt-1 block break-all rounded-xl border border-[rgba(50,143,151,0.3)] px-3 py-2 font-mono text-xs text-[var(--sea-ink)]">
								{totpUri}
							</code>
						</div>
						{backupCodes.length > 0 && (
							<div>
								<p className="text-sm text-[var(--sea-ink-soft)]">
									Backup codes — shown once, store them now:
								</p>
								<code className="mt-1 block rounded-xl border border-[rgba(50,143,151,0.3)] px-3 py-2 font-mono text-xs text-[var(--sea-ink)]">
									{backupCodes.join("  ")}
								</code>
							</div>
						)}
						<form onSubmit={confirmEnrolment} className="space-y-3">
							<label className="block text-sm text-[var(--sea-ink-soft)]">
								Confirm with a code from the authenticator
								<input
									inputMode="numeric"
									pattern="[0-9]*"
									autoComplete="one-time-code"
									required
									value={confirmCode}
									onChange={(event) => setConfirmCode(event.target.value)}
									className={`${FIELD_CLASS} tracking-[0.3em]`}
									placeholder="000000"
								/>
							</label>
							<button type="submit" disabled={busy} className={PRIMARY_BUTTON_CLASS}>
								Turn on two-factor
							</button>
						</form>
					</div>
				) : (
					<form onSubmit={startEnrolment} className="space-y-3">
						<label className="block text-sm text-[var(--sea-ink-soft)]">
							Confirm your password to enrol
							<input
								type="password"
								autoComplete="current-password"
								required
								value={enrolPassword}
								onChange={(event) => setEnrolPassword(event.target.value)}
								className={FIELD_CLASS}
							/>
						</label>
						<button type="submit" disabled={busy} className={PRIMARY_BUTTON_CLASS}>
							Start enrolment
						</button>
					</form>
				)}
				{enrolError && <p className="mt-3 text-sm text-red-500">{enrolError}</p>}
			</section>
		</main>
	);
}
