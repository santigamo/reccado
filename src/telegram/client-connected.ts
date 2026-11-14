import { readTelegramConfig, sendMessage } from "./api";
import { resolveTelegramChatId } from "./binding";
import { telegramEscape } from "./format";

export function renderClientConnectedNotice(input: {
	clientName: string;
	redirectHosts: string[];
	scopes: string[];
}): string {
	const hosts = input.redirectHosts.length ? input.redirectHosts.join(", ") : "?";
	const scopes = input.scopes.length ? input.scopes.join(" ") : "(ninguno)";
	return (
		`<b>Nueva app conectada:</b> ${telegramEscape(input.clientName)} (${telegramEscape(hosts)}) ` +
		`con permisos <code>${telegramEscape(scopes)}</code>\n` +
		`Si no la reconoces, revócala en /security → Aplicaciones conectadas.`
	);
}

/** Best-effort notice to the owner's bound chat on a client's FIRST consent. Never throws. */
export async function notifyClientConnected(
	env: Env,
	input: { clientName: string; redirectHosts: string[]; scopes: string[] },
): Promise<void> {
	try {
		const config = readTelegramConfig(env);
		const chatId = await resolveTelegramChatId(env);
		if (!config || !chatId) return;
		await sendMessage(config, { chatId, text: renderClientConnectedNotice(input) });
	} catch (error) {
		console.warn("client-connected.notify_failed", error instanceof Error ? error.message : error);
	}
}
