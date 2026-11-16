import {
	createContext,
	createElement,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { fetchMailboxes, fetchThread, type Mailbox, type ThreadDetail } from "./mail";

type Resource<T> = {
	data: T;
	loading: boolean;
	error: string | null;
	refetch: () => void;
	/**
	 * Id of the load whose result `data` holds. Loads are numbered in the order
	 * they start, so `appliedRun > n` means the data on screen was fetched by a
	 * load that started after `startedRuns()` returned n (optimistic UI uses this
	 * to know when the server's answer can replace its guess).
	 */
	appliedRun: number;
	/** How many loads have started so far. */
	startedRuns: () => number;
};

/**
 * A monotonically increasing token. Bumping it (e.g. on a `message.created`
 * WebSocket event, or a manual refresh) re-runs every mounted mail resource, so
 * the sidebar counts, thread list, and open conversation all refresh together.
 */
const MailSyncContext = createContext(0);

/** The current revalidation token (for resources that manage their own loading). */
export function useMailSyncToken(): number {
	return useContext(MailSyncContext);
}

export function MailSyncProvider({ token, children }: { token: number; children: ReactNode }) {
	return createElement(MailSyncContext.Provider, { value: token }, children);
}

/**
 * Generic client-side async resource. Runs only in the browser (via useEffect),
 * which deliberately sidesteps SSR relative-fetch issues in Workers. `deps`
 * re-runs the loader; `refetch()` forces a reload (used on WS events / actions).
 */
export function useAsyncResource<T>(
	loader: () => Promise<T>,
	initial: T,
	deps: ReadonlyArray<unknown>,
): Resource<T> {
	const [data, setData] = useState<T>(initial);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [nonce, setNonce] = useState(0);
	const [appliedRun, setAppliedRun] = useState(0);
	const runRef = useRef(0);
	const syncToken = useContext(MailSyncContext);
	// Keep the latest loader without making it a dependency of the effect.
	const loaderRef = useRef(loader);
	loaderRef.current = loader;
	const initialRef = useRef(initial);
	initialRef.current = initial;
	// A change of `deps` is a different resource: reset to the loading state.
	// A refetch / sync bump of the same resource revalidates in the background,
	// keeping the current data on screen (no spinner flash on new mail).
	const depsKey = JSON.stringify(deps);
	const lastDepsKeyRef = useRef<string | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `nonce` and `syncToken` are deliberate re-run triggers (manual refetch + WS revalidation); the loader is read via a ref, so it is intentionally not a dependency.
	useEffect(() => {
		let alive = true;
		if (lastDepsKeyRef.current !== depsKey) {
			lastDepsKeyRef.current = depsKey;
			setData(initialRef.current);
			setLoading(true);
		}
		setError(null);
		const run = ++runRef.current;
		loaderRef
			.current()
			.then((result) => {
				if (alive) {
					setData(result);
					setAppliedRun(run);
				}
			})
			.catch((err: unknown) => {
				if (alive) setError(err instanceof Error ? err.message : "Something went wrong");
			})
			.finally(() => {
				if (alive) setLoading(false);
			});
		return () => {
			alive = false;
		};
	}, [depsKey, nonce, syncToken]);

	const refetch = useCallback(() => setNonce((n) => n + 1), []);
	const startedRuns = useCallback(() => runRef.current, []);
	return { data, loading, error, refetch, appliedRun, startedRuns };
}

export function useMailboxes(): Resource<Mailbox[]> {
	return useAsyncResource<Mailbox[]>(() => fetchMailboxes(), [], []);
}

export function useThread(mailboxId: string, threadId: string): Resource<ThreadDetail | null> {
	return useAsyncResource<ThreadDetail | null>(() => fetchThread(mailboxId, threadId), null, [
		mailboxId,
		threadId,
	]);
}

export type MailSocketEvent = {
	type?: string;
	payload?: { messageId?: string; threadId?: string; subject?: string };
};

/**
 * Single WebSocket per mailbox. Invokes `onEvent` for every server message
 * (notably `message.created` on new inbound mail). The callback is kept in a
 * ref so the socket isn't torn down when the handler identity changes.
 */
export function useMailboxSocket(
	mailboxId: string,
	onEvent: (event: MailSocketEvent) => void,
): void {
	const handlerRef = useRef(onEvent);
	handlerRef.current = onEvent;

	useEffect(() => {
		if (typeof window === "undefined") return;
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const url = `${protocol}//${window.location.host}/api/mailboxes/${encodeURIComponent(mailboxId)}/ws`;
		let ws: WebSocket;
		try {
			ws = new WebSocket(url);
		} catch {
			return;
		}
		ws.onopen = () => {
			try {
				ws.send(
					JSON.stringify({
						v: 1,
						type: "ping",
						id: "1",
						mailboxId,
						ts: new Date().toISOString(),
						payload: {},
					}),
				);
			} catch {
				// socket closed before open completed; ignore
			}
		};
		ws.onmessage = (event) => {
			try {
				handlerRef.current(JSON.parse(String(event.data)) as MailSocketEvent);
			} catch {
				// ignore malformed frames
			}
		};
		return () => ws.close();
	}, [mailboxId]);
}
