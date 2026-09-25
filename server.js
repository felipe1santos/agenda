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
  'ALTER TABLE recurring_items ADD COLUMN done_months TEXT',
]) {
  try { db.exec(stmt); } catch (e) { /* coluna já existe */ }
}

// Recorrentes antigos: o único mês confirmado (last_done_month) vira a lista inicial
db.exec("UPDATE recurring_items SET done_months = CASE WHEN last_done_month IS NULL THEN '[]' ELSE json_array(last_done_month) END WHERE done_months IS NULL");

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

const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token || !safeEqual(token, VALID_TOKEN)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// Limite de tentativas de senha por IP (em memória): 10 erros a cada 15 min
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 10;
const loginFails = new Map();

function loginBlocked(ip) {
  const entry = loginFails.get(ip);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) { loginFails.delete(ip); return false; }
  return entry.count >= LOGIN_MAX_FAILS;
}

function registerLoginFail(ip) {
  const entry = loginFails.get(ip);
  if (!entry || Date.now() > entry.resetAt) loginFails.set(ip, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
  else entry.count++;
}

// ---------- App ----------
const app = express();
// Atrás do proxy do Coolify: confia só no primeiro salto para obter o IP real
app.set('trust proxy', 1);

// JSON pequeno por padrão; a rota de foto (autenticada) usa limite maior
const smallJson = express.json({ limit: '200kb' });
const photoJson = express.json({ limit: '8mb' });
const isPhotoRoute = (req) => /^\/api\/tasks\/[^/]+\/photo$/.test(req.path) && req.method === 'PUT';
app.use((req, res, next) => (isPhotoRoute(req) ? next() : smallJson(req, res, next)));

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (loginBlocked(ip)) return res.status(429).json({ error: 'muitas tentativas, aguarde alguns minutos' });
  const { password } = req.body || {};
  if (typeof password !== 'string' || !safeEqual(password, APP_PASSWORD)) {
    registerLoginFail(ip);
    return res.status(401).json({ error: 'invalid_password' });
  }
  loginFails.delete(ip);
  res.json({ token: VALID_TOKEN });
});

app.use('/api', requireAuth);
app.use((req, res, next) => (isPhotoRoute(req) ? photoJson(req, res, next) : next()));

// ---------- Helpers ----------
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const toBool = (v) => (v ? 1 : 0);

// Validação de entrada (evita 500 e valores estranhos gravados no banco)
class BadRequest extends Error {}
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const reqText = (v, field) => {
  if (typeof v !== 'string' || !v.trim()) throw new BadRequest(`${field} é obrigatório`);
  return v.trim().slice(0, 500);
};
const optText = (v, max = 1000) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const optDate = (v, field) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' || !ISO_DATE.test(v)) throw new BadRequest(`${field} inválida`);
  return v;
};
const optPriority = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new BadRequest('priority inválida');
  return n;
};

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

  const recurring = db.prepare('SELECT * FROM recurring_items ORDER BY day_of_month ASC, created_at ASC').all().map(serializeRecurring);

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
  if (anchorDate !== null && (typeof anchorDate !== 'string' || !ISO_DATE.test(anchorDate))) {
    return res.status(400).json({ error: 'anchorDate inválida' });
  }
  db.prepare('UPDATE config SET anchor_date = ?, cycle_length = ? WHERE id = 1').run(anchorDate || null, length);
  res.json({ anchorDate: anchorDate || null, cycleLength: length });
});

// ---------- Specials ----------
app.put('/api/specials/:date', (req, res) => {
  const { date } = req.params;
  const { start, end, notify } = req.body || {};
  const HHMM = /^\d{2}:\d{2}$/;
  if (!ISO_DATE.test(date) || typeof start !== 'string' || typeof end !== 'string' || !HHMM.test(start) || !HHMM.test(end)) {
    return res.status(400).json({ error: 'data/horário inválido' });
  }
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
const validTime = (v) => (typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) ? v : null);
const CLIENT_ID = /^[0-9a-f-]{16,64}$/i;

// Fotos das tarefas ficam em arquivo (no mesmo volume do banco), não no SQLite
const PHOTO_DIR = path.join(path.dirname(DB_PATH), 'photos');
fs.mkdirSync(PHOTO_DIR, { recursive: true });
const photoPath = (id) => path.join(PHOTO_DIR, `${String(id).replace(/[^0-9a-z-]/gi, '')}.jpg`);
const removePhoto = (id) => { try { fs.unlinkSync(photoPath(id)); } catch (e) { /* sem foto */ } };

function serializeTask(t) {
  return {
    id: t.id, title: t.title, date: t.date, endDate: t.end_date, time: t.time,
    priority: t.priority, obs: t.obs, address: t.address || null,
    hasPhoto: !!t.has_photo, done: !!t.done, notify: !!t.notify,
  };
}

const getTask = (id) => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);

// Mescla o corpo da requisição sobre a tarefa existente (campos ausentes ficam iguais)
function mergeTaskFields(existing, body) {
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const title = has('title') ? reqText(body.title, 'title') : existing.title;
  const date = has('date') ? optDate(body.date, 'date') : existing.date;
  const rawEnd = has('endDate') ? optDate(body.endDate, 'endDate') : existing.end_date;
  return {
    title,
    date,
    endDate: date && rawEnd && rawEnd > date ? rawEnd : null,
    time: has('time') ? validTime(body.time) : existing.time,
    priority: has('priority') ? optPriority(body.priority) : existing.priority,
    obs: has('obs') ? optText(body.obs) : existing.obs,
    address: has('address') ? optText(body.address, 300) : existing.address,
    done: has('done') ? toBool(body.done) : existing.done,
    notify: has('notify') ? toBool(body.notify) : existing.notify,
  };
}

function updateTask(id, f) {
  db.prepare('UPDATE tasks SET title = ?, date = ?, end_date = ?, time = ?, priority = ?, obs = ?, address = ?, done = ?, notify = ? WHERE id = ?')
    .run(f.title, f.date, f.endDate, f.time, f.priority, f.obs, f.address, f.done, f.notify, id);
}

app.post('/api/tasks', (req, res) => {
  const body = req.body || {};
  const validClientId = typeof body.id === 'string' && CLIENT_ID.test(body.id) ? body.id : null;
  // Idempotente: reenvio do mesmo formulário (mesmo id) vira atualização, sem duplicar
  // e sem descartar o que o usuário corrigiu entre um envio e outro
  const existing = validClientId && getTask(validClientId);
  if (existing) {
    updateTask(existing.id, mergeTaskFields(existing, body));
    return res.status(200).json(serializeTask(getTask(existing.id)));
  }
  const title = reqText(body.title, 'title');
  const date = optDate(body.date, 'date');
  const endRaw = optDate(body.endDate, 'endDate');
  const end = date && endRaw && endRaw > date ? endRaw : null;
  const id = validClientId || uuid();
  db.prepare(`
    INSERT INTO tasks (id, title, date, end_date, time, priority, obs, address, done, created_at, notify)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(id, title, date, end, validTime(body.time), optPriority(body.priority), optText(body.obs), optText(body.address, 300), now(), toBool(body.notify));
  res.status(201).json(serializeTask(getTask(id)));
});

app.put('/api/tasks/:id', (req, res) => {
  const existing = getTask(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  updateTask(req.params.id, mergeTaskFields(existing, req.body || {}));
  res.json(serializeTask(getTask(req.params.id)));
});

// ---- Foto da tarefa (JPEG já reduzido no cliente, enviado como data URL) ----
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

app.put('/api/tasks/:id/photo', (req, res) => {
  if (!getTask(req.params.id)) return res.status(404).json({ error: 'not_found' });
  const dataUrl = (req.body || {}).dataUrl;
  const m = typeof dataUrl === 'string' && /^data:image\/jpe?g;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return res.status(400).json({ error: 'imagem inválida (envie JPEG)' });
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
  const title = reqText((req.body || {}).title, 'title');
  const id = uuid();
  db.prepare('INSERT INTO projects (id, title, done, created_at) VALUES (?, ?, 0, ?)').run(id, title, now());
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
  const title = Object.prototype.hasOwnProperty.call(body, 'title') ? reqText(body.title, 'title') : existing.title;
  const done = Object.prototype.hasOwnProperty.call(body, 'done') ? toBool(body.done) : existing.done;
  db.prepare('UPDATE projects SET title = ?, done = ? WHERE id = ?').run(title, done, req.params.id);
  res.json(getProjectWithSteps(req.params.id));
});

app.post('/api/projects/:id/steps', (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'not_found' });
  const body = req.body || {};
  const title = reqText(body.title, 'title');
  const maxPos = db.prepare('SELECT MAX(position) as maxPos FROM project_steps WHERE project_id = ?').get(req.params.id);
  const position = (maxPos.maxPos ?? -1) + 1;
  const id = uuid();
  db.prepare('INSERT INTO project_steps (id, project_id, title, done, position, obs) VALUES (?, ?, ?, 0, ?, ?)')
    .run(id, req.params.id, title, position, optText(body.obs));
  recomputeProjectDone(req.params.id);
  res.status(201).json(getProjectWithSteps(req.params.id));
});

app.put('/api/projects/:pid/steps/:sid', (req, res) => {
  const step = db.prepare('SELECT * FROM project_steps WHERE id = ? AND project_id = ?').get(req.params.sid, req.params.pid);
  if (!step) return res.status(404).json({ error: 'not_found' });
  const body = req.body || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const title = has('title') ? reqText(body.title, 'title') : step.title;
  const done = has('done') ? toBool(body.done) : step.done;
  const obs = has('obs') ? optText(body.obs) : step.obs;
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
  const name = reqText((req.body || {}).name, 'name');
  let id = slugify(name);
  while (db.prepare('SELECT id FROM shopping_categories WHERE id = ?').get(id)) id += '-' + Math.floor(Math.random() * 1000);
  const maxPos = db.prepare('SELECT MAX(position) AS m FROM shopping_categories').get().m;
  const position = (maxPos == null ? -1 : maxPos) + 1;
  db.prepare('INSERT INTO shopping_categories (id, name, position, created_at) VALUES (?, ?, ?, ?)').run(id, name, position, now());
  res.status(201).json({ id, name });
});

app.put('/api/shopping-categories/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM shopping_categories WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const name = reqText((req.body || {}).name, 'name');
  db.prepare('UPDATE shopping_categories SET name = ? WHERE id = ?').run(name, req.params.id);
  res.json({ id: req.params.id, name });
});

app.delete('/api/shopping-categories/:id', (req, res) => {
  db.prepare('DELETE FROM shopping_items WHERE category = ?').run(req.params.id);
  db.prepare('DELETE FROM shopping_categories WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// ---------- Shopping ----------
app.post('/api/shopping', (req, res) => {
  const { category } = req.body || {};
  if (typeof category !== 'string' || !db.prepare('SELECT id FROM shopping_categories WHERE id = ?').get(category)) {
    return res.status(400).json({ error: 'category inválida' });
  }
  const name = reqText((req.body || {}).name, 'name');
  const id = uuid();
  db.prepare('INSERT INTO shopping_items (id, category, name, done, created_at) VALUES (?, ?, ?, 0, ?)')
    .run(id, category, name, now());
  res.status(201).json({ id, category, name, done: false });
});

app.put('/api/shopping/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM shopping_items WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const body = req.body || {};
  const name = Object.prototype.hasOwnProperty.call(body, 'name') ? reqText(body.name, 'name') : existing.name;
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
  if (!ISO_DATE.test(date)) return res.status(400).json({ error: 'data inválida' });
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
  if (typeof start !== 'string' || typeof end !== 'string' || !ISO_DATE.test(start) || !ISO_DATE.test(end) || end < start) {
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
// done_months: lista JSON dos meses confirmados ("YYYY-MM"). Antes só existia
// last_done_month (um mês), o que fazia meses passados parecerem pendentes.
const MONTH_KEY = /^\d{4}-\d{2}$/;

function parseDoneMonths(r) {
  try {
    const list = JSON.parse(r.done_months || '[]');
    if (Array.isArray(list)) return list.filter((m) => typeof m === 'string' && MONTH_KEY.test(m));
  } catch (e) { /* valor antigo inválido */ }
  return [];
}

const serializeRecurring = (r) => ({
  id: r.id,
  title: r.title,
  dayOfMonth: r.day_of_month,
  doneMonths: parseDoneMonths(r),
  createdMonth: String(r.created_at || '').slice(0, 7),
  notify: !!r.notify,
});

function clampDay(d) {
  const n = parseInt(d, 10);
  if (!Number.isInteger(n)) return null;
  return Math.min(Math.max(n, 1), 31);
}

const getRecurring = (id) => db.prepare('SELECT * FROM recurring_items WHERE id = ?').get(id);

app.post('/api/recurring', (req, res) => {
  const { dayOfMonth, notify } = req.body || {};
  const title = reqText((req.body || {}).title, 'title');
  const day = clampDay(dayOfMonth);
  if (day == null) return res.status(400).json({ error: 'dayOfMonth inválido' });
  const id = uuid();
  db.prepare("INSERT INTO recurring_items (id, title, day_of_month, last_done_month, done_months, notify, created_at) VALUES (?, ?, ?, NULL, '[]', ?, ?)")
    .run(id, title, day, toBool(notify), now());
  res.status(201).json(serializeRecurring(getRecurring(id)));
});

app.put('/api/recurring/:id', (req, res) => {
  const existing = getRecurring(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const body = req.body || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const title = has('title') ? reqText(body.title, 'title') : existing.title;
  const day = has('dayOfMonth') ? clampDay(body.dayOfMonth) : existing.day_of_month;
  if (day == null) return res.status(400).json({ error: 'dayOfMonth inválido' });
  const notify = has('notify') ? toBool(body.notify) : existing.notify;

  // Marca/desmarca um mês específico: { month: 'YYYY-MM', done: true|false }
  let doneMonths = parseDoneMonths(existing);
  if (has('month')) {
    if (typeof body.month !== 'string' || !MONTH_KEY.test(body.month)) return res.status(400).json({ error: 'month inválido' });
    doneMonths = doneMonths.filter((m) => m !== body.month);
    if (body.done) doneMonths.push(body.month);
    doneMonths = doneMonths.sort().slice(-60);
  }
  const lastDone = doneMonths.length ? doneMonths[doneMonths.length - 1] : null;

  db.prepare('UPDATE recurring_items SET title = ?, day_of_month = ?, last_done_month = ?, done_months = ?, notify = ? WHERE id = ?')
    .run(title, day, lastDone, JSON.stringify(doneMonths), notify, req.params.id);
  res.json(serializeRecurring(getRecurring(req.params.id)));
});

app.delete('/api/recurring/:id', (req, res) => {
  db.prepare('DELETE FROM recurring_items WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// Erros: resposta JSON curta (sem stack trace/caminhos para o cliente)
app.use('/api', (err, req, res, next) => {
  if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'conteúdo muito grande' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
  console.error('[agenda]', err);
  res.status(500).json({ error: 'erro interno' });
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
