/// <reference types="@cloudflare/workers-types" />

declare interface Env {
	MAILBOX_ID_SECRET?: string;
	ACCESS_JWT_AUDIENCE?: string;
	ACCESS_TEAM_DOMAIN?: string;
	PHASE0_DEBUG_TOKEN?: string;
	CLOUDFLARE_API_TOKEN?: string;
}
