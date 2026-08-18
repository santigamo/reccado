export class AppError extends Error {
	constructor(
		message: string,
		readonly code: string,
		readonly status = 400,
	) {
		super(message);
		this.name = "AppError";
	}
}

export function isAppError(error: unknown): error is AppError {
	return error instanceof AppError;
}

/**
 * Wraps an ambiguous/transient failure from EMAIL.send — the provider may or may
 * not have accepted the message. The DO keeps its sent marker in place to prevent
 * retries with the same idempotency key, and the caller records a "unknown" D1
 * row with error code "ambiguous" (no automatic re-delivery). Human review is
 * required to reconcile the actual outcome. Under no circumstance is the ambiguous
 * outcome converted to "failed" for automatic retry.
 *
 * This is not an AppError because it originates in the DO boundary and is caught
 * before it reaches HTTP response logic.
 */
export class AmbiguousSendError extends Error {
	constructor(
		message: string,
		readonly original: unknown = undefined,
	) {
		super(message);
		this.name = "AmbiguousSendError";
	}
}

export function isAmbiguousSendError(error: unknown): error is AmbiguousSendError {
	return error instanceof AmbiguousSendError;
}
