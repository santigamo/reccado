import { X } from "lucide-react";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { cn } from "#/lib/cn";

export type ToastAction = { label: string; onClick: () => void | Promise<void> };

export type ToastInput = {
	message: string;
	tone?: "neutral" | "danger";
	/** "Undo", "View message"… One action; the toast closes when it runs. */
	action?: ToastAction;
	/** Milliseconds on screen. Default 6 s (8 s with an action). */
	duration?: number;
};

type Toast = ToastInput & { id: number };

type ToastApi = {
	show: (toast: ToastInput) => number;
	dismiss: (id: number) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

/** Show a toast from anywhere under <ToastProvider>. A no-op outside one. */
export function useToast(): ToastApi {
	return useContext(ToastContext) ?? NOOP;
}

const NOOP: ToastApi = { show: () => 0, dismiss: () => {} };

/**
 * Gmail-style snackbar: one line at the bottom left ("Conversation archived ·
 * Undo"), the newest replacing the previous one. Announced politely to screen
 * readers; pauses while hovered or focused so an Undo can still be reached.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
	const [toast, setToast] = useState<Toast | null>(null);
	const nextId = useRef(1);

	const dismiss = useCallback((id: number) => {
		setToast((current) => (current?.id === id ? null : current));
	}, []);
	const show = useCallback((input: ToastInput) => {
		const id = nextId.current++;
		setToast({ ...input, id });
		return id;
	}, []);
	const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

	return (
		<ToastContext.Provider value={api}>
			{children}
			<ToastView toast={toast} onDismiss={dismiss} />
		</ToastContext.Provider>
	);
}

function ToastView({ toast, onDismiss }: { toast: Toast | null; onDismiss: (id: number) => void }) {
	const [paused, setPaused] = useState(false);
	const [running, setRunning] = useState(false);

	useEffect(() => {
		if (!toast || paused || running) return;
		const ms = toast.duration ?? (toast.action ? 8000 : 6000);
		const timer = window.setTimeout(() => onDismiss(toast.id), ms);
		return () => window.clearTimeout(timer);
	}, [toast, paused, running, onDismiss]);

	return (
		<div
			aria-live="polite"
			className="pointer-events-none fixed inset-x-0 bottom-[84px] z-[60] flex justify-center px-4"
		>
			{toast ? (
				// biome-ignore lint/a11y/noStaticElementInteractions: hover only pauses the timer; the buttons inside are the controls.
				<div
					key={toast.id}
					role={toast.tone === "danger" ? "alert" : "status"}
					onMouseEnter={() => setPaused(true)}
					onMouseLeave={() => setPaused(false)}
					onFocus={() => setPaused(true)}
					onBlur={() => setPaused(false)}
					className={cn(
						"pointer-events-auto flex min-h-11 max-w-[min(520px,100%)] items-center gap-3 rounded-control py-2 pr-2 pl-4 text-body shadow-popover",
						toast.tone === "danger" ? "bg-danger text-white" : "bg-brand text-white",
					)}
				>
					<span className="min-w-0 flex-1">{toast.message}</span>
					{toast.action ? (
						<button
							type="button"
							disabled={running}
							onClick={async () => {
								setRunning(true);
								try {
									await toast.action?.onClick();
								} finally {
									setRunning(false);
									onDismiss(toast.id);
								}
							}}
							className="shrink-0 rounded-[6px] px-2.5 py-1 text-body font-semibold text-white underline-offset-2 hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-white disabled:opacity-60"
						>
							{toast.action.label}
						</button>
					) : null}
					<button
						type="button"
						aria-label="Dismiss"
						onClick={() => onDismiss(toast.id)}
						className="inline-flex size-7 shrink-0 items-center justify-center rounded-[6px] text-white/80 hover:bg-white/15 hover:text-white focus-visible:outline-2 focus-visible:outline-white"
					>
						<X className="size-4" />
					</button>
				</div>
			) : null}
		</div>
	);
}
