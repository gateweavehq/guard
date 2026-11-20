CREATE TABLE `track_connect` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`user_id` text NOT NULL,
	`address` text NOT NULL,
	`name` text NOT NULL,
	`verifier_sealed` text,
	`undo_sealed` text,
	`undo_until` integer,
	`issued_digest` text,
	`last_tried_at` integer,
	`undo_attempts` integer DEFAULT 0 NOT NULL,
	`undo_status` integer,
	`superseded` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `track_connect_connection` ON `track_connect` (`connection_id`);--> statement-breakpoint
CREATE INDEX `track_connect_expiry` ON `track_connect` (`expires_at`);--> statement-breakpoint
CREATE TABLE `secrets_primary` (
	`key_id` text PRIMARY KEY NOT NULL,
	`first_seen` integer NOT NULL
);
