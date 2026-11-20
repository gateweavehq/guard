CREATE TABLE `track_source` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`key_sealed` text NOT NULL,
	`key_hint` text NOT NULL,
	`key_digest` text NOT NULL,
	`generation` text NOT NULL,
	`guard_origin` text NOT NULL,
	`last_answer` text,
	`answered_at` integer,
	`first_missing_at` integer,
	`stopped` integer DEFAULT 0 NOT NULL,
	`retry_at` integer,
	`calls` text DEFAULT '[]' NOT NULL,
	`lease` text,
	`lease_until` integer,
	FOREIGN KEY (`connection_id`) REFERENCES `connection`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `track_source_key_digest_unique` ON `track_source` (`key_digest`);--> statement-breakpoint
ALTER TABLE `finding` ADD `source_state` text;--> statement-breakpoint
ALTER TABLE `finding` ADD `source_severity` text;--> statement-breakpoint
ALTER TABLE `finding` ADD `source_rejected` text;--> statement-breakpoint
ALTER TABLE `finding` ADD `source_unconfirmed` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `finding` ADD `source_attempt_at` integer;--> statement-breakpoint
ALTER TABLE `finding` ADD `source_changed_at` integer;--> statement-breakpoint
ALTER TABLE `track_integration` ADD `source_mode` integer DEFAULT 0 NOT NULL;