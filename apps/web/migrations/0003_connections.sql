CREATE TABLE `connection` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`kind` text NOT NULL,
	`target` text NOT NULL,
	`github_repository_id` integer,
	`name` text NOT NULL,
	`token_sealed` text NOT NULL,
	`token_hint` text NOT NULL,
	`added_by` text NOT NULL,
	`added_at` integer NOT NULL,
	`last_scan_at` integer,
	`last_scan_outcome` text,
	`next_scan_at` integer NOT NULL,
	`scan_started_at` integer,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "connection_kind" CHECK("connection"."kind" IN ('cloudflare', 'github')),
	CONSTRAINT "connection_repository_id" CHECK(("connection"."kind" = 'github') = ("connection"."github_repository_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connection_target_unique` ON `connection` (`organization_id`,`kind`,`target`);--> statement-breakpoint
CREATE UNIQUE INDEX `connection_repository_unique` ON `connection` (`organization_id`,`github_repository_id`);--> statement-breakpoint
CREATE INDEX `connection_next_scan_idx` ON `connection` (`next_scan_at`);--> statement-breakpoint
CREATE TABLE `finding` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`source` text NOT NULL,
	`severity` text NOT NULL,
	`kind` text NOT NULL,
	`subject` text NOT NULL,
	`title` text NOT NULL,
	`url` text NOT NULL,
	`fixed_version` text,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`resolved_at` integer,
	`dismissed_at` integer,
	`dismissed_by` text,
	`dismiss_reason` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `connection`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "finding_source" CHECK("finding"."source" IN ('cloudflare', 'dependency')),
	CONSTRAINT "finding_severity" CHECK("finding"."severity" IN ('critical', 'high', 'moderate', 'low', 'unknown')),
	CONSTRAINT "finding_dismiss_reason" CHECK("finding"."dismiss_reason" IS NULL OR length("finding"."dismiss_reason") <= 200)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `finding_fingerprint_unique` ON `finding` (`organization_id`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `finding_connection_idx` ON `finding` (`connection_id`);--> statement-breakpoint
CREATE INDEX `finding_open_idx` ON `finding` (`organization_id`,`resolved_at`);--> statement-breakpoint
CREATE TABLE `scan` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer NOT NULL,
	`outcome` text NOT NULL,
	`found` integer DEFAULT 0 NOT NULL,
	`new` integer DEFAULT 0 NOT NULL,
	`resolved` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connection`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scan_connection_idx` ON `scan` (`connection_id`,`started_at`);