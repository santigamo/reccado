import { useEffect, useState, type FormEvent, type ReactElement } from "react";
import { registerPasskey, type PasskeyCreationOptions } from "./webauthn";

const FIELD_CLASS =
	"mt-1 w-full rounded-xl border border-[rgba(50,143,151,0.3)] bg-transparent px-3 py-2 text-sm text-[var(--sea-ink)] outline-none focus:border-[rgba(79,184,178,0.6)]";
const PRIMARY_BUTTON_CLASS =
	"rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-5 py-2.5 text-sm font-semibold text-[var(--lagoon-deep)] transition hover:bg-[rgba(79,184,178,0.24)] disabled:opacity-50";
const SECONDARY_BUTTON_CLASS =
	"rounded-full border border-[rgba(50,143,151,0.3)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] transition hover:bg-[rgba(79,184,178,0.14)] disabled:opacity-50";

type ListedPasskey = { id: string; name?: string | null; createdAt?: string | number | null };

type StepUp =
	| { phase: "idle" }
	| { phase: "code"; method: "totp" | "email" }
	| { phase: "ready"; proof: string };

/**
 * Register, list and remove passkeys. Registration asks for a fresh TOTP or
 * email code first; a session opened earlier is not enough.
 */
export function PasskeysSection(): ReactElement {
	const [passkeys, setPasskeys] = useState<ListedPasskey[]>([]);
	const [stepUp, setStepUp] = useState<StepUp>({ phase: "idle" });
	const [code, setCode] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function refresh(): Promise<void> {
		const response = await fetch("/api/auth/passkey/list-user-passkeys");
		if (!response.ok) return;
		const body = (await response.json()) as ListedPasskey[];
		setPasskeys(Array.isArray(body) ? body : []);
	}

	useEffect(() => {
		void refresh();
	}, []);

	async function begin(event: FormEvent): Promise<void> {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const response = await fetch("/api/auth/passkey/step-up", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({}),
			});
			const body = (await response.json()) as { method?: "totp" | "email"; error?: string };
			if (!response.ok || (body.method !== "totp" && body.method !== "email")) {
				setError("No se ha podido pedir el código.");
				return;
			}
			setStepUp({ phase: "code", method: body.method });
		} catch {
			setError("No se ha podido pedir el código.");
		} finally {
			setBusy(false);
		}
	}

	async function confirmCode(event: FormEvent): Promise<void> {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const response = await fetch("/api/auth/passkey/step-up", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ code }),
			});
			const body = (await response.json()) as { proof?: string };
			if (!response.ok || !body.proof) {
				setError("El código no vale. Pide otro.");
				return;
			}
			setCode("");
			setStepUp({ phase: "ready", proof: body.proof });
		} catch {
			setError("El código no vale. Pide otro.");
		} finally {
			setBusy(false);
		}
	}

	async function register(): Promise<void> {
		if (stepUp.phase !== "ready") return;
		setBusy(true);
		setError(null);
		try {
			const optionsResponse = await fetch("/api/auth/passkey/generate-register-options", {
				headers: { "x-passkey-stepup": stepUp.proof },
			});
			if (!optionsResponse.ok) {
				setError("La comprobación ha caducado. Empieza de nuevo.");
				setStepUp({ phase: "idle" });
				return;
			}
			const options = (await optionsResponse.json()) as PasskeyCreationOptions;
			const credential = await registerPasskey(options);
			const verified = await fetch("/api/auth/passkey/verify-registration", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-passkey-stepup": stepUp.proof,
				},
				body: JSON.stringify({ response: credential, name: "Passkey" }),
			});
			if (!verified.ok) {
				setError("No se ha podido registrar la passkey.");
				setStepUp({ phase: "idle" });
				return;
			}
			setStepUp({ phase: "idle" });
			await refresh();
		} catch {
			setError("No se ha podido registrar la passkey.");
			setStepUp({ phase: "idle" });
		} finally {
			setBusy(false);
		}
	}

	async function remove(id: string): Promise<void> {
		setBusy(true);
		setError(null);
		try {
			const response = await fetch("/api/auth/passkey/delete-passkey", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id }),
			});
			if (!response.ok) {
				setError("No se ha podido eliminar la passkey.");
				return;
			}
			await refresh();
		} catch {
			setError("No se ha podido eliminar la passkey.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<section id="passkeys" className="island-shell mt-8 rounded-2xl p-6">
			<h2 className="text-lg font-semibold text-[var(--sea-ink)]">Passkeys</h2>
			<p className="mt-2 text-sm text-[var(--sea-ink-soft)]">
				Una passkey sirve para aprobar lo que un agente quiere enviar. Registrarla pide un código nuevo:
				el de la app de autenticación si está activada, o uno por correo si no.
			</p>
			{passkeys.length === 0 ? (
				<p className="mt-4 text-sm text-[var(--sea-ink-soft)]">Todavía no hay ninguna passkey.</p>
			) : (
				<ul className="mt-4 space-y-2">
					{passkeys.map((passkey) => (
						<li key={passkey.id} className="flex items-center justify-between gap-3 text-sm">
							<span className="text-[var(--sea-ink)]">{passkey.name?.trim() || "Passkey"}</span>
							<button
								type="button"
								className={SECONDARY_BUTTON_CLASS}
								disabled={busy}
								onClick={() => void remove(passkey.id)}
							>
								Eliminar
							</button>
						</li>
					))}
				</ul>
			)}
			{stepUp.phase === "idle" && (
				<form onSubmit={begin} className="mt-4">
					<button type="submit" className={PRIMARY_BUTTON_CLASS} disabled={busy}>
						Registrar una passkey
					</button>
				</form>
			)}
			{stepUp.phase === "code" && (
				<form onSubmit={confirmCode} className="mt-4 space-y-3">
					<label className="block text-sm text-[var(--sea-ink-soft)]">
						{stepUp.method === "totp"
							? "Código de la app de autenticación"
							: "Código que te acabamos de enviar por correo"}
						<input
							inputMode="numeric"
							autoComplete="one-time-code"
							value={code}
							onChange={(event) => setCode(event.target.value)}
							className={FIELD_CLASS}
						/>
					</label>
					<button type="submit" className={PRIMARY_BUTTON_CLASS} disabled={busy || code.trim().length === 0}>
						Continuar
					</button>
				</form>
			)}
			{stepUp.phase === "ready" && (
				<div className="mt-4">
					<button type="button" className={PRIMARY_BUTTON_CLASS} disabled={busy} onClick={() => void register()}>
						Crear la passkey en este dispositivo
					</button>
				</div>
			)}
			{error && <p className="mt-3 text-sm text-red-500">{error}</p>}
		</section>
	);
}
