import { DEFAULT_PROFILE_ID, isKnownProfileId } from "./profiles";
import type { Milestone, Settings, SyncConfig, SyncOp, SyncQueue, Workout } from "./types";

const DB_NAME = "workout-tracker";
const DB_VERSION = 1;
const LEGACY_DB_NAME = "ppl-tracker";
const MIGRATION_KEY = "migrated-from-ppl-tracker";
const SYNC_QUEUE_KEY = "sync-queue";
const SYNC_CONFIG_KEY = "sync-config";

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
    tx.onabort = () => reject(tx.error);
  });
}

function newRev(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function workoutQueueKey(workoutId: string): string {
  return `workout:${workoutId}`;
}

// Adds ops to the sync queue inside an open readwrite transaction on "kv", so a
// saved workout and its pending upload are committed together. Later ops for the
// same key replace earlier ones; the Sheet only ever needs the latest state.
function enqueueInTx(tx: IDBTransaction, ops: Array<[string, SyncOp]>): void {
  if (!ops.length) return;
  const kv = tx.objectStore("kv");
  const read = kv.get(SYNC_QUEUE_KEY);
  read.onsuccess = () => {
    const queue = { ...((read.result as SyncQueue | undefined) ?? {}) };
    for (const [key, op] of ops) {
      queue[key] = { rev: newRev(), op };
    }
    kv.put(queue, SYNC_QUEUE_KEY);
  };
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

// Asks the browser not to evict our IndexedDB under storage pressure (Safari
// otherwise may clear data for sites that go unused for a while).
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export const defaultSettings: Settings = {
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

async function allWorkouts(): Promise<Workout[]> {
  const db = await openDb();
  const rows = await reqToPromise(db.transaction("workouts").objectStore("workouts").getAll());
  db.close();
  return rows as Workout[];
}

export async function listWorkouts(profileId: string): Promise<Workout[]> {
  return (await allWorkouts())
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
  const tx = db.transaction(["workouts", "kv"], "readwrite");
  tx.objectStore("workouts").put(workout);
  enqueueInTx(tx, [[workoutQueueKey(workout.id), { type: "workout", workout }]]);
  await waitTx(tx);
  db.close();
}

export async function deleteWorkout(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(["workouts", "kv"], "readwrite");
  const store = tx.objectStore("workouts");
  const read = store.get(id);
  read.onsuccess = () => {
    const row = read.result as Workout | undefined;
    store.delete(id);
    enqueueInTx(tx, [
      [workoutQueueKey(id), { type: "delete", profileId: row?.profileId ?? DEFAULT_PROFILE_ID, workoutId: id }],
    ]);
  };
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
  enqueueInTx(tx, [[milestonesKey(profileId), { type: "milestones", profileId, state }]]);
  await waitTx(tx);
  db.close();
}

export async function getSyncConfig(): Promise<SyncConfig | null> {
  const db = await openDb();
  const stored = await reqToPromise(db.transaction("kv").objectStore("kv").get(SYNC_CONFIG_KEY));
  db.close();
  return (stored as SyncConfig | undefined) ?? null;
}

export async function saveSyncConfig(config: SyncConfig | null): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("kv", "readwrite");
  if (config) tx.objectStore("kv").put(config, SYNC_CONFIG_KEY);
  else tx.objectStore("kv").delete(SYNC_CONFIG_KEY);
  await waitTx(tx);
  db.close();
}

export async function getSyncQueue(): Promise<SyncQueue> {
  const db = await openDb();
  const stored = await reqToPromise(db.transaction("kv").objectStore("kv").get(SYNC_QUEUE_KEY));
  db.close();
  return (stored as SyncQueue | undefined) ?? {};
}

// Drops entries the server has accepted, unless they were replaced by a newer
// change while the upload was in flight.
export async function ackSyncEntries(sent: Array<{ key: string; rev: string }>): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("kv", "readwrite");
  const kv = tx.objectStore("kv");
  const read = kv.get(SYNC_QUEUE_KEY);
  read.onsuccess = () => {
    const queue = { ...((read.result as SyncQueue | undefined) ?? {}) };
    for (const { key, rev } of sent) {
      if (queue[key]?.rev === rev) delete queue[key];
    }
    kv.put(queue, SYNC_QUEUE_KEY);
  };
  await waitTx(tx);
  db.close();
}

// Queues every workout and milestone list on this device, for the first sync or a resend.
export async function enqueueEverything(profileIds: string[]): Promise<void> {
  const workouts = await allWorkouts();
  const milestoneStates = await Promise.all(profileIds.map((id) => getMilestoneState(id)));
  const ops: Array<[string, SyncOp]> = workouts.map((workout) => [
    workoutQueueKey(workout.id),
    { type: "workout", workout },
  ]);
  profileIds.forEach((profileId, index) => {
    ops.push([milestonesKey(profileId), { type: "milestones", profileId, state: milestoneStates[index] }]);
  });
  const db = await openDb();
  const tx = db.transaction("kv", "readwrite");
  enqueueInTx(tx, ops);
  await waitTx(tx);
  db.close();
}

export interface RestoreResult {
  added: number;
  skipped: number;
}

// Adds workouts from the Sheet that this phone does not have. Never overwrites
// or deletes local data, skips workouts deleted here but not yet synced, and
// does not queue anything, since the Sheet already holds these rows.
export async function mergeRestored(
  incoming: Workout[],
  milestones: Record<string, Record<string, boolean>>,
): Promise<RestoreResult> {
  const local = new Set((await allWorkouts()).map((workout) => workout.id));
  const queue = await getSyncQueue();
  const fresh = incoming.filter(
    (workout) => !local.has(workout.id) && queue[workoutQueueKey(workout.id)]?.op.type !== "delete",
  );
  const localMilestones: Record<string, Record<string, boolean>> = {};
  for (const profileId of Object.keys(milestones)) {
    if (isKnownProfileId(profileId)) localMilestones[profileId] = await getMilestoneState(profileId);
  }

  const db = await openDb();
  const tx = db.transaction(["workouts", "kv"], "readwrite");
  for (const workout of fresh) {
    tx.objectStore("workouts").put(workout);
  }
  const pendingMilestones: Array<[string, SyncOp]> = [];
  for (const [profileId, state] of Object.entries(localMilestones)) {
    const merged = { ...milestones[profileId], ...state };
    tx.objectStore("kv").put(merged, milestonesKey(profileId));
    // A queued upload of the pre-restore list would untick goals the Sheet has marked done.
    if (queue[milestonesKey(profileId)]) {
      pendingMilestones.push([milestonesKey(profileId), { type: "milestones", profileId, state: merged }]);
    }
  }
  enqueueInTx(tx, pendingMilestones);
  await waitTx(tx);
  db.close();
  return { added: fresh.length, skipped: incoming.length - fresh.length };
}

export interface BackupPayload {
  exportedAt: string;
  profileId: string;
  workouts: Workout[];
  milestones: Record<string, boolean>;
}

export async function exportBackup(profileId: string): Promise<BackupPayload> {
  const [workouts, milestones] = await Promise.all([listWorkouts(profileId), getMilestoneState(profileId)]);
  return {
    exportedAt: new Date().toISOString(),
    profileId,
    workouts,
    milestones,
  };
}

export function validateBackup(payload: unknown): BackupPayload {
  const candidate = payload as BackupPayload | null;
  if (!candidate || !Array.isArray(candidate.workouts) || !isKnownProfileId(candidate.profileId)) {
    throw new Error("Invalid backup file");
  }
  return candidate;
}

export async function importBackup(payload: BackupPayload): Promise<void> {
  validateBackup(payload);
  const profileId = payload.profileId;
  const existing = await allWorkouts();
  const incomingIds = new Set(payload.workouts.map((workout) => workout.id));
  const milestones = payload.milestones ?? {};
  const db = await openDb();
  const tx = db.transaction(["workouts", "kv"], "readwrite");
  const workoutStore = tx.objectStore("workouts");
  const ops: Array<[string, SyncOp]> = [];
  for (const workout of existing) {
    if (workout.profileId !== profileId) continue;
    workoutStore.delete(workout.id);
    if (!incomingIds.has(workout.id)) {
      ops.push([workoutQueueKey(workout.id), { type: "delete", profileId, workoutId: workout.id }]);
    }
  }
  for (const workout of payload.workouts) {
    const row = { ...workout, profileId };
    workoutStore.put(row);
    ops.push([workoutQueueKey(row.id), { type: "workout", workout: row }]);
  }
  tx.objectStore("kv").put(milestones, milestonesKey(profileId));
  ops.push([milestonesKey(profileId), { type: "milestones", profileId, state: milestones }]);
  enqueueInTx(tx, ops);
  await waitTx(tx);
  db.close();
}

export function mergeMilestones(catalog: Milestone[], state: Record<string, boolean>): Milestone[] {
  return catalog.map((item) => ({
    ...item,
    done: state[item.id] ?? item.done,
  }));
}
