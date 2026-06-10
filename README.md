# Agenda de Escala

App pessoal (PWA) para controle de escala cíclica, tarefas, projetos e lista
de compras. Backend Node.js + Express + SQLite (`node:sqlite`, nativo do
Node 22+, sem dependências de compilação).

## Rodando localmente

```bash
npm install
node scripts/generate-icons.js   # já gerados em public/icons, só rode de novo se quiser regenerar
npm start
```

Acesse `http://localhost:3000`. Senha padrão: `agenda123` (defina
`APP_PASSWORD` para trocar).

## Configuração da escala

No primeiro acesso, abra Configurações (ícone ⚙️) e informe:

- **Data de um Plantão de DIA (06h-18h)** — qualquer data conhecida desse turno.
- **Duração total do ciclo (dias)** — padrão `9` (1 dia + 1 noite + 7 folgas).
  O dia seguinte ao "Plantão DIA" vira automaticamente "Plantão NOITE", e o
  restante do ciclo é folga. O app recalcula o ano inteiro a partir disso.

## Variáveis de ambiente

| Variável        | Padrão                  | Descrição                                   |
|-----------------|-------------------------|----------------------------------------------|
| `PORT`          | `3000`                  | Porta HTTP do servidor                        |
| `DB_PATH`       | `./data/agenda.db`      | Caminho do arquivo SQLite                     |
| `APP_PASSWORD`  | `agenda123`             | Senha de acesso ao app (defina em produção!)  |

## Deploy no Coolify

1. Crie uma aplicação apontando para este repositório (`Dockerfile` já incluso).
2. Defina as variáveis de ambiente `APP_PASSWORD` (senha forte) e, se quiser,
   `DB_PATH=/app/data/agenda.db`.
3. Monte um **volume persistente** em `/app/data` (mantém o banco SQLite entre
   deploys/restart).
4. Exponha a porta `3000` e configure o domínio
   (`agenda.menuzia.com.br`).

## PWA

O app é instalável (manifest + service worker). No Android/Chrome aparece um
botão de "instalar" (ícone de download) no header quando disponível; no
iOS/Safari o mesmo botão mostra o passo a passo manual
("Compartilhar → Adicionar à Tela de Início").

Os ícones em `public/icons/` são gerados por `scripts/generate-icons.js`
(sem dependências externas — usa apenas `zlib` nativo do Node).
