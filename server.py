from __future__ import annotations

import json
import subprocess
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from scripts.solar_data import connect_db, ensure_place, get_dataset_payload


ROOT = Path(__file__).resolve().parent


class AppHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self) -> None:
        if urlparse(self.path).path == "/api/dataset":
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(get_dataset_payload()).encode("utf-8"))
            return
        super().do_GET()

    def do_POST(self) -> None:
        if self.path == "/api/place":
            self.handle_place_upsert()
            return
        if self.path != "/api/refresh":
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return

        result = subprocess.run(
            ["python3", str(ROOT / "scripts" / "solar_data.py")],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            self.send_response(HTTPStatus.INTERNAL_SERVER_ERROR)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": False, "stderr": result.stderr, "stdout": result.stdout}).encode("utf-8"))
            return

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"ok": True, "summary": json.loads(result.stdout)}).encode("utf-8"))

    def handle_place_upsert(self) -> None:
        content_length = int(self.headers.get("Content-Length", "0"))
        try:
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
            name = payload["name"].strip()
            latitude = parse_coordinate(payload["latitude"])
            longitude = parse_coordinate(payload["longitude"])
        except (KeyError, ValueError, json.JSONDecodeError):
            self.send_response(HTTPStatus.BAD_REQUEST)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": False, "error": "Invalid place payload"}).encode("utf-8"))
            return

        if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
            self.send_response(HTTPStatus.BAD_REQUEST)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": False, "error": "Coordinates out of range"}).encode("utf-8"))
            return

        with connect_db() as connection:
            place_id = ensure_place(connection, name, latitude, longitude)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"ok": True, "place_id": place_id}).encode("utf-8"))


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 10000), AppHandler)
    print("Serving Sunshine Hours at http://127.0.0.1:10000")
    server.serve_forever()


def parse_coordinate(value: object) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    return float(str(value).strip().replace(",", "."))


if __name__ == "__main__":
    main()
