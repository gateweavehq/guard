import { createFileRoute } from "@tanstack/react-router";
import { FindingFilters } from "#/lib/connection-schemas";

export const Route = createFileRoute("/api/findings/$workspace")({
	server: {
		handlers: {
			GET: async ({ request, params }) => {
				const { readFindings } = await import("#/server/connections/findings-gateway");
				const query = Object.fromEntries(new URL(request.url).searchParams);
				return readFindings(params.workspace, FindingFilters.parse(query));
			},
			POST: async ({ request, params }) => {
				const { changeFindings } = await import("#/server/connections/findings-gateway");
				return changeFindings(request, params.workspace);
			},
		},
	},
});
