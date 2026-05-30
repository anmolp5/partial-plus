/**
 * APLift Routine Configuration
 * Exposes default routines, handles loading and saving routine configurations from localStorage,
 * and maintains the webhook URL for the Google Sheets integration.
 */

export const DEFAULT_ROUTINE = {
  "Monday": {
    "label": "Push",
    "isRest": false,
    "exercises": [
      { "name": "Incline Dumbbell Press", "tag": "HC", "target": "Chest/Shoulders", "sets": 3 },
      { "name": "Flat Machine Press", "tag": "HC", "target": "Chest/Shoulders", "sets": 3 },
      { "name": "Cable Lateral Raises", "tag": "LLP", "target": "Shoulders", "sets": 3 },
      { "name": "Tricep Overhead Cable Extensions", "tag": "LLP", "target": "Triceps", "sets": 3 }
    ]
  },
  "Tuesday": {
    "label": "Legs",
    "isRest": false,
    "exercises": [
      { "name": "Leg Press", "tag": "HC", "target": "Quads/Glutes", "sets": 3 },
      { "name": "Leg Extension", "tag": "LLP", "target": "Quads", "sets": 3 },
      { "name": "Seated Leg Curl", "tag": "LLP", "target": "Hamstrings", "sets": 3 },
      { "name": "Standing or Seated Calf Raise", "tag": "Base", "target": "Calves", "sets": 2 }
    ]
  },
  "Wednesday": {
    "label": "Pull",
    "isRest": false,
    "exercises": [
      { "name": "Chest-Supported Row", "tag": "HC", "target": "Back", "sets": 3 },
      { "name": "Lat Pulldown", "tag": "HC", "target": "Back", "sets": 3 },
      { "name": "Rear Delt Fly", "tag": "Base", "target": "Rear Delts", "sets": 2 },
      { "name": "Incline Dumbbell Curl", "tag": "LLP", "target": "Biceps", "sets": 3 }
    ]
  },
  "Thursday": {
    "label": "Rest Day",
    "isRest": true,
    "exercises": []
  },
  "Friday": {
    "label": "Upper",
    "isRest": false,
    "exercises": [
      { "name": "Standing Barbell Overhead Press", "tag": "HC", "target": "Shoulders", "sets": 3 },
      { "name": "Weighted Dips or Decline Press Machine", "tag": "HC", "target": "Chest/Triceps", "sets": 3 },
      { "name": "Weighted Pull-Ups or Lat-Focused Row", "tag": "HC", "target": "Back", "sets": 3 },
      { "name": "Dumbbell Leaning Lateral Raises", "tag": "LLP", "target": "Shoulders", "sets": 3 }
    ]
  },
  "Saturday": {
    "label": "Lower",
    "isRest": false,
    "exercises": [
      { "name": "45-Degree Back Extension", "tag": "HC", "target": "Hamstrings/Glutes", "sets": 3 },
      { "name": "Glute Kickbacks", "tag": "Base", "target": "Glutes", "sets": 2 },
      { "name": "Leg Extension", "tag": "LLP", "target": "Quads", "sets": 3 },
      { "name": "Cable Tricep Pushdowns", "tag": "Base", "target": "Triceps", "sets": 2 },
      { "name": "Standing Cable or Barbell Curl", "tag": "Base", "target": "Biceps", "sets": 2 }
    ]
  },
  "Sunday": {
    "label": "Rest Day",
    "isRest": true,
    "exercises": []
  }
};

const STORAGE_KEYS = {
  ROUTINE: 'partial_plus_routine_config',
  WEBHOOK: 'partial_plus_webhook_url',
};

/**
 * Loads the active routine configuration from localStorage, fallback to DEFAULT_ROUTINE.
 * @returns {Object} Routine configuration.
 */
export function getRoutineConfig() {
  const saved = localStorage.getItem(STORAGE_KEYS.ROUTINE);
  if (!saved) {
    return DEFAULT_ROUTINE;
  }
  try {
    const parsed = JSON.parse(saved);
    let modified = false;

    // Clean up "Day X - " prefixes from labels
    const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    days.forEach(day => {
      if (parsed[day] && parsed[day].label) {
        const oldLabel = parsed[day].label;
        const newLabel = oldLabel.replace(/^Day \d+\s*-\s*/, "");
        if (newLabel !== oldLabel) {
          parsed[day].label = newLabel;
          modified = true;
        }
      }
    });

    // Ensure Tuesday is Legs and Wednesday is Pull
    // If Tuesday contains "Pull" (or has pull exercises) and Wednesday contains "Legs" (or has leg exercises), swap them
    const tuesdayIsPull = parsed.Tuesday && (parsed.Tuesday.label === "Pull" || (parsed.Tuesday.exercises && parsed.Tuesday.exercises.some(e => e.name.includes("Row") || e.name.includes("Pulldown"))));
    const wednesdayIsLegs = parsed.Wednesday && (parsed.Wednesday.label === "Legs" || (parsed.Wednesday.exercises && parsed.Wednesday.exercises.some(e => e.name.includes("Leg"))));

    if (tuesdayIsPull && wednesdayIsLegs) {
      console.log("Migrating older routine configuration (Swapping Tuesday/Wednesday to Legs/Pull)...");
      const temp = parsed.Tuesday;
      parsed.Tuesday = parsed.Wednesday;
      parsed.Wednesday = temp;
      parsed.Tuesday.label = "Legs";
      parsed.Wednesday.label = "Pull";
      modified = true;
    }

    if (modified) {
      localStorage.setItem(STORAGE_KEYS.ROUTINE, JSON.stringify(parsed));
    }

    return parsed;
  } catch (e) {
    console.error("Failed to parse saved routine configuration, falling back to default.", e);
    return DEFAULT_ROUTINE;
  }
}

/**
 * Saves a new routine configuration to localStorage.
 * @param {Object} config The configuration object to save.
 */
export function saveRoutineConfig(config) {
  localStorage.setItem(STORAGE_KEYS.ROUTINE, JSON.stringify(config));
}

/**
 * Loads the Google Sheets Webhook URL.
 * @returns {string} Webhook URL or placeholder.
 */
export function getWebhookUrl() {
  return localStorage.getItem(STORAGE_KEYS.WEBHOOK) || 'https://script.google.com/macros/s/YOUR_APPS_SCRIPT_ID/exec';
}

/**
 * Saves the Webhook URL.
 * @param {string} url The URL to save.
 */
export function saveWebhookUrl(url) {
  localStorage.setItem(STORAGE_KEYS.WEBHOOK, url);
}
