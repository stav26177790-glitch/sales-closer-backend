/**
 * tests/harness.js — прогон НАСТОЯЩЕГО stateMachine.advance() на моках.
 *
 * В отличие от старых тестов (test_*.js в корне), файлы db.js и
 * agentRunner.js на диске не подменяются: моки кладутся прямо в
 * require.cache до загрузки stateMachine.js. Если тест упадёт, рабочие
 * файлы останутся нетронутыми.
 *
 * Сценарий описывает стартовую сделку, ответы агентов (очередь на каждого
 * агента) и сообщения менеджера. Харнесс ведёт себя как server.js:
 * сохраняет сообщение менеджера, вызывает advance(), сохраняет ответ агента.
 * На выходе — то, что видит менеджер, и то, что ушло в агенты и в базу.
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STATE_MACHINE = path.join(ROOT, 'stateMachine.js');
const DB = path.join(ROOT, 'db.js');
const RUNNER = path.join(ROOT, 'agentRunner.js');

const TODAY_TOKEN = '<TODAY>';
const today = () => new Date().toISOString().slice(0, 10);

// Дата меняется каждый день — в снимках заменяем её на постоянную метку.
function normalize(value) {
  const t = today();
  return JSON.parse(JSON.stringify(value === undefined ? null : value).split(t).join(TODAY_TOKEN));
}

function createDb(initialDeal) {
  let deal = { ...initialDeal };
  let memory = null;
  const messages = [];
  const patches = [];
  return {
    get deal() { return deal; },
    patches,
    messages,
    api: {
      async getDeal() { return deal; },
      async loadMemory() { return memory; },
      async getMessages() { return messages.slice(); },
      async updateDealState(_id, patch) {
        patches.push(patch);
        deal = { ...deal, ...patch };
        return deal;
      },
      async saveMemory(_id, memoryOutput) { memory = memoryOutput; },
      async addMessage(_id, role, content, state) {
        messages.push({ role, content, state });
      },
    },
  };
}

function createRunner(script) {
  const queues = {};
  for (const [agent, responses] of Object.entries(script || {})) queues[agent] = responses.slice();
  const calls = [];
  return {
    calls,
    leftovers: () => Object.entries(queues).filter(([, q]) => q.length).map(([a, q]) => `${a}: ${q.length}`),
    api: {
      async callAgent(agentName, input, maxTokens) {
        // Теневой классификатор вызывается в фоне и не влияет на поведение.
        if (agentName === 'intent_classifier') {
          return { intent_classifier_output: { intent: 'other', confidence: 'low' } };
        }
        calls.push({ agent: agentName, maxTokens: maxTokens ?? null, input });
        const q = queues[agentName];
        if (!q || !q.length) {
          throw new Error(`Сценарий не предусматривает вызов агента "${agentName}" (вызов №${calls.length})`);
        }
        const next = q.shift();
        return typeof next === 'function' ? next(input) : JSON.parse(JSON.stringify(next));
      },
    },
  };
}

function loadStateMachine(dbApi, runnerApi) {
  // Сбрасываем все модули проекта (stateMachine.js, engine/…), чтобы каждый
  // сценарий получил свежие копии с нашими моками и чистые очереди advance().
  for (const p of Object.keys(require.cache)) {
    if (p.startsWith(ROOT) && !p.includes(`${path.sep}node_modules${path.sep}`) && !p.startsWith(__dirname)) {
      delete require.cache[p];
    }
  }
  const fake = (filename, exports) => {
    require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
  };
  fake(DB, dbApi);
  fake(RUNNER, runnerApi);
  return require(STATE_MACHINE);
}

// advance() защищается от повторов по времени (Date.now) — в тестах время
// "идёт" по минуте на каждый вызов, чтобы одинаковые сообщения подряд
// (например, два "ок") не считались дублем.
function withFakeClock(fn) {
  const realNow = Date.now;
  let clock = Date.UTC(2026, 0, 1);
  Date.now = () => (clock += 60_000);
  return Promise.resolve()
    .then(fn)
    .finally(() => { Date.now = realNow; });
}

async function runScenario(scenario) {
  const db = createDb({ id: `deal-${scenario.name}`, ...scenario.deal });
  const runner = createRunner(scenario.agents);
  const { advance } = loadStateMachine(db.api, runner.api);
  const steps = [];

  await withFakeClock(async () => {
    for (const message of scenario.messages) {
      const stateBefore = db.deal.current_state;
      const callsBefore = runner.calls.length;
      const patchesBefore = db.patches.length;
      await db.api.addMessage(db.deal.id, 'user', message, stateBefore);
      const result = await advance(db.deal.id, message);
      await db.api.addMessage(db.deal.id, 'agent', result.chatText, result.nextState);
      steps.push({
        message,
        stateBefore,
        nextState: result.nextState,
        chatText: result.chatText,
        agentCalls: runner.calls.slice(callsBefore),
        dbPatches: db.patches.slice(patchesBefore),
      });
    }
  });

  return normalize({
    name: scenario.name,
    description: scenario.description,
    unusedAgentResponses: runner.leftovers(),
    steps,
  });
}

module.exports = { runScenario, TODAY_TOKEN };
