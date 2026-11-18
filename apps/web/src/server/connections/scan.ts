import {
	type FetchOptions,
	listInsights,
	parseRepositoryName,
	scanRepository,
	UpstreamError,
	type UpstreamFailure,
} from "@gateweave/guard-scan";
import type { Database } from "../db";
import { KEPT_SCANS } from "../db/connections-schema";
import { raisedAtFor } from "../notifications/rules";
import { isSealer, sealerFor } from "../secrets";
import type { SecretsKeySettings } from "../secrets-key";
import { dependencyFindings, insightFindings, type PresentFinding } from "./findings";
import { type ProtectionRead, readConnectionProtection, unstoredProtection } from "./protection";
import { tokenPlace } from "./tokens";
import { readConnectionTraffic, type TrafficRead, unstored } from "./traffic";

/** What a scan needs of the Worker's settings. */
export interface ScanSettings extends SecretsKeySettings {
	/** Where Cloudflare, GitHub and OSV are reached when it is not at their own hosts. */
	CLOUDFLARE_API_URL?: string | undefined;
	GITHUB_API_URL?: string | undefined;
	OSV_API_URL?: string | undefined;
}

export interface ScanDeps {
	db: Database;
	settings: ScanSettings;
}

export type ScanOutcome = "ok" | UpstreamFailure | "unreadable";

/** What a scan did, as the page that asked for it shows it. */
export interface ScanResult {
	outcome: ScanOutcome;
	found: number;
	added: number;
	resolved: number;
}

/**
 * What came of asking for a scan. `held` is a connection nothing was read from: another scan has
 * it, it is gone, or it is not due for the hourly run. `unrecorded` is a scan that ran and whose
 * result could not be written, which is not the same thing to whoever asked.
 */
export type ScanRun =
	| { state: "recorded"; result: ScanResult }
	| { state: "held" }
	| { state: "unrecorded" };

/**
 * What a connection's `last_scan_outcome` says after a scan that could not be written. No row of
 * `scan` has it: the row is part of what was not written.
 */
export const UNRECORDED = "unrecorded";

const HOUR = 60 * 60 * 1000;
/** A connection is scanned this often. */
export const SCAN_EVERY_MS = 24 * HOUR;
/** After a failure that passes with time, such as a spent rate limit, the next try comes sooner. */
export const RETRY_AFTER_FAILURE_MS = HOUR;
/** A scan that has not finished in this long is taken to have died, and may be started again. */
export const SCAN_LEASE_MS = 10 * 60 * 1000;
/** How many connections one run of the hourly trigger scans, at most. */
export const SCANS_PER_RUN = 10;
/** Findings written by one statement, which D1 binds as one JSON value. */
const FINDINGS_PER_STATEMENT = 100;
const IDS_PER_STATEMENT = 500;

function fetchOptions(settings: ScanSettings): FetchOptions {
	return {
		apiUrls: {
			...(settings.CLOUDFLARE_API_URL ? { cloudflare: settings.CLOUDFLARE_API_URL } : {}),
			...(settings.GITHUB_API_URL ? { github: settings.GITHUB_API_URL } : {}),
			...(settings.OSV_API_URL ? { osv: settings.OSV_API_URL } : {}),
		},
	};
}

/** Options for a call to an upstream, from the Worker's settings. */
export const upstreamOptions = fetchOptions;

interface Claimed {
	id: string;
	organization_id: string;
	kind: "cloudflare" | "github";
	target: string;
	token_sealed: string;
}

/**
 * Takes a connection to scan it, or says someone else has. A conditional UPDATE does it, so that
 * two isolates asking at once cannot both win: it sets `scan_started_at`, which a scan that
 * finishes (or one that dies, after `SCAN_LEASE_MS`) lets go of. The hourly run takes only what is
 * due; "Scan now" takes a connection whenever nobody is scanning it.
 */
async function claim(db: Database, id: string, now: number, onlyDue: boolean) {
	return db.$client
		.prepare(
			`UPDATE connection SET scan_started_at = ?1
			WHERE id = ?2
				AND (scan_started_at IS NULL OR scan_started_at < ?3)
				AND (?4 = 0 OR next_scan_at <= ?1)
			RETURNING id, organization_id, kind, target, token_sealed`,
		)
		.bind(now, id, now - SCAN_LEASE_MS, onlyDue ? 1 : 0)
		.first<Claimed>();
}

interface Seen {
	findings: PresentFinding[];
	unjudged: string[];
	partial: boolean;
	/** Fingerprint prefixes of findings this scan could not judge, which stay as they are. */
	held: string[];
	/** What the traffic read did, for a Cloudflare connection. */
	traffic: TrafficRead | null;
	/** What the protection read did, for a Cloudflare connection. */
	protection: ProtectionRead | null;
}

/** Reads what the connection can see, and returns what is wrong there now. */
async function read(
	deps: ScanDeps,
	connection: Claimed,
	token: string,
	now: number,
): Promise<Seen> {
	const options = fetchOptions(deps.settings);
	if (connection.kind === "cloudflare") {
		const insights = await listInsights({ accountId: connection.target, token }, options);
		const findings = await insightFindings(connection.target, insights);
		// Traffic comes after Insights and never fails them: a token without Analytics › Read still
		// has its insights scanned, and says what it lacks.
		let traffic: TrafficRead;
		try {
			traffic = await readConnectionTraffic(deps.db, connection, token, options, now);
		} catch (error) {
			console.error(`scan: traffic ${error instanceof Error ? error.name : "failure"}`);
			traffic = unstored(connection);
		}
		// Protection comes after Traffic, on the zones it listed, and never fails the rest: a token
		// without the optional WAF, bot and settings permissions says so, zone by zone.
		let protection: ProtectionRead;
		try {
			protection = await readConnectionProtection(
				deps.db,
				connection,
				token,
				options,
				traffic.zones,
			);
		} catch (error) {
			console.error(`scan: protection ${error instanceof Error ? error.name : "failure"}`);
			protection = unstoredProtection();
		}
		return { findings, unjudged: [], partial: false, held: [], traffic, protection };
	}
	const name = parseRepositoryName(connection.target);
	if (!name) throw new UpstreamError("github", "not_found", "That is not a repository name");
	const scanned = await dependencyFindings(await scanRepository(name, token, options));
	return { ...scanned, held: [], traffic: null, protection: null };
}

/** The failure to record for something that went wrong. Never carries a message: tokens are near. */
function outcomeOf(error: unknown): UpstreamFailure {
	if (error instanceof UpstreamError) return error.failure;
	// A bug here, not the upstream's doing. Only the kind of error is logged.
	console.error(`scan: unexpected ${error instanceof Error ? error.name : "failure"}`);
	return "invalid_response";
}

/**
 * When to scan a connection again after a scan with this outcome. A traffic read that failed in a
 * way that passes with time brings the next scan forward too: the days it read are stored, so the
 * second try is cheap.
 */
function nextScanAfter(outcome: ScanOutcome, now: number, trafficRetry = false): number {
	return (
		now +
		(outcome === "rate_limited" || outcome === "unavailable" || trafficRetry
			? RETRY_AFTER_FAILURE_MS
			: SCAN_EVERY_MS)
	);
}

interface Known {
	id: string;
	fingerprint: string;
	resolved_at: number | null;
	raised_at: number;
	subject: string;
}

/**
 * Scans one connection and records what it found, or why it could not. It is `held` when another
 * scan holds the connection (or the connection is gone, or not due for the hourly run).
 *
 * A scan that fails changes no findings, and says on the connection what failed. A scan that
 * succeeds writes every change in one D1 batch: findings seen are added, updated and reopened,
 * findings no longer seen are resolved, and a finding an admin dismissed stays dismissed.
 *
 * A scan whose batch fails is `unrecorded`. The connection is then told so in one small statement
 * of its own, and waits: an hour the first time, since most failures of D1 pass, and a day once
 * the scan before it went the same way. Left due, such a connection was read every hour for
 * nothing, and came first in every hourly run, ahead of the ones that could be scanned.
 */
export async function runScan(
	deps: ScanDeps,
	connectionId: string,
	{ onlyDue = false, now = Date.now() }: { onlyDue?: boolean; now?: number } = {},
): Promise<ScanRun> {
	const { db } = deps;
	const connection = await claim(db, connectionId, now, onlyDue);
	if (!connection) return { state: "held" };

	let seen: Seen | null = null;
	let failure: ScanOutcome | null = null;
	try {
		const sealer = await sealerFor(deps.settings, connection.organization_id);
		let token: string | null = null;
		if (isSealer(sealer)) {
			try {
				token = await sealer.open(tokenPlace(connection.id), connection.token_sealed);
			} catch {
				token = null;
			}
		}
		if (token === null) failure = "unreadable";
		else seen = await read(deps, connection, token, now);
	} catch (error) {
		failure = outcomeOf(error);
	}

	try {
		if (seen === null) {
			const result = await record(db, connection, now, {
				outcome: failure ?? "invalid_response",
				found: 0,
				added: 0,
				resolved: 0,
			});
			return { state: "recorded", result };
		}
		const result = await apply(
			db,
			connection,
			await withProtection(db, await withTraffic(db, connection, seen)),
			now,
		);
		return { state: "recorded", result };
	} catch (error) {
		// The connection may have been removed while this scan ran, or D1 failed. Either way
		// nothing was written, since each is one batch.
		console.error(`scan: could not record ${error instanceof Error ? error.name : "failure"}`);
		// If this fails as well, the connection stays taken until the lease runs out and is due
		// after it, as before: there is nowhere left to say so.
		await db.$client
			.prepare(
				`UPDATE connection SET scan_started_at = NULL, last_scan_at = ?1,
					next_scan_at = ?1 + CASE WHEN last_scan_outcome = ?2 THEN ?3 ELSE ?4 END,
					last_scan_outcome = ?2
				WHERE id = ?5`,
			)
			.bind(Date.now(), UNRECORDED, SCAN_EVERY_MS, RETRY_AFTER_FAILURE_MS, connection.id)
			.run()
			.catch(() => undefined);
		return { state: "unrecorded" };
	}
}

const insertScan = (db: Database, connectionId: string, startedAt: number, result: ScanResult) => [
	db.$client
		.prepare(
			`INSERT INTO scan (id, connection_id, started_at, finished_at, outcome, found, new, resolved)
			VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
		)
		.bind(
			crypto.randomUUID(),
			connectionId,
			startedAt,
			Date.now(),
			result.outcome,
			result.found,
			result.added,
			result.resolved,
		),
	db.$client
		.prepare(
			`DELETE FROM scan WHERE connection_id = ?1 AND id NOT IN (
				SELECT id FROM scan WHERE connection_id = ?1 ORDER BY started_at DESC, id DESC LIMIT ?2
			)`,
		)
		.bind(connectionId, KEPT_SCANS),
];

/** A scan that failed: no finding changes, the connection says what failed. */
async function record(
	db: Database,
	connection: Claimed,
	startedAt: number,
	result: ScanResult,
): Promise<ScanResult> {
	const finished = Date.now();
	await db.$client.batch([
		db.$client
			.prepare(
				`UPDATE connection SET last_scan_at = ?1, last_scan_outcome = ?2, next_scan_at = ?3,
					scan_started_at = NULL WHERE id = ?4`,
			)
			.bind(finished, result.outcome, nextScanAfter(result.outcome, finished), connection.id),
		...insertScan(db, connection.id, startedAt, result),
	]);
	return result;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let start = 0; start < items.length; start += size)
		out.push(items.slice(start, start + size));
	return out;
}

/**
 * Stores what the traffic read found, in a batch of its own: a traffic write that fails must not
 * keep the insights from being recorded. If it does fail, nothing of the traffic is judged, and
 * the findings it made stay as they are until a scan can store it.
 */
async function withTraffic(db: Database, connection: Claimed, seen: Seen): Promise<Seen> {
	let traffic = seen.traffic;
	if (traffic && traffic.statements.length > 0) {
		try {
			await db.$client.batch(traffic.statements);
		} catch (error) {
			console.error(
				`scan: could not store traffic ${error instanceof Error ? error.name : "failure"}`,
			);
			traffic = unstored(connection);
		}
	}
	if (!traffic) return seen;
	return {
		...seen,
		findings: [...seen.findings, ...traffic.findings],
		held: [...seen.held, ...traffic.held],
		traffic,
	};
}

/**
 * Stores what the protection read found, in a batch of its own as the traffic is: a write that
 * fails must not keep the insights from being recorded.
 */
async function withProtection(db: Database, seen: Seen): Promise<Seen> {
	let protection = seen.protection;
	if (protection && protection.statements.length > 0) {
		try {
			await db.$client.batch(protection.statements);
		} catch (error) {
			console.error(
				`scan: could not store protection ${error instanceof Error ? error.name : "failure"}`,
			);
			protection = unstoredProtection();
		}
	}
	if (!protection) return seen;
	return { ...seen, protection };
}

async function apply(
	db: Database,
	connection: Claimed,
	seen: Seen,
	startedAt: number,
): Promise<ScanResult> {
	const { results: known } = await db.$client
		.prepare(
			"SELECT id, fingerprint, resolved_at, raised_at, subject FROM finding WHERE connection_id = ?1",
		)
		.bind(connection.id)
		.all<Known>();
	// A connection's first good scan finds what was already there, which is no alert: those findings
	// count as told. They still show as New to members, who have not seen them.
	const baseline =
		(await db.$client
			.prepare("SELECT 1 AS one FROM scan WHERE connection_id = ?1 AND outcome = 'ok' LIMIT 1")
			.bind(connection.id)
			.first()) === null;
	const knownBy = new Map(known.map((row) => [row.fingerprint, row]));
	const present = new Set(seen.findings.map((found) => found.fingerprint));
	const before = new Set(known.map((row) => row.fingerprint));
	const added = seen.findings.filter((found) => !before.has(found.fingerprint)).length;
	// What this scan could not see is not gone: a lockfile it could not read, or part of a
	// repository GitHub did not list.
	const unseen = (row: Known) =>
		seen.partial ||
		seen.unjudged.some((path) => row.subject.endsWith(` in ${path}`)) ||
		seen.held.some((prefix) => row.fingerprint.startsWith(prefix));
	const gone = known.filter(
		(row) => row.resolved_at === null && !present.has(row.fingerprint) && !unseen(row),
	);

	const finished = Date.now();
	const result: ScanResult = {
		outcome: "ok",
		found: seen.findings.length,
		added,
		resolved: gone.length,
	};
	const upsert = db.$client.prepare(
		`INSERT INTO finding (id, organization_id, connection_id, fingerprint, source, severity, kind,
			subject, title, url, fixed_version, first_seen_at, last_seen_at, raised_at, notified_at)
		SELECT json_extract(value, '$.id'), ?1, ?2, json_extract(value, '$.fingerprint'),
			json_extract(value, '$.source'), json_extract(value, '$.severity'), json_extract(value, '$.kind'),
			json_extract(value, '$.subject'), json_extract(value, '$.title'), json_extract(value, '$.url'),
			json_extract(value, '$.fixedVersion'), ?3, ?3, json_extract(value, '$.raisedAt'), ?5
		FROM json_each(?4) WHERE true
		ON CONFLICT (organization_id, fingerprint) DO UPDATE SET
			severity = excluded.severity, kind = excluded.kind, subject = excluded.subject,
			title = excluded.title, url = excluded.url, fixed_version = excluded.fixed_version,
			last_seen_at = excluded.last_seen_at, raised_at = excluded.raised_at, resolved_at = NULL
		WHERE finding.connection_id = excluded.connection_id`,
	);
	const resolve = db.$client.prepare(
		`UPDATE finding SET resolved_at = ?1
		WHERE connection_id = ?2 AND resolved_at IS NULL AND id IN (SELECT value FROM json_each(?3))`,
	);
	await db.$client.batch([
		...chunks(seen.findings, FINDINGS_PER_STATEMENT).map((chunk) =>
			upsert.bind(
				connection.organization_id,
				connection.id,
				finished,
				JSON.stringify(
					chunk.map((found) => {
						const row = knownBy.get(found.fingerprint);
						return {
							id: crypto.randomUUID(),
							...found,
							raisedAt: raisedAtFor(
								row && { raisedAt: row.raised_at, resolvedAt: row.resolved_at },
								finished,
							),
						};
					}),
				),
				baseline ? finished : null,
			),
		),
		...chunks(
			gone.map((row) => row.id),
			IDS_PER_STATEMENT,
		).map((ids) => resolve.bind(finished, connection.id, JSON.stringify(ids))),
		db.$client
			.prepare(
				`UPDATE connection SET last_scan_at = ?1, last_scan_outcome = 'ok', next_scan_at = ?2,
					scan_started_at = NULL, traffic_outcome = ?3 WHERE id = ?4`,
			)
			.bind(
				finished,
				nextScanAfter(
					"ok",
					finished,
					(seen.traffic?.retry ?? false) || (seen.protection?.retry ?? false),
				),
				seen.traffic?.outcome ?? null,
				connection.id,
			),
		...insertScan(db, connection.id, startedAt, result),
	]);
	return result;
}

/**
 * The hourly run: scans the connections whose time has come, oldest first, at most
 * `SCANS_PER_RUN`, one after another. The rest wait for the next hour. A connection another scan
 * holds is left to it.
 */
export async function scanDue(
	deps: ScanDeps,
	now = Date.now(),
): Promise<{ scanned: number; failed: number }> {
	const { results } = await deps.db.$client
		.prepare(
			`SELECT id FROM connection
			WHERE next_scan_at <= ?1 AND (scan_started_at IS NULL OR scan_started_at < ?2)
			ORDER BY next_scan_at, id LIMIT ?3`,
		)
		.bind(now, now - SCAN_LEASE_MS, SCANS_PER_RUN)
		.all<{ id: string }>();
	let scanned = 0;
	let failed = 0;
	for (const { id } of results) {
		const run = await runScan(deps, id, { onlyDue: true, now });
		if (run.state !== "recorded") continue;
		scanned++;
		if (run.result.outcome !== "ok") failed++;
	}
	return { scanned, failed };
}
