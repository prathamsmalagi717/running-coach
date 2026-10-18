import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
	compact,
	formatSpeed,
	downsampleStreams,
	formatDuration,
	type StravaClient,
	StravaError,
	summarizeActivity,
	summarizeEffort,
	summarizeLap,
	summarizeSegment,
	toEpochSeconds,
} from "./strava";

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }] });

/** Wrap a tool handler so Strava errors come back as readable tool errors instead of protocol failures. */
function safe<A>(fn: (args: A) => Promise<unknown>) {
	return async (args: A) => {
		try {
			return json(await fn(args));
		} catch (error) {
			const message = error instanceof StravaError || error instanceof Error ? error.message : String(error);
			return { content: [{ type: "text" as const, text: message }], isError: true };
		}
	};
}

// Coaching guidance carried over from the running-coach skill.
const COACH_GUIDE = `Act as my personal running coach. You have live access to my Strava data through the Strava tools; talk to me like a coach who has been tracking every run, not like a data report.

- Simple "how was my run?": fetch my last run (list_activities with sport_type Run, per_page 1, then get_activity) and give a 3-4 sentence take: what went well, what to watch, one actionable tip.
- Trend questions: use get_training_summary and list_activities to spot patterns (pace improving, heart rate creeping up, mileage dropping).
- Planning questions: check my current load with get_training_summary before suggesting anything.
- Deep analysis: use get_activity splits and laps, and get_activity_streams if needed, to comment on pacing strategy.
- Be direct and personal ("your Tuesday run", "you negative split that 5K"). If heart rate data is missing, note it but don't make the answer about it.

Reading the data: pace is min:sec per km, lower is faster (5:00 strong, 6:30 comfortable, 7:30+ easy/recovery). suffer_score is Strava's effort rating (<50 easy, 50-100 moderate, 100-150 hard, 150+ very hard). Cadence is steps per minute; 170-180 is ideal for most runners. Same pace at a lower heart rate means fitness is improving.`;

const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

function totals(t: any) {
	return compact({
		count: t.count,
		distance_km: Math.round(t.distance / 10) / 100,
		moving_time: formatDuration(t.moving_time),
		elapsed_time: formatDuration(t.elapsed_time),
		elevation_gain_m: Math.round(t.elevation_gain),
		achievements: t.achievement_count,
	});
}

/** Inclusive [from, to] local-date ranges for the summary periods around `day`. */
export function trainingPeriods(day: string): Record<string, [string, string]> {
	const d = new Date(`${day}T00:00:00Z`);
	const iso = (x: Date) => x.toISOString().slice(0, 10);
	const addDays = (x: Date, n: number) => new Date(x.getTime() + n * 86400000);
	const weekStart = addDays(d, -((d.getUTCDay() + 6) % 7));
	const monthStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
	const lastMonthStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
	return {
		this_week: [iso(weekStart), iso(d)],
		last_week: [iso(addDays(weekStart, -7)), iso(addDays(weekStart, -1))],
		this_month: [iso(monthStart), iso(d)],
		last_month: [iso(lastMonthStart), iso(addDays(monthStart, -1))],
	};
}

function periodTotals(activities: any[], sportType: string) {
	if (!activities.length) return { count: 0 };
	const distance = activities.reduce((s, a) => s + (a.distance ?? 0), 0);
	const moving = activities.reduce((s, a) => s + (a.moving_time ?? 0), 0);
	const longest = activities.reduce((m, a) => ((a.distance ?? 0) > (m.distance ?? 0) ? a : m));
	return compact({
		count: activities.length,
		distance_km: Math.round(distance / 10) / 100,
		moving_time: formatDuration(moving),
		elevation_gain_m: Math.round(activities.reduce((s, a) => s + (a.total_elevation_gain ?? 0), 0)),
		average: sportType.toLowerCase() === "all" ? undefined : formatSpeed(moving ? distance / moving : 0, sportType),
		longest: compact({ id: longest.id, name: longest.name, date: String(longest.start_date_local).slice(0, 10), distance_km: Math.round(longest.distance / 10) / 100 }),
	});
}

export function registerTools(server: McpServer, strava: () => StravaClient, athleteId: number) {
	server.registerTool(
		"get_athlete",
		{
			title: "Get my Strava profile",
			description:
				"The connected athlete's Strava profile: name, location, units preference, weight, FTP, and their bikes and shoes (with gear ids and total distance).",
			annotations: readOnly,
		},
		safe(async () => {
			const a = await strava().get("/athlete");
			const gear = (g: any) => compact({ id: g.id, name: g.name, primary: g.primary || undefined, distance_km: Math.round(g.distance / 1000), retired: g.retired || undefined });
			return compact({
				id: a.id,
				name: `${a.firstname ?? ""} ${a.lastname ?? ""}`.trim(),
				username: a.username,
				city: a.city,
				state: a.state,
				country: a.country,
				sex: a.sex,
				premium: a.summit ?? a.premium,
				created_at: a.created_at,
				measurement_preference: a.measurement_preference,
				weight_kg: a.weight,
				ftp: a.ftp,
				follower_count: a.follower_count,
				friend_count: a.friend_count,
				bikes: a.bikes?.map(gear),
				shoes: a.shoes?.map(gear),
			});
		}),
	);

	server.registerTool(
		"get_athlete_stats",
		{
			title: "Get my training totals",
			description:
				"Recent (last 4 weeks), year-to-date and all-time totals for rides, runs and swims, plus biggest ride and biggest climb.",
			annotations: readOnly,
		},
		safe(async () => {
			const s = await strava().get(`/athletes/${athleteId}/stats`);
			const out: Record<string, unknown> = {
				biggest_ride_km: s.biggest_ride_distance ? Math.round(s.biggest_ride_distance / 100) / 10 : undefined,
				biggest_climb_m: s.biggest_climb_elevation_gain ? Math.round(s.biggest_climb_elevation_gain) : undefined,
			};
			for (const sport of ["ride", "run", "swim"]) {
				out[sport] = {
					last_4_weeks: totals(s[`recent_${sport}_totals`]),
					year_to_date: totals(s[`ytd_${sport}_totals`]),
					all_time: totals(s[`all_${sport}_totals`]),
				};
			}
			return compact(out);
		}),
	);

	server.registerTool(
		"list_activities",
		{
			title: "List my activities",
			description:
				"List the athlete's activities, newest first, with distance, time, pace/speed, heart rate and power. Filter by date range and sport. Use get_activity for full detail on one.",
			inputSchema: {
				after: z.string().optional().describe("Only activities starting after this date/time, e.g. 2026-10-01"),
				before: z.string().optional().describe("Only activities starting before this date/time"),
				sport_type: z
					.string()
					.optional()
					.describe("Filter by Strava sport type, e.g. Run, Ride, TrailRun, Swim, Walk, VirtualRide (case-insensitive)"),
				page: z.number().int().min(1).default(1).describe("Page number"),
				per_page: z.number().int().min(1).max(200).default(30).describe("Activities per page (max 200)"),
			},
			annotations: readOnly,
		},
		safe(async ({ after, before, sport_type, page, per_page }) => {
			const list = await strava().get<any[]>("/athlete/activities", {
				after: after ? toEpochSeconds(after) : undefined,
				before: before ? toEpochSeconds(before) : undefined,
				page,
				per_page,
			});
			const filtered = sport_type
				? list.filter((a) => String(a.sport_type ?? a.type).toLowerCase() === sport_type.toLowerCase())
				: list;
			return {
				page,
				returned: filtered.length,
				more_pages_likely: list.length === per_page,
				activities: filtered.map(summarizeActivity),
			};
		}),
	);

	server.registerTool(
		"get_training_summary",
		{
			title: "Get weekly and monthly training summary",
			description:
				"Totals for this week, last week, this month and last month (weeks start Monday, by the activity's local date): count, distance, time, average pace and longest activity. Defaults to runs.",
			inputSchema: {
				today: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/)
					.optional()
					.describe("The user's local date as YYYY-MM-DD; defaults to today in UTC"),
				sport_type: z.string().default("Run").describe("Strava sport type, or 'all' for every sport"),
			},
			annotations: readOnly,
		},
		safe(async ({ today, sport_type }) => {
			const day = today ?? new Date().toISOString().slice(0, 10);
			const periods = trainingPeriods(day);
			// Fetch from a day before the earliest period so time zones can't drop an activity at the edge.
			const after = Date.parse(`${periods.last_month[0]}T00:00:00Z`) / 1000 - 86400;
			const activities: any[] = [];
			for (let page = 1; page <= 3; page++) {
				const batch = await strava().get<any[]>("/athlete/activities", { after, page, per_page: 200 });
				activities.push(...batch);
				if (batch.length < 200) break;
			}
			const wanted =
				sport_type.toLowerCase() === "all"
					? activities
					: activities.filter((a) => String(a.sport_type ?? a.type).toLowerCase() === sport_type.toLowerCase());
			const out: Record<string, unknown> = { today: day, sport_type };
			for (const [name, [from, to]] of Object.entries(periods)) {
				const inPeriod = wanted.filter((a) => {
					const d = String(a.start_date_local).slice(0, 10);
					return d >= from && d <= to;
				});
				out[name] = { from, to, ...periodTotals(inPeriod, sport_type) };
			}
			return out;
		}),
	);

	server.registerTool(
		"get_activity",
		{
			title: "Get one activity",
			description:
				"Full detail for one activity: description, device, calories, gear, km splits, laps, best efforts (fastest 1k/5k/etc.) and segment efforts.",
			inputSchema: {
				activity_id: z.number().int().describe("Strava activity id"),
				include_segment_efforts: z.boolean().default(true).describe("Include segment efforts on this activity"),
			},
			annotations: readOnly,
		},
		safe(async ({ activity_id, include_segment_efforts }) => {
			const a = await strava().get(`/activities/${activity_id}`, { include_all_efforts: include_segment_efforts });
			const sport = a.sport_type ?? a.type;
			return compact({
				...summarizeActivity(a),
				description: a.description,
				device: a.device_name,
				calories: a.calories,
				location: [a.location_city, a.location_state, a.location_country].filter(Boolean).join(", ") || undefined,
				gear: a.gear ? compact({ id: a.gear.id, name: a.gear.name }) : undefined,
				elev_high_m: a.elev_high,
				elev_low_m: a.elev_low,
				average_temp_c: a.average_temp,
				splits_km: a.splits_metric?.map((s: any) => summarizeLap(s, sport)),
				laps: a.laps?.length > 1 ? a.laps.map((l: any) => summarizeLap(l, sport)) : undefined,
				best_efforts: a.best_efforts?.map((e: any) => summarizeEffort(e, sport)),
				segment_efforts: include_segment_efforts
					? a.segment_efforts?.map((e: any) => summarizeEffort(e, sport))
					: undefined,
			});
		}),
	);

	server.registerTool(
		"get_activity_streams",
		{
			title: "Get activity data streams",
			description:
				"Time-series data recorded during an activity (heart rate, pace, power, cadence, elevation, GPS), downsampled to keep the response small. Units: distance m, velocity_smooth m/s, altitude m, time s.",
			inputSchema: {
				activity_id: z.number().int().describe("Strava activity id"),
				keys: z
					.array(
						z.enum([
							"time",
							"distance",
							"latlng",
							"altitude",
							"velocity_smooth",
							"heartrate",
							"cadence",
							"watts",
							"temp",
							"moving",
							"grade_smooth",
						]),
					)
					.default(["time", "distance", "heartrate", "velocity_smooth", "altitude"])
					.describe("Which streams to fetch"),
				max_points: z.number().int().min(10).max(1000).default(100).describe("Maximum samples per stream"),
			},
			annotations: readOnly,
		},
		safe(async ({ activity_id, keys, max_points }) => {
			const streams = await strava().get(`/activities/${activity_id}/streams`, {
				keys: keys.join(","),
				key_by_type: true,
			});
			const original = Object.values(streams as Record<string, any>)[0]?.original_size;
			return { original_samples: original, streams: downsampleStreams(streams, max_points) };
		}),
	);

	server.registerTool(
		"get_activity_zones",
		{
			title: "Get activity heart rate and power zones",
			description:
				"Time spent in each heart rate and power zone for one activity. Strava only provides this for athletes with a subscription.",
			inputSchema: { activity_id: z.number().int().describe("Strava activity id") },
			annotations: readOnly,
		},
		safe(async ({ activity_id }) => {
			const zones = await strava().get<any[]>(`/activities/${activity_id}/zones`);
			return zones.map((z) =>
				compact({
					type: z.type,
					score: z.score,
					buckets: z.distribution_buckets?.map((b: any) => ({
						range: `${b.min}-${b.max === -1 ? "max" : b.max}`,
						time: formatDuration(b.time),
					})),
				}),
			);
		}),
	);

	server.registerTool(
		"get_athlete_zones",
		{
			title: "Get my training zones",
			description: "The athlete's configured heart rate and power zone boundaries.",
			annotations: readOnly,
		},
		safe(async () => strava().get("/athlete/zones")),
	);

	server.registerPrompt(
		"running_coach",
		{
			title: "Running coach",
			description: "Talk to Claude as your personal running coach, using your live Strava data.",
			argsSchema: z.object({ question: z.string().optional().describe("What you want to ask your coach") }),
		},
		({ question }) => ({
			messages: [
				{
					role: "user" as const,
					content: { type: "text" as const, text: `${COACH_GUIDE}\n\n${question ? `My question: ${question}` : "How was my last run?"}` },
				},
			],
		}),
	);

	server.registerTool(
		"list_starred_segments",
		{
			title: "List my starred segments",
			description: "Segments the athlete has starred, with distance, grade and their personal record.",
			inputSchema: {
				page: z.number().int().min(1).default(1),
				per_page: z.number().int().min(1).max(200).default(30),
			},
			annotations: readOnly,
		},
		safe(async ({ page, per_page }) => {
			const list = await strava().get<any[]>("/segments/starred", { page, per_page });
			return list.map(summarizeSegment);
		}),
	);

	server.registerTool(
		"get_segment",
		{
			title: "Get a segment",
			description: "Detail for one segment, including the athlete's effort count and personal record on it.",
			inputSchema: { segment_id: z.number().int().describe("Strava segment id") },
			annotations: readOnly,
		},
		safe(async ({ segment_id }) => summarizeSegment(await strava().get(`/segments/${segment_id}`))),
	);

	server.registerTool(
		"explore_segments",
		{
			title: "Find segments in an area",
			description:
				"Find popular segments inside a map rectangle. Give the south-west and north-east corners in decimal degrees.",
			inputSchema: {
				sw_lat: z.number().min(-90).max(90),
				sw_lng: z.number().min(-180).max(180),
				ne_lat: z.number().min(-90).max(90),
				ne_lng: z.number().min(-180).max(180),
				activity_type: z.enum(["running", "riding"]).default("running"),
				min_climb_category: z.number().int().min(0).max(5).optional().describe("Riding only: 0 (none) to 5 (HC)"),
				max_climb_category: z.number().int().min(0).max(5).optional(),
			},
			annotations: readOnly,
		},
		safe(async ({ sw_lat, sw_lng, ne_lat, ne_lng, activity_type, min_climb_category, max_climb_category }) => {
			const result = await strava().get("/segments/explore", {
				bounds: [sw_lat, sw_lng, ne_lat, ne_lng].join(","),
				activity_type,
				min_cat: min_climb_category,
				max_cat: max_climb_category,
			});
			return (result.segments ?? []).map(summarizeSegment);
		}),
	);

	server.registerTool(
		"list_segment_efforts",
		{
			title: "List my efforts on a segment",
			description:
				"The athlete's own attempts on one segment, optionally within a date range. Strava only provides this for athletes with a subscription.",
			inputSchema: {
				segment_id: z.number().int().describe("Strava segment id"),
				start_date_local: z.string().optional().describe("e.g. 2026-01-01T00:00:00Z"),
				end_date_local: z.string().optional(),
				per_page: z.number().int().min(1).max(200).default(30),
			},
			annotations: readOnly,
		},
		safe(async ({ segment_id, start_date_local, end_date_local, per_page }) => {
			const list = await strava().get<any[]>("/segment_efforts", {
				segment_id,
				start_date_local,
				end_date_local,
				per_page,
			});
			return list.map((e) => summarizeEffort(e, ""));
		}),
	);

	server.registerTool(
		"list_clubs",
		{
			title: "List my clubs",
			description: "Strava clubs the athlete belongs to.",
			annotations: readOnly,
		},
		safe(async () => {
			const clubs = await strava().get<any[]>("/athlete/clubs", { per_page: 100 });
			return clubs.map((c) =>
				compact({ id: c.id, name: c.name, sport_type: c.sport_type, city: c.city, country: c.country, members: c.member_count, url: c.url ? `https://www.strava.com/clubs/${c.url}` : undefined }),
			);
		}),
	);

	server.registerTool(
		"list_routes",
		{
			title: "List my routes",
			description: "Routes the athlete has created on Strava, with distance, elevation and estimated time.",
			inputSchema: {
				page: z.number().int().min(1).default(1),
				per_page: z.number().int().min(1).max(200).default(30),
			},
			annotations: readOnly,
		},
		safe(async ({ page, per_page }) => {
			const routes = await strava().get<any[]>(`/athletes/${athleteId}/routes`, { page, per_page });
			return routes.map((r) =>
				compact({
					id: r.id_str ?? r.id,
					name: r.name,
					description: r.description || undefined,
					type: r.type === 1 ? "ride" : r.type === 2 ? "run" : r.type,
					distance_km: Math.round(r.distance / 10) / 100,
					elevation_gain_m: Math.round(r.elevation_gain),
					estimated_moving_time: formatDuration(r.estimated_moving_time),
					starred: r.starred || undefined,
					private: r.private || undefined,
					created_at: r.created_at,
				}),
			);
		}),
	);

	server.registerTool(
		"get_gear",
		{
			title: "Get a bike or pair of shoes",
			description: "Detail for one piece of gear (ids come from get_athlete or an activity's gear_id).",
			inputSchema: { gear_id: z.string().describe("Gear id, e.g. b1234567 or g1234567") },
			annotations: readOnly,
		},
		safe(async ({ gear_id }) => {
			const g = await strava().get(`/gear/${encodeURIComponent(gear_id)}`);
			return compact({
				id: g.id,
				name: g.name,
				brand: g.brand_name,
				model: g.model_name,
				description: g.description || undefined,
				distance_km: Math.round(g.distance / 1000),
				primary: g.primary,
				retired: g.retired || undefined,
			});
		}),
	);
}
