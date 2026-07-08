# Промпт следующей сессии: автономный agentic loop — эскалация, проверяемый evidence, PRD-контракт

Ты — агент-реализатор в репозитории `pi-ai-automation` (Pi-пакет: workflow
`brain -> coder -> reviewer` + спринт-сабстрат + прототип `agent-harness`).
Твоя задача — реализовать work packages WP1–WP7 ниже. Это продолжение двух
предыдущих сессий; весь необходимый контекст — в этом файле. Прочитай его
целиком, потом `CONTEXT.md` (доменный словарь) и `agent-harness/README.md`,
и только после этого начинай.

---

## 1. Состояние репозитория

- Рабочая ветка: `architecture-deepening-and-gate-hardening` (запушена в origin).
  Свежие коммиты: `6de869b` (agent-harness), `5167507` (углубление модулей +
  hardening гейтов), `d0b2c8e` (дедупликация промптов + рантайм-фиксы).
- **Не трогай чужой WIP** (незакоммичен в рабочем дереве, принадлежит владельцу
  репо): `.sprints/*`, незастейдженный остаток `extensions/workflow/runtime/config.ts`
  (+49 строк semantic-nav диагностики), untracked `.idea/`, `.serena/`,
  `docs/prd-*.md`, `docs/task-cmux-*.md`, `docs/pi-ai-automation-workflow-chart.md`,
  `scripts/task-004-serena-diagnostics-fallback-smokes.ts`. Если тебе нужно
  править `runtime/config.ts` — правь, но при коммите стейджи только свои
  ханки (`git apply --cached` отфильтрованного патча; так уже делалось).

## 2. Как проверять (обязательно перед каждым коммитом)

```sh
# peer-зависимости Pi не установлены локально; резолвятся из глобального Pi:
G=$(npm root -g); export NODE_PATH="$G:$G/@earendil-works/pi-coding-agent/node_modules"

# канонический раннер смоуков:
npx tsx --conditions import scripts/<smoke>.ts

# полный прогон:
for f in scripts/task-*-smokes.ts; do npx tsx --conditions import "$f" >/dev/null 2>&1 || echo "FAIL $f"; done

# поведенческий тест делегатов (tsx не умеет его top-level await, нужен родной лоадер):
node --experimental-loader ./tests/ts-extension-loader.mjs --test tests/delegate-placement-smoke.test.ts

# калибровка agent-harness:
node agent-harness/runner/calibrate.ts
```

- **Заранее сломаны (НЕ твоя вина, не чини и не ломай сильнее):**
  `task-009-workflow-quality-audit`, `task-028-workflow-cfg`,
  `task-029-prd-planning` — падают из-за WIP владельца в зоне configure-overlay.
  Все остальные обязаны быть зелёными после каждого твоего коммита.
- В репо НЕТ tsconfig/tsc — типы проверяются только запуском. Node 24
  type-stripping: никаких enum/namespace, импорты внутри пакета без расширений
  (tsx резолвит), в `agent-harness/` — с расширениями `.ts`.
- Новые смоуки пиши поведенчески через `tests/fake-pi.ts` (fake ExtensionAPI:
  реестр инструментов + `createFakeContext(cwd)`), НЕ через grep исходников.

## 3. Карта ключевых модулей

| Что | Где |
|---|---|
| Словарь домена | `CONTEXT.md` |
| Роли/вердикты ревьюеров (OSOT) | `extensions/workflow/reviewer-protocol.ts` — парсер fail-closed: APPROVED только первым токеном |
| Reviewer swarm (role mode) | `extensions/workflow/delegate/{swarm,reviewer-roles,reviewer-memo-file}.ts`; memo пишется атомарно + JSON-sidecar `<planId>-<phase>.json` |
| Coder evidence gate | `extensions/workflow/delegate/{completion-evidence,completion-evidence-gate}.ts` — matrix-gated `coderEvidence` (filesChanged/commandsRun/criterionCoverage) |
| Architecture plan + матрица | `extensions/workflow/architecture/{store,gate,evidence-matrix,types}.ts`; заголовок задач — `architecturePlanTaskHeader()` |
| Финализация | `extensions/workflow/{finalization-gate,finalization-runtime}.ts`; читает memo-sidecar, манифесты (cap 300), disclosure-waiver с узкими токенами |
| Planning gate (PRD-first) | `extensions/workflow/{planning-state,planning-pointer,planning-gate-runtime}.ts`; единый вход `evaluatePlanningGate(cwd, roomId, gate)`; только STRONG-фразы подтверждают этапы |
| Делегаты (транспорт) | `extensions/workflow/delegate/{runner,headless,pane,child,state,model-guard,pane-status,done-tools}.ts`; headless wall-clock cap `DELEGATE_HEADLESS_MAX_WAIT_MS` |
| AFK ship supervisor | `extensions/sprint/{ship-engine,ship-state,ship-tools,lane-policy}.ts` — чистая state machine стадий + durable state в `.pi/workflow-runs/afk-ship/<runId>/` |
| Спринт-сабстрат | `extensions/sprint/{store,tools,command,hooks}.ts`; `.sprints/` на диске |
| Атомарные записи | `extensions/workflow/fs-atomic.ts` (`writeFileAtomicSync/writeFileAtomic`) — используй для ЛЮБОГО durable-файла |
| Прототип-эталон гейтов | `agent-harness/` — G1–G11; G7=report-matches-diff, G9=гейт сам запускает тесты, G10=мутационный гейт, OSOT=sha256-заморозка |

Принципы (не нарушать): fail-closed по умолчанию (ошибка/отсутствие данных =
блок, не пропуск); «что может быть кодом — должно быть кодом» (LLM-суждение
только там, где код не может); OSOT — каждая константа/протокол объявлены один
раз; строковые эвристики по прозе LLM — запрещённый приём для новых гейтов.

## 4. Work packages (в порядке реализации)

### WP2 (первый — максимальная отдача): проверяемый coder evidence
Перенести G7/G9 из agent-harness в основной workflow.
- **G7 (report-matches-diff):** в `evaluateCoderCompletionEvidence` сверять
  `coderEvidence.filesChanged` с реальным диффом. Снимай снапшот
  `git status --porcelain`/`git diff --name-only` в `delegate/tools.ts` ДО
  `runDelegateAgent` и ПОСЛЕ; расхождение (файл изменён, но не заявлен /
  заявлен, но не изменён) → новый rejection code `evidence_diff_mismatch`,
  фаза не продвигается. Не-git cwd → код `diff_unverifiable` + блок для
  matrix-gated (fail-closed).
- **G9 (re-run):** для `commandsRun[].outcome === "passed"` c
  `requiredEvidence.kind` из {behavior-test, regression-test, unit-test,
  runtime-gate-test} гейт перезапускает команду сам (bounded: timeout из
  констант, cap N=5 команд, только команды из белого списка префиксов —
  `npx tsx`, `node`, `npm test`, конфигурируемо через workflow config
  `evidence.rerunAllowlist`). Ненулевой exit → `evidence_rerun_failed`.
  Перезапуск отключаем флагом конфига `evidence.rerun: "off"|"required"`
  (default `"required"` для matrix-gated ready-планов).
- Смоук: новый `scripts/task-030-evidence-verification-smokes.ts` — фикстура
  с временным git-репо: (а) честный evidence проходит; (б) незаявленный
  изменённый файл → блок; (в) заявленная команда, падающая при re-run → блок.

### WP1: канал эскалации к оператору
- Новый модуль `extensions/workflow/operator-questions.ts`: durable-очередь
  `.pi/workflow-runs/<room|run>/questions.jsonl` (append-only, писать через
  fs-atomic список? — append построчно допустим, читатель терпит хвостовую
  обрезку); записи `{id, at, from, question, options?, recommendedDefault?,
  blocking, answeredAt?, answer?}`.
- Инструменты: `workflow_ask_operator` (создать вопрос; для Brain и — через
  child-регистрацию по env, как done-tools — для делегатов) и
  `workflow_answer_question` (оператор/Brain фиксирует ответ).
- Гейты: незакрытый `blocking` вопрос блокирует (а) `evaluateFinalizationGate`
  (новый blocker-код `operator_question_pending`), (б) `ready_for_sprint`
  в planning-state (см. WP3), (в) переход ship-engine в `delivery_complete`.
- AFK ship: новое состояние причины остановки `awaiting_operator` в
  `ship-engine` stop conditions; REPORT.md перечисляет открытые вопросы.
- UI: `ctx.ui.notify` при создании blocking-вопроса (родительская сессия).
- Промпты: в BRAIN_INSTRUCTIONS и в hard rules планнеров заменить «спроси
  пользователя» на явное «задай вопрос через workflow_ask_operator, если
  неопределённость блокирует» (одно место, без дублей — правила дедупликации
  из d0b2c8e соблюдать).
- Смоук `task-031-operator-questions-smokes.ts`: очередь round-trip; blocking
  вопрос блокирует финализацию; ответ разблокирует.

### WP3: PRD-контракт и трассировка ID
- Схема PRD по образцу `agent-harness/contracts/requirement.schema.json`:
  новый `extensions/workflow/planning-prd-contract.ts` (типы + normalize +
  validate, стиль evidence-matrix.ts): `expected_behavior[]` (B\*),
  `edge_cases[]` (E\*), `forbidden_behavior[]` (X\*), `assumptions[]`
  (A\*, `covers_question`), `open_questions[]` (Q\*, `blocking`).
- `workflow_planning_artifacts` принимает/хранит рядом с PRD.md структурный
  `prd.json`; переход `prd_ready_for_sprint` требует валидный prd.json
  (fail-closed: нет файла → переход блокирован с actionable-ошибкой).
  `ready_for_sprint` ВЫЧИСЛЯЕТСЯ: все Q\* с blocking=true отвечены (интеграция
  с WP1), каждое A\* ссылается на закрытый Q\*.
- Трассировка: `AcceptanceEvidenceMatrixEntry` получает опциональный
  `criterionId` (AC\*) и `covers?: string[]` (B\*/X\*); валидация матрицы
  ready-плана: каждый X\* покрыт хотя бы одной строкой с негативным сценарием
  (новый `criterionKind: "forbidden-behavior"` ИЛИ поле `negative: true` —
  выбери меньший радиус, обнови docs/workflow-config-v2.md).
- Adversarial verifier: в deep-planning добавить финальный опциональный раунд
  `verifier` (конфиг `deepPlanning.verifier: boolean`, default true): один
  агент с промптом «найди двусмысленности/нетестируемые требования/дыры в
  failure paths; выведи список gaps + вопросы» — его вопросы попадают в
  очередь WP1 как non-blocking (Brain решает поднять до blocking).
- Смоук `task-032-prd-contract-smokes.ts`.

### WP5: OSOT-заморозка плана на фазу
- При старте фазы (первый `delegate_to_coder` фазы) — snapshot плана:
  `.pi/workflow-architecture/plans/<planId>.<phase>.frozen.json` + sha256
  (писать fs-atomic). В `PaneManifest` — поле `planSha256`.
- Гейты: `evaluateCoderPhaseAdvancement` и reviewer role-mode сверяют текущий
  план со снапшотом фазы; расхождение (план изменён после старта фазы) →
  блок `plan_drift_detected` + требование пере-подтверждения
  (`workflow_update_architecture_plan` с явным `rebaselinePhase: true`
  обновляет снапшот и сбрасывает фазу в `not_started`).
- Проверь взаимодействие с существующей инвалидацией planning-state
  (`invalidatedBy`) — семантика едина: изменение контракта сбрасывает допуски.
- Смоук `task-033-plan-freeze-smokes.ts`.

### WP4: circuit breakers цикла
- Конфиг `loopBudget: { maxCostUsd?, maxWallClockMs?, maxSameFindingRepeats? }`
  (v1-поле, default'ы в defaults.ts; учти v2-адаптер).
- Cost: делегаты уже возвращают `usage.cost` — аккумулируй в durable
  `.pi/workflow-runs/afk-ship/<runId>/state.json` (ship) и в план-фазе
  (обычный цикл); превышение → stop `budget_exhausted` (ship) / блок
  делегирования с эскалацией (WP1 blocking-вопрос «продолжать?»).
- Repeated-finding: нормализованный отпечаток blocking-находок ревью
  (role + первые N символов lowercased) хранится в фазе; одинаковый отпечаток
  ≥ maxSameFindingRepeats (default 2) → вместо очередного re-delegate —
  blocking-вопрос оператору.
- Смоук `task-034-loop-budget-smokes.ts` (чистые функции ship-engine +
  синтетические результаты ревью).

### WP6: калибровка ревьюеров основного workflow
- `scripts/reviewer-calibration/` : 2–3 золотые фикстуры (заведомо сломанный
  дифф + честный дифф) в формате `ReviewerResultLike`; скрипт
  `scripts/task-035-reviewer-calibration-smokes.ts` гоняет их через
  `evaluateReviewerResult`/`buildReviewerMemoForResults` и проверяет вердикты
  (это оффлайн-калибровка детерминированной части; LLM-часть — вне скоупа,
  но заложи файл `docs/reviewer-calibration.md` с инструкцией ручного прогона).

### WP7 (если останется бюджет; иначе — оформи как задачи в PROGRESS-стиле)
- Worktree-изоляция параллельных coder-делегатов (`room`-режим): `git worktree
  add` на делегата + merge-гейт. Большая — согласуй дизайн с оператором через
  WP1 прежде чем писать код.
- Tool-level deny-list для AFK (`push|deploy|pr` в bash делегатов) вместо
  промптного запрета.
- Heartbeat/lease для room-воркеров (`rooms/store.ts`): job без heartbeat
  дольше T → помечается stale, room job освобождается.
- Сквозной `traceId` (planning-room → plan → манифесты → финализация).

## 5. Дисциплина работы

1. По одному WP за раз: реализация → смоуки зелёные → атомарный коммит →
   следующий. Push после каждых 1–2 коммитов в ту же ветку.
2. Новые durable-файлы — только через `fs-atomic`. Новые константы/коды —
   один владелец, без повторных деклараций (см. reviewer-protocol как образец).
3. Каждый новый гейт — fail-closed и с actionable-текстом ошибки (что именно
   сделать, каким инструментом).
4. Обновляй README.md (соответствующие секции) и CONTEXT.md на каждый новый
   контракт: несоответствие документации и кода — это баг класса P0 здесь.
5. Если дизайн-решение неоднозначно (например, форма negative-строк матрицы
   в WP3) — сформулируй варианты с рекомендацией и спроси оператора; не
   выбирай молча. До реализации WP1 — просто вопросом в чате.
6. Коммит-месседжи завершай строкой:
   `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

Начни с WP2. Перед этим прогони полный смоук-сьют, чтобы зафиксировать
базовую линию (ожидаемые падения — только task-009/028/029).
