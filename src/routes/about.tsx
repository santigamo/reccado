import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/about")({
	component: About,
});

function About() {
	return (
		<main className="page-wrap px-4 py-12">
			<section className="island-shell rounded-2xl p-6 sm:p-8">
				<p className="island-kicker mb-2">About</p>
				<h1 className="display-title mb-3 text-4xl font-bold text-[var(--sea-ink)] sm:text-5xl">
					The agent-native inbox, self-hosted on Cloudflare.
				</h1>
				<p className="m-0 max-w-3xl text-base leading-8 text-[var(--sea-ink-soft)]">
					Reccado receives, stores, threads, searches and sends email from your own domains, running
					entirely on Cloudflare Workers, Durable Objects, R2, D1 and Queues — with an MCP layer on
					the roadmap so agents can read, triage and draft your mail.
				</p>
			</section>
		</main>
	);
}
