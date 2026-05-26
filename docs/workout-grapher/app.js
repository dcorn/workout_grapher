const DATA_URL = "./data/workout-data.json";
const KG_TO_LB = 2.2046226218;

const ranges = [
  { label: "30D", days: 30 },
  { label: "90D", days: 90 },
  { label: "180D", days: 180 },
  { label: "365D", days: 365 },
  { label: "All", days: null },
];

const metrics = [
  { key: "bestWeight", label: "Top weight", unit: "lb", format: formatWeight },
  { key: "estimatedOneRepMax", label: "Est. 1RM", unit: "lb", format: formatWeight },
  { key: "sessionVolume", label: "Session volume", unit: "lb", format: formatWeight },
  { key: "totalReps", label: "Total reps", unit: "reps", format: formatCount },
  { key: "bestDuration", label: "Best duration", unit: "time", format: formatDuration },
  { key: "bestDistance", label: "Best distance", unit: "km", format: formatDistance },
];

const state = {
  data: null,
  exerciseId: "",
  rangeDays: 90,
  metric: "estimatedOneRepMax",
};

const els = {
  lastSynced: document.querySelector("#lastSynced"),
  exerciseSelect: document.querySelector("#exerciseSelect"),
  metricSelect: document.querySelector("#metricSelect"),
  rangeButtons: document.querySelector("#rangeButtons"),
  chartKicker: document.querySelector("#chartKicker"),
  chartTitle: document.querySelector("#chartTitle"),
  chart: document.querySelector("#chart"),
  bestLabel: document.querySelector("#bestLabel"),
  bestValue: document.querySelector("#bestValue"),
  sessionCount: document.querySelector("#sessionCount"),
  firstValue: document.querySelector("#firstValue"),
  latestValue: document.querySelector("#latestValue"),
  changeValue: document.querySelector("#changeValue"),
  tableHint: document.querySelector("#tableHint"),
  sessionRows: document.querySelector("#sessionRows"),
};

init();

async function init() {
  buildRanges();
  buildMetrics();

  try {
    const response = await fetch(DATA_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`Data file returned ${response.status}`);
    state.data = await response.json();
  } catch (error) {
    renderLoadError(error);
    return;
  }

  const exercises = getExercisesWithHistory();
  state.exerciseId = exercises[0]?.id || "";
  buildExercises(exercises);
  render();

  els.exerciseSelect.addEventListener("change", (event) => {
    state.exerciseId = event.target.value;
    chooseBestMetric();
    render();
  });

  els.metricSelect.addEventListener("change", (event) => {
    state.metric = event.target.value;
    render();
  });
}

function buildRanges() {
  ranges.forEach((range) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = range.label;
    button.setAttribute("aria-pressed", String(range.days === state.rangeDays));
    button.addEventListener("click", () => {
      state.rangeDays = range.days;
      render();
    });
    els.rangeButtons.append(button);
  });
}

function buildMetrics() {
  metrics.forEach((metric) => {
    const option = document.createElement("option");
    option.value = metric.key;
    option.textContent = metric.label;
    els.metricSelect.append(option);
  });
  els.metricSelect.value = state.metric;
}

function buildExercises(exercises) {
  els.exerciseSelect.innerHTML = "";
  if (!exercises.length) {
    const option = document.createElement("option");
    option.textContent = "No exercise history found";
    els.exerciseSelect.append(option);
    els.exerciseSelect.disabled = true;
    return;
  }

  exercises.forEach((exercise) => {
    const option = document.createElement("option");
    option.value = exercise.id;
    option.textContent = exercise.title || exercise.name || exercise.id;
    els.exerciseSelect.append(option);
  });
  els.exerciseSelect.value = state.exerciseId;
  chooseBestMetric();
}

function chooseBestMetric() {
  const sessions = getSessionsForExercise(state.exerciseId);
  const available = metrics.find((metric) => sessions.some((session) => Number.isFinite(session[metric.key])));
  state.metric = available?.key || "totalReps";
  els.metricSelect.value = state.metric;
}

function render() {
  if (!state.data) return;

  document.querySelectorAll("#rangeButtons button").forEach((button, index) => {
    button.setAttribute("aria-pressed", String(ranges[index].days === state.rangeDays));
  });

  const exercise = state.data.exercises.find((item) => item.id === state.exerciseId);
  const metric = metrics.find((item) => item.key === state.metric) || metrics[0];
  const sessions = filterByRange(getSessionsForExercise(state.exerciseId));
  const points = sessions
    .map((session) => ({ date: new Date(session.date), value: session[metric.key], session }))
    .filter((point) => Number.isFinite(point.value))
    .sort((a, b) => a.date - b.date);

  els.lastSynced.textContent = state.data.generatedAt ? formatDateTime(state.data.generatedAt) : "Unknown";
  els.chartKicker.textContent = metric.label;
  els.chartTitle.textContent = exercise?.title || exercise?.name || "Choose an exercise";
  els.bestLabel.textContent = `Best ${metric.label.toLowerCase()}`;

  renderChart(points, metric);
  renderStats(points, metric, sessions);
  renderRows(sessions);
}

function renderChart(points, metric) {
  if (!points.length) {
    els.chart.innerHTML = `<div class="empty-state">No ${metric.label.toLowerCase()} data in this range.</div>`;
    return;
  }

  const width = 920;
  const height = 420;
  const padding = { top: 18, right: 28, bottom: 42, left: 64 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const minDate = points[0].date.getTime();
  const maxDate = points.at(-1).date.getTime();
  const values = points.map((point) => point.value);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const valuePad = maxValue === minValue ? Math.max(maxValue * 0.15, 1) : (maxValue - minValue) * 0.16;
  const yMin = Math.max(0, minValue - valuePad);
  const yMax = maxValue + valuePad;

  const x = (date) => {
    if (maxDate === minDate) return padding.left + innerWidth / 2;
    return padding.left + ((date.getTime() - minDate) / (maxDate - minDate)) * innerWidth;
  };
  const y = (value) => padding.top + innerHeight - ((value - yMin) / (yMax - yMin || 1)) * innerHeight;
  const line = points.map((point) => `${x(point.date).toFixed(1)},${y(point.value).toFixed(1)}`).join(" ");
  const area = `${padding.left},${padding.top + innerHeight} ${line} ${padding.left + innerWidth},${padding.top + innerHeight}`;
  const ticks = Array.from({ length: 5 }, (_, index) => yMin + ((yMax - yMin) / 4) * index);

  els.chart.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="areaGradient" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="#65f0ba" stop-opacity="0.34"></stop>
          <stop offset="100%" stop-color="#6fb7ff" stop-opacity="0.02"></stop>
        </linearGradient>
      </defs>
      ${ticks
        .map((tick) => {
          const tickY = y(tick);
          return `
            <line class="grid" x1="${padding.left}" x2="${padding.left + innerWidth}" y1="${tickY}" y2="${tickY}"></line>
            <text class="axis-label" x="14" y="${tickY + 4}">${metric.format(tick)}</text>
          `;
        })
        .join("")}
      <polyline class="trend-area" points="${area}"></polyline>
      <polyline class="trend-line" points="${line}"></polyline>
      ${points
        .map(
          (point) => `
            <circle class="point" cx="${x(point.date)}" cy="${y(point.value)}" r="5">
              <title>${formatShortDate(point.date)}: ${metric.format(point.value)}</title>
            </circle>
          `,
        )
        .join("")}
      <line class="axis" x1="${padding.left}" x2="${padding.left + innerWidth}" y1="${padding.top + innerHeight}" y2="${padding.top + innerHeight}"></line>
      <text class="axis-label" x="${padding.left}" y="${height - 12}">${formatShortDate(points[0].date)}</text>
      <text class="axis-label" x="${padding.left + innerWidth - 74}" y="${height - 12}">${formatShortDate(points.at(-1).date)}</text>
    </svg>
  `;
}

function renderStats(points, metric, sessions) {
  const first = points[0]?.value;
  const latest = points.at(-1)?.value;
  const best = points.reduce((max, point) => Math.max(max, point.value), Number.NEGATIVE_INFINITY);
  const change = Number.isFinite(first) && Number.isFinite(latest) ? latest - first : null;
  const changePrefix = change > 0 ? "+" : "";

  els.sessionCount.textContent = String(sessions.length);
  els.firstValue.textContent = Number.isFinite(first) ? metric.format(first) : "--";
  els.latestValue.textContent = Number.isFinite(latest) ? metric.format(latest) : "--";
  els.bestValue.textContent = Number.isFinite(best) ? metric.format(best) : "--";
  els.changeValue.textContent = Number.isFinite(change) ? `${changePrefix}${formatDelta(change, metric)}` : "--";
  els.changeValue.parentElement.classList.toggle("positive", change > 0);
  els.changeValue.parentElement.classList.toggle("negative", change < 0);
}

function renderRows(sessions) {
  els.sessionRows.innerHTML = "";
  els.tableHint.textContent = sessions.length ? `${sessions.length} sessions in the selected range.` : "No sessions in the selected range.";

  sessions
    .slice()
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 12)
    .forEach((session) => {
      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${formatShortDate(new Date(session.date))}</td>
        <td>${formatBestSet(session)}</td>
        <td>${formatWeight(session.bestWeight)}</td>
        <td>${formatWeight(session.sessionVolume)}</td>
        <td>${formatCount(session.totalReps)}</td>
        <td>${session.setCount || 0}</td>
      `;
      els.sessionRows.append(row);
    });
}

function getExercisesWithHistory() {
  return (state.data?.exercises || [])
    .filter((exercise) => getSessionsForExercise(exercise.id).length)
    .sort((a, b) => (a.title || a.name || "").localeCompare(b.title || b.name || ""));
}

function getSessionsForExercise(exerciseId) {
  const exercise = state.data?.exercises?.find((item) => item.id === exerciseId);
  return exercise?.sessions || [];
}

function filterByRange(sessions) {
  if (!state.rangeDays) return sessions;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - state.rangeDays);
  return sessions.filter((session) => new Date(session.date) >= cutoff);
}

function renderLoadError(error) {
  els.lastSynced.textContent = "No data";
  els.chart.innerHTML = `<div class="empty-state">Could not load workout data. ${escapeHtml(error.message)}</div>`;
}

function formatBestSet(session) {
  if (Number.isFinite(session.bestWeight) && Number.isFinite(session.bestReps)) {
    return `${formatWeight(session.bestWeight)} x ${formatCount(session.bestReps)}`;
  }
  if (Number.isFinite(session.bestDuration)) return formatDuration(session.bestDuration);
  if (Number.isFinite(session.bestDistance)) return formatDistance(session.bestDistance);
  return "--";
}

function formatWeight(value) {
  if (!Number.isFinite(value)) return "--";
  return `${round(kgToLb(value))} lb`;
}

function formatCount(value) {
  if (!Number.isFinite(value)) return "--";
  return String(Math.round(value));
}

function formatDuration(value) {
  if (!Number.isFinite(value)) return "--";
  const minutes = Math.floor(value / 60);
  const seconds = Math.round(value % 60);
  return minutes ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

function formatDistance(value) {
  if (!Number.isFinite(value)) return "--";
  return `${round(value / 1000)} km`;
}

function formatDelta(value, metric) {
  if (metric.unit === "time") return `${round(value)}s`;
  if (metric.unit === "km") return `${round(value / 1000)} km`;
  return metric.format(value);
}

function kgToLb(value) {
  return value * KG_TO_LB;
}

function round(value) {
  return Math.abs(value) >= 100 ? Math.round(value).toLocaleString() : value.toFixed(1);
}

function formatShortDate(date) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "2-digit" }).format(date);
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => {
    const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
    return entities[char];
  });
}
