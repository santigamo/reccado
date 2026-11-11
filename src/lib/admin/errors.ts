import { AppError } from "../errors";
import { ZodError, type z } from "zod";

/** A stable service error with the exact response shape expected by REST. */
export class AdminError extends AppError {
	constructor(
		message: string,
		code: string,
		status: number,
		readonly includeMessage = true,
	) {
		super(message, code, status);
		this.name = "AdminError";
	}
}

export class AdminValidationError extends AdminError {
	constructor(readonly issues: ReturnType<ZodError["flatten"]>) {
		super("Validation failed", "validation_error", 400, false);
	}
}

export class AdminRemoteError extends AdminError {
	constructor(
		code: string,
		status: number,
		readonly body: string,
		readonly headers: Headers,
	) {
		super(code, code, status, false);
	}
}

export type AdminProxyResult = { status: number; headers: Headers; body: string; value: unknown };

/** Preserve the DO's bytes and headers while making its errors available to non-HTTP callers. */
export async function readAdminResponse(response: Response): Promise<AdminProxyResult> {
	const body = await response.text();
	let value: unknown;
	try {
		value = JSON.parse(body);
	} catch {
		value = undefined;
	}
	if (!response.ok) {
		const code =
			typeof value === "object" &&
			value !== null &&
			"error" in value &&
			typeof value.error === "string"
				? value.error
				: "upstream_error";
		throw new AdminRemoteError(code, response.status, body, response.headers);
	}
	return { status: response.status, headers: response.headers, body, value };
}

export function adminResponse(result: AdminProxyResult): Response {
	return new Response([204, 205, 304].includes(result.status) ? null : result.body, {
		status: result.status,
		headers: result.headers,
	});
}

export function parseAdmin<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
	try {
		return schema.parse(input);
	} catch (error) {
		if (error instanceof ZodError) throw new AdminValidationError(error.flatten());
		throw error;
	}
}
