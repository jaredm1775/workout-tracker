import type { Workout } from "./types";

export const WEEKDAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"] as const;

export function parseDateKey(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function formatDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function startOfWeek(date: Date): Date {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  start.setDate(start.getDate() - start.getDay());
  return start;
}

export function weekDates(anchor = new Date()): Date[] {
  const start = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    return day;
  });
}

export function formatWeekRange(days: Date[]): string {
  const first = days[0];
  const last = days[6];
  const monthDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
  if (first.getMonth() === last.getMonth()) {
    return `${monthDay.format(first)}–${last.getDate()}`;
  }
  return `${monthDay.format(first)} – ${monthDay.format(last)}`;
}

export function formatMonthTitle(year: number, month: number): string {
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(new Date(year, month, 1));
}

export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const next = new Date(year, month + delta, 1);
  return { year: next.getFullYear(), month: next.getMonth() };
}

export function monthCells(year: number, month: number): Array<Date | null> {
  const first = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const leading = first.getDay();
  const cells: Array<Date | null> = Array.from({ length: leading }, () => null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push(new Date(year, month, day));
  }
  return cells;
}

export function finishedWorkoutsByDate(workouts: Workout[]): Map<string, Workout[]> {
  const grouped = new Map<string, Workout[]>();
  for (const workout of workouts) {
    if (!workout.finishedAt) continue;
    const list = grouped.get(workout.date) ?? [];
    list.push(workout);
    grouped.set(workout.date, list);
  }
  return grouped;
}

export function uniqueFinishedDates(workouts: Workout[], startKey: string, endKey: string): string[] {
  const dates = new Set<string>();
  for (const workout of workouts) {
    if (!workout.finishedAt) continue;
    if (workout.date >= startKey && workout.date <= endKey) dates.add(workout.date);
  }
  return [...dates];
}
