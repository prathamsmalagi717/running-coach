// Handles everything outside /mcp: the consent page, the hand-off to Strava's login, and Strava's callback.
// The OAuth helpers (consent binding, state, PKCE for MCP clients) come from @cloudflare/workers-oauth-provider.

import {
	AuthorizationError,
	type AuthRequest,
	authorizationErrorRedirect,
	CimdFetchError,
	type ConsentDescription,
	type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { authorizeUrl, exchangeCode, type StravaConfig } from "./strava";

export interface Env {
	OAUTH_KV: KVNamespace;
	STRAVA_CLIENT_ID: string;
	STRAVA_CLIENT_SECRET: string;
	/** Optional comma-separated Strava athlete ids allowed to connect. Empty means anyone who can log in. */
	ALLOWED_ATHLETE_IDS?: string;
	/** Test-only overrides; leave unset in production. */
	STRAVA_OAUTH_BASE?: string;
	STRAVA_API_BASE?: string;
}

/** What gets encrypted into each MCP token and handed to the tools. */
export interface Props {
	athleteId: number;
	athleteName: string;
	stravaScope: string;
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	[key: string]: unknown;
}

export const stravaConfig = (env: Env): StravaConfig => ({
	clientId: env.STRAVA_CLIENT_ID,
	clientSecret: env.STRAVA_CLIENT_SECRET,
	oauthBase: env.STRAVA_OAUTH_BASE,
	apiBase: env.STRAVA_API_BASE,
});

export const MCP_SCOPE = "strava:read";

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function page(title: string, body: string, status = 200, headers = new Headers()) {
	headers.set("Content-Type", "text/html; charset=utf-8");
	return new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#fafafa;--fg:#1d1d1f;--muted:#6e6e73;--card:#fff;--line:#e5e5ea;--accent:#fc4c02}
@media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#f5f5f7;--muted:#a1a1a6;--card:#1c1c1e;--line:#2c2c2e}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
main{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px 24px;max-width:420px;width:100%}
h1{font-size:1.3rem;margin:0 0 12px}p{margin:0 0 12px}.muted{color:var(--muted);font-size:.9rem}
.warn{background:#fc4c0218;border-left:3px solid var(--accent);padding:8px 12px;border-radius:6px}
.row{display:flex;gap:12px;margin-top:20px}button{flex:1;font:inherit;font-weight:600;padding:12px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
</style></head><body><main>${body}</main></body></html>`,
		{ status, headers },
	);
}

function consentPage(details: ConsentDescription, handle: string) {
	const name = escape(details.clientName);
	const origin = details.clientDomain
		? `Published by <strong>${escape(details.clientDomain)}</strong>.`
		: "This app registered itself, so its name is not verified.";
	return page(
		`Connect ${details.clientName} to Strava`,
		`<h1>Let ${name} read your Strava data?</h1>
<p>${origin} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? '<p class="warn">This sends access to an app on your computer. Continue only if you just started connecting from it.</p>' : ""}
<p>Next you'll sign in to Strava and approve read-only access to your profile and activities, including private ones.</p>
<form method="post">
<input type="hidden" name="handle" value="${escape(handle)}">
<div class="row"><button name="decision" value="deny">Cancel</button><button class="primary" name="decision" value="approve">Continue to Strava</button></div>
</form>
<p class="muted" style="margin-top:16px">This connector only reads data. It cannot post, edit or delete anything on Strava.</p>`,
	);
}

const errorPage = (message: string, status = 400) =>
	page("Strava connector", `<h1>Something went wrong</h1><p>${escape(message)}</p><p class="muted">Close this window and try connecting again from Claude.</p>`, status);

async function authorizeGet(req: Request, oauth: OAuthHelpers) {
	const request = await oauth.parseAuthRequest(req);
	const details = await oauth.describeConsent(request);
	const consent = await oauth.beginConsent(request);
	const res = consentPage(details, consent.handle);
	consent.headers.forEach((v, k) => res.headers.append(k, v));
	return res;
}

async function authorizePost(req: Request, env: Env, oauth: OAuthHelpers) {
	const form = await req.formData();
	const handle = String(form.get("handle") ?? "");
	if (form.get("decision") !== "approve") {
		const denied = await oauth.denyConsent(req, handle);
		return new Response(null, { status: 302, headers: denied.headers });
	}
	const approved = await oauth.approveConsent(req, handle, { scope: [MCP_SCOPE] });
	const { state, headers } = await oauth.beginUpstream(approved.request, { headers: approved.headers });
	headers.set("Location", authorizeUrl(stravaConfig(env), new URL("/callback", req.url).href, state));
	return new Response(null, { status: 302, headers });
}

async function callback(req: Request, env: Env, oauth: OAuthHelpers) {
	const params = new URL(req.url).searchParams;
	const { request: original, headers } = await oauth.finishUpstream(req);
	const deny = (description: string) => {
		headers.set("Location", authorizationErrorRedirect(original as AuthRequest & { issuer?: string }, "access_denied", description));
		return new Response(null, { status: 302, headers });
	};

	if (params.get("error")) return deny("Strava access was declined");
	const code = params.get("code");
	if (!code) return deny("Strava did not return an authorization code");

	const grantedScope = params.get("scope") ?? "";
	if (!grantedScope.split(",").includes("activity:read_all") && !grantedScope.split(",").includes("activity:read")) {
		return errorPage(
			"Strava didn't grant access to your activities. Connect again and leave the activity boxes ticked on Strava's page.",
		);
	}

	const tokens = await exchangeCode(stravaConfig(env), code);
	const athlete = tokens.athlete;
	if (!athlete?.id) return errorPage("Strava did not identify the athlete.", 502);

	const allowed = (env.ALLOWED_ATHLETE_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
	if (allowed.length && !allowed.includes(String(athlete.id))) {
		return errorPage("This Strava account is not allowed to use this connector.", 403);
	}

	const athleteName = `${athlete.firstname ?? ""} ${athlete.lastname ?? ""}`.trim() || `Athlete ${athlete.id}`;
	const props: Props = {
		athleteId: athlete.id,
		athleteName,
		stravaScope: grantedScope,
		accessToken: tokens.accessToken,
		refreshToken: tokens.refreshToken,
		expiresAt: tokens.expiresAt,
	};
	const { redirectTo } = await oauth.completeAuthorization({
		request: original,
		userId: String(athlete.id),
		metadata: { label: athleteName },
		scope: original.scope,
		props,
	});
	headers.set("Location", redirectTo);
	return new Response(null, { status: 302, headers });
}

export const authHandler: ExportedHandler<Env & { OAUTH_PROVIDER: OAuthHelpers }> = {
	async fetch(req, env) {
		const { pathname } = new URL(req.url);
		const oauth = env.OAUTH_PROVIDER;
		try {
			if (pathname === "/authorize" && req.method === "GET") return await authorizeGet(req, oauth);
			if (pathname === "/authorize" && req.method === "POST") return await authorizePost(req, env, oauth);
			if (pathname === "/callback" && req.method === "GET") return await callback(req, env, oauth);
			if (pathname === "/") {
				return page(
					"Strava connector for Claude",
					`<h1>Strava connector for Claude</h1><p>This server is running. To use it, add <strong>${escape(new URL("/mcp", req.url).href)}</strong> as a custom connector in Claude.</p>`,
				);
			}
			return new Response("Not found", { status: 404 });
		} catch (error) {
			if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
			if (error instanceof AuthorizationError) return errorPage(error.description);
			if (error instanceof CimdFetchError) return errorPage("This app could not be verified.");
			throw error;
		}
	},
};
