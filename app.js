const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
const dateInputPattern = /^\d{4}-\d{2}-\d{2}$/;

const state = {
  rows: [],
  places: [],
  summary: null,
  selectedPlaces: new Set(),
  currentStart: null,
  currentEnd: null,
  isEditingDateInput: false,
  chartEventsBound: false,
  activeMatchDate: null,
};

const elements = {
  chart: document.getElementById("chart"),
  dataNote: document.getElementById("data-note"),
  datasetSummary: document.getElementById("dataset-summary"),
  selectionStats: document.getElementById("selection-stats"),
  metricSelect: document.getElementById("metric-select"),
  startDate: document.getElementById("start-date"),
  startDateButton: document.getElementById("start-date-button"),
  startDatePicker: document.getElementById("start-date-picker"),
  endDate: document.getElementById("end-date"),
  endDateButton: document.getElementById("end-date-button"),
  endDatePicker: document.getElementById("end-date-picker"),
  themeSelect: document.getElementById("theme-select"),
  resetZoom: document.getElementById("reset-zoom"),
  refreshData: document.getElementById("refresh-data"),
  yScale: document.getElementById("y-scale"),
  yScaleValue: document.getElementById("y-scale-value"),
  placeSelectors: document.getElementById("place-selectors"),
  placeForm: document.getElementById("place-form"),
  placeName: document.getElementById("place-name"),
  placeLatitude: document.getElementById("place-latitude"),
  placeLongitude: document.getElementById("place-longitude"),
  placeStatus: document.getElementById("place-status"),
};

const formatDate = new Intl.DateTimeFormat("sv-SE", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

init();

async function init() {
  applyStoredTheme();
  await loadDataset();
  renderSummary();
  renderPlaceSelectors();
  wireEvents();
  setDefaultRange();
}

async function loadDataset() {
  const response = await fetch("/api/dataset");
  const payload = await response.json();
  state.rows = payload.rows;
  state.places = payload.places;
  state.summary = payload.summary;
  if (!state.selectedPlaces.size) {
    state.places.forEach((place) => state.selectedPlaces.add(place.name));
  }
}

function wireEvents() {
  elements.metricSelect.addEventListener("change", drawChart);
  elements.startDate.addEventListener("focus", () => {
    state.isEditingDateInput = true;
  });
  elements.endDate.addEventListener("focus", () => {
    state.isEditingDateInput = true;
  });
  elements.startDate.addEventListener("blur", onDateBlur);
  elements.endDate.addEventListener("blur", onDateBlur);
  elements.startDate.addEventListener("change", applyDateInputs);
  elements.endDate.addEventListener("change", applyDateInputs);
  elements.startDateButton.addEventListener("click", () => openDatePicker(elements.startDatePicker));
  elements.endDateButton.addEventListener("click", () => openDatePicker(elements.endDatePicker));
  elements.startDatePicker.addEventListener("change", () => applyPickerValue(elements.startDate, elements.startDatePicker));
  elements.endDatePicker.addEventListener("change", () => applyPickerValue(elements.endDate, elements.endDatePicker));
  elements.themeSelect.addEventListener("change", onThemeChange);
  elements.yScale.addEventListener("input", onYScaleChange);
  elements.resetZoom.addEventListener("click", () => {
    state.currentStart = null;
    state.currentEnd = null;
    drawChart();
  });
  elements.refreshData.addEventListener("click", refreshDataset);
  elements.placeForm.addEventListener("submit", savePlace);
  mediaQuery.addEventListener("change", () => {
    if (elements.themeSelect.value === "system") {
      applyTheme("system");
      drawChart();
    }
  });
  updateYScaleLabel();
}

function renderSummary() {
  const summary = state.summary;
  elements.dataNote.textContent = `Coverage ${summary.date_start} to ${summary.date_end}. Updated ${formatTimestamp(summary.generated_at)}.`;
  elements.datasetSummary.innerHTML = [
    statCard("Coverage", `${summary.date_start} to ${summary.date_end}`),
    statCard("Places", summary.place_count.toLocaleString("en-US")),
    statCard("Daily rows", summary.row_count.toLocaleString("en-US")),
    statCard("Timezone", "Europe/Stockholm"),
  ].join("");
}

function renderPlaceSelectors() {
  elements.placeSelectors.innerHTML = state.places
    .map(
      (place) => `
        <div class="place-chip">
          <label class="place-chip-toggle">
            <input type="checkbox" value="${escapeHtml(place.name)}" ${state.selectedPlaces.has(place.name) ? "checked" : ""} />
            <span>${escapeHtml(place.name)}</span>
          </label>
          ${place.can_delete ? `<button type="button" class="place-delete" data-place-id="${place.id}" data-place-name="${escapeHtml(place.name)}" aria-label="Delete ${escapeHtml(place.name)}">x</button>` : ""}
        </div>
      `
    )
    .join("");

  elements.placeSelectors.querySelectorAll("input").forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) state.selectedPlaces.add(input.value);
      else state.selectedPlaces.delete(input.value);
      drawChart();
    });
  });

  elements.placeSelectors.querySelectorAll(".place-delete").forEach((button) => {
    button.addEventListener("click", () => {
      deletePlace(Number(button.dataset.placeId), button.dataset.placeName);
    });
  });
}

function setDefaultRange() {
  state.currentStart = `${new Date().getUTCFullYear()}-01-01`;
  state.currentEnd = `${new Date().getUTCFullYear()}-12-31`;
  drawChart();
}

function applyDateInputs() {
  const start = normalizeDateInputValue(elements.startDate.value);
  const end = normalizeDateInputValue(elements.endDate.value);
  elements.startDate.value = start;
  elements.endDate.value = end;
  elements.startDatePicker.value = start;
  elements.endDatePicker.value = end;
  if (start && end && start > end) {
    elements.endDate.value = start;
    elements.endDatePicker.value = start;
  }
  state.currentStart = elements.startDate.value || null;
  state.currentEnd = elements.endDate.value || null;
  drawChart();
}

async function refreshDataset() {
  const buttonText = elements.refreshData.textContent;
  elements.refreshData.disabled = true;
  elements.refreshData.textContent = "Recalculating...";
  try {
    const response = await fetch("/api/refresh", { method: "POST" });
    if (!response.ok) throw new Error("Recalculation failed");
    await loadDataset();
    renderSummary();
    renderPlaceSelectors();
    drawChart();
  } catch (error) {
    window.alert(`Refresh failed: ${error.message}`);
  } finally {
    elements.refreshData.disabled = false;
    elements.refreshData.textContent = buttonText;
  }
}

async function savePlace(event) {
  event.preventDefault();
  const payload = {
    name: elements.placeName.value.trim(),
    latitude: elements.placeLatitude.value.trim().replace(",", "."),
    longitude: elements.placeLongitude.value.trim().replace(",", "."),
  };
  elements.placeStatus.textContent = "Calculating...";
  try {
    const response = await fetch("/api/place", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error("Place save failed");
    await loadDataset();
    state.selectedPlaces.add(payload.name);
    renderSummary();
    renderPlaceSelectors();
    drawChart();
    elements.placeForm.reset();
    elements.placeStatus.textContent = `Saved ${payload.name}.`;
  } catch (error) {
    elements.placeStatus.textContent = `Save failed: ${error.message}`;
  }
}

async function deletePlace(placeId, placeName) {
  elements.placeStatus.textContent = `Deleting ${placeName}...`;
  try {
    const response = await fetch(`/api/place/${placeId}`, { method: "DELETE" });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error || "Place delete failed");
    }
    await loadDataset();
    state.selectedPlaces.delete(placeName);
    renderSummary();
    renderPlaceSelectors();
    drawChart();
    elements.placeStatus.textContent = `Deleted ${placeName}.`;
  } catch (error) {
    elements.placeStatus.textContent = `Delete failed: ${error.message}`;
  }
}

function drawChart() {
  const theme = getTheme();
  const metric = elements.metricSelect.value;
  const selected = state.rows.filter((row) => state.selectedPlaces.has(row.place_name) && withinRange(row.date));
  const grouped = groupByPlace(selected);
  const palette = theme.palette;

  const traces = buildTraces(grouped, metric, palette);
  const tickValues = buildTickValues(metric, selected);
  const yRange = buildYRange(metric, selected);

  Plotly.newPlot(
    elements.chart,
    traces,
    {
      paper_bgcolor: theme.paper,
      plot_bgcolor: theme.plot,
      font: { color: theme.text },
      height: getChartHeight(metric),
      margin: { t: 24, r: 18, b: 56, l: 92 },
      hovermode: "closest",
      legend: { orientation: "h", x: 0, y: 1.12 },
      xaxis: {
        title: "Date",
        gridcolor: theme.grid,
        rangeslider: { visible: true, bgcolor: theme.plot, bordercolor: theme.grid },
      },
      yaxis: {
        title: metricLabel(metric),
        titlefont: { size: 14 },
        title_standoff: 18,
        gridcolor: theme.grid,
        tickmode: "array",
        tickvals: tickValues,
        ticktext: tickValues.map((value) => formatMetricValue(value, metric === "sun_times" ? "sunrise_minutes" : metric)),
        range: yRange,
      },
      shapes: buildMatchShapes(metric),
    },
    { responsive: true, displaylogo: false }
  );

  if (!state.chartEventsBound) {
    elements.chart.on("plotly_relayout", (event) => {
      const start = event["xaxis.range[0]"];
      const end = event["xaxis.range[1]"];
      if (start && end) {
        state.currentStart = start.slice(0, 10);
        state.currentEnd = end.slice(0, 10);
        syncDateInputs();
        renderSelectionStats(selected, metric);
        return;
      }
      if (event["xaxis.autorange"]) {
        state.currentStart = null;
        state.currentEnd = null;
        syncDateInputs();
        renderSelectionStats(selected, metric);
      }
    });
    elements.chart.on("plotly_hover", (event) => {
      if (!event.points?.[0]) {
        return;
      }

      const point = event.points[0];
      const metric = elements.metricSelect.value;
      if (metric !== "daylight_minutes" && metric !== "sun_times") {
        return;
      }

      const matchDate = metric === "daylight_minutes"
        ? findMatchingDate(point.data.meta.placeName, point.x, "daylight_minutes")
        : findMatchingDate(point.data.meta.placeName, point.x, point.data.meta.metric);
      if (!matchDate || matchDate === point.x) {
        if (state.activeMatchDate !== null) {
          state.activeMatchDate = null;
          Plotly.relayout(elements.chart, { shapes: [] });
        }
        return;
      }

      if (state.activeMatchDate === matchDate) {
        return;
      }

      state.activeMatchDate = matchDate;
      Plotly.relayout(elements.chart, {
        shapes: buildMatchShapes(metric),
      });
    });
    state.chartEventsBound = true;
  }

  syncDateBounds();
  syncDateInputs();
  renderSelectionStats(selected, metric);
}

function renderSelectionStats(rows, metric) {
  if (!rows.length) {
    elements.selectionStats.innerHTML = "<p>No data in this selection.</p>";
    return;
  }
  const grouped = groupByPlace(rows);
  elements.selectionStats.innerHTML = Object.entries(grouped)
    .map(([placeName, placeRows]) => {
      if (metric === "sun_times") {
        const avgSunrise = placeRows.reduce((sum, row) => sum + row.sunrise_minutes, 0) / placeRows.length;
        const avgSunset = placeRows.reduce((sum, row) => sum + row.sunset_minutes, 0) / placeRows.length;
        const earliestSunrise = placeRows.reduce((best, row) => (row.sunrise_minutes < best.sunrise_minutes ? row : best));
        const latestSunset = placeRows.reduce((best, row) => (row.sunset_minutes > best.sunset_minutes ? row : best));
        return [
          statCard(`${placeName} span`, `${placeRows[0].date} to ${placeRows[placeRows.length - 1].date}`),
          statCard(`${placeName} avg sunrise`, formatMetricValue(avgSunrise, "sunrise_minutes")),
          statCard(`${placeName} avg sunset`, formatMetricValue(avgSunset, "sunset_minutes")),
          statCard(`${placeName} earliest sunrise`, `${formatMetricValue(earliestSunrise.sunrise_minutes, "sunrise_minutes")} · ${earliestSunrise.date}`),
          statCard(`${placeName} latest sunset`, `${formatMetricValue(latestSunset.sunset_minutes, "sunset_minutes")} · ${latestSunset.date}`),
        ].join("");
      }

      const minRow = placeRows.reduce((best, row) => (row[metric] < best[metric] ? row : best));
      const maxRow = placeRows.reduce((best, row) => (row[metric] > best[metric] ? row : best));
      const avg = placeRows.reduce((sum, row) => sum + row[metric], 0) / placeRows.length;
      return [
        statCard(`${placeName} span`, `${placeRows[0].date} to ${placeRows[placeRows.length - 1].date}`),
        statCard(`${placeName} avg`, formatMetricValue(avg, metric)),
        statCard(`${placeName} min`, `${formatMetricValue(minRow[metric], metric)} · ${minRow.date}`),
        statCard(`${placeName} max`, `${formatMetricValue(maxRow[metric], metric)} · ${maxRow.date}`),
      ].join("");
    })
    .join("");
}

function groupByPlace(rows) {
  return rows.reduce((groups, row) => {
    groups[row.place_name] ||= [];
    groups[row.place_name].push(row);
    return groups;
  }, {});
}

function findMatchingDate(placeName, dateText, metric) {
  const target = state.rows.find((row) => row.place_name === placeName && row.date === dateText);
  if (!target) {
    return null;
  }

  const year = dateText.slice(0, 4);
  const solstice = `${year}-06-21`;
  const candidates = state.rows.filter((row) => {
    if (row.place_name !== placeName || row.date.slice(0, 4) !== year || row.date === dateText) {
      return false;
    }
    if (dateText < solstice) {
      return row.date > solstice;
    }
    if (dateText > solstice) {
      return row.date < solstice;
    }
    return false;
  });

  if (!candidates.length) {
    return null;
  }

  const best = candidates.reduce((closest, row) => {
    const diff = Math.abs(row[metric] - target[metric]);
    const bestDiff = Math.abs(closest[metric] - target[metric]);
    if (diff !== bestDiff) {
      return diff < bestDiff ? row : closest;
    }

    const distance = Math.abs(new Date(row.date).getTime() - new Date(target.date).getTime());
    const bestDistance = Math.abs(new Date(closest.date).getTime() - new Date(target.date).getTime());
    return distance > bestDistance ? row : closest;
  });

  return best.date;
}

function formatMatchingDaylightLabel(placeName, dateText) {
  const matchDate = findMatchingDate(placeName, dateText, "daylight_minutes");
  return matchDate ? formatDateLabel(matchDate) : "none";
}

function formatMatchingMetricLabel(placeName, dateText, metric) {
  const matchDate = findMatchingDate(placeName, dateText, metric);
  return matchDate ? formatDateLabel(matchDate) : "none";
}

function withinRange(dateText) {
  if (state.currentStart && dateText < state.currentStart) return false;
  if (state.currentEnd && dateText > state.currentEnd) return false;
  return true;
}

function syncDateBounds() {
  const start = state.summary.date_start;
  const end = state.summary.date_end;
  elements.startDate.placeholder = start;
  elements.startDate.title = `${start} to ${end}`;
  elements.startDatePicker.min = start;
  elements.startDatePicker.max = end;
  elements.endDate.placeholder = end;
  elements.endDate.title = `${start} to ${end}`;
  elements.endDatePicker.min = start;
  elements.endDatePicker.max = end;
}

function syncDateInputs() {
  if (state.isEditingDateInput) return;
  elements.startDate.value = state.currentStart ?? state.summary.date_start;
  elements.endDate.value = state.currentEnd ?? state.summary.date_end;
  elements.startDatePicker.value = elements.startDate.value;
  elements.endDatePicker.value = elements.endDate.value;
}

function onDateBlur() {
  state.isEditingDateInput = false;
  syncDateInputs();
}

function normalizeDateInputValue(value) {
  const trimmed = String(value).trim();
  if (!trimmed) {
    return "";
  }

  const normalized = trimmed.replace(/[./]/g, "-");
  if (!dateInputPattern.test(normalized)) {
    return "";
  }

  const parsed = new Date(`${normalized}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  if (parsed.toISOString().slice(0, 10) !== normalized) {
    return "";
  }

  return normalized;
}

function openDatePicker(picker) {
  if (typeof picker.showPicker === "function") {
    picker.showPicker();
    return;
  }

  picker.focus();
  picker.click();
}

function applyPickerValue(input, picker) {
  input.value = picker.value;
  applyDateInputs();
}

function hoverTemplate(metric) {
  if (metric === "sunrise_minutes") {
    return "%{customdata[0]}<br>Sunrise time: %{customdata[4]}<br>Matching day: %{customdata[5]}<br>Sunrise: %{customdata[1]} %{customdata[3]}<br>Sunset: %{customdata[2]} %{customdata[3]}<extra></extra>";
  }
  if (metric === "sunset_minutes") {
    return "%{customdata[0]}<br>Sunset time: %{customdata[4]}<br>Matching day: %{customdata[5]}<br>Sunrise: %{customdata[1]} %{customdata[3]}<br>Sunset: %{customdata[2]} %{customdata[3]}<extra></extra>";
  }
  if (metric === "daylight_minutes") {
    return "%{customdata[0]}<br>Sunshine hours: %{customdata[4]}<br>Matching day: %{customdata[5]}<br>Sunrise: %{customdata[1]} %{customdata[3]}<br>Sunset: %{customdata[2]} %{customdata[3]}<extra></extra>";
  }
  const valueLabel = metricLabel(metric);
  return `%{customdata[0]}<br>${valueLabel}: %{customdata[4]}<br>Sunrise: %{customdata[1]} %{customdata[3]}<br>Sunset: %{customdata[2]} %{customdata[3]}<extra></extra>`;
}

function metricLabel(metric) {
  if (metric === "daylight_minutes") return "Sunshine hours";
  return "Sunrise / sunset time";
}

function formatMetricValue(value, metric) {
  if (metric === "daylight_minutes") {
    const hours = Math.floor(value / 60);
    const minutes = Math.round(value % 60);
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  const hours = Math.floor(value / 60);
  const minutes = Math.round(value % 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function buildTickValues(metric, rows) {
  if (!rows.length) {
    return [];
  }

  const values = metric === "sun_times"
    ? rows.flatMap((row) => [row.sunrise_minutes, row.sunset_minutes])
    : rows.map((row) => row[metric]);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const step = metric === "daylight_minutes" ? 120 : 60;
  const start = Math.floor(minValue / step) * step;
  const end = Math.ceil(maxValue / step) * step;

  const ticks = [];
  for (let value = start; value <= end; value += step) {
    ticks.push(value);
  }
  return ticks;
}

function buildYRange(metric, rows) {
  if (!rows.length) {
    return undefined;
  }

  const values = metric === "sun_times"
    ? rows.flatMap((row) => [row.sunrise_minutes, row.sunset_minutes])
    : rows.map((row) => row[metric]);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const spread = Math.max(maxValue - minValue, metric === "daylight_minutes" ? 90 : 45);
  const padding = Math.max(spread * 0.08, metric === "daylight_minutes" ? 20 : 12);
  return [minValue - padding, maxValue + padding];
}

function buildMatchShapes(metric) {
  if (!state.activeMatchDate || (metric !== "daylight_minutes" && metric !== "sun_times")) {
    return [];
  }

  return [
    {
      type: "line",
      xref: "x",
      yref: "paper",
      x0: state.activeMatchDate,
      x1: state.activeMatchDate,
      y0: 0,
      y1: 1,
      line: {
        color: "#22d3ee",
        width: 2,
        dash: "dot",
      },
    },
  ];
}

function getYScaleFactor() {
  return Number(elements.yScale.value) / 100;
}

function getChartHeight(metric) {
  const baseHeight = metric === "sun_times" ? 900 : 600;
  return Math.round(baseHeight * getYScaleFactor());
}

function onYScaleChange() {
  updateYScaleLabel();
  Plotly.relayout(elements.chart, {
    height: getChartHeight(elements.metricSelect.value),
    shapes: buildMatchShapes(elements.metricSelect.value),
  });
}

function updateYScaleLabel() {
  elements.yScaleValue.textContent = `${elements.yScale.value}%`;
}

function buildTraces(grouped, metric, palette) {
  if (metric !== "sun_times") {
    return Object.entries(grouped).map(([placeName, rows], index) => ({
      x: rows.map((row) => row.date),
      y: rows.map((row) => row[metric]),
      customdata: rows.map((row) => [
        formatDateLabel(row.date),
        row.sunrise_local,
        row.sunset_local,
        row.timezone_name,
        formatMetricValue(row[metric], metric),
        metric === "daylight_minutes" ? formatMatchingDaylightLabel(placeName, row.date) : "",
      ]),
      type: "scatter",
      mode: "lines",
      name: placeName,
      meta: { placeName, metric },
      line: { color: palette[index % palette.length], width: 2.5, shape: "spline", smoothing: 1.05 },
      hovertemplate: hoverTemplate(metric),
    }));
  }

  return Object.entries(grouped).flatMap(([placeName, rows], index) => {
    const color = palette[index % palette.length];
    return [
      {
        x: rows.map((row) => row.date),
        y: rows.map((row) => row.sunrise_minutes),
        type: "scatter",
        mode: "lines",
        name: `${placeName} sunrise`,
        meta: { placeName, metric: "sunrise_minutes" },
        customdata: rows.map((row) => [
          formatDateLabel(row.date),
          row.sunrise_local,
          row.sunset_local,
          row.timezone_name,
          formatMetricValue(row.sunrise_minutes, "sunrise_minutes"),
          formatMatchingMetricLabel(placeName, row.date, "sunrise_minutes"),
        ]),
        line: { color, width: 2.2, dash: "dot", shape: "spline", smoothing: 1.05 },
        hovertemplate: hoverTemplate("sunrise_minutes"),
      },
      {
        x: rows.map((row) => row.date),
        y: rows.map((row) => row.sunset_minutes),
        customdata: rows.map((row) => [
          formatDateLabel(row.date),
          row.sunrise_local,
          row.sunset_local,
          row.timezone_name,
          formatMetricValue(row.sunset_minutes, "sunset_minutes"),
          formatMatchingMetricLabel(placeName, row.date, "sunset_minutes"),
        ]),
        type: "scatter",
        mode: "lines",
        name: `${placeName} sunset`,
        meta: { placeName, metric: "sunset_minutes" },
        line: { color, width: 2.8, shape: "spline", smoothing: 1.05 },
        hovertemplate: hoverTemplate("sunset_minutes"),
      },
    ];
  });
}

function formatTimestamp(timestamp) {
  return new Date(timestamp).toLocaleString("sv-SE", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function formatDateLabel(dateText) {
  return formatDate.format(new Date(`${dateText}T00:00:00Z`));
}

function statCard(label, value) {
  return `<div class="stat-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function applyStoredTheme() {
  const storedTheme = window.localStorage.getItem("sunshine-theme") || "system";
  elements.themeSelect.value = storedTheme;
  applyTheme(storedTheme);
}

function onThemeChange() {
  const value = elements.themeSelect.value;
  window.localStorage.setItem("sunshine-theme", value);
  applyTheme(value);
  drawChart();
}

function applyTheme(theme) {
  if (theme === "system") {
    document.documentElement.dataset.theme = mediaQuery.matches ? "dark" : "light";
    return;
  }
  document.documentElement.dataset.theme = theme;
}

function getTheme() {
  const dark = document.documentElement.dataset.theme === "dark";
  return dark
    ? {
        paper: "#0b1220",
        plot: "#111827",
        text: "#e5eefb",
        grid: "rgba(148, 163, 184, 0.2)",
        palette: ["#f59e0b", "#22d3ee", "#34d399", "#f472b6", "#a78bfa"],
      }
    : {
        paper: "#f8fafc",
        plot: "#ffffff",
        text: "#162033",
        grid: "rgba(51, 65, 85, 0.12)",
        palette: ["#d97706", "#0891b2", "#059669", "#db2777", "#7c3aed"],
      };
}
