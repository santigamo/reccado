import { useAsyncResource } from "./use-mail";

export type Me = { userId: string | null; email: string | null };

async function fetchMe(): Promise<Me> {
	const res = await fetch("/api/me");
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const data = (await res.json()) as { userId?: string; email?: string };
	return { userId: data.userId ?? null, email: data.email ?? null };
}

/** The signed-in owner (GET /api/me). */
export function useMe() {
	return useAsyncResource<Me | null>(fetchMe, null, []);
}

/** "santi@x.dev" -> "SA"; "ana.perez@x" -> "AP". */
export function ownerInitials(email: string | null | undefined): string {
	if (!email) return "";
	const local = email.split("@")[0] ?? "";
	const parts = local.split(/[._+-]+/).filter(Boolean);
	if (parts.length >= 2) return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase();
	return local.slice(0, 2).toUpperCase();
}
