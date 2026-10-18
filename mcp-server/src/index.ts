import { OAuthError, OAuthProvider, type TokenExchangeCallbackOptions } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { authHandler, type Env, MCP_SCOPE, type Props, stravaConfig } from "./auth-handler";
import { refreshTokens, StravaClient, StravaError } from "./strava";
import { registerTools } from "./tools";

const VERSION = "0.1.0";

// Strava access tokens last 6 hours. Each MCP access token is issued to expire shortly before the
// Strava token inside it, so the client refreshes in time and we refresh Strava alongside it.
const EXPIRY_MARGIN_SECONDS = 300;
const MAX_ACCESS_TOKEN_TTL = 3600;

function ttlFor(expiresAt: number) {
	const remaining = expiresAt - Math.floor(Date.now() / 1000) - EXPIRY_MARGIN_SECONDS;
	return Math.max(60, Math.min(MAX_ACCESS_TOKEN_TTL, remaining));
}

async function tokenExchangeCallback({ grantType, props, env }: TokenExchangeCallbackOptions<Env>) {
	const p = props as Props;
	if (grantType === "authorization_code") return { accessTokenTTL: ttlFor(p.expiresAt) };
	if (grantType !== "refresh_token") return;

	try {
		const { accessToken, refreshToken, expiresAt } = await refreshTokens(stravaConfig(env), p.refreshToken);
		const newProps: Props = { ...p, accessToken, refreshToken, expiresAt };
		return { newProps, accessTokenTTL: ttlFor(expiresAt) };
	} catch (error) {
		if (error instanceof StravaError && (error.status === 400 || error.status === 401)) {
			throw new OAuthError("invalid_grant", { description: "Strava access was revoked; reconnect the connector" });
		}
		throw new OAuthError("temporarily_unavailable", { description: "Strava is unavailable", statusCode: 503 });
	}
}

function createServer(env: Env) {
	const server = new McpServer(
		{ name: "strava", title: "Strava", version: VERSION },
		{
			instructions:
				"Read-only access to the user's own Strava account. Distances are in km, elevation in m, durations as h:mm:ss. Use list_activities with after/before dates to answer questions about a period, then get_activity for detail.",
		},
	);
	const props = getMcpAuthContext()?.props as Props | undefined;
	if (!props) throw new Error("Missing auth context");
	registerTools(server, () => new StravaClient(stravaConfig(env), props.accessToken), props.athleteId);
	return server;
}

const mcpApiHandler: ExportedHandler<Env> = {
	fetch(request, env, ctx) {
		return createMcpHandler(() => createServer(env), { route: "/mcp" })(request, env, ctx);
	},
};

// The OAuth resource identifier must be this Worker's public URL, which is only known per request,
// so build one provider per origin and reuse it.
const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string) {
	let provider = providers.get(origin);
	if (!provider) {
		provider = new OAuthProvider<Env>({
			apiRoute: "/mcp",
			apiHandler: mcpApiHandler as any,
			defaultHandler: authHandler as any,
			authorizeEndpoint: "/authorize",
			tokenEndpoint: "/token",
			clientRegistrationEndpoint: "/register",
			clientIdMetadataDocumentEnabled: true,
			scopesSupported: [MCP_SCOPE],
			resourceMetadata: { resource: `${origin}/mcp`, resource_name: "Strava" },
			refreshTokenTTL: 60 * 60 * 24 * 90,
			tokenExchangeCallback,
		});
		providers.set(origin, provider);
	}
	return provider;
}

export default {
	fetch(request, env, ctx) {
		return providerFor(new URL(request.url).origin).fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
