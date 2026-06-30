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
