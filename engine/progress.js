/**
 * engine/progress.js — ход менеджера в фоне и что Клоузер сейчас делает.
 *
 * Раньше запрос «ок» держался открытым 2–6 минут без признаков жизни, а
 * выкладка на сервер его обрывала («Load failed»). Теперь (2026-11-13):
 * POST …/continue с { async: true } сразу отвечает «принято», ход идёт
 * в фоне, страница раз в пару секунд спрашивает статус и показывает этап
 * («пишу касания…», «проверяю…», «редактор правит касание 3…»).
 *
 * Задания живут в памяти процесса (один экземпляр на Render). При перезапуске
 * сервера задание теряется — страница честно говорит об этом; при выкладке
 * сервер ждёт завершения начатых заданий (SIGTERM в server.js).
 */
const jobs = new Map(); // dealId → { id, status, stage, startedAt, finishedAt, result, error }
const KEEP_MS = 30 * 60 * 1000;

function setStage(dealId, stage) {
  const j = jobs.get(dealId);
  if (j && j.status === 'running') {
    j.stage = stage;
    j.stageAt = Date.now();
  }
}

function getJob(dealId) {
  const j = jobs.get(dealId);
  if (j && j.status !== 'running' && Date.now() - j.finishedAt > KEEP_MS) { jobs.delete(dealId); return null; }
  return j || null;
}

function isRunning(dealId) {
  return getJob(dealId)?.status === 'running';
}

function runningCount() {
  let n = 0;
  for (const j of jobs.values()) if (j.status === 'running') n++;
  return n;
}

// Запустить ход в фоне. work() — async-функция, её результат кладётся в job.result.
function startJob(dealId, firstStage, work) {
  const job = { id: `${dealId}:${Date.now()}`, status: 'running', stage: firstStage, startedAt: Date.now(), stageAt: Date.now() };
  jobs.set(dealId, job);
  Promise.resolve()
    .then(work)
    .then((result) => { job.status = 'done'; job.result = result; })
    .catch((e) => { job.status = 'error'; job.error = e; console.error('[JOB ERROR]', dealId, e); })
    .finally(() => { job.finishedAt = Date.now(); });
  return job;
}

// Этап по состоянию сделки — до вызова агентов.
function stageForState(state) {
  switch (state) {
    case 'INIT': case 'COLLECTING': case 'SOPRANO_INTERVIEW': return 'Изучаю переписку и оцениваю сделку по формуле закрытия…';
    case 'DIAGNOSING': return 'Составляю стратегию и план касаний…';
    case 'CONFLICT_RESOLUTION': return 'Пересматриваю оценку…';
    case 'STRATEGY_SELECTION': return 'Пишу касания по плану…';
    case 'COMPOSING': case 'REVIEWING': case 'ESCALATION': return 'Дорабатываю касания…';
    case 'FINAL_OUTPUT': return 'Начинаю новую сессию…';
    default: return 'Работаю…';
  }
}

module.exports = { setStage, getJob, isRunning, startJob, runningCount, stageForState };
