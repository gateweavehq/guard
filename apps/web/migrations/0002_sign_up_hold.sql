-- Custom SQL migration: "Who owns a deployment" in docs/architecture.md.
--
-- Ported from Gateweave Agents, where these arrived in four steps (0006 to 0009); this is where they
-- end up. A new deployment has no accounts and no owner yet: its first account becomes it, and sign-up
-- starts open, so nobody finds it closed before its owner has chosen.
INSERT INTO `deployment` (`id`, `owner_id`, `sign_up`, `trust_provider`, `updated_at`)
VALUES (1, NULL, 'open', 0, cast(unixepoch('subsecond') * 1000 as integer));--> statement-breakpoint
-- However an account comes to be made, while sign-up is closed it needs a way in: the owner's list (the
-- address, or its domain, which is the part from the last `@`), or a pending invitation to a workspace.
-- `auth/deployment.ts` asks the same first, to say so in words; this is what holds if a path that makes
-- accounts ever forgets to ask. A missing row counts as closed.
--
-- Whether an account comes from the sign-in provider is not known until its sign-in is linked, which is
-- after this row is written. So the hook that knows writes a pass for its address (`sign_up_pass`, a
-- minute long), and where the owner trusts the provider the trigger lets an insert through only while
-- one is there. Expired passes count as none.
CREATE TRIGGER `user_needs_a_way_in`
BEFORE INSERT ON `user`
WHEN COALESCE((SELECT `sign_up` FROM `deployment` WHERE `id` = 1), 'closed') <> 'open'
	AND EXISTS (SELECT 1 FROM `user`)
	AND NOT EXISTS (
		SELECT 1 FROM `sign_up_allow`
		WHERE `entry` = lower(new.`email`)
			OR `entry` = substr(lower(new.`email`), length(rtrim(lower(new.`email`), replace(lower(new.`email`), '@', ''))))
	)
	AND NOT EXISTS (
		SELECT 1 FROM `invitation`
		WHERE `email` = lower(new.`email`)
			AND `status` = 'pending'
			AND `expires_at` > cast(unixepoch('subsecond') * 1000 as integer)
	)
	AND NOT (
		COALESCE((SELECT `trust_provider` FROM `deployment` WHERE `id` = 1), 0) = 1
		AND EXISTS (
			SELECT 1 FROM `sign_up_pass`
			WHERE `email` = lower(new.`email`)
				AND `expires_at` > cast(unixepoch('subsecond') * 1000 as integer)
		)
	)
BEGIN
	SELECT RAISE(ABORT, 'sign-up is closed here');
END;--> statement-breakpoint
-- Whoever gets there first owns the deployment, and D1 runs writes one at a time, so there is only
-- ever one.
CREATE TRIGGER `first_account_owns_deployment`
AFTER INSERT ON `user`
WHEN (SELECT `owner_id` FROM `deployment` WHERE `id` = 1) IS NULL
	AND NOT EXISTS (SELECT 1 FROM `user` WHERE `id` <> new.`id`)
BEGIN
	UPDATE `deployment`
	SET `owner_id` = new.`id`, `updated_at` = cast(unixepoch('subsecond') * 1000 as integer)
	WHERE `id` = 1;
END;--> statement-breakpoint
-- The owner's row going would empty `deployment.owner_id`, and on a closed deployment that leaves
-- nobody able to open sign-up or change the list, short of SQL. So while sign-up is closed their
-- account stays, however a request comes to try.
CREATE TRIGGER `deployment_keeps_its_owner`
BEFORE DELETE ON `user`
WHEN old.`id` = (SELECT `owner_id` FROM `deployment` WHERE `id` = 1)
	AND (SELECT `sign_up` FROM `deployment` WHERE `id` = 1) <> 'open'
BEGIN
	SELECT RAISE(ABORT, 'a server must keep its owner');
END;--> statement-breakpoint
-- While sign-up is open, the owner's account may go, and ownership passes to the earliest account left
-- (`created_at`, then `id`), or to nobody if there is none, when `first_account_owns_deployment` gives
-- it to the next account. This runs before the row goes, so the foreign key that would empty
-- `owner_id` finds nothing to do.
CREATE TRIGGER `deployment_hands_over_its_owner`
BEFORE DELETE ON `user`
WHEN old.`id` = (SELECT `owner_id` FROM `deployment` WHERE `id` = 1)
	AND (SELECT `sign_up` FROM `deployment` WHERE `id` = 1) = 'open'
BEGIN
	UPDATE `deployment`
	SET `owner_id` = (SELECT `id` FROM `user` WHERE `id` <> old.`id` ORDER BY `created_at`, `id` LIMIT 1),
		`updated_at` = cast(unixepoch('subsecond') * 1000 as integer)
	WHERE `id` = 1;
END;--> statement-breakpoint
-- The list is for people the owner knows by name, and a cap keeps what the page lists and searches
-- small. The page asks first, to say so in words; this holds when two adds arrive together.
CREATE TRIGGER `sign_up_allow_is_capped`
BEFORE INSERT ON `sign_up_allow`
WHEN (SELECT count(*) FROM `sign_up_allow`) >= 5000
BEGIN
	SELECT RAISE(ABORT, 'the sign-up list is full');
END;
