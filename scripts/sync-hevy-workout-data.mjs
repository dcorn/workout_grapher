#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const API_BASE = "https://api.hevyapp.com";
const PAGE_SIZE = 100;
const CONCURRENCY = 3;

const apiKey = process.env.APIKEY || process.env.HEVY_API_KEY;
const outputPath = getArg("--out") || "docs/workout-grapher/data/workout-data.json";

if (!apiKey) {
  throw new Error("Missing API key. Set APIKEY or HEVY_API_KEY in the environment.");
}

const exercises = await fetchAllExerciseTemplates();
console.log(`Fetched ${exercises.length} exercise templates.`);

const hydrated = await mapLimit(exercises, CONCURRENCY, async (exercise, index) => {
  const history = await fetchExerciseHistory(exercise.id);
  const sessions = normalizeHistory(history);
  if ((index + 1) % 25 === 0 || index + 1 === exercises.length) {
    console.log(`Hydrated ${index + 1}/${exercises.length} exercises.`);
  }
  return {
    id: exercise.id,
    title: exercise.title || exercise.name || "Untitled exercise",
    type: exercise.type || exercise.exercise_type || null,
    primaryMuscleGroup: exercise.primary_muscle_group || exercise.primaryMuscleGroup || null,
    sessions,
  };
});

const payload = {
  generatedAt: new Date().toISOString(),
  source: "hevy",
  exercises: hydrated.filter((exercise) => exercise.sessions.length),
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(`Wrote ${payload.exercises.length} exercises with history to ${outputPath}.`);

async function fetchAllExerciseTemplates() {
  const all = [];
  for (let page = 1; ; page += 1) {
    const data = await hevyFetch(`/v1/exercise_templates?page=${page}&pageSize=${PAGE_SIZE}`);
    const items = getList(data, ["exercise_templates", "exerciseTemplates", "items", "data"]);
    all.push(...items);

    const pageCount = data.page_count || data.pageCount || data.total_pages || data.totalPages;
    if (pageCount && page >= pageCount) break;
    if (!pageCount && items.length < PAGE_SIZE) break;
    if (!items.length) break;
  }
  return uniqueById(all.map(normalizeExerciseTemplate).filter((exercise) => exercise.id));
}

async function fetchExerciseHistory(exerciseTemplateId) {
  const data = await hevyFetch(`/v1/exercise_history/${encodeURIComponent(exerciseTemplateId)}`);
  return getList(data, ["exercise_history", "exerciseHistory", "history", "items", "data"]);
}

async function hevyFetch(path) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      "api-key": apiKey,
      accept: "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Hevy ${path} failed with ${response.status}: ${body.slice(0, 300)}`);
  }

  return response.json();
}

function normalizeExerciseTemplate(item) {
  return {
    ...item,
    id: item.id || item.exercise_template_id || item.exerciseTemplateId,
    title: item.title || item.name,
  };
}

function normalizeHistory(entries) {
  const sessions = new Map();

  for (const entry of entries) {
    const date = entry.start_time || entry.startTime || entry.workout_start_time || entry.date || entry.created_at;
    const sets = getHistorySets(entry);
    if (!date || !sets.length) continue;

    const workoutId = entry.workout_id || entry.workoutId || date;
    const sessionKey = `${workoutId}:${date}`;
    const session = sessions.get(sessionKey) || {
      date,
      workoutTitle: entry.workout_title || entry.workoutTitle || entry.title || null,
      sets: [],
    };

    session.sets.push(...sets);
    sessions.set(sessionKey, session);
  }

  return [...sessions.values()]
    .map((session) => {
      const weightedSets = session.sets.filter((set) => Number.isFinite(set.weight) && Number.isFinite(set.reps));
      const bestByWeight = maxBy(weightedSets, (set) => set.weight) || {};
      const bestByOneRepMax = maxBy(weightedSets, (set) => estimatedOneRepMax(set.weight, set.reps)) || {};
      const sessionVolume = session.sets.reduce(
        (sum, set) => sum + (Number.isFinite(set.weight) && Number.isFinite(set.reps) ? set.weight * set.reps : 0),
        0,
      );
      const totalReps = session.sets.reduce((sum, set) => sum + (Number.isFinite(set.reps) ? set.reps : 0), 0);
      const durations = session.sets.map((set) => set.duration).filter(Number.isFinite);
      const distances = session.sets.map((set) => set.distance).filter(Number.isFinite);
      const bestDuration = durations.length ? Math.max(...durations) : undefined;
      const bestDistance = distances.length ? Math.max(...distances) : undefined;

      return pruneEmpty({
        date: session.date,
        workoutTitle: session.workoutTitle,
        setCount: session.sets.length,
        bestWeight: bestByWeight.weight,
        bestReps: bestByWeight.reps,
        estimatedOneRepMax: Number.isFinite(bestByOneRepMax.weight)
          ? estimatedOneRepMax(bestByOneRepMax.weight, bestByOneRepMax.reps)
          : undefined,
        sessionVolume: sessionVolume || undefined,
        totalReps: totalReps || undefined,
        bestDuration,
        bestDistance,
      });
    })
    .filter(Boolean)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

function getHistorySets(entry) {
  const nestedSets = getList(entry, ["sets"]).map(normalizeSet).filter(Boolean);
  if (nestedSets.length) return nestedSets;

  const flatSet = normalizeSet(entry);
  return flatSet ? [flatSet] : [];
}

function normalizeSet(set) {
  const weight = firstNumber(set.weight_kg, set.weightKg, set.weight, set.weight_lbs && set.weight_lbs * 0.45359237);
  const reps = firstNumber(set.reps, set.rep_count, set.repCount);
  const duration = firstNumber(set.duration_seconds, set.durationSeconds, set.time_seconds, set.timeSeconds, set.seconds);
  const distance = firstNumber(set.distance_meters, set.distanceMeters, set.distance);

  if (![weight, reps, duration, distance].some(Number.isFinite)) return null;
  return { weight, reps, duration, distance };
}

function estimatedOneRepMax(weight, reps) {
  if (!Number.isFinite(weight) || !Number.isFinite(reps) || reps <= 0) return Number.NaN;
  return weight * (1 + reps / 30);
}

function getList(source, keys) {
  for (const key of keys) {
    if (Array.isArray(source?.[key])) return source[key];
  }
  return Array.isArray(source) ? source : [];
}

function firstNumber(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function maxBy(items, getValue) {
  return items.reduce((best, item) => {
    if (!best) return item;
    return getValue(item) > getValue(best) ? item : best;
  }, null);
}

function uniqueById(items) {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function pruneEmpty(source) {
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== null && value !== undefined && !(Number.isNaN(value))),
  );
}

function getArg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

async function mapLimit(items, limit, callback) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await callback(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
