# Sunshine Hours

Browser app for exploring computed sunrise, sunset, and daylight duration by place, backed by SQLite.

## Run

```bash
python3 scripts/solar_data.py
python3 server.py
```

Open `http://127.0.0.1:10000` in a browser.

## Storage

- SQLite database: `data/sunshine_hours.sqlite`

## Features

- Computed sunrise and sunset from latitude/longitude
- Swedish local civil time (`Europe/Stockholm`)
- Multiple places with overlay graphs
- Add more places from the browser
- Light/dark mode and zoomable Plotly charts
