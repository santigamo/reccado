export type McpMailbox = {
	mailbox_id: string;
	primary_address: string;
	display_name: string | null;
};

export type McpThread = {
	id: string;
	subject_norm: string | null;
	last_message_at: string;
	message_count: number;
	unread_count: number;
	latest_subject: string | null;
	latest_from: string | null;
	latest_snippet: string | null;
	latest_received_at: string;
	latest_has_attachments: number;
	latest_is_read: number;
	latest_direction: string;
	latest_state: string;
};

export type McpSearchResult = {
	message_id: string;
	subject: string | null;
	from_addr: string;
	snippet: string | null;
	received_at: string;
};

export type McpAttachment = {
	filename: string | null;
	content_type: string | null;
	size: number;
};

export type McpMessageDto = {
	message_id: string;
	thread_id: string;
	direction: "inbound" | "outbound";
	from_addr: string;
	to: string[];
	cc: string[];
	subject: string | null;
	date: string | null;
	received_at: string;
	is_read: boolean;
	has_attachments: boolean;
	attachments: McpAttachment[];
	body_text: string;
	body_truncated: boolean;
	body_original_length: number;
};

export type McpDraftResult = {
	draft_id: string;
	status: "draft";
	duplicate: boolean;
};
