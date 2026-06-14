import { getRoutineConfig, saveRoutineConfig, getWebhookUrl, saveWebhookUrl } from './config.js';

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
        .then(reg => console.log('Service Worker registered successfully.', reg.scope))
        .catch(err => console.error('Service Worker registration failed.', err));
    });
  }
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
          state.exerciseRegistry[ex.name] = {
            notes: '',
            muscle_tags: ex.target || '',
            default_tag: ex.tag || 'Base'
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
  // Login Panel
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

  document.getElementById('btn-save-routine').addEventListener('click', () => {
    saveRoutineFromEditor();
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

  // Swap Dropdown visibility controller
  document.getElementById('swap-select').addEventListener('change', (e) => {
    const todayStr = getLocalDateString();
    const currentTemplate = getAssignedTemplateDay(todayStr);
    const swapBtn = document.getElementById('btn-swap-workout');
    if (e.target.value !== currentTemplate) {
      swapBtn.style.display = 'block';
    } else {
      swapBtn.style.display = 'none';
    }
  });

  // Swap Button Action
  document.getElementById('btn-swap-workout').addEventListener('click', () => {
    handleSwapButtonClick();
  });

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
  const templateDay = getAssignedTemplateDay(dateStr);
  const config = getRoutineConfig();
  const routine = config[templateDay];
  
  const labelEl = document.getElementById('today-routine-label');
  const exercisesEl = document.getElementById('today-routine-exercises');
  const swapSelect = document.getElementById('swap-select');
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
    swapSelect.disabled = true;
  } else {
    startBtn.textContent = 'Start Workout';
    swapSelect.disabled = false;
    if (routine.isRest) {
      exercisesEl.textContent = 'Enjoy your rest day! Recover well.';
      startBtn.style.display = 'none';
    } else {
      const list = routine.exercises.map(ex => ex.name).join(', ');
      exercisesEl.textContent = list;
      startBtn.style.display = 'block';
    }
  }

  // Populate Swaps Dropdown
  swapSelect.innerHTML = '';
  
  const weekId = getWeekMonday(dateStr);
  const weekDays = getWeekDaysList(weekId);
  
  // Repetition prevention: identify templates completed in the current week
  const completedTemplates = new Set();
  weekDays.forEach(wd => {
    const log = state.history[wd.dateStr];
    if (log && log.templateDay) {
      completedTemplates.add(log.templateDay);
    }
  });

  const dayNamesOrder = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  dayNamesOrder.forEach(dayName => {
    // Resolve what template is assigned to this dayName
    const assignedTemplate = getTemplateDayForWeekday(dayName, weekId);
    const info = config[assignedTemplate];
    const option = document.createElement('option');
    // The value represents the template day to swap to
    option.value = assignedTemplate;
    
    const label = info.isRest ? `${dayName} (Rest Day)` : `${dayName} (${info.label})`;
    option.textContent = label;

    // Select today's current mapped template
    if (assignedTemplate === templateDay) {
      option.selected = true;
    }

    // Disable if completed, EXCEPT if it's currently selected, it's a Rest Day, or today is a Rest Day
    const todayInfo = config[templateDay];
    if (completedTemplates.has(assignedTemplate) && 
        assignedTemplate !== templateDay && 
        !info.isRest && 
        (!todayInfo || !todayInfo.isRest)) {
      option.disabled = true;
      option.textContent += ' [Completed]';
    }

    swapSelect.appendChild(option);
  });
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

// Dynamic Reciprocal Swap Handler
async function handleSwapButtonClick() {
  const swapSelect = document.getElementById('swap-select');
  const swapBtn = document.getElementById('btn-swap-workout');
  const selectedTemplate = swapSelect.value;
  
  // 1. Show loading state
  swapBtn.disabled = true;
  const originalHtml = swapBtn.innerHTML;
  swapBtn.innerHTML = `<span class="spinner-icon">⏳</span> Swapping...`;
  
  // Simulated delay for loading presentation
  await new Promise(resolve => setTimeout(resolve, 600));
  
  // 2. Validate swap
  const todayStr = getLocalDateString();
  const dateObj = new Date(todayStr + 'T00:00:00');
  const todayDayName = WEEKDAYS[dateObj.getDay()];
  const weekId = getWeekMonday(todayStr);
  const currentTemplate = getAssignedTemplateDay(todayStr);
  
  // Check if today's workout was already logged in history
  if (state.history[todayStr]) {
    showSwapBanner("Swap invalid: Today's workout has already been completed.", true);
    swapBtn.disabled = false;
    swapBtn.innerHTML = originalHtml;
    return;
  }
  
  const config = getRoutineConfig();
  
  // Check if same template
  if (selectedTemplate === currentTemplate) {
    showSwapBanner("Swap invalid: Today is already assigned to this template.", true);
    swapBtn.disabled = false;
    swapBtn.innerHTML = originalHtml;
    return;
  }
  
  // Check if selected template was already completed this week on another day
  const weekDays = getWeekDaysList(weekId);
  const completedTemplates = new Set();
  weekDays.forEach(wd => {
    const log = state.history[wd.dateStr];
    if (log && log.templateDay) {
      completedTemplates.add(log.templateDay);
    }
  });
  const currentTemplateInfo = config[currentTemplate];
  const selectedTemplateInfo = config[selectedTemplate];
  if (completedTemplates.has(selectedTemplate) && 
      !selectedTemplateInfo.isRest && 
      (!currentTemplateInfo || !currentTemplateInfo.isRest)) {
    showSwapBanner("Swap invalid: This template has already been completed this week.", true);
    swapBtn.disabled = false;
    swapBtn.innerHTML = originalHtml;
    return;
  }
  
  // 3. Perform reciprocal swap
  executeSwap(todayDayName, selectedTemplate, weekId);
  
  // 4. Success banner and hide button
  showSwapBanner("Swap completed!", false);
  swapBtn.disabled = false;
  swapBtn.innerHTML = originalHtml;
  swapBtn.style.display = 'none';
}

function showSwapBanner(message, isError) {
  const banner = document.getElementById('swap-status-banner');
  if (banner) {
    banner.textContent = message;
    banner.className = `status-banner ${isError ? 'error' : 'success'}`;
    banner.style.display = 'block';
    
    if (window.swapBannerTimeout) clearTimeout(window.swapBannerTimeout);
    
    window.swapBannerTimeout = setTimeout(() => {
      banner.style.display = 'none';
    }, 4000);
  }
}

function executeSwap(todayDayName, selectedTemplateDay, weekId) {
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

  const currentSwaps = state.weekSwaps[weekId];

  // 1. Undo any existing swap that todayDayName is currently involved in
  const currentTemplateForToday = currentSwaps[todayDayName];
  if (currentTemplateForToday !== todayDayName) {
    let dayHoldingTodayTemplate = '';
    for (const [day, temp] of Object.entries(currentSwaps)) {
      if (temp === todayDayName) {
        dayHoldingTodayTemplate = day;
        break;
      }
    }
    if (dayHoldingTodayTemplate) {
      currentSwaps[todayDayName] = todayDayName;
      currentSwaps[dayHoldingTodayTemplate] = dayHoldingTodayTemplate;
    }
  }

  // 2. Perform the new swap: swap todayDayName with the day currently holding selectedTemplateDay
  const currentTemplate = currentSwaps[todayDayName]; // which is now todayDayName

  let weekdayToSwap = '';
  for (const [day, temp] of Object.entries(currentSwaps)) {
    if (temp === selectedTemplateDay) {
      weekdayToSwap = day;
      break;
    }
  }

  if (weekdayToSwap) {
    currentSwaps[todayDayName] = selectedTemplateDay;
    currentSwaps[weekdayToSwap] = currentTemplate;
    
    if (state.auth.mode === 'user') {
      localStorage.setItem(KEYS.WEEK_SWAPS, JSON.stringify(state.weekSwaps));
    }
    
    const todayStr = getLocalDateString();
    renderTodayRoutineDetails(todayStr);
    renderCalendar();
  }
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
  const config = getRoutineConfig();
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
    sessionNoteEl.value = wk.workoutNote || '';
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
      statusDiv.textContent = '✅ Sync Successful! Test row appended to Google Sheet.';
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
      statusDiv.textContent = '⚠️ Dispatched (opaque mode). Please verify your Google Sheet!';
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
    workoutNote: wk.workoutNote || '',
    exercises: wk.exercises.map(ex => ({
      name: ex.name,
      tag: ex.tag,
      target: ex.target,
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

  if (!record.exercises || record.exercises.length === 0) {
    return; // Do not log rest days to the Google Sheet
  }

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
        rir: set.rir
      });
    });
  });

  const transactionLogsPayload = logsMatrix.map((set, index) => {
    return {
      date: record.date,
      day_label: record.dayLabel,
      exercise_name: set.exercise_name,
      set_number: set.set_number,
      tag: set.tag,
      weight: set.weight,
      reps: set.reps,
      rir: set.rir,
      workout_note: (index === 0) ? (state.activeWorkout.workoutNote || "") : ""
    };
  });

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
    const response = await fetch(webhookUrl, {
      method: 'POST',
      mode: 'cors',
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
    } else {
      throw new Error("Invalid response format received from Google Sheet.");
    }
    
    // Restore weight history
    const reconstructedWeights = {};
    weightRows.forEach(row => {
      if (row.date && row.weight !== undefined && row.weight !== null) {
        // Handle timezone safe local parsing
        let parsedDate = row.date;
        if (typeof parsedDate === 'string' && parsedDate.includes('T')) {
          parsedDate = parsedDate.split('T')[0];
        }
        const d = new Date(parsedDate + 'T00:00:00');
        if (!isNaN(d.getTime())) {
          const year = d.getFullYear();
          const month = String(d.getMonth() + 1).padStart(2, '0');
          const day = String(d.getDate()).padStart(2, '0');
          const date = `${year}-${month}-${day}`;
          reconstructedWeights[date] = parseFloat(row.weight);
        }
      }
    });
    state.weightHistory = reconstructedWeights;
    localStorage.setItem(KEYS.WEIGHT_HISTORY, JSON.stringify(state.weightHistory));
    
    // Restore exercise metadata registry
    if (exerciseRows.length > 0) {
      const reconstructedRegistry = {};
      exerciseRows.forEach(row => {
        if (row.exercise_name) {
          reconstructedRegistry[row.exercise_name] = {
            notes: row.exercise_notes || '',
            muscle_tags: row.muscle_tags || '',
            default_tag: row.default_tag || 'Base'
          };
        }
      });
      state.exerciseRegistry = reconstructedRegistry;
      localStorage.setItem(KEYS.EXERCISE_REGISTRY, JSON.stringify(state.exerciseRegistry));
    }
    
    // Reconstruct history object
    const reconstructed = {};
    workoutRows.forEach(row => {
      // Skip connection verification test logs
      if (row.dayLabel === 'Test Connection' || !row.date || row.date === 'undefined') {
        return;
      }
      
      const d = new Date(row.date);
      if (isNaN(d.getTime())) {
        console.warn(`Skipping invalid date: "${row.date}"`);
        return;
      }
      
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const date = `${year}-${month}-${day}`;
      
      if (!reconstructed[date]) {
        reconstructed[date] = {
          date: date,
          dayLabel: row.dayLabel,
          templateDay: '',
          elapsedTime: row.workoutTime || '00:00',
          workoutNote: '',
          exercises: []
        };
      }
      
      if (row.workoutNote || row.workout_note) {
        reconstructed[date].workoutNote = row.workoutNote || row.workout_note;
      }
      
      if (row.exerciseName === 'Rest Day' && !row.setNumber) {
        return;
      }
      
      let ex = reconstructed[date].exercises.find(e => e.name === row.exerciseName);
      if (!ex) {
        ex = {
          name: row.exerciseName,
          tag: row.tag || '',
          target: '',
          setData: []
        };
        reconstructed[date].exercises.push(ex);
      }
      
      const setIndex = parseInt(row.setNumber) - 1;
      if (!isNaN(setIndex) && setIndex >= 0) {
        ex.setData[setIndex] = {
          weight: row.weight || '0',
          reps: row.reps || '0',
          rir: row.rir || '0'
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
  const config = getRoutineConfig();
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
      const config = getRoutineConfig();
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
      state.activeWorkout.workoutNote = e.target.value;
      saveActiveWorkoutState();
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
          workoutNote: workout.workoutNote || ''
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
