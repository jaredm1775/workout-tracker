import { formatDateKey, parseDateKey, startOfWeek } from "./calendar";
import { estimatedOneRepMax } from "./progression";
import type { Workout } from "./types";

// Trend numbers for the Progress tab and the streak on Today. Weeks start on
// Sunday to match the calendar. Only finished workouts count.

export interface WeekBucket {
  start: string;
  days: number;
  workouts: number;
  volume: number;
}

function finished(workouts: Workout[]): Workout[] {
  return workouts.filter((workout) => workout.finishedAt);
}

export function weekStartKey(dateKey: string): string {
  return formatDateKey(startOfWeek(parseDateKey(dateKey)));
}

function shiftWeeks(weekKey: string, delta: number): string {
  const date = parseDateKey(weekKey);
  date.setDate(date.getDate() + delta * 7);
  return formatDateKey(date);
}

function workoutVolume(workout: Workout): number {
  return workout.sets.reduce((sum, set) => sum + set.weight * set.reps, 0);
}

// The last `count` weeks ending with the week containing `today`, oldest first.
export function weeklyBuckets(workouts: Workout[], count: number, today: string): WeekBucket[] {
  const current = weekStartKey(today);
  const buckets = new Map<string, { dates: Set<string>; workouts: number; volume: number }>();
  for (let i = count - 1; i >= 0; i -= 1) {
    buckets.set(shiftWeeks(current, -i), { dates: new Set(), workouts: 0, volume: 0 });
  }
  for (const workout of finished(workouts)) {
    const bucket = buckets.get(weekStartKey(workout.date));
    if (!bucket) continue;
    bucket.dates.add(workout.date);
    bucket.workouts += 1;
    bucket.volume += workoutVolume(workout);
  }
  return [...buckets].map(([start, bucket]) => ({
    start,
    days: bucket.dates.size,
    workouts: bucket.workouts,
    volume: Math.round(bucket.volume),
  }));
}

// Rest days allowed in a row before a streak breaks. A 4-6 day split never
// needs more than 2 back to back; lighter plans get one more.
export function maxRestDays(plannedDays: number): number {
  return Math.max(2, Math.ceil((7 - plannedDays) / 2));
}

export interface Streak {
  // Calendar days in the current streak, training and rest days alike (0 when broken).
  days: number;
  workouts: number;
  restDays: number;
  // Rest days still allowed before the streak breaks, counting today.
  restLeft: number;
  // Last date a workout keeps the streak alive, or null with no streak.
  trainBy: string | null;
  best: number;
  maxRest: number;
}

function daysBetween(fromKey: string, toKey: string): number {
  return Math.round((parseDateKey(toKey).getTime() - parseDateKey(fromKey).getTime()) / 86_400_000);
}

function addDays(dateKey: string, delta: number): string {
  const date = parseDateKey(dateKey);
  date.setDate(date.getDate() + delta);
  return formatDateKey(date);
}

// A day streak where rest days count as long as no more than `maxRest` fall in
// a row. Today never breaks it: an untrained today is just a rest day so far.
export function dayStreak(workouts: Workout[], plannedDays: number, today: string): Streak {
  const maxRest = maxRestDays(plannedDays);
  const dates = [...new Set(finished(workouts).map((workout) => workout.date))]
    .filter((date) => date <= today)
    .sort();

  // Split training dates into runs where each gap is within the rest allowance.
  const runs: string[][] = [];
  for (const date of dates) {
    const run = runs[runs.length - 1];
    if (run && daysBetween(run[run.length - 1], date) - 1 <= maxRest) run.push(date);
    else runs.push([date]);
  }

  const last = runs[runs.length - 1];
  const alive = Boolean(last && daysBetween(last[last.length - 1], today) - 1 <= maxRest);
  const best = runs.reduce((max, run) => {
    const end = run === last && alive ? today : run[run.length - 1];
    return Math.max(max, daysBetween(run[0], end) + 1);
  }, 0);

  if (!alive || !last) {
    return { days: 0, workouts: 0, restDays: 0, restLeft: maxRest, trainBy: null, best, maxRest };
  }
  const lastTrained = last[last.length - 1];
  const days = daysBetween(last[0], today) + 1;
  const restSinceLast = Math.max(0, daysBetween(lastTrained, today) - 1);
  return {
    days,
    workouts: last.length,
    restDays: days - last.length,
    restLeft: lastTrained === today ? maxRest : maxRest - restSinceLast,
    trainBy: addDays(lastTrained, maxRest + 1),
    best,
    maxRest,
  };
}

export interface LiftPoint {
  date: string;
  workoutId: string;
  e1rm: number;
  e1rmSet: string;
  topWeight: number;
  topSet: string;
}

// One point per session: the best estimated 1RM and the heaviest set.
export function liftSeries(workouts: Workout[], exerciseId: string): LiftPoint[] {
  const points: LiftPoint[] = [];
  for (const workout of finished(workouts)) {
    const sets = workout.sets.filter((set) => set.exerciseId === exerciseId && set.reps > 0);
    if (!sets.length) continue;
    const best = sets.reduce((a, b) => (estimatedOneRepMax(b.weight, b.reps) > estimatedOneRepMax(a.weight, a.reps) ? b : a));
    const top = sets.reduce((a, b) => (b.weight > a.weight || (b.weight === a.weight && b.reps > a.reps) ? b : a));
    points.push({
      date: workout.date,
      workoutId: workout.id,
      e1rm: estimatedOneRepMax(best.weight, best.reps),
      e1rmSet: `${best.weight} × ${best.reps}`,
      topWeight: top.weight,
      topSet: `${top.weight} × ${top.reps}`,
    });
  }
  return points.sort((a, b) => a.date.localeCompare(b.date));
}

export interface ExerciseSummary {
  exerciseId: string;
  sessions: number;
  best: LiftPoint;
  first: LiftPoint;
}

// Exercises with weighted history, most-trained first.
export function exerciseSummaries(workouts: Workout[]): ExerciseSummary[] {
  const ids = new Set(finished(workouts).flatMap((workout) => workout.sets.map((set) => set.exerciseId)));
  const summaries: ExerciseSummary[] = [];
  for (const exerciseId of ids) {
    const series = liftSeries(workouts, exerciseId);
    if (!series.length || series.every((point) => point.e1rm === 0)) continue;
    const best = series.reduce((a, b) => (b.e1rm > a.e1rm ? b : a));
    summaries.push({ exerciseId, sessions: series.length, best, first: series[0] });
  }
  return summaries.sort((a, b) => b.sessions - a.sessions || b.best.e1rm - a.best.e1rm);
}

export function workoutsSince(workouts: Workout[], sinceKey: string): number {
  return finished(workouts).filter((workout) => workout.date >= sinceKey).length;
}
