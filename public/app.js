// ===================== Constantes ===================== //
const fireSVG = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.5 11c0 2.5-2.5 4-2.5 4s1-1.5 1-3c0-2-1.5-3-1.5-3s-.5 1-.5 2c0 0-1-1-1.5-2.5C11 7 12 4 12 4s-3 2-4 5c-1 3 1 5 1 5s-1.5-1.5-1.5-3C7 13.5 5 16 5 18c0 3.5 3 6 7 6s7-2.5 7-6c0-2.5-1.5-7-1.5-7z"/></svg>`;

const colorsMap = { 1: 'var(--prio-1)', 2: 'var(--prio-2)', 3: 'var(--prio-3)', 4: 'var(--prio-4)', 5: 'var(--prio-5)' };

function fireBadge(priority) {
  if (!priority) return '';
  const c = colorsMap[priority];
  return `<div class="fire-badge" style="background-color:color-mix(in srgb, ${c} 18%, white); color:${c}">${fireSVG}</div>`;
}

const monthNames = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
const dayNames = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

const ICON_GRID = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>`;
const ICON_LIST = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>`;

const TOKEN_KEY = 'agendaToken';

// ===================== Estado ===================== //
let state = { config: { anchorDate: null, cycleLength: 9 }, specials: {}, tasks: [], projects: [], shopping: { mercado: [], avulso: [] } };
let currentDate = new Date();
let viewMode = localStorage.getItem('agendaViewMode') || 'list';
let currentTab = 'calendar';
let currentFormType = 'special';
let specialTimeTouched = false;
let currentSheetDate = null;
let deferredPrompt = null;

// ===================== Helpers ===================== //
function $(sel) { return document.querySelector(sel); }

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function pad(n) { return String(n).padStart(2, '0'); }

function formatDate(year, month, day) {
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

function formatDateBR(dateStr) {
  const [, m, d] = dateStr.split('-');
  return `${d}/${m}`;
}

function formatDateBRFull(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

function todayISO() {
  const d = new Date();
  return formatDate(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return formatDate(d.getFullYear(), d.getMonth(), d.getDate());
}

window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason && e.reason.message;
  if (msg && msg !== 'unauthorized') alert('Erro: ' + msg);
});

// ===================== Auth / API ===================== //
function getToken() { return localStorage.getItem(TOKEN_KEY); }
function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
function clearToken() { localStorage.removeItem(TOKEN_KEY); }

async function api(path, method = 'GET', body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const token = getToken();
  if (token) opts.headers['Authorization'] = 'Bearer ' + token;

  const res = await fetch(path, opts);
  if (res.status === 401) {
    showLogin();
    throw new Error('unauthorized');
  }
  if (res.status === 204) return null;
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'erro inesperado' }));
    throw new Error(err.error || 'erro inesperado');
  }
  return res.json();
}

function showLogin() {
  clearToken();
  $('#app').classList.add('hidden');
  $('#loginScreen').classList.remove('hidden');
}

function logout() {
  clearToken();
  closeModals();
  location.reload();
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = $('#loginPassword').value;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) throw new Error();
    const { token } = await res.json();
    setToken(token);
    $('#loginError').classList.add('hidden');
    await boot();
  } catch {
    $('#loginError').classList.remove('hidden');
  }
});

async function boot() {
  try {
    state = await api('/api/state');
    $('#loginScreen').classList.add('hidden');
    $('#app').classList.remove('hidden');
    applyViewMode();
    switchTab('calendar');
    if (!state.config.anchorDate) openConfigModal();
    checkDueNotifications();
  } catch (e) {
    if (e.message !== 'unauthorized') console.error(e);
  }
}

// ===================== Ciclo de Escala ===================== //
function getCycleIndex(dateString) {
  const cfg = state.config;
  if (!cfg.anchorDate || !cfg.cycleLength) return -1;
  const anchor = new Date(cfg.anchorDate + 'T00:00:00');
  const target = new Date(dateString + 'T00:00:00');
  const diffDays = Math.floor((target.getTime() - anchor.getTime()) / 86400000);
  return ((diffDays % cfg.cycleLength) + cfg.cycleLength) % cfg.cycleLength;
}

function getShiftInfo(dateString) {
  const idx = getCycleIndex(dateString);
  if (idx === -1) return { label: 'Sem Escala', class: 'shift-folga', type: 'folga', cycleIndex: -1 };
  if (idx === 0) return { label: 'Trabalho (06h-22h)', class: 'shift-dia', type: 'trabalho', cycleIndex: idx };
  return { label: 'Folga', class: 'shift-folga', type: 'folga', cycleIndex: idx };
}

// ===================== Tabs ===================== //
const TABS = ['calendar', 'tasks', 'projects', 'shopping'];
const TAB_TITLES = { tasks: 'Tarefas', projects: 'Projetos', shopping: 'Lista' };

function switchTab(tab) {
  currentTab = tab;
  TABS.forEach((t) => $('#panel-' + t).classList.toggle('hidden', t !== tab));
  document.querySelectorAll('.nav-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tab));

  $('#monthNav').classList.toggle('hidden', tab !== 'calendar');
  $('#tabTitle').classList.toggle('hidden', tab === 'calendar');
  $('#btnViewToggle').classList.toggle('hidden', tab !== 'calendar');
  $('#btnSpecialsList').classList.toggle('hidden', tab !== 'calendar');
  if (TAB_TITLES[tab]) $('#tabTitle').textContent = TAB_TITLES[tab];

  $('#fabBtn').classList.toggle('hidden', tab === 'shopping');

  renderActiveTab(tab === 'calendar');
}

function renderActiveTab(scrollToToday) {
  if (currentTab === 'calendar') renderCalendar(scrollToToday);
  else if (currentTab === 'tasks') renderTasks();
  else if (currentTab === 'projects') renderProjects();
  else if (currentTab === 'shopping') renderShopping();
}

function renderAll() { renderActiveTab(false); }

function toggleCollapse(id) {
  $('#' + id).classList.toggle('collapsed');
  $('#' + id + '-chevron').parentElement.classList.toggle('open');
}

// ===================== FAB ===================== //
function onFabClick() {
  if (currentTab === 'calendar') openAddRecordModal(todayISO(), 'special');
  else if (currentTab === 'tasks') openTaskModal(null, null);
  else if (currentTab === 'projects') openModal('projectModal');
}

// ===================== Modais ===================== //
function openModal(id) { $('#' + id).classList.add('active'); }
function closeModals() { document.querySelectorAll('.modal-overlay').forEach((m) => m.classList.remove('active')); }

function showConfirm(message, onConfirm) {
  $('#confirmMessage').textContent = message;
  const oldBtn = $('#confirmBtn');
  const newBtn = oldBtn.cloneNode(true);
  oldBtn.parentNode.replaceChild(newBtn, oldBtn);
  newBtn.addEventListener('click', onConfirm);
  openModal('confirmModal');
}

// ===================== Calendário ===================== //
function changeMonth(direction) {
  currentDate.setMonth(currentDate.getMonth() + direction);
  renderCalendar();
}

function toggleViewMode() {
  viewMode = viewMode === 'list' ? 'grid' : 'list';
  localStorage.setItem('agendaViewMode', viewMode);
  applyViewMode();
  renderCalendar(true);
}

function applyViewMode() {
  const main = $('#mainContent');
  const iconBtn = $('#btnViewToggle');
  if (viewMode === 'grid') {
    main.classList.add('mode-grid');
    iconBtn.innerHTML = ICON_LIST;
  } else {
    main.classList.remove('mode-grid');
    iconBtn.innerHTML = ICON_GRID;
  }
}

function renderCalendar(scrollToToday) {
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  $('#currentMonthYear').textContent = `${monthNames[month]} ${year}`;
  const today = new Date();
  $('#currentMonthYear').classList.toggle('month-current', year === today.getFullYear() && month === today.getMonth());
  const t = new Date();
  $('#todayBadge').textContent = `Hoje, ${t.getDate()} de ${monthNames[t.getMonth()]}`;

  const calendarEl = $('#calendar');
  calendarEl.innerHTML = '';

  const daysInMonth = new Date(year, month + 1, 0).getDate();

  for (let i = 1; i <= daysInMonth; i++) calendarEl.appendChild(createDayCard(year, month, i, false));

  for (let i = 1; i <= 3; i++) {
    let nextMonth = month + 1;
    let nextYear = year;
    if (nextMonth > 11) { nextMonth = 0; nextYear++; }
    calendarEl.appendChild(createDayCard(nextYear, nextMonth, i, true));
  }

  if (scrollToToday) {
    const todayCard = calendarEl.querySelector('.day-card.is-today');
    if (todayCard) todayCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function shouldShowShiftBadge(dateStr, shift) {
  return !(shift.type === 'folga' && state.specials[dateStr]);
}

function getDayTags(dateStr, shift) {
  const tags = [];
  if (shift.type === 'trabalho') tags.push({ label: 'Trabalho', cls: 'day-tag-dia' });

  if (state.specials[dateStr]) {
    const isEmendando = shift.cycleIndex === 0;
    tags.push({ label: isEmendando ? 'Especial 24h' : 'Especial', cls: 'day-tag-especial' });
  }

  state.tasks
    .filter((t) => t.date === dateStr && !t.done)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
    .forEach((t) => {
      const color = t.priority ? colorsMap[t.priority] : 'var(--text-muted)';
      tags.push({ label: t.title, cls: 'day-tag-task', style: `background-color:color-mix(in srgb, ${color} 18%, white); color:${color}` });
    });

  return tags;
}

function createDayCard(year, month, day, isNextMonth) {
  const dateStr = formatDate(year, month, day);
  const dateObj = new Date(year, month, day);
  const shift = getShiftInfo(dateStr);
  const isToday = dateStr === todayISO();

  const card = document.createElement('div');
  card.className = `day-card ${isNextMonth ? 'next-month' : ''} ${isToday ? 'is-today' : ''}`;

  if (viewMode === 'grid') {
    const tags = getDayTags(dateStr, shift);
    let tagsHtml = '<div class="day-tags">';
    const overflow = tags.length > 5;
    const visibleTags = overflow ? tags.slice(0, 4) : tags;
    visibleTags.forEach((tag) => {
      tagsHtml += `<div class="day-tag ${tag.cls}" style="${tag.style || ''}">${escapeHtml(tag.label)}</div>`;
    });
    if (overflow) tagsHtml += `<div class="day-tag day-tag-more">+${tags.length - 4} eventos</div>`;
    tagsHtml += '</div>';

    card.innerHTML = `
      <div class="day-header"><div class="day-info"><span class="day-number">${pad(day)}</span></div></div>
      ${tagsHtml}
    `;
    card.onclick = () => openDaySheet(dateStr);
    return card;
  }

  let html = `
    <div class="day-header">
      <div class="day-info">
        <span class="day-number">${pad(day)}</span>
        <span class="day-name">${dayNames[dateObj.getDay()]}</span>
      </div>
      ${shouldShowShiftBadge(dateStr, shift) ? `<span class="shift-badge ${shift.class}">${shift.label}</span>` : ''}
    </div>
  `;
  html += renderDayBody(dateStr, shift);
  card.innerHTML = html;
  return card;
}

function renderDayBody(dateStr, shift) {
  let html = '';
  const sp = state.specials[dateStr];
  if (sp) {
    const isEmendando = shift.cycleIndex === 0;
    html += `<div class="special-alert" onclick="openAddRecordForDateDirect('${dateStr}')">ESPECIAL: ${sp.start} às ${sp.end}${isEmendando ? '<span class="emendando-tag">EMENDANDO</span>' : ''}</div>`;
  }

  const dayTasks = state.tasks.filter((t) => t.date === dateStr);
  if (dayTasks.length) {
    html += '<div class="event-list">';
    dayTasks.forEach((t) => {
      const fire = fireBadge(t.priority);
      const actions = t.done
        ? `<button onclick="event.stopPropagation(); reopenTask('${t.id}')">↩ Reabrir</button>`
        : `<button onclick="event.stopPropagation(); completeTask('${t.id}')">✓ Concluir</button>
           <button onclick="event.stopPropagation(); sendToBacklog('${t.id}')">↩ Sem data</button>`;
      html += `
        <div class="event-item ${t.done ? 'done' : ''}">
          ${fire}
          <div class="event-details">
            <span class="event-title">${escapeHtml(t.title)}</span>
            ${t.obs ? `<span class="event-obs">${escapeHtml(t.obs)}</span>` : ''}
          </div>
          <div class="event-actions">${actions}</div>
        </div>
      `;
    });
    html += '</div>';
  }

  return html;
}

function openDaySheet(dateStr) {
  currentSheetDate = dateStr;
  const dateObj = new Date(dateStr + 'T00:00:00');
  const shift = getShiftInfo(dateStr);
  $('#daySheetTitle').textContent = `${dateObj.getDate()} de ${monthNames[dateObj.getMonth()]} - ${dayNames[dateObj.getDay()]}`;

  let html = shouldShowShiftBadge(dateStr, shift) ? `<div class="day-header"><span class="shift-badge ${shift.class}">${shift.label}</span></div>` : '';
  const body = renderDayBody(dateStr, shift);
  html += body || '<p class="confirm-message">Nada registrado neste dia.</p>';

  $('#daySheetBody').innerHTML = html;
  openModal('daySheetModal');
}

function openAddRecordForDay(type) {
  closeModals();
  openAddRecordModal(currentSheetDate, type);
}

function openAddRecordForDateDirect(dateStr) {
  openAddRecordModal(dateStr, 'special');
}

// ===================== Modal: Adicionar Registro ===================== //
function switchFormType(type) {
  currentFormType = type;
  $('#btnTypeSpecial').classList.toggle('active', type === 'special');
  $('#btnTypeTask').classList.toggle('active', type === 'task');
  $('#formSpecial').classList.toggle('hidden', type !== 'special');
  $('#formTask').classList.toggle('hidden', type !== 'task');
  checkEmendandoAutoFill();
}

function checkEmendandoAutoFill() {
  const dateStr = $('#inputDate').value;
  const aviso = $('#emendandoAviso');
  if (!dateStr || !state.config.anchorDate) { aviso.classList.add('hidden'); return; }

  const idx = getCycleIndex(dateStr);
  const isEmendando = idx === 0 && currentFormType === 'special';
  aviso.classList.toggle('hidden', !isEmendando);

  if (currentFormType !== 'special') return;
  if (state.specials[dateStr]) return;
  if (specialTimeTouched) return;

  if (idx === 0) { $('#specialStart').value = '22:00'; $('#specialEnd').value = '06:00'; }
}

function openAddRecordModal(dateStr, defaultType) {
  specialTimeTouched = false;
  $('#inputDate').value = dateStr;
  switchFormType(defaultType || 'special');

  if (state.specials[dateStr]) {
    $('#specialStart').value = state.specials[dateStr].start;
    $('#specialEnd').value = state.specials[dateStr].end;
    $('#specialNotify').checked = !!state.specials[dateStr].notify;
    $('#btnDeleteSpecial').classList.remove('hidden');
  } else {
    $('#specialStart').value = '18:00';
    $('#specialEnd').value = '06:00';
    $('#specialNotify').checked = false;
    $('#btnDeleteSpecial').classList.add('hidden');
  }

  $('#taskNotify').checked = false;

  checkEmendandoAutoFill();
  openModal('addRecordModal');
}

async function saveRecord() {
  const dateStr = $('#inputDate').value;
  if (!dateStr) return alert('Selecione uma data.');

  if (currentFormType === 'special') {
    const start = $('#specialStart').value;
    const end = $('#specialEnd').value;
    const notify = $('#specialNotify').checked;
    const saved = await api(`/api/specials/${dateStr}`, 'PUT', { start, end, notify });
    state.specials[dateStr] = { start: saved.start, end: saved.end, notify: saved.notify };
  } else {
    const title = $('#taskTitle').value.trim();
    if (!title) return alert('Dê um título à tarefa.');
    const priorityVal = $('#taskPriority').value;
    const priority = priorityVal ? parseInt(priorityVal, 10) : null;
    const obs = $('#taskObs').value.trim() || null;
    const notify = $('#taskNotify').checked;
    const created = await api('/api/tasks', 'POST', { title, date: dateStr, priority, obs, notify });
    state.tasks.push(created);
    $('#taskTitle').value = '';
    $('#taskObs').value = '';
    $('#taskPriority').value = '';
    $('#taskNotify').checked = false;
  }

  closeModals();
  renderAll();
}

async function deleteSpecialFromModal() {
  const dateStr = $('#inputDate').value;
  if (!dateStr || !state.specials[dateStr]) return closeModals();
  await api(`/api/specials/${dateStr}`, 'DELETE');
  delete state.specials[dateStr];
  closeModals();
  renderAll();
}

// ===================== Lista de Especiais ===================== //
function openSpecialsListModal() {
  renderSpecialsList();
  openModal('specialsListModal');
}

function renderSpecialsList() {
  const el = $('#specialsListBody');
  const dates = Object.keys(state.specials).sort();
  if (!dates.length) { el.innerHTML = '<div class="empty-state">Nenhum dia especial cadastrado.</div>'; return; }

  el.innerHTML = dates.map((dateStr) => {
    const sp = state.specials[dateStr];
    const shift = getShiftInfo(dateStr);
    const isEmendando = shift.cycleIndex === 0;
    const dateObj = new Date(dateStr + 'T00:00:00');
    return `
      <div class="list-item">
        <div class="item-content">
          <div class="item-title">${formatDateBRFull(dateStr)} - ${dayNames[dateObj.getDay()]}</div>
          <div class="item-meta"><span>${sp.start} às ${sp.end}</span>${isEmendando ? '<span class="emendando-tag">EMENDANDO</span>' : ''}</div>
        </div>
        <div class="item-actions">
          <button class="icon-btn" title="Excluir" onclick="confirmDeleteSpecial('${dateStr}')">🗑</button>
        </div>
      </div>
    `;
  }).join('');
}

function confirmDeleteSpecial(dateStr) {
  showConfirm(`Excluir o dia especial de ${formatDateBRFull(dateStr)}?`, async () => {
    await api(`/api/specials/${dateStr}`, 'DELETE');
    delete state.specials[dateStr];
    closeModals();
    renderAll();
  });
}

// ===================== Tarefas ===================== //
function renderTasks() {
  const upcoming = state.tasks.filter((t) => t.date && !t.done).sort((a, b) => a.date.localeCompare(b.date));
  const backlog = state.tasks.filter((t) => !t.date && !t.done);
  const done = state.tasks.filter((t) => t.done);

  renderTaskList('tasksUpcoming', upcoming, 'upcoming');
  renderTaskList('tasksBacklog', backlog, 'backlog');
  renderTaskList('tasksDoneWrap', done, 'done');
}

function renderTaskList(containerId, items, context) {
  const el = $('#' + containerId);
  if (!items.length) { el.innerHTML = '<div class="empty-state">Nada por aqui.</div>'; return; }
  el.innerHTML = items.map((t) => taskListItemHtml(t, context)).join('');
}

function taskListItemHtml(t, context) {
  const fire = fireBadge(t.priority);

  const metaParts = [];
  if (t.date) metaParts.push(formatDateBR(t.date));
  if (t.obs) metaParts.push(escapeHtml(t.obs));

  let actions;
  if (context === 'upcoming') {
    actions = `
      <button class="icon-btn" title="Concluir" onclick="completeTask('${t.id}')">✓</button>
      <button class="icon-btn" title="Sem data" onclick="sendToBacklog('${t.id}')">↩</button>`;
  } else if (context === 'backlog') {
    actions = `
      <button class="icon-btn" title="Definir data" onclick="openTaskModal('${t.id}')">📅</button>
      <button class="icon-btn" title="Excluir" onclick="confirmDeleteTask('${t.id}')">🗑</button>`;
  } else {
    actions = `
      <button class="icon-btn" title="Reabrir" onclick="reopenTask('${t.id}')">↩</button>
      <button class="icon-btn" title="Excluir" onclick="confirmDeleteTask('${t.id}')">🗑</button>`;
  }

  const meta = (fire || metaParts.length)
    ? `<div class="item-meta">${fire}${metaParts.map((m) => `<span>${m}</span>`).join(' · ')}</div>`
    : '';

  return `
    <div class="list-item ${t.done ? 'done' : ''}">
      <button class="check-circle" onclick="${t.done ? `reopenTask('${t.id}')` : `completeTask('${t.id}')`}">${t.done ? '✓' : ''}</button>
      <div class="item-content">
        <div class="item-title">${escapeHtml(t.title)}</div>
        ${meta}
      </div>
      <div class="item-actions">${actions}</div>
    </div>
  `;
}

function openTaskModal(id, defaultDate) {
  const task = id ? state.tasks.find((t) => t.id === id) : null;
  $('#taskModalTitle').textContent = task ? 'Editar Tarefa' : 'Nova Tarefa';
  $('#taskModalId').value = task ? task.id : '';
  $('#taskModalTitleInput').value = task ? task.title : '';
  $('#taskModalDate').value = task ? (task.date || '') : (defaultDate || '');
  $('#taskModalPriority').value = task && task.priority ? String(task.priority) : '';
  $('#taskModalObs').value = task ? (task.obs || '') : '';
  $('#taskModalNotify').checked = task ? !!task.notify : false;
  openModal('taskModal');
}

async function saveTaskModal() {
  const id = $('#taskModalId').value;
  const title = $('#taskModalTitleInput').value.trim();
  if (!title) return alert('Dê um título à tarefa.');
  const date = $('#taskModalDate').value || null;
  const priorityVal = $('#taskModalPriority').value;
  const priority = priorityVal ? parseInt(priorityVal, 10) : null;
  const obs = $('#taskModalObs').value.trim() || null;
  const notify = $('#taskModalNotify').checked;

  if (id) {
    const updated = await api(`/api/tasks/${id}`, 'PUT', { title, date, priority, obs, notify });
    const idx = state.tasks.findIndex((t) => t.id === id);
    state.tasks[idx] = updated;
  } else {
    const created = await api('/api/tasks', 'POST', { title, date, priority, obs, notify });
    state.tasks.push(created);
  }

  closeModals();
  renderAll();
}

async function patchTask(id, fields) {
  const updated = await api(`/api/tasks/${id}`, 'PUT', fields);
  const idx = state.tasks.findIndex((t) => t.id === id);
  state.tasks[idx] = updated;
  renderAll();
}

function completeTask(id) { return patchTask(id, { done: true }); }
function reopenTask(id) { return patchTask(id, { done: false }); }
function sendToBacklog(id) { return patchTask(id, { date: null, done: false }); }

function confirmDeleteTask(id) {
  const task = state.tasks.find((t) => t.id === id);
  showConfirm(`Excluir a tarefa "${task.title}"?`, async () => {
    await api(`/api/tasks/${id}`, 'DELETE');
    state.tasks = state.tasks.filter((t) => t.id !== id);
    closeModals();
    renderAll();
  });
}

// ===================== Projetos ===================== //
function renderProjects() {
  const active = state.projects.filter((p) => !p.done);
  const done = state.projects.filter((p) => p.done);
  renderProjectList('projectsActive', active);
  renderProjectList('projectsDoneWrap', done);
}

function renderProjectList(containerId, items) {
  const el = $('#' + containerId);
  if (!items.length) { el.innerHTML = '<div class="empty-state">Nenhum projeto aqui.</div>'; return; }
  el.innerHTML = items.map(projectCardHtml).join('');
}

function projectCardHtml(p) {
  const total = p.steps.length;
  const doneCount = p.steps.filter((s) => s.done).length;
  const pct = total ? Math.round((doneCount / total) * 100) : 0;

  const stepsHtml = p.steps.map((s) => `
    <div class="list-item step-item ${s.done ? 'done' : ''}">
      <button class="check-circle" onclick="toggleStep('${p.id}','${s.id}',${!s.done})">${s.done ? '✓' : ''}</button>
      <div class="item-content">
        <div class="item-title">${escapeHtml(s.title)}</div>
        ${s.obs ? `<div class="item-obs">${escapeHtml(s.obs)}</div>` : ''}
      </div>
      <div class="item-actions">
        <button class="icon-btn" title="Observação" onclick="editStepObs('${p.id}','${s.id}')">📝</button>
        <button class="icon-btn" title="Excluir" onclick="deleteStep('${p.id}','${s.id}')">🗑</button>
      </div>
    </div>
  `).join('');

  return `
    <div class="project-card ${p.done ? 'done' : ''}">
      <div class="project-header">
        <span class="project-title">${escapeHtml(p.title)}</span>
        <div class="item-actions">
          ${p.done ? `<button class="icon-btn" title="Reabrir" onclick="reopenProject('${p.id}')">↩</button>` : ''}
          <button class="icon-btn" title="Excluir" onclick="confirmDeleteProject('${p.id}')">🗑</button>
        </div>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="progress-label">${doneCount}/${total} etapas</div>
      <div class="step-list">${stepsHtml}</div>
      <div class="add-step-row">
        <input type="text" class="form-control" placeholder="+ etapa" onkeydown="if(event.key==='Enter') addStep('${p.id}', this)">
        <button class="btn-add" onclick="addStep('${p.id}', this.previousElementSibling)">+</button>
      </div>
    </div>
  `;
}

function replaceProject(updated) {
  const idx = state.projects.findIndex((p) => p.id === updated.id);
  if (idx >= 0) state.projects[idx] = updated; else state.projects.push(updated);
}

async function addStep(projectId, inputEl) {
  const title = inputEl.value.trim();
  if (!title) return;
  const updated = await api(`/api/projects/${projectId}/steps`, 'POST', { title });
  replaceProject(updated);
  renderAll();
}

async function toggleStep(pid, sid, done) {
  const updated = await api(`/api/projects/${pid}/steps/${sid}`, 'PUT', { done });
  replaceProject(updated);
  renderAll();
}

async function deleteStep(pid, sid) {
  const updated = await api(`/api/projects/${pid}/steps/${sid}`, 'DELETE');
  replaceProject(updated);
  renderAll();
}

async function editStepObs(pid, sid) {
  const project = state.projects.find((p) => p.id === pid);
  const step = project && project.steps.find((s) => s.id === sid);
  const obs = window.prompt('Observação da etapa:', (step && step.obs) || '');
  if (obs === null) return;
  const updated = await api(`/api/projects/${pid}/steps/${sid}`, 'PUT', { obs: obs.trim() || null });
  replaceProject(updated);
  renderAll();
}

async function reopenProject(id) {
  const updated = await api(`/api/projects/${id}`, 'PUT', { done: false });
  replaceProject(updated);
  renderAll();
}

function confirmDeleteProject(id) {
  const p = state.projects.find((x) => x.id === id);
  showConfirm(`Excluir o projeto "${p.title}" e todas as etapas?`, async () => {
    await api(`/api/projects/${id}`, 'DELETE');
    state.projects = state.projects.filter((x) => x.id !== id);
    closeModals();
    renderAll();
  });
}

async function saveProject() {
  const title = $('#projectTitle').value.trim();
  if (!title) return alert('Dê um título ao projeto.');
  const created = await api('/api/projects', 'POST', { title });
  state.projects.push(created);
  $('#projectTitle').value = '';
  closeModals();
  renderAll();
}

// ===================== Compras ===================== //
function renderShopping() {
  renderShoppingList('shoppingMercado', state.shopping.mercado);
  renderShoppingList('shoppingAvulso', state.shopping.avulso);
}

function renderShoppingList(containerId, items) {
  const el = $('#' + containerId);
  if (!items.length) { el.innerHTML = '<div class="empty-state">Lista vazia.</div>'; return; }
  el.innerHTML = items.map((it) => `
    <div class="list-item ${it.done ? 'done' : ''}">
      <button class="check-circle" onclick="toggleShoppingItem('${it.id}',${!it.done})">${it.done ? '✓' : ''}</button>
      <div class="item-content"><div class="item-title">${escapeHtml(it.name)}</div></div>
      <div class="item-actions"><button class="icon-btn" title="Excluir" onclick="deleteShoppingItem('${it.id}')">🗑</button></div>
    </div>
  `).join('');
}

async function addShoppingItem(category) {
  const inputId = category === 'mercado' ? 'inputShoppingMercado' : 'inputShoppingAvulso';
  const input = $('#' + inputId);
  const name = input.value.trim();
  if (!name) return;
  const created = await api('/api/shopping', 'POST', { category, name });
  state.shopping[category].push(created);
  input.value = '';
  renderShopping();
}

async function toggleShoppingItem(id, done) {
  const updated = await api(`/api/shopping/${id}`, 'PUT', { done });
  for (const cat of ['mercado', 'avulso']) {
    const idx = state.shopping[cat].findIndex((i) => i.id === id);
    if (idx >= 0) state.shopping[cat][idx] = updated;
  }
  renderShopping();
}

function deleteShoppingItem(id) {
  showConfirm('Excluir este item?', async () => {
    await api(`/api/shopping/${id}`, 'DELETE');
    for (const cat of ['mercado', 'avulso']) state.shopping[cat] = state.shopping[cat].filter((i) => i.id !== id);
    closeModals();
    renderShopping();
  });
}

function clearShoppingDone(category) {
  const doneItems = state.shopping[category].filter((i) => i.done);
  if (!doneItems.length) return;
  showConfirm(`Remover ${doneItems.length} item(ns) concluído(s)?`, async () => {
    for (const it of doneItems) await api(`/api/shopping/${it.id}`, 'DELETE');
    state.shopping[category] = state.shopping[category].filter((i) => !i.done);
    closeModals();
    renderShopping();
  });
}

// ===================== Configurações ===================== //
function openConfigModal() {
  $('#anchorDiaDate').value = state.config.anchorDate || '';
  const folgaDays = (state.config.cycleLength || 3) - 1;
  $('#folgaDays').value = folgaDays >= 1 ? folgaDays : 2;
  openModal('configModal');
}

async function saveConfig() {
  const anchorDate = $('#anchorDiaDate').value || null;
  if (!anchorDate) return alert('Informe a data de um dia de TRABALHO.');
  const folgaDays = parseInt($('#folgaDays').value, 10);
  if (!folgaDays || folgaDays < 1) return alert('Informe os dias de folga (mínimo 1).');
  const cycleLength = folgaDays + 1;
  const updated = await api('/api/config', 'PUT', { anchorDate, cycleLength });
  state.config = updated;
  closeModals();
  renderAll();
}

// ===================== Notificações ===================== //
const NOTIFIED_KEY = 'agendaNotified';

function ensureNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function getNotifiedToday() {
  try {
    const raw = JSON.parse(localStorage.getItem(NOTIFIED_KEY) || 'null');
    if (raw && raw.date === todayISO()) return raw.ids;
  } catch {}
  return [];
}

function saveNotifiedToday(ids) {
  localStorage.setItem(NOTIFIED_KEY, JSON.stringify({ date: todayISO(), ids }));
}

async function showAppNotification(title, body) {
  if ('serviceWorker' in navigator) {
    const reg = await navigator.serviceWorker.ready;
    reg.showNotification(title, { body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png' });
  } else {
    new Notification(title, { body });
  }
}

async function checkDueNotifications() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const today = todayISO();
  const notified = getNotifiedToday();
  const newlyNotified = [];

  for (const t of state.tasks) {
    if (t.date === today && !t.done && t.notify && !notified.includes('task:' + t.id)) {
      await showAppNotification('Tarefa de hoje', t.title);
      newlyNotified.push('task:' + t.id);
    }
  }

  const sp = state.specials[today];
  if (sp && sp.notify && !notified.includes('special:' + today)) {
    await showAppNotification('Especial hoje', `${sp.start} às ${sp.end}`);
    newlyNotified.push('special:' + today);
  }

  if (newlyNotified.length) saveNotifiedToday([...notified, ...newlyNotified]);
}

// ===================== PWA ===================== //
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

function setupInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    $('#btnInstall').classList.remove('hidden');
  });
  window.addEventListener('appinstalled', () => {
    $('#btnInstall').classList.add('hidden');
    deferredPrompt = null;
  });

  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  if (!standalone && /iPhone|iPad|iPod/.test(navigator.userAgent)) {
    $('#btnInstall').classList.remove('hidden');
  }
}

async function onInstallClick() {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    $('#btnInstall').classList.add('hidden');
  } else {
    openModal('installModal');
  }
}

// ===================== Init ===================== //
(function init() {
  if (getToken()) boot();
  registerServiceWorker();
  setupInstallPrompt();

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && getToken()) checkDueNotifications();
  });
  setInterval(() => { if (getToken()) checkDueNotifications(); }, 5 * 60 * 1000);
})();
