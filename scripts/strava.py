"""
Strava API helper. Called by the running-coach skill to fetch live workout data.

Usage:
  python strava.py recent        -- last 10 runs
  python strava.py today         -- today's run (if any)
  python strava.py last          -- most recent single run
  python strava.py stats         -- weekly/monthly summary
  python strava.py activity <id> -- full details for a specific activity
"""

import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

CREDENTIALS_FILE = Path(__file__).parent.parent / "data" / "strava_credentials.json"
BASE_URL = "https://www.strava.com/api/v3"


def load_credentials():
    if not CREDENTIALS_FILE.exists():
        print(json.dumps({"error": "No credentials found. Run strava_auth.py first."}))
        sys.exit(1)
    with open(CREDENTIALS_FILE) as f:
        return json.load(f)


def save_credentials(creds):
    with open(CREDENTIALS_FILE, "w") as f:
        json.dump(creds, f, indent=2)


def get_access_token():
    creds = load_credentials()

    # Refresh token if expired
    if time.time() >= creds["expires_at"] - 60:
        data = urllib.parse.urlencode({
            "client_id": creds["client_id"],
            "client_secret": creds["client_secret"],
            "grant_type": "refresh_token",
            "refresh_token": creds["refresh_token"]
        }).encode()
        req = urllib.request.Request("https://www.strava.com/oauth/token", data=data, method="POST")
        with urllib.request.urlopen(req) as resp:
            tokens = json.loads(resp.read())
        creds["access_token"] = tokens["access_token"]
        creds["refresh_token"] = tokens["refresh_token"]
        creds["expires_at"] = tokens["expires_at"]
        save_credentials(creds)

    return creds["access_token"]


def api_get(path, params=None):
    token = get_access_token()
    url = f"{BASE_URL}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def format_activity(a):
    pace = (a["moving_time"] / 60) / (a["distance"] / 1000) if a["distance"] > 0 else None
    return {
        "id": a["id"],
        "name": a.get("name", ""),
        "date": a["start_date_local"][:10],
        "start_time": a["start_date_local"][11:16],
        "distance_km": round(a["distance"] / 1000, 2),
        "duration_minutes": round(a["moving_time"] / 60, 1),
        "avg_pace_min_per_km": round(pace, 2) if pace else None,
        "avg_heart_rate": a.get("average_heartrate"),
        "max_heart_rate": a.get("max_heartrate"),
        "calories": a.get("calories"),
        "elevation_gain_m": a.get("total_elevation_gain"),
        "avg_cadence": round(a["average_cadence"] * 2) if a.get("average_cadence") else None,
        "avg_watts": a.get("average_watts"),
        "kudos": a.get("kudos_count", 0),
        "suffer_score": a.get("suffer_score"),
        "workout_type": a.get("workout_type"),  # 0=default, 1=race, 2=long, 3=workout
    }


def cmd_recent():
    activities = api_get("/athlete/activities", {"per_page": 10, "page": 1})
    runs = [a for a in activities if a["type"] == "Run"]
    print(json.dumps([format_activity(r) for r in runs], indent=2))


def cmd_last():
    activities = api_get("/athlete/activities", {"per_page": 5, "page": 1})
    runs = [a for a in activities if a["type"] == "Run"]
    if not runs:
        print(json.dumps({"error": "No recent runs found."}))
    else:
        print(json.dumps(format_activity(runs[0]), indent=2))


def cmd_today():
    from datetime import datetime, timezone
    start_of_day = int(datetime.now(timezone.utc).replace(hour=0, minute=0, second=0).timestamp())
    activities = api_get("/athlete/activities", {"after": start_of_day, "per_page": 10})
    runs = [a for a in activities if a["type"] == "Run"]
    if not runs:
        print(json.dumps({"message": "No run recorded today yet."}))
    else:
        print(json.dumps([format_activity(r) for r in runs], indent=2))


def cmd_stats():
    from datetime import datetime, timezone, timedelta
    now = datetime.now(timezone.utc)
    week_start = int((now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0).timestamp())
    month_start = int(now.replace(day=1, hour=0, minute=0, second=0).timestamp())

    weekly = api_get("/athlete/activities", {"after": week_start, "per_page": 30})
    monthly = api_get("/athlete/activities", {"after": month_start, "per_page": 50})

    def summarize(activities):
        runs = [a for a in activities if a["type"] == "Run"]
        if not runs:
            return {"runs": 0, "total_km": 0, "total_minutes": 0}
        total_dist = sum(r["distance"] for r in runs) / 1000
        total_time = sum(r["moving_time"] for r in runs) / 60
        return {
            "runs": len(runs),
            "total_km": round(total_dist, 2),
            "total_minutes": round(total_time, 1),
            "avg_pace_min_per_km": round(total_time / total_dist, 2) if total_dist > 0 else None
        }

    print(json.dumps({
        "this_week": summarize(weekly),
        "this_month": summarize(monthly)
    }, indent=2))


def cmd_activity(activity_id):
    activity = api_get(f"/activities/{activity_id}")
    result = format_activity(activity)

    # Add laps/splits if available
    if activity.get("laps"):
        result["splits"] = [
            {
                "lap": i + 1,
                "distance_km": round(lap["distance"] / 1000, 2),
                "pace_min_per_km": round((lap["moving_time"] / 60) / (lap["distance"] / 1000), 2) if lap["distance"] > 0 else None,
                "avg_heart_rate": lap.get("average_heartrate")
            }
            for i, lap in enumerate(activity["laps"])
        ]

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "recent"

    if cmd == "recent":
        cmd_recent()
    elif cmd == "last":
        cmd_last()
    elif cmd == "today":
        cmd_today()
    elif cmd == "stats":
        cmd_stats()
    elif cmd == "activity" and len(sys.argv) > 2:
        cmd_activity(sys.argv[2])
    else:
        print(json.dumps({"error": f"Unknown command: {cmd}"}))
        sys.exit(1)
