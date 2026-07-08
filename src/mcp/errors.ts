export type McpToolError = {
	content: Array<{ type: "text"; text: string }>;
	isError: true;
};

export function mcpToolError(message: string): McpToolError {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
	};
}

export function mcpToolResult(text: string) {
	return {
		content: [{ type: "text" as const, text }],
	};
}

export function mcpToolResultJson(data: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
	};
}
