import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/assistants")({
	server: {
		handlers: {
			GET: async () => {
				const { readGrants } = await import("#/server/mcp/grants-gateway");
				return readGrants();
			},
			POST: async ({ request }) => {
				const { takeBackFromRequest } = await import("#/server/mcp/grants-gateway");
				return takeBackFromRequest(request);
			},
		},
	},
});
