import { createFileRoute } from "@tanstack/react-router";
import { AccountSettings } from "#/components/settings/account/AccountSettings";

export const Route = createFileRoute("/settings/account")({ component: AccountSettings });
