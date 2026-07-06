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
import {
	type Draft,
	type Folder,
	fetchDrafts,
	fetchMailboxes,
	fetchThread,
	fetchThreads,
	type Mailbox,
	searchThreads,
	type ThreadDetail,
	type ThreadRow,
} from "./mail";

type Resource<T> = {
	data: T;
	loading: boolean;
	error: string | null;
	refetch: () => void;
};

/**
 * A monotonically increasing token. Bumping it (e.g. on a `message.created`
 * WebSocket event, or a manual refresh) re-runs every mounted mail resource, so
 * the sidebar counts, thread list, and open conversation all refresh together.
 */
const MailSyncContext = createContext(0);

export function MailSyncProvider({ token, children }: { token: number; children: ReactNode }) {
	return createElement(MailSyncContext.Provider, { value: token }, children);
}

/**
 * Generic client-side async resource. Runs only in the browser (via useEffect),
 * which deliberately sidesteps SSR relative-fetch issues in Workers. `deps`
 * re-runs the loader; `refetch()` forces a reload (used on WS events / actions).
 */
function useAsyncResource<T>(
	loader: () => Promise<T>,
	initial: T,
	deps: ReadonlyArray<unknown>,
): Resource<T> {
	const [data, setData] = useState<T>(initial);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [nonce, setNonce] = useState(0);
	const syncToken = useContext(MailSyncContext);
	// Keep the latest loader without making it a dependency of the effect.
	const loaderRef = useRef(loader);
	loaderRef.current = loader;

	// biome-ignore lint/correctness/useExhaustiveDependencies: `nonce` and `syncToken` are deliberate re-run triggers (manual refetch + WS revalidation); the loader is read via a ref, so it is intentionally not a dependency.
	useEffect(() => {
		let alive = true;
		setLoading(true);
		setError(null);
		loaderRef
			.current()
			.then((result) => {
				if (alive) setData(result);
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
	}, [...deps, nonce, syncToken]);

	const refetch = useCallback(() => setNonce((n) => n + 1), []);
	return { data, loading, error, refetch };
}

export function useMailboxes(): Resource<Mailbox[]> {
	return useAsyncResource<Mailbox[]>(() => fetchMailboxes(), [], []);
}

export function useThreads(mailboxId: string, folder: Folder, q?: string): Resource<ThreadRow[]> {
	return useAsyncResource<ThreadRow[]>(
		() => {
			const query = q?.trim();
			if (query) {
				return searchThreads(mailboxId, query, { state: folder.state });
			}
			return fetchThreads(mailboxId, { state: folder.state });
		},
		[],
		[mailboxId, folder.key, q],
	);
}

export function useThread(mailboxId: string, threadId: string): Resource<ThreadDetail | null> {
	return useAsyncResource<ThreadDetail | null>(() => fetchThread(mailboxId, threadId), null, [
		mailboxId,
		threadId,
	]);
}

export function useDrafts(mailboxId: string): Resource<Draft[]> {
	return useAsyncResource<Draft[]>(() => fetchDrafts(mailboxId), [], [mailboxId]);
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
