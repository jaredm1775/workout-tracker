import type { Milestone, Settings, WeekMode, Workout } from "./types";

const DB_NAME = "ppl-tracker";
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("workouts")) {
        db.createObjectStore("workouts", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("kv")) {
        db.createObjectStore("kv");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function reqToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const defaultSettings: Settings = {
  weekMode: "6day",
  activeWorkoutId: null,
  restStartedAt: null,
  restPrescribed: null,
};

export async function getSettings(): Promise<Settings> {
  const db = await openDb();
  const stored = await reqToPromise(
    db.transaction("kv").objectStore("kv").get("settings"),
  );
  db.close();
  return { ...defaultSettings, ...(stored as Settings | undefined) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("kv", "readwrite");
  tx.objectStore("kv").put(settings, "settings");
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function listWorkouts(): Promise<Workout[]> {
  const db = await openDb();
  const rows = await reqToPromise(
    db.transaction("workouts").objectStore("workouts").getAll(),
  );
  db.close();
  return (rows as Workout[]).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function getWorkout(id: string): Promise<Workout | undefined> {
  const db = await openDb();
  const row = await reqToPromise(
    db.transaction("workouts").objectStore("workouts").get(id),
  );
  db.close();
  return row as Workout | undefined;
}

export async function saveWorkout(workout: Workout): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("workouts", "readwrite");
  tx.objectStore("workouts").put(workout);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function getMilestoneState(): Promise<Record<string, boolean>> {
  const db = await openDb();
  const stored = await reqToPromise(
    db.transaction("kv").objectStore("kv").get("milestones"),
  );
  db.close();
  return (stored as Record<string, boolean> | undefined) ?? {};
}

export async function saveMilestoneState(state: Record<string, boolean>): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("kv", "readwrite");
  tx.objectStore("kv").put(state, "milestones");
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export interface BackupPayload {
  exportedAt: string;
  weekMode: WeekMode;
  workouts: Workout[];
  milestones: Record<string, boolean>;
}

export async function exportBackup(): Promise<BackupPayload> {
  const [settings, workouts, milestones] = await Promise.all([
    getSettings(),
    listWorkouts(),
    getMilestoneState(),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    weekMode: settings.weekMode,
    workouts,
    milestones,
  };
}

export async function importBackup(payload: BackupPayload): Promise<void> {
  if (!payload || !Array.isArray(payload.workouts)) {
    throw new Error("Invalid backup file");
  }
  const settings = await getSettings();
  settings.weekMode = payload.weekMode ?? settings.weekMode;
  await saveSettings(settings);
  const db = await openDb();
  const tx = db.transaction(["workouts", "kv"], "readwrite");
  const workoutStore = tx.objectStore("workouts");
  workoutStore.clear();
  for (const workout of payload.workouts) {
    workoutStore.put(workout);
  }
  tx.objectStore("kv").put(payload.milestones ?? {}, "milestones");
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export function mergeMilestones(
  catalog: Milestone[],
  state: Record<string, boolean>,
): Milestone[] {
  return catalog.map((item) => ({
    ...item,
    done: state[item.id] ?? item.done,
  }));
}
