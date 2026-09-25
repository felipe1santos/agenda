const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'agenda.db');
const APP_PASSWORD = process.env.APP_PASSWORD || 'agenda123';

if (!process.env.APP_PASSWORD) {
  console.warn('[agenda] APP_PASSWORD não definida — usando senha padrão "agenda123". Defina a variável de ambiente em produção.');
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

// ---------- Schema ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    anchor_date TEXT,
    cycle_length INTEGER NOT NULL DEFAULT 9
  );

  CREATE TABLE IF NOT EXISTS specials (
    date TEXT PRIMARY KEY,
    start TEXT NOT NULL,
    end TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    date TEXT,
    priority INTEGER,
    obs TEXT,
    done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS project_steps (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS shopping_items (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL CHECK(category IN ('mercado','avulso')),
    name TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS shopping_categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS recurring_items (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    day_of_month INTEGER NOT NULL,
    last_done_month TEXT,
    notify INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS abonos (
    date TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS vacations (
    id TEXT PRIMARY KEY,
    start TEXT NOT NULL,
    end TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

// Remove CHECK fixo de shopping_items.category (permite categorias custom)
{
  const t = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='shopping_items'").get();
  if (t && /CHECK\s*\(\s*category/i.test(t.sql)) {
    db.exec(`
      CREATE TABLE shopping_items_new (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        name TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      INSERT INTO shopping_items_new SELECT id, category, name, done, created_at FROM shopping_items;
      DROP TABLE shopping_items;
      ALTER TABLE shopping_items_new RENAME TO shopping_items;
    `);
  }
}

// Seed categorias padrão (ids casam com dados antigos)
if (!db.prepare('SELECT id FROM shopping_categories LIMIT 1').get()) {
  const ts = new Date().toISOString();
  db.prepare('INSERT INTO shopping_categories (id, name, position, created_at) VALUES (?, ?, ?, ?)').run('mercado', 'Mercado', 0, ts);
  db.prepare('INSERT INTO shopping_categories (id, name, position, created_at) VALUES (?, ?, ?, ?)').run('avulso', 'Avulso', 1, ts);
}

if (!db.prepare('SELECT id FROM config WHERE id = 1').get()) {
  db.prepare('INSERT INTO config (id, anchor_date, cycle_length) VALUES (1, NULL, 9)').run();
}

// ---------- Migrações leves (colunas novas em bancos já existentes) ----------
for (const stmt of [
  'ALTER TABLE tasks ADD COLUMN notify INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE specials ADD COLUMN notify INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE project_steps ADD COLUMN obs TEXT',
  'ALTER TABLE tasks ADD COLUMN end_date TEXT',
  'ALTER TABLE tasks ADD COLUMN time TEXT',
  'ALTER TABLE tasks ADD COLUMN address TEXT',
  'ALTER TABLE tasks ADD COLUMN has_photo INTEGER NOT NULL DEFAULT 0',
]) {
  try { db.exec(stmt); } catch (e) { /* coluna já existe */ }
}

// ---------- Auth ----------
// Segredo persistido no volume de dados: o token salvo no celular continua
// válido após deploy/restart (antes era aleatório a cada start e deslogava).
// Trocar APP_PASSWORD invalida todos os tokens.
function loadServerSecret() {
  const file = path.join(path.dirname(DB_PATH), '.session-secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch (e) { /* primeiro start */ }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}
const SERVER_SECRET = loadServerSecret();
const VALID_TOKEN = crypto.createHmac('sha256', SERVER_SECRET).update(APP_PASSWORD).digest('hex');

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token || token !== VALID_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// ---------- App ----------
const app = express();
// Limite maior por causa das fotos das tarefas (já chegam reduzidas pelo cliente)
app.use(express.json({ limit: '8mb' }));

app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (password !== APP_PASSWORD) {
    return res.status(401).json({ error: 'invalid_password' });
  }
  res.json({ token: VALID_TOKEN });
});

app.use('/api', requireAuth);

// ---------- Helpers ----------
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const toBool = (v) => (v ? 1 : 0);

function getProjectWithSteps(projectId) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) return null;
  const steps = db.prepare('SELECT * FROM project_steps WHERE project_id = ? ORDER BY position ASC').all(projectId);
  return serializeProject(project, steps);
}

function serializeProject(project, steps) {
  return {
    id: project.id,
    title: project.title,
    done: !!project.done,
    createdAt: project.created_at,
    steps: steps.map((s) => ({ id: s.id, title: s.title, done: !!s.done, obs: s.obs })),
  };
}

function recomputeProjectDone(projectId) {
  const steps = db.prepare('SELECT done FROM project_steps WHERE project_id = ?').all(projectId);
  const done = steps.length > 0 && steps.every((s) => !!s.done);
  db.prepare('UPDATE projects SET done = ? WHERE id = ?').run(toBool(done), projectId);
}

// ---------- State ----------
app.get('/api/state', (req, res) => {
  const configRow = db.prepare('SELECT * FROM config WHERE id = 1').get();
  const config = {
    anchorDate: configRow.anchor_date,
    cycleLength: configRow.cycle_length,
  };

  const specials = {};
  for (const row of db.prepare('SELECT * FROM specials').all()) {
    specials[row.date] = { start: row.start, end: row.end, notify: !!row.notify };
  }

  const tasks = db.prepare('SELECT * FROM tasks ORDER BY created_at ASC').all().map(serializeTask);

  const abonos = {};
  for (const row of db.prepare('SELECT * FROM abonos').all()) abonos[row.date] = true;

  const projectRows = db.prepare('SELECT * FROM projects ORDER BY created_at ASC').all();
  const projects = projectRows.map((p) => {
    const steps = db.prepare('SELECT * FROM project_steps WHERE project_id = ? ORDER BY position ASC').all(p.id);
    return serializeProject(p, steps);
  });

  const shoppingCategories = db.prepare('SELECT * FROM shopping_categories ORDER BY position ASC, created_at ASC').all()
    .map((c) => ({ id: c.id, name: c.name }));

  const shopping = {};
  for (const c of shoppingCategories) shopping[c.id] = [];
  for (const row of db.prepare('SELECT * FROM shopping_items ORDER BY created_at ASC').all()) {
    if (!shopping[row.category]) shopping[row.category] = [];
    shopping[row.category].push({ id: row.id, name: row.name, done: !!row.done });
  }

  const recurring = db.prepare('SELECT * FROM recurring_items ORDER BY day_of_month ASC, created_at ASC').all().map((r) => ({
    id: r.id,
    title: r.title,
    dayOfMonth: r.day_of_month,
    lastDoneMonth: r.last_done_month,
    notify: !!r.notify,
  }));

  const vacations = db.prepare('SELECT * FROM vacations ORDER BY start ASC').all()
    .map((v) => ({ id: v.id, start: v.start, end: v.end }));

  res.json({ config, specials, tasks, projects, shopping, shoppingCategories, recurring, abonos, vacations });
});

// ---------- Config ----------
app.put('/api/config', (req, res) => {
  const { anchorDate, cycleLength } = req.body || {};
  const length = parseInt(cycleLength, 10);
  if (!Number.isInteger(length) || length < 2) {
    return res.status(400).json({ error: 'cycleLength deve ser um inteiro >= 2' });
  }
  if (anchorDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(anchorDate || '')) {
    return res.status(400).json({ error: 'anchorDate inválida' });
  }
  db.prepare('UPDATE config SET anchor_date = ?, cycle_length = ? WHERE id = 1').run(anchorDate || null, length);
  res.json({ anchorDate: anchorDate || null, cycleLength: length });
});

// ---------- Specials ----------
app.put('/api/specials/:date', (req, res) => {
  const { date } = req.params;
  const { start, end, notify } = req.body || {};
  if (!start || !end) return res.status(400).json({ error: 'start e end são obrigatórios' });
  db.prepare(`
    INSERT INTO specials (date, start, end, notify) VALUES (?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET start = excluded.start, end = excluded.end, notify = excluded.notify
  `).run(date, start, end, toBool(notify));
  res.json({ date, start, end, notify: !!notify });
});

app.delete('/api/specials/:date', (req, res) => {
  db.prepare('DELETE FROM specials WHERE date = ?').run(req.params.date);
  res.status(204).end();
});

// ---------- Tasks ----------
const validTime = (v) => (v && /^\d{2}:\d{2}$/.test(v) ? v : null);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLIENT_ID = /^[0-9a-f-]{16,64}$/i;

// Fotos das tarefas ficam em arquivo (no mesmo volume do banco), não no SQLite
const PHOTO_DIR = path.join(path.dirname(DB_PATH), 'photos');
fs.mkdirSync(PHOTO_DIR, { recursive: true });
const photoPath = (id) => path.join(PHOTO_DIR, `${String(id).replace(/[^0-9a-z-]/gi, '')}.jpg`);
const removePhoto = (id) => { try { fs.unlinkSync(photoPath(id)); } catch (e) { /* sem foto */ } };

const cleanAddress = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : null);

function serializeTask(t) {
  return {
    id: t.id, title: t.title, date: t.date, endDate: t.end_date, time: t.time,
    priority: t.priority, obs: t.obs, address: t.address || null,
    hasPhoto: !!t.has_photo, done: !!t.done, notify: !!t.notify,
  };
}

const getTask = (id) => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);

app.post('/api/tasks', (req, res) => {
  const { id: clientId, title, date, endDate, time, priority, obs, address, notify } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'title é obrigatório' });
  // Idempotente: reenvios do mesmo formulário (clique repetido / rede lenta) mandam o mesmo id
  const validClientId = clientId && CLIENT_ID.test(clientId) ? clientId : null;
  if (validClientId) {
    const existing = getTask(validClientId);
    if (existing) return res.status(200).json(serializeTask(existing));
  }
  const end = date && endDate && ISO_DATE.test(endDate) && endDate > date ? endDate : null;
  const id = validClientId || uuid();
  db.prepare(`
    INSERT INTO tasks (id, title, date, end_date, time, priority, obs, address, done, created_at, notify)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(id, title.trim(), date || null, end, validTime(time), priority ?? null, obs || null, cleanAddress(address), now(), toBool(notify));
  res.status(201).json(serializeTask(getTask(id)));
});

app.put('/api/tasks/:id', (req, res) => {
  const existing = getTask(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const body = req.body || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const title = has('title') ? body.title : existing.title;
  const date = has('date') ? body.date : existing.date;
  const rawEnd = has('endDate') ? body.endDate : existing.end_date;
  const endDate = date && rawEnd && ISO_DATE.test(rawEnd) && rawEnd > date ? rawEnd : null;
  const time = validTime(has('time') ? body.time : existing.time);
  const priority = has('priority') ? body.priority : existing.priority;
  const obs = has('obs') ? body.obs : existing.obs;
  const address = has('address') ? cleanAddress(body.address) : existing.address;
  const done = has('done') ? toBool(body.done) : existing.done;
  const notify = has('notify') ? toBool(body.notify) : existing.notify;

  db.prepare('UPDATE tasks SET title = ?, date = ?, end_date = ?, time = ?, priority = ?, obs = ?, address = ?, done = ?, notify = ? WHERE id = ?')
    .run(title, date, endDate, time, priority, obs, address, done, notify, req.params.id);

  res.json(serializeTask(getTask(req.params.id)));
});

// ---- Foto da tarefa (JPEG já reduzido no cliente, enviado como data URL) ----
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

app.put('/api/tasks/:id/photo', (req, res) => {
  if (!getTask(req.params.id)) return res.status(404).json({ error: 'not_found' });
  const m = /^data:image\/(?:jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec((req.body || {}).dataUrl || '');
  if (!m) return res.status(400).json({ error: 'imagem inválida' });
  const buf = Buffer.from(m[1], 'base64');
  if (!buf.length || buf.length > MAX_PHOTO_BYTES) return res.status(400).json({ error: 'imagem muito grande' });
  fs.writeFileSync(photoPath(req.params.id), buf);
  db.prepare('UPDATE tasks SET has_photo = 1 WHERE id = ?').run(req.params.id);
  res.json(serializeTask(getTask(req.params.id)));
});

app.delete('/api/tasks/:id/photo', (req, res) => {
  if (!getTask(req.params.id)) return res.status(404).json({ error: 'not_found' });
  removePhoto(req.params.id);
  db.prepare('UPDATE tasks SET has_photo = 0 WHERE id = ?').run(req.params.id);
  res.json(serializeTask(getTask(req.params.id)));
});

app.get('/api/tasks/:id/photo', (req, res) => {
  const file = photoPath(req.params.id);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'not_found' });
  res.set('Cache-Control', 'private, no-cache');
  res.type('image/jpeg').sendFile(file);
});

// Exclusão definitiva em lote: 'backlog' (sem data, pendentes) ou 'done' (concluídas)
app.post('/api/tasks/bulk-delete', (req, res) => {
  const { scope } = req.body || {};
  const where = { backlog: 'date IS NULL AND done = 0', done: 'done = 1' }[scope];
  if (!where) return res.status(400).json({ error: 'scope inválido' });
  for (const { id } of db.prepare(`SELECT id FROM tasks WHERE ${where} AND has_photo = 1`).all()) removePhoto(id);
  const info = db.prepare(`DELETE FROM tasks WHERE ${where}`).run();
  db.exec('VACUUM');
  res.json({ deleted: Number(info.changes) });
});

app.delete('/api/tasks/:id', (req, res) => {
  removePhoto(req.params.id);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// ---------- Projects ----------
app.post('/api/projects', (req, res) => {
  const { title } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'title é obrigatório' });
  const id = uuid();
  db.prepare('INSERT INTO projects (id, title, done, created_at) VALUES (?, ?, 0, ?)').run(id, title.trim(), now());
  res.status(201).json(getProjectWithSteps(id));
});

app.delete('/api/projects/:id', (req, res) => {
  db.prepare('DELETE FROM project_steps WHERE project_id = ?').run(req.params.id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

app.put('/api/projects/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const body = req.body || {};
  const title = Object.prototype.hasOwnProperty.call(body, 'title') ? body.title.trim() : existing.title;
  const done = Object.prototype.hasOwnProperty.call(body, 'done') ? toBool(body.done) : existing.done;
  db.prepare('UPDATE projects SET title = ?, done = ? WHERE id = ?').run(title, done, req.params.id);
  res.json(getProjectWithSteps(req.params.id));
});

app.post('/api/projects/:id/steps', (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'not_found' });
  const { title, obs } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'title é obrigatório' });
  const maxPos = db.prepare('SELECT MAX(position) as maxPos FROM project_steps WHERE project_id = ?').get(req.params.id);
  const position = (maxPos.maxPos ?? -1) + 1;
  const id = uuid();
  db.prepare('INSERT INTO project_steps (id, project_id, title, done, position, obs) VALUES (?, ?, ?, 0, ?, ?)')
    .run(id, req.params.id, title.trim(), position, obs || null);
  recomputeProjectDone(req.params.id);
  res.status(201).json(getProjectWithSteps(req.params.id));
});

app.put('/api/projects/:pid/steps/:sid', (req, res) => {
  const step = db.prepare('SELECT * FROM project_steps WHERE id = ? AND project_id = ?').get(req.params.sid, req.params.pid);
  if (!step) return res.status(404).json({ error: 'not_found' });
  const body = req.body || {};
  const title = Object.prototype.hasOwnProperty.call(body, 'title') ? body.title.trim() : step.title;
  const done = Object.prototype.hasOwnProperty.call(body, 'done') ? toBool(body.done) : step.done;
  const obs = Object.prototype.hasOwnProperty.call(body, 'obs') ? body.obs : step.obs;
  db.prepare('UPDATE project_steps SET title = ?, done = ?, obs = ? WHERE id = ?').run(title, done, obs, req.params.sid);
  recomputeProjectDone(req.params.pid);
  res.json(getProjectWithSteps(req.params.pid));
});

app.delete('/api/projects/:pid/steps/:sid', (req, res) => {
  db.prepare('DELETE FROM project_steps WHERE id = ? AND project_id = ?').run(req.params.sid, req.params.pid);
  recomputeProjectDone(req.params.pid);
  res.json(getProjectWithSteps(req.params.pid));
});

// ---------- Shopping categorias ----------
const slugify = (s) => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'cat';

app.post('/api/shopping-categories', (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name é obrigatório' });
  let id = slugify(name.trim());
  while (db.prepare('SELECT id FROM shopping_categories WHERE id = ?').get(id)) id += '-' + Math.floor(Math.random() * 1000);
  const maxPos = db.prepare('SELECT MAX(position) AS m FROM shopping_categories').get().m;
  const position = (maxPos == null ? -1 : maxPos) + 1;
  db.prepare('INSERT INTO shopping_categories (id, name, position, created_at) VALUES (?, ?, ?, ?)').run(id, name.trim(), position, now());
  res.status(201).json({ id, name: name.trim() });
});

app.put('/api/shopping-categories/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM shopping_categories WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name é obrigatório' });
  db.prepare('UPDATE shopping_categories SET name = ? WHERE id = ?').run(name.trim(), req.params.id);
  res.json({ id: req.params.id, name: name.trim() });
});

app.delete('/api/shopping-categories/:id', (req, res) => {
  db.prepare('DELETE FROM shopping_items WHERE category = ?').run(req.params.id);
  db.prepare('DELETE FROM shopping_categories WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// ---------- Shopping ----------
app.post('/api/shopping', (req, res) => {
  const { category, name } = req.body || {};
  if (!db.prepare('SELECT id FROM shopping_categories WHERE id = ?').get(category)) return res.status(400).json({ error: 'category inválida' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'name é obrigatório' });
  const id = uuid();
  db.prepare('INSERT INTO shopping_items (id, category, name, done, created_at) VALUES (?, ?, ?, 0, ?)')
    .run(id, category, name.trim(), now());
  res.status(201).json({ id, category, name: name.trim(), done: false });
});

app.put('/api/shopping/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM shopping_items WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const body = req.body || {};
  const name = Object.prototype.hasOwnProperty.call(body, 'name') ? body.name.trim() : existing.name;
  const done = Object.prototype.hasOwnProperty.call(body, 'done') ? toBool(body.done) : existing.done;
  db.prepare('UPDATE shopping_items SET name = ?, done = ? WHERE id = ?').run(name, done, req.params.id);
  res.json({ id: req.params.id, category: existing.category, name, done: !!done });
});

app.delete('/api/shopping/:id', (req, res) => {
  db.prepare('DELETE FROM shopping_items WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// ---------- Abonos ----------
app.put('/api/abonos/:date', (req, res) => {
  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'data inválida' });
  db.prepare('INSERT INTO abonos (date, created_at) VALUES (?, ?) ON CONFLICT(date) DO NOTHING').run(date, now());
  res.json({ date });
});

app.delete('/api/abonos/:date', (req, res) => {
  db.prepare('DELETE FROM abonos WHERE date = ?').run(req.params.date);
  res.status(204).end();
});

// ---------- Férias ----------
app.post('/api/vacations', (req, res) => {
  const { start, end } = req.body || {};
  if (!ISO_DATE.test(start || '') || !ISO_DATE.test(end || '') || end < start) {
    return res.status(400).json({ error: 'período inválido' });
  }
  const dup = db.prepare('SELECT * FROM vacations WHERE start = ? AND end = ?').get(start, end);
  if (dup) return res.status(200).json({ id: dup.id, start: dup.start, end: dup.end });
  const id = uuid();
  db.prepare('INSERT INTO vacations (id, start, end, created_at) VALUES (?, ?, ?, ?)').run(id, start, end, now());
  res.status(201).json({ id, start, end });
});

app.delete('/api/vacations/:id', (req, res) => {
  db.prepare('DELETE FROM vacations WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// ---------- Recorrentes ----------
const serializeRecurring = (r) => ({ id: r.id, title: r.title, dayOfMonth: r.day_of_month, lastDoneMonth: r.last_done_month, notify: !!r.notify });

function clampDay(d) {
  const n = parseInt(d, 10);
  if (!Number.isInteger(n)) return null;
  return Math.min(Math.max(n, 1), 31);
}

app.post('/api/recurring', (req, res) => {
  const { title, dayOfMonth, notify } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'title é obrigatório' });
  const day = clampDay(dayOfMonth);
  if (day == null) return res.status(400).json({ error: 'dayOfMonth inválido' });
  const id = uuid();
  db.prepare('INSERT INTO recurring_items (id, title, day_of_month, last_done_month, notify, created_at) VALUES (?, ?, ?, NULL, ?, ?)')
    .run(id, title.trim(), day, toBool(notify), now());
  res.status(201).json(serializeRecurring(db.prepare('SELECT * FROM recurring_items WHERE id = ?').get(id)));
});

app.put('/api/recurring/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM recurring_items WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const body = req.body || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const title = has('title') ? String(body.title).trim() : existing.title;
  const day = has('dayOfMonth') ? clampDay(body.dayOfMonth) : existing.day_of_month;
  if (day == null) return res.status(400).json({ error: 'dayOfMonth inválido' });
  const notify = has('notify') ? toBool(body.notify) : existing.notify;
  const lastDoneMonth = has('lastDoneMonth') ? body.lastDoneMonth : existing.last_done_month;
  db.prepare('UPDATE recurring_items SET title = ?, day_of_month = ?, last_done_month = ?, notify = ? WHERE id = ?')
    .run(title, day, lastDoneMonth, notify, req.params.id);
  res.json(serializeRecurring(db.prepare('SELECT * FROM recurring_items WHERE id = ?').get(req.params.id)));
});

app.delete('/api/recurring/:id', (req, res) => {
  db.prepare('DELETE FROM recurring_items WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// ---------- Static frontend ----------
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[agenda] servidor rodando na porta ${PORT} (db: ${DB_PATH})`);
});
