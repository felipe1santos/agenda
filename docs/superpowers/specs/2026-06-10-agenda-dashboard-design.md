# Agenda Dashboard — Design Spec

Data: 2026-06-10

## 1. Visão Geral

Refatorar o `index.html` atual (app de escala/calendário com localStorage) em um
**Dashboard de Gestão Pessoal SPA**, mobile-first, com 4 abas via bottom navigation:
Calendário, Tarefas, Projetos e Compras. O estado da aplicação passa a ser
sincronizado com um backend próprio (PHP + SQLite) hospedado na VPS do usuário,
mantendo o localStorage como cache local/offline.

Identidade visual (paleta, variáveis CSS, fontes do sistema Apple, estilo clean
arredondado) é preservada.

## 2. Arquitetura

**Arquivos entregues:**
- `index.html` — frontend SPA completo (HTML + CSS em `<style>` + JS em `<script>`),
  organizado em seções comentadas (estado, sync, render por aba, modais, utils).
- `api.php` — backend PHP + SQLite via PDO. Cria o banco automaticamente na
  primeira requisição (`CREATE TABLE IF NOT EXISTS`).

**Persistência — "JSON blob versionado":**

O estado inteiro do app é um único objeto JSON (chave `agendaDashboard_data`),
guardado:
- No `localStorage` do navegador (sempre, instantâneo).
- No SQLite da VPS, numa tabela de uma linha só:

```sql
CREATE TABLE IF NOT EXISTS app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL,        -- JSON serializado do estado
  updated_at TEXT NOT NULL   -- ISO timestamp (gerado pelo cliente)
);
```

Justificativa: uso pessoal single-user, um blob único evita múltiplos endpoints
CRUD e lógica de merge por entidade. O campo `version` no JSON permite migrar o
schema no futuro sem quebrar compatibilidade.

**Limitação assumida (last-write-wins):** se o app for editado em dois
dispositivos *enquanto ambos estão offline*, a sincronização mais recente
sobrescreve o blob inteiro do outro dispositivo. Aceitável para uso pessoal
(1-2 dispositivos, raramente offline simultâneo). Não há merge de campos
individuais.

## 3. Modelo de Dados (`agendaDashboard_data`)

```json
{
  "version": 1,
  "updatedAt": "2026-06-10T15:00:00.000Z",
  "config": {
    "anchorDate": "2026-01-01"
  },
  "specials": {
    "2026-06-15": { "start": "18:00", "end": "06:00" }
  },
  "tasks": [
    {
      "id": "uuid",
      "title": "Consulta médica",
      "date": "2026-06-15",
      "priority": 3,
      "obs": "Levar exames",
      "done": false
    }
  ],
  "projects": [
    {
      "id": "uuid",
      "title": "Reformar quarto",
      "subtasks": [
        { "id": "uuid", "title": "Comprar tinta", "done": false }
      ]
    }
  ],
  "shopping": [
    { "id": "uuid", "name": "Arroz", "done": false }
  ]
}
```

Notas:
- **`tasks`**: substitui o antigo conceito de "Evento Pessoal". `priority` é
  opcional (`1`-`5` ou `null`), mantém os ícones de fogo (`colorsMap`/`prio-N`)
  quando definida. `date` é opcional/`null` → tarefa cai no "backlog"
  (= "Lista de Vulto").
- **Ciclo 1x1x3 fica fixo no código JS** (constante `CYCLE_DEFINITIONS`), não no
  JSON. Apenas `config.anchorDate` define o offset do ciclo.
- **`emendando` não é armazenado** — é calculado dinamicamente a partir de
  `getCycleIndex(date)` toda vez que renderiza, garantindo consistência se
  `anchorDate` mudar.
- **Estado inicial (sem dados):**
```json
{ "version": 1, "updatedAt": null, "config": { "anchorDate": "" },
  "specials": {}, "tasks": [], "projects": [], "shopping": [] }
```
Se `config.anchorDate` estiver vazio, o modal de Configurações abre
automaticamente no load (igual ao comportamento atual).

**Configuração local de conexão** (NÃO faz parte do blob sincronizado, é por
dispositivo): `agendaDashboard_apiUrl`, `agendaDashboard_apiKey`,
`agendaDashboard_viewMode` (preferência lista/grade), salvos em chaves
separadas do `localStorage`.

## 4. Backend (`api.php`)

Endpoints (mesmo arquivo, roteado por método HTTP):

- **`GET /api.php`**
  - Header obrigatório: `X-Api-Key: <chave>`
  - Resposta 200: `{"data": {...} | null, "updatedAt": "..." | null}`
  - Resposta 401: `{"error": "unauthorized"}`

- **`POST /api.php`**
  - Header obrigatório: `X-Api-Key: <chave>`, `Content-Type: application/json`
  - Body: `{"data": {...}, "updatedAt": "..."}`
  - Faz `INSERT ... ON CONFLICT(id) DO UPDATE` (upsert da linha única)
  - Resposta 200: `{"ok": true}`
  - Resposta 401: `{"error": "unauthorized"}`

- **`OPTIONS /api.php`** — responde 200 com headers CORS para o preflight.

**Configuração:**
- Constante `API_KEY` no topo do arquivo (usuário troca por uma string
  aleatória própria antes do deploy).
- Headers CORS liberados (`Access-Control-Allow-Origin: *`,
  `Access-Control-Allow-Headers: Content-Type, X-Api-Key`,
  `Access-Control-Allow-Methods: GET, POST, OPTIONS`) para permitir que o
  `index.html` rode de qualquer origem.
- Banco SQLite (`agenda.db`) criado automaticamente no mesmo diretório do
  `api.php` — requer permissão de escrita na pasta.

## 5. Sincronização (online/offline)

Algoritmo (pseudocódigo):

```js
// Ao iniciar o app
async function syncOnLoad() {
  const local = loadFromLocalStorage(); // ou estado inicial vazio
  if (!apiConfigured()) { appData = local; setSyncStatus('not-configured'); return; }

  try {
    const remote = await apiGet(); // {data, updatedAt}
    if (remote.data && (!local.updatedAt || remote.updatedAt > local.updatedAt)) {
      appData = remote.data;
      saveLocal(appData);
    } else {
      appData = local;
      await apiPost(appData); // sobe versão local mais nova
    }
    setSyncStatus('synced');
  } catch (e) {
    appData = local;
    setSyncStatus('offline');
  }
}

// A cada mudança de dado
function onDataChange() {
  appData.updatedAt = new Date().toISOString();
  saveLocal(appData);
  scheduleSync(); // debounce ~1.5s
}

async function scheduleSync() {
  debounce(async () => {
    setSyncStatus('syncing');
    try { await apiPost(appData); setSyncStatus('synced'); }
    catch (e) { setSyncStatus('offline'); }
  }, 1500);
}
```

**Indicador de sincronização** no header (todas as abas): ✅ sincronizado /
🔄 sincronizando / ⚠️ offline (alterações salvas localmente). Toque mostra
"Última sincronização: HH:MM".

## 6. Navegação & Layout

```
┌─────────────────────────┐
│ HEADER (fixo)            │ ← muda conforme a aba
├─────────────────────────┤
│   MAIN CONTENT           │ ← único elemento com scroll
├─────────────────────────┤
│ BOTTOM NAV (fixo)        │ ← 4 abas
└─────────────────────────┘
```

**Bottom Nav** (SVG stroke style, mesmo padrão visual atual): Calendário,
Tarefas, Projetos, Compras. Aba ativa destacada com `--primary`. Altura ~60px,
toque ≥44px.

**Header por aba:**
| Aba | Conteúdo |
|---|---|
| Calendário | seletor de mês (◀ Mês ▶) + toggle lista/grade + indicador sync + ⚙️ |
| Tarefas | título "Tarefas" + indicador sync + ⚙️ |
| Projetos | título "Projetos" + indicador sync + ⚙️ |
| Compras | título "Compras" + menu (⋮: limpar concluídos / limpar tudo) + indicador sync + ⚙️ |

**FAB contextual** (flutua acima da bottom nav):
- Calendário → modal "Adicionar Registro" (Especial / **Tarefa**, era "Evento Pessoal")
- Tarefas → modal "Nova Tarefa"
- Projetos → action sheet: "Item de Vulto" (input rápido) ou "Novo Projeto" (modal)
- Compras → **sem FAB** — input fixo no topo da lista (Enter ou botão "+")

**Responsivo desktop:** `#app` cresce de `max-width: 480px` para `~900px` em
telas `≥768px` (media query). Header, main-content e bottom nav acompanham a
largura. Grid do calendário ganha células maiores.

## 7. Aba Calendário

### Modo Lista
Mantém estrutura de `day-card`, com adições:
- Badge de turno (Dia/Noite/Folga) — igual ao atual.
- Alerta de Especial com tag `[EMENDANDO]` quando `cycleIndex` do dia for `0`
  ou `1`.
- Lista de **tarefas com data** daquele dia: título, ícones de fogo (se
  `priority` definida), `obs`, e dois botões:
  - **"✓ Concluir"** → `task.done = true`
  - **"↩ Sem data"** → `task.date = null` (tarefa volta pro backlog/Vulto)
  - Tarefas com `done = true` aparecem riscadas + opacidade reduzida.

### Modo Grade — overhaul
- **Tamanho/expansão:** grade ocupa 100% da largura (7 colunas). Cada célula
  tem `min-height` ~2x o atual (de ~50-60px para ~110px mobile / ~130px
  desktop). A grade pode rolar verticalmente dentro de `.main-content` (em vez
  do `overflow:hidden` atual que forçava caber sem scroll); o cabeçalho
  "Dom Seg Ter..." fica `position: sticky; top: 0` durante o scroll.
- **Linhas dinâmicas (fix de bug):** número de linhas =
  `Math.ceil(totalCélulas / 7)` em vez do fixo `repeat(6, 1fr)` atual —
  elimina espaço vazio excessivo em meses de 5 semanas.
- **Mini-cards substituem `.grid-dots`/`.dot`:** dentro de cada célula, abaixo
  do número do dia, até **3 mini-badges** (linhas finas, `text-overflow:
  ellipsis`, texto branco):
  - Ordem de prioridade: `[turno (Dia/Noite)]` → `[Especial]` → `[tarefas com
    data]`.
  - Folga **não gera mini-card** (célula fica visualmente "limpa").
  - Cores: turno usa `--cor-dia`/`--cor-noite`; especial usa `--cor-especial`
    (com sufixo `[EMENDANDO]` se aplicável); tarefas usam a cor de
    `colorsMap[priority]` ou `--primary` se sem prioridade.
  - **Regra de overflow:** se o total de itens do dia for `≤ 3`, mostra todos.
    Se for `> 3`, mostra os 2 primeiros (pela ordem acima) + um badge final
    `+N` (cinza) com `N = total - 2`.
  - **Toque na célula** abre um bottom-sheet modal com o detalhe completo do
    dia (mesmo conteúdo do `day-card` do modo lista: turno, Especial com tags
    `[EMENDANDO]`, tarefas com data e seus botões "✓ Concluir"/"↩ Sem data").
    O bottom-sheet inclui dois atalhos: **"✏️ Editar Especial"** (abre o modal
    "Adicionar Registro" pré-preenchido com a data e os horários atuais da
    Especial daquele dia, permitindo sobrescrever) e **"+ Nova tarefa neste
    dia"** (abre o modal "Nova Tarefa" com a data já preenchida).
- **Regra de exibição:** mês corrente + 3 primeiros dias do mês seguinte —
  igual ao comportamento atual. Células vazias antes do dia 1 (alinhamento de
  semana) continuam transparentes.

## 8. Ciclo 1x1x3 + Emendando

```js
const CYCLE_DEFINITIONS = [
  { type: 'dia',   label: 'Plantão Dia',   start: '06:00', end: '18:00', class: 'shift-dia' },
  { type: 'noite', label: 'Plantão Noite', start: '18:00', end: '06:00', class: 'shift-noite' },
  { type: 'folga', label: 'Folga', class: 'shift-folga' },
  { type: 'folga', label: 'Folga', class: 'shift-folga' },
  { type: 'folga', label: 'Folga', class: 'shift-folga' },
];
```

- `getCycleIndex(date)` mantém a lógica atual baseada em `config.anchorDate`
  (diferença de dias `mod 5`).
- **Auto-fill de Especial** ao escolher a data no modal "Adicionar Registro":
  - `cycleIndex === 0` (Plantão Dia) → preenche `18:00–06:00` + exibe
    `[EMENDANDO]`.
  - `cycleIndex === 1` (Plantão Noite) → preenche `06:00–18:00` + exibe
    `[EMENDANDO]`.
  - Demais dias (`2`, `3`, `4` — Folga) → usuário escolhe livremente, sem tag.
  - Tag `[EMENDANDO]` é sempre recalculada dinamicamente (não fica "presa" ao
    valor no momento da criação).

## 9. Aba Tarefas

Filtros sobre o array único `tasks`:
- **"Próximas"** = `date != null && done == false`, ordenadas por `date` asc.
  Cada item: data formatada (ex: "15/06 - Seg"), título, fogos (se
  `priority`), `obs`, botões **"✓ Concluir"** e **"↩ Sem data"**.
- **"Backlog (sem data)"** = `date == null && done == false`. Cada item:
  checkbox de conclusão, botão **"📅 Definir data"** (date picker → move para
  "Próximas"), botão excluir (🗑).
- **"Concluídas"** (seção colapsável, no fim) = `done == true` (qualquer
  data). Cada item: título + data (se houver), botões **"↩ Reabrir"** (volta
  pro filtro de origem conforme tem ou não `date`) e **"🗑 Excluir"**.

**Modal "Nova Tarefa"**: título (obrigatório), toggle **Com Data / Sem Data**
(mostra date picker se "Com Data"), prioridade opcional (`Nenhuma`, `1`-`5`),
observação.

## 10. Aba Projetos

- **Lista de Vulto** (topo): mesmo filtro "Backlog (sem data)" da aba Tarefas
  (`date == null && done == false`), em formato checklist simples (checkbox +
  título + excluir). Input fixo no topo cria
  `{title, date: null, priority: null, obs: '', done: false}`. Marcar como
  concluído remove o item desta lista (passa a aparecer em "Concluídas" na aba
  Tarefas) — comportamento consistente, sem casos especiais.
- **Planejamento Futuro** (cards de projeto), array `projects`:
  - Título do projeto + barra de progresso (`X/Y subtarefas concluídas`)
  - Lista de subtarefas: checkbox + título + excluir (🗑)
  - "+ Adicionar subtarefa" inline dentro do card
  - Excluir projeto inteiro (🗑, com confirmação)

**Modal "Novo Projeto"**: apenas título — subtarefas são adicionadas depois,
direto no card.

## 11. Aba Compras

- Input fixo no topo (campo texto + Enter ou botão "+") cria
  `{id, name, done: false}` em `shopping`.
- Lista: checkbox + nome; item marcado fica com opacidade reduzida + texto
  riscado (`text-decoration: line-through`).
- Menu (⋮) no header: **"Limpar concluídos"** (remove itens com `done==true`)
  e **"Limpar lista toda"** (remove todos os itens) — ambas pedem confirmação.

## 12. UX Transversal

- **Modal de confirmação genérico** (`showConfirm(message, onConfirm)`),
  mesmo estilo visual dos modais existentes — usado em: limpar lista de
  compras, excluir projeto, excluir tarefa concluída.
- **Estados vazios**: listas vazias mostram mensagem central amigável (ex:
  "Nenhum item ainda — toque em + para adicionar").
- **Geração de IDs**: `crypto.randomUUID()` com fallback
  (`'id-' + Date.now() + '-' + Math.random().toString(36).slice(2,9)`).
- **Toques e overflow**: botões com padding mínimo equivalente a 44px de área
  de toque; títulos longos em mini-cards/listas usam `text-overflow:
  ellipsis` em uma linha.
- **Headers e bottom nav fixos**: apenas `.main-content` tem scroll vertical.

## 13. Tela de Configurações (⚙️, global)

Acessível de qualquer aba. Campos:
- **Data-âncora do ciclo** (`config.anchorDate`) — já existe.
- **URL da API** (`agendaDashboard_apiUrl`) — endereço do `api.php` na VPS.
- **Chave de API** (`agendaDashboard_apiKey`).
- Botão **"Sincronizar agora"** (força `apiGet`/`apiPost` conforme o algoritmo
  da seção 5) + texto com a última sincronização.

## 14. Bugs corrigidos do código atual

1. Grid do modo grade fixo em `repeat(6, 1fr)` → cálculo dinâmico de linhas
   (`Math.ceil(totalCélulas / 7)`), eliminando espaço vazio excessivo em meses
   de 5 semanas.
2. Valores-padrão do horário de Especial (`16:00`/`04:00`) não condiziam com a
   lógica de emenda (`06:00`/`18:00`) — corrigidos para refletir o auto-fill.
3. Comentário/linha duplicada (`// Processa Eventos` repetido) no JS de
   renderização — removido.
4. `.grid-dots`/`.dot` (bolinhas sem informação) substituídos por mini-cards
   com texto legível.
5. Estado disperso em múltiplas chaves de `localStorage`
   (`agendaGCM_data`, `agendaGCM_anchor`, `agendaGCM_viewMode`) → unificado em
   `agendaDashboard_data` (versionado) + chaves de config local separadas.

## 15. Arquivos entregues / Deploy

1. **`index.html`** — SPA completo.
2. **`api.php`** — backend PHP+SQLite, ~50-60 linhas, cria o banco
   automaticamente.
3. **Passos de deploy** (documentados no próprio código/README curto):
   - Subir `api.php` numa pasta com permissão de escrita na VPS (Nginx +
     PHP-FPM já disponíveis).
   - Trocar a constante `API_KEY` por uma string aleatória própria.
   - Abrir o app, ir em Configurações, preencher URL da API + chave, salvar.
