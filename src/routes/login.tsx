import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useState } from "react";

export const Route = createFileRoute("/login")({ component: LoginPage });

type Step = "email" | "code";

async function postJson(url: string, body: Record<string, unknown>): Promise<Response> {
	return fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

/**
 * The login page: the front door of the web perimeter since Better Auth replaced
 * Cloudflare Access (docs/plans/sending-streams-and-auth.md, Phase 2).
 *
 * Two forms, on purpose:
 *  - Email OTP — the normal path. An OTP is only ever sent to an address the
 *    owner registry vouches for (registration is closed at the issuer), so the
 *    email step doubles as the "you are not the operator" check while telling a
 *    stranger nothing either way.
 *  - Pairing-code rescue — the same emergency ladder Telegram uses, when the
 *    code is minted by `wrangler d1 execute` because mail sending is not yet
 *    configured or the registry says nobody owns this deployment. The code is
 *    the credential: the endpoint links the email as an owner and opens the
 *    session directly.
 */
function LoginPage(): ReactElement {
	const [step, setStep] = useState<Step>("email");
	const [email, setEmail] = useState("");
	const [otp, setOtp] = useState("");
	const [otpError, setOtpError] = useState<string | null>(null);
	const [otpBusy, setOtpBusy] = useState(false);

	const [pairingCode, setPairingCode] = useState("");
	const [pairingError, setPairingError] = useState<string | null>(null);
	const [pairingBusy, setPairingBusy] = useState(false);

	async function requestOtp(event: React.FormEvent): Promise<void> {
		event.preventDefault();
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
			setStep("code");
		} catch {
			setOtpError("The request never reached the server. Check your connection and retry.");
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
			// Full navigation so the new session cookie is part of the next load.
			window.location.assign("/");
		} catch {
			setOtpError("The request never reached the server. Check your connection and retry.");
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
				window.location.assign("/");
				return;
			}
			setPairingError(
				pairingClaims[body?.claim ?? ""] ?? "Pairing failed. Check the email and code and retry.",
			);
		} catch {
			setPairingError("The request never reached the server. Check your connection and retry.");
		} finally {
			setPairingBusy(false);
		}
	}

	return (
		<main className="page-wrap px-4 pb-8 pt-14">
			<section className="island-shell rise-in mx-auto max-w-md rounded-[2rem] px-6 py-10">
				<p className="island-kicker mb-3">Reccado</p>
				<h1 className="mb-5 text-2xl font-bold tracking-tight text-[var(--sea-ink)]">Sign in</h1>

				<form onSubmit={step === "email" ? requestOtp : signInWithOtp} className="space-y-4">
					<label className="block text-sm text-[var(--sea-ink-soft)]">
						Email
						<input
							type="email"
							required
							value={email}
							onChange={(event) => setEmail(event.target.value)}
							disabled={step === "code"}
							className="mt-1 w-full rounded-xl border border-[rgba(50,143,151,0.3)] bg-transparent px-3 py-2 text-sm text-[var(--sea-ink)] outline-none focus:border-[rgba(79,184,178,0.6)]"
							placeholder="you@example.com"
						/>
					</label>
					{step === "code" && (
						<label className="block text-sm text-[var(--sea-ink-soft)]">
							Code (check your inbox, expires in 5 minutes)
							<input
								inputMode="numeric"
								pattern="[0-9]*"
								autoComplete="one-time-code"
								required
								value={otp}
								onChange={(event) => setOtp(event.target.value)}
								className="mt-1 w-full rounded-xl border border-[rgba(50,143,151,0.3)] bg-transparent px-3 py-2 text-sm tracking-[0.3em] text-[var(--sea-ink)] outline-none focus:border-[rgba(79,184,178,0.6)]"
								placeholder="000000"
							/>
						</label>
					)}
					<button
						type="submit"
						disabled={otpBusy}
						className="w-full rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-5 py-2.5 text-sm font-semibold text-[var(--lagoon-deep)] transition hover:bg-[rgba(79,184,178,0.24)] disabled:opacity-50"
					>
						{step === "email" ? "Send code" : "Sign in"}
					</button>
					{step === "code" && (
						<button
							type="button"
							onClick={() => setStep("email")}
							className="text-xs text-[var(--sea-ink-soft)] underline"
						>
							Use a different email
						</button>
					)}
				</form>
				{otpError && <p className="mt-3 text-sm text-red-500">{otpError}</p>}

				<div className="my-6 border-t border-[rgba(50,143,151,0.2)]" />

				<details>
					<summary className="cursor-pointer text-sm text-[var(--sea-ink-soft)]">
						Locked out? Pair with a recovery code
					</summary>
					<form onSubmit={pairWithCode} className="mt-4 space-y-4">
						<label className="block text-sm text-[var(--sea-ink-soft)]">
							Recovery code (minted with <code>wrangler d1 execute</code>)
							<input
								required
								value={pairingCode}
								onChange={(event) => setPairingCode(event.target.value)}
								className="mt-1 w-full rounded-xl border border-[rgba(50,143,151,0.3)] bg-transparent px-3 py-2 font-mono text-sm text-[var(--sea-ink)] outline-none focus:border-[rgba(79,184,178,0.6)]"
								placeholder="paste the code"
							/>
						</label>
						<button
							type="submit"
							disabled={pairingBusy}
							className="w-full rounded-full border border-[rgba(50,143,151,0.3)] px-5 py-2.5 text-sm font-semibold text-[var(--lagoon-deep)] transition hover:bg-[rgba(79,184,178,0.14)] disabled:opacity-50"
						>
							Pair and sign in
						</button>
					</form>
					{pairingError && <p className="mt-3 text-sm text-red-500">{pairingError}</p>}
				</details>
			</section>
		</main>
	);
}
