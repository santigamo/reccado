import { ChevronDown, Layers } from "lucide-react";
import { Menu, type MenuItem } from "#/components/ui/Menu";
import { CountBadge } from "#/components/ui/Pill";
import { StatusDot } from "#/components/ui/StatusDot";
import type { Mailbox } from "#/lib/mail";
import { type MailboxColor, sortMailboxesForColor } from "#/lib/mailbox-color";
import { formatCount } from "#/lib/use-unified-mail";

/** Header pill: "●●● All mailboxes 5 ▾" or "● hello@imsanti.dev ▾". */
export function ScopeSwitcher({
	mailboxes,
	scope,
	colorOf,
	unreadOf,
	onChange,
}: {
	mailboxes: Mailbox[];
	/** Selected mailbox id, or undefined for all. */
	scope: string | undefined;
	colorOf: (id: string) => MailboxColor;
	unreadOf: (id: string) => number;
	onChange: (mailboxId: string | undefined) => void;
}) {
	const ordered = sortMailboxesForColor(mailboxes);
	const current = scope ? mailboxes.find((m) => m.mailbox_id === scope) : undefined;

	const items: MenuItem[] = [
		{
			key: "all",
			label: "All mailboxes",
			icon: <Layers />,
			active: !scope,
			trailing: <CountBadge count={mailboxes.length} />,
			onSelect: () => onChange(undefined),
		},
		{ key: "sep", separator: true },
		...ordered.map(
			(m): MenuItem => ({
				key: m.mailbox_id,
				label: m.primary_address,
				icon: (
					<span className="flex w-4 justify-center">
						<StatusDot color={colorOf(m.mailbox_id).css} size={8} />
					</span>
				),
				active: scope === m.mailbox_id,
				trailing:
					unreadOf(m.mailbox_id) > 0 ? (
						<CountBadge count={formatCount(unreadOf(m.mailbox_id))} />
					) : undefined,
				onSelect: () => onChange(m.mailbox_id),
			}),
		),
	];

	return (
		<Menu
			label={`Mailbox scope: ${current ? current.primary_address : "all mailboxes"}`}
			items={items}
			menuClassName="min-w-64"
			triggerClassName="flex h-8 max-w-[220px] shrink-0 items-center gap-2 rounded-pill border border-border pr-2 pl-2.5 text-label hover:bg-hover"
			trigger={
				<>
					<span className="flex items-center gap-[3px]">
						{(current ? [current] : ordered.slice(0, 3)).map((m) => (
							<StatusDot key={m.mailbox_id} color={colorOf(m.mailbox_id).css} />
						))}
					</span>
					<span className="truncate font-medium text-text">
						{current ? current.primary_address : "All mailboxes"}
					</span>
					{current ? null : <span className="text-text-muted">{mailboxes.length}</span>}
					<ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-text-muted" />
				</>
			}
		/>
	);
}
