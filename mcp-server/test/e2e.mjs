// End-to-end: MCP client registration -> consent -> (mock) Strava login -> token -> MCP tool calls -> refresh.
// Run with: npm test
import assert from "node:assert/strict";
import crypto from "node:crypto";

const BASE = process.env.BASE ?? "http://localhost:8788";
const MOCK = process.env.MOCK ?? "http://127.0.0.1:9999";
const REDIRECT = "http://localhost:3333/cb";
const jar = new Map();
const keep = (res) => { for (const c of res.headers.getSetCookie()) { const [kv] = c.split(";"); const i = kv.indexOf("="); const v = kv.slice(i + 1); v ? jar.set(kv.slice(0, i), v) : jar.delete(kv.slice(0, i)); } };
const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
const go = async (url, init = {}) => { const res = await fetch(url, { redirect: "manual", ...init, headers: { cookie: cookie(), ...(init.headers ?? {}) } }); keep(res); return res; };
const step = (s) => console.log(`✓ ${s}`);

const apiCalls = async () => (await (await fetch(`${MOCK}/__log`)).json()).filter((l) => l.path.startsWith("/api/"));
const before = (await apiCalls()).length;

// 1. Discovery
const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
assert.equal(prm.resource, `${BASE}/mcp`);
const unauth = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
assert.equal(unauth.status, 401);
step(`discovery ok, unauthenticated /mcp -> 401`);

// 2. Dynamic client registration
const reg = await (await fetch(`${BASE}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "E2E Client", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) })).json();
assert.ok(reg.client_id, JSON.stringify(reg));
step(`registered client`);

// 3. Authorize -> consent page
const verifier = crypto.randomBytes(32).toString("base64url");
const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
const authUrl = new URL(`${BASE}/authorize`);
Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "client-state", resource: `${BASE}/mcp`, scope: "strava:read" }).forEach(([k, v]) => authUrl.searchParams.set(k, v));
let res = await go(authUrl);
const html = await res.text();
assert.equal(res.status, 200, html);
assert.match(html, /E2E Client/);
const handle = html.match(/name="handle" value="([^"]+)"/)[1];
step(`consent page shown`);

// 4. Approve -> redirected to Strava
res = await go(`${BASE}/authorize`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ handle, decision: "approve" }) });
assert.equal(res.status, 302, await res.text());
const stravaUrl = new URL(res.headers.get("location"));
assert.equal(stravaUrl.origin + stravaUrl.pathname, `${MOCK}/oauth/authorize`);
assert.equal(stravaUrl.searchParams.get("scope"), "read,activity:read_all,profile:read_all");
step(`approved, sent to Strava login`);

// 5. Strava -> callback -> client redirect with code
res = await go(stravaUrl);
const cb = res.headers.get("location");
res = await go(cb);
assert.equal(res.status, 302, await res.text());
const back = new URL(res.headers.get("location"));
assert.equal(back.origin + back.pathname, REDIRECT);
assert.equal(back.searchParams.get("state"), "client-state");
step(`callback completed, code returned to client`);

// 6. Token exchange
const tok = await (await fetch(`${BASE}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code"), redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier, resource: `${BASE}/mcp` }) })).json();
assert.ok(tok.access_token && tok.refresh_token, JSON.stringify(tok));
assert.ok(tok.expires_in <= 3600 && tok.expires_in > 60, `ttl ${tok.expires_in}`);
step(`token issued (expires_in ${tok.expires_in}s)`);

// 7. MCP calls
let id = 0;
const mcp = async (token, method, params) => {
	const r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
	const text = await r.text();
	assert.equal(r.status, 200, text);
	const line = text.includes("data:") ? text.split("\n").find((l) => l.startsWith("data:")).slice(5) : text;
	const msg = JSON.parse(line);
	assert.ok(!msg.error, JSON.stringify(msg.error));
	return msg.result;
};
const call = async (token, name, args = {}) => mcp(token, "tools/call", { name, arguments: args });
const init = await mcp(tok.access_token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
assert.equal(init.serverInfo.name, "strava");
const { tools } = await mcp(tok.access_token, "tools/list", {});
console.log(`  tools: ${tools.map((t) => t.name).join(", ")}`);
assert.equal(tools.length, 15);

const acts = JSON.parse((await call(tok.access_token, "list_activities", { after: "2026-10-01", sport_type: "run" })).content[0].text);
assert.equal(acts.activities.length, 1);
assert.equal(acts.activities[0].average, "4:54 /km");
assert.equal(acts.activities[0].distance_km, 10.23);
assert.equal(acts.activities[0].average_cadence, 172);
assert.equal(acts.activities[0].workout_type, "long run");
step(`list_activities: ${JSON.stringify(acts.activities[0])}`);

const summary = JSON.parse((await call(tok.access_token, "get_training_summary", { today: "2026-10-17" })).content[0].text);
assert.deepEqual([summary.this_week.from, summary.this_week.to], ["2026-10-12", "2026-10-17"]);
assert.equal(summary.this_week.count, 1);
assert.equal(summary.this_week.average, "4:54 /km");
assert.equal(summary.last_month.count, 0);
step(`get_training_summary: ${JSON.stringify(summary.this_week)}`);

const { prompts } = await mcp(tok.access_token, "prompts/list", {});
assert.deepEqual(prompts.map((p) => p.name), ["running_coach"]);
const prompt = await mcp(tok.access_token, "prompts/get", { name: "running_coach", arguments: { question: "Am I getting faster?" } });
assert.match(prompt.messages[0].content.text, /Am I getting faster\?/);
step(`running_coach prompt ok`);

const detail = JSON.parse((await call(tok.access_token, "get_activity", { activity_id: 1 })).content[0].text);
assert.equal(detail.best_efforts[0].elapsed_time, "24:10");
step(`get_activity ok`);

const streams = JSON.parse((await call(tok.access_token, "get_activity_streams", { activity_id: 1, keys: ["heartrate", "time"], max_points: 50 })).content[0].text);
assert.equal(streams.streams.heartrate.length, 50);
step(`get_activity_streams downsampled 1000 -> 50`);

const stats = JSON.parse((await call(tok.access_token, "get_athlete_stats")).content[0].text);
assert.equal(stats.run.year_to_date.distance_km, 30);
step(`get_athlete_stats ok`);

const zones = await call(tok.access_token, "get_activity_zones", { activity_id: 1 });
assert.equal(zones.isError, true); assert.match(zones.content[0].text, /subscription/);
const rl = await call(tok.access_token, "list_starred_segments");
assert.equal(rl.isError, true); assert.match(rl.content[0].text, /rate limit/);
step(`402 and 429 surface as readable tool errors`);

const calls = (await apiCalls()).slice(before);
const firstToken = calls[0].auth;
assert.ok(calls.every((l) => l.auth === firstToken));
step(`all API calls used the athlete's Strava token`);

// 8. Refresh rotates the Strava token
const ref = await (await fetch(`${BASE}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: reg.client_id, resource: `${BASE}/mcp` }) })).json();
assert.ok(ref.access_token, JSON.stringify(ref));
await call(ref.access_token, "get_athlete");
const lastToken = (await apiCalls()).at(-1).auth;
assert.ok(lastToken.startsWith("Bearer at") && lastToken !== firstToken, lastToken);
step(`refresh: new MCP token uses refreshed Strava token`);

console.log("\nAll end-to-end checks passed.");
