/**
 * Service actors are trusted AuthContexts created by authenticated adapters.
 * CLI and MCP callers must never derive owners or the local bypass from input.
 * API key results can contain a one-time secret; future MCP adapters must not expose it.
 */
export * from "./mailboxes";
export * from "./domains";
export * from "./routing";
export * from "./templates";
export * from "./api-keys";
export * from "./suppressions";
export * from "./ops";
export * from "./errors";
