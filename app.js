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

// -------------------------------------------------------------
// Initialization & Routing Engine
// -------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  initPWA();
  loadStateFromStorage();
  setupEventListeners();
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
  if (tag) {
    if (state.auth.mode === 'guest') {
      tag.textContent = 'Guest Mode (Demo)';
      tag.style.background = 'rgba(252, 163, 17, 0.15)';
      tag.style.color = 'var(--accent-gold)';
      document.getElementById('guest-banner').style.display = 'block';
    } else {
      tag.textContent = 'Active Lifter';
      tag.style.background = 'rgba(6, 214, 160, 0.1)';
      tag.style.color = 'var(--accent-mint)';
      document.getElementById('guest-banner').style.display = 'none';
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
    document.getElementById('password-input').focus();
  });
  
  document.getElementById('btn-login-back').addEventListener('click', () => {
    document.getElementById('auth-form').classList.remove('active');
    document.querySelector('.login-choices').style.display = 'flex';
  });

  document.getElementById('login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const pw = document.getElementById('password-input').value;
    const authCard = document.getElementById('auth-form');
    
    if (pw === 'aplift') {
      state.auth = { loggedIn: true, mode: 'user' };
      localStorage.setItem(KEYS.SESSION, JSON.stringify(state.auth));
      
      // Load user data now that authenticated
      loadStateFromStorage();
      
      showView('dashboard-view');
      initDashboard();
    } else {
      // Trigger CSS shake animation on validation fail
      authCard.classList.remove('shake');
      void authCard.offsetWidth; // Trigger reflow
      authCard.classList.add('shake');
      
      // Reset input field
      document.getElementById('password-input').value = '';
    }
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
    document.getElementById('password-input').value = '';
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
    
    // Reset inputs
    document.getElementById('password-input').value = '';
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
      
      document.getElementById('password-input').value = '';
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

  // Swap Dropdown Listener
  document.getElementById('swap-select').addEventListener('change', (e) => {
    handleSwapTemplateChange(e.target.value);
  });

  // Card view navigator
  document.getElementById('btn-prev-exercise').addEventListener('click', () => {
    if (state.activeWorkout.currentExerciseIndex > 0) {
      state.activeWorkout.currentExerciseIndex--;
      saveActiveWorkoutState();
      showView('workout-view', 'backward');
      renderActiveCard();
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

  // Input accessory buttons listeners
  document.getElementById('btn-accessory-prev').addEventListener('click', () => {
    focusAdjacentInput(-1);
  });
  document.getElementById('btn-accessory-next').addEventListener('click', () => {
    focusAdjacentInput(1);
  });
  document.getElementById('btn-accessory-done').addEventListener('click', () => {
    const activeEl = document.activeElement;
    if (activeEl) activeEl.blur();
  });
}

// -------------------------------------------------------------
// 2. Date Utilities & Week Swap Controller
// -------------------------------------------------------------
function getLocalDateString(date = new Date()) {
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

// Get templates assigned for a date, resolving custom swaps
function getAssignedTemplateDay(dateStr) {
  const dateObj = new Date(dateStr + 'T00:00:00');
  const dayName = WEEKDAYS[dateObj.getDay()];
  const weekId = getWeekMonday(dateStr);

  const weekSwapMap = state.weekSwaps[weekId];
  if (weekSwapMap && weekSwapMap[dayName]) {
    return weekSwapMap[dayName]; // Returns swapped template day (e.g. Saturday)
  }
  return dayName; // Defaults to normal week day
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

  // Set visual label details
  labelEl.textContent = routine.isRest ? 'Rest Day' : routine.label;
  
  if (routine.isRest) {
    exercisesEl.textContent = 'Enjoy your rest day! Recover well.';
    startBtn.style.display = 'none';
  } else {
    const list = routine.exercises.map(ex => ex.name).join(', ');
    exercisesEl.textContent = list;
    startBtn.style.display = 'block';
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
  dayNamesOrder.forEach(day => {
    const info = config[day];
    const option = document.createElement('option');
    option.value = day;
    
    const label = info.isRest ? `${day} (Rest Day)` : `${day} (${info.label})`;
    option.textContent = label;

    // Select today's current mapped template
    if (day === templateDay) {
      option.selected = true;
    }

    // Disable if completed, EXCEPT if it's currently selected (completed but assigned here)
    if (completedTemplates.has(day) && day !== templateDay) {
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
function handleSwapTemplateChange(selectedTemplateDay) {
  const todayStr = getLocalDateString();
  const dateObj = new Date(todayStr + 'T00:00:00');
  const todayDayName = WEEKDAYS[dateObj.getDay()];
  const weekId = getWeekMonday(todayStr);

  // Initialize mapping if empty
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

  // Find template day originally assigned to today (before the new swap)
  const currentTemplate = currentSwaps[todayDayName]; // e.g. Thursday (originally Rest)

  // Find which weekday is currently mapping to the selected template day
  let weekdayToSwap = '';
  for (const [day, temp] of Object.entries(currentSwaps)) {
    if (temp === selectedTemplateDay) {
      weekdayToSwap = day;
      break;
    }
  }

  if (weekdayToSwap) {
    // Perform Reciprocal swap
    currentSwaps[todayDayName] = selectedTemplateDay;
    currentSwaps[weekdayToSwap] = currentTemplate;
    
    // Save state
    if (state.auth.mode === 'user') {
      localStorage.setItem(KEYS.WEEK_SWAPS, JSON.stringify(state.weekSwaps));
    }
    
    // Redraw
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
  const nextMonthCells = 42 - totalCells; // Standard 6-row grid
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
    localStorage.setItem(KEYS.ACTIVE_WORKOUT, JSON.stringify(state.activeWorkout));
  }
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

  prevBtn.disabled = index === 0;

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
  } else if (element.classList.contains('val-reps')) {
    set.reps = element.value;
  } else if (element.classList.contains('val-rir')) {
    set.rir = element.value;
  }

  saveActiveWorkoutState();
}

let accessoryBarTimer = null;

function handleInputFocus(inputElement) {
  // Clear hide timers for bar
  if (accessoryBarTimer) clearTimeout(accessoryBarTimer);

  const bar = document.getElementById('keyboard-accessory');
  bar.classList.add('active');

  // Dynamic Scroll centering to keep inputs above viewport safe areas
  // Wait short delay for iOS softkeyboard layout transition
  setTimeout(() => {
    inputElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 100);
}

function handleInputBlur() {
  // Use short delay to prevent bar blinking during tab jumps
  accessoryBarTimer = setTimeout(() => {
    const bar = document.getElementById('keyboard-accessory');
    bar.classList.remove('active');
  }, 150);
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

// -------------------------------------------------------------
// 5. Conclude Workout Session & Webhook Pipeline
// -------------------------------------------------------------
async function concludeWorkoutSession() {
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
    alert("Guest Mode Sandbox: Mock sync fired. Data not permanently recorded.");
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
        exercise: ex.name,
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
      body: JSON.stringify({
        action: 'log_workout',
        payload: rows
      })
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
  let csvContent = "Date,Day Label,Exercise Name,Set Number,Tag,Weight (kg),Reps,Reps In Reserve (RIR)\n";

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
