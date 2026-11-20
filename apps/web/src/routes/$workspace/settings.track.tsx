import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { LiveButton } from "#/components/live-button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { isAdminRole, useMyRole, useWorkspace } from "#/components/workspace/context";
import { formatRelative } from "#/lib/dates";
import { useDocumentTitle } from "#/lib/title";
import {
	changeTrack,
	getTrack,
	type SourceView,
	sourceAnswerText,
	startTrackConnect,
	TRACK_DEFAULT_ADDRESS,
	type TrackIntegrationView,
} from "#/lib/track";

/** Everything this screen says, in one place, so it can be translated without hunting for it. */
const TEXT = {
	title: "Gateweave Track",
	sources: "Report findings automatically",
	setup: (origin: string) =>
		`Choose Connect Track to approve a source for this connection. To use a pasted key, make a source in Track’s Settings › Sources. Choose product guard and add ${origin} as a link origin. Choose the lowest severity you want to file. Track defaults to high. Turn on "close when cleared": Guard clears a finding only after a complete scan, and Track completes only an issue nobody has started.`,
	switching:
		"Saving a source key removes this workspace's agent key and switches from manual filing to automatic reporting. Existing issue links stay available.",
	assignee:
		"To have an agent work on these issues, set an assignee for this source in Track's Settings › Sources.",
	stopped:
		"Track has not known this key for seven days, so Guard stopped sending. Connect again or paste a new key to start sending.",
	sourceKey: "Source key",
	saveSource: "Save source key",
	connect: "Connect Track",
	fallback: "On an older Track, paste the source key here.",
	reconnect:
		"Connecting again replaces this key. The old source stays in Track until you delete it there.",
	failed: "Track was not connected",
	sourceSaved: "Source key saved.",
	lastAnswer: (answer: string, time: string) => `Last answer: ${answer} · ${time}`,
	awaiting: "Waiting for a finding to report.",
	memberSource: "This workspace reports findings automatically to Track.",
	disconnect: "Stop reporting",
	disconnectTitle: "Stop reporting findings to Track?",
	disconnectBody:
		"Guard forgets every source key and stops sending. The issues already made stay in Track, and their links stay on the findings. You can connect Track again afterwards, with source keys or an agent key.",
	disconnected: "Guard no longer reports to Track.",
	intro:
		"File a finding as an issue in Gateweave Track, and ask Gateweave Agents to fix a dependency through it. Guard sends Track only what it found, never a token or a secret.",
	privacy:
		"Findings about multi-factor authentication name the members who have it off, by email: those go to this same team's Track.",
	notSetUp: "This server is not set up to keep keys, so Track cannot be connected.",
	notSetUpFix:
		"Whoever runs it sets SECRETS_KEY, a random 32-byte key. See docs/self-hosting.md in Guard's repository.",
	memberNone: "Gateweave Track is not connected. Ask an owner or admin to connect it.",
	memberSet: (workspace: string, team: string) =>
		`Findings are filed in the ${team} team of the ${workspace} workspace in Track.`,
	memberFix: (label: string) =>
		`Dependencies with a fix can also be sent to Agents, through the label ${label}.`,
	connected: (key: string) => `Key …${key}`,
	checked: (when: string) => `Last answered ${when}.`,
	outcome: {
		ok: "",
		unauthorized: "Track refused the key. It was revoked, or its agent was deleted: replace it.",
		not_found: "The workspace or team was not found. Check them, or replace the key.",
		no_label: "The label is not in Track any more. Make it there again, or change it here.",
		unreachable: "Track could not be reached the last time Guard tried.",
		not_mcp: "Nothing at that address answered as Track does the last time Guard tried.",
		invalid_response: "Track answered in a way Guard did not understand the last time it tried.",
		tool_error: "Track refused the last filing.",
	} satisfies Record<string, string>,
	addressLabel: "Track's address",
	addressHint:
		"Where Track runs: https://track.gateweave.com for Gateweave Cloud, or your own, such as https://track.example.com.",
	workspaceLabel: "Track workspace",
	workspaceHint: "The first part of its address in Track: the slug.",
	teamLabel: "Team key",
	teamHint: "The team issues go to, by its key, such as ENG. Guard files in this team only.",
	labelLabel: "Label that asks Agents for a fix (optional)",
	labelHint:
		"A label that exists in that workspace, such as agent. Dependencies with a fix get an Ask Agents button that adds it.",
	labelHowTo:
		"To use it: make the label in Track, then give Gateweave Agents a trigger for Track issues with that label. Guard holds no Agents secret; Agents opens the pull request, and it shows on the Track issue.",
	keyLabel: "Agent member's key",
	keyHint:
		"Make an agent member in Track (Settings, Agents) and paste its key. It is sealed before it is stored, and Guard shows only its last four characters.",
	keyKept: (hint: string) => `Leave empty to keep the key ending …${hint}.`,
	save: "Check and save",
	saving: "Checking…",
	saved: "Saved. Track answered.",
	remove: "Remove",
	removeTitle: "Remove Gateweave Track?",
	removeBody:
		"Findings can no longer be filed. The issues already made stay in Track, and their links stay on the findings.",
	removed: "Gateweave Track removed.",
	cancel: "Cancel",
	missing: "Page not found",
};

export const Route = createFileRoute("/$workspace/settings/track")({
	loader: async ({ params }) => {
		const page = await getTrack({ data: params.workspace });
		if (!page) throw notFound();
		return page;
	},
	component: TrackPage,
});

function TrackPage() {
	useDocumentTitle(TEXT.title);
	const { sealingProblem, integration, sources, guardOrigin, sourceAddress } =
		Route.useLoaderData();
	const admin = isAdminRole(useMyRole());

	return (
		<section aria-labelledby="track-heading" className="space-y-6">
			<div className="space-y-1">
				<h2 id="track-heading" className="text-base font-semibold">
					{TEXT.title}
				</h2>
				<p className="text-sm text-muted-foreground">{TEXT.intro}</p>
			</div>
			{admin ? (
				sealingProblem ? (
					<div role="note" className="space-y-1 rounded-lg border p-4 text-sm">
						<p className="font-medium">{TEXT.notSetUp}</p>
						<p className="text-muted-foreground">{TEXT.notSetUpFix}</p>
					</div>
				) : (
					<>
						{sources.length > 0 && (
							<section className="space-y-4">
								<h3 className="font-semibold">{TEXT.sources}</h3>
								<p className="text-sm">{TEXT.setup(guardOrigin)}</p>
								{integration && <p className="text-sm">{TEXT.switching}</p>}
								{sources.map((row) => (
									<SourceForm
										key={row.id}
										row={row}
										address={sourceAddress ?? integration?.address ?? null}
									/>
								))}
								{sourceAddress && <Disconnect />}
							</section>
						)}
						{!sourceAddress && <TrackForm integration={integration} />}
					</>
				)
			) : sourceAddress ? (
				<p>{TEXT.memberSource}</p>
			) : (
				<MemberStatus integration={integration} />
			)}
			<p className="text-sm text-muted-foreground">{TEXT.privacy}</p>
		</section>
	);
}

function Disconnect() {
	const { slug } = useWorkspace();
	const router = useRouter();
	const [asking, setAsking] = useState(false);
	async function disconnect() {
		const result = await changeTrack(slug, { action: "remove" });
		if (!result.ok) {
			toast.error(result.error);
			return;
		}
		toast.success(TEXT.disconnected);
		await router.invalidate();
	}
	return (
		<>
			<LiveButton type="button" variant="outline" onClick={() => setAsking(true)}>
				{TEXT.disconnect}
			</LiveButton>
			{asking && (
				<ConfirmDialog
					title={TEXT.disconnectTitle}
					confirmLabel={TEXT.disconnect}
					onConfirm={disconnect}
					onClose={() => setAsking(false)}
				>
					{TEXT.disconnectBody}
				</ConfirmDialog>
			)}
		</>
	);
}

function SourceForm({ row, address }: { row: SourceView; address: string | null }) {
	const { slug } = useWorkspace();
	const router = useRouter();
	const [key, setKey] = useState("");
	const [origin, setOrigin] = useState(address ?? TRACK_DEFAULT_ADDRESS);
	const [pending, setPending] = useState(false);
	async function connect() {
		setPending(true);
		try {
			const result = await startTrackConnect({
				data: { slug, connectionId: row.id, address: address ?? origin },
			});
			if (result.ok) window.location.assign(result.url);
			else toast.error(result.error);
		} catch {
			toast.error(TEXT.failed);
		} finally {
			setPending(false);
		}
	}
	async function submit(event: FormEvent) {
		event.preventDefault();
		setPending(true);
		try {
			const result = await changeTrack(slug, {
				action: "source",
				connectionId: row.id,
				key,
				address: address ?? origin,
			});
			if (!result.ok) {
				toast.error(result.error);
				return;
			}
			setKey("");
			toast.success(TEXT.sourceSaved);
			await router.invalidate();
		} finally {
			setPending(false);
		}
	}
	return (
		<form className="space-y-3 rounded-lg border p-4 text-sm" onSubmit={submit}>
			<h4 className="font-medium">{row.name}</h4>
			<label htmlFor={`source-origin-${row.id}`}>
				{TEXT.addressLabel}
				<Input
					id={`source-origin-${row.id}`}
					value={address ?? origin}
					readOnly={!!address}
					required
					onChange={(event) => setOrigin(event.target.value)}
				/>
			</label>
			<label htmlFor={`source-key-${row.id}`}>
				{TEXT.sourceKey}
				<Input
					id={`source-key-${row.id}`}
					type="password"
					autoComplete="new-password"
					value={key}
					required
					onChange={(event) => setKey(event.target.value)}
				/>
			</label>
			{row.keyHint && (
				<p>
					{TEXT.connected(row.keyHint)} ·{" "}
					{row.lastAnswer && row.answeredAt
						? TEXT.lastAnswer(sourceAnswerText(row.lastAnswer), formatRelative(row.answeredAt))
						: TEXT.awaiting}
				</p>
			)}
			{row.stopped && <p role="alert">{TEXT.stopped}</p>}
			{row.kind === "github" && <p>{TEXT.assignee}</p>}
			{row.keyHint && <p>{TEXT.reconnect}</p>}
			<p>{TEXT.fallback}</p>
			<LiveButton type="button" disabled={pending} onClick={connect}>
				{TEXT.connect}
			</LiveButton>
			<LiveButton type="submit" disabled={pending}>
				{TEXT.saveSource}
			</LiveButton>
		</form>
	);
}

function MemberStatus({ integration }: { integration: TrackIntegrationView | null }) {
	if (!integration) {
		return <p className="text-sm">{TEXT.memberNone}</p>;
	}
	return (
		<div className="space-y-1 text-sm">
			<p>{TEXT.memberSet(integration.workspace, integration.team)}</p>
			{integration.fixLabel && (
				<p className="text-muted-foreground">{TEXT.memberFix(integration.fixLabel)}</p>
			)}
		</div>
	);
}

function TrackForm({ integration }: { integration: TrackIntegrationView | null }) {
	const { slug } = useWorkspace();
	const router = useRouter();
	const [address, setAddress] = useState(integration?.address ?? TRACK_DEFAULT_ADDRESS);
	const [workspace, setWorkspace] = useState(integration?.workspace ?? "");
	const [team, setTeam] = useState(integration?.team ?? "");
	const [fixLabel, setFixLabel] = useState(integration?.fixLabel ?? "");
	const [key, setKey] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [removing, setRemoving] = useState(false);
	// A kept key is for the address it was made at; another address needs a key of its own.
	const keepable =
		integration !== null && address.trim().replace(/\/+$/, "") === integration.address;

	async function submit(event: FormEvent) {
		event.preventDefault();
		setPending(true);
		setError(null);
		const result = await changeTrack(slug, {
			action: "save",
			address,
			workspace,
			team,
			fixLabel,
			key,
		});
		setPending(false);
		if (!result.ok) {
			setError(result.error);
			return;
		}
		// The key has been sealed; nothing of it stays in the page.
		setKey("");
		toast.success(TEXT.saved);
		await router.invalidate();
	}

	async function remove() {
		const result = await changeTrack(slug, { action: "remove" });
		if (!result.ok) {
			toast.error(result.error);
			return;
		}
		toast.success(TEXT.removed);
		setWorkspace("");
		setTeam("");
		setFixLabel("");
		await router.invalidate();
	}

	const problem = integration?.lastCheckOutcome
		? TEXT.outcome[integration.lastCheckOutcome as keyof typeof TEXT.outcome]
		: "";

	return (
		<>
			<form onSubmit={submit} className="space-y-4 rounded-lg border p-4">
				{integration && (
					<div className="space-y-1 text-sm text-muted-foreground">
						<p>
							{integration.keyHint ? TEXT.connected(integration.keyHint) : ""}
							{integration.lastCheckAt
								? ` · ${TEXT.checked(formatRelative(integration.lastCheckAt))}`
								: ""}
						</p>
						{problem && (
							<p role="alert" className="text-destructive">
								{problem}
							</p>
						)}
					</div>
				)}
				<Field
					id="track-address"
					label={TEXT.addressLabel}
					hint={TEXT.addressHint}
					value={address}
					onChange={setAddress}
					placeholder={TRACK_DEFAULT_ADDRESS}
					mono
				/>
				<div className="grid gap-4 sm:grid-cols-2">
					<Field
						id="track-workspace"
						label={TEXT.workspaceLabel}
						hint={TEXT.workspaceHint}
						value={workspace}
						onChange={setWorkspace}
						placeholder="acme"
						mono
					/>
					<Field
						id="track-team"
						label={TEXT.teamLabel}
						hint={TEXT.teamHint}
						value={team}
						onChange={setTeam}
						placeholder="ENG"
						mono
					/>
				</div>
				<Field
					id="track-label"
					label={TEXT.labelLabel}
					hint={TEXT.labelHint}
					value={fixLabel}
					onChange={setFixLabel}
					placeholder="agent"
					required={false}
				/>
				{!fixLabel.trim() && <p className="text-xs text-muted-foreground">{TEXT.labelHowTo}</p>}
				<Field
					id="track-key"
					label={TEXT.keyLabel}
					hint={keepable && integration?.keyHint ? TEXT.keyKept(integration.keyHint) : TEXT.keyHint}
					value={key}
					onChange={setKey}
					placeholder="gwt_…"
					type="password"
					mono
					required={!keepable}
				/>
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
				<div className="flex flex-wrap gap-2">
					<LiveButton type="submit" disabled={pending}>
						{pending ? TEXT.saving : TEXT.save}
					</LiveButton>
					{integration && (
						<LiveButton type="button" variant="outline" onClick={() => setRemoving(true)}>
							{TEXT.remove}
						</LiveButton>
					)}
				</div>
			</form>
			{removing && (
				<ConfirmDialog
					title={TEXT.removeTitle}
					confirmLabel={TEXT.remove}
					onConfirm={remove}
					onClose={() => setRemoving(false)}
				>
					{TEXT.removeBody}
				</ConfirmDialog>
			)}
		</>
	);
}

function Field({
	id,
	label,
	hint,
	value,
	onChange,
	placeholder,
	type = "text",
	mono = false,
	required = true,
}: {
	id: string;
	label: string;
	hint: string;
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	type?: string;
	mono?: boolean;
	required?: boolean;
}) {
	return (
		<div className="space-y-1.5">
			<Label htmlFor={id}>{label}</Label>
			<Input
				id={id}
				type={type}
				value={value}
				onChange={(event) => onChange(event.target.value)}
				placeholder={placeholder}
				required={required}
				autoComplete="off"
				spellCheck={false}
				aria-describedby={`${id}-hint`}
				className={mono ? "font-mono" : undefined}
			/>
			<p id={`${id}-hint`} className="text-xs text-muted-foreground">
				{hint}
			</p>
		</div>
	);
}
