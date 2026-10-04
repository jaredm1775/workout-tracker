import { DEFAULT_PROFILE_ID, isKnownProfileId } from "./profiles";
import type { Milestone, Settings, WeekMode, Workout } from "./types";

const DB_NAME = "workout-tracker";
const DB_VERSION = 1;
const LEGACY_DB_NAME = "ppl-tracker";
const MIGRATION_KEY = "migrated-from-ppl-tracker";

function settingsKey(profileId: string): string {
  return `settings:${profileId}`;
}

function milestonesKey(profileId: string): string {
  return `milestones:${profileId}`;
}

function openNamedDb(name: string, version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version == null ? indexedDB.open(name) : indexedDB.open(name, version);
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

function openExistingDb(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    const request = indexedDB.open(name);
    let created = false;
    request.onupgradeneeded = () => {
      created = true;
    };
    request.onsuccess = () => {
      const db = request.result;
      if (created) {
        db.close();
        const del = indexedDB.deleteDatabase(name);
        del.onsuccess = () => resolve(null);
        del.onerror = () => resolve(null);
        return;
      }
      resolve(db);
    };
    request.onerror = () => resolve(null);
  });
}

function reqToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function waitTx(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function migrateLegacyIfNeeded(db: IDBDatabase): Promise<void> {
  const already = await reqToPromise(db.transaction("kv").objectStore("kv").get(MIGRATION_KEY));
  if (already) return;

  const legacy = await openExistingDb(LEGACY_DB_NAME);
  if (!legacy) {
    const flagTx = db.transaction("kv", "readwrite");
    flagTx.objectStore("kv").put(true, MIGRATION_KEY);
    await waitTx(flagTx);
    return;
  }

  try {
    const hasWorkouts = legacy.objectStoreNames.contains("workouts");
    const hasKv = legacy.objectStoreNames.contains("kv");
    const workouts = hasWorkouts
      ? ((await reqToPromise(legacy.transaction("workouts").objectStore("workouts").getAll())) as Workout[])
      : [];
    const settings = hasKv
      ? await reqToPromise(legacy.transaction("kv").objectStore("kv").get("settings"))
      : undefined;
    const milestones = hasKv
      ? await reqToPromise(legacy.transaction("kv").objectStore("kv").get("milestones"))
      : undefined;

    const tx = db.transaction(["workouts", "kv"], "readwrite");
    const workoutStore = tx.objectStore("workouts");
    for (const workout of workouts) {
      workoutStore.put({ ...workout, profileId: workout.profileId ?? DEFAULT_PROFILE_ID });
    }
    if (settings) {
      tx.objectStore("kv").put(settings, settingsKey(DEFAULT_PROFILE_ID));
    }
    if (milestones) {
      tx.objectStore("kv").put(milestones, milestonesKey(DEFAULT_PROFILE_ID));
    }
    tx.objectStore("kv").put(true, MIGRATION_KEY);
    await waitTx(tx);
  } finally {
    legacy.close();
  }
}

let migrateOnce: Promise<void> | null = null;

async function openDb(): Promise<IDBDatabase> {
  const db = await openNamedDb(DB_NAME, DB_VERSION);
  if (!migrateOnce) {
    migrateOnce = migrateLegacyIfNeeded(db).catch((error) => {
      migrateOnce = null;
      throw error;
    });
  }
  await migrateOnce;
  return db;
}

export const defaultSettings: Settings = {
  weekMode: "6day",
  activeWorkoutId: null,
  restStartedAt: null,
  restPrescribed: null,
};

export async function getSettings(profileId: string): Promise<Settings> {
  const db = await openDb();
  const stored = await reqToPromise(db.transaction("kv").objectStore("kv").get(settingsKey(profileId)));
  db.close();
  return { ...defaultSettings, ...(stored as Settings | undefined) };
}

export async function saveSettings(profileId: string, settings: Settings): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("kv", "readwrite");
  tx.objectStore("kv").put(settings, settingsKey(profileId));
  await waitTx(tx);
  db.close();
}

export async function listWorkouts(profileId: string): Promise<Workout[]> {
  const db = await openDb();
  const rows = await reqToPromise(db.transaction("workouts").objectStore("workouts").getAll());
  db.close();
  return (rows as Workout[])
    .filter((workout) => workout.profileId === profileId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function getWorkout(profileId: string, id: string): Promise<Workout | undefined> {
  const db = await openDb();
  const row = (await reqToPromise(db.transaction("workouts").objectStore("workouts").get(id))) as
    | Workout
    | undefined;
  db.close();
  if (!row || row.profileId !== profileId) return undefined;
  return row;
}

export async function saveWorkout(workout: Workout): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("workouts", "readwrite");
  tx.objectStore("workouts").put(workout);
  await waitTx(tx);
  db.close();
}

export async function deleteWorkout(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("workouts", "readwrite");
  tx.objectStore("workouts").delete(id);
  await waitTx(tx);
  db.close();
}

export async function getMilestoneState(profileId: string): Promise<Record<string, boolean>> {
  const db = await openDb();
  const stored = await reqToPromise(db.transaction("kv").objectStore("kv").get(milestonesKey(profileId)));
  db.close();
  return (stored as Record<string, boolean> | undefined) ?? {};
}

export async function saveMilestoneState(profileId: string, state: Record<string, boolean>): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("kv", "readwrite");
  tx.objectStore("kv").put(state, milestonesKey(profileId));
  await waitTx(tx);
  db.close();
}

export interface BackupPayload {
  exportedAt: string;
  profileId: string;
  weekMode: WeekMode;
  workouts: Workout[];
  milestones: Record<string, boolean>;
}

export async function exportBackup(profileId: string): Promise<BackupPayload> {
  const [settings, workouts, milestones] = await Promise.all([
    getSettings(profileId),
    listWorkouts(profileId),
    getMilestoneState(profileId),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    profileId,
    weekMode: settings.weekMode,
    workouts,
    milestones,
  };
}

export async function importBackup(payload: BackupPayload): Promise<void> {
  if (!payload || !Array.isArray(payload.workouts) || !isKnownProfileId(payload.profileId)) {
    throw new Error("Invalid backup file");
  }
  const profileId = payload.profileId;
  const settings = await getSettings(profileId);
  settings.weekMode = payload.weekMode ?? settings.weekMode;
  await saveSettings(profileId, settings);

  const db = await openDb();
  const existing = (await reqToPromise(
    db.transaction("workouts").objectStore("workouts").getAll(),
  )) as Workout[];
  const tx = db.transaction(["workouts", "kv"], "readwrite");
  const workoutStore = tx.objectStore("workouts");
  for (const workout of existing) {
    if (workout.profileId === profileId) workoutStore.delete(workout.id);
  }
  for (const workout of payload.workouts) {
    workoutStore.put({ ...workout, profileId });
  }
  tx.objectStore("kv").put(payload.milestones ?? {}, milestonesKey(profileId));
  await waitTx(tx);
  db.close();
}

export function mergeMilestones(catalog: Milestone[], state: Record<string, boolean>): Milestone[] {
  return catalog.map((item) => ({
    ...item,
    done: state[item.id] ?? item.done,
  }));
}
