---

name: schema-change
description: Change the D1 database schema in Gateweave Guard with a proper migration - users, sessions, workspaces, members and invitations (via Better Auth), and the owner triggers. Use when adding or altering tables, columns, indexes or triggers.
---

# Change a schema

Guard has one database today, D1. Its tables are Better Auth's: users, sessions, accounts,
verifications, workspaces (organizations), members and invitations, and the deployment's own:
`deployment`, `sign_up_allow` and `sign_up_pass` (`db/deployment-schema.ts`). The schema of
Better Auth's tables is generated from its configuration, so don't edit
`apps/web/src/server/db/auth-schema.ts` by hand.

Migrations are append-only. Never edit or delete a migration that has been merged; write a new
one that moves the schema forward. When another branch's migration lands first, regenerate yours
after it rather than renaming it.

Guard's own tables are ordinary Drizzle tables, in `apps/web/src/server/db/`, exported from
`schema.ts`. Traffic data is stored as aggregates only, so a table for it never has a column for an
address, a user agent or a path.

## Steps

1. Change the Better Auth configuration (`apps/web/src/server/auth/config.ts`), for example a
   plugin or `additionalFields`, or add a table file under `apps/web/src/server/db/`.
2. Regenerate the Drizzle schema for Better Auth's tables, then the migration:

   ```sh
   pnpm --filter @gateweave/guard-web auth:schema
   pnpm --filter @gateweave/guard-web db:generate
   ```

   Drizzle Kit also runs directly, from `apps/web`:
   `node node_modules/drizzle-kit/bin.cjs generate`.
3. For what Drizzle cannot express, such as a trigger, make a custom migration and write the SQL
   in it: `drizzle-kit generate --custom --name what_it_does`. `0001_owner_triggers.sql` and `0002_sign_up_hold.sql` are.
4. Read the SQL in `apps/web/migrations/`, then apply it locally and run the app:

   ```sh
   pnpm --filter @gateweave/guard-web db:migrate:local
   ```

5. Deploys apply D1 migrations before the new code goes live (`apps/web/scripts/deploy.mjs`), for
   Gateweave's staging and production and for self-hosters alike. Old code still runs against the new schema until
   the deploy finishes, so say in the pull request whether it can.

`drizzle-orm` stays on 0.45: the 1.0 migration format does not work with Wrangler's D1
migrations.

## Verify

```sh
pnpm verify
```

The Worker tests apply every migration in `apps/web/migrations/` to a fresh database, so one
that fails on an empty schema fails there.
