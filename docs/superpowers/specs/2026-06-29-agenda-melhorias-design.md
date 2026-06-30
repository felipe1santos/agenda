# Melhorias da Agenda — Design (2026-06-29)

Seis melhorias na PWA de agenda (calendário/tarefas/projetos/lista).
Stack: Express + better-sqlite3 (`server.js`), front vanilla em `public/`.

## F1 — Dia atual no topo
`#todayBadge` mostra "Hoje, 29 de Junho". Título do mês segue navegável pelas
setas; o badge sempre reflete a data real de hoje.

## F2 — Auto-scroll pro dia atual
Ao entrar no Calendário (visão lista E grid/30 dias) e ao alternar visualização,
rolar até o card de hoje via `scrollIntoView({behavior:'smooth',block:'center'})`.
Só no momento da entrada/toggle; depois o usuário rola livre.

## F3 — Linhas mais finas
Reduzir padding/altura de `.list-item` (Tarefas e Projetos). Mais compacto.

## F4 — Check → linha verde
Ao marcar o check, a linha inteira acende verde (fundo + texto). CSS em
`.list-item.done` aplicado a tarefas, etapas de projeto e itens de lista.
Sem diálogo de confirmação — clique direto.

## F5 — Lista por pastas + categorias custom
- Aba Lista vira grid de pastas (Mercado, Avulso + custom). Clicar abre a lista
  da categoria com botão ◀ voltar.
- "+ Nova categoria" cria pasta; renomear/excluir (excluir pede confirmação se
  tiver itens).
- Backend: tabela `shopping_categories(id, name, position, created_at)`. Seed
  Mercado/Avulso com ids `mercado`/`avulso` (casa com dados existentes).
  Migração: rebuild de `shopping_items` removendo o `CHECK(category IN ...)`.
  `shopping_items.category` passa a referenciar id da categoria (texto livre).
- Endpoints: GET state inclui `shoppingCategories`; POST/PUT/DELETE
  `/api/shopping-categories`. Validação de category no POST de item passa a
  conferir existência na tabela.

## F6 — Recorrentes (aba própria)
- Nova aba "Recorrentes" na bottom-nav. Lista itens mensais: título +
  "Todo dia X" + status (pendente/feito este mês). FAB adiciona; editar/excluir.
- Backend: tabela `recurring_items(id, title, day_of_month, last_done_month,
  notify, created_at)`. `last_done_month` = "YYYY-MM" do último mês confirmado.
- Endpoints: GET state inclui `recurring`; POST/PUT/DELETE `/api/recurring`;
  confirmar via PUT `{ lastDoneMonth }`.
- Pendência: item é "pendente" no mês M se `last_done_month != M`.
- Calendário: no dia X de cada mês visível aparece o item; **piscando vermelho**
  enquanto pendente naquele mês; ao confirmar para de piscar no mês atual.
  Virou o mês → pendente de novo automaticamente.
- Dia 29-31 em mês curto → encaixa no último dia do mês (clamp).
- Confirmar: clicando no item no calendário ou na aba Recorrentes.

## Ordem
F1–F4 (front only) → F5 (backend+front) → F6 (backend+front). Commit por bloco.
