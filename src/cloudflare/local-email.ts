import { handleEmail } from "./email-handler";

function headersFromRawMime(rawText: string): Headers {
	const headers = new Headers();
	const [headerBlock = ""] = rawText.split(/\r?\n\r?\n/, 1);
	let currentName: string | null = null;
	let currentValue = "";

	for (const line of headerBlock.split(/\r?\n/)) {
		if (/^\s/.test(line) && currentName) {
			currentValue += ` ${line.trim()}`;
			continue;
		}
		if (currentName) {
			headers.set(currentName, currentValue);
		}
		const separator = line.indexOf(":");
		if (separator === -1) {
			currentName = null;
			currentValue = "";
			continue;
		}
		currentName = line.slice(0, separator);
		currentValue = line.slice(separator + 1).trim();
	}

	if (currentName) {
		headers.set(currentName, currentValue);
	}

	return headers;
}

export async function handleLocalEmailSimulation(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	if (request.method !== "POST") {
		return new Response("Method not allowed", { status: 405 });
	}

	const url = new URL(request.url);
	const from = url.searchParams.get("from");
	const to = url.searchParams.get("to");
	if (!from || !to) {
		return new Response("from and to query params are required", { status: 400 });
	}

	const rawBytes = new Uint8Array(await request.arrayBuffer());
	const rawText = new TextDecoder().decode(rawBytes);
	const headers = headersFromRawMime(rawText);
	const message = {
		from,
		to,
		raw: new Blob([rawBytes]).stream(),
		headers,
		rawSize: rawBytes.byteLength,
		setReject(reason: string) {
			console.log("local.email.rejected", { to, reason });
		},
		async forward(target: string) {
			console.log("local.email.forwarded", { to, target });
			return { messageId: `local-forward:${target}` };
		},
		async reply() {
			return { messageId: "local-reply" };
		},
	} satisfies ForwardableEmailMessage;

	await handleEmail(message, env, ctx);
	return Response.json({
		ok: true,
		from,
		to,
		rawSize: rawBytes.byteLength,
	});
}
