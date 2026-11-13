import { createFileRoute, Link, notFound, useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { LiveButton } from "#/components/live-button";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { isAdminRole, useMyRole, useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import {
	changeFindings,
	FindingFilters,
	type FindingSeverity,
	type FindingSource,
	type FindingStatus,
	type FindingView,
	getFindings,
	MAX_DISMISS_REASON,
	SEVERITIES,
	SOURCES,
	STATUSES,
} from "#/lib/connections";
import { formatDateTime, formatRelative } from "#/lib/dates";
import { formatNumber } from "#/lib/numbers";
import { useDocumentTitle } from "#/lib/title";
import { cn } from "#/lib/utils";

/** Everything this screen says, in one place, so it can be translated without hunting for it. */
const TEXT = {
	title: "Findings",
	empty: "No findings yet.",
	hint: "Connect a Cloudflare account or a GitHub repository to start.",
	toConnections: "Connections",
	missing: "Page not found",
	missingHint: "Check the address, or go back to your workspace.",
	noOpen: "No open findings.",
	noOpenHint: "Everything Guard reads from your connections is in order.",
	noMatch: "No findings match.",
	noMatchHint: "Try other filters.",
	filters: "Filters",
	severity: "Severity",
	source: "Source",
	status: "Status",
	any: "Any",
	severities: {
		critical: "Critical",
		high: "High",
		moderate: "Moderate",
		low: "Low",
		unknown: "Unknown",
	} satisfies Record<FindingSeverity, string>,
	sources: { cloudflare: "Cloudflare", dependency: "Dependencies" } satisfies Record<
		FindingSource,
		string
	>,
	statuses: { open: "Open", resolved: "Resolved", dismissed: "Dismissed" } satisfies Record<
		FindingStatus,
		string
	>,
	showing: (shown: string, total: string) => `Showing ${shown} of ${total}.`,
	count: (total: string) => `${total} found.`,
	firstSeen: (when: string) => `First seen ${when}`,
	connection: (name: string) => `From ${name}`,
	fixedIn: (version: string) => `Fixed in ${version}`,
	noFix: "No fix is known for every version installed.",
	openIn: { cloudflare: "Open in Cloudflare", dependency: "Read the advisory" } satisfies Record<
		FindingSource,
		string
	>,
	dismiss: "Dismiss",
	dismissTitle: "Dismiss this finding?",
	dismissBody:
		"It stays out of the open list, whatever later scans see, until someone un-dismisses it. Say why, so the next person knows.",
	reasonLabel: "Reason",
	reasonHint: (max: string) => `Up to ${max} characters.`,
	cancel: "Cancel",
	dismissed: "Finding dismissed.",
	undismiss: "Un-dismiss",
	undismissed: "Finding is back in the list.",
	dismissedWhy: (reason: string) => `Dismissed: ${reason}`,
	resolvedNote: "No longer seen by Guard.",
};

export const Route = createFileRoute("/$workspace/findings")({
	validateSearch: FindingFilters,
	loaderDeps: ({ search }) => ({ filters: search }),
	loader: async ({ params, deps }) => {
		const page = await getFindings({ data: { slug: params.workspace, filters: deps.filters } });
		if (!page) throw notFound();
		return page;
	},
	component: FindingsPage,
	notFoundComponent: () => <Notice title={TEXT.missing}>{TEXT.missingHint}</Notice>,
});

const SEVERITY_STYLE: Record<FindingSeverity, string> = {
	critical: "bg-destructive text-destructive-foreground",
	high: "bg-destructive/15 text-destructive",
	moderate: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
	low: "bg-muted text-muted-foreground",
	unknown: "bg-muted text-muted-foreground",
};

function FindingsPage() {
	useDocumentTitle(TEXT.title);
	const page = Route.useLoaderData();
	const { slug } = useWorkspace();
	const filters = Route.useSearch();
	const navigate = Route.useNavigate();

	if (!page.hasConnections) {
		return (
			<div className="mx-auto max-w-4xl space-y-6 px-4 py-10 sm:px-6">
				<h1 className="text-xl font-semibold tracking-tight">{TEXT.title}</h1>
				<Notice
					title={TEXT.empty}
					action={
						<Button asChild variant="outline">
							<Link to="/$workspace/connections" params={{ workspace: slug }}>
								{TEXT.toConnections}
							</Link>
						</Button>
					}
				>
					{TEXT.hint}
				</Notice>
			</div>
		);
	}

	const status = filters.status ?? "open";
	const filtered = filters.severity !== undefined || filters.source !== undefined;
	return (
		<div className="mx-auto max-w-4xl space-y-6 px-4 py-10 sm:px-6">
			<h1 className="text-xl font-semibold tracking-tight">{TEXT.title}</h1>
			<form className="flex flex-wrap gap-4" aria-label={TEXT.filters}>
				<Filter
					label={TEXT.severity}
					value={filters.severity ?? ""}
					options={SEVERITIES.map((value) => [value, TEXT.severities[value]])}
					onChange={(value) =>
						navigate({
							search: (prev) => ({
								...prev,
								severity: (value || undefined) as FindingSeverity | undefined,
							}),
						})
					}
				/>
				<Filter
					label={TEXT.source}
					value={filters.source ?? ""}
					options={SOURCES.map((value) => [value, TEXT.sources[value]])}
					onChange={(value) =>
						navigate({
							search: (prev) => ({
								...prev,
								source: (value || undefined) as FindingSource | undefined,
							}),
						})
					}
				/>
				<Filter
					label={TEXT.status}
					value={status}
					options={STATUSES.map((value) => [value, TEXT.statuses[value]])}
					anyLabel={null}
					onChange={(value) =>
						navigate({ search: (prev) => ({ ...prev, status: value as FindingStatus }) })
					}
				/>
			</form>
			{page.findings.length === 0 ? (
				<Notice title={status === "open" && !filtered ? TEXT.noOpen : TEXT.noMatch}>
					{status === "open" && !filtered ? TEXT.noOpenHint : TEXT.noMatchHint}
				</Notice>
			) : (
				<>
					<p className="text-sm text-muted-foreground">
						{page.total > page.findings.length
							? TEXT.showing(formatNumber(page.findings.length), formatNumber(page.total))
							: TEXT.count(formatNumber(page.total))}
					</p>
					<ul className="divide-y rounded-lg border">
						{page.findings.map((finding) => (
							<FindingRow key={finding.id} finding={finding} />
						))}
					</ul>
				</>
			)}
		</div>
	);
}

function Filter({
	label,
	value,
	options,
	onChange,
	anyLabel = TEXT.any,
}: {
	label: string;
	value: string;
	options: (readonly [string, string])[];
	onChange: (value: string) => void;
	anyLabel?: string | null;
}) {
	const id = `filter-${label}`;
	return (
		<div className="space-y-1.5">
			<Label htmlFor={id}>{label}</Label>
			<select
				id={id}
				value={value}
				onChange={(event) => onChange(event.target.value)}
				className="flex h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
			>
				{anyLabel !== null && <option value="">{anyLabel}</option>}
				{options.map(([optionValue, optionLabel]) => (
					<option key={optionValue} value={optionValue}>
						{optionLabel}
					</option>
				))}
			</select>
		</div>
	);
}

/** Only an https address leaves the page: what scans stored is not trusted to be a link. */
function safeHref(url: string): string | null {
	try {
		return new URL(url).protocol === "https:" ? url : null;
	} catch {
		return null;
	}
}

function FindingRow({ finding }: { finding: FindingView }) {
	const { slug } = useWorkspace();
	const router = useRouter();
	const canManage = isAdminRole(useMyRole());
	const [dismissing, setDismissing] = useState(false);
	const href = safeHref(finding.url);

	async function undismiss() {
		const result = await changeFindings(slug, { action: "undismiss", id: finding.id });
		if (result.ok) toast.success(TEXT.undismissed);
		else toast.error(result.error);
		await router.invalidate();
	}

	return (
		<li className="space-y-2 p-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0 space-y-1">
					<div className="flex flex-wrap items-center gap-2">
						<span
							className={cn(
								"rounded px-1.5 py-0.5 text-xs font-medium",
								SEVERITY_STYLE[finding.severity],
							)}
						>
							{TEXT.severities[finding.severity]}
						</span>
						<p className="wrap-anywhere font-medium">{finding.title}</p>
					</div>
					<p className="wrap-anywhere text-sm text-muted-foreground">{finding.subject}</p>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					{href && (
						<Button asChild variant="outline" size="sm">
							<a href={href} target="_blank" rel="noreferrer noopener">
								{TEXT.openIn[finding.source]}
							</a>
						</Button>
					)}
					{canManage && finding.status !== "dismissed" && (
						<Button variant="outline" size="sm" onClick={() => setDismissing(true)}>
							{TEXT.dismiss}
						</Button>
					)}
					{canManage && finding.status === "dismissed" && (
						<LiveButton variant="outline" size="sm" onClick={undismiss}>
							{TEXT.undismiss}
						</LiveButton>
					)}
				</div>
			</div>
			<p className="text-xs text-muted-foreground">
				{TEXT.connection(finding.connectionName)} ·{" "}
				<span title={formatDateTime(finding.firstSeenAt)}>
					{TEXT.firstSeen(formatRelative(finding.firstSeenAt))}
				</span>
				{finding.source === "dependency" &&
					` · ${finding.fixedVersion ? TEXT.fixedIn(finding.fixedVersion) : TEXT.noFix}`}
				{finding.status === "resolved" && ` · ${TEXT.resolvedNote}`}
			</p>
			{finding.status === "dismissed" && finding.dismissReason && (
				<p className="wrap-anywhere text-sm text-muted-foreground">
					{TEXT.dismissedWhy(finding.dismissReason)}
				</p>
			)}
			{dismissing && <DismissDialog finding={finding} onClose={() => setDismissing(false)} />}
		</li>
	);
}

function DismissDialog({ finding, onClose }: { finding: FindingView; onClose: () => void }) {
	const { slug } = useWorkspace();
	const router = useRouter();
	const [reason, setReason] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submit(event: FormEvent) {
		event.preventDefault();
		setPending(true);
		setError(null);
		const result = await changeFindings(slug, { action: "dismiss", id: finding.id, reason });
		setPending(false);
		if (!result.ok) {
			setError(result.error);
			return;
		}
		toast.success(TEXT.dismissed);
		await router.invalidate();
		onClose();
	}

	return (
		<Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
			<DialogContent className="max-w-md">
				<form onSubmit={submit} className="space-y-4">
					<DialogHeader>
						<DialogTitle>{TEXT.dismissTitle}</DialogTitle>
						<DialogDescription>{TEXT.dismissBody}</DialogDescription>
					</DialogHeader>
					<p className="wrap-anywhere text-sm font-medium">{finding.title}</p>
					<div className="space-y-1.5">
						<Label htmlFor="dismiss-reason">{TEXT.reasonLabel}</Label>
						<Input
							id="dismiss-reason"
							value={reason}
							onChange={(event) => setReason(event.target.value)}
							maxLength={MAX_DISMISS_REASON}
							required
							autoComplete="off"
						/>
						<p className="text-xs text-muted-foreground">
							{TEXT.reasonHint(formatNumber(MAX_DISMISS_REASON))}
						</p>
					</div>
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<DialogFooter className="gap-2">
						<Button type="button" variant="outline" onClick={onClose} disabled={pending}>
							{TEXT.cancel}
						</Button>
						<LiveButton type="submit" disabled={pending}>
							{TEXT.dismiss}
						</LiveButton>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
