import { ackSyncEntries, enqueueEverything, getSyncConfig, getSyncQueue, saveSyncConfig } from "./db";
import { PROFILES } from "./profiles";
import { findDay, findExercise, milestoneCatalog } from "./programs";
import { estimatedOneRepMax } from "./progression";
import type { SyncConfig, SyncOp, Workout } from "./types";

// Live sync to a Google Sheet through a small Apps Script web app (see
// apps-script/Code.gs). Every change is queued in IndexedDB first, so logging
// works offline and uploads catch up when the phone is back online.

export type SyncStatus = "off" | "idle" | "pending" | "syncing" | "error";

export interface SyncState {
  status: SyncStatus;
  pending: number;
  lastSyncedAt: string | null;
  lastError: string | null;
}

const BATCH_SIZE = 150;
const LAST_SYNC_KEY = "workout-tracker:last-sync";
const RETRY_STEPS_MS = [5_000, 15_000, 60_000, 300_000];

const state: SyncState = {
  status: "off",
  pending: 0,
  lastSyncedAt: readLastSync(),
  lastError: null,
};

const listeners = new Set<(state: SyncState) => void>();
let flushing: Promise<void> | null = null;
let again = false;
let debounceHandle = 0;
let retryHandle = 0;
let failures = 0;

function readLastSync(): string | null {
  try {
    return localStorage.getItem(LAST_SYNC_KEY);
  } catch {
    return null;
  }
}

function writeLastSync(value: string): void {
  try {
    localStorage.setItem(LAST_SYNC_KEY, value);
  } catch {
    /* not critical */
  }
}

function emit(patch: Partial<SyncState>): void {
  Object.assign(state, patch);
  for (const listener of listeners) listener({ ...state });
}

export function syncState(): SyncState {
  return { ...state };
}

export function onSyncChange(listener: (state: SyncState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export interface WireWorkout {
  type: "workout";
  workoutId: string;
  workout: Record<string, string | number>;
  sets: Array<Record<string, string | number>>;
}

export interface WireDelete {
  type: "delete";
  workoutId: string;
}

export interface WireMilestones {
  type: "milestones";
  profile: string;
  rows: Array<Record<string, string | number | boolean>>;
}

export type WireOp = WireWorkout | WireDelete | WireMilestones;

// Flattens a workout into the rows the Sheet stores, with names resolved from
// the program so the Sheet is readable without the app.
export function workoutToWire(workout: Workout, updatedAt = new Date().toISOString()): WireWorkout {
  const day = findDay(workout.profileId, workout.dayId);
  const sets = [...workout.sets].sort(
    (a, b) => a.completedAt.localeCompare(b.completedAt) || a.setIndex - b.setIndex,
  );
  const volume = sets.reduce((sum, set) => sum + set.weight * set.reps, 0);
  const durationMin = workout.finishedAt
    ? round1((Date.parse(workout.finishedAt) - Date.parse(workout.startedAt)) / 60000)
    : "";
  return {
    type: "workout",
    workoutId: workout.id,
    workout: {
      workoutId: workout.id,
      profile: workout.profileId,
      date: workout.date,
      day: day?.name ?? workout.dayId,
      focus: day?.focus ?? "",
      startedAt: workout.startedAt,
      finishedAt: workout.finishedAt ?? "",
      durationMin,
      sets: sets.length,
      volumeLb: round1(volume),
      updatedAt,
    },
    sets: sets.map((set) => ({
      workoutId: workout.id,
      profile: workout.profileId,
      date: workout.date,
      day: day?.name ?? workout.dayId,
      exercise: findExercise(workout.profileId, set.exerciseId)?.name ?? set.exerciseId,
      exerciseId: set.exerciseId,
      set: set.setIndex + 1,
      weight: set.weight,
      reps: set.reps,
      e1rm: estimatedOneRepMax(set.weight, set.reps),
      restSec: set.restSeconds ?? "",
      completedAt: set.completedAt,
    })),
  };
}

export function opToWire(op: SyncOp, updatedAt = new Date().toISOString()): WireOp {
  if (op.type === "workout") return workoutToWire(op.workout, updatedAt);
  if (op.type === "delete") return { type: "delete", workoutId: op.workoutId };
  return {
    type: "milestones",
    profile: op.profileId,
    rows: milestoneCatalog(op.profileId).map((item) => ({
      profile: op.profileId,
      milestoneId: item.id,
      lift: item.lift,
      target: item.target,
      done: op.state[item.id] ?? item.done,
      updatedAt,
    })),
  };
}

async function post(config: SyncConfig, ops: WireOp[]): Promise<void> {
  // text/plain keeps this a "simple" CORS request; Apps Script cannot answer preflights.
  const response = await fetch(config.url, {
    method: "POST",
    body: JSON.stringify({ token: config.token, ops }),
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`Sheet returned HTTP ${response.status}`);
  let body: { ok?: boolean; error?: string };
  try {
    body = await response.json();
  } catch {
    throw new Error("Sheet did not answer with JSON. Check the web app URL and that access is set to Anyone.");
  }
  if (!body.ok) throw new Error(body.error ?? "Sheet rejected the upload");
}

async function refreshPending(): Promise<number> {
  const pending = Object.keys(await getSyncQueue()).length;
  emit({ pending });
  return pending;
}

async function runFlush(): Promise<void> {
  const config = await getSyncConfig();
  if (!config) {
    emit({ status: "off", pending: await refreshPending(), lastError: null });
    return;
  }
  const queue = await getSyncQueue();
  const entries = Object.entries(queue);
  emit({ pending: entries.length });
  if (!entries.length) {
    emit({ status: "idle", lastError: null });
    return;
  }
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    emit({ status: "pending" });
    return;
  }
  emit({ status: "syncing" });
  try {
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE);
      await post(
        config,
        batch.map(([, entry]) => opToWire(entry.op)),
      );
      await ackSyncEntries(batch.map(([key, entry]) => ({ key, rev: entry.rev })));
    }
    failures = 0;
    const now = new Date().toISOString();
    writeLastSync(now);
    const pending = await refreshPending();
    emit({ status: pending ? "pending" : "idle", lastSyncedAt: now, lastError: null });
  } catch (error) {
    failures += 1;
    await refreshPending();
    emit({ status: "error", lastError: error instanceof Error ? error.message : String(error) });
    const delay = RETRY_STEPS_MS[Math.min(failures - 1, RETRY_STEPS_MS.length - 1)];
    window.clearTimeout(retryHandle);
    retryHandle = window.setTimeout(() => void flushNow(), delay);
  }
}

export async function flushNow(): Promise<void> {
  if (flushing) {
    again = true;
    return flushing;
  }
  flushing = (async () => {
    do {
      again = false;
      await runFlush();
    } while (again);
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

// Called after every local change; waits a moment so a burst of edits goes up in one request.
export function scheduleSync(delayMs = 1500): void {
  window.clearTimeout(debounceHandle);
  debounceHandle = window.setTimeout(() => void flushNow(), delayMs);
}

export async function testConnection(config: SyncConfig): Promise<void> {
  await post(config, []);
}

export async function connectSheet(config: SyncConfig): Promise<void> {
  const clean = { url: config.url.trim(), token: config.token.trim() };
  if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(clean.url)) {
    throw new Error("That does not look like an Apps Script web app URL (https://script.google.com/...).");
  }
  if (!clean.token) throw new Error("Enter the sync password from the script.");
  await testConnection(clean);
  await saveSyncConfig(clean);
  await enqueueEverything(PROFILES.map((profile) => profile.id));
  failures = 0;
  await flushNow();
}

export async function disconnectSheet(): Promise<void> {
  await saveSyncConfig(null);
  window.clearTimeout(retryHandle);
  emit({ status: "off", lastError: null });
}

export async function resendEverything(): Promise<void> {
  await enqueueEverything(PROFILES.map((profile) => profile.id));
  await flushNow();
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

// The setup link carries the config in the URL fragment, which browsers never
// send to a server, so it can be opened on a second phone without retyping.
export function setupLink(config: SyncConfig, profileId: string): string {
  const base = `${location.origin}${location.pathname}`;
  return `${base}#${profileId}/sync=${toBase64Url(JSON.stringify(config))}`;
}

export function parseSetupHash(hash: string): SyncConfig | null {
  const match = hash.match(/sync=([A-Za-z0-9_-]+)/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(fromBase64Url(match[1])) as Partial<SyncConfig>;
    if (typeof parsed.url === "string" && typeof parsed.token === "string") {
      return { url: parsed.url, token: parsed.token };
    }
  } catch {
    return null;
  }
  return null;
}

export function startSyncLoop(): void {
  window.addEventListener("online", () => void flushNow());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void flushNow();
  });
  window.setInterval(() => {
    if (state.pending > 0 && state.status !== "syncing") void flushNow();
  }, 60_000);
  void flushNow();
}
