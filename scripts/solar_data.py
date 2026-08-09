from __future__ import annotations

import json
import math
import sqlite3
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "sunshine_hours.sqlite"
TIMEZONE = ZoneInfo("Europe/Stockholm")
START_DATE = date(2020, 1, 1)
END_DATE = date(2030, 12, 31)
ZENITH = 90.833

DEFAULT_PLACES = [
    {"name": "Solna", "latitude": 59.36004, "longitude": 18.00086},
]


def connect_db() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    init_schema(connection)
    return connection


def init_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS places (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            latitude REAL NOT NULL,
            longitude REAL NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS solar_days (
            place_id INTEGER NOT NULL,
            date TEXT NOT NULL,
            sunrise_local TEXT,
            sunset_local TEXT,
            sunrise_minutes INTEGER,
            sunset_minutes INTEGER,
            daylight_minutes INTEGER,
            timezone_name TEXT NOT NULL,
            PRIMARY KEY (place_id, date),
            FOREIGN KEY(place_id) REFERENCES places(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        """
    )
    connection.commit()


def seed_defaults() -> None:
    with connect_db() as connection:
        for place in DEFAULT_PLACES:
            ensure_place(connection, place["name"], place["latitude"], place["longitude"])


def ensure_place(connection: sqlite3.Connection, name: str, latitude: float, longitude: float) -> int:
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    connection.execute(
        """
        INSERT INTO places (name, latitude, longitude, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET latitude = excluded.latitude, longitude = excluded.longitude
        """,
        (name, latitude, longitude, now),
    )
    place_id = connection.execute("SELECT id FROM places WHERE name = ?", (name,)).fetchone()[0]
    rebuild_place(connection, place_id)
    rebuild_metadata(connection)
    connection.commit()
    return place_id


def rebuild_place(connection: sqlite3.Connection, place_id: int) -> None:
    place = connection.execute("SELECT * FROM places WHERE id = ?", (place_id,)).fetchone()
    connection.execute("DELETE FROM solar_days WHERE place_id = ?", (place_id,))

    rows = []
    current = START_DATE
    while current <= END_DATE:
        sunrise_utc, sunset_utc = calculate_sun_events(current, place["latitude"], place["longitude"])
        sunrise_local = sunrise_utc.astimezone(TIMEZONE)
        sunset_local = sunset_utc.astimezone(TIMEZONE)
        sunrise_minutes = sunrise_local.hour * 60 + sunrise_local.minute
        sunset_minutes = sunset_local.hour * 60 + sunset_local.minute
        daylight_minutes = int(round((sunset_utc - sunrise_utc).total_seconds() / 60))
        rows.append(
            (
                place_id,
                current.isoformat(),
                sunrise_local.strftime("%H:%M"),
                sunset_local.strftime("%H:%M"),
                sunrise_minutes,
                sunset_minutes,
                daylight_minutes,
                sunrise_local.tzname() or "CET",
            )
        )
        current += timedelta(days=1)

    connection.executemany(
        """
        INSERT INTO solar_days (
            place_id, date, sunrise_local, sunset_local, sunrise_minutes,
            sunset_minutes, daylight_minutes, timezone_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )


def rebuild_metadata(connection: sqlite3.Connection) -> dict:
    stats = connection.execute(
        """
        SELECT MIN(date) AS date_start, MAX(date) AS date_end, COUNT(*) AS row_count
        FROM solar_days
        """
    ).fetchone()
    place_count = connection.execute("SELECT COUNT(*) FROM places").fetchone()[0]
    summary = {
        "date_start": stats["date_start"],
        "date_end": stats["date_end"],
        "row_count": stats["row_count"],
        "place_count": place_count,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    connection.execute(
        "INSERT INTO metadata (key, value) VALUES ('summary', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (json.dumps(summary, ensure_ascii=True, separators=(",", ":")),),
    )
    return summary


def calculate_sun_events(day: date, latitude: float, longitude: float) -> tuple[datetime, datetime]:
    sunrise_utc_hours = calculate_event_utc_hours(day, latitude, longitude, True)
    sunset_utc_hours = calculate_event_utc_hours(day, latitude, longitude, False)
    base = datetime.combine(day, time.min, tzinfo=timezone.utc)
    sunrise_utc = base + timedelta(hours=sunrise_utc_hours)
    sunset_utc = base + timedelta(hours=sunset_utc_hours)
    return sunrise_utc, sunset_utc


def calculate_event_utc_hours(day: date, latitude: float, longitude: float, sunrise: bool) -> float:
    day_of_year = day.timetuple().tm_yday
    lng_hour = longitude / 15.0
    approx = day_of_year + ((6 - lng_hour) / 24 if sunrise else (18 - lng_hour) / 24)
    mean_anomaly = (0.9856 * approx) - 3.289
    true_longitude = mean_anomaly + (1.916 * math.sin(math.radians(mean_anomaly))) + (0.020 * math.sin(math.radians(2 * mean_anomaly))) + 282.634
    true_longitude = normalize_degrees(true_longitude)

    right_ascension = math.degrees(math.atan(0.91764 * math.tan(math.radians(true_longitude))))
    right_ascension = normalize_degrees(right_ascension)
    true_longitude_quadrant = math.floor(true_longitude / 90) * 90
    right_ascension_quadrant = math.floor(right_ascension / 90) * 90
    right_ascension = (right_ascension + (true_longitude_quadrant - right_ascension_quadrant)) / 15

    sin_declination = 0.39782 * math.sin(math.radians(true_longitude))
    cos_declination = math.cos(math.asin(sin_declination))
    cos_hour_angle = (
        math.cos(math.radians(ZENITH))
        - (sin_declination * math.sin(math.radians(latitude)))
    ) / (cos_declination * math.cos(math.radians(latitude)))

    if cos_hour_angle > 1 or cos_hour_angle < -1:
        raise ValueError("Sun never rises or sets for this date/location")

    if sunrise:
        hour_angle = 360 - math.degrees(math.acos(cos_hour_angle))
    else:
        hour_angle = math.degrees(math.acos(cos_hour_angle))
    hour_angle /= 15

    local_mean_time = hour_angle + right_ascension - (0.06571 * approx) - 6.622
    utc_hours = normalize_hours(local_mean_time - lng_hour)
    return utc_hours


def normalize_degrees(value: float) -> float:
    return value % 360


def normalize_hours(value: float) -> float:
    return value % 24


def get_dataset_payload() -> dict:
    with connect_db() as connection:
        summary_row = connection.execute("SELECT value FROM metadata WHERE key = 'summary'").fetchone()
        if summary_row is None:
            seed_defaults()
            summary_row = connection.execute("SELECT value FROM metadata WHERE key = 'summary'").fetchone()
        summary = json.loads(summary_row["value"])
        places = [dict(row) for row in connection.execute("SELECT * FROM places ORDER BY name")]
        rows = [
            dict(row)
            for row in connection.execute(
                """
                SELECT p.name AS place_name, p.latitude, p.longitude, s.*
                FROM solar_days s
                JOIN places p ON p.id = s.place_id
                ORDER BY p.name, s.date
                """
            )
        ]
    return {"summary": summary, "places": places, "rows": rows}


def main() -> None:
    seed_defaults()
    with connect_db() as connection:
        summary = rebuild_metadata(connection)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
