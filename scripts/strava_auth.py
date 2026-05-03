"""
One-time Strava OAuth setup. Run this once to get your refresh token.
Usage: python strava_auth.py
"""

import json
import os
import webbrowser
import urllib.parse
import urllib.request
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler

CREDENTIALS_FILE = Path(__file__).parent.parent / "data" / "strava_credentials.json"
REDIRECT_URI = "http://localhost:8080/callback"
auth_code = None


class CallbackHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        global auth_code
        params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        if "code" in params:
            auth_code = params["code"][0]
            self.send_response(200)
            self.send_header("Content-type", "text/html")
            self.end_headers()
            self.wfile.write(b"<h2>Success! You can close this tab and go back to the terminal.</h2>")
        else:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b"<h2>Error: no code received.</h2>")

    def log_message(self, format, *args):
        pass  # suppress server logs


def main():
    print("=== Strava One-Time Setup ===\n")

    client_id = input("Enter your Strava Client ID: ").strip()
    client_secret = input("Enter your Strava Client Secret: ").strip()

    auth_url = (
        f"https://www.strava.com/oauth/authorize"
        f"?client_id={client_id}"
        f"&response_type=code"
        f"&redirect_uri={urllib.parse.quote(REDIRECT_URI)}"
        f"&approval_prompt=force"
        f"&scope=activity:read_all"
    )

    print("\nOpening Strava in your browser...")
    print("Log in and click 'Authorize'. You'll be redirected back automatically.\n")
    webbrowser.open(auth_url)

    server = HTTPServer(("localhost", 8080), CallbackHandler)
    print("Waiting for authorization...")
    server.handle_request()

    if not auth_code:
        print("Failed to get auth code. Try again.")
        return

    # Exchange code for tokens
    data = urllib.parse.urlencode({
        "client_id": client_id,
        "client_secret": client_secret,
        "code": auth_code,
        "grant_type": "authorization_code"
    }).encode()

    req = urllib.request.Request("https://www.strava.com/oauth/token", data=data, method="POST")
    with urllib.request.urlopen(req) as response:
        tokens = json.loads(response.read())

    credentials = {
        "client_id": client_id,
        "client_secret": client_secret,
        "access_token": tokens["access_token"],
        "refresh_token": tokens["refresh_token"],
        "expires_at": tokens["expires_at"]
    }

    CREDENTIALS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(CREDENTIALS_FILE, "w") as f:
        json.dump(credentials, f, indent=2)

    print(f"\nSetup complete! Credentials saved to:\n{CREDENTIALS_FILE}")
    print("\nYou can now ask Claude about your runs.")


if __name__ == "__main__":
    main()
