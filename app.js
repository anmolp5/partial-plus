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
    editDate: ''           // YYYY-MM-DD if editing history
  },
  history: {},             // Map of YYYY-MM-DD -> completed workout object
  weekSwaps: {}            // Map of weekMondayDate -> { weekdayName: templateDayName }
};

// LocalStorage Keys
const KEYS = {
  SESSION: 'partial_plus_session',
  ACTIVE_WORKOUT: 'partial_plus_active_workout',
  HISTORY: 'partial_plus_history',
  WEEK_SWAPS: 'partial_plus_week_swaps'
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
  // TEMP: Clear today's workout for testing
  const tmpH = JSON.parse(localStorage.getItem('partial_plus_history') || '{}');
  const tmpToday = new Date();
  const tmpOffset = tmpToday.getTimezoneOffset();
  const tmpLocal = new Date(tmpToday.getTime() - (tmpOffset*60*1000));
  const tmpDateStr = tmpLocal.toISOString().split('T')[0];
  delete tmpH[tmpDateStr];
  localStorage.setItem('partial_plus_history', JSON.stringify(tmpH));
  // END TEMP

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
  if (tag) {
    if (state.auth.mode === 'guest') {
      tag.textContent = 'Guest Mode';
      tag.style.background = 'rgba(252, 163, 17, 0.15)';
      tag.style.color = 'var(--accent-gold)';
      document.getElementById('guest-banner').style.display = 'block';
      if (configBtn) configBtn.style.display = 'none';
    } else {
      tag.textContent = 'Active Lifter';
      tag.style.background = 'rgba(6, 214, 160, 0.1)';
      tag.style.color = 'var(--accent-mint)';
      document.getElementById('guest-banner').style.display = 'none';
      if (configBtn) configBtn.style.display = 'flex';
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
    // Clear volatile state
    state.history = {};
    state.weekSwaps = {};
    
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
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay(); // 0 (Sun) - 6 (Sat)
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust to Monday
  const monday = new Date(d.setDate(diff));
  return monday.toISOString().split('T')[0];
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
      const list = completedLog.exercises.map(ex => ex.name).join(', ');
      exercisesEl.textContent = list;
    } else {
      exercisesEl.textContent = routine.exercises.map(ex => ex.name).join(', ');
    }
    startBtn.textContent = 'Edit Workout';
    startBtn.style.display = 'block';
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

  // Highlight if workout logged in history
  if (state.history[dateStr]) {
    cell.classList.add('completed');
  }

  // Handle tap log detail display
  cell.addEventListener('click', () => {
    showCalendarDayDetails(dateStr);
  });

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
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  
  const pad = (n) => String(n).padStart(2, '0');
  
  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(hundredths)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}.${pad(hundredths)}`;
}

function handleLapButton() {
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
  document.getElementById('exercise-target').textContent = ex.target;
  
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

  // Footer Navigation Buttons mapping
  const prevBtn = document.getElementById('btn-prev-exercise');
  const nextBtn = document.getElementById('btn-next-exercise');

  if (index === 0) {
    prevBtn.textContent = 'Cancel Workout';
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
  // Stop stopwatch
  stopStopwatch();

  const wk = state.activeWorkout;

  // Structure complete log entry
  const workoutRecord = {
    date: wk.date,
    dayLabel: wk.dayLabel,
    templateDay: wk.templateDay,
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

    // 2. Transmit to Google Sheet Webhook Async
    await transmitWebhookLog(workoutRecord);
    
    // Clear recovery memory
    localStorage.removeItem(KEYS.ACTIVE_WORKOUT);
  } else {
    // Guest Mode - volatile storage
    if (confirm("Workout complete! Guest Mode data is volatile and will clear on refresh.\n\nWould you like to download this workout session as a CSV file?")) {
      downloadSingleWorkoutCSV(workoutRecord);
    }
  }

  // Clear active state properties
  state.activeWorkout = {
    date: '', dayOfWeek: '', dayLabel: '', templateDay: '', exercises: [], isActive: false, currentExerciseIndex: 0, isEditingHistorical: false, editDate: ''
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

  // Format flattened rows for App Script consumption
  const rows = [];
  record.exercises.forEach(ex => {
    ex.setData.forEach((set, i) => {
      rows.push({
        date: record.date,
        dayLabel: record.dayLabel,
        exerciseName: ex.name,
        setNumber: i + 1,
        tag: ex.tag,
        weight: set.weight,
        reps: set.reps,
        rir: set.rir
      });
    });
  });

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      mode: 'no-cors', // Avoids CORS hurdles on static scripts
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(rows)
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
    log.exercises.forEach(ex => {
      const exDiv = document.createElement('div');
      exDiv.classList.add('history-exercise-log');
      
      const setsStr = ex.setData.map((set, i) => `S${i+1}: ${set.weight}kg x ${set.reps} (RIR ${set.rir})`).join(', ');
      
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
  } else {
    // Unrecorded rest day details
    label.style.display = 'none';
    container.innerHTML = `<div style="text-align:center; padding: 20px 0; color: var(--text-muted); font-size: 13px;">No workout records logged for this day.</div>`;
    editBtn.style.display = 'none';
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
