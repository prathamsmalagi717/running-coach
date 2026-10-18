// Minimal fake of Strava's OAuth + API for local end-to-end tests.
import http from "node:http";

const port = Number(process.env.MOCK_PORT ?? 9999);
const log = [];
let tokenN = 0;
const now = () => Math.floor(Date.now() / 1000);
const tokens = (extra = {}) => ({ token_type: "Bearer", access_token: `at${++tokenN}`, refresh_token: `rt${tokenN}`, expires_at: now() + 21600, expires_in: 21600, ...extra });
const activity = (id) => ({ id, name: `Morning Run ${id}`, sport_type: "Run", type: "Run", start_date_local: "2026-10-15T07:00:00Z", distance: 10234.5, moving_time: 3005, elapsed_time: 3120, total_elevation_gain: 87.3, average_speed: 3.406, max_speed: 5.1, average_heartrate: 152.4, max_heartrate: 178, kudos_count: 4, gear_id: "g123", average_cadence: 86, workout_type: 2 });

http.createServer(async (req, res) => {
	const url = new URL(req.url, `http://localhost:${port}`);
	let body = "";
	for await (const chunk of req) body += chunk;
	log.push({ method: req.method, path: url.pathname, query: url.search, auth: req.headers.authorization, body });
	const send = (status, obj, headers = {}) => { res.writeHead(status, { "Content-Type": "application/json", ...headers }); res.end(JSON.stringify(obj)); };
	const p = url.pathname;

	if (p === "/__log") return send(200, log);
	if (p === "/oauth/authorize") {
		const to = new URL(url.searchParams.get("redirect_uri"));
		to.searchParams.set("state", url.searchParams.get("state"));
		to.searchParams.set("code", "strava-code-1");
		to.searchParams.set("scope", url.searchParams.get("scope"));
		res.writeHead(302, { Location: to.href }); return res.end();
	}
	if (p === "/oauth/token") {
		const f = new URLSearchParams(body);
		if (f.get("grant_type") === "authorization_code") return send(200, tokens({ athlete: { id: 42, firstname: "Test", lastname: "Runner" } }));
		if (f.get("grant_type") === "refresh_token") return f.get("refresh_token") === "revoked" ? send(400, { message: "Bad Request" }) : send(200, tokens());
		return send(400, {});
	}
	if (!req.headers.authorization?.startsWith("Bearer at")) return send(401, { message: "Authorization Error" });
	if (p === "/api/v3/athlete") return send(200, { id: 42, firstname: "Test", lastname: "Runner", city: "Bengaluru", measurement_preference: "meters", shoes: [{ id: "g123", name: "Pegasus", distance: 456789, primary: true }] });
	if (p === "/api/v3/athletes/42/stats") { const t = { count: 3, distance: 30000, moving_time: 9000, elapsed_time: 9500, elevation_gain: 200, achievement_count: 1 }; return send(200, { biggest_ride_distance: 80000, recent_run_totals: t, ytd_run_totals: t, all_run_totals: t, recent_ride_totals: t, ytd_ride_totals: t, all_ride_totals: t, recent_swim_totals: t, ytd_swim_totals: t, all_swim_totals: t }); }
	if (p === "/api/v3/athlete/activities") return send(200, [activity(1), { ...activity(2), sport_type: "Ride", type: "Ride", average_speed: 8.2 }]);
	if (p === "/api/v3/activities/1") return send(200, { ...activity(1), description: "Easy", splits_metric: [{ split: 1, distance: 1000, moving_time: 290, elapsed_time: 295, average_speed: 3.45, average_heartrate: 148 }], best_efforts: [{ name: "5k", elapsed_time: 1450, moving_time: 1450, distance: 5000 }], segment_efforts: [] });
	if (p === "/api/v3/activities/1/streams") return send(200, { heartrate: { data: Array.from({ length: 1000 }, (_, i) => 120 + (i % 50)), original_size: 1000 }, time: { data: Array.from({ length: 1000 }, (_, i) => i), original_size: 1000 } });
	if (p === "/api/v3/activities/1/zones") return send(402, { message: "Payment Required" });
	if (p === "/api/v3/segments/starred") return send(429, { message: "Rate Limit Exceeded" }, { "X-ReadRateLimit-Usage": "101,500", "X-ReadRateLimit-Limit": "100,1000" });
	send(404, { message: "Record Not Found" });
}).listen(port, () => console.log(`mock strava on ${port}`));
