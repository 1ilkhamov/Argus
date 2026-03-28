export interface BattleMessage {
  /** Logical conversation name — same key reuses the same conversationId */
  conversation: string;
  content: string;
}

const corpus: BattleMessage[] = [];
const msg = (conversation: string, content: string) => corpus.push({ conversation, content });

// ═══════════════════════════════════════════════════════════════════════════════
//  PHASE 1: SEED — Identity, facts, constraints (10)
// ═══════════════════════════════════════════════════════════════════════════════

msg('seed', 'Меня зовут Илья.');
msg('seed', 'Я staff platform engineer в компании NovaTech.');
msg('seed', 'Мой основной проект — Argus, AI-assistant backend на NestJS + TypeScript.');
msg('seed', 'Мы используем SQLite для хранения, Qdrant для векторов.');
msg('seed', 'Моя текущая цель — стабилизировать memory subsystem перед релизом.');
msg('seed', 'Нельзя использовать внешний managed vector DB кроме Qdrant.');
msg('seed', 'Релиз Argus v2 через три дня, опасные миграции запрещены.');
msg('seed', 'Команда: я (backend), Макс (frontend React), Лена (ML pipeline).');
msg('seed', 'Пиши по-русски, кратко и по делу.');
msg('seed', 'Мой email — ilya@novatech.dev, timezone UTC+5.');

// ═══════════════════════════════════════════════════════════════════════════════
//  PHASE 2: CONTRADICTIONS — Override facts to test contradiction detection (8)
// ═══════════════════════════════════════════════════════════════════════════════

msg('contradict', 'Я теперь работаю в CloudBase, ушёл из NovaTech.');
msg('contradict', 'Мой проект теперь называется Orion, Argus закрыли.');
msg('contradict', 'Мы перешли на PostgreSQL, SQLite больше не используем.');
msg('contradict', 'Лена ушла из команды, вместо неё пришёл Артём на ML.');
msg('contradict', 'Нет, подожди — мы всё ещё на SQLite, забудь про PostgreSQL.');
msg('contradict', 'Мой email изменился на ilya@cloudbase.io.');
msg('contradict', 'Timezone теперь UTC+3, я переехал.');
msg('contradict', 'Релиз сдвинулся на неделю, теперь не через три дня.');

// ═══════════════════════════════════════════════════════════════════════════════
//  PHASE 3: EPISODES & DECISIONS — Build episodic context (10)
// ═══════════════════════════════════════════════════════════════════════════════

msg('episodes', 'Decision: не делаем broad rewrite ChatService в текущем спринте.');
msg('episodes', 'Сегодня провели code review memory pipeline — нашли три бага в recall merger.');
msg('episodes', 'Task: production-safe refactor MemoryResolverService до релиза.');
msg('episodes', 'Вчера деплоили hotfix для embedding service — упал Qdrant коннектор.');
msg('episodes', 'Артём предложил вынести knowledge graph в отдельный микросервис.');
msg('episodes', 'Мы отклонили идею микросервиса — слишком рискованно перед релизом.');
msg('episodes', 'Decision: сначала стабилизируем memory, потом упрощаем ChatService.');
msg('episodes', 'Sprint goal: прогнать 100 боевых сообщений, проверить память в БД.');
msg('episodes', 'Нашли race condition в auto-capture при параллельных запросах.');
msg('episodes', 'Зафиксировали: TTL для working memory = 4 часа, для session = 24 часа.');

// ═══════════════════════════════════════════════════════════════════════════════
//  PHASE 4: PREFERENCES — Tone, language, style changes (6)
// ═══════════════════════════════════════════════════════════════════════════════

msg('prefs', 'Отвечай кратко и без лишней воды.');
msg('prefs', 'Не предлагай следующие шаги, если я не прошу.');
msg('prefs', 'Switch to English for the next answer.');
msg('prefs', 'Вернись на русский. Теперь отвечай теплее и с примерами.');
msg('prefs', 'Не бойся спорить со мной, если я ошибаюсь.');
msg('prefs', 'Снова кратко и по делу, без эмоций.');

// ═══════════════════════════════════════════════════════════════════════════════
//  PHASE 5: TECHNICAL LEARNING — Domain knowledge (8)
// ═══════════════════════════════════════════════════════════════════════════════

msg('tech', 'Объясни разницу между optimistic и pessimistic locking.');
msg('tech', 'Как работает exponential decay для scoring в recall pipeline?');
msg('tech', 'Сравни BM25 и vector search для нашего use case.');
msg('tech', 'Почему Jaccard similarity плохо работает для коротких текстов?');
msg('tech', 'Объясни Reciprocal Rank Fusion для merge recall results.');
msg('tech', 'Как правильно нормализовать composite score для confidence?');
msg('tech', 'Чем опасна дублированная episodic memory для recall quality?');
msg('tech', 'Как slot-based diversity filter предотвращает information bubble?');

// ═══════════════════════════════════════════════════════════════════════════════
//  PHASE 6: MEMORY COMMANDS — Pin, forget, snapshot (10)
// ═══════════════════════════════════════════════════════════════════════════════

msg('cmds', 'Покажи snapshot памяти.');
msg('cmds', 'Закрепи мою роль.');
msg('cmds', 'Закрепи проект.');
msg('cmds', 'Забудь мой email.');
msg('cmds', 'Покажи snapshot памяти.');
msg('cmds', 'Открепи проект.');
msg('cmds', 'Закрепи sprint goal.');
msg('cmds', 'Закрепи team composition.');
msg('cmds', 'Забудь timezone.');
msg('cmds', 'Покажи snapshot памяти.');

// ═══════════════════════════════════════════════════════════════════════════════
//  PHASE 7: FILLER — Long conversation to approach trim threshold (18)
// ═══════════════════════════════════════════════════════════════════════════════

msg('filler', 'Расскажи про CAP theorem подробно.');
msg('filler', 'Что такое CRDT и когда его использовать?');
msg('filler', 'Объясни event sourcing на примере.');
msg('filler', 'Что такое saga pattern в микросервисах?');
msg('filler', 'Расскажи про circuit breaker pattern.');
msg('filler', 'Как работает two-phase commit?');
msg('filler', 'Объясни eventual consistency на примере.');
msg('filler', 'Что такое idempotency key в API?');
msg('filler', 'Объясни backpressure в реактивных системах.');
msg('filler', 'Как работает consistent hashing?');
msg('filler', 'Расскажи про leader election в distributed systems.');
msg('filler', 'Что такое write-ahead log?');
msg('filler', 'Объясни gossip protocol.');
msg('filler', 'Как работает Raft consensus?');
msg('filler', 'Объясни разницу между strong и eventual consistency.');
msg('filler', 'Что такое vector clock?');
msg('filler', 'Расскажи про bloom filter.');
msg('filler', 'Как работает LSM-tree?');

// ═══════════════════════════════════════════════════════════════════════════════
//  PHASE 8: 30 BATTLE QUESTIONS — across fresh conversations
// ═══════════════════════════════════════════════════════════════════════════════

// ── Group A: Hard identity recall after contradictions (6) ───────────────────
msg('battle-a', 'Как меня зовут и где я работаю?');                           // 1: recall after company change
msg('battle-a', 'Какой у меня основной проект сейчас?');                       // 2: Argus→Orion contradiction
msg('battle-a', 'Какую СУБД мы используем — PostgreSQL или SQLite?');           // 3: triple contradiction (SQLite→PG→SQLite)
msg('battle-a', 'Кто в моей команде? Перечисли всех с ролями.');               // 4: team change (Лена→Артём)
msg('battle-a', 'Какой у меня email?');                                        // 5: email was forgotten via command
msg('battle-a', 'В каком timezone я нахожусь?');                               // 6: timezone was forgotten via command

// ── Group B: Contradiction awareness (4) ─────────────────────────────────────
msg('battle-b', 'Ты замечаешь противоречия в том, что я тебе говорил? Перечисли.');  // 7: meta-contradiction check
msg('battle-b', 'Что правда — я в NovaTech или в CloudBase?');                       // 8: direct contradiction probe
msg('battle-b', 'Мы используем Qdrant или нет? А что с ограничением?');              // 9: constraint recall
msg('battle-b', 'Когда релиз — через три дня или через неделю?');                    // 10: deadline contradiction

// ── Group C: Episodic recall — decisions & events (5) ────────────────────────
msg('battle-c', 'Какие решения (decisions) мы принимали? Перечисли все.');             // 11: episode recall
msg('battle-c', 'Какие баги и проблемы мы находили?');                                // 12: episode recall
msg('battle-c', 'Какой sprint goal мы установили?');                                  // 13: pinned sprint goal
msg('battle-c', 'Что Артём предлагал и что мы решили?');                              // 14: specific episode
msg('battle-c', 'Какие параметры TTL мы зафиксировали для memory?');                  // 15: precise numeric recall

// ── Group D: Cross-conversation recall + provenance (5) ──────────────────────
msg('battle-d', 'Что ты помнишь обо мне из всех наших разговоров?');                  // 16: full cross-chat summary
msg('battle-d', 'В каком разговоре я менял место работы?');                            // 17: provenance tracking
msg('battle-d', 'Какие memory commands я выполнял? Что закреплено?');                  // 18: command audit
msg('battle-d', 'Сделай полную сводку: кто я, что делаю, какие ограничения, цели.');  // 19: comprehensive recall
msg('battle-d', 'Какие технические темы мы обсуждали? Только список.');               // 20: learning recall

// ── Group E: Confidence & diversity stress (5) ───────────────────────────────
msg('battle-e', 'Какой у меня любимый язык программирования?');                       // 21: never mentioned → low confidence
msg('battle-e', 'Ты уверен в информации о моей команде? Насколько?');                 // 22: confidence self-assessment
msg('battle-e', 'Дай мне 5 фактов обо мне от самого уверенного к наименее.');         // 23: ranked confidence
msg('battle-e', 'Что ты точно НЕ знаешь обо мне?');                                  // 24: honesty about gaps
msg('battle-e', 'Перечисли всё что ты помнишь: факты, события, решения, предпочтения отдельно.'); // 25: diversity recall

// ── Group F: Pinned memory, decay, edge cases (5) ───────────────────────────
msg('battle-f', 'Что у тебя закреплено (pinned)? Перечисли.');                        // 26: pinned audit
msg('battle-f', 'Какая информация обо мне самая старая?');                             // 27: temporal/decay
msg('battle-f', 'Если бы тебе нужно было выбрать 3 самых важных факта обо мне — какие?'); // 28: importance ranking
msg('battle-f', 'Составь timeline наших взаимодействий в хронологическом порядке.');   // 29: temporal reasoning
msg('battle-f', 'Резюмируй в трёх предложениях: кто я, что делаю, что важно помнить.'); // 30: final synthesis

if (corpus.length !== 100) {
  throw new Error(`Expected 100 battle messages, got ${corpus.length}`);
}

export const battleCorpus = corpus;
