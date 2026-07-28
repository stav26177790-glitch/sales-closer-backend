/**
 * fixtures.js
 * Фиксированные входные данные для live-проверок (требуют вызова LLM
 * через agentRunner.callAgent). Каждая фикстура воссоздаёт условия,
 * в которых баг реально проявился на ручном тесте в сессии 2.
 */
const TODAY = '2026-07-19';

const DEAL_SIGNAGE = {
  client: 'СтройДвор',
  product: 'вывеска на фасад',
  deal_size: 420000,
  industry: 'signage',
  last_contact: '2026-07-15',
  days_silent: 4
};

module.exports = {
  TODAY,

  // --- Баг №13: повторяющийся хедж-смягчитель при массовой правке на давление ---
  bug13_hedge_repetition: {
    agent: 'composer',
    input: {
      today: TODAY,
      deal: DEAL_SIGNAGE,
      materials: 'Клиент написал: "хватит давить, я подумаю сам, когда будет надо".',
      strategy_output: { primary_strategy: { name: 'Soft Nurture', goal: 'снять давление, оставить дверь открытой' } },
      previous_composer_feedback: {
        source: 'reviewer',
        fix_instructions: 'Все 3 касания создают давление (агрессивный CTA, искусственный дедлайн) — смягчить формулировки, убрать нажим, но сохранить конкретный следующий шаг.',
        failed_criteria: ['no_pressure', 'no_pressure', 'no_pressure']
      },
      iteration: 2
    },
    // Список типовых хеджей, которые ранее использовались механически и повторялись
    knownHedges: ['если пригодится', 'как будет удобно', 'если что', 'по возможности', 'если появится время'],
    assert(output) {
      const messages = output?.composer_output?.messages || output?.messages || [];
      if (messages.length < 2) return { pass: false, detail: `ожидалось несколько касаний, получено ${messages.length}` };
      const bodies = messages.map((m) => (m.body || '').toLowerCase());
      const repeats = [];
      for (const hedge of this.knownHedges) {
        const count = bodies.filter((b) => b.includes(hedge)).length;
        if (count > 1) repeats.push(`"${hedge}" встречается в ${count} касаниях`);
      }
      return {
        pass: repeats.length === 0,
        detail: repeats.length ? repeats.join('; ') : 'дублирующихся типовых хеджей не найдено'
      };
    }
  },

  // --- Баг №15/№23: фабрикация данных — нет измеренных данных во входе ---
  bug15_23_data_fabrication: {
    agent: 'composer',
    input: {
      today: TODAY,
      deal: DEAL_SIGNAGE,
      materials: 'Инженер клиента спросил: "Какие у вас сроки монтажа с учётом погодных ограничений в этом сезоне?" Точных данных по трафику или инженерным расчётам по этому объекту в переписке нет.',
      strategy_output: { primary_strategy: { name: 'Trust Building', goal: 'дать честный ответ на технический вопрос' } },
      message_length_limits: { whatsapp: 400 }
    },
    // Числа, которых точно не было во входных данных (кроме типового норматива 10 дней,
    // который допустим ТОЛЬКО с оговоркой "базовый/ориентировочный")
    forbiddenNumberPatterns: [/\b\d+\s*дней?\s+(запас|буфер|резерв)/i, /итого\s+\d+\s*дней/i, /\b18\s*дней/i],
    assert(output) {
      const messages = output?.composer_output?.messages || output?.messages || [];
      if (!messages.length) return { pass: false, detail: 'нет касаний в выводе' };
      const problems = [];
      messages.forEach((m, i) => {
        const body = m.body || '';
        for (const re of this.forbiddenNumberPatterns) {
          if (re.test(body)) problems.push(`касание ${i + 1}: найдена вероятно выдуманная "надстройка" по паттерну ${re}`);
        }
        // Проверка attachment по старому Правилу 11: если content есть, но входные
        // данные не содержали измеренных цифр — это подозрительно.
        if (m.attachment?.content && /\d{2,}/.test(m.attachment.content) && !/базов|ориентировочн/i.test(m.attachment.content)) {
          problems.push(`касание ${i + 1}: attachment.content содержит числа без оговорки "базовый/ориентировочный"`);
        }
      });
      return { pass: problems.length === 0, detail: problems.length ? problems.join('; ') : 'фабрикации не обнаружено' };
    }
  },

  // --- Баг №16: незапрошенная правка + повтор маркера подводки ---
  bug16_unrequested_edit: {
    agent: 'composer',
    input: {
      today: TODAY,
      deal: DEAL_SIGNAGE,
      materials: 'История переписки с клиентом, 3 касания уже отправлены ранее.',
      strategy_output: { primary_strategy: { name: 'Soft Nurture' } },
      previous_composer_feedback: {
        source: 'manager',
        manager_feedback: 'Касание 2 слишком длинное, сократи в 2 раза. Касание 1 и 3 не трогай.'
      },
      // Базовые тексты предыдущей версии — используются для сверки касаний 1 и 3
      previousMessages: [
        { touchpoint_number: 1, body: 'Александр, добрый день! Уточняю, актуален ли вопрос по вывеске на фасад — можем обсудить детали в четверг в 11:00?' },
        { touchpoint_number: 2, body: 'Длинный текст про монтаж, сроки, гарантию и оплату, который нужно сократить вдвое по просьбе менеджера...' },
        { touchpoint_number: 3, body: 'Слушайте, отправляю расчёт по вывеске — если появятся вопросы, звоните в любое время.' }
      ],
      iteration: 2
    },
    assert(output) {
      const messages = output?.composer_output?.messages || output?.messages || [];
      const prev = this.input.previousMessages;
      if (!messages.length) return { pass: false, detail: 'нет касаний в выводе' };
      const problems = [];
      const t1 = messages.find((m) => m.touchpoint_number === 1);
      const t3 = messages.find((m) => m.touchpoint_number === 3);
      if (t1 && t1.body !== prev[0].body) problems.push('касание 1 изменено, хотя менеджер просил не трогать');
      if (t3 && t3.body !== prev[2].body) problems.push('касание 3 изменено, хотя менеджер просил не трогать');
      const bodies = messages.map((m) => (m.body || '').toLowerCase());
      const markerCounts = {};
      for (const marker of ['слушайте', 'кстати', 'единственное', 'можно']) {
        const count = bodies.filter((b) => b.trim().startsWith(marker) || b.includes(`, ${marker}`)).length;
        if (count > 1) markerCounts[marker] = count;
      }
      if (Object.keys(markerCounts).length) {
        problems.push(`маркер подводки повторяется: ${JSON.stringify(markerCounts)}`);
      }
      return { pass: problems.length === 0, detail: problems.length ? problems.join('; ') : 'незапрошенных правок и повтора маркера не найдено' };
    }
  },

  // --- Баг №18: паттерн без достаточных оснований (недостаточно признаков) ---
  bug18_pattern_insufficient_evidence: {
    agent: 'diagnostic',
    input: {
      today: TODAY,
      deal: DEAL_SIGNAGE,
      materials: 'Марина (посредник без явных полномочий) написала один раз неделю назад: "передам ЛПР, он посмотрит". Больше сообщений не было. Сделке 6 дней.',
      manager_criteria_assessment: {}
    },
    assert(output) {
      const patterns = output?.diagnostic_output?.patterns_detected || output?.patterns_detected || [];
      return {
        pass: Array.isArray(patterns) && patterns.length === 0,
        detail: patterns.length ? `паттерн заявлен при недостаточных основаниях: ${JSON.stringify(patterns)}` : 'паттернов не заявлено — корректно'
      };
    }
  },

  // --- Баг №22 (живая проверка): diagnostic без паттернов -> memory не должен их придумывать ---
  bug22_memory_no_invented_patterns: {
    agent: 'memory',
    input: {
      today: TODAY,
      deal: DEAL_SIGNAGE,
      materials: 'Короткая переписка, сделке 6 дней, без признаков затягивания.',
      diagnostic_output: { patterns_detected: [], scores: {}, primary_blocker: null },
      composer_output: { messages: [] },
      reviewer_output: { verdict: 'ОДОБРЕНО' }
    },
    assert(output) {
      const mo = output?.memory_output || output;
      const blockers = mo?.blockers_history || [];
      const summaryText = JSON.stringify(mo?.session_summary || {});
      const mentionsPattern = /паттерн|затягива|ложное продвижение/i.test(summaryText) || (Array.isArray(blockers) && blockers.some((b) => /паттерн/i.test(JSON.stringify(b))));
      return {
        pass: !mentionsPattern,
        detail: mentionsPattern ? 'memory упомянул паттерн, которого не было в diagnostic_output' : 'паттерн не придуман — корректно'
      };
    }
  }
};
