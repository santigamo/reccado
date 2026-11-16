import { createFileRoute, useLocation } from "@tanstack/react-router";
import type { ReactElement, ReactNode } from "react";
import { useState } from "react";
import { ChevronDownIcon } from "#/components/auth/icons";
import {
	ApprovalStrip,
	AuthPage,
	Brand,
	Card,
	CardHeader,
	Checkbox,
	CodeInput,
	Field,
	InlineError,
	PrimaryButton,
	SecondaryButton,
	SelfHostedNote,
	TextButton,
	TextInput,
} from "#/components/auth/primitives";

export const Route = createFileRoute("/login")({ component: LoginPage });

type Step = "credentials" | "totp" | "otp-code";

async function postJson(url: string, body: Record<string, unknown>): Promise<Response> {
	return fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

const NETWORK_ERROR = "The request never reached the server. Check your connection and retry.";

/** Same-origin path only. A protocol-relative or backslash next is ignored. */
function destination(): string {
	const next = new URLSearchParams(window.location.search).get("next");
	if (next?.startsWith("/") && !next.startsWith("//") && !next.includes("\\")) return next;
	return "/inbox";
}

/**
 * The login page: the front door of the web perimeter since Better Auth replaced
 * Cloudflare Access (docs/plans/sending-streams-and-auth.md, Phase 2).
 *
 * The daily path is password then TOTP, both of which a password manager fills,
 * because the thing that made the old perimeter tiresome was not its security
 * but waiting for mail on every sign-in. Trusting the device on verification
 * means the second factor is asked for on a new browser rather than every time.
 *
 * Two ladders sit underneath, deliberately out of the way:
 *  - Email OTP — how a deployment reaches its first session, and how one comes
 *    back when the authenticator is gone. A code only ever goes to an address
 *    the owner registry vouches for (registration is closed at the issuer), so
 *    it doubles as the "you are not the operator" check while telling a stranger
 *    nothing either way.
 *  - Pairing-code rescue — the same emergency ladder Telegram uses, for a code
 *    minted by `wrangler d1 execute` when mail is not configured yet or the
 *    registry says nobody owns this deployment. The code is the credential.
 */
function LoginPage(): ReactElement {
	const [step, setStep] = useState<Step>("credentials");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [totp, setTotp] = useState("");
	const [trustDevice, setTrustDevice] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const [otp, setOtp] = useState("");
	const [otpError, setOtpError] = useState<string | null>(null);
	const [otpBusy, setOtpBusy] = useState(false);
	const [otpResent, setOtpResent] = useState(false);

	const [pairingCode, setPairingCode] = useState("");
	const [pairingError, setPairingError] = useState<string | null>(null);
	const [pairingBusy, setPairingBusy] = useState(false);

	// Display only: the strip says where the sign-in leads. The redirect itself
	// still goes through destination(), which validates `next` at click time.
	const search = useLocation({ select: (location) => location.search }) as Record<string, unknown>;
	const forApproval = typeof search.next === "string" && search.next.startsWith("/approve/");

	// Full navigation so the new session cookie is part of the next load.
	//
	// To /mailboxes rather than /: the landing page makes no authenticated API
	// call, and the deployment learns its own canonical origin from one. Signing
	// in and stopping at / therefore left the origin pointing at whatever
	// hostname was used last -- which is what MCP tokens get bound to.
	const enter = () => window.location.assign(destination());

	function back(): void {
		setStep("credentials");
		setError(null);
		setOtpError(null);
		setOtpResent(false);
	}

	async function signInWithPassword(event: React.FormEvent): Promise<void> {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const response = await postJson("/api/auth/sign-in/email", { email, password });
			const body = (await response.json().catch(() => null)) as {
				twoFactorRedirect?: boolean;
			} | null;
			if (!response.ok) {
				setError("That email and password were not accepted.");
				return;
			}
			// A second factor is owed: no session exists yet, only a challenge.
			if (body?.twoFactorRedirect) {
				setStep("totp");
				return;
			}
			enter();
		} catch {
			setError(NETWORK_ERROR);
		} finally {
			setBusy(false);
		}
	}

	async function verifyTotp(event: React.FormEvent): Promise<void> {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const response = await postJson("/api/auth/two-factor/verify-totp", {
				code: totp,
				trustDevice,
			});
			if (!response.ok) {
				setError("That code was not accepted. Check the clock on your authenticator and retry.");
				return;
			}
			enter();
		} catch {
			setError(NETWORK_ERROR);
		} finally {
			setBusy(false);
		}
	}

	async function requestOtp(): Promise<void> {
		setOtpBusy(true);
		setOtpError(null);
		setOtpResent(false);
		try {
			const response = await postJson("/api/auth/email-otp/send-verification-otp", {
				email,
				type: "sign-in",
			});
			if (!response.ok) {
				setOtpError(`Could not send a code (HTTP ${response.status}).`);
				return;
			}
			if (step === "otp-code") setOtpResent(true);
			setStep("otp-code");
		} catch {
			setOtpError(NETWORK_ERROR);
		} finally {
			setOtpBusy(false);
		}
	}

	async function signInWithOtp(event: React.FormEvent): Promise<void> {
		event.preventDefault();
		setOtpBusy(true);
		setOtpError(null);
		setOtpResent(false);
		try {
			const response = await postJson("/api/auth/sign-in/email-otp", { email, otp });
			if (!response.ok) {
				setOtpError("That code was not accepted. Request a new one and try again.");
				return;
			}
			enter();
		} catch {
			setOtpError(NETWORK_ERROR);
		} finally {
			setOtpBusy(false);
		}
	}

	const pairingClaims: Record<string, string> = {
		expired: "That code has expired. Mint a fresh one and try again.",
		used: "That code was already used. Mint a fresh one and try again.",
		unknown: "That code was not recognized. Check it against the one you minted.",
	};

	async function pairWithCode(event: React.FormEvent): Promise<void> {
		event.preventDefault();
		setPairingBusy(true);
		setPairingError(null);
		try {
			const response = await postJson("/api/auth/pairing", { email, code: pairingCode });
			const body = (await response.json().catch(() => null)) as {
				ok?: boolean;
				claim?: string;
			} | null;
			if (response.ok && body?.ok) {
				enter();
				return;
			}
			setPairingError(
				pairingClaims[body?.claim ?? ""] ?? "Pairing failed. Check the email and code and retry.",
			);
		} catch {
			setPairingError(NETWORK_ERROR);
		} finally {
			setPairingBusy(false);
		}
	}

	const strip = forApproval ? (
		<ApprovalStrip>Sign in to review an approval request</ApprovalStrip>
	) : null;

	let body: ReactNode;
	if (step === "totp") {
		body = (
			<>
				<CardHeader
					title="Enter your authenticator code"
					subtitle="The 6-digit code your authenticator app shows for Reccado."
				/>
				<form onSubmit={verifyTotp} className="flex flex-col gap-4 px-7 pb-6 pt-[22px]">
					<Field
						label="Authenticator code"
						htmlFor="login-totp"
						error={error ? <InlineError id="login-totp-error">{error}</InlineError> : null}
					>
						<CodeInput
							id="login-totp"
							required
							autoFocus
							value={totp}
							onChange={(event) => setTotp(event.target.value)}
							aria-invalid={error ? true : undefined}
							aria-describedby={error ? "login-totp-error" : undefined}
						/>
					</Field>
					<Checkbox checked={trustDevice} onChange={setTrustDevice}>
						Trust this browser for 30 days
					</Checkbox>
					<div className="flex flex-col gap-1.5">
						<PrimaryButton type="submit" disabled={busy} aria-busy={busy}>
							{busy ? "Verifying…" : "Verify"}
						</PrimaryButton>
						<TextButton onClick={back} className="self-center">
							Back
						</TextButton>
					</div>
				</form>
			</>
		);
	} else if (step === "otp-code") {
		body = (
			<>
				<CardHeader
					title="Check your email"
					subtitle={
						<>
							We sent a 6-digit code to{" "}
							<span className="font-medium text-text">{email || "your address"}</span>. It expires
							in 5 minutes.
						</>
					}
				/>
				<form onSubmit={signInWithOtp} className="flex flex-col gap-4 px-7 pb-6 pt-[22px]">
					<Field
						label="Emailed code"
						htmlFor="login-otp"
						error={
							otpError ? (
								<InlineError id="login-otp-error">{otpError}</InlineError>
							) : otpResent ? (
								<p role="status" className="text-[13px] leading-[18px] text-text-muted">
									A new code is on its way. Earlier codes no longer work.
								</p>
							) : null
						}
					>
						<CodeInput
							id="login-otp"
							required
							autoFocus
							value={otp}
							onChange={(event) => setOtp(event.target.value)}
							aria-invalid={otpError ? true : undefined}
							aria-describedby={otpError ? "login-otp-error" : undefined}
						/>
					</Field>
					<div className="flex flex-col gap-1.5">
						<PrimaryButton type="submit" disabled={otpBusy} aria-busy={otpBusy}>
							{otpBusy ? "Working…" : "Sign in"}
						</PrimaryButton>
						<div className="flex items-center justify-between">
							<TextButton onClick={back}>Back</TextButton>
							<TextButton
								underline
								disabled={otpBusy || !email}
								onClick={() => {
									setOtp("");
									void requestOtp();
								}}
							>
								Send a new code
							</TextButton>
						</div>
					</div>
				</form>
			</>
		);
	} else {
		body = (
			<>
				<CardHeader
					title="Sign in"
					subtitle={forApproval ? "You'll go straight to the request once you're in." : undefined}
				/>
				<form onSubmit={signInWithPassword} className="flex flex-col gap-4 px-7 pb-6 pt-[22px]">
					<Field label="Email" htmlFor="login-email">
						<TextInput
							id="login-email"
							type="email"
							autoComplete="username"
							required
							value={email}
							onChange={(event) => setEmail(event.target.value)}
							placeholder="you@example.com"
						/>
					</Field>
					<Field
						label="Password"
						htmlFor="login-password"
						error={error ? <InlineError id="login-password-error">{error}</InlineError> : null}
					>
						<TextInput
							id="login-password"
							type="password"
							autoComplete="current-password"
							required
							value={password}
							onChange={(event) => setPassword(event.target.value)}
							aria-invalid={error ? true : undefined}
							aria-describedby={error ? "login-password-error" : undefined}
						/>
					</Field>
					<PrimaryButton type="submit" disabled={busy} aria-busy={busy}>
						{busy ? "Signing in…" : "Sign in"}
					</PrimaryButton>
				</form>
			</>
		);
	}

	return (
		<AuthPage>
			<Brand />
			<Card className="max-w-[420px]" aria-label="Sign in to Reccado">
				{strip}
				{body}
				{step !== "otp-code" && (
					<details className="group border-t border-border-card bg-content">
						<summary className="flex cursor-pointer list-none items-center gap-2.5 px-7 py-4 text-[13px] leading-[18px] text-text-secondary outline-none group-open:pb-0 group-open:font-medium group-open:text-text focus-visible:bg-row-selected [&::-webkit-details-marker]:hidden">
							<span className="grow">
								{step === "totp"
									? "Lost your authenticator?"
									: "No password yet, or lost your authenticator?"}
							</span>
							<ChevronDownIcon className="transition-transform group-open:rotate-180" />
						</summary>
						<div className="flex flex-col gap-3 px-7 pb-[18px] pt-3">
							<p className="text-[13px] leading-[19px] text-text-muted">
								Sign in with a code emailed to the address above. It only ever goes to an address
								this deployment already recognises.
							</p>
							<SecondaryButton onClick={requestOtp} disabled={otpBusy || !email}>
								{otpBusy ? "Sending…" : "Email me a code"}
							</SecondaryButton>
							{!email && (
								<p className="text-[12px] leading-4 text-text-muted">
									Enter your email above first.
								</p>
							)}
							{otpError && <InlineError>{otpError}</InlineError>}
						</div>
						<form
							onSubmit={pairWithCode}
							className="flex flex-col gap-2.5 border-t border-border px-7 pb-[22px] pt-[18px]"
						>
							<Field
								label="Recovery code"
								htmlFor="login-pairing"
								hint={
									<>
										minted with <code className="font-mono">wrangler d1 execute</code>
									</>
								}
								error={
									pairingError ? (
										<InlineError id="login-pairing-error">{pairingError}</InlineError>
									) : null
								}
							>
								<TextInput
									id="login-pairing"
									required
									value={pairingCode}
									onChange={(event) => setPairingCode(event.target.value)}
									placeholder="Paste the code"
									autoComplete="off"
									spellCheck={false}
									className="font-mono text-[14px] font-normal"
									aria-invalid={pairingError ? true : undefined}
									aria-describedby={pairingError ? "login-pairing-error" : undefined}
								/>
							</Field>
							<SecondaryButton type="submit" disabled={pairingBusy} aria-busy={pairingBusy}>
								{pairingBusy ? "Pairing…" : "Pair and sign in"}
							</SecondaryButton>
						</form>
					</details>
				)}
			</Card>
			<SelfHostedNote />
		</AuthPage>
	);
}
