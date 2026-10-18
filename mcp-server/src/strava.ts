// Thin client for Strava's official REST API (https://developers.strava.com/docs/reference/).

export const STRAVA_SCOPES = "read,activity:read_all,profile:read_all";

export interface StravaConfig {
	clientId: string;
	clientSecret: string;
	/** Overridable for local testing only; defaults to Strava's real hosts. */
	oauthBase?: string;
	apiBase?: string;
}

export interface StravaTokens {
	accessToken: string;
	refreshToken: string;
	/** Unix seconds. */
	expiresAt: number;
}

export interface StravaTokenResponse extends StravaTokens {
	athlete?: { id: number; firstname?: string; lastname?: string };
}

export class StravaError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
		this.name = "StravaError";
	}
}

const oauthBase = (c: StravaConfig) => c.oauthBase ?? "https://www.strava.com/oauth";
const apiBase = (c: StravaConfig) => c.apiBase ?? "https://www.strava.com/api/v3";

export function authorizeUrl(c: StravaConfig, redirectUri: string, state: string): string {
	const url = new URL(`${oauthBase(c)}/authorize`);
	url.searchParams.set("client_id", c.clientId);
	url.searchParams.set("redirect_uri", redirectUri);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("approval_prompt", "auto");
	url.searchParams.set("scope", STRAVA_SCOPES);
	url.searchParams.set("state", state);
	return url.href;
}

async function tokenRequest(c: StravaConfig, params: Record<string, string>): Promise<StravaTokenResponse> {
	const resp = await fetch(`${oauthBase(c)}/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...params }),
	});
	if (!resp.ok) {
		throw new StravaError(resp.status, `Strava token request failed (${resp.status}): ${await resp.text()}`);
	}
	const body = (await resp.json()) as {
		access_token: string;
		refresh_token: string;
		expires_at: number;
		athlete?: StravaTokenResponse["athlete"];
	};
	return {
		accessToken: body.access_token,
		refreshToken: body.refresh_token,
		expiresAt: body.expires_at,
		athlete: body.athlete,
	};
}

export const exchangeCode = (c: StravaConfig, code: string) =>
	tokenRequest(c, { code, grant_type: "authorization_code" });

export const refreshTokens = (c: StravaConfig, refreshToken: string) =>
	tokenRequest(c, { refresh_token: refreshToken, grant_type: "refresh_token" });

type Query = Record<string, string | number | boolean | undefined>;

export class StravaClient {
	constructor(
		private config: StravaConfig,
		private accessToken: string,
	) {}

	async get<T = any>(path: string, query: Query = {}): Promise<T> {
		const url = new URL(apiBase(this.config) + path);
		for (const [k, v] of Object.entries(query)) {
			if (v !== undefined) url.searchParams.set(k, String(v));
		}
		const resp = await fetch(url, { headers: { Authorization: `Bearer ${this.accessToken}` } });
		if (resp.ok) return (await resp.json()) as T;
		throw new StravaError(resp.status, describeError(resp, await resp.text()));
	}
}

function describeError(resp: Response, body: string): string {
	switch (resp.status) {
		case 401:
			return "Strava rejected the access token. Disconnect and reconnect the Strava connector in Claude.";
		case 402:
			return "This Strava endpoint is only available to athletes with a Strava subscription.";
		case 403:
			if (body.includes('"Inactive"')) {
				return "Strava has marked the API application as inactive, so it refuses all requests. Check the app at https://www.strava.com/settings/api for a notice (such as an updated API Agreement to accept) or contact Strava developer support. Reconnecting the connector won't help.";
			}
			return `Strava denied access. The connector may be missing a permission (scope); reconnect and tick every box on Strava's consent page. Details: ${body}`;
		case 404:
			return "Not found on Strava (or it belongs to another athlete and is private).";
		case 429: {
			const usage = resp.headers.get("X-ReadRateLimit-Usage") ?? resp.headers.get("X-RateLimit-Usage");
			const limit = resp.headers.get("X-ReadRateLimit-Limit") ?? resp.headers.get("X-RateLimit-Limit");
			return `Strava rate limit reached (usage ${usage ?? "?"} of ${limit ?? "?"} per 15 minutes / per day). Try again in a few minutes.`;
		}
		default:
			return `Strava API error ${resp.status}: ${body}`;
	}
}

// ---- Formatting helpers: keep responses compact and readable for the model. ----

const PACE_SPORTS = new Set(["Run", "TrailRun", "VirtualRun", "Walk", "Hike", "Swim"]);
const FOOT_SPORTS = new Set(["Run", "TrailRun", "VirtualRun", "Walk", "Hike"]);

const WORKOUT_TYPES: Record<number, string> = {
	1: "race",
	2: "long run",
	3: "workout",
	11: "race",
	12: "workout",
};

/** Strava records running cadence per leg; double it to get steps per minute. */
export function cadence(raw: number | undefined, sportType: string | undefined): number | undefined {
	if (!raw) return undefined;
	return Math.round(sportType && FOOT_SPORTS.has(sportType) ? raw * 2 : raw);
}

export function formatDuration(seconds: number | undefined): string | undefined {
	if (seconds === undefined || seconds === null) return undefined;
	const s = Math.round(seconds);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	const mm = String(m).padStart(h ? 2 : 1, "0");
	const ss = String(sec).padStart(2, "0");
	return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Pace per km (or per 100 m for swims) for foot sports, km/h otherwise. */
export function formatSpeed(metersPerSecond: number | undefined, sportType: string | undefined): string | undefined {
	if (!metersPerSecond) return undefined;
	if (sportType === "Swim") return `${formatDuration(100 / metersPerSecond)} /100m`;
	if (sportType && PACE_SPORTS.has(sportType)) return `${formatDuration(1000 / metersPerSecond)} /km`;
	return `${(metersPerSecond * 3.6).toFixed(1)} km/h`;
}

const km = (meters: number | undefined) => (meters === undefined ? undefined : Math.round(meters / 10) / 100);
const round = (n: number | undefined, digits = 0) =>
	n === undefined || n === null ? undefined : Math.round(n * 10 ** digits) / 10 ** digits;

/** Drop undefined/null keys so JSON output stays small. */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
	return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null)) as Partial<T>;
}

export function summarizeActivity(a: any) {
	const sport = a.sport_type ?? a.type;
	return compact({
		id: a.id,
		name: a.name,
		sport_type: sport,
		start_date_local: a.start_date_local,
		distance_km: km(a.distance),
		moving_time: formatDuration(a.moving_time),
		elapsed_time: formatDuration(a.elapsed_time),
		elevation_gain_m: round(a.total_elevation_gain),
		average: formatSpeed(a.average_speed, sport),
		max: formatSpeed(a.max_speed, sport),
		average_heartrate: round(a.average_heartrate),
		max_heartrate: round(a.max_heartrate),
		average_cadence: cadence(a.average_cadence, sport),
		average_watts: round(a.average_watts),
		weighted_average_watts: a.weighted_average_watts,
		kilojoules: round(a.kilojoules),
		suffer_score: a.suffer_score,
		workout_type: WORKOUT_TYPES[a.workout_type],
		kudos: a.kudos_count,
		achievements: a.achievement_count || undefined,
		pr_count: a.pr_count || undefined,
		trainer: a.trainer || undefined,
		commute: a.commute || undefined,
		private: a.private || undefined,
		gear_id: a.gear_id,
	});
}

export function summarizeLap(l: any, sport: string) {
	return compact({
		lap: l.lap_index ?? l.split,
		name: l.name,
		distance_km: km(l.distance),
		moving_time: formatDuration(l.moving_time),
		elapsed_time: formatDuration(l.elapsed_time),
		average: formatSpeed(l.average_speed, sport),
		elevation_change_m: round(l.elevation_difference ?? l.total_elevation_gain),
		average_heartrate: round(l.average_heartrate),
		average_watts: round(l.average_watts),
		pace_zone: l.pace_zone,
	});
}

export function summarizeEffort(e: any, sport: string) {
	return compact({
		name: e.name,
		segment_id: e.segment?.id,
		distance_km: km(e.distance ?? e.segment?.distance),
		elapsed_time: formatDuration(e.elapsed_time),
		moving_time: formatDuration(e.moving_time),
		average: e.distance && e.moving_time ? formatSpeed(e.distance / e.moving_time, sport) : undefined,
		average_heartrate: round(e.average_heartrate),
		average_watts: round(e.average_watts),
		start_date_local: e.start_date_local,
		pr_rank: e.pr_rank,
		kom_rank: e.kom_rank,
		activity_id: e.activity?.id,
	});
}

export function summarizeSegment(s: any) {
	return compact({
		id: s.id,
		name: s.name,
		activity_type: s.activity_type,
		distance_km: km(s.distance),
		average_grade_pct: s.average_grade ?? s.avg_grade,
		maximum_grade_pct: s.maximum_grade,
		elevation_gain_m: round(s.total_elevation_gain ?? s.elev_difference),
		climb_category: s.climb_category,
		city: s.city,
		state: s.state,
		country: s.country,
		starred: s.starred,
		athlete_effort_count: s.athlete_segment_stats?.effort_count,
		athlete_pr_time: formatDuration(s.athlete_segment_stats?.pr_elapsed_time ?? s.athlete_pr_effort?.pr_elapsed_time),
		athlete_pr_date: s.athlete_segment_stats?.pr_date ?? s.athlete_pr_effort?.start_date_local,
		effort_count: s.effort_count,
		athlete_count: s.athlete_count,
		star_count: s.star_count,
		start_latlng: s.start_latlng,
		end_latlng: s.end_latlng,
	});
}

/** Evenly downsample every stream to at most maxPoints samples. */
export function downsampleStreams(streams: Record<string, { data: unknown[] }>, maxPoints: number) {
	const out: Record<string, unknown[]> = {};
	for (const [key, stream] of Object.entries(streams)) {
		const data = stream.data ?? [];
		if (data.length <= maxPoints) {
			out[key] = data;
			continue;
		}
		const step = (data.length - 1) / (maxPoints - 1);
		out[key] = Array.from({ length: maxPoints }, (_, i) => data[Math.round(i * step)]);
	}
	return out;
}

/** Parse a date or datetime string into Unix seconds; throws on garbage. */
export function toEpochSeconds(value: string): number {
	const ms = Date.parse(value);
	if (Number.isNaN(ms)) throw new Error(`Could not parse date "${value}". Use a format like 2026-10-01.`);
	return Math.floor(ms / 1000);
}
