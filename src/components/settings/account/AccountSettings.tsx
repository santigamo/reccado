import { Loader2 } from "lucide-react";
import { type FormEvent, type ReactElement, type ReactNode, useState } from "react";
import { renderSVG } from "uqr";
import { SettingsCard } from "#/components/settings/parts/SettingsParts";
import { SettingsShell } from "#/components/settings/SettingsShell";
import { signOut } from "#/components/shell/AppShell";
import { Avatar } from "#/components/ui/Avatar";
import { Button } from "#/components/ui/Button";
import { controlClassName, TextField } from "#/components/ui/Field";
import { StatusDot, type StatusTone } from "#/components/ui/StatusDot";
import { cn } from "#/lib/cn";
import { useAsyncResource } from "#/lib/use-mail";
import { ownerInitials, useMe } from "#/lib/use-me";

async function postJson(url: string, body: Record<string, unknown>): Promise<Response> {
	return fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

/**
 * The enrolment URI as a scannable QR, inlined as a data URI so it stays an
 * image with alt text. Fixed colours: a QR is read by a camera, and inverting
 * it on a dark background is a known way to make scanners fail.
 */
function qrDataUri(value: string): string {
	const svg = renderSVG(value, {
		border: 2,
		pixelSize: 8,
		whiteColor: "#ffffff",
		blackColor: "#1e1e1e",
	});
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

type FactorState = {
	/** null = unknown (the session endpoints did not answer, e.g. local dev). */
	hasPassword: boolean | null;
	twoFactorEnabled: boolean | null;
};

/**
 * What the account already has, from Better Auth's own endpoints: a
 * `credential` account means a password exists; the session user carries
 * `twoFactorEnabled`. Either can fail (no BETTER_AUTH_SECRET locally) — then
 * the page falls back to offering the actions, as /security always did.
 */
async function fetchFactors(): Promise<FactorState> {
	const [accounts, session] = await Promise.all([
		fetch("/api/auth/list-accounts")
			.then((r) => (r.ok ? (r.json() as Promise<Array<{ providerId?: string }>>) : null))
			.catch(() => null),
		fetch("/api/auth/get-session")
			.then((r) =>
				r.ok ? (r.json() as Promise<{ user?: { twoFactorEnabled?: boolean } } | null>) : null,
			)
			.catch(() => null),
	]);
	return {
		hasPassword: Array.isArray(accounts)
			? accounts.some((a) => a.providerId === "credential")
			: null,
		twoFactorEnabled:
			session?.user && typeof session.user.twoFactorEnabled === "boolean"
				? session.user.twoFactorEnabled
				: null,
	};
}

function StepHeader({
	step,
	title,
	status,
	children,
	muted,
}: {
	step: number;
	title: string;
	status: { tone: StatusTone | "ink"; label: string } | null;
	children: ReactNode;
	muted?: boolean;
}): ReactElement {
	return (
		<div className="flex gap-2.5 px-5 pt-4.5 pb-4">
			<span className="w-2 shrink-0 text-label leading-5 text-text-muted tabular-nums">{step}</span>
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<div className="flex items-center gap-3">
					<h2
						className={cn(
							"m-0 flex-1 text-sender font-medium tracking-[-0.01em]",
							muted ? "text-text-secondary" : "text-text",
						)}
					>
						{title}
					</h2>
					{status ? (
						<span
							className={cn(
								"flex shrink-0 items-center gap-1.75 text-label font-medium",
								status.tone === "muted" ? "text-text-muted font-normal" : "text-text",
							)}
						>
							{status.tone === "ink" ? (
								<StatusDot color="var(--color-ink)" size={6} />
							) : (
								<StatusDot tone={status.tone} size={6} />
							)}
							{status.label}
						</span>
					) : null}
				</div>
				<p className="m-0 text-label text-text-muted">{children}</p>
			</div>
		</div>
	);
}

/** A value that copies itself: a setup URI or backup codes headed for a password manager. */
function CopyBlock({
	label,
	note,
	value,
}: {
	label: string;
	note?: string;
	value: string;
}): ReactElement {
	const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
	async function copy() {
		try {
			await navigator.clipboard.writeText(value);
			setState("copied");
			window.setTimeout(() => setState("idle"), 1500);
		} catch {
			setState("failed");
		}
	}
	return (
		<div className="flex min-w-0 flex-col gap-2">
			<div className="flex items-baseline justify-between gap-3">
				<span className="text-label font-medium text-text">{label}</span>
				{note ? <span className="shrink-0 text-meta text-text-muted">{note}</span> : null}
			</div>
			<div className="flex items-start gap-3 rounded-[10px] bg-content px-3 py-2.5">
				<code className="min-w-0 flex-1 select-all break-all font-mono text-meta leading-5 text-text-secondary">
					{value}
				</code>
				<button
					type="button"
					onClick={() => void copy()}
					className="shrink-0 text-label font-medium text-text underline decoration-1 underline-offset-2 hover:text-ink"
				>
					{state === "copied" ? "Copied" : "Copy"}
				</button>
			</div>
			{state === "failed" ? (
				<span role="alert" className="text-meta text-danger">
					Copy failed. Select the text and copy it by hand.
				</span>
			) : null}
		</div>
	);
}

/**
 * Settings → Account (Paper "Settings — Account" and "Account · No password
 * yet"). Everything the old /security page did for the owner account:
 *
 * The order is forced by the issuer: a password can only be set on an account
 * that has none (better-auth refuses to overwrite one here; the way back from
 * a forgotten password is the reset mail), and TOTP enrolment needs that
 * password. So: sign in with an emailed code or a pairing code, set a
 * password, then enrol the authenticator.
 */
export function AccountSettings(): ReactElement {
	const { data: me } = useMe();
	const factors = useAsyncResource<FactorState>(
		fetchFactors,
		{ hasPassword: null, twoFactorEnabled: null },
		[],
	);

	const [password, setPassword] = useState("");
	const [passwordDone, setPasswordDone] = useState(false);
	const [passwordError, setPasswordError] = useState<string | null>(null);

	const [enrolPassword, setEnrolPassword] = useState("");
	const [totpUri, setTotpUri] = useState<string | null>(null);
	const [backupCodes, setBackupCodes] = useState<string[]>([]);
	const [confirmCode, setConfirmCode] = useState("");
	const [enrolError, setEnrolError] = useState<string | null>(null);
	const [enrolled, setEnrolled] = useState(false);
	const [busy, setBusy] = useState<"password" | "enrol" | "confirm" | "signout" | null>(null);

	const hasPassword = passwordDone || factors.data.hasPassword === true;
	const passwordUnknown = !passwordDone && factors.data.hasPassword === null;
	const twoFactorOn = enrolled || factors.data.twoFactorEnabled === true;

	async function submitPassword(event: FormEvent): Promise<void> {
		event.preventDefault();
		setBusy("password");
		setPasswordError(null);
		try {
			const response = await postJson("/api/account/password", { newPassword: password });
			const body = (await response.json().catch(() => null)) as {
				reason?: string;
				minLength?: number;
			} | null;
			if (response.ok) {
				setPasswordDone(true);
				// Carried into enrolment so the next step needs no retyping.
				setEnrolPassword(password);
				setPassword("");
				return;
			}
			if (body?.reason === "too_short") {
				setPasswordError(
					`Use at least ${body.minLength ?? 16} characters. Let your password manager generate it.`,
				);
				return;
			}
			if (body?.reason === "already_set") {
				setPasswordError(
					"This account already has a password. To replace it, sign out and use the reset link on the sign-in page.",
				);
				return;
			}
			setPasswordError(`Could not set the password (HTTP ${response.status}).`);
		} catch {
			setPasswordError("The request never reached the server.");
		} finally {
			setBusy(null);
		}
	}

	async function startEnrolment(event: FormEvent): Promise<void> {
		event.preventDefault();
		setBusy("enrol");
		setEnrolError(null);
		try {
			const response = await postJson("/api/auth/two-factor/enable", { password: enrolPassword });
			if (!response.ok) {
				setEnrolError(
					response.status >= 500
						? `Two-factor is not available right now (HTTP ${response.status}).`
						: "That password was not accepted.",
				);
				return;
			}
			const body = (await response.json()) as { totpURI?: string; backupCodes?: string[] };
			setTotpUri(body.totpURI ?? null);
			setBackupCodes(body.backupCodes ?? []);
		} catch {
			setEnrolError("The request never reached the server.");
		} finally {
			setBusy(null);
		}
	}

	async function confirmEnrolment(event: FormEvent): Promise<void> {
		event.preventDefault();
		setBusy("confirm");
		setEnrolError(null);
		try {
			const response = await postJson("/api/auth/two-factor/verify-totp", {
				code: confirmCode,
				trustDevice: true,
			});
			if (!response.ok) {
				setEnrolError("That code was not accepted. Check your authenticator and try again.");
				return;
			}
			setEnrolled(true);
		} catch {
			setEnrolError("The request never reached the server.");
		} finally {
			setBusy(null);
		}
	}

	const email = me?.email ?? null;

	const passwordStatus = hasPassword
		? { tone: "success" as const, label: "Set" }
		: passwordUnknown
			? null
			: { tone: "ink" as const, label: "Not set" };

	const twoFactorStatus = twoFactorOn
		? { tone: "success" as const, label: "On" }
		: totpUri
			? { tone: "ink" as const, label: "Finish setting up" }
			: hasPassword || passwordUnknown
				? factors.data.twoFactorEnabled === false || passwordDone
					? { tone: "ink" as const, label: "Off" }
					: null
				: { tone: "muted" as const, label: "Set a password first" };

	const passwordBlocked = !hasPassword && !passwordUnknown;

	return (
		<SettingsShell active="account">
			<div className="app-scroll h-full min-h-0 min-w-0 flex-1 overflow-y-auto">
				<div className="flex flex-col gap-4 pb-4 lg:flex-row lg:items-start">
					<div className="flex shrink-0 flex-col gap-3.5 lg:w-130">
						{/* Who */}
						<SettingsCard aria-label="Owner">
							<div className="flex items-start gap-3.5 px-5 pt-4.5 pb-4">
								<Avatar from={email} label={ownerInitials(email) || " "} tone="neutral" size="lg" />
								<div className="flex min-w-0 flex-1 flex-col gap-0.5">
									<h1 className="m-0 truncate text-title font-semibold tracking-[-0.015em] text-ink">
										{email ?? "…"}
									</h1>
									<p className="m-0 text-label text-text-muted">
										Owner. The only person who can send, approve and change settings.
									</p>
								</div>
								<Button
									variant="secondary"
									size="sm"
									className="h-8"
									disabled={busy === "signout"}
									onClick={() => {
										setBusy("signout");
										void signOut();
									}}
								>
									Sign out
								</Button>
							</div>
							<dl className="m-0 flex flex-col">
								<div className="flex gap-4 border-t border-border-card px-5 py-3">
									<dt className="w-28 shrink-0 text-label text-text-muted">Email code</dt>
									<dd className="m-0 text-label text-text">
										Always available. A one-time code is sent to this address.
									</dd>
								</div>
								<div className="flex gap-4 border-t border-border-card px-5 py-3">
									<dt className="w-28 shrink-0 text-label text-text-muted">Locked out</dt>
									<dd className="m-0 text-label text-text">
										Create a pairing code from your terminal. Nothing in the browser can do it for
										you.
									</dd>
								</div>
							</dl>
						</SettingsCard>

						{/* 1. Password */}
						<SettingsCard aria-label="Password">
							<StepHeader step={1} title="Password" status={passwordStatus}>
								{hasPassword
									? passwordDone
										? "Password set. Next, turn on the authenticator app."
										: "A password can be set once from here. To replace it, sign out and use the reset link on the sign-in page."
									: "You signed in with an emailed code. Add a password so signing in does not depend on your inbox alone."}
							</StepHeader>
							{hasPassword ? null : (
								<form
									onSubmit={(event) => void submitPassword(event)}
									className="flex flex-col gap-2 border-t border-border-card bg-content px-5 pt-4 pb-5"
								>
									<label
										htmlFor="account-new-password"
										className="text-label font-medium text-text"
									>
										New password
									</label>
									<div className="flex flex-col gap-2.5 sm:flex-row">
										<input
											id="account-new-password"
											type="password"
											autoComplete="new-password"
											required
											value={password}
											onChange={(event) => setPassword(event.target.value)}
											aria-invalid={passwordError ? true : undefined}
											aria-describedby="account-password-help"
											className={controlClassName("h-11 flex-1", Boolean(passwordError))}
										/>
										<Button
											type="submit"
											variant="primary"
											disabled={busy !== null}
											className="h-11 px-5"
										>
											{busy === "password" ? <Loader2 className="animate-spin" /> : null}
											Set password
										</Button>
									</div>
									<p
										id="account-password-help"
										role={passwordError ? "alert" : undefined}
										className={cn(
											"m-0 text-label",
											passwordError ? "text-danger" : "text-text-muted",
										)}
									>
										{passwordError ??
											"At least 16 characters. Let your password manager generate it."}
									</p>
								</form>
							)}
						</SettingsCard>
					</div>

					{/* 2. Authenticator app */}
					<SettingsCard aria-label="Authenticator app" className="min-w-0 flex-1">
						<StepHeader
							step={2}
							title="Authenticator app"
							status={twoFactorStatus}
							muted={passwordBlocked}
						>
							A six-digit code from your phone or password manager, asked for when you sign in on a
							new browser.
							{passwordBlocked ? " Turning it on needs your password, so that comes first." : null}
						</StepHeader>

						{twoFactorOn ? (
							<p className="m-0 border-t border-border-card px-5 py-4 text-label text-text">
								Two-factor authentication is on.{" "}
								{enrolled
									? "This browser is trusted for 30 days; a new one will ask for a code."
									: null}
							</p>
						) : passwordBlocked ? null : totpUri ? (
							<>
								<div className="flex flex-col gap-5 border-t border-border-card p-5 sm:flex-row">
									<img
										src={qrDataUri(totpUri)}
										alt="QR code containing the two-factor setup link"
										width={188}
										height={188}
										className="size-47 shrink-0 self-center rounded-[10px] border border-border-card bg-white p-2.5 sm:self-start"
									/>
									<div className="flex min-w-0 flex-1 flex-col gap-4">
										<CopyBlock
											label="Scan the code, or copy the setup link into your password manager"
											value={totpUri}
										/>
										{backupCodes.length > 0 ? (
											<CopyBlock
												label="Backup codes"
												note="Shown once. Store them now."
												value={backupCodes.join(" ")}
											/>
										) : null}
									</div>
								</div>
								<form
									onSubmit={(event) => void confirmEnrolment(event)}
									className="flex flex-col gap-2 border-t border-border-card bg-content px-5 pt-4 pb-5"
								>
									<label htmlFor="account-totp-code" className="text-label font-medium text-text">
										Confirm with a code from the app
									</label>
									<div className="flex flex-col gap-3 sm:flex-row sm:items-center">
										<input
											id="account-totp-code"
											inputMode="numeric"
											pattern="[0-9]*"
											autoComplete="one-time-code"
											required
											maxLength={6}
											value={confirmCode}
											onChange={(event) => setConfirmCode(event.target.value)}
											placeholder="000000"
											className={controlClassName("h-11 font-mono tracking-[0.3em] sm:w-44")}
										/>
										<span className="min-w-0 flex-1 text-label text-text-muted">
											This browser is then trusted for 30 days. A new one asks for a code.
										</span>
										<Button
											type="submit"
											variant="primary"
											disabled={busy !== null}
											className="h-11 px-5"
										>
											{busy === "confirm" ? <Loader2 className="animate-spin" /> : null}
											Turn on two-factor
										</Button>
									</div>
									{enrolError ? (
										<p role="alert" className="m-0 text-label text-danger">
											{enrolError}
										</p>
									) : null}
								</form>
							</>
						) : (
							<form
								onSubmit={(event) => void startEnrolment(event)}
								className="flex flex-col gap-3 border-t border-border-card bg-content px-5 pt-4 pb-5 sm:flex-row sm:items-end"
							>
								<TextField
									label="Confirm your password to start"
									type="password"
									autoComplete="current-password"
									required
									value={enrolPassword}
									onChange={(event) => setEnrolPassword(event.target.value)}
									error={enrolError ?? undefined}
									containerClassName="min-w-0 flex-1"
								/>
								<Button
									type="submit"
									variant="primary"
									disabled={busy !== null}
									className="h-11 px-5"
								>
									{busy === "enrol" ? <Loader2 className="animate-spin" /> : null}
									Start setup
								</Button>
							</form>
						)}
					</SettingsCard>
				</div>
			</div>
		</SettingsShell>
	);
}
