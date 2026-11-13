import { createFileRoute, Link, notFound, useRouter } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { LiveButton } from "#/components/live-button";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { isAdminRole, useMyRole, useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import {
	type ConnectionActionInput,
	type ConnectionKind,
	type ConnectionView,
	changeConnections,
	getConnections,
	MAX_CONNECTIONS,
	MAX_NAME,
} from "#/lib/connections";
import { formatDateTime, formatRelative } from "#/lib/dates";
import { formatNumber } from "#/lib/numbers";
import { useDocumentTitle } from "#/lib/title";

/** Everything this screen says, in one place, so it can be translated without hunting for it. */
const TEXT = {
	title: "Connections",
	empty: "Nothing connected yet.",
	emptyHint: "Connect a Cloudflare account or a GitHub repository, and Guard starts reading.",
	missing: "Page not found",
	missingHint: "Check the address, or go back to your workspace.",
	connectCloudflare: "Connect a Cloudflare account",
	connectGithub: "Connect a GitHub repository",
	notSetUp: "This server is not set up to keep tokens, so nothing can be connected.",
	notSetUpFix:
		"Whoever runs it sets SECRETS_KEY, a random 32-byte key. See docs/self-hosting.md in Guard's repository.",
	full: (max: string) => `A workspace can have up to ${max} connections.`,
	kind: { cloudflare: "Cloudflare account", github: "GitHub repository" } satisfies Record<
		ConnectionKind,
		string
	>,
	token: (hint: string) => `Token …${hint}`,
	neverScanned: "Not scanned yet.",
	scanned: (when: string) => `Last scan ${when}`,
	next: (when: string) => `Next scan ${when}`,
	openFindings: (count: number, formatted: string) =>
		count === 1 ? `${formatted} open finding` : `${formatted} open findings`,
	outcome: {
		ok: "The last scan went well.",
		unauthorized:
			"Needs attention: the token was refused. It may have been revoked or have expired.",
		forbidden: "Needs attention: the token lacks a permission it needs.",
		not_found:
			"Needs attention: the account or repository was not found, or the token cannot see it.",
		rate_limited: "The service was limiting requests. Guard tries again within the hour.",
		unavailable: "The service could not be reached. Guard tries again within the hour.",
		invalid_response: "The service answered in a way Guard does not understand.",
		unreadable:
			"Needs attention: Guard can no longer open the stored token, as when the server's SECRETS_KEY was replaced.",
	} satisfies Record<string, string>,
	fix: {
		cloudflare:
			"Replace it with a token that has Account › Security Center Insights › Read on this account.",
		github: "Replace it with a token for this repository that has Contents: Read-only.",
	} satisfies Record<ConnectionKind, string>,
	scanNow: "Scan now",
	scanning: "Scanning…",
	replaceToken: "Replace token",
	remove: "Remove",
	removeTitle: (name: string) => `Remove ${name}?`,
	removeBody:
		"Its token is deleted, and so are the findings and scans from it. Guard reads from it no more. You can connect it again later.",
	removed: (name: string) => `${name} removed`,
	scanDone: (found: string, added: string, resolved: string) =>
		`Scan done: ${found} found, ${added} new, ${resolved} closed.`,
	scanFailed: "The scan did not work. See the connection for why.",
	cancel: "Cancel",
	cloudflare: {
		heading: "Connect a Cloudflare account",
		steps:
			"Create an account API token with one permission, Account › Security Center Insights › Read, for this account only. Guard asks for nothing more and only reads.",
		tokenPage: "Create an account API token",
		profilePage: "or a user API token",
		accountId: "Account id",
		accountIdHint:
			"32 characters, in the dashboard's address and at the foot of an account's overview.",
	},
	github: {
		heading: "Connect a GitHub repository",
		steps:
			"Create a fine-grained personal access token for this one repository, with Contents set to Read-only. GitHub adds Metadata (read-only) itself. Guard asks for nothing more and only reads the lockfiles.",
		tokenPage: "Create a fine-grained token",
		repository: "Repository",
		repositoryHint: "owner/name, or the repository's github.com address.",
	},
	tokenLabel: "Token",
	tokenHint: "Sealed before it is stored. Guard shows only its last four characters, ever.",
	nameLabel: "Name (optional)",
	nameHint: "What this is called here. It defaults to the account id or the repository.",
	check: "Check and connect",
	checking: "Checking…",
	connected: "Connected.",
	replaceHeading: (name: string) => `New token for ${name}`,
	replaceSave: "Check and replace",
	replaced: "Token replaced.",
};

const NEEDS_ATTENTION = new Set(["unauthorized", "forbidden", "not_found", "unreadable"]);

export const Route = createFileRoute("/$workspace/connections")({
	loader: async ({ params }) => {
		const page = await getConnections({ data: params.workspace });
		if (!page) throw notFound();
		return page;
	},
	component: ConnectionsPage,
	notFoundComponent: () => <Notice title={TEXT.missing}>{TEXT.missingHint}</Notice>,
});

function ConnectionsPage() {
	useDocumentTitle(TEXT.title);
	const { sealingProblem, connections } = Route.useLoaderData();
	const canManage = isAdminRole(useMyRole());
	const [form, setForm] = useState<ConnectionKind | null>(null);
	const canConnect = canManage && sealingProblem === null && connections.length < MAX_CONNECTIONS;

	const connectButtons = canConnect && (
		<div className="flex flex-wrap justify-center gap-2">
			<Button variant="outline" onClick={() => setForm("cloudflare")}>
				{TEXT.connectCloudflare}
			</Button>
			<Button variant="outline" onClick={() => setForm("github")}>
				{TEXT.connectGithub}
			</Button>
		</div>
	);

	return (
		<div className="mx-auto max-w-4xl space-y-6 px-4 py-10 sm:px-6">
			<h1 className="text-xl font-semibold tracking-tight">{TEXT.title}</h1>
			{sealingProblem !== null && (
				<div className="space-y-1 rounded-lg border p-4 text-sm" role="status">
					<p className="font-medium">{TEXT.notSetUp}</p>
					<p className="text-muted-foreground">{sealingProblem}</p>
					<p className="text-muted-foreground">{TEXT.notSetUpFix}</p>
				</div>
			)}
			{canManage && connections.length >= MAX_CONNECTIONS && (
				<p className="text-sm text-muted-foreground">{TEXT.full(formatNumber(MAX_CONNECTIONS))}</p>
			)}
			{form && canConnect && <ConnectForm kind={form} onDone={() => setForm(null)} />}
			{connections.length === 0 ? (
				<Notice title={TEXT.empty} action={!form && connectButtons}>
					{TEXT.emptyHint}
				</Notice>
			) : (
				<>
					<ul className="divide-y rounded-lg border">
						{connections.map((connection) => (
							<ConnectionRow key={connection.id} connection={connection} canManage={canManage} />
						))}
					</ul>
					{!form && connectButtons}
				</>
			)}
		</div>
	);
}

function ConnectionRow({
	connection,
	canManage,
}: {
	connection: ConnectionView;
	canManage: boolean;
}) {
	const { slug } = useWorkspace();
	const router = useRouter();
	const [scanning, setScanning] = useState(false);
	const [replacing, setReplacing] = useState(false);
	const [removing, setRemoving] = useState(false);
	const outcome = connection.lastScanOutcome;
	const attention = outcome !== null && NEEDS_ATTENTION.has(outcome);
	const outcomeText =
		outcome === null
			? TEXT.neverScanned
			: ((TEXT.outcome as Record<string, string>)[outcome] ?? TEXT.outcome.invalid_response);

	async function scanNow() {
		setScanning(true);
		const result = await changeConnections(slug, { action: "scan", id: connection.id });
		setScanning(false);
		if (!result.ok) toast.error(result.error);
		else if (result.scan && result.scan.outcome === "ok") {
			toast.success(
				TEXT.scanDone(
					formatNumber(result.scan.found),
					formatNumber(result.scan.added),
					formatNumber(result.scan.resolved),
				),
			);
		} else toast.error(TEXT.scanFailed);
		await router.invalidate();
	}

	return (
		<li className="space-y-3 p-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0 space-y-1">
					<p className="wrap-anywhere font-medium">{connection.name}</p>
					<p className="text-sm text-muted-foreground">
						{TEXT.kind[connection.kind]} ·{" "}
						<span className="font-mono wrap-anywhere">{connection.target}</span> ·{" "}
						{TEXT.token(connection.tokenHint)}
					</p>
				</div>
				{canManage && (
					<div className="flex flex-wrap gap-2">
						<LiveButton variant="outline" size="sm" onClick={scanNow} disabled={scanning}>
							{scanning ? TEXT.scanning : TEXT.scanNow}
						</LiveButton>
						<Button variant="outline" size="sm" onClick={() => setReplacing(!replacing)}>
							{TEXT.replaceToken}
						</Button>
						<Button variant="outline" size="sm" onClick={() => setRemoving(true)}>
							{TEXT.remove}
						</Button>
					</div>
				)}
			</div>
			<div className="space-y-1 text-sm">
				<p className={attention ? "font-medium text-destructive" : "text-muted-foreground"}>
					{outcomeText}
					{attention && canManage && ` ${TEXT.fix[connection.kind]}`}
				</p>
				<p className="text-muted-foreground">
					{connection.lastScanAt !== null && (
						<span title={formatDateTime(connection.lastScanAt)}>
							{TEXT.scanned(formatRelative(connection.lastScanAt))} ·{" "}
						</span>
					)}
					<span title={formatDateTime(connection.nextScanAt)}>
						{TEXT.next(formatRelative(connection.nextScanAt))}
					</span>
					{" · "}
					<Link to="/$workspace/findings" params={{ workspace: slug }} className="underline">
						{TEXT.openFindings(connection.openFindings, formatNumber(connection.openFindings))}
					</Link>
				</p>
			</div>
			{replacing && canManage && (
				<TokenForm
					heading={TEXT.replaceHeading(connection.name)}
					submitLabel={TEXT.replaceSave}
					kind={connection.kind}
					fields={null}
					toAction={(token) => ({ action: "replace-token", id: connection.id, token })}
					successMessage={TEXT.replaced}
					onDone={() => setReplacing(false)}
				/>
			)}
			{removing && (
				<ConfirmDialog
					title={TEXT.removeTitle(connection.name)}
					confirmLabel={TEXT.remove}
					onClose={() => setRemoving(false)}
					onConfirm={async () => {
						const result = await changeConnections(slug, { action: "remove", id: connection.id });
						if (result.ok) toast.success(TEXT.removed(connection.name));
						else toast.error(result.error);
						await router.invalidate();
					}}
				>
					{TEXT.removeBody}
				</ConfirmDialog>
			)}
		</li>
	);
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
	return (
		<a href={href} target="_blank" rel="noreferrer noopener" className="underline">
			{children}
		</a>
	);
}

function ConnectForm({ kind, onDone }: { kind: ConnectionKind; onDone: () => void }) {
	const [first, setFirst] = useState("");
	const [name, setName] = useState("");
	const cloudflare = kind === "cloudflare";
	return (
		<TokenForm
			heading={cloudflare ? TEXT.cloudflare.heading : TEXT.github.heading}
			submitLabel={TEXT.check}
			kind={kind}
			fields={
				<>
					<div className="space-y-1.5">
						<Label htmlFor="connect-target">
							{cloudflare ? TEXT.cloudflare.accountId : TEXT.github.repository}
						</Label>
						<Input
							id="connect-target"
							value={first}
							onChange={(event) => setFirst(event.target.value)}
							required
							autoComplete="off"
							spellCheck={false}
							className="font-mono"
							placeholder={cloudflare ? "023e105f4ecef8ad9ca31a8372d0c353" : "owner/name"}
						/>
						<p className="text-xs text-muted-foreground">
							{cloudflare ? TEXT.cloudflare.accountIdHint : TEXT.github.repositoryHint}
						</p>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="connect-name">{TEXT.nameLabel}</Label>
						<Input
							id="connect-name"
							value={name}
							onChange={(event) => setName(event.target.value)}
							maxLength={MAX_NAME}
							autoComplete="off"
						/>
						<p className="text-xs text-muted-foreground">{TEXT.nameHint}</p>
					</div>
				</>
			}
			toAction={(token) =>
				cloudflare
					? { action: "connect-cloudflare", accountId: first, token, name }
					: { action: "connect-github", repository: first, token, name }
			}
			successMessage={TEXT.connected}
			onDone={onDone}
		/>
	);
}

/** A form that takes a token, checks it with the server and says why when it is refused. */
function TokenForm({
	heading,
	submitLabel,
	kind,
	fields,
	toAction,
	successMessage,
	onDone,
}: {
	heading: string;
	submitLabel: string;
	kind: ConnectionKind;
	fields: ReactNode;
	toAction: (token: string) => ConnectionActionInput;
	successMessage: string;
	onDone: () => void;
}) {
	const { slug } = useWorkspace();
	const router = useRouter();
	const [token, setToken] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const cloudflare = kind === "cloudflare";

	async function submit(event: FormEvent) {
		event.preventDefault();
		setPending(true);
		setError(null);
		const result = await changeConnections(slug, toAction(token));
		setPending(false);
		if (!result.ok) {
			setError(result.error);
			return;
		}
		// The token has been sealed; nothing of it stays in the page.
		setToken("");
		toast.success(successMessage);
		await router.invalidate();
		onDone();
	}

	return (
		<form onSubmit={submit} className="space-y-4 rounded-lg border p-4">
			<h2 className="text-base font-semibold">{heading}</h2>
			<p className="text-sm text-muted-foreground">
				{cloudflare ? TEXT.cloudflare.steps : TEXT.github.steps}{" "}
				{cloudflare ? (
					<>
						<ExternalLink href="https://dash.cloudflare.com/?to=/:account/api-tokens">
							{TEXT.cloudflare.tokenPage}
						</ExternalLink>{" "}
						(
						<ExternalLink href="https://dash.cloudflare.com/profile/api-tokens">
							{TEXT.cloudflare.profilePage}
						</ExternalLink>
						).
					</>
				) : (
					<ExternalLink href="https://github.com/settings/personal-access-tokens/new">
						{TEXT.github.tokenPage}
					</ExternalLink>
				)}
			</p>
			{fields}
			<div className="space-y-1.5">
				<Label htmlFor="connect-token">{TEXT.tokenLabel}</Label>
				<Input
					id="connect-token"
					type="password"
					value={token}
					onChange={(event) => setToken(event.target.value)}
					required
					autoComplete="off"
					spellCheck={false}
					className="font-mono"
				/>
				<p className="text-xs text-muted-foreground">{TEXT.tokenHint}</p>
			</div>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			<div className="flex gap-2">
				<LiveButton type="submit" disabled={pending}>
					{pending ? TEXT.checking : submitLabel}
				</LiveButton>
				<Button type="button" variant="outline" onClick={onDone} disabled={pending}>
					{TEXT.cancel}
				</Button>
			</div>
		</form>
	);
}
