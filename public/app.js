// ===================== Constantes ===================== //
const alertSVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;

// Escala visual de prioridade: 1 verde claro → 5 vermelho piscando
const PRIORITY_LABELS = { 1: 'Baixa', 2: 'Média', 3: 'Alta', 4: 'Urgente', 5: 'Crítica' };

function prioClass(priority) {
  return Number.isInteger(priority) && priority >= 1 && priority <= 5 ? ' prio-fill prio-fill-' + priority : '';
}

// Ícone de alerta só na prioridade máxima (vermelho piscando)
function prioIcon(priority) {
  return priority === 5 ? `<span class="prio-alert">${alertSVG}</span>` : '';
}

const monthNames = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
const dayNames = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
const dayAbbr = ["DOM", "SEG", "TER", "QUA", "QUI", "SEX", "SÁB"];

const ICON_GRID = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>`;
const ICON_LIST = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>`;

const TOKEN_KEY = 'agendaToken';

// ===================== Estado ===================== //
let state = { config: { anchorDate: null, cycleLength: 9 }, specials: {}, tasks: [], projects: [], shopping: {}, shoppingCategories: [], recurring: [], abonos: {}, vacations: [] };
let currentDate = new Date();
let currentShoppingCat = null;
let viewMode = localStorage.getItem('agendaViewMode') || 'list';
let currentTab = 'calendar';
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

// ---- Campos com máscara BR (dd/mm/aaaa e hora 24h) ---- //
function maskDateBR(el) {
  let v = el.value.replace(/\D/g, '').slice(0, 8);
  if (v.length > 4) v = v.slice(0, 2) + '/' + v.slice(2, 4) + '/' + v.slice(4);
  else if (v.length > 2) v = v.slice(0, 2) + '/' + v.slice(2);
  el.value = v;
}

function maskTime24(el) {
  let v = el.value.replace(/\D/g, '').slice(0, 4);
  if (v.length >= 3) v = v.slice(0, v.length - 2) + ':' + v.slice(-2);
  el.value = v;
}

function brToISO(br) {
  const m = (br || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  const dt = new Date(`${y}-${mo}-${d}T00:00:00`);
  if (dt.getFullYear() !== +y || dt.getMonth() + 1 !== +mo || dt.getDate() !== +d) return null;
  return `${y}-${mo}-${d}`;
}

function isoToBR(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function parseTime24(v) {
  const m = (v || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = +m[1], min = +m[2];
  if (h > 23 || min > 59) return null;
  return pad(h) + ':' + pad(min);
}

// Id gerado no cliente (crypto.randomUUID só existe em contexto seguro)
function genId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// Trava contra envio duplicado: enquanto a ação `key` está em andamento,
// novos cliques são ignorados e o botão fica desabilitado.
const inFlight = new Set();
async function runOnce(key, btn, fn) {
  if (inFlight.has(key)) return;
  inFlight.add(key);
  const originalHtml = btn ? btn.innerHTML : null;
  if (btn) {
    btn.disabled = true;
    btn.classList.add('is-busy');
    if (btn.classList.contains('btn-submit')) btn.textContent = 'Aguarde...';
  }
  try {
    return await fn();
  } finally {
    inFlight.delete(key);
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('is-busy');
      btn.innerHTML = originalHtml;
    }
  }
}

function taskOccursOn(t, dateStr) {
  if (!t.date) return false;
  const end = t.endDate && t.endDate > t.date ? t.endDate : t.date;
  return dateStr >= t.date && dateStr <= end;
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

  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new Error('sem conexão com o servidor');
  }
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
  $('#bootScreen').classList.add('hidden');
  $('#loginScreen').classList.remove('hidden');
}

function showLoginError(msg) {
  $('#loginError').textContent = msg;
  $('#loginError').classList.remove('hidden');
}

function logout() {
  clearToken();
  closeModals();
  location.reload();
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = $('#loginPassword').value;
  let res;
  try {
    res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
  } catch {
    return showLoginError('Sem conexão com o servidor. Tente de novo.');
  }
  if (res.status === 401) return showLoginError('Senha incorreta.');
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return showLoginError(res.status === 429 ? 'Muitas tentativas. Aguarde alguns minutos.' : (err.error || 'Erro no servidor. Tente de novo.'));
  }
  const { token } = await res.json();
  setToken(token);
  $('#loginError').classList.add('hidden');
  await boot();
});

// Com sessão salva o app vai direto para cá (sem tela de senha). Falha de rede
// ou servidor reiniciando mostra "sem conexão" em vez de pedir a senha.
async function boot() {
  $('#loginScreen').classList.add('hidden');
  $('#bootScreen').classList.remove('hidden');
  $('#bootMsg').textContent = 'Carregando…';
  $('#bootRetry').classList.add('hidden');
  try {
    state = await api('/api/state');
    $('#bootScreen').classList.add('hidden');
    $('#app').classList.remove('hidden');
    if (!state.vacations) state.vacations = [];
    applyViewMode();
    switchTab('calendar');
    armBackGuard();
    if (!state.config.anchorDate) openConfigModal();
    checkDueNotifications();
  } catch (e) {
    if (e.message === 'unauthorized') return; // api() já mostrou a tela de senha
    console.error(e);
    $('#bootMsg').textContent = 'Sem conexão com o servidor. Verifique a internet e tente de novo.';
    $('#bootRetry').classList.remove('hidden');
  }
}

// ===================== Ciclo de Escala ===================== //
function getCycleIndex(dateString) {
  const cfg = state.config;
  if (!cfg.anchorDate || !cfg.cycleLength) return -1;
  const anchor = new Date(cfg.anchorDate + 'T00:00:00');
  const target = new Date(dateString + 'T00:00:00');
  const diffDays = Math.round((target.getTime() - anchor.getTime()) / 86400000);
  return ((diffDays % cfg.cycleLength) + cfg.cycleLength) % cfg.cycleLength;
}

function vacationFor(dateString) {
  return (state.vacations || []).find((v) => dateString >= v.start && dateString <= v.end) || null;
}

function getShiftInfo(dateString) {
  const idx = getCycleIndex(dateString);
  if (idx === -1) return { label: 'Sem Escala', class: 'shift-folga', type: 'folga', cycleIndex: -1 };
  const vac = vacationFor(dateString);
  if (vac) return { label: 'Férias', class: 'shift-folga', type: 'folga', cycleIndex: idx, ferias: vac };
  if (idx === 0) {
    if (state.abonos[dateString]) return { label: 'Folga (Abono)', class: 'shift-folga', type: 'folga', cycleIndex: idx, abono: true };
    return { label: 'Trabalho (06h-22h)', class: 'shift-dia', type: 'trabalho', cycleIndex: idx };
  }
  return { label: 'Folga', class: 'shift-folga', type: 'folga', cycleIndex: idx };
}

function isFolgaDay(dateStr) {
  const s = getShiftInfo(dateStr);
  return s.type === 'folga' && s.cycleIndex !== -1;
}

// Folga prolongada: sequência de folgas conectadas que contém pelo menos um abono ou férias
function isExtendedFolga(dateStr) {
  if (!isFolgaDay(dateStr)) return false;
  let start = dateStr;
  while (isFolgaDay(addDays(start, -1))) start = addDays(start, -1);
  let d = start;
  let hasAbono = false;
  while (isFolgaDay(d)) {
    if (state.abonos[d] || vacationFor(d)) hasAbono = true;
    d = addDays(d, 1);
  }
  return hasAbono;
}

// ===================== Tabs ===================== //
const TABS = ['calendar', 'tasks', 'projects', 'shopping', 'recurring'];
const TAB_TITLES = { tasks: 'Tarefas', projects: 'Projetos', shopping: 'Lista', recurring: 'Recorrentes' };

function switchTab(tab) {
  currentTab = tab;
  TABS.forEach((t) => $('#panel-' + t).classList.toggle('hidden', t !== tab));
  document.querySelectorAll('.nav-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tab));

  $('#monthNav').classList.toggle('hidden', tab !== 'calendar');
  $('#tabTitle').classList.toggle('hidden', tab === 'calendar');
  $('#btnViewToggle').classList.toggle('hidden', tab !== 'calendar');
  if (TAB_TITLES[tab]) $('#tabTitle').textContent = TAB_TITLES[tab];

  $('#fabBtn').classList.toggle('hidden', tab === 'shopping');
  if (tab === 'shopping') currentShoppingCat = null;

  renderActiveTab(tab === 'calendar');
}

function renderActiveTab(scrollToToday) {
  if (currentTab === 'calendar') renderCalendar(scrollToToday);
  else if (currentTab === 'tasks') renderTasks();
  else if (currentTab === 'projects') renderProjects();
  else if (currentTab === 'shopping') renderShopping();
  else if (currentTab === 'recurring') renderRecurring();
}

function renderAll() { renderActiveTab(false); }

function toggleCollapse(id) {
  $('#' + id).classList.toggle('collapsed');
  $('#' + id + '-chevron').parentElement.classList.toggle('open');
}

// ===================== FAB ===================== //
function onFabClick() {
  if (currentTab === 'calendar') openTaskModal(null, todayISO());
  else if (currentTab === 'tasks') openTaskModal(null, todayISO());
  else if (currentTab === 'projects') openModal('projectModal');
  else if (currentTab === 'recurring') openRecurringModal(null);
}

// ===================== Modais ===================== //
// Pilha de modais: o último aberto fica sempre por cima (z-index crescente),
// então abrir "Editar" de dentro da lista do dia não cai atrás dela.
const modalStack = [];

function openModal(id) {
  const el = $('#' + id);
  if (!modalStack.includes(id)) modalStack.push(id);
  el.style.zIndex = 30 + modalStack.indexOf(id);
  el.classList.add('active');
}

function closeModal(id) {
  const idx = modalStack.indexOf(id);
  if (idx >= 0) modalStack.splice(idx, 1);
  $('#' + id).classList.remove('active');
  armBackGuard();
}

function closeTopModal() {
  if (modalStack.length) closeModal(modalStack[modalStack.length - 1]);
}

function closeModals() {
  modalStack.length = 0;
  document.querySelectorAll('.modal-overlay').forEach((m) => m.classList.remove('active'));
  armBackGuard();
}

function isModalOpen(id) { return modalStack.includes(id); }

function showConfirm(message, onConfirm) {
  $('#confirmMessage').textContent = message;
  const oldBtn = $('#confirmBtn');
  const newBtn = oldBtn.cloneNode(true);
  newBtn.disabled = false;
  newBtn.classList.remove('is-busy');
  newBtn.textContent = 'Confirmar';
  oldBtn.parentNode.replaceChild(newBtn, oldBtn);
  newBtn.addEventListener('click', () => runOnce('confirm', newBtn, onConfirm));
  openModal('confirmModal');
}

// ===================== Calendário ===================== //
function changeMonth(direction) {
  currentDate = new Date(currentDate.getFullYear(), currentDate.getMonth() + direction, 1);
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
  // Versão curta ("Hoje, 24 Set") aparece em telas estreitas via CSS
  $('#todayBadge').innerHTML = `Hoje, ${t.getDate()} <span class="badge-long">de ${monthNames[t.getMonth()]}</span><span class="badge-short">${monthNames[t.getMonth()].slice(0, 3)}</span>`;

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
  if (shift.abono) tags.push({ label: 'Abono ✓', cls: 'day-tag-folga' });
  if (shift.ferias) tags.push({ label: 'Férias', cls: 'day-tag-folga' });

  if (state.specials[dateStr]) {
    const isEmendando = shift.cycleIndex === 0;
    tags.push({ label: isEmendando ? 'Especial 24h' : 'Especial', cls: 'day-tag-especial' });
  }

  const mk = monthKeyOf(dateStr);
  recurringForDate(dateStr).forEach((r) => {
    const pending = !isRecurringDone(r, mk);
    tags.push({ label: '🔁 ' + r.title, cls: pending ? 'day-tag-recurring-pending' : 'day-tag-recurring-done' });
  });

  state.tasks
    .filter((t) => taskOccursOn(t, dateStr) && !t.done)
    .sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99') || (b.priority || 0) - (a.priority || 0))
    .forEach((t) => {
      tags.push({
        label: (t.time ? t.time + ' ' : '') + t.title,
        cls: 'day-tag-task' + prioClass(t.priority),
        icon: prioIcon(t.priority),
      });
    });

  return tags;
}

function createDayCard(year, month, day, isNextMonth) {
  const dateStr = formatDate(year, month, day);
  const dateObj = new Date(year, month, day);
  const shift = getShiftInfo(dateStr);
  const isToday = dateStr === todayISO();
  const extended = isExtendedFolga(dateStr);

  const card = document.createElement('div');
  card.className = `day-card ${isNextMonth ? 'next-month' : ''} ${isToday ? 'is-today' : ''} ${extended ? 'folga-estendida' : ''}`;

  if (viewMode === 'grid') {
    const tags = getDayTags(dateStr, shift);
    let tagsHtml = '<div class="day-tags">';
    const overflow = tags.length > 5;
    const visibleTags = overflow ? tags.slice(0, 4) : tags;
    visibleTags.forEach((tag) => {
      tagsHtml += `<div class="day-tag ${tag.cls}" style="${tag.style || ''}">${tag.icon || ''}<span class="day-tag-text">${escapeHtml(tag.label)}</span></div>`;
    });
    if (overflow) tagsHtml += `<div class="day-tag day-tag-more">+${tags.length - 4} eventos</div>`;
    tagsHtml += '</div>';

    card.innerHTML = `
      <div class="day-header">
        <div class="day-info"><span class="day-number">${pad(day)}</span></div>
        <span class="day-weekday">${dayAbbr[dateObj.getDay()]}</span>
      </div>
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
        ${isToday ? '<span class="today-pill">HOJE</span>' : ''}
      </div>
      ${shouldShowShiftBadge(dateStr, shift) ? `<span class="shift-badge ${shift.class}">${shift.label}</span>` : ''}
    </div>
  `;
  html += renderDayBody(dateStr, shift);
  card.innerHTML = html;
  card.onclick = () => openDaySheet(dateStr);
  return card;
}

function monthKeyOf(dateStr) { const [y, m] = dateStr.split('-'); return `${y}-${m}`; }

function isRecurringDone(r, mk) {
  return (r.doneMonths || []).includes(mk);
}

// Não aparece em meses anteriores ao cadastro do lembrete
function recurringForDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const mk = monthKeyOf(dateStr);
  return state.recurring.filter((r) => Math.min(r.dayOfMonth, daysInMonth) === d && (!r.createdMonth || mk >= r.createdMonth));
}

function renderDayBody(dateStr, shift) {
  let html = '';
  if (shift.abono) {
    html += `<div class="abono-alert" onclick="event.stopPropagation(); openAbonoForDate('${dateStr}')">ABONO — dia de folga</div>`;
  }
  if (shift.ferias) {
    html += `<div class="abono-alert" onclick="event.stopPropagation(); openVacationModal()">FÉRIAS — ${formatDateBR(shift.ferias.start)} até ${formatDateBR(shift.ferias.end)}</div>`;
  }
  const sp = state.specials[dateStr];
  if (sp) {
    const isEmendando = shift.cycleIndex === 0;
    html += `<div class="special-alert" onclick="event.stopPropagation(); openSpecialsListModal()">ESPECIAL: ${escapeHtml(sp.start)} às ${escapeHtml(sp.end)}${isEmendando ? '<span class="emendando-tag">EMENDANDO</span>' : ''}</div>`;
  }

  const mk = monthKeyOf(dateStr);
  recurringForDate(dateStr).forEach((r) => {
    const pending = !isRecurringDone(r, mk);
    html += `<div class="recurring-alert ${pending ? 'pending' : 'done'}" onclick="event.stopPropagation(); toggleRecurringMonth('${r.id}','${mk}')">🔁 ${escapeHtml(r.title)} ${pending ? '<span class="recurring-hint">toque p/ confirmar</span>' : '✓ feito'}</div>`;
  });

  const dayTasks = state.tasks
    .filter((t) => taskOccursOn(t, dateStr))
    .sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99') || (b.priority || 0) - (a.priority || 0));
  if (dayTasks.length) {
    html += '<div class="event-list">';
    dayTasks.forEach((t) => {
      const range = t.endDate && t.endDate !== t.date ? `<span class="event-obs">${formatDateBR(t.date)} até ${formatDateBR(t.endDate)}</span>` : '';
      const actions = t.done
        ? `<button onclick="event.stopPropagation(); reopenTask('${t.id}')">↩ Reabrir</button>`
        : `<button onclick="event.stopPropagation(); completeTask('${t.id}')">✓</button>
           <button onclick="event.stopPropagation(); openTaskModal('${t.id}')">✏️</button>
           <button title="Nova data" onclick="event.stopPropagation(); openRescheduleModal('${t.id}')">📅</button>`;
      html += `
        <div class="event-item ${t.done ? 'done' : ''}${t.done ? '' : prioClass(t.priority)}">
          ${t.done ? '' : prioIcon(t.priority)}
          <div class="event-details">
            <span class="event-title">${t.time ? `<span class="event-time">${t.time}</span> ` : ''}${escapeHtml(t.title)}</span>
            ${t.obs ? `<span class="event-obs">${escapeHtml(t.obs)}</span>` : ''}
            ${taskExtrasHtml(t) ? `<span class="event-obs task-extras">${taskExtrasHtml(t)}</span>` : ''}
            ${range}
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
  renderDaySheet();
  openModal('daySheetModal');
}

function renderDaySheet() {
  const dateStr = currentSheetDate;
  const dateObj = new Date(dateStr + 'T00:00:00');
  const shift = getShiftInfo(dateStr);
  $('#daySheetTitle').textContent = `${dateObj.getDate()} de ${monthNames[dateObj.getMonth()]} - ${dayNames[dateObj.getDay()]}`;

  let html = shouldShowShiftBadge(dateStr, shift) ? `<div class="day-header"><span class="shift-badge ${shift.class}">${shift.label}</span></div>` : '';
  const body = renderDayBody(dateStr, shift);
  html += body || '<p class="confirm-message">Nada registrado neste dia.</p>';

  $('#daySheetBody').innerHTML = html;
}

// Atualiza a lista do dia (se aberta) sem mexer na ordem dos modais
function refreshDaySheet() {
  if (isModalOpen('daySheetModal') && currentSheetDate) renderDaySheet();
}

function openAddRecordForDay(type) {
  if (type === 'abono') openAbonoModal(currentSheetDate);
  else openTaskModal(null, currentSheetDate);
}

function openAbonoForDate(dateStr) {
  openAbonoModal(dateStr);
}

// ===================== Modal: Abono ===================== //
function openAbonoModal(dateStr) {
  $('#inputDate').value = isoToBR(dateStr);
  syncAbonoDeleteBtn();
  openModal('abonoModal');
}

function nextWorkDay(fromDate) {
  let d = fromDate;
  for (let i = 0; i < (state.config.cycleLength || 1) + 1; i++) {
    if (getCycleIndex(d) === 0 && !state.abonos[d]) return d;
    d = addDays(d, 1);
  }
  return fromDate;
}

function syncAbonoDeleteBtn() {
  const dateStr = brToISO($('#inputDate').value);
  $('#btnDeleteAbono').classList.toggle('hidden', !(dateStr && state.abonos[dateStr]));
}

function saveAbono(btn) {
  return runOnce('abono', btn, async () => {
    const dateStr = brToISO($('#inputDate').value);
    if (!dateStr) return alert('Data inválida. Use o formato dd/mm/aaaa.');
    if (getCycleIndex(dateStr) !== 0) return alert('Abono só pode ser marcado em um dia de TRABALHO.');
    await api(`/api/abonos/${dateStr}`, 'PUT');
    state.abonos[dateStr] = true;
    closeModal('abonoModal');
    renderAll();
    refreshDaySheet();
  });
}

function deleteAbonoFromModal(btn) {
  return runOnce('abono', btn, async () => {
    const dateStr = brToISO($('#inputDate').value);
    if (!dateStr || !state.abonos[dateStr]) return closeModal('abonoModal');
    await api(`/api/abonos/${dateStr}`, 'DELETE');
    delete state.abonos[dateStr];
    closeModal('abonoModal');
    renderAll();
    refreshDaySheet();
  });
}

// ===================== Menu de Ajustes (engrenagem) ===================== //
function openSettingsMenu() { openModal('settingsModal'); }

function openFromMenu(what) {
  closeModal('settingsModal');
  if (what === 'abono') openAbonoModal(nextWorkDay(todayISO()));
  else if (what === 'vacation') openVacationModal();
  else if (what === 'specials') openSpecialsListModal();
  else if (what === 'config') openConfigModal();
}

// ===================== Férias ===================== //
function openVacationModal() {
  $('#vacationStart').value = '';
  $('#vacationEnd').value = '';
  renderVacationList();
  openModal('vacationModal');
}

function renderVacationList() {
  const el = $('#vacationList');
  if (!state.vacations.length) { el.innerHTML = '<div class="empty-state">Nenhum período de férias.</div>'; return; }
  el.innerHTML = state.vacations.map((v) => `
    <div class="list-item">
      <div class="item-content">
        <div class="item-title">${formatDateBRFull(v.start)} até ${formatDateBRFull(v.end)}</div>
      </div>
      <div class="item-actions">
        <button class="icon-btn" title="Excluir" onclick="confirmDeleteVacation('${v.id}')">🗑</button>
      </div>
    </div>`).join('');
}

function saveVacation(btn) {
  return runOnce('vacation', btn, async () => {
    const start = brToISO($('#vacationStart').value);
    const end = brToISO($('#vacationEnd').value);
    if (!start || !end) return alert('Informe início e fim no formato dd/mm/aaaa.');
    if (end < start) return alert('O fim deve ser igual ou depois do início.');
    const created = await api('/api/vacations', 'POST', { start, end });
    if (!state.vacations.some((v) => v.id === created.id)) state.vacations.push(created);
    state.vacations.sort((a, b) => a.start.localeCompare(b.start));
    $('#vacationStart').value = '';
    $('#vacationEnd').value = '';
    renderVacationList();
    renderAll();
    refreshDaySheet();
  });
}

function confirmDeleteVacation(id) {
  const v = state.vacations.find((x) => x.id === id);
  if (!v) return;
  showConfirm(`Excluir as férias de ${formatDateBRFull(v.start)} até ${formatDateBRFull(v.end)}?`, async () => {
    await api(`/api/vacations/${id}`, 'DELETE');
    state.vacations = state.vacations.filter((x) => x.id !== id);
    closeModal('confirmModal');
    renderVacationList();
    renderAll();
    refreshDaySheet();
  });
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
          <div class="item-meta"><span>${escapeHtml(sp.start)} às ${escapeHtml(sp.end)}</span>${isEmendando ? '<span class="emendando-tag">EMENDANDO</span>' : ''}</div>
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
    closeModal('confirmModal');
    renderSpecialsList();
    renderAll();
  });
}

// ===================== Tarefas ===================== //
function renderTasks() {
  const upcoming = state.tasks
    .filter((t) => t.date && !t.done)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time || '99:99').localeCompare(b.time || '99:99'));
  const backlog = state.tasks.filter((t) => !t.date && !t.done);
  const done = state.tasks.filter((t) => t.done);

  renderTaskList('tasksUpcoming', upcoming, 'upcoming');
  renderTaskList('tasksBacklog', backlog, 'backlog');
  renderTaskList('tasksDoneWrap', done, 'done');
  $('#backlogSection').classList.toggle('hidden', !backlog.length);
  $('#btnClearDone').classList.toggle('hidden', !done.length);
}

function isOverdue(t) {
  return !t.done && t.date && (t.endDate && t.endDate > t.date ? t.endDate : t.date) < todayISO();
}

function renderTaskList(containerId, items, context) {
  const el = $('#' + containerId);
  if (!items.length) { el.innerHTML = '<div class="empty-state">Nada por aqui.</div>'; return; }
  el.innerHTML = items.map((t) => taskListItemHtml(t, context)).join('');
}

function taskListItemHtml(t, context) {
  const metaParts = [];
  if (isOverdue(t)) metaParts.push('<span class="overdue-tag">⚠ Vencida</span>');
  if (t.date) metaParts.push(formatDateBR(t.date) + (t.endDate && t.endDate !== t.date ? ' até ' + formatDateBR(t.endDate) : ''));
  if (t.time) metaParts.push('⏰ ' + t.time);
  if (t.priority) metaParts.push(PRIORITY_LABELS[t.priority]);
  if (t.obs) metaParts.push(escapeHtml(t.obs));
  const extras = taskExtrasHtml(t);

  let actions;
  if (context === 'upcoming') {
    actions = `
      <button class="icon-btn" title="Editar" onclick="openTaskModal('${t.id}')">✏️</button>
      <button class="icon-btn" title="Nova data" onclick="openRescheduleModal('${t.id}')">📅</button>`;
  } else if (context === 'backlog') {
    actions = `
      <button class="icon-btn" title="Definir data" onclick="openRescheduleModal('${t.id}')">📅</button>
      <button class="icon-btn" title="Excluir" onclick="confirmDeleteTask('${t.id}')">🗑</button>`;
  } else {
    actions = `
      <button class="icon-btn" title="Reabrir" onclick="reopenTask('${t.id}')">↩</button>
      <button class="icon-btn" title="Excluir" onclick="confirmDeleteTask('${t.id}')">🗑</button>`;
  }

  const meta = metaParts.length
    ? `<div class="item-meta">${metaParts.map((m) => `<span>${m}</span>`).join(' · ')}</div>`
    : '';

  return `
    <div class="list-item ${t.done ? 'done' : ''}${t.done ? '' : prioClass(t.priority)}">
      <button class="check-circle" onclick="${t.done ? `reopenTask('${t.id}')` : `completeTask('${t.id}')`}">${t.done ? '✓' : ''}</button>
      ${t.done ? '' : prioIcon(t.priority)}
      <div class="item-content">
        <div class="item-title">${escapeHtml(t.title)}</div>
        ${meta}
        ${extras ? `<div class="item-meta">${extras}</div>` : ''}
      </div>
      <div class="item-actions">${actions}</div>
    </div>
  `;
}

// ---- Relógio analógico para o horário ---- //
// Modo "hora": mostrador 1–12 + botões AM/PM (os números pequenos por dentro
// mostram o equivalente 24h). Ao soltar o dedo passa sozinho para o modo
// "minuto" (de 5 em 5). Tocar ou arrastar funciona.
const CLOCK = { size: 280, c: 140, rOuter: 110, rInner: 74, knob: 20 };
let clockMode = 'hour';
let clockMeridiem = 'AM';

// 1–12 + AM/PM -> 0–23
function to24h(h12, meridiem) {
  if (meridiem === 'AM') return h12 === 12 ? 0 : h12;
  return h12 === 12 ? 12 : h12 + 12;
}

// Sem horário definido, AM/PM segue a hora atual
function resetClock() {
  clockMode = 'hour';
  const { h } = currentTimeParts();
  clockMeridiem = (h != null ? +h : new Date().getHours()) >= 12 ? 'PM' : 'AM';
  renderClock();
}

function setMeridiem(m) {
  clockMeridiem = m;
  const { h } = currentTimeParts();
  if (h != null) {
    const h12 = +h % 12 || 12;
    pickHour(pad(to24h(h12, m)));
  } else {
    renderClock();
  }
}
// Toque simples marca o número; arrastar só a partir da bolinha do ponteiro.
// Assim rolar o formulário passando o dedo pelo relógio não muda o horário.
let clockPress = null;

function buildTaskPickers() {
  const face = $('#clockFace');
  // Começou na bolinha: bloqueia a rolagem para permitir arrastar o ponteiro
  face.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    if (t && isOnClockKnob(t.clientX, t.clientY)) e.preventDefault();
  }, { passive: false });
  face.addEventListener('pointerdown', (e) => {
    const drag = e.pointerType === 'mouse' || isOnClockKnob(e.clientX, e.clientY);
    clockPress = { x: e.clientX, y: e.clientY, drag };
    if (drag) {
      face.setPointerCapture(e.pointerId);
      applyClockPointer(e);
    }
  });
  face.addEventListener('pointermove', (e) => { if (clockPress && clockPress.drag) applyClockPointer(e); });
  face.addEventListener('pointerup', (e) => {
    if (!clockPress) return;
    const moved = Math.hypot(e.clientX - clockPress.x, e.clientY - clockPress.y) > 10;
    const wasDrag = clockPress.drag;
    clockPress = null;
    if (!wasDrag && moved) return; // foi rolagem, não toque
    applyClockPointer(e);
    if (clockMode === 'hour') setTimeout(() => setClockMode('minute'), 220);
  });
  face.addEventListener('pointercancel', () => { clockPress = null; });

  $('#prioRow').innerHTML = `
    <button type="button" class="prio-btn prio-btn-0" data-prio="" onclick="pickPriority('')">Nenhuma</button>
    ${[1, 2, 3, 4, 5].map((p) => `
      <button type="button" class="prio-btn prio-fill prio-fill-${p}" data-prio="${p}" onclick="pickPriority(${p})">
        ${p === 5 ? alertSVG : ''}<span>${PRIORITY_LABELS[p]}</span>
      </button>`).join('')}
  `;
}

function clockPoint(step, r) {
  const a = (step / 12) * 2 * Math.PI - Math.PI / 2;
  return [CLOCK.c + r * Math.cos(a), CLOCK.c + r * Math.sin(a)];
}

function renderClock() {
  const { h, min } = currentTimeParts();
  const labels = [];
  let hand = null;
  let selected = null;

  if (h != null) clockMeridiem = +h >= 12 ? 'PM' : 'AM';

  if (clockMode === 'hour') {
    for (let i = 0; i < 12; i++) {
      const h12 = i === 0 ? 12 : i;
      labels.push({ text: String(h12), value: h12, pos: clockPoint(i, CLOCK.rOuter), inner: false });
      // referência 24h (não clicável à parte): 3 PM -> 15
      labels.push({ text: pad(to24h(h12, clockMeridiem)), value: null, pos: clockPoint(i, CLOCK.rInner), inner: true });
    }
    if (h != null) {
      selected = +h % 12 || 12;
      hand = clockPoint(selected % 12, CLOCK.rOuter);
    }
  } else {
    for (let i = 0; i < 12; i++) labels.push({ text: pad(i * 5), value: i * 5, pos: clockPoint(i, CLOCK.rOuter), inner: false });
    if (min != null) {
      selected = +min;
      hand = clockPoint(selected / 5, CLOCK.rOuter);
    }
  }

  const { c, knob } = CLOCK;
  $('#clockFace').innerHTML = `
    <circle cx="${c}" cy="${c}" r="${c - 2}" class="clock-bg"></circle>
    ${hand ? `<line x1="${c}" y1="${c}" x2="${hand[0]}" y2="${hand[1]}" class="clock-hand"></line>
      <circle cx="${c}" cy="${c}" r="4" class="clock-center"></circle>
      <circle cx="${hand[0]}" cy="${hand[1]}" r="${knob}" class="clock-knob"></circle>` : ''}
    ${labels.map((l) => `<text x="${l.pos[0]}" y="${l.pos[1]}" class="clock-num${l.inner ? ' inner' : ''}${selected != null && l.value === selected ? ' active' : ''}">${l.text}</text>`).join('')}
  `;

  $('#clockAM').classList.toggle('active', clockMeridiem === 'AM');
  $('#clockPM').classList.toggle('active', clockMeridiem === 'PM');
  $('#clockModeHour').classList.toggle('active', clockMode === 'hour');
  $('#clockModeMinute').classList.toggle('active', clockMode === 'minute');
  $('#clockModeHour').textContent = h != null ? h : '--';
  $('#clockModeMinute').textContent = min != null ? min : '--';
}

// Posição da bolinha do ponteiro atual (coordenadas do SVG), ou null
function clockKnobPoint() {
  const { h, min } = currentTimeParts();
  if (clockMode === 'hour') return h != null ? clockPoint(+h % 12, CLOCK.rOuter) : null;
  return min != null ? clockPoint(+min / 5, CLOCK.rOuter) : null;
}

function isOnClockKnob(clientX, clientY) {
  const knob = clockKnobPoint();
  if (!knob) return false;
  const rect = $('#clockFace').getBoundingClientRect();
  const scale = CLOCK.size / rect.width;
  const x = (clientX - rect.left) * scale;
  const y = (clientY - rect.top) * scale;
  return Math.hypot(x - knob[0], y - knob[1]) <= CLOCK.knob + 16;
}

function applyClockPointer(e) {
  const rect = $('#clockFace').getBoundingClientRect();
  const scale = CLOCK.size / rect.width;
  const x = (e.clientX - rect.left) * scale - CLOCK.c;
  const y = (e.clientY - rect.top) * scale - CLOCK.c;
  let angle = Math.atan2(y, x) + Math.PI / 2;
  if (angle < 0) angle += 2 * Math.PI;
  const step = Math.round((angle / (2 * Math.PI)) * 12) % 12;

  if (clockMode === 'hour') {
    pickHour(pad(to24h(step === 0 ? 12 : step, clockMeridiem)));
  } else {
    pickMinute(pad(step * 5));
  }
}

function setClockMode(mode) {
  clockMode = mode;
  renderClock();
}

function currentTimeParts() {
  const m = $('#taskModalTime').value.match(/^(\d{1,2}):?(\d{0,2})$/);
  if (!m) return { h: null, min: null };
  const h = m[1].length && +m[1] <= 23 ? pad(+m[1]) : null;
  const min = m[2] && m[2].length === 2 && +m[2] <= 59 ? m[2] : null;
  return { h, min };
}

function pickHour(h) {
  const { min } = currentTimeParts();
  $('#taskModalTime').value = `${h}:${min || '00'}`;
  renderClock();
}

function pickMinute(min) {
  const { h } = currentTimeParts();
  $('#taskModalTime').value = `${h || pad(new Date().getHours())}:${min}`;
  renderClock();
}

function clearTaskTime() {
  $('#taskModalTime').value = '';
  resetClock();
}

// Chamado ao digitar o horário no campo
function syncTimePicker() {
  renderClock();
}

// ---- Atalhos de data e prioridade ---- //
function setTaskDateValue(br) {
  $('#taskModalDate').value = br;
}

function setTaskDateOffset(n) {
  setTaskDateValue(isoToBR(addDays(todayISO(), n)));
}

function pickPriority(p) {
  $('#taskModalPriority').value = p === '' ? '' : String(p);
  syncPriorityPicker();
}

function syncPriorityPicker() {
  const cur = $('#taskModalPriority').value;
  document.querySelectorAll('#prioRow .prio-btn').forEach((b) => b.classList.toggle('active', b.dataset.prio === cur));
}

function toggleTaskAdvanced(forceOpen) {
  const adv = $('#taskAdvanced');
  const open = forceOpen === undefined ? adv.classList.contains('hidden') : forceOpen;
  adv.classList.toggle('hidden', !open);
  $('#taskAdvancedBtn').classList.toggle('open', open);
}

// ---- Foto da tarefa ---- //
// Estado da foto no formulário aberto: nova (dataUrl), remover a atual, ou nada.
let taskPhotoDraft = { dataUrl: null, remove: false, existing: false };
const photoUrlCache = {};

// Busca a foto com o token (um <img src> não manda o header de auth)
async function loadTaskPhotoUrl(id) {
  if (photoUrlCache[id]) return photoUrlCache[id];
  const res = await fetch(`/api/tasks/${id}/photo`, { headers: { Authorization: 'Bearer ' + getToken() } });
  if (!res.ok) throw new Error('Não foi possível carregar a foto.');
  photoUrlCache[id] = URL.createObjectURL(await res.blob());
  return photoUrlCache[id];
}

function forgetTaskPhoto(id) {
  if (photoUrlCache[id]) URL.revokeObjectURL(photoUrlCache[id]);
  delete photoUrlCache[id];
}

// Reduz no aparelho (máx. 1280px, JPEG) antes de enviar: foto de celular tem vários MB
function resizeImageFile(file, maxSide = 1280, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Imagem inválida.')); };
    img.src = url;
  });
}

function showTaskPhotoPreview(src) {
  $('#taskPhotoPreview').classList.toggle('hidden', !src);
  if (src) $('#taskPhotoImg').src = src;
  else $('#taskPhotoImg').removeAttribute('src');
  $('#taskPhotoBtn').textContent = src ? '📷 Trocar foto' : '📷 Adicionar foto';
}

async function onTaskPhotoPicked(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  const dataUrl = await resizeImageFile(file);
  taskPhotoDraft.dataUrl = dataUrl;
  taskPhotoDraft.remove = false;
  showTaskPhotoPreview(dataUrl);
}

function removeTaskPhoto() {
  taskPhotoDraft.dataUrl = null;
  taskPhotoDraft.remove = taskPhotoDraft.existing;
  showTaskPhotoPreview(null);
}

async function openPhotoViewer(id) {
  const task = state.tasks.find((t) => t.id === id);
  $('#photoModalTitle').textContent = task ? task.title : 'Foto';
  $('#photoModalImg').removeAttribute('src');
  openModal('photoModal');
  $('#photoModalImg').src = await loadTaskPhotoUrl(id);
}

function mapsUrl(address) {
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(address);
}

// Link do endereço + botão da foto, usados na lista de tarefas e no calendário
function taskExtrasHtml(t) {
  let html = '';
  if (t.address) html += `<a class="task-link" href="${mapsUrl(t.address)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">📍 ${escapeHtml(t.address)}</a>`;
  if (t.hasPhoto) html += `<button type="button" class="task-link" onclick="event.stopPropagation(); openPhotoViewer('${t.id}')">📷 Ver foto</button>`;
  return html;
}

// Id usado no POST de criação: o mesmo em todos os reenvios deste formulário,
// então o servidor nunca cria a tarefa duas vezes.
let taskDraftId = null;

function openTaskModal(id, defaultDate) {
  const task = id ? state.tasks.find((t) => t.id === id) : null;
  taskDraftId = task ? null : genId();
  $('#taskModalTitle').textContent = task ? 'Editar Tarefa' : 'Nova Tarefa';
  $('#taskModalId').value = task ? task.id : '';
  $('#taskModalTitleInput').value = task ? task.title : '';
  $('#taskModalDate').value = task ? isoToBR(task.date) : isoToBR(defaultDate || todayISO());
  $('#taskModalEndDate').value = task ? isoToBR(task.endDate) : '';
  $('#taskModalTime').value = task ? (task.time || '') : '';
  $('#taskModalPriority').value = task && task.priority ? String(task.priority) : '';
  $('#taskModalObs').value = task ? (task.obs || '') : '';
  $('#taskModalAddress').value = task ? (task.address || '') : '';
  $('#taskModalNotify').checked = task ? !!task.notify : true;

  taskPhotoDraft = { dataUrl: null, remove: false, existing: !!(task && task.hasPhoto) };
  showTaskPhotoPreview(null);
  if (task && task.hasPhoto) {
    loadTaskPhotoUrl(task.id).then((url) => {
      if ($('#taskModalId').value === task.id && !taskPhotoDraft.dataUrl && !taskPhotoDraft.remove) showTaskPhotoPreview(url);
    }).catch(() => {});
  }

  resetClock();
  syncPriorityPicker();
  // Abre as opções extras só quando a tarefa já usa alguma delas
  toggleTaskAdvanced(!!(task && (task.endDate || task.obs || task.address || task.hasPhoto)));

  openModal('taskModal');
  setTimeout(() => $('#taskModalTitleInput').focus(), 120);
}

function saveTaskModal(btn) {
  return runOnce('task-save', btn, doSaveTaskModal);
}

// Identifica qual formulário está aberto (edição: id da tarefa; nova: id do rascunho)
function taskFormKey() { return $('#taskModalId').value || taskDraftId; }

async function doSaveTaskModal() {
  const id = $('#taskModalId').value;
  const formKey = taskFormKey();
  const draftId = taskDraftId;
  const photo = { ...taskPhotoDraft };
  const title = $('#taskModalTitleInput').value.trim();
  if (!title) return alert('Dê um título à tarefa.');
  const dateBR = $('#taskModalDate').value.trim();
  const date = dateBR ? brToISO(dateBR) : null;
  if (dateBR && !date) return alert('Data inválida. Use o formato dd/mm/aaaa.');
  const endBR = $('#taskModalEndDate').value.trim();
  const endDate = endBR ? brToISO(endBR) : null;
  if (endBR && !endDate) return alert('Data final inválida. Use o formato dd/mm/aaaa.');
  if (date && endDate && endDate < date) return alert('A data final deve ser igual ou depois da data inicial.');
  const timeBR = $('#taskModalTime').value.trim();
  let time = null;
  if (timeBR) {
    time = parseTime24(timeBR);
    if (!time) return alert('Horário inválido. Use o formato 24h, ex: 08:00 ou 23:59.');
  }
  const priorityVal = $('#taskModalPriority').value;
  const priority = priorityVal ? parseInt(priorityVal, 10) : null;
  const obs = $('#taskModalObs').value.trim() || null;
  const address = $('#taskModalAddress').value.trim() || null;
  const notify = $('#taskModalNotify').checked;
  if (notify) ensureNotificationPermission();

  let saved;
  if (id) {
    saved = await api(`/api/tasks/${id}`, 'PUT', { title, date, endDate, time, priority, obs, address, notify });
  } else {
    saved = await api('/api/tasks', 'POST', { id: draftId, title, date, endDate, time, priority, obs, address, notify });
  }

  if (photo.dataUrl) {
    saved = await api(`/api/tasks/${saved.id}/photo`, 'PUT', { dataUrl: photo.dataUrl });
    forgetTaskPhoto(saved.id);
  } else if (photo.remove) {
    saved = await api(`/api/tasks/${saved.id}/photo`, 'DELETE');
    forgetTaskPhoto(saved.id);
  }

  const idx = state.tasks.findIndex((t) => t.id === saved.id);
  if (idx >= 0) state.tasks[idx] = saved; else state.tasks.push(saved);

  // Se o usuário já abriu outro formulário enquanto salvava, não mexe nele
  if (taskFormKey() === formKey) {
    taskPhotoDraft = { dataUrl: null, remove: false, existing: saved.hasPhoto };
    closeModal('taskModal');
  }
  renderAll();
  refreshDaySheet();
}

function patchTask(id, fields) {
  return runOnce('task:' + id, null, async () => {
    const updated = await api(`/api/tasks/${id}`, 'PUT', fields);
    const idx = state.tasks.findIndex((t) => t.id === id);
    state.tasks[idx] = updated;
    renderAll();
    refreshDaySheet();
  });
}

function completeTask(id) { return patchTask(id, { done: true }); }
function reopenTask(id) { return patchTask(id, { done: false }); }

// ---- Reagendar: escolhe a nova data na hora, sem mandar pra "depois" ---- //
function openRescheduleModal(id) {
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return;
  $('#rescheduleId').value = id;
  $('#rescheduleTaskTitle').textContent = task.title;
  const suggestion = task.date && task.date >= todayISO() ? task.date : addDays(todayISO(), 1);
  $('#rescheduleDate').value = isoToBR(suggestion);
  openModal('rescheduleModal');
}

function setRescheduleOffset(n) {
  $('#rescheduleDate').value = isoToBR(addDays(todayISO(), n));
}

function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
}

function saveReschedule(btn) {
  return runOnce('reschedule', btn, async () => {
    const id = $('#rescheduleId').value;
    const task = state.tasks.find((t) => t.id === id);
    if (!task) return closeModal('rescheduleModal');
    const date = brToISO($('#rescheduleDate').value);
    if (!date) return alert('Data inválida. Use o formato dd/mm/aaaa.');
    // Tarefa com período: mantém a mesma duração a partir da nova data
    const endDate = task.date && task.endDate && task.endDate > task.date
      ? addDays(date, daysBetween(task.date, task.endDate))
      : null;
    const updated = await api(`/api/tasks/${id}`, 'PUT', { date, endDate, done: false });
    const idx = state.tasks.findIndex((t) => t.id === id);
    state.tasks[idx] = updated;
    closeModal('rescheduleModal');
    renderAll();
    refreshDaySheet();
  });
}

function confirmDeleteTask(id) {
  const task = state.tasks.find((t) => t.id === id);
  showConfirm(`Excluir a tarefa "${task.title}"?`, async () => {
    await api(`/api/tasks/${id}`, 'DELETE');
    forgetTaskPhoto(id);
    state.tasks = state.tasks.filter((t) => t.id !== id);
    closeModal('confirmModal');
    renderAll();
  });
}

// Exclusão definitiva (também do banco) de todas as tarefas sem data ou concluídas
function confirmBulkDeleteTasks(scope) {
  const match = scope === 'backlog' ? (t) => !t.date && !t.done : (t) => t.done;
  const count = state.tasks.filter(match).length;
  if (!count) return;
  const what = scope === 'backlog' ? 'sem data' : 'concluídas';
  showConfirm(`Apagar definitivamente ${count} tarefa(s) ${what}? Isso não pode ser desfeito.`, async () => {
    await api('/api/tasks/bulk-delete', 'POST', { scope });
    state.tasks.filter(match).forEach((t) => forgetTaskPhoto(t.id));
    state.tasks = state.tasks.filter((t) => !match(t));
    closeModal('confirmModal');
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

function addStep(projectId, inputEl) {
  return runOnce('step-add:' + projectId, null, () => doAddStep(projectId, inputEl));
}

async function doAddStep(projectId, inputEl) {
  const title = inputEl.value.trim();
  if (!title) return;
  const updated = await api(`/api/projects/${projectId}/steps`, 'POST', { title });
  replaceProject(updated);
  renderAll();
}

function toggleStep(pid, sid, done) {
  return runOnce('step:' + sid, null, () => doToggleStep(pid, sid, done));
}

async function doToggleStep(pid, sid, done) {
  const updated = await api(`/api/projects/${pid}/steps/${sid}`, 'PUT', { done });
  replaceProject(updated);
  renderAll();
}

function deleteStep(pid, sid) {
  return runOnce('step:' + sid, null, () => doDeleteStep(pid, sid));
}

async function doDeleteStep(pid, sid) {
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

function reopenProject(id) {
  return runOnce('project:' + id, null, () => doReopenProject(id));
}

async function doReopenProject(id) {
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

function saveProject(btn) {
  return runOnce('project-save', btn, () => doSaveProject());
}

async function doSaveProject() {
  const title = $('#projectTitle').value.trim();
  if (!title) return alert('Dê um título ao projeto.');
  const created = await api('/api/projects', 'POST', { title });
  state.projects.push(created);
  $('#projectTitle').value = '';
  closeModals();
  renderAll();
}

// ===================== Compras ===================== //
function catName(id) {
  const c = state.shoppingCategories.find((x) => x.id === id);
  return c ? c.name : id;
}

function renderShopping() {
  const el = $('#shoppingView');
  if (currentShoppingCat && !state.shoppingCategories.some((c) => c.id === currentShoppingCat)) {
    currentShoppingCat = null;
  }
  if (currentShoppingCat == null) { renderShoppingFolders(el); return; }
  renderShoppingCategory(el, currentShoppingCat);
}

function renderShoppingFolders(el) {
  const folders = state.shoppingCategories.map((c) => {
    const items = state.shopping[c.id] || [];
    const pending = items.filter((i) => !i.done).length;
    return `
      <button class="folder-card" onclick="openShoppingCat('${c.id}')">
        <span class="folder-icon">📁</span>
        <span class="folder-name">${escapeHtml(c.name)}</span>
        <span class="folder-count">${pending ? pending + ' pendente(s)' : 'vazia'}</span>
      </button>`;
  }).join('');
  el.innerHTML = `
    <div class="folder-grid">${folders || '<div class="empty-state">Nenhuma categoria.</div>'}</div>
    <button class="btn-submit" style="margin-top:16px" onclick="addShoppingCategory()">+ Nova categoria</button>
  `;
}

function renderShoppingCategory(el, catId) {
  const items = state.shopping[catId] || [];
  const itemsHtml = items.length
    ? items.map((it) => `
        <div class="list-item ${it.done ? 'done' : ''}">
          <button class="check-circle" onclick="toggleShoppingItem('${it.id}',${!it.done})">${it.done ? '✓' : ''}</button>
          <div class="item-content"><div class="item-title">${escapeHtml(it.name)}</div></div>
          <div class="item-actions"><button class="icon-btn" title="Excluir" onclick="deleteShoppingItem('${it.id}')">🗑</button></div>
        </div>`).join('')
    : '<div class="empty-state">Lista vazia.</div>';

  el.innerHTML = `
    <div class="shopping-header">
      <button class="icon-btn" title="Voltar" onclick="backToFolders()">◀</button>
      <h3 class="section-title" style="flex:1">${escapeHtml(catName(catId))}</h3>
      <button class="icon-btn" title="Renomear" onclick="renameShoppingCategory('${catId}')">✏️</button>
      <button class="icon-btn" title="Excluir categoria" onclick="deleteShoppingCategory('${catId}')">🗑</button>
    </div>
    <div class="shopping-input-row">
      <input type="text" id="shoppingItemInput" class="form-control" placeholder="Adicionar item..." onkeydown="if(event.key==='Enter') addShoppingItem('${catId}')">
      <button class="btn-add" onclick="addShoppingItem('${catId}')">+</button>
    </div>
    <button class="link-btn" style="margin:4px 0 8px" onclick="clearShoppingDone('${catId}')">Limpar concluídos</button>
    <div class="item-list">${itemsHtml}</div>
  `;
}

function openShoppingCat(id) {
  currentShoppingCat = id;
  renderShopping();
  const input = $('#shoppingItemInput');
  if (input) input.focus();
}
function backToFolders() { currentShoppingCat = null; renderShopping(); }

function addShoppingCategory() {
  return runOnce('shop-cat-add', null, () => doAddShoppingCategory());
}

async function doAddShoppingCategory() {
  const name = window.prompt('Nome da nova categoria:');
  if (!name || !name.trim()) return;
  const created = await api('/api/shopping-categories', 'POST', { name: name.trim() });
  state.shoppingCategories.push(created);
  state.shopping[created.id] = [];
  renderShopping();
}

async function renameShoppingCategory(id) {
  const name = window.prompt('Novo nome da categoria:', catName(id));
  if (!name || !name.trim()) return;
  const updated = await api(`/api/shopping-categories/${id}`, 'PUT', { name: name.trim() });
  const c = state.shoppingCategories.find((x) => x.id === id);
  if (c) c.name = updated.name;
  renderShopping();
}

function deleteShoppingCategory(id) {
  const count = (state.shopping[id] || []).length;
  const msg = count ? `Excluir a categoria "${catName(id)}" e seus ${count} item(ns)?` : `Excluir a categoria "${catName(id)}"?`;
  showConfirm(msg, async () => {
    await api(`/api/shopping-categories/${id}`, 'DELETE');
    state.shoppingCategories = state.shoppingCategories.filter((c) => c.id !== id);
    delete state.shopping[id];
    currentShoppingCat = null;
    closeModals();
    renderShopping();
  });
}

function addShoppingItem(category) {
  return runOnce('shop-add:' + category, null, () => doAddShoppingItem(category));
}

async function doAddShoppingItem(category) {
  const input = $('#shoppingItemInput');
  const name = input.value.trim();
  if (!name) return;
  const created = await api('/api/shopping', 'POST', { category, name });
  if (!state.shopping[category]) state.shopping[category] = [];
  state.shopping[category].push(created);
  input.value = '';
  renderShopping();
  $('#shoppingItemInput').focus();
}

function toggleShoppingItem(id, done) {
  return runOnce('shop:' + id, null, () => doToggleShoppingItem(id, done));
}

async function doToggleShoppingItem(id, done) {
  const updated = await api(`/api/shopping/${id}`, 'PUT', { done });
  for (const cat of Object.keys(state.shopping)) {
    const idx = state.shopping[cat].findIndex((i) => i.id === id);
    if (idx >= 0) state.shopping[cat][idx] = { id: updated.id, name: updated.name, done: updated.done };
  }
  renderShopping();
}

function deleteShoppingItem(id) {
  showConfirm('Excluir este item?', async () => {
    await api(`/api/shopping/${id}`, 'DELETE');
    for (const cat of Object.keys(state.shopping)) state.shopping[cat] = state.shopping[cat].filter((i) => i.id !== id);
    closeModals();
    renderShopping();
  });
}

function clearShoppingDone(category) {
  const doneItems = (state.shopping[category] || []).filter((i) => i.done);
  if (!doneItems.length) return;
  showConfirm(`Remover ${doneItems.length} item(ns) concluído(s)?`, async () => {
    // remove do estado local item a item, para não dessincronizar se um falhar
    for (const it of doneItems) {
      await api(`/api/shopping/${it.id}`, 'DELETE');
      state.shopping[category] = state.shopping[category].filter((i) => i.id !== it.id);
    }
    closeModals();
    renderShopping();
  });
}

// ===================== Recorrentes ===================== //
function currentMonthKey() { const t = new Date(); return `${t.getFullYear()}-${pad(t.getMonth() + 1)}`; }

function renderRecurring() {
  const el = $('#recurringList');
  if (!state.recurring.length) { el.innerHTML = '<div class="empty-state">Nenhum lembrete mensal. Toque em + para criar.</div>'; return; }
  const mk = currentMonthKey();
  el.innerHTML = state.recurring.map((r) => {
    const pending = !isRecurringDone(r, mk);
    return `
      <div class="list-item ${pending ? '' : 'done'}">
        <button class="check-circle" onclick="toggleRecurringMonth('${r.id}','${mk}')">${pending ? '' : '✓'}</button>
        <div class="item-content">
          <div class="item-title">🔁 ${escapeHtml(r.title)}</div>
          <div class="item-meta"><span>Todo dia ${r.dayOfMonth}</span><span>${pending ? 'pendente este mês' : 'feito este mês'}</span></div>
        </div>
        <div class="item-actions">
          <button class="icon-btn" title="Editar" onclick="openRecurringModal('${r.id}')">✏️</button>
          <button class="icon-btn" title="Excluir" onclick="confirmDeleteRecurring('${r.id}')">🗑</button>
        </div>
      </div>`;
  }).join('');
}

function toggleRecurringMonth(id, mk) {
  return runOnce('rec:' + id, null, () => doToggleRecurringMonth(id, mk));
}

async function doToggleRecurringMonth(id, mk) {
  const r = state.recurring.find((x) => x.id === id);
  if (!r) return;
  const updated = await api(`/api/recurring/${id}`, 'PUT', { month: mk, done: !isRecurringDone(r, mk) });
  Object.assign(r, updated);
  renderAll();
  refreshDaySheet();
}

function openRecurringModal(id) {
  const r = id ? state.recurring.find((x) => x.id === id) : null;
  $('#recurringModalTitle').textContent = r ? 'Editar Recorrente' : 'Novo Recorrente';
  $('#recurringModalId').value = r ? r.id : '';
  $('#recurringTitleInput').value = r ? r.title : '';
  $('#recurringDayInput').value = r ? r.dayOfMonth : '';
  $('#recurringNotify').checked = r ? !!r.notify : false;
  openModal('recurringModal');
}

function saveRecurringModal(btn) {
  return runOnce('rec-save', btn, () => doSaveRecurringModal());
}

async function doSaveRecurringModal() {
  const id = $('#recurringModalId').value;
  const title = $('#recurringTitleInput').value.trim();
  if (!title) return alert('Dê um título ao lembrete.');
  const dayOfMonth = parseInt($('#recurringDayInput').value, 10);
  if (!dayOfMonth || dayOfMonth < 1 || dayOfMonth > 31) return alert('Informe o dia do mês (1 a 31).');
  const notify = $('#recurringNotify').checked;
  if (id) {
    const updated = await api(`/api/recurring/${id}`, 'PUT', { title, dayOfMonth, notify });
    const idx = state.recurring.findIndex((x) => x.id === id);
    state.recurring[idx] = updated;
  } else {
    const created = await api('/api/recurring', 'POST', { title, dayOfMonth, notify });
    state.recurring.push(created);
  }
  closeModals();
  renderAll();
}

function confirmDeleteRecurring(id) {
  const r = state.recurring.find((x) => x.id === id);
  showConfirm(`Excluir o recorrente "${r.title}"?`, async () => {
    await api(`/api/recurring/${id}`, 'DELETE');
    state.recurring = state.recurring.filter((x) => x.id !== id);
    closeModals();
    renderAll();
  });
}

// ===================== Configurações ===================== //
function openConfigModal() {
  $('#anchorDiaDate').value = isoToBR(state.config.anchorDate);
  const folgaDays = (state.config.cycleLength || 3) - 1;
  $('#folgaDays').value = folgaDays >= 1 ? folgaDays : 2;
  openModal('configModal');
}

function saveConfig(btn) {
  return runOnce('config', btn, () => doSaveConfig());
}

async function doSaveConfig() {
  const anchorDate = brToISO($('#anchorDiaDate').value);
  if (!anchorDate) return alert('Informe a data de um dia de TRABALHO no formato dd/mm/aaaa.');
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

async function showAppNotification(title, body, tag) {
  // getRegistration (e não .ready) para não travar se o service worker não registrou
  const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
  const opts = { body, tag, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png' };
  if (reg) return reg.showNotification(title, opts);
  new Notification(title, opts);
}

async function checkDueNotifications() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const today = todayISO();
  const notified = getNotifiedToday();
  const newlyNotified = [];

  for (const t of state.tasks) {
    if (taskOccursOn(t, today) && !t.done && t.notify && !notified.includes('task:' + t.id)) {
      await showAppNotification('Tarefa de hoje', t.title, 'task:' + t.id);
      newlyNotified.push('task:' + t.id);
    }
  }

  const sp = state.specials[today];
  if (sp && sp.notify && !notified.includes('special:' + today)) {
    await showAppNotification('Especial hoje', `${sp.start} às ${sp.end}`, 'special:' + today);
    newlyNotified.push('special:' + today);
  }

  const mk = monthKeyOf(today);
  for (const r of recurringForDate(today)) {
    if (r.notify && !isRecurringDone(r, mk) && !notified.includes('recurring:' + r.id)) {
      await showAppNotification('Lembrete mensal', r.title, 'recurring:' + r.id);
      newlyNotified.push('recurring:' + r.id);
    }
  }

  if (newlyNotified.length) saveNotifiedToday([...notified, ...newlyNotified]);
}

// ===================== Botão voltar (celular) ===================== //
// Mantém sempre uma entrada "guarda" no histórico acima da página. Cada
// "voltar" consome a guarda e dispara popstate: fechamos o modal do topo,
// saímos da pasta, voltamos pro Calendário... e só na tela inicial
// perguntamos se quer sair (sem re-armar, então o próximo voltar fecha o app).
let backGuardArmed = false;

function armBackGuard() {
  if (backGuardArmed || !getToken() || $('#app').classList.contains('hidden')) return;
  if (history.state && history.state.agendaGuard) { backGuardArmed = true; return; }
  history.pushState({ agendaGuard: true }, '');
  backGuardArmed = true;
}

function handleBack() {
  if (modalStack.length) { closeTopModal(); return true; }
  if (currentTab === 'shopping' && currentShoppingCat) { backToFolders(); return true; }
  if (currentTab !== 'calendar') { switchTab('calendar'); return true; }
  return false;
}

window.addEventListener('popstate', () => {
  backGuardArmed = false;
  if (!getToken() || $('#app').classList.contains('hidden')) return;
  if (handleBack()) { armBackGuard(); return; }
  $('#exitHint').classList.add('hidden');
  openModal('exitModal');
});

function cancelExit() {
  closeModal('exitModal');
}

function confirmExit() {
  window.close();
  // Se o navegador não deixar fechar via script, o histórico já está na
  // primeira entrada: mais um "voltar" do sistema fecha o app.
  setTimeout(() => $('#exitHint').classList.remove('hidden'), 300);
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
  buildTaskPickers();
  if (getToken()) boot();
  registerServiceWorker();
  setupInstallPrompt();

  let lastSeenDay = todayISO();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !getToken()) return;
    checkDueNotifications();
    if (todayISO() !== lastSeenDay) {
      lastSeenDay = todayISO();
      currentDate = new Date();
      if (currentTab === 'calendar') renderCalendar(true);
    }
  });
  setInterval(() => { if (getToken()) checkDueNotifications(); }, 5 * 60 * 1000);
})();
