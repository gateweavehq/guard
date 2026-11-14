import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { claudeCodeCommand, getGrants, getMcpAddress, takeBackGrant } from "#/lib/assistant";
import type { AssistantGrant } from "#/lib/assistant-grants";
import { formatDateTime, formatRelative } from "#/lib/dates";
import { useDocumentTitle } from "#/lib/title";

/** Everything this screen says, in one place, so it can be translated without hunting for it. */
const TEXT = {
	title: "Use Guard from your AI assistant",
	intro:
		"Connect Claude Code, Claude or any assistant that speaks MCP to Guard: paste this address into it and sign in here when it asks. There is no key to copy.",
	address: "Address",
	copy: "Copy",
	copied: "Copied",
	copyFailed: "Could not copy",
	claudeCode: "In Claude Code, one line does it:",
	can: "It acts as you, in every workspace you belong to. It can list findings, read one in full and see the traffic summary. Owners and admins can also let it dismiss a finding, with a reason, and start a scan. It never sees a token.",
	cannot:
		"It cannot connect or remove accounts or repositories, change members, or read anything you cannot. What it reads goes to the assistant you connected, so connect only ones you trust.",
	allowedTitle: "Assistants you allowed",
	allowedIntro: "These act as you, in every workspace you belong to.",
	none: "No assistant has access.",
	unnamed: "An unnamed app",
	namedByApp: "named by the app",
	goesTo: (destination: string) => `Goes to ${destination}`,
	allowed: (when: string) => `Allowed ${when}`,
	lastUsed: (when: string) => `Last used ${when}`,
	notUsed: "Not used yet",
	takeBack: "Take back",
	takeBackTitle: (name: string) => `Take back ${name}?`,
	takeBackBody: (name: string) =>
		`${name} loses access at once. It can ask again, and you would see the consent page.`,
	takenBack: "Access taken back",
	off: "This server cannot offer this yet. Whoever runs it needs to set BETTER_AUTH_URL to the server's public address. See docs/self-hosting.md in Guard's repository.",
};

export const Route = createFileRoute("/$workspace/settings/assistant")({
	loader: async () => {
		const [address, grants] = await Promise.all([getMcpAddress(), getGrants()]);
		return { address, grants };
	},
	component: AssistantPage,
});

async function copy(text: string, what: string) {
	try {
		await navigator.clipboard.writeText(text);
		toast.success(TEXT.copied, { description: what });
	} catch {
		toast.error(TEXT.copyFailed, { description: text });
	}
}

function AssistantPage() {
	const { address, grants } = Route.useLoaderData();
	useDocumentTitle("AI assistant");

	return (
		<section aria-labelledby="assistant-heading" className="space-y-6">
			<div className="space-y-1">
				<h2 id="assistant-heading" className="text-base font-semibold">
					{TEXT.title}
				</h2>
				<p className="text-sm text-muted-foreground">{TEXT.intro}</p>
			</div>
			{address ? (
				<div className="space-y-4 rounded-lg border p-4">
					<Snippet label={TEXT.address} text={address} />
					<Snippet label={TEXT.claudeCode} text={claudeCodeCommand(address)} />
				</div>
			) : (
				<p role="note" className="rounded-lg border p-4 text-sm text-muted-foreground">
					{TEXT.off}
				</p>
			)}
			<div className="space-y-2 text-sm text-muted-foreground">
				<p>{TEXT.can}</p>
				<p>{TEXT.cannot}</p>
			</div>
			{address && <Allowed initial={grants} />}
		</section>
	);
}

/** The assistants this person allowed, each with one button to take it back. */
function Allowed({ initial }: { initial: AssistantGrant[] }) {
	const [grants, setGrants] = useState(initial);
	const [asking, setAsking] = useState<AssistantGrant | null>(null);

	async function takeBack(grant: AssistantGrant) {
		const result = await takeBackGrant(grant.clientId);
		// Gone already, say from another tab: the list is right either way.
		if (result.ok || result.error === "Not found") {
			setGrants((now) => now.filter((one) => one.clientId !== grant.clientId));
			toast.success(TEXT.takenBack);
		} else {
			toast.error("Could not take it back", { description: result.error });
		}
	}

	return (
		<div className="space-y-3">
			<div className="space-y-1">
				<h3 id="allowed-heading" className="text-base font-semibold">
					{TEXT.allowedTitle}
				</h3>
				<p className="text-sm text-muted-foreground">{TEXT.allowedIntro}</p>
			</div>
			{grants.length === 0 ? (
				<p className="rounded-lg border p-4 text-sm text-muted-foreground">{TEXT.none}</p>
			) : (
				<ul aria-labelledby="allowed-heading" className="divide-y rounded-lg border">
					{grants.map((grant) => (
						<li
							key={grant.clientId}
							className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-4"
						>
							<div className="min-w-0 space-y-0.5">
								<p className="wrap-anywhere text-sm font-medium">
									{grant.name ?? TEXT.unnamed}
									{grant.name && (
										<span className="ml-2 font-normal text-muted-foreground text-xs">
											{TEXT.namedByApp}
										</span>
									)}
								</p>
								<p className="wrap-anywhere text-xs text-muted-foreground">
									{TEXT.goesTo(grant.destination)}
								</p>
								<p className="text-xs text-muted-foreground">
									<span title={formatDateTime(grant.allowedAt)}>
										{TEXT.allowed(formatRelative(grant.allowedAt))}
									</span>
									{" · "}
									{grant.lastUsedAt === null ? (
										TEXT.notUsed
									) : (
										<span title={formatDateTime(grant.lastUsedAt)}>
											{TEXT.lastUsed(formatRelative(grant.lastUsedAt))}
										</span>
									)}
								</p>
							</div>
							<Button type="button" variant="outline" size="sm" onClick={() => setAsking(grant)}>
								{TEXT.takeBack}
							</Button>
						</li>
					))}
				</ul>
			)}
			{asking && (
				<ConfirmDialog
					title={TEXT.takeBackTitle(asking.name ?? TEXT.unnamed)}
					confirmLabel={TEXT.takeBack}
					onConfirm={() => takeBack(asking)}
					onClose={() => setAsking(null)}
				>
					{TEXT.takeBackBody(asking.name ?? TEXT.unnamed)}
				</ConfirmDialog>
			)}
		</div>
	);
}

function Snippet({ label, text }: { label: string; text: string }) {
	return (
		<div className="space-y-1.5">
			<p className="text-sm">{label}</p>
			<div className="flex items-center gap-2">
				<code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md bg-muted px-3 py-2 font-mono text-xs">
					{text}
				</code>
				<Button type="button" variant="outline" size="sm" onClick={() => copy(text, label)}>
					{TEXT.copy}
				</Button>
			</div>
		</div>
	);
}
