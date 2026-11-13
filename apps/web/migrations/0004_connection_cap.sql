-- Custom SQL migration: "Connections" in docs/architecture.md.
--
-- A workspace may have at most 50 connections. The server function that connects one says so in
-- words; this is what holds if a path forgets to ask, or two admins connect at the same moment and
-- each counts 49. D1 runs writes one at a time, so the count here is the true one.
CREATE TRIGGER `connection_is_capped`
BEFORE INSERT ON `connection`
WHEN (SELECT count(*) FROM `connection` WHERE `organization_id` = new.`organization_id`) >= 50
BEGIN
	SELECT RAISE(ABORT, 'a workspace may have at most 50 connections');
END;
