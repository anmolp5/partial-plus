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
      { "name": "Incline Dumbbell Press" },
      { "name": "Flat Machine Press" },
      { "name": "Cable Lateral Raises" },
      { "name": "Tricep Overhead Cable Extensions" }
    ]
  },
  "Tuesday": {
    "label": "Legs",
    "isRest": false,
    "exercises": [
      { "name": "Leg Press" },
      { "name": "Leg Extension" },
      { "name": "Seated Leg Curl" },
      { "name": "Seated Calf Raise" }
    ]
  },
  "Wednesday": {
    "label": "Pull",
    "isRest": false,
    "exercises": [
      { "name": "Chest-Supported Row" },
      { "name": "Lat Pulldown" },
      { "name": "Rear Delt Fly" },
      { "name": "Bayesian Curl" }
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
      { "name": "Standing Barbell Overhead Press" },
      { "name": "Weighted Dips or Decline Press Machine" },
      { "name": "Weighted Pull-Ups or Lat-Focused Row" },
      { "name": "Cable Lateral Raises" }
    ]
  },
  "Saturday": {
    "label": "Lower",
    "isRest": false,
    "exercises": [
      { "name": "45-Degree Back Extension" },
      { "name": "Glute Kickbacks" },
      { "name": "Leg Extension" },
      { "name": "Cable Tricep Pushdowns" },
      { "name": "Standing Cable or Barbell Curl" }
    ]
  },
  "Sunday": {
    "label": "Rest Day",
    "isRest": true,
    "exercises": []
  }
};

export const DEFAULT_EXERCISE_REGISTRY = {
  "Incline Dumbbell Press": { muscle_tags: "Chest/Shoulders", default_tag: "HC" },
  "Flat Machine Press": { muscle_tags: "Chest/Shoulders", default_tag: "HC" },
  "Cable Lateral Raises": { muscle_tags: "Shoulders", default_tag: "LLP" },
  "Tricep Overhead Cable Extensions": { muscle_tags: "Triceps", default_tag: "LLP" },
  "Leg Press": { muscle_tags: "Quads/Glutes", default_tag: "HC" },
  "Leg Extension": { muscle_tags: "Quads", default_tag: "LLP" },
  "Seated Leg Curl": { muscle_tags: "Hamstrings", default_tag: "LLP" },
  "Seated Calf Raise": { muscle_tags: "Calves", default_tag: "Base" },
  "Chest-Supported Row": { muscle_tags: "Mid-Back/Traps", default_tag: "HC" },
  "Lat Pulldown": { muscle_tags: "Lats", default_tag: "HC" },
  "Rear Delt Fly": { muscle_tags: "Rear Delts", default_tag: "Base" },
  "Bayesian Curl": { muscle_tags: "Biceps", default_tag: "LLP" },
  "Standing Barbell Overhead Press": { muscle_tags: "Shoulders", default_tag: "HC" },
  "Weighted Dips or Decline Press Machine": { muscle_tags: "Chest/Triceps", default_tag: "HC" },
  "Weighted Pull-Ups or Lat-Focused Row": { muscle_tags: "Lats/Rhomboids", default_tag: "HC" },
  "45-Degree Back Extension": { muscle_tags: "Hamstrings/Glutes", default_tag: "HC" },
  "Glute Kickbacks": { muscle_tags: "Glutes", default_tag: "Base" },
  "Cable Tricep Pushdowns": { muscle_tags: "Triceps", default_tag: "Base" },
  "Standing Cable or Barbell Curl": { muscle_tags: "Biceps", default_tag: "Base" }
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
    const tuesdayIsPull = parsed.Tuesday && (parsed.Tuesday.label === "Pull" || (parsed.Tuesday.exercises && parsed.Tuesday.exercises.some(e => e.name.includes("Row") || e.name.includes("Pulldown"))));
    const wednesdayIsLegs = parsed.Wednesday && (parsed.Wednesday.label === "Legs" || (parsed.Wednesday.exercises && parsed.Wednesday.exercises.some(e => e.name.includes("Leg"))));

    if (tuesdayIsPull && wednesdayIsLegs) {
      console.log("Migrating older routine configuration (Swapping Tuesday/Wednesday)...");
      const temp = parsed.Tuesday;
      parsed.Tuesday = parsed.Wednesday;
      parsed.Wednesday = temp;
      parsed.Tuesday.label = "Legs";
      parsed.Wednesday.label = "Pull";
      modified = true;
    }

    // Migrate names and clean up redundant fields (tag, target, sets) to enforce normalization
    const nameMap = {
      "Incline Dumbbell Curl": "Bayesian Curl",
      "Standing or Seated Calf Raise": "Seated Calf Raise",
      "Dumbbell Leaning Lateral Raises": "Cable Lateral Raises",
      "Dumbbell Leaning Lateral Raise": "Cable Lateral Raise"
    };
    
    days.forEach(day => {
      if (parsed[day] && parsed[day].exercises) {
        parsed[day].exercises = parsed[day].exercises.map(ex => {
          let name = ex.name;
          if (nameMap[name]) {
            name = nameMap[name];
            modified = true;
          }
          
          // If the exercise has extra properties, strip them out to normalize
          if (ex.tag !== undefined || ex.target !== undefined || ex.sets !== undefined) {
            modified = true;
          }
          
          return { name: name };
        });
      }
    });

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
  // Enforce stripping of redundant metadata fields before saving
  const normalized = JSON.parse(JSON.stringify(config));
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  days.forEach(day => {
    if (normalized[day] && normalized[day].exercises) {
      normalized[day].exercises = normalized[day].exercises.map(ex => ({
        name: ex.name
      }));
    }
  });
  localStorage.setItem(STORAGE_KEYS.ROUTINE, JSON.stringify(normalized));
}

/**
 * Loads the Google Sheets Webhook URL.
 * @returns {string} Webhook URL or placeholder.
 */
export function getWebhookUrl() {
  return localStorage.getItem(STORAGE_KEYS.WEBHOOK) || 'https://script.google.com/macros/s/AKfycbw0kJpBdIZ8c0UekZNEaKZf39SNvMQcKq-8z0Y-GjURsUWMOq8Lna6k2H6yps7R4R-dNQ/exec';
}

/**
 * Saves the Webhook URL.
 * @param {string} url The URL to save.
 */
export function saveWebhookUrl(url) {
  localStorage.setItem(STORAGE_KEYS.WEBHOOK, url);
}
