/**
 * Workout Tracker -> Google Sheet live sync.
 *
 * Setup (once):
 *   1. Create a Google Sheet. Extensions -> Apps Script. Replace Code.gs with this file. Save.
 *   2. Pick "setup" in the function menu and press Run. Approve access when Google asks.
 *      The log (View -> Logs / Execution log) prints your sync password.
 *   3. Deploy -> New deployment -> type "Web app".
 *      Execute as: Me. Who has access: Anyone. Deploy, then copy the Web app URL.
 *   4. In the app open Sync, paste the URL and the password, and press Connect.
 *
 * After editing this script, use Deploy -> Manage deployments -> Edit -> New version,
 * so the same URL keeps working.
 */

var SHEETS = {
  Workouts: ["workoutId", "profile", "date", "day", "focus", "startedAt", "finishedAt",
             "durationMin", "sets", "volumeLb", "updatedAt", "dayId"],
  Sets: ["workoutId", "profile", "date", "day", "exercise", "exerciseId", "set",
         "weight", "reps", "e1rm", "restSec", "completedAt"],
  Milestones: ["profile", "milestoneId", "lift", "target", "done", "updatedAt"],
};

function setup() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty("SYNC_TOKEN");
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, "");
    props.setProperty("SYNC_TOKEN", token);
  }
  var ss = SpreadsheetApp.getActive();
  Object.keys(SHEETS).forEach(function (name) {
    sheetFor_(ss, name);
  });
  var blank = ss.getSheetByName("Sheet1");
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);
  Logger.log("Sync password: " + token);
}

function doGet() {
  return json_({ ok: true, app: "workout-tracker-sync" });
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: "Body is not JSON" });
  }
  var token = PropertiesService.getScriptProperties().getProperty("SYNC_TOKEN");
  if (!token || body.token !== token) {
    return json_({ ok: false, error: "Wrong sync password" });
  }
  if (body.action === "restore") {
    return json_(restore_());
  }
  var ops = Array.isArray(body.ops) ? body.ops : [];
  if (!ops.length) return json_({ ok: true, applied: 0 });

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    apply_(ops);
  } finally {
    lock.releaseLock();
  }
  return json_({ ok: true, applied: ops.length });
}

// Every op carries the full current state of one workout (or one profile's
// milestones), so applying is "replace whatever rows that key had".
function apply_(ops) {
  var ss = SpreadsheetApp.getActive();
  var touchedWorkouts = {};
  var workoutRows = [];
  var setRows = [];
  var touchedProfiles = {};
  var milestoneRows = [];

  ops.forEach(function (op) {
    if (op.type === "workout") {
      touchedWorkouts[op.workoutId] = true;
      workoutRows.push(op.workout);
      setRows = setRows.concat(op.sets || []);
    } else if (op.type === "delete") {
      touchedWorkouts[op.workoutId] = true;
    } else if (op.type === "milestones") {
      touchedProfiles[op.profile] = true;
      milestoneRows = milestoneRows.concat(op.rows || []);
    }
  });

  replaceRows_(sheetFor_(ss, "Workouts"), "Workouts", function (row) {
    return touchedWorkouts[row.workoutId];
  }, workoutRows, "startedAt");
  replaceRows_(sheetFor_(ss, "Sets"), "Sets", function (row) {
    return touchedWorkouts[row.workoutId];
  }, setRows, "completedAt");
  replaceRows_(sheetFor_(ss, "Milestones"), "Milestones", function (row) {
    return touchedProfiles[row.profile];
  }, milestoneRows, null);
}

// Rebuilds the app's workout records from the Sheet, for a new or wiped phone.
function restore_() {
  var ss = SpreadsheetApp.getActive();
  var workouts = {};
  readRows_(sheetFor_(ss, "Workouts"), "Workouts").forEach(function (row) {
    if (!row.workoutId) return;
    workouts[row.workoutId] = {
      id: String(row.workoutId),
      profileId: String(row.profile),
      dayId: String(row.dayId || ""),
      dayName: String(row.day || ""),
      date: String(row.date),
      startedAt: String(row.startedAt),
      finishedAt: row.finishedAt ? String(row.finishedAt) : undefined,
      sets: [],
    };
  });
  readRows_(sheetFor_(ss, "Sets"), "Sets").forEach(function (row) {
    var workout = workouts[row.workoutId];
    if (!workout) return;
    var set = {
      exerciseId: String(row.exerciseId),
      setIndex: Number(row.set) - 1,
      weight: Number(row.weight) || 0,
      reps: Number(row.reps) || 0,
      completedAt: String(row.completedAt),
    };
    if (row.restSec !== "" && row.restSec !== null) set.restSeconds = Number(row.restSec);
    workout.sets.push(set);
  });
  var milestones = {};
  readRows_(sheetFor_(ss, "Milestones"), "Milestones").forEach(function (row) {
    if (!row.profile || !row.milestoneId) return;
    milestones[row.profile] = milestones[row.profile] || {};
    milestones[row.profile][row.milestoneId] = row.done === true || String(row.done).toUpperCase() === "TRUE";
  });
  return {
    ok: true,
    workouts: Object.keys(workouts).map(function (id) { return workouts[id]; }),
    milestones: milestones,
  };
}

function readRows_(sheet, name) {
  var headers = SHEETS[name];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, headers.length).getValues()
    .map(function (values) { return toObject_(headers, values); });
}

function replaceRows_(sheet, name, isReplaced, incoming, sortKey) {
  var headers = SHEETS[name];
  var lastRow = sheet.getLastRow();
  var kept = readRows_(sheet, name).filter(function (row) { return !isReplaced(row); });
  var rows = kept.concat(incoming);
  if (sortKey) {
    rows.sort(function (a, b) {
      return String(a[sortKey]).localeCompare(String(b[sortKey]));
    });
  }
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, headers.length).clearContent();
  if (rows.length) {
    var values = rows.map(function (row) {
      return headers.map(function (h) { return row[h] === undefined || row[h] === null ? "" : row[h]; });
    });
    sheet.getRange(2, 1, values.length, headers.length).setValues(values);
  }
}

function toObject_(headers, values) {
  var row = {};
  headers.forEach(function (h, i) {
    var v = values[i];
    // Sheets turns ISO dates into Date objects; keep them as text for stable keys and sorting.
    row[h] = v instanceof Date ? Utilities.formatDate(v, "UTC", h === "date" ? "yyyy-MM-dd" : "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'") : v;
  });
  return row;
}

function sheetFor_(ss, name) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  var headers = SHEETS[name];
  var first = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  if (first.join("|") !== headers.join("|")) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
    sheet.setFrozenRows(1);
    // Plain text stops Sheets from reinterpreting ids, dates and timestamps.
    sheet.getRange(1, 1, sheet.getMaxRows(), headers.length).setNumberFormat("@");
    numericColumns_(name).forEach(function (h) {
      var col = headers.indexOf(h) + 1;
      sheet.getRange(2, col, sheet.getMaxRows() - 1, 1).setNumberFormat("0.##");
    });
  }
  return sheet;
}

function numericColumns_(name) {
  if (name === "Workouts") return ["durationMin", "sets", "volumeLb"];
  if (name === "Sets") return ["set", "weight", "reps", "e1rm", "restSec"];
  return [];
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
