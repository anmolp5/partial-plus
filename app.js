import { getRoutineConfig, saveRoutineConfig, getWebhookUrl, saveWebhookUrl, DEFAULT_EXERCISE_REGISTRY } from './config.js';

// -------------------------------------------------------------
// Application State Object
// -------------------------------------------------------------
let state = {
  auth: {
    loggedIn: false,
    mode: 'user' // 'user' or 'guest'
  },
  activeWorkout: {
    date: '',              // YYYY-MM-DD
    dayOfWeek: '',         // e.g., 'Monday'
    dayLabel: '',          // e.g., 'Day 1 - Push'
    templateDay: '',       // The template name we are running (e.g. Wednesday template)
    exercises: [],         // Array of exercises, matching config + filled weights/reps/rir
    isActive: false,       // In the middle of a workout card session
    currentExerciseIndex: 0,
    isEditingHistorical: false,
    editDate: '',          // YYYY-MM-DD if editing history
    workoutNote: '',       // Transient daily session note
    lastLapFrozenTime: ''  // Immutably locked split value string
  },
  history: {},             // Map of YYYY-MM-DD -> completed workout object
  weekSwaps: {},           // Map of weekMondayDate -> { weekdayName: templateDayName }
  weightHistory: {},       // Map of YYYY-MM-DD -> weight (float)
  exerciseRegistry: {}     // Map of ExerciseName -> { notes: '', muscle_tags: '', default_tag: '' }
};

// LocalStorage Keys
const KEYS = {
  SESSION: 'partial_plus_session',
  ACTIVE_WORKOUT: 'partial_plus_active_workout',
  HISTORY: 'partial_plus_history',
  WEEK_SWAPS: 'partial_plus_week_swaps',
  WEIGHT_HISTORY: 'partial_plus_weight_history',
  EXERCISE_REGISTRY: 'partial_plus_exercise_registry'
};

// Current Calendar Month display state
let currentCalDate = new Date();
let selectedSwapTargetDay = '';
let activeSplitSelectDay = '';

// Stopwatch & Lap Timer State
let stopwatchInterval = null;
let stopwatchStartTime = null;   // Date.now() when workout started
let lapStartTime = null;         // Date.now() when current lap started



// -------------------------------------------------------------
// Initialization & Routing Engine
// -------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  initPWA();
  loadStateFromStorage();
  setupEventListeners();
  initPatternLock();
  routeToInitialView();
});

// PWA Service Worker Registration
function initPWA() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js')
        .then(reg => {
          console.log('Service Worker registered successfully.', reg.scope);
          // Check for updates
          reg.addEventListener('updatefound', () => {
            const newWorker = reg.installing;
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'activated') {
                window.location.reload();
              }
            });
          });
        })
        .catch(err => console.error('Service Worker registration failed.', err));
    });
    
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!refreshing) {
        refreshing = true;
        window.location.reload();
      }
    });
  }
}

// -------------------------------------------------------------
// Dynamic Routine Resolver & Fuzzy Name Matching Helpers
// -------------------------------------------------------------
function getSetsForTag(tag) {
  if (tag === 'Base') return 2;
  return 3;
}

function levenshteinDistance(s1, s2) {
  const track = Array(s2.length + 1).fill(null).map(() => Array(s1.length + 1).fill(null));
  for (let i = 0; i <= s1.length; i++) track[0][i] = i;
  for (let j = 0; j <= s2.length; j++) track[j][0] = j;
  for (let j = 1; j <= s2.length; j++) {
    for (let i = 1; i <= s1.length; i++) {
      const indicator = s1[i - 1] === s2[j - 1] ? 0 : 1;
      track[j][i] = Math.min(
        track[j][i - 1] + 1, // deletion
        track[j - 1][i] + 1, // insertion
        track[j - 1][i - 1] + indicator // substitution
      );
    }
  }
  return track[s2.length][s1.length];
}

function getWordOverlapScore(s1, s2) {
  const w1 = new Set(s1.toLowerCase().split(/[^a-z0-9]+/));
  const w2 = new Set(s2.toLowerCase().split(/[^a-z0-9]+/));
  const intersection = new Set([...w1].filter(x => w2.has(x)));
  if (Math.max(w1.size, w2.size) === 0) return 0;
  return intersection.size / Math.max(w1.size, w2.size);
}

function getFuzzySimilarity(s1, s2) {
  const clean1 = s1.trim().toLowerCase();
  const clean2 = s2.trim().toLowerCase();
  if (clean1 === clean2) return 1.0;
  
  const len = Math.max(clean1.length, clean2.length);
  if (len === 0) return 1.0;
  
  const levSim = (len - levenshteinDistance(clean1, clean2)) / len;
  const wordOverlap = getWordOverlapScore(clean1, clean2);
  
  return Math.max(levSim, wordOverlap);
}

function resolveRegistryExerciseName(templateName) {
  if (!state.exerciseRegistry) return templateName;
  
  // 1. Exact match (case-insensitive)
  const keys = Object.keys(state.exerciseRegistry);
  const exactMatch = keys.find(k => k.trim().toLowerCase() === templateName.trim().toLowerCase());
  if (exactMatch) return exactMatch;
  
  // 2. Fuzzy match
  let bestMatch = null;
  let highestScore = 0;
  
  keys.forEach(registryName => {
    const score = getFuzzySimilarity(templateName, registryName);
    if (score > highestScore) {
      highestScore = score;
      bestMatch = registryName;
    }
  });
  
  if (highestScore >= 0.6 && bestMatch) {
    console.log(`Fuzzy match detected: auto-healing "${templateName}" to "${bestMatch}" (similarity: ${highestScore.toFixed(2)})`);
    
    if (templateName !== bestMatch) {
      setTimeout(() => {
        migrateHistoryExerciseName(templateName, bestMatch);
        dispatchExerciseRenameToSheets(templateName, bestMatch);
      }, 0);
    }
    
    return bestMatch;
  }
  
  return templateName;
}

function migrateHistoryExerciseName(oldName, newName) {
  let changed = false;
  for (const date in state.history) {
    const log = state.history[date];
    if (log && log.exercises) {
      log.exercises.forEach(ex => {
        if (ex.name === oldName) {
          ex.name = newName;
          changed = true;
        }
      });
    }
  }
  if (changed) {
    localStorage.setItem(KEYS.HISTORY, JSON.stringify(state.history));
    console.log(`Auto-migrated local history exercise name from "${oldName}" to "${newName}"`);
    renderCalendar();
  }
}

async function dispatchExerciseRenameToSheets(oldName, newName) {
  const webhookUrl = getWebhookUrl();
  if (!webhookUrl || webhookUrl.includes('YOUR_APPS_SCRIPT_ID')) return;
  
  const payload = {
    type: "migrate-exercises",
    renames: [
      { oldName: oldName, newName: newName }
    ]
  };
  
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    console.log(`Dispatched exercise rename migration from "${oldName}" to "${newName}" to Google Sheets.`);
  } catch (err) {
    console.error("Failed to dispatch rename migration to Google Sheets", err);
  }
}

function getExpandedRoutineConfig() {
  const config = getRoutineConfig();
  if (!config) return config;
  
  const expanded = JSON.parse(JSON.stringify(config));
  
  // Merge custom day templates
  const customTemplates = JSON.parse(localStorage.getItem('custom_day_templates') || '{}');
  for (const name in customTemplates) {
    if (!expanded[name]) {
      expanded[name] = JSON.parse(JSON.stringify(customTemplates[name]));
    }
  }
  
  let modified = false;
  
  for (const day in expanded) {
    if (expanded[day] && expanded[day].exercises) {
      expanded[day].exercises = expanded[day].exercises.map(ex => {
        const resolvedName = resolveRegistryExerciseName(ex.name);
        if (resolvedName !== ex.name) {
          ex.name = resolvedName;
          modified = true;
        }
        
        const reg = state.exerciseRegistry[resolvedName] || {};
        const resolvedTag = reg.default_tag || ex.tag || 'Base';
        const resolvedTarget = reg.muscle_tags || ex.target || 'Other';
        const resolvedSets = getSetsForTag(resolvedTag);
        
        return {
          name: resolvedName,
          tag: resolvedTag,
          target: resolvedTarget,
          sets: resolvedSets
        };
      });
    }
  }
  
  if (modified) {
    const rawConfig = getRoutineConfig();
    for (const day in rawConfig) {
      if (rawConfig[day] && rawConfig[day].exercises) {
        rawConfig[day].exercises.forEach((rawEx, idx) => {
          const resolvedEx = expanded[day].exercises[idx];
          if (resolvedEx) {
            rawEx.name = resolvedEx.name;
          }
        });
      }
    }
    saveRoutineConfig(rawConfig);
  }
  
  return expanded;
}

// Load application state from localStorage
function loadStateFromStorage() {
  // Load authentication session
  const savedSession = localStorage.getItem(KEYS.SESSION);
  if (savedSession) {
    try {
      state.auth = JSON.parse(savedSession);
    } catch (e) {
      console.error("Failed to parse saved session", e);
    }
  }

  // Load history logs (User mode only)
  if (state.auth.loggedIn && state.auth.mode === 'user') {
    const savedHistory = localStorage.getItem(KEYS.HISTORY);
    if (savedHistory) {
      try {
        state.history = JSON.parse(savedHistory);
        migrateLocalHistoryExerciseNames();
        runExerciseMigrationOnSheets();
        autoLogPastRestDays();
      } catch (e) {
        console.error("Failed to parse history", e);
      }
    }

    const savedSwaps = localStorage.getItem(KEYS.WEEK_SWAPS);
    if (savedSwaps) {
      try {
        state.weekSwaps = JSON.parse(savedSwaps);
      } catch (e) {
        console.error("Failed to parse swaps", e);
      }
    }

    const savedWeight = localStorage.getItem(KEYS.WEIGHT_HISTORY);
    if (savedWeight) {
      try {
        state.weightHistory = JSON.parse(savedWeight) || {};
      } catch (e) {
        console.error("Failed to parse weight history", e);
      }
    } else {
      state.weightHistory = {};
    }
  } else {
    state.weightHistory = {};
  }

  // Load exercise registry (Both User and Guest modes, as long as loggedIn)
  if (state.auth.loggedIn) {
    const savedRegistry = localStorage.getItem(KEYS.EXERCISE_REGISTRY);
    if (savedRegistry) {
      try {
        state.exerciseRegistry = JSON.parse(savedRegistry) || {};
      } catch (e) {
        console.error("Failed to parse exercise registry", e);
        state.exerciseRegistry = {};
      }
    } else {
      state.exerciseRegistry = {};
    }
    initExerciseRegistry();
  } else {
    state.exerciseRegistry = {};
  }
}

function initExerciseRegistry() {
  if (!state.exerciseRegistry) {
    state.exerciseRegistry = {};
  }
  const config = getRoutineConfig();
  let modified = false;
  for (const day in config) {
    if (config[day] && config[day].exercises) {
      config[day].exercises.forEach(ex => {
        if (!state.exerciseRegistry[ex.name]) {
          // New entry: create from DEFAULT_EXERCISE_REGISTRY
          const defaultEx = DEFAULT_EXERCISE_REGISTRY[ex.name] || {};
          state.exerciseRegistry[ex.name] = {
            notes: '',
            muscle_tags: defaultEx.muscle_tags || 'Other',
            default_tag: defaultEx.default_tag || 'Base'
          };
          modified = true;
        }
      });
    }
  }
  if (modified) {
    localStorage.setItem(KEYS.EXERCISE_REGISTRY, JSON.stringify(state.exerciseRegistry));
  }
}

// Redirect client on load based on active states
function routeToInitialView() {
  if (!state.auth.loggedIn) {
    showView('login-view');
    return;
  }

  // Check for active crash recovery workout (User Mode only)
  if (state.auth.mode === 'user') {
    const activeData = localStorage.getItem(KEYS.ACTIVE_WORKOUT);
    if (activeData) {
      try {
        const recovered = JSON.parse(activeData);
        if (recovered && recovered.isActive) {
          state.activeWorkout = recovered;
          showView('workout-view');
          renderActiveCard();
          updateProfileTag();
          // Restore stopwatch from saved start time
          if (recovered.stopwatchStartTime) {
            startStopwatch(recovered.stopwatchStartTime, recovered.lapStartTime);
          } else {
            startStopwatch();
          }
          if (recovered.lastLapFrozenTime) {
            const frozenEl = document.getElementById('lap-time-frozen');
            if (frozenEl) {
              frozenEl.textContent = recovered.lastLapFrozenTime;
              frozenEl.style.display = 'inline-block';
            }
          }
          return;
        }
      } catch (e) {
        console.error("Failed to recover crash active workout", e);
      }
    }
  }

  // Fallback to Dashboard
  showView('dashboard-view');
  initDashboard();
}

// Slide-aware View Switcher using View Transitions API
function showView(viewId, direction = 'forward') {
  const updateDOM = () => {
    document.querySelectorAll('.view-panel').forEach(panel => {
      panel.classList.remove('active');
    });
    const activePanel = document.getElementById(viewId);
    if (activePanel) {
      activePanel.classList.add('active');
      activePanel.scrollTop = 0;
    }

    // Toggle side drawer items based on active view
    const drawerDashboard = document.getElementById('btn-drawer-dashboard');
    const drawerAnalytics = document.getElementById('btn-drawer-analytics');
    if (drawerDashboard && drawerAnalytics) {
      if (viewId === 'analytics-view') {
        drawerDashboard.style.display = 'flex';
        drawerAnalytics.style.display = 'none';
      } else {
        drawerDashboard.style.display = 'none';
        drawerAnalytics.style.display = 'flex';
      }
    }
  };

  // Check if browser supports View Transitions
  if (document.startViewTransition) {
    document.startViewTransition({
      update: updateDOM,
      types: [direction]
    });
  } else {
    updateDOM();
  }
}

function updateProfileTag() {
  const tag = document.getElementById('profile-tag');
  const configBtn = document.getElementById('btn-drawer-config');
  const dashboardView = document.getElementById('dashboard-view');
  if (tag) {
    if (state.auth.mode === 'guest') {
      tag.textContent = 'Guest Mode';
      tag.style.background = 'rgba(252, 163, 17, 0.15)';
      tag.style.color = 'var(--accent-gold)';
      document.getElementById('guest-banner').style.display = 'block';
      if (configBtn) configBtn.style.display = 'none';
      if (dashboardView) dashboardView.classList.add('guest-mode');
    } else {
      tag.textContent = 'Anmol P.';
      tag.style.background = 'rgba(191, 155, 254, 0.1)';
      tag.style.color = 'var(--accent-lavender)';
      document.getElementById('guest-banner').style.display = 'none';
      if (configBtn) configBtn.style.display = 'flex';
      if (dashboardView) dashboardView.classList.remove('guest-mode');
    }
  }
}

// -------------------------------------------------------------
// 1. Auth & Login Modules
// -------------------------------------------------------------
function setupEventListeners() {
  try {
  document.getElementById('btn-user-login-prompt').addEventListener('click', () => {
    document.querySelector('.login-choices').style.display = 'none';
    document.getElementById('auth-form').classList.add('active');
    resetPatternLock();
  });
  
  document.getElementById('btn-login-back').addEventListener('click', () => {
    document.getElementById('auth-form').classList.remove('active');
    document.querySelector('.login-choices').style.display = 'flex';
  });

  document.getElementById('btn-guest-login').addEventListener('click', () => {
    state.auth = { loggedIn: true, mode: 'guest' };
    localStorage.setItem(KEYS.SESSION, JSON.stringify(state.auth));
    // Clear volatile state
    state.history = {};
    state.weekSwaps = {};
    
    loadStateFromStorage();
    showView('dashboard-view');
    initDashboard();
  });

  // Hamburger Side Drawer Actions
  document.getElementById('btn-hamburger').addEventListener('click', () => {
    document.getElementById('side-drawer').classList.add('active');
  });

  const btnAnalyticsHamburger = document.getElementById('btn-analytics-hamburger');
  if (btnAnalyticsHamburger) {
    btnAnalyticsHamburger.addEventListener('click', () => {
      document.getElementById('side-drawer').classList.add('active');
    });
  }

  const btnDrawerDashboard = document.getElementById('btn-drawer-dashboard');
  if (btnDrawerDashboard) {
    btnDrawerDashboard.addEventListener('click', () => {
      document.getElementById('side-drawer').classList.remove('active');
      showView('dashboard-view', 'backward');
      initDashboard();
    });
  }

  document.getElementById('btn-close-drawer').addEventListener('click', () => {
    document.getElementById('side-drawer').classList.remove('active');
  });

  document.getElementById('side-drawer').addEventListener('click', (e) => {
    if (e.target.id === 'side-drawer') {
      document.getElementById('side-drawer').classList.remove('active');
    }
  });

  document.getElementById('btn-drawer-config').addEventListener('click', () => {
    document.getElementById('side-drawer').classList.remove('active');
    openConfigPanel();
  });

  document.getElementById('btn-drawer-split').addEventListener('click', () => {
    document.getElementById('side-drawer').classList.remove('active');
    openSplitPanel();
  });

  document.getElementById('btn-drawer-analytics').addEventListener('click', () => {
    document.getElementById('side-drawer').classList.remove('active');
    openAnalyticsPanel();
  });

  document.getElementById('btn-drawer-csv').addEventListener('click', () => {
    document.getElementById('side-drawer').classList.remove('active');
    downloadHistoryCSV();
  });

  document.getElementById('btn-drawer-logout').addEventListener('click', () => {
    document.getElementById('side-drawer').classList.remove('active');
    state.auth = { loggedIn: false, mode: 'user' };
    localStorage.removeItem(KEYS.SESSION);
    localStorage.removeItem(KEYS.ACTIVE_WORKOUT);
    showView('login-view', 'backward');
    document.getElementById('auth-form').classList.remove('active');
    document.querySelector('.login-choices').style.display = 'flex';
  });
  
  document.getElementById('btn-close-config').addEventListener('click', () => {
    showView('dashboard-view', 'backward');
    initDashboard();
  });

  document.getElementById('btn-close-split').addEventListener('click', () => {
    showView('dashboard-view', 'backward');
    initDashboard();
  });



  document.getElementById('btn-save-routine').addEventListener('click', () => {
    saveRoutineFromEditor();
  });

  document.getElementById('btn-save-split').addEventListener('click', () => {
    saveSplitChanges();
  });

  document.getElementById('btn-save-webhook').addEventListener('click', () => {
    const url = document.getElementById('webhook-url-input').value.trim();
    saveWebhookUrl(url);
    alert('Webhook URL updated successfully.');
  });

  document.getElementById('btn-logout').addEventListener('click', () => {
    state.auth = { loggedIn: false, mode: 'user' };
    localStorage.removeItem(KEYS.SESSION);
    localStorage.removeItem(KEYS.ACTIVE_WORKOUT);
    showView('login-view', 'backward');
    
    document.getElementById('auth-form').classList.remove('active');
    document.querySelector('.login-choices').style.display = 'flex';
  });

  document.getElementById('btn-reset-data').addEventListener('click', () => {
    if (confirm('CRITICAL WARNING: This will permanently wipe all local history, saved config, and reset the database. Are you sure?')) {
      localStorage.clear();
      state.history = {};
      state.weightHistory = {};
      state.weekSwaps = {};
      state.auth = { loggedIn: false, mode: 'user' };
      showView('login-view', 'backward');
      
      document.getElementById('auth-form').classList.remove('active');
      document.querySelector('.login-choices').style.display = 'flex';
    }
  });

  // Calendar Navigator
  document.getElementById('btn-prev-month').addEventListener('click', () => {
    currentCalDate.setMonth(currentCalDate.getMonth() - 1);
    renderCalendar();
  });
  
  document.getElementById('btn-next-month').addEventListener('click', () => {
    currentCalDate.setMonth(currentCalDate.getMonth() + 1);
    renderCalendar();
  });



  // Start Workout Action
  document.getElementById('btn-start-workout').addEventListener('click', () => {
    startActiveWorkoutSession();
  });

  // Custom Swap Menu Trigger and Modal Controllers
  const swapTrigger = document.getElementById('swap-select-trigger');
  if (swapTrigger) {
    swapTrigger.addEventListener('click', () => {
      openSwapWorkoutModal();
    });
  }

  const btnCloseSwapModal = document.getElementById('btn-close-swap-menu-modal');
  if (btnCloseSwapModal) {
    btnCloseSwapModal.addEventListener('click', () => {
      document.getElementById('swap-custom-menu-modal').close();
    });
  }

  const swapModal = document.getElementById('swap-custom-menu-modal');
  if (swapModal) enableLightDismiss(swapModal);

  // Swap Button Action
  const btnExecuteSwap = document.getElementById('btn-execute-swap');
  if (btnExecuteSwap) {
    btnExecuteSwap.addEventListener('click', () => {
      executeSwapAction();
    });
  }

  // Card view navigator
  document.getElementById('btn-prev-exercise').addEventListener('click', () => {
    if (state.activeWorkout.currentExerciseIndex > 0) {
      state.activeWorkout.currentExerciseIndex--;
      saveActiveWorkoutState();
      showView('workout-view', 'backward');
      renderActiveCard();
    } else {
      const dialog = document.getElementById('confirm-cancel-modal');
      const isEditing = state.activeWorkout.isEditingHistorical;
      
      // Select elements inside dialog and adjust text dynamically
      const titleEl = dialog.querySelector('.dialog-header');
      const bodyEl = dialog.querySelector('.dialog-body');
      const confirmBtn = dialog.querySelector('.btn-danger');
      const cancelBtn = dialog.querySelector('.btn-secondary');
      
      if (titleEl) titleEl.textContent = isEditing ? 'Cancel Edits?' : 'Cancel Workout?';
      if (bodyEl) {
        bodyEl.textContent = isEditing 
          ? 'Are you sure you want to discard your edits to this workout? All changes made will be lost.' 
          : "Are you sure you want to cancel today's workout? All current progress will be lost and discarded.";
      }
      if (confirmBtn) confirmBtn.textContent = isEditing ? 'Discard Edits' : 'Yes, Cancel Workout';
      if (cancelBtn) cancelBtn.textContent = isEditing ? 'Keep Editing' : 'No, Keep Tracking';
      
      dialog.showModal();
    }
  });

  document.getElementById('btn-next-exercise').addEventListener('click', () => {
    handleCardNextAction();
  });

  // Modals Submit triggers
  const confirmEndDialog = document.getElementById('confirm-end-modal');
  confirmEndDialog.addEventListener('close', () => {
    if (confirmEndDialog.returnValue === 'confirm') {
      concludeWorkoutSession();
    }
  });

  // Historical Log Viewer Button
  document.getElementById('btn-edit-historical-workout').addEventListener('click', () => {
    document.getElementById('history-log-modal').close();
    editHistoricalWorkout();
  });

  // Prevent any horizontal scrolling on panels
  document.querySelectorAll('.view-panel').forEach(panel => {
    panel.addEventListener('scroll', () => {
      if (panel.scrollLeft !== 0) {
        panel.scrollLeft = 0;
      }
    });
  });

  // Cancel Workout Modal handler
  const confirmCancelDialog = document.getElementById('confirm-cancel-modal');
  confirmCancelDialog.addEventListener('close', () => {
    if (confirmCancelDialog.returnValue === 'confirm') {
      cancelActiveWorkoutSession();
    }
  });

  // Lap Button
  document.getElementById('btn-lap').addEventListener('click', () => {
    handleLapButton();
  });

  // Test Webhook click handler
  document.getElementById('btn-test-webhook').addEventListener('click', () => {
    testWebhookSync();
  });

  // Restore History click handler
  document.getElementById('btn-restore-history').addEventListener('click', () => {
    restoreHistoryFromSheets();
  });

  setupNotesAndSubstitutionListeners();
  setupWorkoutAddExerciseListeners();
  // Create Custom Day click handler (inline card creator)
  const btnCreateCustom = document.getElementById('btn-create-custom-day');
  if (btnCreateCustom) {
    btnCreateCustom.addEventListener('click', () => {
      if (!splitDraft) return;
      const newKey = `_custom_${Date.now()}`;
      splitDraft[newKey] = {
        label: 'New Custom Day',
        isRest: false,
        exercises: []
      };
      renderSplitEditor();
      
      // Auto-scroll to the bottom of the container
      setTimeout(() => {
        const wrapper = document.getElementById('split-days-container');
        if (wrapper) {
          wrapper.scrollTop = wrapper.scrollHeight;
        }
      }, 50);
    });
  }

  // Split Workout Selector Modal Controllers
  const btnCloseSplitSelect = document.getElementById('btn-close-split-select-modal');
  if (btnCloseSplitSelect) {
    btnCloseSplitSelect.addEventListener('click', () => {
      document.getElementById('split-workout-select-modal').close();
    });
  }

  const splitSelectModal = document.getElementById('split-workout-select-modal');
  if (splitSelectModal) enableLightDismiss(splitSelectModal);

  // Daily Weight dashboard input and history modal input
  document.getElementById('btn-save-weight').addEventListener('click', () => {
    const todayStr = getLocalDateString();
    const val = document.getElementById('dashboard-weight-input').value.trim();
    if (val === '') {
      alert('Please enter a valid weight.');
      return;
    }
    saveWeightLog(todayStr, val);
    renderDashboardWeight();
    renderCalendar();
  });

  document.getElementById('btn-edit-weight').addEventListener('click', () => {
    const inputContainer = document.getElementById('weight-input-container');
    const displayContainer = document.getElementById('weight-display-container');
    const saveBtn = document.getElementById('btn-save-weight');
    if (inputContainer && displayContainer && saveBtn) {
      inputContainer.style.display = 'flex';
      displayContainer.style.display = 'none';
      saveBtn.textContent = 'Update';
    }
  });

  document.getElementById('btn-save-history-weight').addEventListener('click', (e) => {
    const dateStr = e.target.dataset.date;
    const val = document.getElementById('history-weight-input').value.trim();
    if (!dateStr) return;
    saveWeightLog(dateStr, val);
    
    // Switch history weight card back to display state if weight was entered
    const inputContainer = document.getElementById('history-weight-input-container');
    const displayContainer = document.getElementById('history-weight-display-container');
    const displayVal = document.getElementById('history-weight-display');
    const saveBtn = document.getElementById('btn-save-history-weight');
    
    if (inputContainer && displayContainer && displayVal && saveBtn) {
      if (val !== '') {
        displayVal.textContent = `${parseFloat(val)} lbs`;
        inputContainer.style.display = 'none';
        displayContainer.style.display = 'flex';
      } else {
        displayVal.textContent = `-- lbs`;
        saveBtn.textContent = 'Log';
        inputContainer.style.display = 'flex';
        displayContainer.style.display = 'none';
      }
    }

    if (dateStr === getLocalDateString()) {
      renderDashboardWeight();
    }
    renderCalendar();
  });

  document.getElementById('btn-edit-history-weight').addEventListener('click', () => {
    const inputContainer = document.getElementById('history-weight-input-container');
    const displayContainer = document.getElementById('history-weight-display-container');
    const saveBtn = document.getElementById('btn-save-history-weight');
    if (inputContainer && displayContainer && saveBtn) {
      inputContainer.style.display = 'flex';
      displayContainer.style.display = 'none';
      saveBtn.textContent = 'Update';
    }
  });

  // Stats modal triggers
  const profileTag = document.getElementById('profile-tag');
  const statsModal = document.getElementById('stats-modal');
  const closeStatsBtn = document.getElementById('btn-close-stats');
  if (profileTag && statsModal) {
    profileTag.addEventListener('click', () => {
      if (state.auth.mode === 'user') {
        calculateConsistencyStats();
        statsModal.showModal();
      }
    });
  }
  if (closeStatsBtn && statsModal) {
    closeStatsBtn.addEventListener('click', () => {
      statsModal.close();
    });
  }

  // Historical Log Rest Day listener
  const btnLogHistRest = document.getElementById('btn-log-historical-rest');
  if (btnLogHistRest) {
    btnLogHistRest.addEventListener('click', () => {
      const dateStr = btnLogHistRest.dataset.date;
      if (dateStr) {
        logRestDay(dateStr);
      }
    });
  }
  } catch (err) {
    console.error('[PARTIAL+ SETUP ERROR]', err);
    alert('App initialization error: ' + err.message + '\n\nCheck console for details.');
  }
}

// -------------------------------------------------------------
// 2. Date Utilities & Week Swap Controller
// -------------------------------------------------------------
function getLocalDateString(date) {
  if (!date) {
    date = new Date();
  }
  const offset = date.getTimezoneOffset();
  const localDate = new Date(date.getTime() - (offset*60*1000));
  return localDate.toISOString().split('T')[0];
}

function getWeekMonday(dateStr) {
  const parts = dateStr.split('-');
  if (parts.length !== 3) {
    throw new Error(`Invalid date format for Monday adjustment: "${dateStr}"`);
  }
  const d = new Date(parts[0], parts[1] - 1, parts[2]); // timezone-safe local date
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid date for Monday adjustment: "${dateStr}"`);
  }
  const day = d.getDay(); // 0 (Sun) - 6 (Sat)
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust to Monday
  const monday = new Date(d.setDate(diff));
  
  const year = monday.getFullYear();
  const month = String(monday.getMonth() + 1).padStart(2, '0');
  const dayNum = String(monday.getDate()).padStart(2, '0');
  return `${year}-${month}-${dayNum}`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Get template day assigned to a weekday name for a given week Monday
function getTemplateDayForWeekday(dayName, weekId) {
  const weekSwapMap = state.weekSwaps[weekId];
  if (weekSwapMap && weekSwapMap[dayName]) {
    return weekSwapMap[dayName];
  }
  return dayName;
}

// Get templates assigned for a date, resolving custom swaps
function getAssignedTemplateDay(dateStr) {
  const dateObj = new Date(dateStr + 'T00:00:00');
  const dayName = WEEKDAYS[dateObj.getDay()];
  const weekId = getWeekMonday(dateStr);
  return getTemplateDayForWeekday(dayName, weekId);
}

// -------------------------------------------------------------
// 3. Dashboard Builder & Calendar Widget
// -------------------------------------------------------------
function initDashboard() {
  updateProfileTag();
  
  const todayStr = getLocalDateString();
  const dateObj = new Date(todayStr + 'T00:00:00');
  
  // Format Header Dates
  const headerDateStr = dateObj.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  document.getElementById('dashboard-date').textContent = headerDateStr;
  
  const dayName = WEEKDAYS[dateObj.getDay()];
  document.getElementById('dashboard-day-name').textContent = dayName;

  // Render current day routine details
  renderTodayRoutineDetails(todayStr);

  // Render daily weight display
  renderDashboardWeight();
  // Render Calendar widget
  renderCalendar();
}

function renderTodayRoutineDetails(dateStr) {
  const dateObj = new Date(dateStr + 'T00:00:00');
  const todayDayName = WEEKDAYS[dateObj.getDay()];
  const templateDay = getAssignedTemplateDay(dateStr);
  const config = getExpandedRoutineConfig();
  const routine = config[templateDay];
  
  const labelEl = document.getElementById('today-routine-label');
  const exercisesEl = document.getElementById('today-routine-exercises');
  const swapTrigger = document.getElementById('swap-select-trigger');
  const startBtn = document.getElementById('btn-start-workout');

  const hasCompletedToday = !!state.history[dateStr];

  // Set visual label details
  labelEl.textContent = routine.isRest ? 'Rest Day' : routine.label;
  
  if (hasCompletedToday) {
    const completedLog = state.history[dateStr];
    if (completedLog) {
      if (completedLog.exercises && completedLog.exercises.length === 0) {
        exercisesEl.textContent = 'Logged Rest Day. Recovered successfully!';
        startBtn.style.display = 'none';
      } else {
        const list = completedLog.exercises.map(ex => ex.name).join(', ');
        exercisesEl.textContent = list;
        startBtn.textContent = 'Edit Workout';
        startBtn.style.display = 'block';
      }
    } else {
      exercisesEl.textContent = routine.exercises.map(ex => ex.name).join(', ');
      startBtn.textContent = 'Edit Workout';
      startBtn.style.display = 'block';
    }
    if (swapTrigger) swapTrigger.disabled = true;
  } else {
    startBtn.textContent = 'Start Workout';
    if (swapTrigger) swapTrigger.disabled = false;
    if (routine.isRest) {
      exercisesEl.textContent = 'Enjoy your rest day! Recover well.';
      startBtn.style.display = 'none';
    } else {
      const list = routine.exercises.map(ex => ex.name).join(', ');
      exercisesEl.textContent = list;
      startBtn.style.display = 'block';
    }
  }

  // Update Swap Selector UI Text
  const currentTemplateInfo = config[templateDay];
  const triggerText = currentTemplateInfo.isRest ? `${todayDayName} (Rest Day)` : `${todayDayName} (${currentTemplateInfo.label})`;
  const triggerTextEl = document.getElementById('swap-select-current-text');
  if (triggerTextEl) triggerTextEl.textContent = triggerText;
}

// -------------------------------------------------------------
// Redesigned Swap Workout Engine
// -------------------------------------------------------------
let selectedSwapTarget = null;

async function openSwapWorkoutModal() {
  const modal = document.getElementById('swap-custom-menu-modal');
  if (!modal) return;
  
  selectedSwapTarget = null;
  renderSwapWorkoutModal();
  modal.showModal();
  
  // Background dynamic history sync fetch from Sheets
  const webhookUrl = getWebhookUrl();
  if (webhookUrl && !webhookUrl.includes('YOUR_APPS_SCRIPT_ID') && state.auth.mode === 'user') {
    try {
      console.log("Swap Menu: Fetching latest history from Google Sheets for dynamic sync...");
      const response = await fetch(webhookUrl);
      if (response.ok) {
        const result = await response.json();
        let workoutRows = [];
        if (Array.isArray(result)) {
          workoutRows = result;
        } else if (result && typeof result === 'object') {
          workoutRows = result.workouts || [];
        }
        
        if (workoutRows.length > 0) {
          updateHistoryFromRows(workoutRows);
          renderSwapWorkoutModal();
        }
      }
    } catch (err) {
      console.warn("Swap Menu: Background history sync failed", err);
    }
  }
}

function updateHistoryFromRows(workoutRows) {
  const reconstructed = {};
  workoutRows.forEach(row => {
    const dateVal = getRowValue(row, ['date']);
    const dayLabel = getRowValue(row, ['day_label', 'dayLabel', 'day']) || '';
    const exerciseName = getRowValue(row, ['exercise_name', 'exerciseName', 'exercise']) || '';
    const setNumber = getRowValue(row, ['set_number', 'setNumber', 'set']) || '';
    const tag = getRowValue(row, ['tag']) || '';
    const weight = getRowValue(row, ['weight']) || '0';
    const reps = getRowValue(row, ['reps']) || '0';
    const rir = getRowValue(row, ['rir']) || '0';
    const workoutNote = getRowValue(row, ['workout_note', 'workoutNote', 'note']) || '';
    let elapsedTime = getRowValue(row, ['workout_time', 'workoutTime', 'elapsed_time', 'elapsedTime', 'time']) || '00:00';
    
    if (dayLabel === 'Test Connection' || !dateVal || dateVal === 'undefined') return;
    
    let parsedDate = dateVal;
    if (typeof parsedDate === 'string' && parsedDate.includes('T')) {
      parsedDate = parsedDate.split('T')[0];
    }
    const d = new Date(parsedDate + 'T00:00:00');
    if (isNaN(d.getTime())) return;
    
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const date = `${year}-${month}-${day}`;
    
    if (!reconstructed[date]) {
      reconstructed[date] = {
        date: date,
        dayLabel: dayLabel,
        templateDay: '',
        elapsedTime: elapsedTime,
        workoutNote: '',
        exercises: []
      };
    }
    
    if (exerciseName === 'Rest Day' && !setNumber) {
      return;
    }
    
    let ex = reconstructed[date].exercises.find(e => e.name === exerciseName);
    if (!ex) {
      ex = {
        name: exerciseName,
        tag: tag,
        target: '',
        workoutNote: '',
        setData: []
      };
      reconstructed[date].exercises.push(ex);
    }
    
    if (workoutNote && parseInt(setNumber) === 1) {
      ex.workoutNote = workoutNote;
    }
    
    const setIndex = parseInt(setNumber) - 1;
    if (!isNaN(setIndex) && setIndex >= 0) {
      ex.setData[setIndex] = {
        weight: weight,
        reps: reps,
        rir: rir
      };
    }
  });
  
  for (const date in reconstructed) {
    try {
      const parts = date.split('-');
      if (parts.length !== 3) continue;
      
      reconstructed[date].exercises.forEach(ex => {
        ex.setData = ex.setData.filter(s => s !== undefined);
      });
      
      const d = new Date(parts[0], parts[1] - 1, parts[2]);
      if (isNaN(d.getTime())) continue;
      
      const dayOfWeek = WEEKDAYS[d.getDay()];
      const weekMonday = getWeekMonday(date);
      reconstructed[date].templateDay = getTemplateDayForWeekday(dayOfWeek, weekMonday);
      
      state.history[date] = reconstructed[date];
    } catch (e) {
      console.warn("Error parsing row for date " + date, e);
    }
  }
  
  syncLocalRestDaysWithSheet(workoutRows);
  autoLogPastRestDays();
  localStorage.setItem(KEYS.HISTORY, JSON.stringify(state.history));
  renderCalendar();
}

function renderSwapWorkoutModal() {
  const todayStr = getLocalDateString();
  const dateObj = new Date(todayStr + 'T00:00:00');
  const todayDayName = WEEKDAYS[dateObj.getDay()];
  const weekId = getWeekMonday(todayStr);
  
  const config = getExpandedRoutineConfig();
  const weekDays = getWeekDaysList(weekId);
  
  selectedSwapTarget = null;
  const executeBtn = document.getElementById('btn-execute-swap');
  if (executeBtn) executeBtn.setAttribute('disabled', 'true');
  
  // Render Top Section (Standard Week)
  const weekDaysContainer = document.getElementById('swap-week-days-list');
  if (weekDaysContainer) {
    weekDaysContainer.innerHTML = '';
    
    weekDays.forEach(wd => {
      const dayName = wd.dayName;
      const dateStr = wd.dateStr;
      const assignedTemplate = getTemplateDayForWeekday(dayName, weekId);
      
      const isToday = (dateStr === todayStr);
      const isCompleted = !!state.history[dateStr];
      
      let workoutLabel = '';
      if (isCompleted) {
        workoutLabel = state.history[dateStr].dayLabel;
      } else {
        const routine = config[assignedTemplate];
        workoutLabel = (routine && routine.isRest) ? 'Rest Day' : (routine ? routine.label : assignedTemplate);
      }
      
      const row = document.createElement('div');
      row.className = 'swap-week-row';
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.padding = '6px 12px'; // Decreased padding to reclaim vertical space
      row.style.transition = 'all 0.2s ease';
      row.style.borderRadius = '10px';
      row.style.margin = '1px 4px'; // Decreased margin to reclaim vertical space
      row.style.border = '1px solid transparent';
      
      if (isToday) {
        row.style.background = 'rgba(191, 155, 254, 0.05)';
        row.style.border = '1px solid rgba(191, 155, 254, 0.2)';
      }
      
      // Radio Selector Dot (clean, minimal purple circle selector)
      const selectDot = document.createElement('div');
      selectDot.className = 'swap-select-dot';
      selectDot.style.width = '12px';
      selectDot.style.height = '12px';
      selectDot.style.borderRadius = '50%';
      selectDot.style.border = '2.5px solid rgba(255,255,255,0.2)';
      selectDot.style.marginRight = '12px';
      selectDot.style.flexShrink = '0';
      selectDot.style.boxSizing = 'border-box';
      selectDot.style.transition = 'all 0.2s ease';
      selectDot.style.background = 'transparent';
      
      // Day label (left)
      const dayLabelEl = document.createElement('div');
      dayLabelEl.style.flex = '1';
      dayLabelEl.style.textAlign = 'left';
      dayLabelEl.style.fontSize = '13px';
      dayLabelEl.style.fontWeight = '600';
      dayLabelEl.innerHTML = `${dayName} ${isToday ? '<span style="font-size:10px; color:var(--accent-lavender); margin-left:4px; font-weight:700;">TODAY</span>' : ''}`;
      dayLabelEl.style.color = isToday ? 'var(--accent-lavender)' : 'var(--text-primary)';
      
      // Divider
      const divider = document.createElement('div');
      divider.style.width = '1px';
      divider.style.height = '18px';
      divider.style.background = 'rgba(255,255,255,0.1)';
      divider.style.margin = '0 14px';
      
      // Workout indicator card (right)
      const indicator = document.createElement('div');
      indicator.style.flex = '1.2';
      indicator.style.textAlign = 'center';
      indicator.style.padding = '6px 10px';
      indicator.style.borderRadius = '8px';
      indicator.style.fontSize = '12px';
      indicator.style.fontWeight = '600';
      indicator.style.transition = 'all 0.2s ease';
      indicator.textContent = workoutLabel;
      
      if (isCompleted) {
        indicator.style.background = 'rgba(255,255,255,0.03)';
        indicator.style.color = 'var(--text-muted)';
        row.style.opacity = '0.4';
        row.classList.add('disabled');
        selectDot.style.opacity = '0.3';
      } else {
        if (workoutLabel === 'Rest Day') {
          indicator.style.background = 'rgba(0, 245, 212, 0.05)';
          indicator.style.color = 'var(--accent-mint)';
          indicator.style.border = '1px solid rgba(0, 245, 212, 0.15)';
        } else {
          indicator.style.background = 'rgba(191, 155, 254, 0.08)';
          indicator.style.color = 'var(--accent-lavender)';
          indicator.style.border = '1px solid rgba(191, 155, 254, 0.2)';
        }
        
        if (!isToday) {
          row.style.cursor = 'pointer';
          row.addEventListener('click', () => {
            selectSwapTarget({ type: 'day', value: dayName }, row);
          });
        }
      }
      
      row.appendChild(selectDot);
      row.appendChild(dayLabelEl);
      row.appendChild(divider);
      row.appendChild(indicator);
      weekDaysContainer.appendChild(row);
    });
  }
  
  // Render Bottom Section (Workouts Consolidated list)
  const customList = document.getElementById('swap-custom-section-list');
  if (customList) {
    customList.innerHTML = '';
    
    // 1. Custom workouts
    const customTemplates = JSON.parse(localStorage.getItem('custom_day_templates') || '{}');
    const customNames = Object.keys(customTemplates).sort();
    
    // 2. Active standard workouts currently in split
    const activeWeekdayTemplates = new Set();
    const standardDays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    standardDays.forEach(day => {
      const dayData = config[day];
      if (dayData) {
        if (dayData.isRest) {
          activeWeekdayTemplates.add("Rest Day");
        } else if (dayData.label) {
          activeWeekdayTemplates.add(dayData.label);
        }
      }
    });
    const standardWorkoutNames = Array.from(activeWeekdayTemplates).sort();
    
    const renderWorkoutPill = (name, isCustom, exerciseCount, associatedKey) => {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'swap-custom-pill';
      pill.style.width = '100%';
      pill.style.textAlign = 'left';
      pill.style.background = 'rgba(255,255,255,0.03)';
      pill.style.border = '1px solid var(--border-glass)';
      pill.style.borderRadius = '12px';
      pill.style.padding = '8px 12px'; // Decreased padding to save space
      pill.style.color = 'var(--text-primary)';
      pill.style.fontFamily = 'inherit';
      pill.style.fontSize = '13px';
      pill.style.cursor = 'pointer';
      pill.style.transition = 'all 0.2s ease';
      pill.style.display = 'flex';
      pill.style.alignItems = 'center';
      pill.style.boxSizing = 'border-box';
      pill.style.margin = '2px 0';
      
      // Radio Selector Dot (clean, minimal purple circle selector)
      const selectDot = document.createElement('div');
      selectDot.className = 'swap-select-dot';
      selectDot.style.width = '12px';
      selectDot.style.height = '12px';
      selectDot.style.borderRadius = '50%';
      selectDot.style.border = '2.5px solid rgba(255,255,255,0.2)';
      selectDot.style.marginRight = '12px';
      selectDot.style.flexShrink = '0';
      selectDot.style.boxSizing = 'border-box';
      selectDot.style.transition = 'all 0.2s ease';
      selectDot.style.background = 'transparent';
      
      const labelText = document.createElement('div');
      labelText.style.flex = '1';
      labelText.style.display = 'flex';
      labelText.style.justifyContent = 'space-between';
      labelText.style.alignItems = 'center';
      labelText.innerHTML = `
        <span style="font-weight:600;">${name}</span>
        <span style="font-size:10px; color:var(--text-muted); font-weight: 500;">
          ${isCustom ? '<span style="color:var(--accent-lavender); font-weight:700; margin-right:4px;">CUSTOM</span>' : ''}${exerciseCount} ex.
        </span>
      `;
      
      pill.appendChild(selectDot);
      pill.appendChild(labelText);
      
      pill.addEventListener('click', () => {
        selectSwapTarget({ type: 'custom', value: associatedKey }, pill);
      });
      
      customList.appendChild(pill);
    };

    // Render Custom Workouts at the top
    customNames.forEach(name => {
      const exCount = customTemplates[name].exercises ? customTemplates[name].exercises.length : 0;
      renderWorkoutPill(name, true, exCount, name);
    });

    // Render Standard Workouts active in split underneath
    standardWorkoutNames.forEach(name => {
      let exCount = 0;
      let associatedKey = '';
      if (name === "Rest Day") {
        exCount = 0;
        associatedKey = "Thursday"; // Map Rest Day to Thursday config
      } else {
        // Find standard day with this label to get exercise count and key
        const foundDay = standardDays.find(day => config[day] && config[day].label === name);
        if (foundDay) {
          associatedKey = foundDay;
          if (config[foundDay].exercises) {
            exCount = config[foundDay].exercises.length;
          }
        }
      }
      if (associatedKey) {
        renderWorkoutPill(name, false, exCount, associatedKey);
      }
    });
  }
}

function selectSwapTarget(target, element) {
  selectedSwapTarget = target;
  
  // Clear other selector dots (leaving backgrounds/borders/halos clean and unchanged)
  document.querySelectorAll('.swap-select-dot').forEach(dot => {
    dot.style.background = 'transparent';
    dot.style.borderColor = 'rgba(255,255,255,0.2)';
  });
  
  // Apply clean purple circle selection indicator to target element's dot
  if (element) {
    const dot = element.querySelector('.swap-select-dot');
    if (dot) {
      dot.style.background = 'var(--accent-lavender)';
      dot.style.borderColor = 'var(--accent-lavender)';
    }
  }
  
  const executeBtn = document.getElementById('btn-execute-swap');
  if (executeBtn) {
    executeBtn.removeAttribute('disabled');
  }
}

async function executeSwapAction() {
  if (!selectedSwapTarget) return;
  
  const executeBtn = document.getElementById('btn-execute-swap');
  if (!executeBtn) return;
  
  executeBtn.disabled = true;
  const originalHtml = executeBtn.innerHTML;
  executeBtn.innerHTML = `<span class="spinner-icon">⏳</span> Swapping...`;
  
  await new Promise(resolve => setTimeout(resolve, 600));
  
  const todayStr = getLocalDateString();
  const dateObj = new Date(todayStr + 'T00:00:00');
  const todayDayName = WEEKDAYS[dateObj.getDay()];
  const weekId = getWeekMonday(todayStr);
  const currentTemplate = getAssignedTemplateDay(todayStr);
  
  if (state.history[todayStr]) {
    showModalSwapBanner("Swap invalid: Today's workout has already been completed.", true);
    executeBtn.disabled = false;
    executeBtn.innerHTML = originalHtml;
    return;
  }
  
  if (selectedSwapTarget.type === 'day') {
    const targetDay = selectedSwapTarget.value;
    const selectedTemplate = getTemplateDayForWeekday(targetDay, weekId);
    
    if (selectedTemplate === currentTemplate) {
      showModalSwapBanner("Swap invalid: Today is already assigned to this template.", true);
      executeBtn.disabled = false;
      executeBtn.innerHTML = originalHtml;
      return;
    }
    
    if (!state.weekSwaps[weekId]) {
      state.weekSwaps[weekId] = {
        "Monday": "Monday",
        "Tuesday": "Tuesday",
        "Wednesday": "Wednesday",
        "Thursday": "Thursday",
        "Friday": "Friday",
        "Saturday": "Saturday",
        "Sunday": "Sunday"
      };
    }
    
    // Trade (reciprocal swap)
    const currentSwaps = state.weekSwaps[weekId];
    const temp = currentSwaps[todayDayName];
    currentSwaps[todayDayName] = currentSwaps[targetDay];
    currentSwaps[targetDay] = temp;
    
    if (state.auth.mode === 'user') {
      localStorage.setItem(KEYS.WEEK_SWAPS, JSON.stringify(state.weekSwaps));
    }
    
  } else if (selectedSwapTarget.type === 'custom') {
    const customTemplateName = selectedSwapTarget.value;
    
    if (customTemplateName === currentTemplate) {
      showModalSwapBanner("Swap invalid: Today is already assigned to this template.", true);
      executeBtn.disabled = false;
      executeBtn.innerHTML = originalHtml;
      return;
    }
    
    if (!state.weekSwaps[weekId]) {
      state.weekSwaps[weekId] = {
        "Monday": "Monday",
        "Tuesday": "Tuesday",
        "Wednesday": "Wednesday",
        "Thursday": "Thursday",
        "Friday": "Friday",
        "Saturday": "Saturday",
        "Sunday": "Sunday"
      };
    }
    
    // Overwrite
    const currentSwaps = state.weekSwaps[weekId];
    currentSwaps[todayDayName] = customTemplateName;
    
    if (state.auth.mode === 'user') {
      localStorage.setItem(KEYS.WEEK_SWAPS, JSON.stringify(state.weekSwaps));
    }
  }
  
  renderTodayRoutineDetails(todayStr);
  renderCalendar();
  
  showModalSwapBanner("Swap completed!", false);
  
  // Instantly re-render the modal card to validate new states without auto-closing!
  renderSwapWorkoutModal();
  
  executeBtn.disabled = false;
  executeBtn.innerHTML = originalHtml;
}

function showModalSwapBanner(message, isError) {
  const banner = document.getElementById('swap-modal-status-banner');
  if (banner) {
    banner.textContent = message;
    banner.style.background = isError ? 'rgba(255, 95, 85, 0.15)' : 'rgba(0, 245, 212, 0.15)';
    banner.style.color = isError ? 'var(--accent-red)' : 'var(--accent-mint)';
    banner.style.border = `1px solid ${isError ? 'rgba(255, 95, 85, 0.25)' : 'rgba(0, 245, 212, 0.25)'}`;
    banner.style.display = 'block';
    
    setTimeout(() => {
      banner.style.display = 'none';
    }, 3000);
  }
}

function getWeekDaysList(mondayStr) {
  const list = [];
  const start = new Date(mondayStr + 'T00:00:00');
  const dayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  for (let i = 0; i < 7; i++) {
    const temp = new Date(start);
    temp.setDate(start.getDate() + i);
    list.push({
      dateStr: temp.toISOString().split('T')[0],
      dayName: dayNames[i]
    });
  }
  return list;
}

// -------------------------------------------------------------
// Calendar Rendering engine
// -------------------------------------------------------------
function renderCalendar() {
  const monthTitle = document.getElementById('calendar-month-title');
  const grid = document.getElementById('calendar-grid');

  const year = currentCalDate.getFullYear();
  const month = currentCalDate.getMonth();

  monthTitle.textContent = currentCalDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  // Clear previous grid elements (keeping labels)
  const labels = Array.from(grid.querySelectorAll('.calendar-day-label'));
  grid.innerHTML = '';
  labels.forEach(l => grid.appendChild(l));

  // Determine date bounds
  const firstDay = new Date(year, month, 1);
  // getDay() gives 0 (Sun) to 6 (Sat). We want Monday (1) to Sunday (0) matching columns:
  // Col 0: Mon, Col 1: Tue, ... Col 6: Sun
  let startCol = firstDay.getDay() - 1;
  if (startCol === -1) startCol = 6; // Sunday gets index 6

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();

  const todayStr = getLocalDateString();

  // 1. Render previous month overhang days
  for (let i = startCol - 1; i >= 0; i--) {
    const dayNum = daysInPrevMonth - i;
    const prevDate = new Date(year, month - 1, dayNum);
    createDayCell(prevDate, true);
  }

  // 2. Render active month days
  for (let i = 1; i <= daysInMonth; i++) {
    const activeDate = new Date(year, month, i);
    createDayCell(activeDate, false);
  }

  // 3. Render next month overhang days (pad grid to multiples of 7)
  const totalCells = startCol + daysInMonth;
  const targetCells = totalCells <= 28 ? 28 : (totalCells <= 35 ? 35 : 42); // Dynamic 4, 5 or 6 row grid to save screen space
  const nextMonthCells = targetCells - totalCells;
  for (let i = 1; i <= nextMonthCells; i++) {
    const nextDate = new Date(year, month + 1, i);
    createDayCell(nextDate, true);
  }
}

function createDayCell(dateObj, isOtherMonth) {
  const grid = document.getElementById('calendar-grid');
  const cell = document.createElement('div');
  
  const dateStr = dateObj.toISOString().split('T')[0];
  const dayNum = dateObj.getDate();

  cell.classList.add('calendar-day');
  cell.textContent = dayNum;

  if (isOtherMonth) {
    cell.classList.add('other-month');
  }

  // Highlight if today
  const todayStr = getLocalDateString();
  if (dateStr === todayStr) {
    cell.classList.add('today');
  }

  const log = state.history[dateStr];
  if (log) {
    if (log.exercises && log.exercises.length === 0) {
      cell.classList.add('completed-rest');
    } else {
      cell.classList.add('completed');
    }
  }

  // Handle tap log detail display and future day style
  if (dateStr > todayStr) {
    cell.classList.add('future');
  } else {
    cell.addEventListener('click', () => {
      showCalendarDayDetails(dateStr);
    });
  }

  grid.appendChild(cell);
}

// -------------------------------------------------------------
// 4. Workout Session Controller
// -------------------------------------------------------------
function startActiveWorkoutSession() {
  const todayStr = getLocalDateString();
  
  // Redirect to edit mode if today's workout is already completed
  if (state.history[todayStr]) {
    startEditingTodayWorkout(todayStr);
    return;
  }

  const templateDay = getAssignedTemplateDay(todayStr);
  const config = getExpandedRoutineConfig();
  const routine = config[templateDay];

  if (routine.isRest) {
    alert("Today is a Rest Day. You can swap days to start a workout session.");
    return;
  }

  // Initialize active workout object
  state.activeWorkout = {
    date: todayStr,
    dayOfWeek: WEEKDAYS[new Date(todayStr + 'T00:00:00').getDay()],
    dayLabel: routine.label,
    templateDay: templateDay,
    isActive: true,
    currentExerciseIndex: 0,
    isEditingHistorical: false,
    editDate: '',
    workoutNote: '',
    lastLapFrozenTime: '',
    // Clone config structure and pre-fill matrix variables
    exercises: routine.exercises.map(ex => {
      const data = [];
      for (let i = 0; i < ex.sets; i++) {
        // Prepopulate failure protocols
        const defaultRir = isFailureSet(ex.tag, i) ? '0' : '';
        data.push({ weight: '', reps: '', rir: defaultRir });
      }
      return {
        name: ex.name,
        tag: ex.tag,
        target: ex.target,
        sets: ex.sets,
        workoutNote: '',
        setData: data
      };
    })
  };

  startStopwatch();
  saveActiveWorkoutState();
  showView('workout-view');
  renderActiveCard();

  // Trigger Apple Watch shortcut start signal via x-callback-url (launches WorkoutStart and automatically returns to PWA)
  const successUrl = encodeURIComponent(window.location.href);
  window.location.href = `shortcuts://x-callback-url/run-shortcut?name=WorkoutStart&x-success=${successUrl}`;
}

// Determine if a set is automatically failure protocol
function isFailureSet(tag, setIndex) {
  // setIndex is 0-indexed: Set 3 is index 2
  if (tag === 'Base') {
    return true; // all sets of Base fail
  }
  if ((tag === 'HC' || tag === 'LLP') && setIndex === 2) {
    return true; // 3rd set of Compounds/Pumps fail
  }
  return false;
}

// Save active session status for crash recovery
function saveActiveWorkoutState() {
  if (state.auth.mode === 'user') {
    // Persist stopwatch start time for crash recovery
    const saveData = { ...state.activeWorkout };
    if (stopwatchStartTime) {
      saveData.stopwatchStartTime = stopwatchStartTime;
    }
    if (lapStartTime) {
      saveData.lapStartTime = lapStartTime;
    }
    localStorage.setItem(KEYS.ACTIVE_WORKOUT, JSON.stringify(saveData));
  }
}

// -------------------------------------------------------------
// Stopwatch & Lap Timer Engine
// -------------------------------------------------------------
function startStopwatch(savedStartTime, savedLapStartTime) {
  // Clear any existing interval
  if (stopwatchInterval) clearInterval(stopwatchInterval);
  
  stopwatchStartTime = savedStartTime || Date.now();
  lapStartTime = savedLapStartTime || Date.now();
  
  updateStopwatchDisplay();
  updateLapDisplay();
  
  stopwatchInterval = setInterval(() => {
    updateStopwatchDisplay();
    updateLapDisplay();
  }, 10);
}

function stopStopwatch() {
  if (stopwatchInterval) {
    clearInterval(stopwatchInterval);
    stopwatchInterval = null;
  }
  stopwatchStartTime = null;
  lapStartTime = null;
  
  // Reset displays
  const stopwatchEl = document.getElementById('stopwatch-display');
  const lapEl = document.getElementById('lap-time');
  if (stopwatchEl) stopwatchEl.textContent = '00:00';
  if (lapEl) lapEl.textContent = '00:00';
  
  const frozenEl = document.getElementById('lap-time-frozen');
  if (frozenEl) {
    frozenEl.textContent = '';
    frozenEl.style.display = 'none';
  }
}

function formatElapsed(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  
  const pad = (n) => String(n).padStart(2, '0');
  
  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}

function updateStopwatchDisplay() {
  if (!stopwatchStartTime) return;
  const elapsed = Date.now() - stopwatchStartTime;
  const el = document.getElementById('stopwatch-display');
  if (el) el.textContent = formatElapsed(elapsed);
}

function updateLapDisplay() {
  if (!lapStartTime) return;
  const elapsed = Date.now() - lapStartTime;
  const el = document.getElementById('lap-time');
  if (el) el.textContent = formatElapsedWithTenths(elapsed);
}

function formatElapsedWithTenths(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hundredths = Math.floor((ms % 1000) / 10);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(minutes)}:${pad(seconds)}.${pad(hundredths)}`;
}

function handleLapButton() {
  if (!lapStartTime) return;
  const snapshotMs = Date.now() - lapStartTime;
  const formatted = formatElapsedWithTenths(snapshotMs);
  
  state.activeWorkout.lastLapFrozenTime = formatted;
  
  const frozenEl = document.getElementById('lap-time-frozen');
  if (frozenEl) {
    frozenEl.textContent = formatted;
    frozenEl.style.display = 'inline-block';
  }

  // Reset lap timer
  lapStartTime = Date.now();
  updateLapDisplay();
  saveActiveWorkoutState();
  
  // Flash animation on button
  const btn = document.getElementById('btn-lap');
  btn.classList.remove('flash');
  void btn.offsetWidth; // trigger reflow
  btn.classList.add('flash');
}

// -------------------------------------------------------------
// Render Card Details
// -------------------------------------------------------------
function renderActiveCard() {
  const wk = state.activeWorkout;
  const index = wk.currentExerciseIndex;
  const ex = wk.exercises[index];

  // Headings & Metas
  document.getElementById('workout-view-day-label').textContent = wk.isEditingHistorical ? `Editing: ${wk.dayLabel}` : wk.dayLabel;
  
  // Format nice human-readable date
  const dateObj = new Date(wk.date + 'T00:00:00');
  const fmtDate = dateObj.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  document.getElementById('workout-view-date').textContent = fmtDate;

  // Show/hide stopwatch & lap timer (hidden during edit sessions)
  const stopwatchEl = document.getElementById('stopwatch-display');
  const lapBar = document.getElementById('lap-timer-bar');
  if (wk.isEditingHistorical) {
    stopwatchEl.style.display = 'none';
    lapBar.style.display = 'none';
  } else {
    stopwatchEl.style.display = 'block';
    lapBar.style.display = 'flex';
  }

  // Progress Bar
  const progressPercent = Math.round(((index) / wk.exercises.length) * 100);
  document.getElementById('workout-progress-fill').style.width = `${progressPercent}%`;

  document.getElementById('exercise-name').textContent = ex.name;
  
  // Resolve muscle target tag (fallback to configuration lookup if missing)
  const targetMuscle = ex.target || getExerciseTarget(ex.name);
  const targetEl = document.getElementById('exercise-target');
  if (targetEl) {
    targetEl.textContent = targetMuscle || '';
    targetEl.style.display = targetMuscle ? 'inline-block' : 'none';
  }
  
  const tagEl = document.getElementById('exercise-tag');
  tagEl.textContent = ex.tag;
  tagEl.className = `tag-badge ${ex.tag.toLowerCase()}`;

  // Populate Input Matrix rows
  const container = document.getElementById('set-rows-container');
  container.innerHTML = '';

  ex.setData.forEach((set, i) => {
    const isLocked = isFailureSet(ex.tag, i);
    const row = document.createElement('div');
    row.classList.add('matrix-row');

    row.innerHTML = `
      <div class="set-number">S${i + 1}</div>
      <div class="matrix-input-wrapper">
        <input type="number" step="any" inputmode="decimal" class="matrix-input val-weight" 
               placeholder="0" value="${set.weight}" data-set="${i}">
      </div>
      <div class="matrix-input-wrapper">
        <input type="number" inputmode="numeric" class="matrix-input val-reps" 
               placeholder="0" value="${set.reps}" data-set="${i}">
      </div>
      <div class="matrix-input-wrapper ${isLocked ? 'locked' : ''}">
        <input type="number" inputmode="numeric" class="matrix-input val-rir" 
               placeholder="${isLocked ? '0' : '0-5'}" value="${set.rir}" data-set="${i}" ${isLocked ? 'disabled readonly' : ''}>
      </div>
    `;

    // Attach listeners for autosaving on value alterations
    row.querySelectorAll('input').forEach(input => {
      input.addEventListener('input', (e) => {
        handleInputValueChange(i, e.target);
      });
      
      input.addEventListener('focus', (e) => {
        handleInputFocus(e.target);
      });

      input.addEventListener('blur', () => {
        handleInputBlur();
      });

      // Jump focus when pressing enter in cell fields
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          focusAdjacentInput(1);
        }
      });
    });

    container.appendChild(row);
  });

  // Calculate and display last session averages for this exercise
  const prevStats = getPreviousExerciseStats(ex.name, wk.date);
  const prevDateEl = document.getElementById('prev-stats-date');
  const prevWeightEl = document.getElementById('prev-stats-weight');
  const prevRepsEl = document.getElementById('prev-stats-reps');
  const prevRirEl = document.getElementById('prev-stats-rir');
  
  if (prevDateEl && prevWeightEl && prevRepsEl && prevRirEl) {
    if (prevStats) {
      prevDateEl.textContent = formatShortDate(prevStats.date);
      prevWeightEl.value = prevStats.weight;
      prevRepsEl.value = prevStats.reps;
      prevRirEl.value = prevStats.rir;
    } else {
      prevDateEl.textContent = '--/--';
      prevWeightEl.value = '--';
      prevRepsEl.value = '--';
      prevRirEl.value = '--';
    }
  }

  // Populate notepads
  const setupNotesEl = document.getElementById('exercise-setup-notes');
  if (setupNotesEl) {
    setupNotesEl.value = (state.exerciseRegistry[ex.name] && state.exerciseRegistry[ex.name].notes) || '';
  }
  const sessionNoteEl = document.getElementById('workout-session-note');
  if (sessionNoteEl) {
    sessionNoteEl.value = ex.workoutNote || '';
  }

  // Footer Navigation Buttons mapping
  const prevBtn = document.getElementById('btn-prev-exercise');
  const nextBtn = document.getElementById('btn-next-exercise');

  if (index === 0) {
    prevBtn.textContent = wk.isEditingHistorical ? 'Cancel Edits' : 'Cancel Workout';
    prevBtn.disabled = false;
    prevBtn.classList.add('cancel-style');
  } else {
    prevBtn.textContent = '◀ Prev';
    prevBtn.disabled = false;
    prevBtn.classList.remove('cancel-style');
  }

  if (index === wk.exercises.length - 1) {
    nextBtn.textContent = wk.isEditingHistorical ? 'Save Changes' : 'End Workout';
    nextBtn.classList.remove('btn-secondary');
    nextBtn.classList.add('btn-start'); // Glow effect
  } else {
    nextBtn.textContent = 'Next ▶';
    nextBtn.classList.remove('btn-start');
    nextBtn.classList.add('nav-arrow-btn');
  }
}

// -------------------------------------------------------------
// Autosave & Input Navigation Focus Controllers
// -------------------------------------------------------------
function handleInputValueChange(setIndex, element) {
  const wk = state.activeWorkout;
  const ex = wk.exercises[wk.currentExerciseIndex];
  const set = ex.setData[setIndex];

  if (element.classList.contains('val-weight')) {
    set.weight = element.value;
    // Auto-populate subsequent sets if editing Set 1 (index 0)
    if (setIndex === 0) {
      for (let i = 1; i < ex.setData.length; i++) {
        ex.setData[i].weight = element.value;
        const otherInput = document.querySelector(`.matrix-input.val-weight[data-set="${i}"]`);
        if (otherInput) otherInput.value = element.value;
      }
    }
  } else if (element.classList.contains('val-reps')) {
    set.reps = element.value;
    // Auto-populate subsequent sets if editing Set 1 (index 0)
    if (setIndex === 0) {
      for (let i = 1; i < ex.setData.length; i++) {
        ex.setData[i].reps = element.value;
        const otherInput = document.querySelector(`.matrix-input.val-reps[data-set="${i}"]`);
        if (otherInput) otherInput.value = element.value;
      }
    }
  } else if (element.classList.contains('val-rir')) {
    set.rir = element.value;
    // Auto-populate subsequent sets if editing Set 1 (index 0)
    if (setIndex === 0) {
      for (let i = 1; i < ex.setData.length; i++) {
        if (!isFailureSet(ex.tag, i)) {
          ex.setData[i].rir = element.value;
          const otherInput = document.querySelector(`.matrix-input.val-rir[data-set="${i}"]`);
          if (otherInput) otherInput.value = element.value;
        }
      }
    }
  }

  saveActiveWorkoutState();
}

function handleInputFocus(inputElement) {
  // Wait short delay for iOS softkeyboard layout transition
  setTimeout(() => {
    // Select all text in input to allow instant overwriting
    if (typeof inputElement.select === 'function') {
      inputElement.select();
    }
    if (typeof inputElement.setSelectionRange === 'function') {
      // For mobile iOS Safari support
      inputElement.setSelectionRange(0, 9999);
    }

    // Explicitly lock horizontal viewport scroll state
    const activePanel = document.querySelector('.view-panel.active');
    if (activePanel) activePanel.scrollLeft = 0;
    document.documentElement.scrollLeft = 0;
    document.body.scrollLeft = 0;
  }, 100);
}

function handleInputBlur() {
  // Intentionally left blank
}

// Focus Jumping
function focusAdjacentInput(direction) {
  const container = document.getElementById('set-rows-container');
  // Query all active focusable inputs
  const inputs = Array.from(container.querySelectorAll('input:not([disabled])'));
  const activeInput = document.activeElement;

  if (!activeInput || !inputs.includes(activeInput)) return;

  const idx = inputs.indexOf(activeInput);
  const nextIdx = idx + direction;

  if (nextIdx >= 0 && nextIdx < inputs.length) {
    inputs[nextIdx].focus();
  } else if (nextIdx >= inputs.length) {
    // Blurs last item
    activeInput.blur();
    // Auto trigger Next Card navigation if final input was confirmed
    // But don't do it instantly to avoid user confusion
  }
}

// Next Button Navigator Action
function handleCardNextAction() {
  const wk = state.activeWorkout;
  const index = wk.currentExerciseIndex;

  if (index < wk.exercises.length - 1) {
    wk.currentExerciseIndex++;
    saveActiveWorkoutState();
    showView('workout-view');
    renderActiveCard();
  } else {
    // Reached final card - prompt submission modal
    const dialog = document.getElementById('confirm-end-modal');
    const msg = document.getElementById('end-workout-message');
    
    if (wk.isEditingHistorical) {
      msg.textContent = `Are you sure you want to save modifications for historical date ${wk.date}? This will overwrite the previous record.`;
    } else {
      msg.textContent = `Are you sure you want to finish and log today's session? All completed sets will be synced and stored.`;
    }

    dialog.showModal();
  }
}

function cancelActiveWorkoutSession() {
  // Stop stopwatch
  stopStopwatch();

  // Clear recovery memory
  localStorage.removeItem(KEYS.ACTIVE_WORKOUT);

  // Reset active workout state
  state.activeWorkout = {
    date: '',
    dayOfWeek: '',
    dayLabel: '',
    templateDay: '',
    exercises: [],
    isActive: false,
    currentExerciseIndex: 0,
    isEditingHistorical: false,
    editDate: ''
  };

  showView('dashboard-view', 'backward');
  initDashboard();
}

async function pushExerciseRegistryToSheets(url) {
  const webhookUrl = url || getWebhookUrl();
  if (!webhookUrl || webhookUrl.includes('YOUR_APPS_SCRIPT_ID')) {
    return;
  }

  const customizedExercisePayload = Object.entries(state.exerciseRegistry).map(([name, config]) => {
    return {
      exercise_name: name,
      exercise_notes: config.notes || "",
      muscle_tags: config.muscle_tags || "",
      default_tag: config.default_tag || "Base"
    };
  });

  const payload = {
    action: "END_WORKOUT_COMMIT",
    log_data: [],
    exercise_notes: customizedExercisePayload
  };

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      mode: 'no-cors',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    });
    console.log("Exercise registry synchronized to Google Sheets.");
  } catch (err) {
    console.error("Failed to sync exercise registry", err);
  }
}

async function testWebhookSync() {
  const urlInput = document.getElementById('webhook-url-input');
  const statusDiv = document.getElementById('webhook-test-status');
  const url = urlInput.value.trim();

  if (!url || url.includes('YOUR_APPS_SCRIPT_ID')) {
    statusDiv.style.display = 'block';
    statusDiv.style.color = 'var(--accent-red)';
    statusDiv.textContent = '❌ Please enter your valid Google Apps Script URL first.';
    return;
  }

  statusDiv.style.display = 'block';
  statusDiv.style.color = 'var(--accent-lavender)';
  statusDiv.textContent = '⏳ Sending connection test payload...';

  const testPayload = [
    {
      date: new Date().toISOString().split('T')[0],
      dayLabel: 'Test Connection',
      workoutTime: '00:01',
      exerciseName: 'Webhook Verification Set',
      setNumber: 1,
      tag: 'Base',
      weight: '999',
      reps: '999',
      rir: '999'
    }
  ];

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(testPayload)
    });

    if (response.ok || response.status === 200) {
      statusDiv.style.color = 'var(--accent-mint)';
      statusDiv.textContent = '✅ Sync Successful! Test row and exercise registry appended.';
      pushExerciseRegistryToSheets(url);
    } else {
      throw new Error(`Google Sheets Webhook returned error code: ${response.status}`);
    }
  } catch (corsErr) {
    console.warn("Direct CORS check failed. Trying fallback request...", corsErr);
    try {
      await fetch(url, {
        method: 'POST',
        mode: 'no-cors',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(testPayload)
      });
      statusDiv.style.color = 'var(--accent-gold)';
      statusDiv.textContent = '⚠️ Dispatched (opaque mode). Exercise registry syncing dispatched.';
      pushExerciseRegistryToSheets(url);
    } catch (fallbackErr) {
      statusDiv.style.color = 'var(--accent-red)';
      statusDiv.textContent = `❌ Sync Failed: ${fallbackErr.message || fallbackErr}`;
    }
  }
}

// -------------------------------------------------------------
// 5. Conclude Workout Session & Webhook Pipeline
// -------------------------------------------------------------
async function concludeWorkoutSession() {
  const wk = state.activeWorkout;
  
  // Calculate elapsed time before stopping
  let elapsedStr = '00:00';
  if (wk.isEditingHistorical) {
    const existing = state.history[wk.date];
    elapsedStr = existing ? (existing.elapsedTime || '00:00') : '00:00';
  } else if (stopwatchStartTime) {
    const elapsedMs = Date.now() - stopwatchStartTime;
    elapsedStr = formatElapsed(elapsedMs);
  }

  // Stop stopwatch
  stopStopwatch();

  // Structure complete log entry
  const workoutRecord = {
    date: wk.date,
    dayLabel: wk.dayLabel,
    templateDay: wk.templateDay,
    elapsedTime: elapsedStr,
    workoutNote: '',
    exercises: wk.exercises.map(ex => ({
      name: ex.name,
      tag: ex.tag,
      target: ex.target,
      workoutNote: ex.workoutNote || '',
      setData: ex.setData.map(set => ({
        weight: set.weight || '0',
        reps: set.reps || '0',
        rir: set.rir || '0'
      }))
    }))
  };

  if (state.auth.mode === 'user') {
    // 1. Commit to history
    state.history[wk.date] = workoutRecord;
    localStorage.setItem(KEYS.HISTORY, JSON.stringify(state.history));

    // 2. Transmit to Google Sheet Webhook Async (non-blocking)
    transmitWebhookLog(workoutRecord).catch(err => console.error("Sheets sync error", err));
    
    // Clear recovery memory
    localStorage.removeItem(KEYS.ACTIVE_WORKOUT);
  } else {
    // Guest Mode - volatile storage
    if (confirm("Workout complete! Guest Mode data is volatile and will clear on refresh.\n\nWould you like to download this workout session as a CSV file?")) {
      downloadSingleWorkoutCSV(workoutRecord);
    }
  }

  // Trigger Apple Watch shortcut end signal via x-callback-url (launches WorkoutEnd and automatically returns to PWA)
  if (!wk.isEditingHistorical) {
    const successUrl = encodeURIComponent(window.location.href);
    window.location.href = `shortcuts://x-callback-url/run-shortcut?name=WorkoutEnd&x-success=${successUrl}`;
  }

  // Clear active state properties
  state.activeWorkout = {
    date: '', 
    dayOfWeek: '', 
    dayLabel: '', 
    templateDay: '', 
    exercises: [], 
    isActive: false, 
    currentExerciseIndex: 0, 
    isEditingHistorical: false, 
    editDate: '',
    workoutNote: '',
    lastLapFrozenTime: ''
  };

  showView('dashboard-view', 'backward');
  initDashboard();
}

async function transmitWebhookLog(record) {
  const webhookUrl = getWebhookUrl();
  if (!webhookUrl || webhookUrl.includes('YOUR_APPS_SCRIPT_ID')) {
    console.warn("Webhook URL placeholder active, skipping Sheets transmission.");
    return;
  }

  let transactionLogsPayload = [];
  if (!record.exercises || record.exercises.length === 0) {
    transactionLogsPayload.push({
      date: record.date,
      day_label: record.dayLabel || 'Rest Day',
      elapsed_time: record.elapsedTime || '00:00',
      exercise_name: 'Rest Day',
      set_number: '',
      tag: '',
      weight: '',
      reps: '',
      rir: '',
      workout_note: record.workoutNote || ""
    });
  } else {
    // Format flattened rows for App Script consumption
    const logsMatrix = [];
    record.exercises.forEach(ex => {
      ex.setData.forEach((set, i) => {
        logsMatrix.push({
          exercise_name: ex.name,
          set_number: i + 1,
          tag: ex.tag,
          weight: set.weight,
          reps: set.reps,
          rir: set.rir,
          workout_note: ex.workoutNote || ""
        });
      });
    });

    transactionLogsPayload = logsMatrix.map((set, index) => {
      return {
        date: record.date,
        day_label: record.dayLabel,
        elapsed_time: record.elapsedTime,
        exercise_name: set.exercise_name,
        set_number: set.set_number,
        tag: set.tag,
        weight: set.weight,
        reps: set.reps,
        rir: set.rir,
        workout_note: (set.set_number === 1) ? (set.workout_note || "") : ""
      };
    });
  }

  const customizedExercisePayload = Object.entries(state.exerciseRegistry).map(([name, config]) => {
    return {
      exercise_name: name,
      exercise_notes: config.notes || "",
      muscle_tags: config.muscle_tags || "",
      default_tag: config.default_tag || "Base"
    };
  });

  const runtimeBundlePayload = {
    action: "END_WORKOUT_COMMIT",
    log_data: transactionLogsPayload,
    exercise_notes: customizedExercisePayload
  };

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      mode: 'no-cors',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(runtimeBundlePayload)
    });
    console.log("Webhook payload dispatched successfully.");
  } catch (err) {
    console.error("Webhook payload delivery failure", err);
    alert("Sheets Sync Failed. Your local logs are saved safely in device memory.");
  }
}

// -------------------------------------------------------------
// 6. History Calendar Logs & Edit Capabilities
// -------------------------------------------------------------
function showCalendarDayDetails(dateStr) {
  const log = state.history[dateStr];
  const dialog = document.getElementById('history-log-modal');
  const title = document.getElementById('history-log-title');
  const label = document.getElementById('history-log-routine-label');
  const container = document.getElementById('history-log-details-container');
  const editBtn = document.getElementById('btn-edit-historical-workout');

  // Format header display date
  const dateObj = new Date(dateStr + 'T00:00:00');
  title.textContent = dateObj.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });

  if (log) {
    label.textContent = log.dayLabel;
    label.style.display = 'block';
    
    container.innerHTML = '';
    if (log.exercises && log.exercises.length === 0) {
      container.innerHTML = `<div style="text-align:center; padding: 20px 0; color: var(--accent-lavender); font-size: 13px; font-weight: 500;">Logged Rest Day. Recovered successfully!</div>`;
      editBtn.style.display = 'none';
    } else {
      log.exercises.forEach(ex => {
        const exDiv = document.createElement('div');
        exDiv.classList.add('history-exercise-log');
        
        const setsStr = ex.setData.map((set, i) => `S${i+1}: ${set.weight} lbs x ${set.reps} (RIR ${set.rir})`).join(', ');
        
        exDiv.innerHTML = `
          <div class="history-exercise-title">${ex.name} <span class="tag-badge ${ex.tag.toLowerCase()}" style="font-size:8px; padding:1px 4px;">${ex.tag}</span></div>
          <div class="history-sets-summary">${setsStr}</div>
          ${ex.workoutNote ? `<div class="history-ex-note" style="font-size:11.5px; color:var(--accent-lavender); margin-top:2px; font-style:italic; text-align: left; padding-left: 6px;">Note: ${ex.workoutNote}</div>` : ''}
        `;
        container.appendChild(exDiv);
      });

      // Enable Editing for history sessions (User Mode only)
      if (state.auth.mode === 'user') {
        editBtn.style.display = 'block';
        editBtn.dataset.date = dateStr;
      } else {
        editBtn.style.display = 'none';
      }
    }
  } else {
    // Unrecorded rest day details
    label.style.display = 'none';
    container.innerHTML = `<div style="text-align:center; padding: 20px 0; color: var(--text-muted); font-size: 13px;">No workout records logged for this day.</div>`;
    editBtn.style.display = 'none';
  }

  // Handle Log Rest Day button visibility
  const logRestBtn = document.getElementById('btn-log-historical-rest');
  if (logRestBtn) {
    logRestBtn.style.display = 'none';
  }

  // Pre-fill retroactive weight field for the selected day
  const weightInput = document.getElementById('history-weight-input');
  const histDisplay = document.getElementById('history-weight-display');
  const histInputContainer = document.getElementById('history-weight-input-container');
  const histDisplayContainer = document.getElementById('history-weight-display-container');
  const saveHistWeightBtn = document.getElementById('btn-save-history-weight');

  if (weightInput && histDisplay && histInputContainer && histDisplayContainer && saveHistWeightBtn) {
    const existingWeight = state.weightHistory[dateStr];
    saveHistWeightBtn.dataset.date = dateStr;
    
    if (existingWeight !== undefined && existingWeight !== null) {
      weightInput.value = existingWeight;
      histDisplay.textContent = `${existingWeight} lbs`;
      histInputContainer.style.display = 'none';
      histDisplayContainer.style.display = 'flex';
    } else {
      weightInput.value = '';
      histDisplay.textContent = '-- lbs';
      saveHistWeightBtn.textContent = 'Log';
      histInputContainer.style.display = 'flex';
      histDisplayContainer.style.display = 'none';
    }
  }

  dialog.showModal();
}

function editHistoricalWorkout() {
  const dateStr = document.getElementById('btn-edit-historical-workout').dataset.date;
  startEditingTodayWorkout(dateStr);
}

function startEditingTodayWorkout(dateStr) {
  const log = state.history[dateStr];

  if (!log) return;

  // Initialize edit session
  state.activeWorkout = {
    date: dateStr,
    dayOfWeek: WEEKDAYS[new Date(dateStr + 'T00:00:00').getDay()],
    dayLabel: log.dayLabel,
    templateDay: log.templateDay || getAssignedTemplateDay(dateStr),
    isActive: true,
    currentExerciseIndex: 0,
    isEditingHistorical: true,
    editDate: dateStr,
    workoutNote: log.workoutNote || log.workout_note || '',
    lastLapFrozenTime: '',
    // Deep clone from historical entries
    exercises: log.exercises.map(ex => ({
      name: ex.name,
      tag: ex.tag,
      target: ex.target,
      sets: ex.setData.length,
      workoutNote: ex.workoutNote || '',
      setData: ex.setData.map(set => ({
        weight: set.weight,
        reps: set.reps,
        rir: set.rir
      }))
    }))
  };

  saveActiveWorkoutState();
  showView('workout-view');
  renderActiveCard();
}

// -------------------------------------------------------------
// 7. CSV Downloader
// -------------------------------------------------------------
function downloadHistoryCSV() {
  const logs = Object.values(state.history).sort((a, b) => new Date(a.date) - new Date(b.date));

  if (logs.length === 0) {
    alert("No training history logged yet. Complete workouts to populate records.");
    return;
  }

  // Construct CSV content headers
  let csvContent = "Date,Day Label,Exercise Name,Set Number,Tag,Weight (lbs),Reps,Reps In Reserve (RIR)\n";

  logs.forEach(log => {
    log.exercises.forEach(ex => {
      ex.setData.forEach((set, i) => {
        // Enforce safety escaping
        const escapedName = ex.name.replace(/"/g, '""');
        csvContent += `"${log.date}","${log.dayLabel}","${escapedName}",${i+1},"${ex.tag}",${set.weight},${set.reps},${set.rir}\n`;
      });
    });
  });

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  
  link.setAttribute("href", url);
  link.setAttribute("download", `partial_plus_training_history_${getLocalDateString()}.csv`);
  link.style.visibility = 'hidden';
  
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function downloadSingleWorkoutCSV(record) {
  let csvContent = "Date,Day Label,Exercise Name,Set Number,Tag,Weight (lbs),Reps,Reps In Reserve (RIR)\n";
  record.exercises.forEach(ex => {
    ex.setData.forEach((set, i) => {
      const escapedName = ex.name.replace(/"/g, '""');
      csvContent += `"${record.date}","${record.dayLabel}","${escapedName}",${i+1},"${ex.tag}",${set.weight || 0},${set.reps || 0},${set.rir || 0}\n`;
    });
  });

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  
  link.setAttribute("href", url);
  link.setAttribute("download", `partial_plus_guest_workout_${record.date}.csv`);
  link.style.visibility = 'hidden';
  
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// -------------------------------------------------------------
// 8. Settings Editor JSON Validation Engine
// -------------------------------------------------------------
function openConfigPanel() {
  const jsonArea = document.getElementById('routine-config-json');
  const urlInput = document.getElementById('webhook-url-input');
  
  const config = getRoutineConfig();
  jsonArea.value = JSON.stringify(config, null, 2);
  
  urlInput.value = getWebhookUrl();

  showView('config-view');
  validateJsonOnTheFly();

  // Attach dynamic checker
  jsonArea.removeEventListener('input', validateJsonOnTheFly);
  jsonArea.addEventListener('input', validateJsonOnTheFly);
}

function validateJsonOnTheFly() {
  const val = document.getElementById('routine-config-json').value;
  const indicator = document.getElementById('validation-indicator');
  const saveBtn = document.getElementById('btn-save-routine');

  try {
    const parsed = JSON.parse(val);
    
    // Check configuration schema structures
    const weekdaysOrder = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    let structureValid = true;
    let missingKeys = [];

    weekdaysOrder.forEach(day => {
      if (!parsed[day]) {
        structureValid = false;
        missingKeys.push(day);
      } else {
        const item = parsed[day];
        if (typeof item.isRest === 'undefined' || !item.label) structureValid = false;
        if (!item.isRest && (!item.exercises || !Array.isArray(item.exercises))) structureValid = false;
      }
    });

    if (structureValid) {
      indicator.textContent = "✓ Valid Routine Config JSON Structure";
      indicator.className = "validation-indicator success";
      saveBtn.disabled = false;
    } else {
      indicator.textContent = `✗ Missing or invalid keys for: ${missingKeys.join(', ')}`;
      indicator.className = "validation-indicator error";
      saveBtn.disabled = true;
    }
  } catch (e) {
    indicator.textContent = `✗ JSON Parsing Error: ${e.message}`;
    indicator.className = "validation-indicator error";
    saveBtn.disabled = true;
  }
}

function saveRoutineFromEditor() {
  const jsonText = document.getElementById('routine-config-json').value;
  try {
    const config = JSON.parse(jsonText);
    saveRoutineConfig(config);
    alert("Routine Configuration successfully saved.");
    showView('dashboard-view', 'backward');
    initDashboard();
  } catch (e) {
    alert("Failed to save. Review validation errors.");
  }
}

// -------------------------------------------------------------
// Pattern Lock Module
// -------------------------------------------------------------
let patternDots = [
  { id: 1, x: 50, y: 50 },
  { id: 2, x: 140, y: 50 },
  { id: 3, x: 230, y: 50 },
  { id: 4, x: 50, y: 140 },
  { id: 5, x: 140, y: 140 },
  { id: 6, x: 230, y: 140 },
  { id: 7, x: 50, y: 230 },
  { id: 8, x: 140, y: 230 },
  { id: 9, x: 230, y: 230 }
];
let selectedPattern = [];
let currentTouchPos = null;
let isDrawingPattern = false;

function initPatternLock() {
  const canvas = document.getElementById('pattern-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Draw connecting lines
    if (selectedPattern.length > 0) {
      ctx.beginPath();
      const firstDot = patternDots.find(d => d.id === selectedPattern[0]);
      ctx.moveTo(firstDot.x, firstDot.y);
      for (let i = 1; i < selectedPattern.length; i++) {
        const dot = patternDots.find(d => d.id === selectedPattern[i]);
        ctx.lineTo(dot.x, dot.y);
      }
      if (isDrawingPattern && currentTouchPos) {
        ctx.lineTo(currentTouchPos.x, currentTouchPos.y);
      }
      ctx.strokeStyle = 'rgba(191, 155, 254, 0.85)';
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.shadowBlur = 10;
      ctx.shadowColor = 'rgba(191, 155, 254, 0.5)';
      ctx.stroke();
      ctx.shadowBlur = 0; // reset
    }
    
    // Draw dots
    patternDots.forEach(dot => {
      const isSelected = selectedPattern.includes(dot.id);
      
      // Outer ring
      ctx.beginPath();
      ctx.arc(dot.x, dot.y, 24, 0, Math.PI * 2);
      ctx.fillStyle = isSelected ? 'rgba(191, 155, 254, 0.15)' : 'rgba(255, 255, 255, 0.03)';
      ctx.strokeStyle = isSelected ? 'rgba(191, 155, 254, 0.6)' : 'rgba(255, 255, 255, 0.1)';
      ctx.lineWidth = 2;
      ctx.fill();
      ctx.stroke();
      
      // Inner dot
      ctx.beginPath();
      ctx.arc(dot.x, dot.y, 8, 0, Math.PI * 2);
      ctx.fillStyle = isSelected ? 'hsl(260, 95%, 78%)' : 'rgba(255, 255, 255, 0.3)';
      ctx.fill();
    });
  }
  
  function getPos(e) {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: (clientX - rect.left) * (canvas.width / rect.width),
      y: (clientY - rect.top) * (canvas.height / rect.height)
    };
  }
  
  function handleStart(e) {
    e.preventDefault();
    isDrawingPattern = true;
    selectedPattern = [];
    const pos = getPos(e);
    currentTouchPos = pos;
    checkCollision(pos);
    draw();
  }
  
  function handleMove(e) {
    if (!isDrawingPattern) return;
    e.preventDefault();
    const pos = getPos(e);
    currentTouchPos = pos;
    checkCollision(pos);
    draw();
  }
  
  function handleEnd(e) {
    if (!isDrawingPattern) return;
    isDrawingPattern = false;
    currentTouchPos = null;
    
    // Validate pattern: 7 -> 4 -> 2 -> 3 -> 6 -> 8 -> 5
    const correctPattern = [7, 4, 2, 3, 6, 8, 5];
    const isCorrect = selectedPattern.length === correctPattern.length &&
                      selectedPattern.every((val, index) => val === correctPattern[index]);
                      
    const authCard = document.getElementById('auth-form');
    if (isCorrect) {
      state.auth = { loggedIn: true, mode: 'user' };
      localStorage.setItem(KEYS.SESSION, JSON.stringify(state.auth));
      loadStateFromStorage();
      showView('dashboard-view');
      initDashboard();
    } else {
      // Trigger CSS shake animation on validation fail
      authCard.classList.remove('shake');
      void authCard.offsetWidth; // Trigger reflow
      authCard.classList.add('shake');
    }
    
    selectedPattern = [];
    draw();
  }
  
  function checkCollision(pos) {
    patternDots.forEach(dot => {
      const dist = Math.hypot(pos.x - dot.x, pos.y - dot.y);
      if (dist < 24) { // hit radius matches outer ring radius
        if (!selectedPattern.includes(dot.id)) {
          selectedPattern.push(dot.id);
          if (navigator.vibrate) {
            navigator.vibrate(20);
          }
        }
      }
    });
  }
  
  // Touch events
  canvas.addEventListener('touchstart', handleStart, { passive: false });
  canvas.addEventListener('touchmove', handleMove, { passive: false });
  canvas.addEventListener('touchend', handleEnd, { passive: false });
  
  // Mouse events
  canvas.addEventListener('mousedown', handleStart);
  
  // Window listeners for dragging outside canvas bounds
  window.addEventListener('mousemove', (e) => {
    if (isDrawingPattern) {
      handleMove(e);
    }
  });
  window.addEventListener('mouseup', (e) => {
    if (isDrawingPattern) {
      handleEnd(e);
    }
  });
  
  // Bind draw method window-wide for redraw/reset utility
  window.resetPatternLock = function() {
    selectedPattern = [];
    currentTouchPos = null;
    isDrawingPattern = false;
    draw();
  };
  
  draw();
}

function getRowValue(row, keys) {
  if (!row || typeof row !== 'object') return undefined;
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null) {
      return row[k];
    }
  }
  // Case-insensitive and fuzzy match (remove spaces, underscores, dashes, and convert to lower case)
  const normalizedKeys = keys.map(k => k.toLowerCase().replace(/[^a-z0-9]/g, ''));
  for (const actualKey in row) {
    const normActual = actualKey.toLowerCase().replace(/[^a-z0-9]/g, '');
    const idx = normalizedKeys.indexOf(normActual);
    if (idx !== -1) {
      return row[actualKey];
    }
  }
  return undefined;
}

function syncLocalRestDaysWithSheet(workoutRows) {
  if (state.auth.mode !== 'user') return;
  const datesOnSheet = new Set();
  
  workoutRows.forEach(row => {
    const dateVal = getRowValue(row, ['date']);
    if (!dateVal || dateVal === 'undefined') return;
    let parsedDate = dateVal;
    if (typeof parsedDate === 'string' && parsedDate.includes('T')) {
      parsedDate = parsedDate.split('T')[0];
    }
    const d = new Date(parsedDate + 'T00:00:00');
    if (!isNaN(d.getTime())) {
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      datesOnSheet.add(`${year}-${month}-${day}`);
    }
  });

  const history = state.history || {};
  let syncCount = 0;
  for (const date in history) {
    const record = history[date];
    if (record && (record.dayLabel === 'Rest Day' || (record.exercises && record.exercises.length === 0))) {
      if (!datesOnSheet.has(date)) {
        console.log(`Dynamic History Sync: Transmitting missing Rest Day for ${date} to Google Sheets...`);
        transmitWebhookLog(record).catch(err => console.error(`Error syncing Rest Day for ${date}:`, err));
        syncCount++;
      }
    }
  }
  if (syncCount > 0) {
    console.log(`Enqueued ${syncCount} local Rest Day(s) to Google Sheets sync pipeline.`);
  }
}

async function restoreHistoryFromSheets() {
  const statusEl = document.getElementById('webhook-restore-status');
  if (!statusEl) return;
  
  const webhookUrl = getWebhookUrl();
  if (!webhookUrl || webhookUrl.includes('YOUR_APPS_SCRIPT_ID')) {
    statusEl.style.display = 'block';
    statusEl.style.color = 'var(--accent-red)';
    statusEl.textContent = '❌ Invalid Google Webhook Deployment URL.';
    return;
  }
  
  statusEl.style.display = 'block';
  statusEl.style.color = 'var(--accent-lavender)';
  statusEl.textContent = '⏳ Fetching data from Google Sheet...';
  
  try {
    const response = await fetch(webhookUrl);
    if (!response.ok) {
      throw new Error(`HTTP Error: ${response.status}`);
    }
    const result = await response.json();
    
    if (result.status === "error") {
      throw new Error(result.message);
    }
    
    let workoutRows = [];
    let weightRows = [];
    let exerciseRows = [];
    
    if (Array.isArray(result)) {
      workoutRows = result;
    } else if (result && typeof result === 'object') {
      workoutRows = result.workouts || [];
      weightRows = result.weights || [];
      exerciseRows = result.exercises || [];
      const splitRows = result.split || [];
    } else {
      throw new Error("Invalid response format received from Google Sheet.");
    }
    
    // Sync local rest days to sheet if missing
    syncLocalRestDaysWithSheet(workoutRows);
    
    // Restore weight history
    const reconstructedWeights = {};
    weightRows.forEach(row => {
      const dateVal = getRowValue(row, ['date']);
      const weightVal = getRowValue(row, ['weight']);
      if (dateVal && weightVal !== undefined && weightVal !== null) {
        // Handle timezone safe local parsing
        let parsedDate = dateVal;
        if (typeof parsedDate === 'string' && parsedDate.includes('T')) {
          parsedDate = parsedDate.split('T')[0];
        }
        const d = new Date(parsedDate + 'T00:00:00');
        if (!isNaN(d.getTime())) {
          const year = d.getFullYear();
          const month = String(d.getMonth() + 1).padStart(2, '0');
          const day = String(d.getDate()).padStart(2, '0');
          const date = `${year}-${month}-${day}`;
          reconstructedWeights[date] = parseFloat(weightVal);
        }
      }
    });
    state.weightHistory = reconstructedWeights;
    localStorage.setItem(KEYS.WEIGHT_HISTORY, JSON.stringify(state.weightHistory));
    
    // Restore exercise metadata registry
    if (exerciseRows.length > 0) {
      const reconstructedRegistry = {};
      exerciseRows.forEach(row => {
        const name = getRowValue(row, ['exercise_name', 'exerciseName', 'exercise']);
        const notes = getRowValue(row, ['exercise_notes', 'exerciseNotes', 'notes', 'exercise_note', 'exerciseNote']) || '';
        const muscleTags = getRowValue(row, ['muscle_tags', 'muscleTags', 'tags', 'muscle_tag', 'muscleTag']) || '';
        const defaultTag = getRowValue(row, ['default_tag', 'defaultTag', 'default']) || 'Base';
        if (name) {
          reconstructedRegistry[name] = {
            notes: notes,
            muscle_tags: muscleTags,
            default_tag: defaultTag
          };
        }
      });
      state.exerciseRegistry = reconstructedRegistry;
      localStorage.setItem(KEYS.EXERCISE_REGISTRY, JSON.stringify(state.exerciseRegistry));
    }

    // Restore split configuration and custom day templates
    if (splitRows.length > 0) {
      const restoredWeekdayConfig = {
        "Monday": { label: "Rest Day", isRest: true, exercises: [] },
        "Tuesday": { label: "Rest Day", isRest: true, exercises: [] },
        "Wednesday": { label: "Rest Day", isRest: true, exercises: [] },
        "Thursday": { label: "Rest Day", isRest: true, exercises: [] },
        "Friday": { label: "Rest Day", isRest: true, exercises: [] },
        "Saturday": { label: "Rest Day", isRest: true, exercises: [] },
        "Sunday": { label: "Rest Day", isRest: true, exercises: [] }
      };
      const restoredCustomTemplates = {};

      splitRows.forEach(row => {
        const template = getRowValue(row, ['Template', 'template', 'Workout', 'workout']);
        const exercisesStr = getRowValue(row, ['Exercises', 'exercises', 'Movements', 'movements']) || '';
        const protocolsStr = getRowValue(row, ['Protocols', 'protocols', 'Tags', 'tags']) || '';
        const assignmentStr = getRowValue(row, ['Assignment', 'assignment', 'Day', 'day', 'Days', 'days']) || '';

        if (!template || !assignmentStr) return;

        const exercises = exercisesStr.split(',').map(s => s.trim()).filter(Boolean);
        const protocols = protocolsStr.split(',').map(s => s.trim()).filter(Boolean);
        const assignments = assignmentStr.split(',').map(s => s.trim()).filter(Boolean);

        const exObjects = exercises.map((name, idx) => {
          const protocol = protocols[idx] || 'Base';
          if (state.exerciseRegistry[name]) {
            state.exerciseRegistry[name].default_tag = protocol;
          }
          return { name };
        });

        assignments.forEach(asg => {
          if (asg === 'Custom') {
            if (template !== 'Rest Day') {
              restoredCustomTemplates[template] = {
                label: template,
                isRest: false,
                exercises: exObjects
              };
            }
          } else {
            const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
            if (days.includes(asg)) {
              if (template === 'Rest Day') {
                restoredWeekdayConfig[asg] = { label: "Rest Day", isRest: true, exercises: [] };
              } else {
                restoredWeekdayConfig[asg] = {
                  label: template,
                  isRest: false,
                  exercises: exObjects
                };
              }
            }
          }
        });
      });

      localStorage.setItem(KEYS.EXERCISE_REGISTRY, JSON.stringify(state.exerciseRegistry));
      saveRoutineConfig(restoredWeekdayConfig);
      localStorage.setItem('custom_day_templates', JSON.stringify(restoredCustomTemplates));
    }
    
    // Reconstruct history object
    const reconstructed = {};
    workoutRows.forEach(row => {
      const dateVal = getRowValue(row, ['date']);
      const dayLabel = getRowValue(row, ['day_label', 'dayLabel', 'day']) || '';
      const exerciseName = getRowValue(row, ['exercise_name', 'exerciseName', 'exercise']) || '';
      const setNumber = getRowValue(row, ['set_number', 'setNumber', 'set']) || '';
      const tag = getRowValue(row, ['tag']) || '';
      const weight = getRowValue(row, ['weight']) || '0';
      const reps = getRowValue(row, ['reps']) || '0';
      const rir = getRowValue(row, ['rir']) || '0';
      const workoutNote = getRowValue(row, ['workout_note', 'workoutNote', 'note']) || '';
      let elapsedTime = getRowValue(row, ['workout_time', 'workoutTime', 'elapsed_time', 'elapsedTime', 'time']) || '00:00';
      if (typeof elapsedTime === 'string' && elapsedTime.includes('T')) {
        const timePart = elapsedTime.split('T')[1];
        if (timePart) {
          elapsedTime = timePart.split('.')[0];
        }
      }

      // Skip connection verification test logs
      if (dayLabel === 'Test Connection' || !dateVal || dateVal === 'undefined') {
        return;
      }
      
      let parsedDate = dateVal;
      if (typeof parsedDate === 'string' && parsedDate.includes('T')) {
        parsedDate = parsedDate.split('T')[0];
      }
      const d = new Date(parsedDate + 'T00:00:00');
      if (isNaN(d.getTime())) {
        console.warn(`Skipping invalid date: "${dateVal}"`);
        return;
      }
      
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const date = `${year}-${month}-${day}`;
      
      if (!reconstructed[date]) {
        reconstructed[date] = {
          date: date,
          dayLabel: dayLabel,
          templateDay: '',
          elapsedTime: elapsedTime,
          workoutNote: '',
          exercises: []
        };
      }
      
      if (exerciseName === 'Rest Day' && !setNumber) {
        return;
      }
      
      let ex = reconstructed[date].exercises.find(e => e.name === exerciseName);
      if (!ex) {
        ex = {
          name: exerciseName,
          tag: tag,
          target: '',
          workoutNote: '',
          setData: []
        };
        reconstructed[date].exercises.push(ex);
      }

      if (workoutNote && parseInt(setNumber) === 1) {
        ex.workoutNote = workoutNote;
      }
      
      const setIndex = parseInt(setNumber) - 1;
      if (!isNaN(setIndex) && setIndex >= 0) {
        ex.setData[setIndex] = {
          weight: weight,
          reps: reps,
          rir: rir
        };
      }
    });
    
    // Filter undefined sets and resolve templateDay if blank
    const finalHistory = {};
    for (const date in reconstructed) {
      try {
        const parts = date.split('-');
        if (parts.length !== 3) continue;
        
        reconstructed[date].exercises.forEach(ex => {
          ex.setData = ex.setData.filter(s => s !== undefined);
        });
        
        // Verify date validation before computing weeks
        const d = new Date(parts[0], parts[1] - 1, parts[2]);
        if (isNaN(d.getTime())) {
          console.warn(`Skipping invalid date entry during parse: "${date}"`);
          continue;
        }
        
        const dayOfWeek = WEEKDAYS[d.getDay()];
        const weekMonday = getWeekMonday(date);
        reconstructed[date].templateDay = getTemplateDayForWeekday(dayOfWeek, weekMonday);
        
        finalHistory[date] = reconstructed[date];
      } catch (err) {
        console.warn(`Skipping parse error for date "${date}":`, err);
      }
    }
    
    // Save to local storage and memory
    state.history = finalHistory;
    autoLogPastRestDays();
    localStorage.setItem(KEYS.HISTORY, JSON.stringify(state.history));
    
    statusEl.style.color = 'var(--accent-mint)';
    statusEl.textContent = `✅ Successfully restored ${Object.keys(finalHistory).length} workout log(s) out of ${workoutRows.length} rows fetched!`;
    
    // Refresh calendar
    renderCalendar();
  } catch (err) {
    statusEl.style.color = 'var(--accent-red)';
    statusEl.textContent = `❌ Restore Failed: ${err.message}`;
  }
}

// -------------------------------------------------------------
// Body Weight Logging & Webhook Transmit Functions
// -------------------------------------------------------------
async function transmitWeightLog(date, weight) {
  const webhookUrl = getWebhookUrl();
  if (!webhookUrl || webhookUrl.includes('YOUR_APPS_SCRIPT_ID')) {
    console.warn("Webhook URL placeholder active, skipping Weight Sheets transmission.");
    return;
  }

  const payload = {
    type: "weight",
    date: date,
    weight: parseFloat(weight)
  };

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      mode: 'no-cors',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    });
    console.log("Weight payload dispatched successfully.");
  } catch (err) {
    console.error("Weight payload delivery failure", err);
    alert("Weight Sync Failed. Your local logs are saved safely in device memory.");
  }
}

function saveWeightLog(date, weight) {
  if (weight === '' || weight === null || weight === undefined) {
    delete state.weightHistory[date];
  } else {
    state.weightHistory[date] = parseFloat(weight);
  }

  if (state.auth.mode === 'user') {
    localStorage.setItem(KEYS.WEIGHT_HISTORY, JSON.stringify(state.weightHistory));
    transmitWeightLog(date, weight).catch(err => console.error("Sheets weight sync error", err));
  }
}

function renderDashboardWeight() {
  const todayStr = getLocalDateString();
  const display = document.getElementById('dashboard-weight-display');
  const input = document.getElementById('dashboard-weight-input');
  const saveBtn = document.getElementById('btn-save-weight');
  
  const inputContainer = document.getElementById('weight-input-container');
  const displayContainer = document.getElementById('weight-display-container');
  
  if (display && input && inputContainer && displayContainer && saveBtn) {
    if (state.weightHistory && state.weightHistory[todayStr] !== undefined) {
      display.textContent = `${state.weightHistory[todayStr]} lbs`;
      input.value = state.weightHistory[todayStr];
      // Show Display State
      inputContainer.style.display = 'none';
      displayContainer.style.display = 'flex';
    } else {
      display.textContent = `-- lbs`;
      input.value = '';
      saveBtn.textContent = 'Log';
      // Show Input State
      inputContainer.style.display = 'flex';
      displayContainer.style.display = 'none';
    }
  }
}

function getPreviousExerciseStats(exerciseName, activeDate) {
  if (!state.history) return null;
  
  const historyDates = Object.keys(state.history)
    .filter(date => date < activeDate)
    .sort((a, b) => b.localeCompare(a));
    
  for (const date of historyDates) {
    const workout = state.history[date];
    if (!workout || !workout.exercises) continue;
    const exercise = workout.exercises.find(ex => ex.name.trim().toLowerCase() === exerciseName.trim().toLowerCase());
    if (exercise && exercise.setData && exercise.setData.length > 0) {
      let totalWeight = 0;
      let totalReps = 0;
      let totalRir = 0;
      let count = 0;
      
      exercise.setData.forEach(set => {
        const w = parseFloat(set.weight);
        const r = parseFloat(set.reps);
        const rir = parseFloat(set.rir);
        
        if (!isNaN(w) && !isNaN(r)) {
          totalWeight += w;
          totalReps += r;
          totalRir += isNaN(rir) ? 0 : rir;
          count++;
        }
      });
      
      if (count > 0) {
        const avgWeight = (totalWeight / count).toFixed(1);
        const avgReps = (totalReps / count).toFixed(1);
        const isBase = exercise.tag === 'Base';
        const avgRir = isBase ? '0.0' : (totalRir / count).toFixed(1);
        
        return {
          date: date,
          weight: parseFloat(avgWeight),
          reps: parseFloat(avgReps),
          rir: parseFloat(avgRir)
        };
      }
    }
  }
  return null;
}

function formatShortDate(dateStr) {
  if (!dateStr) return '--/--';
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  const month = parseInt(parts[1], 10);
  const day = parseInt(parts[2], 10);
  return `${month}/${day}`;
}

function getExerciseTarget(exerciseName) {
  if (!exerciseName) return '';
  if (state.exerciseRegistry && state.exerciseRegistry[exerciseName] && state.exerciseRegistry[exerciseName].muscle_tags) {
    return state.exerciseRegistry[exerciseName].muscle_tags;
  }
  const config = getExpandedRoutineConfig();
  if (config) {
    for (const key in config) {
      const routine = config[key];
      if (routine && routine.exercises) {
        const found = routine.exercises.find(e => e.name.trim().toLowerCase() === exerciseName.trim().toLowerCase());
        if (found && found.target) {
          return found.target;
        }
      }
    }
  }
  return '';
}

function calculateConsistencyStats() {
  const history = state.history || {};
  
  // Calculate counts
  let workoutsCount = 0;
  let restCount = 0;
  
  for (const dateStr in history) {
    const log = history[dateStr];
    if (log) {
      if (log.exercises && log.exercises.length === 0) {
        restCount++;
      } else {
        workoutsCount++;
      }
    }
  }
  
  const totalCount = workoutsCount + restCount;
  
  // Calculate current streak
  let streak = 0;
  const todayStr = getLocalDateString();
  
  const todayDate = new Date(todayStr + 'T00:00:00');
  const yesterdayDate = new Date(todayDate);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterdayStr = getLocalDateString(yesterdayDate);
  
  let startStr = null;
  if (history[todayStr]) {
    startStr = todayStr;
  } else if (history[yesterdayStr]) {
    startStr = yesterdayStr;
  }
  
  if (startStr) {
    let checkDate = new Date(startStr + 'T00:00:00');
    while (true) {
      const checkStr = getLocalDateString(checkDate);
      if (history[checkStr]) {
        streak++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else {
        break;
      }
    }
  }
  
  // Update the UI
  document.getElementById('stats-streak-count').textContent = streak;
  document.getElementById('stats-workouts-count').textContent = workoutsCount;
  document.getElementById('stats-rest-count').textContent = restCount;
  document.getElementById('stats-total-count').textContent = totalCount;
}

function logRestDay(dateStr) {
  const workoutRecord = {
    date: dateStr,
    dayLabel: 'Rest Day',
    templateDay: '',
    elapsedTime: '00:00',
    exercises: []
  };

  if (state.auth.mode === 'user') {
    state.history[dateStr] = workoutRecord;
    localStorage.setItem(KEYS.HISTORY, JSON.stringify(state.history));
    transmitWebhookLog(workoutRecord).catch(err => console.error("Sheets sync error", err));
  }
  
  // Close dialog if open
  const dialog = document.getElementById('history-log-modal');
  if (dialog && dialog.open) {
    dialog.close();
  }
  
  // Re-render
  initDashboard();
  renderCalendar();
}

function migrateLocalHistoryExerciseNames() {
  const nameMap = {
    "incline bicep curl": "Bayesian Curl",
    "incline dumbbell curl": "Bayesian Curl",
    "standing or seated calf raise": "Seated Calf Raise",
    "standing or seated calf raises": "Seated Calf Raise",
    "calf raise": "Seated Calf Raise",
    "dumbbell leaning lateral raises": "Cable Lateral Raises",
    "dumbbell leaning lateral raise": "Cable Lateral Raise"
  };

  let historyChanged = false;
  for (const date in state.history) {
    const workout = state.history[date];
    if (workout && workout.exercises) {
      workout.exercises.forEach(ex => {
        const lowerName = ex.name.trim().toLowerCase();
        if (nameMap[lowerName]) {
          ex.name = nameMap[lowerName];
          historyChanged = true;
        }
      });
    }
  }
  if (historyChanged) {
    localStorage.setItem(KEYS.HISTORY, JSON.stringify(state.history));
    console.log("Local history exercise names migrated successfully.");
  }
}

async function runExerciseMigrationOnSheets() {
  const webhookUrl = getWebhookUrl();
  if (!webhookUrl || webhookUrl.includes('YOUR_APPS_SCRIPT_ID')) {
    return;
  }
  
  const flag = 'aplift_sheets_migration_done_v1';
  if (localStorage.getItem(flag)) {
    return; // Already migrated
  }
  
  const payload = {
    type: "migrate-exercises",
    renames: [
      { oldName: "Incline Dumbbell Curl", newName: "Bayesian Curl" },
      { oldName: "Incline Bicep Curl", newName: "Bayesian Curl" },
      { oldName: "incline bicep curl", newName: "Bayesian Curl" },
      { oldName: "Standing or Seated Calf Raise", newName: "Seated Calf Raise" },
      { oldName: "Standing or Seated Calf Raises", newName: "Seated Calf Raise" },
      { oldName: "Calf Raise", newName: "Seated Calf Raise" },
      { oldName: "Dumbbell Leaning Lateral Raises", newName: "Cable Lateral Raises" },
      { oldName: "Dumbbell Leaning Lateral Raise", newName: "Cable Lateral Raise" }
    ]
  };
  
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      mode: 'no-cors',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    });
    localStorage.setItem(flag, 'true');
    console.log("Spreadsheet exercise migration payload dispatched.");
  } catch (err) {
    console.error("Spreadsheet migration request failed", err);
  }
}

function autoLogPastRestDays() {
  if (state.auth.mode !== 'user') return;
  const history = state.history || {};
  
  // One-time fix for Saturday, June 27, 2026 Rest Day logging
  if (!history['2026-06-27']) {
    const fixedRecord = {
      date: '2026-06-27',
      dayLabel: 'Rest Day',
      templateDay: '',
      elapsedTime: '00:00',
      exercises: []
    };
    history['2026-06-27'] = fixedRecord;
    localStorage.setItem(KEYS.HISTORY, JSON.stringify(history));
    transmitWebhookLog(fixedRecord).catch(err => console.error("Sheets rest day sync error", err));
    console.log("Logged missing Rest Day on Saturday, June 27, 2026.");
  }
  
  const startStr = "2026-06-01";
  const startDate = new Date(startStr + 'T00:00:00');
  const yesterday = new Date(getLocalDateString() + 'T00:00:00');
  yesterday.setDate(yesterday.getDate() - 1);
  
  let currentDate = new Date(startDate);
  let modified = false;
  
  while (currentDate <= yesterday) {
    const dateStr = getLocalDateString(currentDate);
    if (!history[dateStr]) {
      const templateDay = getAssignedTemplateDay(dateStr);
      const config = getExpandedRoutineConfig();
      const routine = config[templateDay];
      if (routine && routine.isRest) {
        // Auto-log it!
        const workoutRecord = {
          date: dateStr,
          dayLabel: 'Rest Day',
          templateDay: '',
          elapsedTime: '00:00',
          exercises: []
        };
        history[dateStr] = workoutRecord;
        transmitWebhookLog(workoutRecord).catch(err => console.error("Sheets rest day sync error", err));
        modified = true;
      }
    }
    currentDate.setDate(currentDate.getDate() + 1);
  }
  
  if (modified) {
    localStorage.setItem(KEYS.HISTORY, JSON.stringify(state.history));
    renderCalendar();
  }
}

// -------------------------------------------------------------
// Notepad, Substitution & Custom Exercise Helper Modules
// -------------------------------------------------------------
let customChips = [];
let customDefaultTag = 'HC';

function setupNotesAndSubstitutionListeners() {
  const setupNotesEl = document.getElementById('exercise-setup-notes');
  if (setupNotesEl) {
    setupNotesEl.addEventListener('input', (e) => {
      const activeEx = state.activeWorkout.exercises[state.activeWorkout.currentExerciseIndex];
      if (activeEx && state.exerciseRegistry[activeEx.name]) {
        state.exerciseRegistry[activeEx.name].notes = e.target.value;
        localStorage.setItem(KEYS.EXERCISE_REGISTRY, JSON.stringify(state.exerciseRegistry));
      }
    });
  }

  const sessionNoteEl = document.getElementById('workout-session-note');
  if (sessionNoteEl) {
    sessionNoteEl.addEventListener('input', (e) => {
      const activeEx = state.activeWorkout.exercises[state.activeWorkout.currentExerciseIndex];
      if (activeEx) {
        activeEx.workoutNote = e.target.value;
        saveActiveWorkoutState();
      }
    });
  }

  const prevStatsBar = document.getElementById('prev-stats-bar');
  if (prevStatsBar) {
    prevStatsBar.addEventListener('click', () => {
      const activeEx = state.activeWorkout.exercises[state.activeWorkout.currentExerciseIndex];
      if (!activeEx) return;

      const historyData = getMostRecentExerciseHistory(activeEx.name);
      const rowsContainer = document.getElementById('historical-sets-rows');
      const noteTextEl = document.getElementById('historical-session-note-text');

      if (rowsContainer) rowsContainer.innerHTML = '';

      if (historyData && historyData.exercises && historyData.exercises[0]) {
        const historicalEx = historyData.exercises[0];
        
        // Title: Workout Type - Completed Date
        const dObj = new Date(historyData.date + 'T00:00:00');
        const fmtDate = dObj.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        const titleEl = document.getElementById('historical-modal-title');
        if (titleEl) {
          titleEl.textContent = `${historyData.dayLabel} - ${fmtDate}`;
        }
        
        // Intensity tag underneath the title
        const tagContainer = document.getElementById('historical-modal-tag-container');
        const tagSpan = document.getElementById('historical-modal-tag-span');
        if (tagContainer && tagSpan) {
          tagSpan.textContent = historicalEx.tag;
          tagSpan.className = `tag-badge ${historicalEx.tag.toLowerCase()}`;
          tagContainer.style.display = 'block';
        }

        historicalEx.setData.forEach((set, idx) => {
          const isLocked = isFailureSet(historicalEx.tag, idx);
          const row = document.createElement('div');
          row.className = 'matrix-row';
          row.innerHTML = `
            <div class="set-number">S${idx + 1}</div>
            <div class="matrix-input-wrapper">
              <input type="number" class="matrix-input" placeholder="0" value="${set.weight !== undefined && set.weight !== null ? set.weight : ''}" readonly tabindex="-1" style="pointer-events: none;">
            </div>
            <div class="matrix-input-wrapper">
              <input type="number" class="matrix-input" placeholder="0" value="${set.reps !== undefined && set.reps !== null ? set.reps : ''}" readonly tabindex="-1" style="pointer-events: none;">
            </div>
            <div class="matrix-input-wrapper ${isLocked ? 'locked' : ''}">
              <input type="number" class="matrix-input" placeholder="${isLocked ? '0' : '0-5'}" value="${set.rir !== undefined && set.rir !== null ? set.rir : ''}" readonly tabindex="-1" style="pointer-events: none;" ${isLocked ? 'disabled' : ''}>
            </div>
          `;
          rowsContainer.appendChild(row);
        });

        if (noteTextEl) {
          noteTextEl.textContent = historyData.workoutNote || 'No workout note found.';
        }
      } else {
        const titleEl = document.getElementById('historical-modal-title');
        if (titleEl) {
          titleEl.textContent = "No Historical Data";
        }
        const tagContainer = document.getElementById('historical-modal-tag-container');
        if (tagContainer) tagContainer.style.display = 'none';

        const emptyRow = document.createElement('div');
        emptyRow.className = 'matrix-row';
        emptyRow.innerHTML = `
          <div class="set-number">-</div>
          <div class="matrix-input-wrapper">
            <input type="text" class="matrix-input" value="-" readonly tabindex="-1" style="pointer-events: none;">
          </div>
          <div class="matrix-input-wrapper">
            <input type="text" class="matrix-input" value="-" readonly tabindex="-1" style="pointer-events: none;">
          </div>
          <div class="matrix-input-wrapper">
            <input type="text" class="matrix-input" value="-" readonly tabindex="-1" style="pointer-events: none;">
          </div>
        `;
        rowsContainer.appendChild(emptyRow);

        if (noteTextEl) {
          noteTextEl.textContent = "No historical data found — First Week Baseline Setting";
        }
      }

      const modal = document.getElementById('historical-averages-modal');
      if (modal) modal.showModal();
    });
  }

  const btnSwap = document.getElementById('btn-swap-exercise');
  if (btnSwap) {
    btnSwap.addEventListener('click', () => {
      const activeEx = state.activeWorkout.exercises[state.activeWorkout.currentExerciseIndex];
      if (!activeEx) return;

      document.getElementById('substitution-modal-title').textContent = `Substitute: ${activeEx.name}`;
      document.getElementById('sub-search-input').value = '';
      
      // Reset custom form
      document.getElementById('custom-inline-form').style.display = 'none';
      document.getElementById('btn-show-custom-inline').style.display = 'block';

      renderSubstitutionList(activeEx.name, '');

      const modal = document.getElementById('exercise-substitution-modal');
      if (modal) modal.showModal();
    });
  }

  const searchInput = document.getElementById('sub-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const activeEx = state.activeWorkout.exercises[state.activeWorkout.currentExerciseIndex];
      if (activeEx) {
        renderSubstitutionList(activeEx.name, searchInput.value);
      }
    });
  }

  const btnCloseSubModal = document.getElementById('btn-close-sub-modal');
  if (btnCloseSubModal) {
    btnCloseSubModal.addEventListener('click', () => {
      document.getElementById('exercise-substitution-modal').close();
    });
  }

  const btnCancelSub = document.getElementById('btn-cancel-substitution');
  if (btnCancelSub) {
    btnCancelSub.addEventListener('click', () => {
      document.getElementById('exercise-substitution-modal').close();
    });
  }

  const btnShowCustom = document.getElementById('btn-show-custom-inline');
  const customForm = document.getElementById('custom-inline-form');
  const btnCancelCustom = document.getElementById('btn-cancel-custom-inline');
  const btnSubmitCustom = document.getElementById('btn-submit-custom-inline');
  const customMusclesInput = document.getElementById('custom-ex-muscles');

  if (btnShowCustom && customForm) {
    btnShowCustom.addEventListener('click', () => {
      btnShowCustom.style.display = 'none';
      customForm.style.display = 'flex';
      document.getElementById('custom-ex-name').value = '';
      customMusclesInput.value = '';
      customChips = [];
      customDefaultTag = 'HC';
      renderCustomChips();
      updateCustomSliderPosition('HC');
    });
  }

  if (btnCancelCustom) {
    btnCancelCustom.addEventListener('click', () => {
      customForm.style.display = 'none';
      btnShowCustom.style.display = 'block';
    });
  }

  if (customMusclesInput) {
    customMusclesInput.addEventListener('input', () => {
      const val = customMusclesInput.value;
      if (val.includes(',')) {
        const parts = val.split(',');
        for (let i = 0; i < parts.length - 1; i++) {
          const chipText = parts[i].trim();
          if (chipText && !customChips.includes(chipText)) {
            customChips.push(chipText);
          }
        }
        customMusclesInput.value = parts[parts.length - 1];
        renderCustomChips();
      }
    });

    customMusclesInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const chipText = customMusclesInput.value.trim();
        if (chipText) {
          if (!customChips.includes(chipText)) {
            customChips.push(chipText);
          }
          customMusclesInput.value = '';
          renderCustomChips();
        }
      }
    });
  }

  if (customForm) {
    const customSliderContainer = customForm.querySelector('.protocol-slider-container');
    if (customSliderContainer) {
      const btns = customSliderContainer.querySelectorAll('.protocol-option-btn');
      btns.forEach(btn => {
        btn.addEventListener('click', () => {
          customDefaultTag = btn.getAttribute('data-tag');
          updateCustomSliderPosition(customDefaultTag);
        });
      });
    }
  }

  if (btnSubmitCustom) {
    btnSubmitCustom.addEventListener('click', () => {
      const nameInput = document.getElementById('custom-ex-name');
      const newName = nameInput.value.trim();
      if (!newName) {
        alert("Please enter an exercise name.");
        return;
      }

      if (state.exerciseRegistry[newName]) {
        alert("An exercise with this name already exists.");
        return;
      }

      const leftover = customMusclesInput.value.trim();
      if (leftover && !customChips.includes(leftover)) {
        customChips.push(leftover);
      }

      const muscleTagsStr = customChips.join(', ') || 'Other';

      // Add to client registry
      state.exerciseRegistry[newName] = {
        notes: '',
        muscle_tags: muscleTagsStr,
        default_tag: customDefaultTag
      };
      localStorage.setItem(KEYS.EXERCISE_REGISTRY, JSON.stringify(state.exerciseRegistry));

      // Execute swap
      const activeIndex = state.activeWorkout.currentExerciseIndex;
      const oldEx = state.activeWorkout.exercises[activeIndex];

      const newData = [];
      for (let i = 0; i < oldEx.sets; i++) {
        const defaultRir = isFailureSet(customDefaultTag, i) ? '0' : '';
        newData.push({ weight: '', reps: '', rir: defaultRir });
      }

      state.activeWorkout.exercises[activeIndex] = {
        name: newName,
        tag: customDefaultTag,
        target: muscleTagsStr,
        sets: oldEx.sets,
        workoutNote: '',
        setData: newData
      };

      saveActiveWorkoutState();
      renderActiveCard();

      // Reset
      customForm.style.display = 'none';
      btnShowCustom.style.display = 'block';
      document.getElementById('exercise-substitution-modal').close();
    });
  }

  // Light dismiss
  const histModal = document.getElementById('historical-averages-modal');
  const subModal = document.getElementById('exercise-substitution-modal');
  if (histModal) enableLightDismiss(histModal);
  if (subModal) enableLightDismiss(subModal);
}

function enableLightDismiss(dialog) {
  if (!('closedBy' in HTMLDialogElement.prototype)) {
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const isDialogContent = (
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width
      );
      if (isDialogContent) return;
      dialog.close();
    });
  }
}

function getMostRecentExerciseHistory(exerciseName) {
  const sortedDates = Object.keys(state.history).sort((a, b) => b.localeCompare(a));
  for (const date of sortedDates) {
    const workout = state.history[date];
    if (workout && workout.exercises) {
      const ex = workout.exercises.find(e => e.name === exerciseName);
      if (ex && ex.setData && ex.setData.length > 0) {
        return {
          date: date,
          dayLabel: workout.dayLabel || '',
          exercises: [ex],
          workoutNote: ex.workoutNote || ''
        };
      }
    }
  }
  return null;
}

function getSimilarityScore(activeExerciseKey, candidateObject) {
  const activeData = state.exerciseRegistry[activeExerciseKey];
  if (!activeData) return 0;
  const activeMuscles = (activeData.muscle_tags || '').split(/[,\/]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
  const candidateMuscles = (candidateObject.muscle_tags || '').split(/[,\/]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
  
  if (activeMuscles.length === 0 || candidateMuscles.length === 0) return 0;
  
  let score = 0;
  if (activeMuscles[0] === candidateMuscles[0]) score += 10.0;
  
  activeMuscles.forEach((muscle, aIdx) => {
    candidateMuscles.forEach((cMuscle, cIdx) => {
      if (muscle === cMuscle) {
        if (aIdx === 0 && cIdx !== 0) score += 3.0; 
        if (aIdx !== 0 && cIdx === 0) score += 2.0; 
        if (aIdx !== 0 && cIdx !== 0) score += 1.5; 
      }
    });
  });
  return score;
}

function renderSubstitutionList(activeExName, searchTerm) {
  const highSimList = document.getElementById('sub-high-similarity-list');
  const alphaList = document.getElementById('sub-alphabetical-list');
  
  if (!highSimList || !alphaList) return;
  
  highSimList.innerHTML = '';
  alphaList.innerHTML = '';
  
  const term = searchTerm.trim().toLowerCase();
  
  const candidates = [];
  for (const name in state.exerciseRegistry) {
    if (name === activeExName) continue;
    
    if (term && !name.toLowerCase().includes(term) && !state.exerciseRegistry[name].muscle_tags.toLowerCase().includes(term)) {
      continue;
    }
    
    const candidateObj = state.exerciseRegistry[name];
    const score = getSimilarityScore(activeExName, candidateObj);
    candidates.push({ name, ...candidateObj, score });
  }
  
  const highSimCandidates = candidates
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    
  const alphaCandidates = candidates
    .filter(c => c.score === 0)
    .sort((a, b) => a.name.localeCompare(b.name));
    
  const highSimSection = document.getElementById('sub-high-similarity-section');
  if (highSimCandidates.length > 0) {
    highSimSection.style.display = 'flex';
    highSimCandidates.forEach(cand => {
      highSimList.appendChild(createSubstitutionRow(cand, activeExName));
    });
  } else {
    highSimSection.style.display = 'none';
  }
  
  const alphaDivider = document.getElementById('sub-alphabetical-divider');
  if (alphaCandidates.length > 0) {
    alphaDivider.style.display = 'flex';
    alphaCandidates.forEach(cand => {
      alphaList.appendChild(createSubstitutionRow(cand, activeExName));
    });
  } else {
    alphaDivider.style.display = 'none';
  }
}

function createSubstitutionRow(cand, activeExName) {
  const row = document.createElement('div');
  row.className = 'substitution-row';
  row.style.cssText = 'display:flex; flex-direction:column; border:1px solid var(--border-glass); border-radius:12px; background:rgba(255,255,255,0.02); overflow:hidden; transition:all 0.3s; margin-bottom:6px;';
  
  const header = document.createElement('div');
  header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:12px; cursor:pointer;';
  
  const tagClass = cand.default_tag.toLowerCase();
  
  header.innerHTML = `
    <div style="display:flex; flex-direction:column; gap:2px; text-align: left;">
      <span style="font-size:14px; font-weight:600; color:var(--text-primary);">${cand.name}</span>
      <span style="font-size:11px; color:var(--text-muted);">${cand.muscle_tags}</span>
    </div>
    <span class="tag-badge ${tagClass}">${cand.default_tag}</span>
  `;
  
  const expansion = document.createElement('div');
  expansion.style.cssText = 'display:none; flex-direction:column; gap:10px; padding:0 12px 12px 12px; border-top:1px solid rgba(255,255,255,0.05); background:rgba(255,255,255,0.01);';
  
  expansion.innerHTML = `
    <div style="font-size:11px; font-weight:600; color:var(--text-muted); margin-top:8px; text-align: left;">Choose intensity protocol</div>
    <div class="protocol-slider-container" style="position:relative; display:flex; height:32px; background:rgba(0,0,0,0.2); border:1px solid var(--border-glass); border-radius:16px; overflow:hidden; padding:2px;">
      <div class="slider-thumb" style="position:absolute; top:2px; bottom:2px; left:2px; width:calc(33.33% - 2px); border-radius:14px; transition:transform 0.3s cubic-bezier(0.25, 1, 0.5, 1); pointer-events:none;"></div>
      <button type="button" class="protocol-btn" data-tag="HC" style="flex:1; background:none; border:none; font-family:inherit; font-size:11px; font-weight:700; z-index:2; cursor:pointer; transition:color 0.2s;">HC</button>
      <button type="button" class="protocol-btn" data-tag="LLP" style="flex:1; background:none; border:none; font-family:inherit; font-size:11px; font-weight:700; z-index:2; cursor:pointer; transition:color 0.2s;">LLP</button>
      <button type="button" class="protocol-btn" data-tag="Base" style="flex:1; background:none; border:none; font-family:inherit; font-size:11px; font-weight:700; z-index:2; cursor:pointer; transition:color 0.2s;">Base</button>
    </div>
    <button type="button" class="btn btn-confirm-swap" style="width:100%; padding:8px; font-size:12px; font-weight:700; margin-top:4px;">Confirm Swap</button>
  `;
  
  row.appendChild(header);
  row.appendChild(expansion);
  
  let selectedTag = cand.default_tag;
  
  header.addEventListener('click', () => {
    const modal = document.getElementById('exercise-substitution-modal');
    modal.querySelectorAll('.substitution-row').forEach(otherRow => {
      if (otherRow !== row) {
        const otherExpansion = otherRow.querySelector('div:nth-child(2)');
        if (otherExpansion) otherExpansion.style.display = 'none';
      }
    });
    
    const isExpanded = expansion.style.display === 'flex';
    expansion.style.display = isExpanded ? 'none' : 'flex';
    
    if (!isExpanded) {
      updateSliderPosition(expansion, selectedTag);
    }
  });
  
  const sliderButtons = expansion.querySelectorAll('.protocol-btn');
  sliderButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      selectedTag = btn.getAttribute('data-tag');
      updateSliderPosition(expansion, selectedTag);
    });
  });
  
  const confirmBtn = expansion.querySelector('.btn-confirm-swap');
  confirmBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    
    const activeIndex = state.activeWorkout.currentExerciseIndex;
    const oldEx = state.activeWorkout.exercises[activeIndex];
    
    const newData = [];
    for (let i = 0; i < oldEx.sets; i++) {
      const defaultRir = isFailureSet(selectedTag, i) ? '0' : '';
      newData.push({ weight: '', reps: '', rir: defaultRir });
    }
    
    state.activeWorkout.exercises[activeIndex] = {
      name: cand.name,
      tag: selectedTag,
      target: cand.muscle_tags,
      sets: oldEx.sets,
      workoutNote: '',
      setData: newData
    };
    
    saveActiveWorkoutState();
    renderActiveCard();
    
    document.getElementById('exercise-substitution-modal').close();
  });
  
  return row;
}

function updateSliderPosition(sliderContainer, activeTag) {
  const thumb = sliderContainer.querySelector('.slider-thumb');
  const buttons = sliderContainer.querySelectorAll('.protocol-btn, .protocol-option-btn');
  
  let translateX = '0%';
  let bg = '';
  let border = '';
  
  if (activeTag === 'HC') {
    translateX = '0%';
    bg = 'rgba(239, 71, 111, 0.15)';
    border = '1px solid rgba(239, 71, 111, 0.3)';
  } else if (activeTag === 'LLP') {
    translateX = '100%';
    bg = 'rgba(191, 155, 254, 0.15)';
    border = '1px solid rgba(191, 155, 254, 0.3)';
  } else if (activeTag === 'Base') {
    translateX = '200%';
    bg = 'rgba(252, 163, 17, 0.15)';
    border = '1px solid rgba(252, 163, 17, 0.3)';
  }
  
  if (thumb) {
    thumb.style.transform = `translateX(${translateX})`;
    thumb.style.background = bg;
    thumb.style.border = border;
  }
  
  buttons.forEach(btn => {
    const btnTag = btn.getAttribute('data-tag');
    if (btnTag === activeTag) {
      btn.classList.add('active');
      if (activeTag === 'HC') btn.style.color = 'var(--accent-red)';
      else if (activeTag === 'LLP') btn.style.color = 'var(--accent-lavender)';
      else if (activeTag === 'Base') btn.style.color = 'var(--accent-gold)';
    } else {
      btn.classList.remove('active');
      btn.style.color = '#708090'; // desaturated Slate Gray
    }
  });
}

function renderCustomChips() {
  const container = document.getElementById('custom-chips-container');
  if (!container) return;
  container.innerHTML = '';
  
  customChips.forEach((chip, idx) => {
    const chipEl = document.createElement('div');
    chipEl.style.cssText = 'display:flex; align-items:center; gap:4px; font-size:11px; padding:3px 8px; border-radius:12px; font-weight:600; line-height:1;';
    
    if (idx === 0) {
      chipEl.style.background = 'var(--accent-lavender)';
      chipEl.style.color = '#0a0a0c';
      chipEl.textContent = `${chip} (Primary)`;
    } else {
      chipEl.style.background = 'rgba(255, 255, 255, 0.08)';
      chipEl.style.color = 'var(--text-secondary)';
      chipEl.textContent = chip;
    }
    
    const deleteBtn = document.createElement('span');
    deleteBtn.innerHTML = '&times;';
    deleteBtn.style.cssText = 'cursor:pointer; font-weight:bold; font-size:12px; margin-left:2px; display:inline-block; vertical-align:middle;';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      customChips.splice(idx, 1);
      renderCustomChips();
    });
    
    chipEl.appendChild(deleteBtn);
    container.appendChild(chipEl);
  });
}

function updateCustomSliderPosition(activeTag) {
  const container = document.querySelector('#custom-inline-form .protocol-slider-container');
  if (container) {
    updateSliderPosition(container, activeTag);
  }
}

// =============================================================
// PWA SPLIT EDITOR MODULE
// =============================================================

let splitDraft = null;       // Draft routine config
let splitDraftRegistry = null; // Draft exercise registry
let splitCustomChips = [];     // Draft chips for new custom exercise tag
let splitCustomDefaultTag = 'HC'; // Default tag for custom exercise tag
let splitActiveDay = null;     // Active day for the add exercise modal

const WORKOUT_TYPICAL_TARGETS = {
  'Push': 'Chest, Shoulders, Triceps',
  'Legs': 'Quads, Glutes, Hamstrings, Calves',
  'Pull': 'Mid-Back, Traps, Lats, Rhomboids, Biceps, Rear Delts',
  'Upper': 'Chest, Shoulders, Triceps, Lats, Rhomboids, Mid-Back, Traps, Biceps, Rear Delts',
  'Lower': 'Quads, Glutes, Hamstrings, Calves, Lower Back'
};

function getWorkoutSimilarityScore(typicalTargetsStr, candidateObject) {
  const activeMuscles = (typicalTargetsStr || '').split(/[,\/]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
  const candidateMuscles = (candidateObject.muscle_tags || '').split(/[,\/]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
  
  if (activeMuscles.length === 0 || candidateMuscles.length === 0) return 0;
  
  let score = 0;
  // If the primary muscle of candidate matches any typical muscle
  if (activeMuscles.includes(candidateMuscles[0])) {
    score += 5.0;
    if (activeMuscles[0] === candidateMuscles[0]) score += 5.0; // Extra weight if primary matches primary
  }
  
  activeMuscles.forEach((muscle) => {
    if (candidateMuscles.includes(muscle)) {
      score += 2.0;
    }
  });
  return score;
}

function openSplitPanel() {
  const currentConfig = getRoutineConfig();
  // Deep copy routine template config
  splitDraft = JSON.parse(JSON.stringify(currentConfig));
  
  // Load custom templates into splitDraft draft state
  const customTemplates = JSON.parse(localStorage.getItem('custom_day_templates') || '{}');
  let idx = 1;
  for (const name in customTemplates) {
    splitDraft[`_custom_${idx}`] = {
      label: name,
      isRest: false,
      exercises: JSON.parse(JSON.stringify(customTemplates[name].exercises || []))
    };
    idx++;
  }
  
  // Deep copy exercise registry
  splitDraftRegistry = JSON.parse(JSON.stringify(state.exerciseRegistry || {}));
  
  // Render day cards
  renderSplitEditor();
  
  // Show split view
  showView('split-view');
  
  // Setup modal handlers if not already configured
  setupSplitModalEventHandlers();
}

function renderSplitEditor() {
  const container = document.getElementById('split-days-container');
  if (!container) return;
  container.innerHTML = '';
  
  // Load custom templates
  const customTemplates = JSON.parse(localStorage.getItem('custom_day_templates') || '{}');
  const customOptionHtml = Object.keys(customTemplates).map(name => `<option value="${name}">${name}</option>`).join('');
  
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  days.forEach(day => {
    const card = document.createElement('div');
    card.className = 'glass-card day-card';
    card.setAttribute('data-day', day);
    
    // Header
    const header = document.createElement('div');
    header.className = 'day-card-header';
    header.innerHTML = `<h3 class="day-card-title">${day}</h3>`;
    card.appendChild(header);
    
    // Selector (Trigger Button)
    const selectWrapper = document.createElement('div');
    selectWrapper.style.cssText = 'display:flex; flex-direction:column; gap:4px;';
    selectWrapper.innerHTML = `
      <label style="font-size:11px; font-weight:600; color:var(--text-muted); text-align:left;">Choose Workout</label>
    `;
    
    const dayData = splitDraft[day] || { label: 'Rest Day', isRest: true, exercises: [] };
    const displayLabel = dayData.isRest ? 'Rest' : dayData.label;
    
    const triggerBtn = document.createElement('button');
    triggerBtn.type = 'button';
    triggerBtn.className = 'dropdown-select split-workout-select-trigger';
    triggerBtn.style.cssText = 'width:100%; text-align:left; display:flex; justify-content:space-between; align-items:center; cursor:pointer; font-weight:600; padding:10px 14px; margin:0;';
    triggerBtn.innerHTML = `
      <span>${displayLabel}</span>
      <span style="font-size:10px; color:var(--text-muted);">▼</span>
    `;
    selectWrapper.appendChild(triggerBtn);
    card.appendChild(selectWrapper);
    
    // Exercises wrapper
    const exListWrapper = document.createElement('div');
    exListWrapper.className = 'split-day-exercises-wrapper';
    exListWrapper.style.cssText = 'display:flex; flex-direction:column; gap:8px; margin-top:8px;';
    card.appendChild(exListWrapper);
    
    // Add Exercise Button
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn btn-secondary btn-add-split-ex';
    addBtn.style.cssText = 'width:100%; margin-top:4px; border:1px dashed var(--accent-lavender); color:var(--accent-lavender); background:rgba(191,155,254,0.05); font-weight:700;';
    addBtn.textContent = '+ Add Exercise';
    card.appendChild(addBtn);
    
    container.appendChild(card);
    
    const activeVal = dayData.isRest ? 'Rest Day' : dayData.label;
    updateSplitCardDisplay(day, card, activeVal);
    
    // Custom select trigger listener
    triggerBtn.addEventListener('click', () => {
      activeSplitSelectDay = day;
      const optionsList = document.getElementById('split-workout-options-list');
      if (!optionsList) return;
      optionsList.innerHTML = '';
      
      const options = ["Push", "Legs", "Pull", "Upper", "Lower", ...Object.keys(customTemplates), "Rest Day"];
      options.forEach(opt => {
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'swap-capsule-pill';
        
        const currentVal = splitDraft[day].isRest ? 'Rest Day' : splitDraft[day].label;
        const optVal = opt === 'Rest Day' ? 'Rest Day' : opt;
        
        pill.textContent = opt === 'Rest Day' ? 'Rest' : opt;
        
        if (optVal === currentVal) {
          pill.classList.add('active');
        } else {
          pill.classList.add('inactive');
        }
        
        pill.addEventListener('click', () => {
          const val = optVal;
          if (val === 'Rest Day') {
            splitDraft[day] = { label: 'Rest Day', isRest: true, exercises: [] };
          } else if (customTemplates[val]) {
            splitDraft[day] = {
              label: val,
              isRest: false,
              exercises: JSON.parse(JSON.stringify(customTemplates[val].exercises || []))
            };
          } else {
            const oldData = splitDraft[day];
            splitDraft[day] = {
              label: val,
              isRest: false,
              exercises: (oldData && !oldData.isRest && oldData.label === val) ? oldData.exercises : []
            };
          }
          
          triggerBtn.querySelector('span:first-child').textContent = val === 'Rest Day' ? 'Rest' : val;
          updateSplitCardDisplay(day, card, val);
          document.getElementById('split-workout-select-modal').close();
        });
        
        optionsList.appendChild(pill);
      });
      
      document.getElementById('split-workout-select-modal').showModal();
    });
    
    // Add button handler
    addBtn.addEventListener('click', () => {
      openSplitAddModal(day);
    });
  });

  // Render Custom Day Templates
  const customSectionHeader = document.createElement('div');
  customSectionHeader.style.cssText = 'font-size:11px; font-weight:700; color:var(--accent-lavender); text-transform:uppercase; letter-spacing:0.5px; margin-top:20px; margin-bottom:8px; text-align:left; padding-left:4px;';
  customSectionHeader.textContent = 'Custom Workout Templates';
  container.appendChild(customSectionHeader);

  let hasCustom = false;
  for (const day in splitDraft) {
    if (day.startsWith('_custom_')) {
      hasCustom = true;
      const dayData = splitDraft[day];
      
      const card = document.createElement('div');
      card.className = 'glass-card day-card';
      card.setAttribute('data-day', day);
      
      // Header with input title and delete button
      const header = document.createElement('div');
      header.className = 'day-card-header';
      header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; width:100%;';
      header.innerHTML = `
        <input type="text" class="custom-day-title-input" value="${dayData.label}" placeholder="e.g. Full Body A" style="margin:0; font-family:inherit; font-size:15px; font-weight:700; color:var(--accent-lavender); background:transparent; border:none; border-bottom:1px dashed var(--accent-lavender); border-radius:0; padding:4px 0; width:75%; outline:none;">
        <button type="button" class="btn-delete-custom-card" style="background:none; border:none; color:var(--accent-red); font-size:20px; cursor:pointer; padding:4px;">&times;</button>
      `;
      card.appendChild(header);

      // Title input listener
      const titleInput = header.querySelector('.custom-day-title-input');
      titleInput.addEventListener('input', (e) => {
        dayData.label = e.target.value;
      });

      // Delete custom day card listener
      const deleteCardBtn = header.querySelector('.btn-delete-custom-card');
      deleteCardBtn.addEventListener('click', () => {
        delete splitDraft[day];
        renderSplitEditor();
      });

      // Exercises wrapper
      const exListWrapper = document.createElement('div');
      exListWrapper.className = 'split-day-exercises-wrapper';
      exListWrapper.style.cssText = 'display:flex; flex-direction:column; gap:8px; margin-top:12px;';
      card.appendChild(exListWrapper);
      
      // Add Exercise Button
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'btn btn-secondary btn-add-split-ex';
      addBtn.style.cssText = 'width:100%; margin-top:8px; border:1px dashed var(--accent-lavender); color:var(--accent-lavender); background:rgba(191,155,254,0.05); font-weight:700;';
      addBtn.textContent = '+ Add Exercise';
      card.appendChild(addBtn);
      
      // Add button handler
      addBtn.addEventListener('click', () => {
        openSplitAddModal(day);
      });
      
      container.appendChild(card);

      // Render its exercises
      renderSplitDayExercises(day, exListWrapper);
    }
  }

  if (!hasCustom) {
    const emptyMsg = document.createElement('div');
    emptyMsg.style.cssText = 'text-align:center; padding:16px; color:var(--text-muted); font-size:13px; font-style:italic;';
    emptyMsg.textContent = 'No custom templates created yet. Click "+ Create Custom Day" below to add one.';
    container.appendChild(emptyMsg);
  }
}

function updateSplitCardDisplay(day, cardEl, selectValue) {
  const listWrapper = cardEl.querySelector('.split-day-exercises-wrapper');
  const addBtn = cardEl.querySelector('.btn-add-split-ex');
  if (!listWrapper || !addBtn) return;
  
  if (selectValue === 'Rest Day') {
    listWrapper.innerHTML = '';
    listWrapper.style.display = 'none';
    addBtn.style.display = 'none';
  } else {
    listWrapper.style.display = 'flex';
    addBtn.style.display = 'block';
    renderSplitDayExercises(day, listWrapper);
  }
}

function renderSplitDayExercises(day, listWrapper) {
  listWrapper.innerHTML = '';
  const dayData = splitDraft[day];
  if (!dayData || !dayData.exercises) return;
  
  dayData.exercises.forEach((ex, index) => {
    // Find exercise config in draft registry
    const reg = splitDraftRegistry[ex.name] || { muscle_tags: 'Other', default_tag: 'Base' };
    const tagClass = reg.default_tag.toLowerCase();
    
    const row = document.createElement('div');
    row.className = 'split-exercise-row';
    row.style.cssText = 'display:flex; flex-direction:column; border:1px solid var(--border-glass); border-radius:12px; background:rgba(255,255,255,0.02); overflow:hidden; touch-action:none; user-select:none; -webkit-user-select:none; cursor:grab;';
    
    const header = document.createElement('div');
    header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:12px;';
    header.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:2px; text-align:left; pointer-events:none;">
        <span style="font-size:14px; font-weight:600; color:var(--text-primary);">${ex.name}</span>
        <span style="font-size:11px; color:var(--text-muted);">${reg.muscle_tags}</span>
      </div>
      <div style="display:flex; align-items:center; gap:10px;">
        <span class="tag-badge ${tagClass}" style="text-transform:uppercase;">${reg.default_tag}</span>
        <button type="button" class="btn-edit-protocol" style="background:none; border:none; color:var(--text-muted); cursor:pointer; padding:4px; display:inline-flex; align-items:center; justify-content:center;" title="Edit Protocol">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
          </svg>
        </button>
        <button type="button" class="btn-delete-exercise" style="background:none; border:none; color:var(--accent-red); font-size:18px; cursor:pointer; padding:4px;">&times;</button>
      </div>
    `;
    row.appendChild(header);
    
    // Protocol Slider Panel
    const sliderPanel = document.createElement('div');
    sliderPanel.className = 'split-ex-protocol-edit';
    sliderPanel.style.cssText = 'display:none; flex-direction:column; gap:8px; padding:0 12px 12px 12px; border-top:1px solid rgba(255,255,255,0.05); background:rgba(255,255,255,0.01);';
    sliderPanel.innerHTML = `
      <div style="font-size:11px; font-weight:600; color:var(--text-muted); margin-top:8px; text-align:left;">Choose intensity protocol</div>
      <div class="protocol-slider-container" style="position:relative; display:flex; height:32px; background:rgba(0,0,0,0.2); border:1px solid var(--border-glass); border-radius:16px; overflow:hidden; padding:2px;">
        <div class="slider-thumb" style="position:absolute; top:2px; bottom:2px; left:2px; width:calc(33.33% - 2px); border-radius:14px; transition:transform 0.3s cubic-bezier(0.25, 1, 0.5, 1); pointer-events:none;"></div>
        <button type="button" class="protocol-btn" data-tag="HC" style="flex:1; background:none; border:none; font-family:inherit; font-size:11px; font-weight:700; z-index:2; cursor:pointer; transition:color 0.2s;">HC</button>
        <button type="button" class="protocol-btn" data-tag="LLP" style="flex:1; background:none; border:none; font-family:inherit; font-size:11px; font-weight:700; z-index:2; cursor:pointer; transition:color 0.2s;">LLP</button>
        <button type="button" class="protocol-btn" data-tag="Base" style="flex:1; background:none; border:none; font-family:inherit; font-size:11px; font-weight:700; z-index:2; cursor:pointer; transition:color 0.2s;">Base</button>
      </div>
    `;
    row.appendChild(sliderPanel);
    
    // Toggle slider panel
    header.querySelector('.btn-edit-protocol').addEventListener('click', (e) => {
      e.stopPropagation();
      const isExpanded = sliderPanel.style.display === 'flex';
      sliderPanel.style.display = isExpanded ? 'none' : 'flex';
      if (!isExpanded) {
        updateSliderPosition(sliderPanel, reg.default_tag);
      }
    });
    
    // Slider button triggers
    const sliderButtons = sliderPanel.querySelectorAll('.protocol-btn');
    sliderButtons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const tag = btn.getAttribute('data-tag');
        
        // Update draft registry
        if (splitDraftRegistry[ex.name]) {
          splitDraftRegistry[ex.name].default_tag = tag;
        }
        
        // Update local badge UI
        const badge = header.querySelector('.tag-badge');
        badge.textContent = tag;
        badge.className = `tag-badge ${tag.toLowerCase()}`;
        
        updateSliderPosition(sliderPanel, tag);
      });
    });
    
    // Delete button trigger
    header.querySelector('.btn-delete-exercise').addEventListener('click', (e) => {
      e.stopPropagation();
      dayData.exercises.splice(index, 1);
      // snappy re-render of this day card only
      renderSplitDayExercises(day, listWrapper);
    });
    
    // Long Press Drag & Drop Controller
    let pressTimer = null;
    let isDragging = false;
    let startY = 0;
    
    const onPointerMove = (moveEvent) => {
      if (!isDragging) {
        if (Math.abs(moveEvent.clientY - startY) > 5) {
          clearTimeout(pressTimer);
          window.removeEventListener('pointermove', onPointerMove);
          window.removeEventListener('pointerup', onPointerUp);
          window.removeEventListener('pointercancel', onPointerUp);
        }
        return;
      }
      
      moveEvent.preventDefault();
      
      const siblings = [...listWrapper.querySelectorAll('.split-exercise-row:not(.dragging)')];
      const nextSibling = siblings.find(sibling => {
        const rect = sibling.getBoundingClientRect();
        return moveEvent.clientY <= rect.top + rect.height / 2;
      });
      
      if (nextSibling) {
        listWrapper.insertBefore(row, nextSibling);
      } else {
        listWrapper.appendChild(row);
      }
    };
    
    const onPointerUp = (upEvent) => {
      clearTimeout(pressTimer);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      
      if (isDragging) {
        row.classList.remove('dragging');
        row.style.opacity = '';
        row.style.transform = '';
        row.style.cursor = 'grab';
        isDragging = false;
        
        // Rebuild exercises array in new order
        const rows = [...listWrapper.querySelectorAll('.split-exercise-row')];
        const newExercisesOrder = rows.map(r => {
          const name = r.querySelector('span').textContent;
          return { name };
        });
        
        dayData.exercises = newExercisesOrder;
        renderSplitDayExercises(day, listWrapper);
      }
    };

    row.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button') || e.target.closest('input') || e.target.closest('.protocol-slider-container')) return;
      
      startY = e.clientY;
      
      window.addEventListener('pointermove', onPointerMove, { passive: false });
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerUp);
      
      pressTimer = setTimeout(() => {
        isDragging = true;
        row.classList.add('dragging');
        row.style.opacity = '0.6';
        row.style.transform = 'scale(1.02)';
        row.style.cursor = 'grabbing';
        
        if (navigator.vibrate) navigator.vibrate(20);
      }, 300);
    });
    
    listWrapper.appendChild(row);
  });
}

function openSplitAddModal(day) {
  splitActiveDay = day;
  
  const modal = document.getElementById('split-add-exercise-modal');
  if (!modal) return;
  
  // Reset fields
  document.getElementById('split-add-search-input').value = '';
  document.getElementById('split-custom-inline-form').style.display = 'none';
  document.getElementById('btn-show-split-custom-inline').style.display = 'block';
  
  renderSplitAddList(day, '');
  modal.showModal();
}

function renderSplitAddList(day, searchTerm) {
  const highSimList = document.getElementById('split-add-high-similarity-list');
  const alphaList = document.getElementById('split-add-alphabetical-list');
  if (!highSimList || !alphaList) return;
  
  highSimList.innerHTML = '';
  alphaList.innerHTML = '';
  
  const term = searchTerm.trim().toLowerCase();
  
  // Get active exercises already on this day to exclude duplicates
  const currentExNames = (splitDraft[day].exercises || []).map(e => e.name);
  
  const workoutType = splitDraft[day].label;
  const typicalTargets = WORKOUT_TYPICAL_TARGETS[workoutType] || '';
  
  const candidates = [];
  for (const name in splitDraftRegistry) {
    // Exclude if already added to this day
    if (currentExNames.includes(name)) continue;
    
    // Filter by search term
    if (term && !name.toLowerCase().includes(term) && !splitDraftRegistry[name].muscle_tags.toLowerCase().includes(term)) {
      continue;
    }
    
    const candidateObj = splitDraftRegistry[name];
    const score = getWorkoutSimilarityScore(typicalTargets, candidateObj);
    candidates.push({ name, ...candidateObj, score });
  }
  
  // Sort candidates
  const highSimCandidates = candidates
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    
  const alphaCandidates = candidates
    .filter(c => c.score === 0)
    .sort((a, b) => a.name.localeCompare(b.name));
    
  // Similarity Section visibility
  const highSimSection = document.getElementById('split-add-high-similarity-section');
  if (highSimCandidates.length > 0) {
    highSimSection.style.display = 'flex';
    highSimCandidates.forEach(cand => {
      highSimList.appendChild(createSplitAddRow(cand));
    });
  } else {
    highSimSection.style.display = 'none';
  }
  
  // Alphabetical Divider visibility
  const alphaDivider = document.getElementById('split-add-alphabetical-divider');
  if (alphaCandidates.length > 0) {
    alphaDivider.style.display = 'flex';
    alphaCandidates.forEach(cand => {
      alphaList.appendChild(createSplitAddRow(cand));
    });
  } else {
    alphaDivider.style.display = 'none';
  }
}

function createSplitAddRow(cand) {
  const row = document.createElement('div');
  row.className = 'substitution-row';
  row.style.cssText = 'display:flex; flex-direction:column; border:1px solid var(--border-glass); border-radius:12px; background:rgba(255,255,255,0.02); overflow:hidden; transition:all 0.3s; margin-bottom:6px;';
  
  const header = document.createElement('div');
  header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:12px; cursor:pointer;';
  
  const tagClass = cand.default_tag.toLowerCase();
  header.innerHTML = `
    <div style="display:flex; flex-direction:column; gap:2px; text-align:left;">
      <span style="font-size:14px; font-weight:600; color:var(--text-primary);">${cand.name}</span>
      <span style="font-size:11px; color:var(--text-muted);">${cand.muscle_tags}</span>
    </div>
    <span class="tag-badge ${tagClass}" style="text-transform:uppercase;">${cand.default_tag}</span>
  `;
  
  const expansion = document.createElement('div');
  expansion.style.cssText = 'display:none; flex-direction:column; gap:10px; padding:0 12px 12px 12px; border-top:1px solid rgba(255,255,255,0.05); background:rgba(255,255,255,0.01);';
  expansion.innerHTML = `
    <div style="font-size:11px; font-weight:600; color:var(--text-muted); margin-top:8px; text-align:left;">Choose intensity protocol</div>
    <div class="protocol-slider-container" style="position:relative; display:flex; height:32px; background:rgba(0,0,0,0.2); border:1px solid var(--border-glass); border-radius:16px; overflow:hidden; padding:2px;">
      <div class="slider-thumb" style="position:absolute; top:2px; bottom:2px; left:2px; width:calc(33.33% - 2px); border-radius:14px; transition:transform 0.3s cubic-bezier(0.25, 1, 0.5, 1); pointer-events:none;"></div>
      <button type="button" class="protocol-btn" data-tag="HC" style="flex:1; background:none; border:none; font-family:inherit; font-size:11px; font-weight:700; z-index:2; cursor:pointer; transition:color 0.2s;">HC</button>
      <button type="button" class="protocol-btn" data-tag="LLP" style="flex:1; background:none; border:none; font-family:inherit; font-size:11px; font-weight:700; z-index:2; cursor:pointer; transition:color 0.2s;">LLP</button>
      <button type="button" class="protocol-btn" data-tag="Base" style="flex:1; background:none; border:none; font-family:inherit; font-size:11px; font-weight:700; z-index:2; cursor:pointer; transition:color 0.2s;">Base</button>
    </div>
    <button type="button" class="btn btn-confirm-add-ex" style="width:100%; padding:8px; font-size:12px; font-weight:700; margin-top:4px;">Add Exercise</button>
  `;
  
  row.appendChild(header);
  row.appendChild(expansion);
  
  let selectedTag = cand.default_tag;
  
  header.addEventListener('click', () => {
    const modal = document.getElementById('split-add-exercise-modal');
    modal.querySelectorAll('.substitution-row').forEach(otherRow => {
      if (otherRow !== row) {
        const otherExpansion = otherRow.querySelector('div:nth-child(2)');
        if (otherExpansion) otherExpansion.style.display = 'none';
      }
    });
    
    const isExpanded = expansion.style.display === 'flex';
    expansion.style.display = isExpanded ? 'none' : 'flex';
    if (!isExpanded) {
      updateSliderPosition(expansion, selectedTag);
    }
  });
  
  const sliderButtons = expansion.querySelectorAll('.protocol-btn');
  sliderButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      selectedTag = btn.getAttribute('data-tag');
      updateSliderPosition(expansion, selectedTag);
    });
  });
  
  const confirmBtn = expansion.querySelector('.btn-confirm-add-ex');
  confirmBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    
    // Update the protocol in draft registry
    if (splitDraftRegistry[cand.name]) {
      splitDraftRegistry[cand.name].default_tag = selectedTag;
    }
    
    // Add to day's exercises
    const dayData = splitDraft[splitActiveDay];
    if (dayData) {
      if (!dayData.exercises) dayData.exercises = [];
      dayData.exercises.push({ name: cand.name });
      
      // Snappy update of the card's exercises list
      const cardEl = document.querySelector(`.day-card[data-day="${splitActiveDay}"]`);
      if (cardEl) {
        const wrapper = cardEl.querySelector('.split-day-exercises-wrapper');
        renderSplitDayExercises(splitActiveDay, wrapper);
      }
    }
    
    document.getElementById('split-add-exercise-modal').close();
  });
  
  return row;
}

let splitModalEventsBound = false;
function setupSplitModalEventHandlers() {
  if (splitModalEventsBound) return;
  splitModalEventsBound = true;
  
  const searchInput = document.getElementById('split-add-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      renderSplitAddList(splitActiveDay, searchInput.value);
    });
  }
  
  const btnCloseModal = document.getElementById('btn-close-split-add-modal');
  if (btnCloseModal) {
    btnCloseModal.addEventListener('click', () => {
      document.getElementById('split-add-exercise-modal').close();
    });
  }
  
  const btnShowCustom = document.getElementById('btn-show-split-custom-inline');
  const customForm = document.getElementById('split-custom-inline-form');
  const btnCancelCustom = document.getElementById('btn-cancel-split-custom-inline');
  const btnSubmitCustom = document.getElementById('btn-submit-split-custom-inline');
  const customMusclesInput = document.getElementById('split-custom-ex-muscles');
  
  if (btnShowCustom && customForm) {
    btnShowCustom.addEventListener('click', () => {
      btnShowCustom.style.display = 'none';
      customForm.style.display = 'flex';
      document.getElementById('split-custom-ex-name').value = '';
      customMusclesInput.value = '';
      splitCustomChips = [];
      splitCustomDefaultTag = 'HC';
      renderSplitCustomChips();
      updateSplitCustomSliderPosition('HC');
    });
  }
  
  if (btnCancelCustom) {
    btnCancelCustom.addEventListener('click', () => {
      customForm.style.display = 'none';
      btnShowCustom.style.display = 'block';
    });
  }
  
  if (customMusclesInput) {
    customMusclesInput.addEventListener('input', () => {
      const val = customMusclesInput.value;
      if (val.includes(',')) {
        const parts = val.split(',');
        for (let i = 0; i < parts.length - 1; i++) {
          const chipText = parts[i].trim();
          if (chipText && !splitCustomChips.includes(chipText)) {
            splitCustomChips.push(chipText);
          }
        }
        customMusclesInput.value = parts[parts.length - 1];
        renderSplitCustomChips();
      }
    });
    
    customMusclesInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const chipText = customMusclesInput.value.trim();
        if (chipText) {
          if (!splitCustomChips.includes(chipText)) {
            splitCustomChips.push(chipText);
          }
          customMusclesInput.value = '';
          renderSplitCustomChips();
        }
      }
    });
  }
  
  if (customForm) {
    const customSliderContainer = customForm.querySelector('.protocol-slider-container');
    if (customSliderContainer) {
      const btns = customSliderContainer.querySelectorAll('.protocol-option-btn');
      btns.forEach(btn => {
        btn.addEventListener('click', () => {
          splitCustomDefaultTag = btn.getAttribute('data-tag');
          updateSplitCustomSliderPosition(splitCustomDefaultTag);
        });
      });
    }
  }
  
  if (btnSubmitCustom) {
    btnSubmitCustom.addEventListener('click', () => {
      const nameInput = document.getElementById('split-custom-ex-name');
      const newName = nameInput.value.trim();
      if (!newName) {
        alert("Please enter an exercise name.");
        return;
      }
      
      if (splitDraftRegistry[newName]) {
        alert("An exercise with this name already exists.");
        return;
      }
      
      const leftover = customMusclesInput.value.trim();
      if (leftover && !splitCustomChips.includes(leftover)) {
        splitCustomChips.push(leftover);
      }
      
      const muscleTagsStr = splitCustomChips.join(', ') || 'Other';
      
      // Save new exercise to draft registry!
      splitDraftRegistry[newName] = {
        notes: '',
        muscle_tags: muscleTagsStr,
        default_tag: splitCustomDefaultTag
      };
      
      // Add exercise to active day draft
      const dayData = splitDraft[splitActiveDay];
      if (dayData) {
        if (!dayData.exercises) dayData.exercises = [];
        dayData.exercises.push({ name: newName });
        
        // Snappy card update
        const cardEl = document.querySelector(`.day-card[data-day="${splitActiveDay}"]`);
        if (cardEl) {
          const wrapper = cardEl.querySelector('.split-day-exercises-wrapper');
          renderSplitDayExercises(splitActiveDay, wrapper);
        }
      }
      
      // Reset custom form
      customForm.style.display = 'none';
      btnShowCustom.style.display = 'block';
      document.getElementById('split-add-exercise-modal').close();
    });
  }
  
  const modal = document.getElementById('split-add-exercise-modal');
  if (modal) {
    enableLightDismiss(modal);
  }
}

function renderSplitCustomChips() {
  const container = document.getElementById('split-custom-chips-container');
  if (!container) return;
  container.innerHTML = '';
  
  splitCustomChips.forEach((chip, idx) => {
    const chipEl = document.createElement('div');
    chipEl.style.cssText = 'display:flex; align-items:center; gap:4px; font-size:11px; padding:3px 8px; border-radius:12px; font-weight:600; line-height:1;';
    
    if (idx === 0) {
      chipEl.style.background = 'var(--accent-lavender)';
      chipEl.style.color = '#0a0a0c';
      chipEl.textContent = `${chip} (Primary)`;
    } else {
      chipEl.style.background = 'rgba(255, 255, 255, 0.08)';
      chipEl.style.color = 'var(--text-secondary)';
      chipEl.textContent = chip;
    }
    
    const deleteBtn = document.createElement('span');
    deleteBtn.innerHTML = '&times;';
    deleteBtn.style.cssText = 'cursor:pointer; font-weight:bold; font-size:12px; margin-left:2px; display:inline-block; vertical-align:middle;';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      splitCustomChips.splice(idx, 1);
      renderSplitCustomChips();
    });
    
    chipEl.appendChild(deleteBtn);
    container.appendChild(chipEl);
  });
}

function updateSplitCustomSliderPosition(activeTag) {
  const container = document.querySelector('#split-custom-inline-form .protocol-slider-container');
  if (container) {
    updateSliderPosition(container, activeTag);
  }
}

function saveSplitChanges() {
  if (!splitDraft || !splitDraftRegistry) return;
  
  // 1. Commit draft registry changes to main registry state
  state.exerciseRegistry = splitDraftRegistry;
  localStorage.setItem(KEYS.EXERCISE_REGISTRY, JSON.stringify(state.exerciseRegistry));
  
  // 2. Separate weekday config from custom templates
  const weekdayConfig = {};
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  days.forEach(day => {
    weekdayConfig[day] = splitDraft[day];
  });
  
  const customTemplates = {};
  for (const key in splitDraft) {
    if (key.startsWith('_custom_')) {
      const customDay = splitDraft[key];
      const name = customDay.label.trim();
      if (name && name !== 'Rest Day' && name !== 'New Custom Day') {
        customTemplates[name] = {
          label: name,
          isRest: false,
          exercises: customDay.exercises.map(ex => ({ name: ex.name }))
        };
      }
    }
  }
  
  // 3. Commit weekday config using config.js saveRoutineConfig
  saveRoutineConfig(weekdayConfig);
  
  // 4. Save custom day templates
  localStorage.setItem('custom_day_templates', JSON.stringify(customTemplates));
  
  // 5. Sync to Google Sheets if webhook configured
  const templateMap = {};
  
  // Process Weekdays
  days.forEach(day => {
    const dayData = splitDraft[day];
    if (dayData.isRest) {
      if (!templateMap["Rest Day"]) {
        templateMap["Rest Day"] = { exercises: [], protocols: [], assignments: [] };
      }
      templateMap["Rest Day"].assignments.push(day);
    } else {
      const label = dayData.label;
      if (!templateMap[label]) {
        templateMap[label] = { exercises: [], protocols: [], assignments: [] };
        if (dayData.exercises) {
          dayData.exercises.forEach(ex => {
            const regObj = splitDraftRegistry[ex.name] || state.exerciseRegistry[ex.name] || {};
            const protocol = regObj.default_tag || "Base";
            templateMap[label].exercises.push(ex.name);
            templateMap[label].protocols.push(protocol);
          });
        }
      }
      if (!templateMap[label].assignments.includes(day)) {
        templateMap[label].assignments.push(day);
      }
    }
  });

  // Process Custom templates
  for (const key in splitDraft) {
    if (key.startsWith('_custom_')) {
      const customDay = splitDraft[key];
      const name = customDay.label.trim();
      if (name && name !== 'Rest Day' && name !== 'New Custom Day') {
        if (!templateMap[name]) {
          templateMap[name] = { exercises: [], protocols: [], assignments: ["Custom"] };
          if (customDay.exercises) {
            customDay.exercises.forEach(ex => {
              const regObj = splitDraftRegistry[ex.name] || state.exerciseRegistry[ex.name] || {};
              const protocol = regObj.default_tag || "Base";
              templateMap[name].exercises.push(ex.name);
              templateMap[name].protocols.push(protocol);
            });
          }
        }
      }
    }
  }

  // Map to Sheets row format
  const splitDataPayload = Object.keys(templateMap).map(label => {
    const item = templateMap[label];
    return {
      Template: label,
      Exercises: item.exercises.join(', '),
      Protocols: item.protocols.join(', '),
      Assignment: item.assignments.join(', ')
    };
  });

  const webhookUrl = getWebhookUrl();
  if (webhookUrl && !webhookUrl.includes('YOUR_APPS_SCRIPT_ID')) {
    fetch(webhookUrl, {
      method: 'POST',
      mode: 'no-cors',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        action: "UPDATE_SPLIT",
        split_data: splitDataPayload
      })
    }).then(() => {
      console.log("Split configuration synced to Google Sheets successfully (grouped format).");
    }).catch(err => {
      console.error("Failed to sync Split configuration to Google Sheets:", err);
    });
  }
  
  alert("Split Configuration and Exercise Registry changes successfully saved.");
  
  // 6. Return to dashboard and init
  showView('dashboard-view', 'backward');
  initDashboard();
}

// =============================================================
// PWA ANALYTICS TAB ENGINE (UPI% & e1RM Visualizer)
// =============================================================

let analyticsState = {
  currentMetricType: null, // 'weight' | 'muscle' | 'exercise'
  selectedMetric: null,    // 'Weight' | 'Chest' | 'Legs' | 'Incline Dumbbell Press' etc.
  currentRange: '3M',      // '1M' | '3M' | '6M' | 'All'
  excludeNotes: false      // Exclude logs with notes
};

const MUSCLE_GROUP_MAPPING = {
  'legs': ['quads', 'hamstrings', 'glutes', 'calves', 'legs'],
  'back': ['lats', 'mid-back', 'traps', 'rhomboids', 'back'],
  'chest': ['chest'],
  'shoulders': ['shoulders', 'rear delts', 'delts'],
  'arms': ['biceps', 'triceps', 'arms']
};

function belongsToGroup(muscle, group) {
  if (!muscle || !group) return false;
  const m = muscle.toLowerCase();
  const g = group.toLowerCase();
  if (g === m) return true;
  const mapped = MUSCLE_GROUP_MAPPING[g];
  if (!mapped) return false;
  return mapped.includes(m);
}

function openAnalyticsPanel() {
  // Reset navigation to State A selector main menu
  analyticsState.currentMetricType = null;
  analyticsState.selectedMetric = null;
  analyticsState.currentRange = '3M';
  analyticsState.excludeNotes = false;
  
  const excludeNotesCheckbox = document.getElementById('analytics-exclude-notes');
  if (excludeNotesCheckbox) {
    excludeNotesCheckbox.checked = false;
  }
  
  // Set dynamic layout state to Selection
  const viewContainer = document.getElementById('analytics-view');
  if (viewContainer) {
    viewContainer.classList.remove('state-detail', 'state-selection-sub');
    viewContainer.classList.add('state-selection-main');
  }
  
  const titleEl = document.getElementById('analytics-title');
  if (titleEl) {
    titleEl.textContent = 'Analytics';
  }
  
  const menuMain = document.getElementById('analytics-menu-main');
  const menuMuscles = document.getElementById('analytics-menu-muscles');
  const menuExercises = document.getElementById('analytics-menu-exercises');
  if (menuMain && menuMuscles && menuExercises) {
    menuMain.style.display = 'flex';
    menuMain.style.opacity = '1';
    menuMuscles.style.display = 'none';
    menuMuscles.style.opacity = '0';
    menuExercises.style.display = 'none';
    menuExercises.style.opacity = '0';
  }
  
  // Render selector event listeners if not already bound
  setupAnalyticsEventListeners();
  
  showView('analytics-view');
  
  // Populate bottom card with empty chart (after view is visible to measure size correctly)
  renderAnalyticsChart([]);
}

// 1. e1RM Calculation Math
function calculateExerciseE1RM(weight, reps, rir, tag) {
  const w = parseFloat(weight);
  const r = parseInt(reps);
  const rirVal = parseInt(rir);
  
  if (isNaN(w) || isNaN(r) || w <= 0 || r <= 0) return 0;
  
  const base = w * (1 + ((r + rirVal) / 30));
  
  let multiplier = 1.0;
  if (tag === 'Base') {
    multiplier = 1.15;
  } else if (tag === 'LLP') {
    multiplier = 1.0; // Treating LLP as 1.0x (same as HC)
  }
  
  return base * multiplier;
}

// Get range cut-off date helper
function getRangeStartDate(rangeKey) {
  const now = new Date();
  if (rangeKey === '1M') {
    now.setMonth(now.getMonth() - 1);
  } else if (rangeKey === '3M') {
    now.setMonth(now.getMonth() - 3);
  } else if (rangeKey === '6M') {
    now.setMonth(now.getMonth() - 6);
  } else {
    return new Date(0); // All time
  }
  return now;
}

// 2. Data Filtering and Normalization Engine
function getStartOfWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d.setDate(diff));
  
  const yyyy = monday.getFullYear();
  const mm = String(monday.getMonth() + 1).padStart(2, '0');
  const dd = String(monday.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function isExcludedNote(note) {
  if (!note) return false;
  const lower = note.toLowerCase();
  return lower.includes('#exclude') || lower.includes('[exclude]') || lower.includes('exclude:true') || lower.includes('@exclude');
}

function isBaselineNote(note) {
  if (!note) return false;
  const lower = note.toLowerCase();
  return lower.includes('#baseline') || lower.includes('[baseline]') || lower.includes('baseline:true') || lower.includes('@baseline');
}

// 2. Data Filtering and Normalization Engine
function processAnalyticsData() {
  const startDate = getRangeStartDate(analyticsState.currentRange);
  const logs = []; // Array of { date: string, value: float, hasNote: boolean, workoutNote: string }
  
  // Filter history logs chronologically
  const sortedDates = Object.keys(state.history).sort();

  // 1. Chronological pass: Calculate raw daily averages and extrapolate starting baselines
  const exerciseBaselines = {}; // exName -> array of { date: string, val: float, isManual: boolean }
  const exerciseDailyE1RMs = {}; // exName -> array of { date: string, val: float }
  
  const rollingGroupUPIs = {
    'legs': 100,
    'back': 100,
    'chest': 100,
    'shoulders': 100,
    'arms': 100
  };

  sortedDates.forEach(dateStr => {
    const workout = state.history[dateStr];
    if (!workout || !workout.exercises) return;
    if (isExcludedNote(workout.workoutNote)) return;

    const rawE1RMs = {};
    workout.exercises.forEach(ex => {
      if (analyticsState.excludeNotes && ex.workoutNote && ex.workoutNote.trim()) return;
      if (isExcludedNote(ex.workoutNote)) return;
      if (!ex.setData || !Array.isArray(ex.setData)) return;

      let sumE1RM = 0;
      let count = 0;
      ex.setData.forEach(set => {
        const e1rm = calculateExerciseE1RM(set.weight, set.reps, set.rir, ex.tag);
        if (e1rm > 0) {
          sumE1RM += e1rm;
          count++;
        }
      });

      if (count > 0) {
        rawE1RMs[ex.name] = sumE1RM / count;
      }
    });

    Object.keys(rawE1RMs).forEach(exName => {
      const rawVal = rawE1RMs[exName];
      const exObj = workout.exercises.find(e => e.name === exName);
      const isManualBaseline = isBaselineNote(workout.workoutNote) || (exObj && isBaselineNote(exObj.workoutNote));

      if (!exerciseBaselines[exName]) {
        // First time ever seeing this exercise - estimate its starting baseline!
        const rawTags = getExerciseTarget(exName) || '';
        const muscles = rawTags.split(/[,\/]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
        
        let primaryGroup = 'chest';
        if (muscles.length > 0) {
          const primaryMuscle = muscles[0];
          ['legs', 'back', 'chest', 'shoulders', 'arms'].forEach(g => {
            if (belongsToGroup(primaryMuscle, g)) {
              primaryGroup = g;
            }
          });
        }

        const currentGroupUPI = rollingGroupUPIs[primaryGroup] || 100;
        const estimatedBaseline = rawVal / (currentGroupUPI / 100);

        exerciseBaselines[exName] = [{
          date: dateStr,
          val: estimatedBaseline,
          isManual: false
        }];
      } else if (isManualBaseline) {
        exerciseBaselines[exName].push({
          date: dateStr,
          val: rawVal,
          isManual: true
        });
      }
    });

    const dailyExUPIs = {};
    Object.keys(rawE1RMs).forEach(exName => {
      const rawVal = rawE1RMs[exName];
      const match = exerciseBaselines[exName].filter(b => b.date <= dateStr).pop();
      const activeBaseline = match ? match.val : rawVal;
      
      const upi = (rawVal / activeBaseline) * 100;
      dailyExUPIs[exName] = upi;

      if (!exerciseDailyE1RMs[exName]) {
        exerciseDailyE1RMs[exName] = [];
      }
      exerciseDailyE1RMs[exName].push({
        date: dateStr,
        val: rawVal
      });
    });

    // Group active UPIs into muscle groups to update rollingGroupUPIs
    const dailyGroupUPI = {
      'legs': { sum: 0, weight: 0 },
      'back': { sum: 0, weight: 0 },
      'chest': { sum: 0, weight: 0 },
      'shoulders': { sum: 0, weight: 0 },
      'arms': { sum: 0, weight: 0 }
    };

    for (const exName in dailyExUPIs) {
      const upi = dailyExUPIs[exName];
      const rawTags = getExerciseTarget(exName) || '';
      const muscles = rawTags.split(/[,\/]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
      
      if (muscles.length > 0) {
        const primary = muscles[0];
        const secondary = muscles[1] || '';
        
        ['legs', 'back', 'chest', 'shoulders', 'arms'].forEach(g => {
          if (belongsToGroup(primary, g)) {
            dailyGroupUPI[g].sum += upi * 1.0;
            dailyGroupUPI[g].weight += 1.0;
          } else if (belongsToGroup(secondary, g)) {
            dailyGroupUPI[g].sum += upi * 0.3;
            dailyGroupUPI[g].weight += 0.3;
          }
        });
      }
    }

    ['legs', 'back', 'chest', 'shoulders', 'arms'].forEach(g => {
      if (dailyGroupUPI[g].weight > 0) {
        rollingGroupUPIs[g] = dailyGroupUPI[g].sum / dailyGroupUPI[g].weight;
      }
    });
  });

  const getExerciseBaselineForDate = (exName, dateStr) => {
    const points = exerciseBaselines[exName];
    if (!points || points.length === 0) return null;
    
    const pastPoints = points.filter(p => p.date <= dateStr);
    if (pastPoints.length === 0) return points[0].val;
    
    const match = pastPoints.pop();
    return match ? match.val : points[0].val;
  };
  
  if (analyticsState.currentMetricType === 'weight') {
    // ---------------------------------------------------------
    // BODY WEIGHT TRACKER
    // ---------------------------------------------------------
    const weightDates = Object.keys(state.weightHistory).sort();
    
    // Find weight baselines
    const weightBaselines = [];
    weightDates.forEach(dateStr => {
      const workout = state.history[dateStr];
      if (workout && isBaselineNote(workout.workoutNote)) {
        weightBaselines.push({ date: dateStr, val: parseFloat(state.weightHistory[dateStr]) });
      }
    });
    
    let firstWeight = null;
    for (let i = 0; i < weightDates.length; i++) {
      const w = parseFloat(state.weightHistory[weightDates[i]]);
      if (w > 0) {
        firstWeight = w;
        break;
      }
    }
    
    weightDates.forEach(dateStr => {
      const d = new Date(dateStr + 'T00:00:00');
      if (d >= startDate) {
        const workout = state.history[dateStr];
        if (workout && isExcludedNote(workout.workoutNote)) {
          return;
        }
        
        const val = parseFloat(state.weightHistory[dateStr]);
        if (val > 0) {
          const match = weightBaselines.filter(b => b.date <= dateStr).pop();
          const activeBaseline = match ? match.val : firstWeight;
          
          if (activeBaseline > 0) {
            const pct = (val / activeBaseline) * 100;
            logs.push({ date: dateStr, value: pct, rawVal: val, unit: 'lbs', hasNote: false, workoutNote: '' });
          }
        }
      }
    });
  } else if (analyticsState.currentMetricType === 'exercise') {
    // ---------------------------------------------------------
    // EXERCISE e1RM TRACKER
    // ---------------------------------------------------------
    const targetEx = analyticsState.selectedMetric;
    
    sortedDates.forEach(dateStr => {
      const workout = state.history[dateStr];
      if (!workout || !workout.exercises) return;
      if (isExcludedNote(workout.workoutNote)) return;
      
      const ex = workout.exercises.find(e => e.name === targetEx);
      if (ex && ex.setData && ex.setData.length > 0) {
        if (analyticsState.excludeNotes && ex.workoutNote && ex.workoutNote.trim()) {
          return;
        }
        if (isExcludedNote(ex.workoutNote)) return;
        
        let sumE1RM = 0;
        let count = 0;
        ex.setData.forEach(set => {
          const e1rm = calculateExerciseE1RM(set.weight, set.reps, set.rir, ex.tag);
          if (e1rm > 0) {
            sumE1RM += e1rm;
            count++;
          }
        });
        if (count > 0) {
          const dailyAvg = sumE1RM / count;
          const baseline = getExerciseBaselineForDate(targetEx, dateStr);
          if (baseline > 0) {
            const pct = (dailyAvg / baseline) * 100;
            const hasNote = !!(ex.workoutNote && ex.workoutNote.trim());
            logs.push({
              date: dateStr,
              value: pct,
              rawVal: dailyAvg,
              unit: 'lbs',
              hasNote: hasNote,
              workoutNote: hasNote ? ex.workoutNote.trim() : ''
            });
          }
        }
      }
    });
  } else if (analyticsState.currentMetricType === 'muscle') {
    // ---------------------------------------------------------
    // MUSCLE GROUPS & MASTER INDEX
    // ---------------------------------------------------------
    const targetMuscleGroup = analyticsState.selectedMetric;
    
    // Track last known values for carry forward
    const lastKnownGroups = {
      'legs': 100,
      'back': 100,
      'chest': 100,
      'shoulders': 100,
      'arms': 100
    };
    
    // Helper to calculate daily average UPI% for a specific group
    const getGroupDailyUPI = (workout, targetGroup, dateStr) => {
      let sumUPI = 0;
      let sumWeight = 0;
      let hasNote = false;
      const notesList = [];
      
      workout.exercises.forEach(ex => {
        if (analyticsState.excludeNotes && ex.workoutNote && ex.workoutNote.trim()) {
          return;
        }
        if (isExcludedNote(ex.workoutNote)) return;
        
        const baseline = getExerciseBaselineForDate(ex.name, dateStr);
        if (!baseline) return;
        
        // Calculate daily average e1RM
        let sumE1RM = 0;
        let count = 0;
        ex.setData.forEach(set => {
          const e1rm = calculateExerciseE1RM(set.weight, set.reps, set.rir, ex.tag);
          if (e1rm > 0) {
            sumE1RM += e1rm;
            count++;
          }
        });
        
        if (count > 0) {
          const dailyAvg = sumE1RM / count;
          const upi = (dailyAvg / baseline) * 100;
          
          // Parse muscle tags
          const rawTags = ex.target || getExerciseTarget(ex.name) || '';
          const muscles = rawTags.split(/[,\/]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
          
          if (muscles.length > 0) {
            const primary = muscles[0];
            const secondary = muscles[1] || '';
            const tGroup = targetGroup.toLowerCase();
            
            let matched = false;
            // Map primary (100% weight) and secondary (30% weight)
            if (belongsToGroup(primary, tGroup)) {
              sumUPI += upi * 1.0;
              sumWeight += 1.0;
              matched = true;
            } else if (belongsToGroup(secondary, tGroup)) {
              sumUPI += upi * 0.3;
              sumWeight += 0.3;
              matched = true;
            }
            
            if (matched && ex.workoutNote && ex.workoutNote.trim()) {
              hasNote = true;
              notesList.push(`${ex.name}: ${ex.workoutNote.trim()}`);
            }
          }
        }
      });
      
      return {
        value: sumWeight > 0 ? (sumUPI / sumWeight) : null,
        hasNote,
        workoutNote: notesList.join(' | ')
      };
    };
    
    // Track last known values for carry forward
    const lastKnownWeeklyGroups = {
      'legs': 100,
      'back': 100,
      'chest': 100,
      'shoulders': 100,
      'arms': 100
    };
    
    // Group workouts in the selected date range by week start date (Monday)
    const workoutsByWeek = {}; // weekKey -> array of { date: string, workout: object }
    
    sortedDates.forEach(dateStr => {
      const d = new Date(dateStr + 'T00:00:00');
      if (d >= startDate) {
        const workout = state.history[dateStr];
        if (!workout || !workout.exercises) return;
        if (isExcludedNote(workout.workoutNote)) return;
        
        const weekKey = getStartOfWeek(dateStr);
        if (!workoutsByWeek[weekKey]) {
          workoutsByWeek[weekKey] = [];
        }
        workoutsByWeek[weekKey].push({ date: dateStr, workout: workout });
      }
    });
    
    const weekKeys = Object.keys(workoutsByWeek).sort();
    
    weekKeys.forEach(weekKey => {
      const dayNotesList = [];
      let dayHasNote = false;
      
      // Collate all exercises trained in this week
      const weeklyExData = {}; // name -> { sum: 0, count: 0, notes: [] }
      
      workoutsByWeek[weekKey].forEach(({ date, workout }) => {
        workout.exercises.forEach(ex => {
          if (analyticsState.excludeNotes && ex.workoutNote && ex.workoutNote.trim()) {
            return;
          }
          if (isExcludedNote(ex.workoutNote)) return;
          
          if (!weeklyExData[ex.name]) {
            weeklyExData[ex.name] = { sum: 0, count: 0, notes: [] };
          }
          
          ex.setData.forEach(set => {
            const e1rm = calculateExerciseE1RM(set.weight, set.reps, set.rir, ex.tag);
            if (e1rm > 0) {
              weeklyExData[ex.name].sum += e1rm;
              weeklyExData[ex.name].count++;
            }
          });
          
          if (ex.workoutNote && ex.workoutNote.trim()) {
            weeklyExData[ex.name].notes.push(ex.workoutNote.trim());
          }
        });
      });
      
      // Calculate weekly UPI% for each exercise trained
      const weeklyExUPI = {};
      for (const name in weeklyExData) {
        const data = weeklyExData[name];
        const baseline = getExerciseBaselineForDate(name, weekKey);
        if (baseline && data.count > 0) {
          const avgE1RM = data.sum / data.count;
          weeklyExUPI[name] = (avgE1RM / baseline) * 100;
          
          if (data.notes.length > 0) {
            dayHasNote = true;
            data.notes.forEach(n => {
              if (!dayNotesList.includes(`${name}: ${n}`)) {
                dayNotesList.push(`${name}: ${n}`);
              }
            });
          }
        }
      }
      
      // Group the weekly exercise UPIs into muscle groups
      const weeklyGroupUPI = {
        'legs': { sum: 0, weight: 0 },
        'back': { sum: 0, weight: 0 },
        'chest': { sum: 0, weight: 0 },
        'shoulders': { sum: 0, weight: 0 },
        'arms': { sum: 0, weight: 0 }
      };
      
      for (const name in weeklyExUPI) {
        const upi = weeklyExUPI[name];
        const rawTags = getExerciseTarget(name) || '';
        const muscles = rawTags.split(/[,\/]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
        
        if (muscles.length > 0) {
          const primary = muscles[0];
          const secondary = muscles[1] || '';
          
          ['legs', 'back', 'chest', 'shoulders', 'arms'].forEach(g => {
            if (belongsToGroup(primary, g)) {
              weeklyGroupUPI[g].sum += upi * 1.0;
              weeklyGroupUPI[g].weight += 1.0;
            } else if (belongsToGroup(secondary, g)) {
              weeklyGroupUPI[g].sum += upi * 0.3;
              weeklyGroupUPI[g].weight += 0.3;
            }
          });
        }
      }
      
      // Update carry-forward values
      let activeInWeek = false;
      ['legs', 'back', 'chest', 'shoulders', 'arms'].forEach(g => {
        if (weeklyGroupUPI[g].weight > 0) {
          lastKnownWeeklyGroups[g] = weeklyGroupUPI[g].sum / weeklyGroupUPI[g].weight;
          activeInWeek = true;
        }
      });
      
      if (activeInWeek) {
        if (targetMuscleGroup === 'Full Body') {
          const masterVal = 
            lastKnownWeeklyGroups['legs'] * 0.22 +
            lastKnownWeeklyGroups['back'] * 0.22 +
            lastKnownWeeklyGroups['chest'] * 0.22 +
            lastKnownWeeklyGroups['shoulders'] * 0.18 +
            lastKnownWeeklyGroups['arms'] * 0.16;
          
          logs.push({
            date: weekKey,
            value: masterVal,
            rawVal: masterVal,
            unit: '%',
            hasNote: dayHasNote,
            workoutNote: dayNotesList.join(' | ')
          });
        } else {
          const gKey = targetMuscleGroup.toLowerCase();
          const val = lastKnownWeeklyGroups[gKey];
          logs.push({
            date: weekKey,
            value: val,
            rawVal: val,
            unit: '%',
            hasNote: dayHasNote,
            workoutNote: dayNotesList.join(' | ')
          });
        }
      }
    });
  }
  
  return logs;
}

// 3. SVG Line Chart Rendering Engine
function renderAnalyticsChart(data, drawLine = true) {
  const svg = document.getElementById('analytics-svg-chart');
  const path = document.getElementById('analytics-svg-path');
  const dottedPath = document.getElementById('analytics-svg-dotted-path');
  const gridline = document.getElementById('analytics-baseline-gridline');
  const dotsContainer = document.getElementById('analytics-svg-dots');
  const peakLabel = document.getElementById('analytics-chart-peak-label');
  const maskRect = document.getElementById('analytics-mask-rect');
  
  if (!svg || !path || !gridline || !dotsContainer) return;
  
  dotsContainer.innerHTML = '';
  
  // Use measured final dimensions if available to prevent stretching
  const width = analyticsState.finalWidth || svg.clientWidth || 350;
  const height = analyticsState.finalHeight || svg.clientHeight || 200;
  const marginY = 15;
  const marginX = 15;
  
  if (data.length === 0) {
    path.setAttribute('d', '');
    if (dottedPath) {
      dottedPath.setAttribute('d', '');
    }
    if (peakLabel) peakLabel.textContent = 'Peak Performance: --';
    
    // Restore default percentage position (10% from the bottom)
    gridline.setAttribute('x1', '0');
    gridline.setAttribute('x2', '100%');
    gridline.setAttribute('y1', '90%');
    gridline.setAttribute('y2', '90%');
    gridline.style.display = 'block';
    
    if (maskRect) {
      maskRect.setAttribute('height', height.toString());
      maskRect.style.transition = 'none';
      maskRect.setAttribute('width', '0');
    }
    return;
  }
  
  // Find min/max boundaries
  const values = data.map(d => d.value);
  const minVal = Math.min(...values, 100); // lock baseline 100% inside graph
  const maxVal = Math.max(...values, 100);
  
  const peakVal = Math.max(...values);
  if (peakLabel) {
    peakLabel.textContent = `Peak Performance: ${Math.round(peakVal)}%`;
  }
  
  const drawHeight = height - (2 * marginY);
  const drawWidth = width - (2 * marginX);
  
  const valRange = maxVal - minVal || 1;
  
  // Invert Y coordinates since SVG 0 is top
  const getX = (index) => {
    if (data.length <= 1) return width / 2;
    return marginX + (index * (drawWidth / (data.length - 1)));
  };
  
  const getY = (val) => {
    // 0 is maxVal (top), drawHeight is minVal (bottom)
    return marginY + drawHeight - ((val - minVal) / valRange * drawHeight);
  };
  
  // Draw dotted 100% baseline gridline
  const baselineY = getY(100);
  gridline.setAttribute('x1', '0');
  gridline.setAttribute('x2', width.toString());
  gridline.setAttribute('y1', baselineY.toString());
  gridline.setAttribute('y2', baselineY.toString());
  gridline.style.display = 'block';
  
  // 1. Draw solid line connecting all dots consecutively
  let dStrSolid = '';
  if (drawLine) {
    data.forEach((d, idx) => {
      const x = getX(idx);
      const y = getY(d.value);
      if (idx === 0) {
        dStrSolid += `M ${x} ${y}`;
      } else {
        dStrSolid += ` L ${x} ${y}`;
      }
    });
  }

  // 2. Overlay a dotted line bridging only purple dots that are separated by gold dots (note logs)
  const purpleIndices = [];
  data.forEach((d, idx) => {
    if (!d.hasNote) {
      purpleIndices.push(idx);
    }
  });

  let dStrDotted = '';
  if (drawLine) {
    for (let k = 0; k < purpleIndices.length - 1; k++) {
      const i = purpleIndices[k];
      const j = purpleIndices[k + 1];
      if (j > i + 1) {
        // There is a note gap (gold dot) between purple indices i and j
        const x1 = getX(i);
        const y1 = getY(data[i].value);
        const x2 = getX(j);
        const y2 = getY(data[j].value);
        dStrDotted += ` M ${x1} ${y1} L ${x2} ${y2}`;
      }
    }
  }
  
  // Draw dots
  data.forEach((d, idx) => {
    const x = getX(idx);
    const y = getY(d.value);
    
    // Draw dot
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', x);
    circle.setAttribute('cy', y);
    circle.setAttribute('r', '5');
    circle.setAttribute('fill', d.hasNote ? 'var(--accent-gold)' : 'var(--accent-lavender)');
    circle.setAttribute('stroke', '#000');
    circle.setAttribute('stroke-width', '1.5');
    circle.style.cursor = 'pointer';
    
    // Attach click popup on dots
    circle.addEventListener('click', () => {
      const dialog = document.getElementById('analytics-info-dialog');
      const titleEl = document.getElementById('analytics-info-title');
      const bodyEl = document.getElementById('analytics-info-body');
      if (!dialog || !titleEl || !bodyEl) return;
  
      const dateObj = new Date(d.date + 'T00:00:00');
      let titleText = '';
      if (analyticsState.currentMetricType === 'muscle' && analyticsState.selectedMetric === 'Full Body') {
        const fmt = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        titleText = `Week of ${fmt}`;
      } else {
        titleText = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      }
  
      titleEl.textContent = titleText;
  
      // Determine exercises to display
      let exercisesToDisplay = [];
      if (analyticsState.currentMetricType === 'exercise') {
        const workout = state.history[d.date];
        if (workout && workout.exercises) {
          workout.exercises.forEach(ex => {
            if (ex.name === analyticsState.selectedMetric) {
              exercisesToDisplay.push({
                name: ex.name,
                tag: ex.tag,
                setData: ex.setData,
                workoutNote: ex.workoutNote
              });
            }
          });
        }
      } else if (analyticsState.currentMetricType === 'muscle') {
        const targetGroup = analyticsState.selectedMetric;
        if (targetGroup === 'Full Body') {
          const startDay = new Date(d.date + 'T00:00:00');
          const endDay = new Date(startDay.getTime() + 7 * 24 * 60 * 60 * 1000);
          Object.keys(state.history).sort().forEach(dateKey => {
            const entryDate = new Date(dateKey + 'T00:00:00');
            if (entryDate >= startDay && entryDate < endDay) {
              const workout = state.history[dateKey];
              workout.exercises.forEach(ex => {
                exercisesToDisplay.push({
                  name: ex.name,
                  tag: ex.tag,
                  setData: ex.setData,
                  workoutNote: ex.workoutNote
                });
              });
            }
          });
        } else {
          const workout = state.history[d.date];
          if (workout && workout.exercises) {
            workout.exercises.forEach(ex => {
              const rawTags = ex.target || getExerciseTarget(ex.name) || '';
              const muscles = rawTags.split(/[,\/]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
              if (muscles.length > 0) {
                const primary = muscles[0];
                const secondary = muscles[1] || '';
                if (belongsToGroup(primary, targetGroup.toLowerCase()) || belongsToGroup(secondary, targetGroup.toLowerCase())) {
                  exercisesToDisplay.push({
                    name: ex.name,
                    tag: ex.tag,
                    setData: ex.setData,
                    workoutNote: ex.workoutNote
                  });
                }
              }
            });
          }
        }
      }
      
      let exercisesHtml = '';
      if (exercisesToDisplay.length > 0) {
        exercisesHtml = exercisesToDisplay.map(ex => `
          <div style="background:rgba(255,255,255,0.02); border:1px solid var(--border-glass); border-radius:16px; padding:12px; margin-top:8px; display:flex; flex-direction:column; gap:8px; text-align:left;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <span style="font-size:13px; font-weight:700; color:var(--text-primary);">${ex.name}</span>
              <span class="tag-badge ${ex.tag.toLowerCase()}">${ex.tag}</span>
            </div>
            ${ex.workoutNote && ex.workoutNote.trim() ? `
              <div style="font-size:11px; font-style:italic; color:var(--accent-gold); padding:4px 8px; background:rgba(252, 163, 17, 0.05); border:1px solid rgba(252, 163, 17, 0.15); border-radius:8px;">
                Note: ${ex.workoutNote.trim()}
              </div>
            ` : ''}
            <div style="display:grid; grid-template-columns:1.2fr 2.5fr 1.5fr 1.5fr; gap:6px; font-size:10px; font-weight:700; color:var(--text-muted); text-transform:uppercase; text-align:center; padding-bottom:4px; border-bottom:1px solid rgba(255,255,255,0.05);">
              <div>Set</div>
              <div>Weight</div>
              <div>Reps</div>
              <div>RIR</div>
            </div>
            ${ex.setData.map((set, setIdx) => `
              <div style="display:grid; grid-template-columns:1.2fr 2.5fr 1.5fr 1.5fr; gap:6px; text-align:center; font-size:12px; color:var(--text-primary); padding-top:4px;">
                <div>${setIdx + 1}</div>
                <div>${set.weight} lbs</div>
                <div>${set.reps}</div>
                <div>${set.rir}</div>
              </div>
            `).join('')}
          </div>
        `).join('');
      } else if (analyticsState.currentMetricType === 'weight') {
        exercisesHtml = `
          <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.02); border:1px solid var(--border-glass); border-radius:16px; padding:12px; margin-top:8px;">
            <span style="font-size:12px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px;">Body Weight</span>
            <span style="font-size:14px; font-weight:600; color:var(--text-primary);">${Math.round(d.rawVal)} lbs</span>
          </div>
        `;
      }
  
      bodyEl.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:12px;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size:12px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px;">Performance</span>
            <span class="tag-badge llp" style="font-size:14px; font-weight:700; color:var(--accent-lavender); padding:4px 8px; border-radius:8px;">${Math.round(d.value)}%</span>
          </div>
          ${exercisesHtml}
          ${d.hasNote && d.workoutNote && !exercisesToDisplay.some(ex => ex.workoutNote && ex.workoutNote.trim() === d.workoutNote.trim()) ? `
          <div style="background:rgba(252, 163, 17, 0.08); border:1px solid rgba(252, 163, 17, 0.25); border-radius:12px; padding:10px 12px; margin-top:4px; text-align:left;">
            <div style="font-size:11px; font-weight:700; color:var(--accent-gold); text-transform:uppercase; margin-bottom:4px; letter-spacing:0.5px;">Note</div>
            <div style="font-size:12px; color:var(--text-secondary); line-height:1.4; font-style:italic;">${d.workoutNote}</div>
          </div>
          ` : ''}
        </div>
      `;
  
      dialog.showModal();
    });
    
    dotsContainer.appendChild(circle);
  });
  
  if (drawLine) {
    path.setAttribute('d', dStrSolid);
    if (dottedPath) {
      dottedPath.setAttribute('d', dStrDotted);
    }
    
    if (maskRect) {
      maskRect.setAttribute('height', height.toString());
      // Reset width to 0 without transition
      maskRect.style.transition = 'none';
      maskRect.setAttribute('width', '0');
      void maskRect.offsetWidth; // force reflow
      
      // Animate width to reveal both solid and dotted paths concurrently
      maskRect.style.transition = 'width 1.5s cubic-bezier(0.22, 1, 0.36, 1)';
      maskRect.setAttribute('width', width.toString());
    }
  } else {
    path.setAttribute('d', '');
    if (dottedPath) {
      dottedPath.setAttribute('d', '');
    }
    if (maskRect) {
      maskRect.setAttribute('height', height.toString());
      maskRect.style.transition = 'none';
      maskRect.setAttribute('width', '0');
    }
  }
}

// 4. Render logs list
function renderAnalyticsLogsList(data) {
  const container = document.getElementById('analytics-logs-list');
  if (!container) return;
  
  container.innerHTML = '';
  
  if (data.length === 0) {
    container.innerHTML = `<div style="text-align:center; padding:20px; color:var(--text-muted); font-size:13px;">No logs found for this date range.</div>`;
    return;
  }
  
  // List chronologically descending (newest first)
  const reversed = [...data].reverse();
  
  reversed.forEach(log => {
    const row = document.createElement('div');
    row.className = 'analytics-card';
    row.style.cssText = 'padding:12px; margin-bottom:6px; cursor:default;';
    
    const dateObj = new Date(log.date + 'T00:00:00');
    let fmtDate = '';
    if (analyticsState.currentMetricType === 'muscle' && analyticsState.selectedMetric === 'Full Body') {
      fmtDate = 'Week of ' + dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } else {
      fmtDate = dateObj.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    }
    
    row.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:2px; text-align:left;">
        <span style="font-size:13px; font-weight:600; color:var(--text-primary);">${fmtDate}</span>
        <span style="font-size:11px; color:var(--text-muted);">${Math.round(log.rawVal)} ${log.unit}</span>
        ${log.hasNote && log.workoutNote ? `<div style="font-size:10.5px; color:var(--accent-gold); margin-top:2px; font-style:italic; line-height:1.2;">Note: ${log.workoutNote}</div>` : ''}
      </div>
      <span class="tag-badge llp" style="font-size:10px; font-weight:700; color:var(--accent-lavender);">${Math.round(log.value)}%</span>
    `;
    container.appendChild(row);
  });
}

// 5. State B: Transition and Data Loading
function loadAnalyticsDataView(metricType, metricVal) {
  analyticsState.currentMetricType = metricType;
  analyticsState.selectedMetric = metricVal;
  analyticsState.currentRange = '1M'; // default default range
  
  const viewContainer = document.getElementById('analytics-view');
  const svg = document.getElementById('analytics-svg-chart');
  
  // Measure final detail view size of the SVG
  let finalWidth = 350;
  let finalHeight = 200;
  
  if (viewContainer && svg) {
    // Select transitioning layout-affecting elements
    const selectorCard = document.getElementById('analytics-selector-card');
    const chartCard = document.getElementById('analytics-chart-card');
    const headerTitleBar = document.getElementById('analytics-header-title-bar');
    
    const transitioningEls = [viewContainer, selectorCard, chartCard, headerTitleBar].filter(Boolean);
    const originalTransitions = transitioningEls.map(el => el.style.transition);
    
    // Temporarily disable transitions to force an instant layout snap
    transitioningEls.forEach(el => el.style.transition = 'none');
    
    // Temporarily force state-detail class to calculate layout
    const prevClasses = Array.from(viewContainer.classList);
    
    viewContainer.classList.remove('state-selection-main', 'state-selection-sub');
    viewContainer.classList.add('state-detail');
    
    // Force layout engine computation
    const rect = svg.getBoundingClientRect();
    finalWidth = rect.width || 350;
    finalHeight = rect.height || 200;
    
    // Restore previous state classes
    viewContainer.classList.forEach(c => viewContainer.classList.remove(c));
    prevClasses.forEach(c => viewContainer.classList.add(c));
    
    // Restore original transitions
    transitioningEls.forEach((el, idx) => el.style.transition = originalTransitions[idx]);
  }
  
  analyticsState.finalWidth = finalWidth;
  analyticsState.finalHeight = finalHeight;
  
  // Apply morph and collapse classes immediately
  if (analyticsState.clickedCard) {
    analyticsState.clickedCard.classList.add('clicked-morph');
    
    const selectorCard = document.getElementById('analytics-selector-card');
    if (selectorCard) {
      const allCards = selectorCard.querySelectorAll('.analytics-card');
      allCards.forEach(card => {
        if (card !== analyticsState.clickedCard) {
          card.classList.add('fade-collapse');
        }
      });
      
      const backButtons = selectorCard.querySelectorAll('.btn-analytics-back');
      backButtons.forEach(btn => btn.classList.add('fade-collapse'));
      
      const searchInput = document.getElementById('analytics-exercise-search');
      if (searchInput) searchInput.classList.add('fade-collapse');
      
      const listHeaders = selectorCard.querySelectorAll('#analytics-exercise-list > div:not(.analytics-card)');
      listHeaders.forEach(hdr => hdr.classList.add('fade-collapse'));
    }
  }
  
  // Toggle layout from Selection to Detail State immediately
  if (viewContainer) {
    viewContainer.classList.remove('state-selection-main', 'state-selection-sub');
    viewContainer.classList.add('state-detail');
  }
  
  // Set date range slider container state and thumb to 1M immediately
  const container = document.querySelector('.date-range-slider-container');
  if (container) {
    const thumb = document.getElementById('analytics-date-thumb');
    if (thumb) thumb.style.transform = 'translateX(0%)';
    const buttons = container.querySelectorAll('.date-pill-btn');
    buttons.forEach(btn => {
      const btnRange = btn.getAttribute('data-range');
      if (btnRange === '1M') {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
        btn.style.color = '#708090';
      }
    });
  }

  // Process data and render all dots and logs list immediately (during transition)
  const processedData = processAnalyticsData();
  renderAnalyticsChart(processedData, false); // drawLine = false
  renderAnalyticsLogsList(processedData);
  
  // Defer drawing the lines until transition animation finishes (900ms)
  setTimeout(() => {
    if (analyticsState.selectedMetric === metricVal && viewContainer && viewContainer.classList.contains('state-detail')) {
      renderAnalyticsChart(processedData, true); // drawLine = true
    }
  }, 900);
}

function updateAnalyticsDateSlider(range) {
  analyticsState.currentRange = range;
  
  const container = document.querySelector('.date-range-slider-container');
  const thumb = document.getElementById('analytics-date-thumb');
  const buttons = container.querySelectorAll('.date-pill-btn');
  
  let translateX = '0%';
  if (range === '1M') translateX = '0%';
  else if (range === '3M') translateX = '100%';
  else if (range === '6M') translateX = '200%';
  else if (range === 'All') translateX = '300%';
  
  if (thumb) {
    thumb.style.transform = `translateX(${translateX})`;
  }
  
  buttons.forEach(btn => {
    const btnRange = btn.getAttribute('data-range');
    if (btnRange === range) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
      btn.style.color = '#708090'; // default Gray color
    }
  });
  
  // Process and render
  const processedData = processAnalyticsData();
  renderAnalyticsChart(processedData);
  renderAnalyticsLogsList(processedData);
}

// Helper to switch sub-menus inside selector card with a quick fade transition
function switchSubMenu(fromId, toId) {
  const fromEl = document.getElementById(fromId);
  const toEl = document.getElementById(toId);
  if (!fromEl || !toEl) return;
  
  fromEl.style.transition = 'opacity 0.15s ease-in-out';
  fromEl.style.opacity = '0';
  
  setTimeout(() => {
    fromEl.style.display = 'none';
    toEl.style.display = 'flex';
    toEl.style.opacity = '0';
    toEl.style.transition = 'opacity 0.15s ease-in-out';
    
    // Force reflow
    void toEl.offsetWidth;
    toEl.style.opacity = '1';
  }, 150);
}

// 6. Navigation Event Listeners
let analyticsEventsBound = false;
function setupAnalyticsEventListeners() {
  if (analyticsEventsBound) return;
  analyticsEventsBound = true;
  
  // Main Menu clicks
  const mainCards = document.querySelectorAll('#analytics-menu-main .analytics-card');
  mainCards.forEach(card => {
    card.addEventListener('click', () => {
      const action = card.getAttribute('data-action');
      
      if (action === 'weight') {
        analyticsState.clickedCard = card;
        loadAnalyticsDataView('weight', 'Weight');
      } else if (action === 'muscles') {
        switchSubMenu('analytics-menu-main', 'analytics-menu-muscles');
        const viewContainer = document.getElementById('analytics-view');
        if (viewContainer) {
          viewContainer.classList.remove('state-selection-main');
          viewContainer.classList.add('state-selection-sub');
        }
      } else if (action === 'exercises') {
        switchSubMenu('analytics-menu-main', 'analytics-menu-exercises');
        renderAnalyticsExercisesList('');
        const viewContainer = document.getElementById('analytics-view');
        if (viewContainer) {
          viewContainer.classList.remove('state-selection-main');
          viewContainer.classList.add('state-selection-sub');
        }
      }
    });
  });
  
  // Back from Muscle Groups to Main
  const muscleBack = document.querySelector('#analytics-menu-muscles .btn-analytics-back');
  muscleBack.addEventListener('click', () => {
    switchSubMenu('analytics-menu-muscles', 'analytics-menu-main');
    const viewContainer = document.getElementById('analytics-view');
    if (viewContainer) {
      viewContainer.classList.remove('state-selection-sub');
      viewContainer.classList.add('state-selection-main');
    }
  });
  
  // Back from Exercises to Main
  const exerciseBack = document.querySelector('#analytics-menu-exercises .btn-analytics-back');
  exerciseBack.addEventListener('click', () => {
    switchSubMenu('analytics-menu-exercises', 'analytics-menu-main');
    const viewContainer = document.getElementById('analytics-view');
    if (viewContainer) {
      viewContainer.classList.remove('state-selection-sub');
      viewContainer.classList.add('state-selection-main');
    }
  });
  
  // Muscle Group sub-selection click
  const muscleCards = document.querySelectorAll('#analytics-menu-muscles .analytics-card');
  muscleCards.forEach(card => {
    card.addEventListener('click', () => {
      const group = card.getAttribute('data-muscle');
      analyticsState.clickedCard = card;
      loadAnalyticsDataView('muscle', group);
    });
  });
  
  // Exercise search input filter
  const searchInput = document.getElementById('analytics-exercise-search');
  searchInput.addEventListener('input', () => {
    renderAnalyticsExercisesList(searchInput.value);
  });
  
  // Back from State B data view to State A selector
  document.getElementById('btn-back-to-selector').addEventListener('click', () => {
    const viewContainer = document.getElementById('analytics-view');
    
    // Recalculate/empty the chart card
    renderAnalyticsChart([]);
    const logsList = document.getElementById('analytics-logs-list');
    if (logsList) logsList.innerHTML = '';
    
    // Remove morph and collapse classes
    document.querySelectorAll('.clicked-morph').forEach(el => el.classList.remove('clicked-morph'));
    document.querySelectorAll('.fade-collapse').forEach(el => el.classList.remove('fade-collapse'));
    analyticsState.clickedCard = null;
    analyticsState.finalWidth = null;
    analyticsState.finalHeight = null;
    
    const menuMain = document.getElementById('analytics-menu-main');
    const menuMuscles = document.getElementById('analytics-menu-muscles');
    const menuExercises = document.getElementById('analytics-menu-exercises');
    
    if (menuMain && menuMuscles && menuExercises) {
      menuMain.style.display = 'none';
      menuMain.style.opacity = '0';
      menuMuscles.style.display = 'none';
      menuMuscles.style.opacity = '0';
      menuExercises.style.display = 'none';
      menuExercises.style.opacity = '0';
    }
    
    // Return to the sub-menu we came from and restore headers
    if (analyticsState.currentMetricType === 'weight') {
      if (viewContainer) {
        viewContainer.classList.remove('state-detail', 'state-selection-sub');
        viewContainer.classList.add('state-selection-main');
      }
      if (menuMain) {
        menuMain.style.display = 'flex';
        void menuMain.offsetWidth;
        menuMain.style.transition = 'opacity 0.2s ease-in-out';
        menuMain.style.opacity = '1';
      }
    } else if (analyticsState.currentMetricType === 'muscle') {
      if (viewContainer) {
        viewContainer.classList.remove('state-detail', 'state-selection-main');
        viewContainer.classList.add('state-selection-sub');
      }
      if (menuMuscles) {
        menuMuscles.style.display = 'flex';
        void menuMuscles.offsetWidth;
        menuMuscles.style.transition = 'opacity 0.2s ease-in-out';
        menuMuscles.style.opacity = '1';
      }
    } else if (analyticsState.currentMetricType === 'exercise') {
      if (viewContainer) {
        viewContainer.classList.remove('state-detail', 'state-selection-main');
        viewContainer.classList.add('state-selection-sub');
      }
      if (menuExercises) {
        menuExercises.style.display = 'flex';
        void menuExercises.offsetWidth;
        menuExercises.style.transition = 'opacity 0.2s ease-in-out';
        menuExercises.style.opacity = '1';
      }
    }
  });
  
  // Date Pill Buttons listeners
  const dateButtons = document.querySelectorAll('.date-pill-btn');
  dateButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const range = btn.getAttribute('data-range');
      updateAnalyticsDateSlider(range);
    });
  });

  // Exclude Notes Checkbox listener
  const excludeNotesCheckbox = document.getElementById('analytics-exclude-notes');
  if (excludeNotesCheckbox) {
    excludeNotesCheckbox.addEventListener('change', (e) => {
      analyticsState.excludeNotes = e.target.checked;
      const processedData = processAnalyticsData();
      renderAnalyticsChart(processedData);
      renderAnalyticsLogsList(processedData);
    });
  }

  // Analytics Info Dialog Close listener
  const closeInfoBtn = document.getElementById('btn-close-analytics-info');
  const infoDialog = document.getElementById('analytics-info-dialog');
  if (closeInfoBtn && infoDialog) {
    closeInfoBtn.addEventListener('click', () => {
      infoDialog.close();
    });
  }
}

// Render dynamic exercise selection list in selector
function getExercisePrimaryMuscleGroup(name) {
  const rawTags = getExerciseTarget(name) || '';
  const muscles = rawTags.split(/[,\/]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
  if (muscles.length === 0) return 'Other';
  
  const primary = muscles[0];
  const groups = ['Legs', 'Back', 'Chest', 'Shoulders', 'Arms'];
  for (const g of groups) {
    if (belongsToGroup(primary, g)) {
      return g;
    }
  }
  
  const secondary = muscles[1] || '';
  if (secondary) {
    for (const g of groups) {
      if (belongsToGroup(secondary, g)) {
        return g;
      }
    }
  }
  
  return 'Other';
}

function renderAnalyticsExercisesList(searchTerm) {
  const container = document.getElementById('analytics-exercise-list');
  if (!container) return;
  container.innerHTML = '';
  
  const term = searchTerm.trim().toLowerCase();
  
  // Gather all unique exercises that exist in history logs or registry
  const uniqueExercises = new Set();
  
  // From History
  for (const date in state.history) {
    state.history[date].exercises.forEach(ex => {
      uniqueExercises.add(ex.name);
    });
  }
  
  // From Registry
  for (const name in state.exerciseRegistry) {
    uniqueExercises.add(name);
  }
  
  const sortedExercises = Array.from(uniqueExercises).sort();
  
  // Group by muscle group
  const groups = {
    'Legs': [],
    'Back': [],
    'Chest': [],
    'Shoulders': [],
    'Arms': [],
    'Other': []
  };
  
  sortedExercises.forEach(name => {
    const reg = state.exerciseRegistry[name] || { muscle_tags: 'Other' };
    
    if (term && !name.toLowerCase().includes(term) && !reg.muscle_tags.toLowerCase().includes(term)) {
      return;
    }
    
    const groupName = getExercisePrimaryMuscleGroup(name);
    groups[groupName].push({ name, reg });
  });
  
  let count = 0;
  const order = ['Legs', 'Back', 'Chest', 'Shoulders', 'Arms', 'Other'];
  order.forEach(groupName => {
    const list = groups[groupName];
    if (list.length === 0) return;
    
    // Header for muscle group section
    const header = document.createElement('div');
    header.style.cssText = 'font-size:11px; font-weight:700; color:var(--accent-lavender); text-transform:uppercase; letter-spacing:0.5px; margin-top:14px; margin-bottom:8px; text-align:left; padding-left:4px;';
    header.textContent = groupName;
    container.appendChild(header);
    
    list.forEach(item => {
      const card = document.createElement('div');
      card.className = 'analytics-card';
      card.style.cssText = 'padding:12px; margin-bottom:6px; cursor:pointer;';
      card.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:2px; text-align:left;">
          <span style="font-size:13px; font-weight:600; color:var(--text-primary);">${item.name}</span>
          <span style="font-size:11px; color:var(--text-muted);">${item.reg.muscle_tags}</span>
        </div>
        <span class="chevron">▶</span>
      `;
      
      card.addEventListener('click', () => {
        analyticsState.clickedCard = card;
        loadAnalyticsDataView('exercise', item.name);
      });
      
      container.appendChild(card);
      count++;
    });
  });
  
  if (count === 0) {
    container.innerHTML = `<div style="text-align:center; padding:20px; color:var(--text-muted); font-size:13px;">No matching exercises found.</div>`;
  }
}

// -------------------------------------------------------------
// Mid-Workout Inject Exercise Module
// -------------------------------------------------------------
function setupWorkoutAddExerciseListeners() {
  const btnAdd = document.getElementById('btn-workout-add-exercise');
  if (btnAdd) {
    btnAdd.addEventListener('click', () => {
      const activeWorkout = state.activeWorkout;
      if (!activeWorkout || !activeWorkout.isActive) return;

      document.getElementById('workout-add-search-input').value = '';
      renderWorkoutAddList('');

      const modal = document.getElementById('workout-add-exercise-modal');
      if (modal) modal.showModal();
    });
  }

  const searchInput = document.getElementById('workout-add-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      renderWorkoutAddList(searchInput.value);
    });
  }

  const btnClose = document.getElementById('btn-close-workout-add-modal');
  if (btnClose) {
    btnClose.addEventListener('click', () => {
      document.getElementById('workout-add-exercise-modal').close();
    });
  }

  const modal = document.getElementById('workout-add-exercise-modal');
  if (modal) enableLightDismiss(modal);
}

function renderWorkoutAddList(searchTerm) {
  const highSimList = document.getElementById('workout-add-high-similarity-list');
  const alphaList = document.getElementById('workout-add-alphabetical-list');
  if (!highSimList || !alphaList) return;

  highSimList.innerHTML = '';
  alphaList.innerHTML = '';

  const term = searchTerm.trim().toLowerCase();
  const currentExNames = (state.activeWorkout.exercises || []).map(e => e.name);

  const dayLabel = state.activeWorkout.dayLabel || '';
  const typicalTargets = WORKOUT_TYPICAL_TARGETS[dayLabel] || '';

  const candidates = [];
  for (const name in state.exerciseRegistry) {
    if (currentExNames.includes(name)) continue;

    if (term && !name.toLowerCase().includes(term) && !state.exerciseRegistry[name].muscle_tags.toLowerCase().includes(term)) {
      continue;
    }

    const candidateObj = state.exerciseRegistry[name];
    const score = getWorkoutSimilarityScore(typicalTargets, candidateObj);
    candidates.push({ name, ...candidateObj, score });
  }

  const highSimCandidates = candidates
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    
  const alphaCandidates = candidates
    .filter(c => c.score === 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  const highSimSection = document.getElementById('workout-add-high-similarity-section');
  if (highSimCandidates.length > 0) {
    highSimSection.style.display = 'flex';
    highSimCandidates.forEach(cand => {
      highSimList.appendChild(createWorkoutAddRow(cand));
    });
  } else {
    highSimSection.style.display = 'none';
  }

  const alphaDivider = document.getElementById('workout-add-alphabetical-divider');
  if (alphaCandidates.length > 0) {
    alphaDivider.style.display = 'flex';
    alphaCandidates.forEach(cand => {
      alphaList.appendChild(createWorkoutAddRow(cand));
    });
  } else {
    alphaDivider.style.display = 'none';
  }
}

function createWorkoutAddRow(cand) {
  const row = document.createElement('div');
  row.className = 'substitution-row';
  row.style.cssText = 'display:flex; flex-direction:column; border:1px solid var(--border-glass); border-radius:12px; background:rgba(255,255,255,0.02); overflow:hidden; transition:all 0.3s; margin-bottom:6px;';

  const header = document.createElement('div');
  header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:12px; cursor:pointer;';
  
  const tagClass = cand.default_tag.toLowerCase();
  header.innerHTML = `
    <div style="display:flex; flex-direction:column; gap:2px; text-align:left;">
      <span style="font-size:14px; font-weight:600; color:var(--text-primary);">${cand.name}</span>
      <span style="font-size:11px; color:var(--text-muted);">${cand.muscle_tags}</span>
    </div>
    <span class="tag-badge ${tagClass}" style="text-transform:uppercase;">${cand.default_tag}</span>
  `;

  const expansion = document.createElement('div');
  expansion.style.cssText = 'display:none; flex-direction:column; gap:10px; padding:0 12px 12px 12px; border-top:1px solid rgba(255,255,255,0.05); background:rgba(255,255,255,0.01);';
  expansion.innerHTML = `
    <div style="font-size:11px; font-weight:600; color:var(--text-muted); margin-top:8px; text-align:left;">Choose intensity protocol</div>
    <div class="protocol-slider-container" style="position:relative; display:flex; height:32px; background:rgba(0,0,0,0.2); border:1px solid var(--border-glass); border-radius:16px; overflow:hidden; padding:2px;">
      <div class="slider-thumb" style="position:absolute; top:2px; bottom:2px; left:2px; width:calc(33.33% - 2px); border-radius:14px; transition:transform 0.3s cubic-bezier(0.25, 1, 0.5, 1); pointer-events:none;"></div>
      <button type="button" class="protocol-btn" data-tag="HC" style="flex:1; background:none; border:none; font-family:inherit; font-size:11px; font-weight:700; z-index:2; cursor:pointer; transition:color 0.2s;">HC</button>
      <button type="button" class="protocol-btn" data-tag="LLP" style="flex:1; background:none; border:none; font-family:inherit; font-size:11px; font-weight:700; z-index:2; cursor:pointer; transition:color 0.2s;">LLP</button>
      <button type="button" class="protocol-btn" data-tag="Base" style="flex:1; background:none; border:none; font-family:inherit; font-size:11px; font-weight:700; z-index:2; cursor:pointer; transition:color 0.2s;">Base</button>
    </div>
    <button type="button" class="btn btn-confirm-workout-add-ex" style="width:100%; padding:8px; font-size:12px; font-weight:700; margin-top:4px;">Add Exercise</button>
  `;

  row.appendChild(header);
  row.appendChild(expansion);

  let selectedTag = cand.default_tag;

  header.addEventListener('click', () => {
    const modal = document.getElementById('workout-add-exercise-modal');
    modal.querySelectorAll('.substitution-row').forEach(otherRow => {
      if (otherRow !== row) {
        const otherExpansion = otherRow.querySelector('div:nth-child(2)');
        if (otherExpansion) otherExpansion.style.display = 'none';
      }
    });

    const isExpanded = expansion.style.display === 'flex';
    expansion.style.display = isExpanded ? 'none' : 'flex';
    if (!isExpanded) {
      updateSliderPosition(expansion, selectedTag);
    }
  });

  const sliderButtons = expansion.querySelectorAll('.protocol-btn');
  sliderButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      selectedTag = btn.getAttribute('data-tag');
      updateSliderPosition(expansion, selectedTag);
    });
  });

  const confirmBtn = expansion.querySelector('.btn-confirm-workout-add-ex');
  confirmBtn.addEventListener('click', (e) => {
    e.stopPropagation();

    const activeDate = state.activeWorkout.date;
    const prevStats = getPreviousExerciseStats(cand.name, activeDate);
    const setsCount = getSetsForTag(selectedTag);

    const data = [];
    for (let i = 0; i < setsCount; i++) {
      const defaultRir = isFailureSet(selectedTag, i) ? '0' : '';
      data.push({
        weight: prevStats ? prevStats.weight.toString() : '',
        reps: prevStats ? Math.round(prevStats.reps).toString() : '',
        rir: defaultRir
      });
    }

    const newEx = {
      name: cand.name,
      tag: selectedTag,
      target: cand.muscle_tags || 'Other',
      sets: setsCount,
      workoutNote: '',
      setData: data
    };

    state.activeWorkout.exercises.push(newEx);
    saveActiveWorkoutState();
    renderActiveCard();

    document.getElementById('workout-add-exercise-modal').close();
  });

  return row;
}


