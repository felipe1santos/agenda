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
`);

if (!db.prepare('SELECT id FROM config WHERE id = 1').get()) {
  db.prepare('INSERT INTO config (id, anchor_date, cycle_length) VALUES (1, NULL, 9)').run();
}

// ---------- Migrações leves (colunas novas em bancos já existentes) ----------
for (const stmt of [
  'ALTER TABLE tasks ADD COLUMN notify INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE specials ADD COLUMN notify INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE project_steps ADD COLUMN obs TEXT',
]) {
  try { db.exec(stmt); } catch (e) { /* coluna já existe */ }
}

// ---------- Auth ----------
const SERVER_SECRET = crypto.randomBytes(32).toString('hex');
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
app.use(express.json());

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

  const tasks = db.prepare('SELECT * FROM tasks ORDER BY created_at ASC').all().map((t) => ({
    id: t.id,
    title: t.title,
    date: t.date,
    priority: t.priority,
    obs: t.obs,
    done: !!t.done,
    notify: !!t.notify,
  }));

  const projectRows = db.prepare('SELECT * FROM projects ORDER BY created_at ASC').all();
  const projects = projectRows.map((p) => {
    const steps = db.prepare('SELECT * FROM project_steps WHERE project_id = ? ORDER BY position ASC').all(p.id);
    return serializeProject(p, steps);
  });

  const shopping = { mercado: [], avulso: [] };
  for (const row of db.prepare('SELECT * FROM shopping_items ORDER BY created_at ASC').all()) {
    shopping[row.category].push({ id: row.id, name: row.name, done: !!row.done });
  }

  res.json({ config, specials, tasks, projects, shopping });
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
app.post('/api/tasks', (req, res) => {
  const { title, date, priority, obs, notify } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'title é obrigatório' });
  const id = uuid();
  db.prepare(`
    INSERT INTO tasks (id, title, date, priority, obs, done, created_at, notify)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?)
  `).run(id, title.trim(), date || null, priority ?? null, obs || null, now(), toBool(notify));
  res.status(201).json({ id, title: title.trim(), date: date || null, priority: priority ?? null, obs: obs || null, done: false, notify: !!notify });
});

app.put('/api/tasks/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const body = req.body || {};
  const title = Object.prototype.hasOwnProperty.call(body, 'title') ? body.title : existing.title;
  const date = Object.prototype.hasOwnProperty.call(body, 'date') ? body.date : existing.date;
  const priority = Object.prototype.hasOwnProperty.call(body, 'priority') ? body.priority : existing.priority;
  const obs = Object.prototype.hasOwnProperty.call(body, 'obs') ? body.obs : existing.obs;
  const done = Object.prototype.hasOwnProperty.call(body, 'done') ? toBool(body.done) : existing.done;
  const notify = Object.prototype.hasOwnProperty.call(body, 'notify') ? toBool(body.notify) : existing.notify;

  db.prepare('UPDATE tasks SET title = ?, date = ?, priority = ?, obs = ?, done = ?, notify = ? WHERE id = ?')
    .run(title, date, priority, obs, done, notify, req.params.id);

  res.json({ id: req.params.id, title, date, priority, obs, done: !!done, notify: !!notify });
});

app.delete('/api/tasks/:id', (req, res) => {
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

// ---------- Shopping ----------
app.post('/api/shopping', (req, res) => {
  const { category, name } = req.body || {};
  if (!['mercado', 'avulso'].includes(category)) return res.status(400).json({ error: 'category inválida' });
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
