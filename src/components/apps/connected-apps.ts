/**
 * Contract for the "Aplicaciones conectadas" section of /security: the shape
 * GET /api/oauth-clients returns, plus the pure helpers the component renders from.
 */

export type ConnectedApp = {
	client_id: string;
	name: string | null;
	redirect_hosts: string[];
	granted_scopes: string[];
	authorized: boolean;
	created_at: string | null;
	last_token_at: string | null;
};

export function appName(app: Pick<ConnectedApp, "name" | "client_id">): string {
	return app.name?.trim() || `App ${app.client_id.slice(0, 8)}`;
}

export function formatAppDate(iso: string | null): string {
	if (!iso) return "—";
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric" });
}

export async function readJson<T>(response: Response): Promise<T> {
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return (await response.json()) as T;
}
