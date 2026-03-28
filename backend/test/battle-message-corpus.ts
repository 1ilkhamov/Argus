export interface BattleMessage {
  /** Logical conversation name — same key reuses the same conversationId */
  conversation: string;
  content: string;
}

const corpus: BattleMessage[] = [];
const msg = (conversation: string, content: string) => corpus.push({ conversation, content });

// ── Seeding facts & episodic context (10) ───────────────────────────────────
msg('seed', 'Меня зовут Илья.');
msg('seed', 'Я lead backend engineer.');
msg('seed', 'Мой основной проект — Argus.');
msg('seed', 'Моя текущая цель — стабилизировать memory subsystem перед релизом.');
msg('seed', 'Нельзя использовать внешний vector database в этом проекте.');
msg('seed', 'Сейчас я разбираюсь с orchestration complexity в memory layer.');
msg('seed', 'Релиз через три дня, поэтому опасные миграции нежелательны.');
msg('seed', 'Мы решили не делать broad rewrite ChatService в этом спринте.');
msg('seed', 'Текущая задача — production-safe refactor MemoryResolverService.');
msg('seed', 'Пиши по-русски.');

// ── Technical workbench (15) ─────────────────────────────────────────────────
msg('workbench', 'Объясни разницу между optimistic locking и pessimistic locking.');
msg('workbench', 'Как безопасно распилить orchestration-service на внутренние pipeline?');
msg('workbench', 'Почему один сервис с retrieval, commit и grounding сразу — это smell?');
msg('workbench', 'Предложи safe order рефакторинга memory resolver без broad rewrite.');
msg('workbench', 'Сформулируй 5 production-risk checks перед таким рефакторингом.');
msg('workbench', 'Как проверить, что response grounding реально соблюдается?');
msg('workbench', 'Что сломается первым если transient preferences попадут в durable profile?');
msg('workbench', 'Дай короткий план ручной проверки памяти после рефакторинга.');
msg('workbench', 'Какие 3 лога важнее всего вокруг memory commit path?');
msg('workbench', 'Объясни, как бы ты мерил quality memory answer в проде.');
msg('workbench', 'Сравни facade и coordinator pattern для нашего кейса.');
msg('workbench', 'В одном абзаце: почему commit retry важнее красивой архитектуры?');
msg('workbench', 'Чем опасна дублированная episodic memory?');
msg('workbench', 'Стоит ли объединять archive retrieval и structured retrieval?');
msg('workbench', 'Составь короткий чеклист перед prod deploy.');

// ── Recall within seed conversation (10) ────────────────────────────────────
msg('seed', 'Как меня зовут?');
msg('seed', 'Над каким проектом я работаю?');
msg('seed', 'Какая у меня роль?');
msg('seed', 'Какая у меня цель сейчас?');
msg('seed', 'Какие ограничения ты помнишь?');
msg('seed', 'Что ты помнишь обо мне?');
msg('seed', 'What do you remember about me?');
msg('seed', 'Do you know my role?');
msg('seed', 'Какой у нас рабочий контекст?');
msg('seed', 'Какой у нас фоновый контекст?');

// ── Preference tuning (10) ───────────────────────────────────────────────────
msg('prefs', 'Отвечай кратко и без лишней воды.');
msg('prefs', 'Не предлагай следующие шаги.');
msg('prefs', 'Теперь отвечай подробнее и теплее.');
msg('prefs', 'В конце можешь предлагать следующие шаги.');
msg('prefs', 'Switch to English for the next answer.');
msg('prefs', 'Continue with the refactor plan.');
msg('prefs', 'С этого момента по умолчанию отвечай теплее, подробнее и с примерами.');
msg('prefs', 'Вернись на русский.');
msg('prefs', 'Не бойся спорить, если я ошибаюсь.');
msg('prefs', 'Снова кратко и по делу.');

// ── Episodic memory building (15) ────────────────────────────────────────────
msg('memb', 'Decision: мы решили не делать broad rewrite ChatService в этом спринте.');
msg('memb', 'Task: нужно сделать production-safe refactor MemoryResolverService.');
msg('memb', 'Background: релиз через три дня, рисковые migration нежелательны.');
msg('memb', 'Working context: backend на NestJS, storage сейчас SQLite.');
msg('memb', 'Нужно проверить, что commit retry не ломает память.');
msg('memb', 'Нельзя трогать публичный API MemoryResolverService.');
msg('memb', 'Моя текущая цель — прогнать 100 боевых сообщений и проверить память в БД.');
msg('memb', 'Decision: first stabilize memory, then simplify ChatService.');
msg('memb', 'Task: собрать отчёт по качеству памяти.');
msg('memb', 'Background: у нас есть manual-test findings по memory.');
msg('memb', 'Напомни текущую цель.');
msg('memb', 'Какие решения ты помнишь?');
msg('memb', 'Какие ограничения ты помнишь сейчас?');
msg('memb', 'Какой рабочий контекст активен?');
msg('memb', 'Какой фоновый контекст у нас есть?');

// ── Noise — no memorable content (15) ───────────────────────────────────────
msg('noise', 'Подробно объясни CAP theorem.');
msg('noise', 'Что такое MMR reranking?');
msg('noise', 'Сравни BM25 и vector search.');
msg('noise', 'Чем отличается prompt grounding от response validation?');
msg('noise', 'Расскажи про trade-offs optimistic UI.');
msg('noise', 'Объясни, что такое uncertainty-first answer policy.');
msg('noise', 'Покажи пример хорошей rollback strategy.');
msg('noise', 'Как назвать smell, когда один сервис делает слишком много?');
msg('noise', 'Почему duplicate episodic memory опасна?');
msg('noise', 'Как работает version conflict retry?');
msg('noise', 'Объясни разницу между soft delete и hard delete.');
msg('noise', 'Что такое idempotency key в API дизайне?');
msg('noise', 'Как работает two-phase commit в distributed systems?');
msg('noise', 'Объясни eventual consistency на примере.');
msg('noise', 'Что такое circuit breaker pattern?');

// ── Memory commands (13) ─────────────────────────────────────────────────────
msg('cmds', 'Покажи snapshot памяти.');
msg('cmds', 'Закрепи project.');
msg('cmds', 'Закрепи goal.');
msg('cmds', 'Открепи goal.');
msg('cmds', 'Забудь проект Argus.');
msg('cmds', 'Что ты помнишь обо мне?');
msg('cmds', 'Мой проект теперь Orion.');
msg('cmds', 'Над каким проектом я работаю?');
msg('cmds', 'Забудь имя.');
msg('cmds', 'Что ты помнишь обо мне?');
msg('cmds', 'Закрепи текущее ограничение.');
msg('cmds', 'Открепи текущее ограничение.');
msg('cmds', 'Покажи snapshot памяти.');

// ── Re-seed after forget (5) ─────────────────────────────────────────────────
msg('reseed', 'Меня зовут Илья.');
msg('reseed', 'Мой проект Orion Control Plane.');
msg('reseed', 'Я staff platform engineer.');
msg('reseed', 'Моя цель — завершить memory battle test и проверить БД.');
msg('reseed', 'Что ты помнишь обо мне?');

// ── Cross-chat recall — new conversation (7) ─────────────────────────────────
msg('cross', 'Как меня зовут?');
msg('cross', 'Какой у меня проект?');
msg('cross', 'Какая у меня роль?');
msg('cross', 'Какая у меня цель?');
msg('cross', 'Объясни кратко состояние нашего проекта.');
msg('cross', 'Сделай резюме того, что важно помнить про мой рабочий контекст.');
msg('cross', 'Спасибо, это всё.');

if (corpus.length !== 100) {
  throw new Error(`Expected 100 battle messages, got ${corpus.length}`);
}

export const battleCorpus = corpus;
