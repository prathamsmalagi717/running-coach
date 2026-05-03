# Running Coach — Setup Guide

## Overview

```
Apple Watch → Strava (already syncing) → Strava API → Claude
```

You only need to do this setup once. After that, just ask Claude about your runs.

---

## Step 1: Create a Strava API App

1. Go to: https://www.strava.com/settings/api
2. Log in if prompted
3. Fill in the form:
   - **Application Name:** anything (e.g. "My Running Coach")
   - **Category:** Personal
   - **Website:** http://localhost
   - **Authorization Callback Domain:** localhost
4. Click **Create**
5. You'll see your **Client ID** and **Client Secret** — keep this page open

---

## Step 2: Run the Auth Setup Script

Open a terminal in your projects folder and run:

```bash
python "F:/Pratham/Projects/my-skills/running-coach/scripts/strava_auth.py"
```

It will:
1. Ask for your Client ID and Client Secret (from Step 1)
2. Open Strava in your browser — click **Authorize**
3. Automatically capture the token
4. Save credentials to `data/strava_credentials.json`

That's it. You're connected.

---

## Step 3: Test It

Ask Claude any of these:
- "How was my last run?"
- "How many km did I run this week?"
- "Am I getting faster?"

---

## Troubleshooting

- **"No credentials found"** → Run `strava_auth.py` again
- **"Port 8080 already in use"** → Close other apps using that port and retry
- **Browser doesn't open** → Copy the URL printed in the terminal and paste it manually
- **Token expired errors** → The script auto-refreshes tokens, but if it fails run `strava_auth.py` again
