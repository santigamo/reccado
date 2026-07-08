NEXT:

- Deploy to dev and run the validation gate: connect MCP Inspector to https://&lt;custom-domain&gt;/mcp, list tools, call search_messages, verify Access login

- Run `pnpm setup:mcp-claim --env dev --apply` to backfill owner_email on existing dev mailboxes

- Configure Access MCP server app (Zero Trust → AI controls → MCP servers → Add, enable Managed OAuth)

- Then proceed to Milestone 2.2 (EmailAgent draft-only) which builds on this MCP surface