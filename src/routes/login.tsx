import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useState } from "react";

export const Route = createFileRoute("/login")({ component: LoginPage });

type Step = "credentials" | "totp" | "otp-code";

const FIELD_CLASS =
	"mt-1 w-full rounded-xl border border-[rgba(50,143,151,0.3)] bg-transparent px-3 py-2 text-sm text-[var(--sea-ink)] outline-none focus:border-[rgba(79,184,178,0.6)]";
const PRIMARY_BUTTON_CLASS =
	"w-full rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-5 py-2.5 text-sm font-semibold text-[var(--lagoon-deep)] transition hover:bg-[rgba(79,184,178,0.24)] disabled:opacity-50";
const SECONDARY_BUTTON_CLASS =
	"w-full rounded-full border border-[rgba(50,143,151,0.3)] px-5 py-2.5 text-sm font-semibold text-[var(--lagoon-deep)] transition hover:bg-[rgba(79,184,178,0.14)] disabled:opacity-50";

async function postJson(url: string, body: Record<string, unknown>): Promise<Response> {
	return fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

const NETWORK_ERROR = "The request never reached the server. Check your connection and retry.";

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

	const [pairingCode, setPairingCode] = useState("");
	const [pairingError, setPairingError] = useState<string | null>(null);
	const [pairingBusy, setPairingBusy] = useState(false);

	// Full navigation so the new session cookie is part of the next load.
	//
	// To /mailboxes rather than /: the landing page makes no authenticated API
	// call, and the deployment learns its own canonical origin from one. Signing
	// in and stopping at / therefore left the origin pointing at whatever
	// hostname was used last -- which is what MCP tokens get bound to.
	const enter = () => window.location.assign("/mailboxes");

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
		try {
			const response = await postJson("/api/auth/email-otp/send-verification-otp", {
				email,
				type: "sign-in",
			});
			if (!response.ok) {
				setOtpError(`Could not send a code (HTTP ${response.status}).`);
				return;
			}
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

	return (
		<main className="page-wrap px-4 pb-8 pt-14">
			<section className="island-shell rise-in mx-auto max-w-md rounded-[2rem] px-6 py-10">
				<p className="island-kicker mb-3">Reccado</p>
				<h1 className="mb-5 text-2xl font-bold tracking-tight text-[var(--sea-ink)]">Sign in</h1>

				{step === "totp" ? (
					<form onSubmit={verifyTotp} className="space-y-4">
						<label className="block text-sm text-[var(--sea-ink-soft)]">
							Authenticator code
							<input
								inputMode="numeric"
								pattern="[0-9]*"
								autoComplete="one-time-code"
								required
								value={totp}
								onChange={(event) => setTotp(event.target.value)}
								className={`${FIELD_CLASS} tracking-[0.3em]`}
								placeholder="000000"
							/>
						</label>
						<label className="flex items-center gap-2 text-sm text-[var(--sea-ink-soft)]">
							<input
								type="checkbox"
								checked={trustDevice}
								onChange={(event) => setTrustDevice(event.target.checked)}
							/>
							Trust this browser for 30 days
						</label>
						<button type="submit" disabled={busy} className={PRIMARY_BUTTON_CLASS}>
							Verify
						</button>
						<button
							type="button"
							onClick={() => setStep("credentials")}
							className="text-xs text-[var(--sea-ink-soft)] underline"
						>
							Back
						</button>
					</form>
				) : step === "otp-code" ? (
					<form onSubmit={signInWithOtp} className="space-y-4">
						<label className="block text-sm text-[var(--sea-ink-soft)]">
							Emailed code (expires in 5 minutes)
							<input
								inputMode="numeric"
								pattern="[0-9]*"
								autoComplete="one-time-code"
								required
								value={otp}
								onChange={(event) => setOtp(event.target.value)}
								className={`${FIELD_CLASS} tracking-[0.3em]`}
								placeholder="000000"
							/>
						</label>
						<button type="submit" disabled={otpBusy} className={PRIMARY_BUTTON_CLASS}>
							Sign in
						</button>
						<button
							type="button"
							onClick={() => setStep("credentials")}
							className="text-xs text-[var(--sea-ink-soft)] underline"
						>
							Back
						</button>
						{otpError && <p className="text-sm text-red-500">{otpError}</p>}
					</form>
				) : (
					<form onSubmit={signInWithPassword} className="space-y-4">
						<label className="block text-sm text-[var(--sea-ink-soft)]">
							Email
							<input
								type="email"
								autoComplete="username"
								required
								value={email}
								onChange={(event) => setEmail(event.target.value)}
								className={FIELD_CLASS}
								placeholder="you@example.com"
							/>
						</label>
						<label className="block text-sm text-[var(--sea-ink-soft)]">
							Password
							<input
								type="password"
								autoComplete="current-password"
								required
								value={password}
								onChange={(event) => setPassword(event.target.value)}
								className={FIELD_CLASS}
							/>
						</label>
						<button type="submit" disabled={busy} className={PRIMARY_BUTTON_CLASS}>
							Sign in
						</button>
					</form>
				)}
				{error && <p className="mt-3 text-sm text-red-500">{error}</p>}

				<div className="my-6 border-t border-[rgba(50,143,151,0.2)]" />

				<details>
					<summary className="cursor-pointer text-sm text-[var(--sea-ink-soft)]">
						No password yet, or lost your authenticator?
					</summary>
					<div className="mt-4 space-y-6">
						<div className="space-y-3">
							<p className="text-sm text-[var(--sea-ink-soft)]">
								Sign in with a code emailed to the address above. It only ever goes to an address
								this deployment already recognises.
							</p>
							<button
								type="button"
								onClick={requestOtp}
								disabled={otpBusy || !email}
								className={SECONDARY_BUTTON_CLASS}
							>
								Email me a code
							</button>
							{otpError && step !== "otp-code" && (
								<p className="text-sm text-red-500">{otpError}</p>
							)}
						</div>

						<form onSubmit={pairWithCode} className="space-y-3">
							<label className="block text-sm text-[var(--sea-ink-soft)]">
								Recovery code (minted with <code>wrangler d1 execute</code>)
								<input
									required
									value={pairingCode}
									onChange={(event) => setPairingCode(event.target.value)}
									className={`${FIELD_CLASS} font-mono`}
									placeholder="paste the code"
								/>
							</label>
							<button type="submit" disabled={pairingBusy} className={SECONDARY_BUTTON_CLASS}>
								Pair and sign in
							</button>
							{pairingError && <p className="text-sm text-red-500">{pairingError}</p>}
						</form>
					</div>
				</details>
			</section>
		</main>
	);
}
