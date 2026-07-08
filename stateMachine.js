const { callAgent } = require('./agentRunner');
const db = require('./db');

const CONFIG = {
  MAX_COMPOSER_ITERATIONS: 3,
  CHANNEL_HISTORY_SIZE: 3,
  MAX_MESSAGE_LENGTH: { telegram: 400, whatsapp: 400, email: 1500, voice: 300, call_script: 500 }
};

function validateMessageLength(composerOutput) {
  const messages = composerOutput?.composer_output?.messages || [];
  const violations = [];
  messages.forEach((msg, i) => {
    const maxLen = CONFIG.MAX_MESSAGE_LENGTH[msg.channel?.toLowerCase()];
    if (maxLen && msg.body?.length > maxLen) {
      violations.push({ touchpoint: i + 1, channel: msg.channel, current: msg.body.length, max: maxLen });
    }
  });
  return { valid: violations.length === 0, violations };
}

function formatAgentReplyForChat(state, output) {
  switch (state) {
    case 'SOPRANO_INTERVIEW': {
      const qs = output?.diagnostic_output?.clarification_needed?.questions
        || output?.planner_output?.clarification_needed?.questions || [];
      return qs.length ? qs.join('\n') : 'Уточните, пожалуйста, недостающие детали по сделке.';
    }
    case 'DIAGNOSING': {
      const c = output?.diagnostic_output?.criteria_assessment;
      if (!c) return JSON.stringify(output?.diagnostic_output || output, null, 2);
      const lines = Object.entries(c).map(([k, v]) => {
        const status = v?.status || v;
        const comment = v?.comment || v?.explanation || '';
        return `${k}: ${status}${comment ? ' — ' + comment : ''}`;
      });
      const conflicts = output?.diagnostic_output?.conflicts_explained || [];
      const conflictText = conflicts.length
        ? '\n\nРасхождения:\n' + conflicts.map(c => `${c.criterion}: ${c.plain_explanation}`).join('\n')
        : '';
      return `Оценка по критериям СОПРАНО:\n${lines.join('\n')}${conflictText}`;
    }
    case 'CONFLICT_RESOLUTION': {
      const conflicts = output?.diagnostic_output?.conflicts_explained || [];
      return conflicts.map((c) => `${c.criterion}: ${c.plain_explanation}\n${c.question_for_manager}`).join('\n\n')
        || 'Есть расхождение между вашей оценкой и оценкой агента — уточните детали.';
    }
    case 'STRATEGY_SELECTION': {
      const s = output?.strategy_output;
      if (!s) return JSON.stringify(output, null, 2);
      const lines = [
        `Стратегия: ${s.primary_strategy || '—'}`,
        s.main_blocker ? `Блокер: ${s.main_blocker}` : null,
        s.recommended_next_step ? `Следующий шаг: ${s.recommended_next_step}` : null,
        s.rationale ? `Обоснование: ${s.rationale}` : null,
      ].filter(Boolean);
      return lines.join('\n');
    }
    case 'COMPOSING': {
      const msgs = output?.composer_output?.messages || [];
      if (!msgs.length) return JSON.stringify(output?.composer_output || output, null, 2);
      return msgs.map((m, i) =>
        `Касание ${i + 1} — ${m.channel || ''}:\n${m.subject ? 'Тема: ' + m.subject + '\n' : ''}${m.body || ''}`
      ).join('\n\n---\n\n');
    }
    case 'REVIEWING': {
      const r = output?.reviewer_output;
      if (!r) return JSON.stringify(output, null, 2);
      const verdict = r.verdict || '—';
      const details = (r.messages_reviewed || []).map(m =>
        `Касание ${m.touchpoint_number}: ${m.verdict}${m.failed_criteria?.length ? ' | Проблемы: ' + m.failed_criteria.join(', ') : ''}${m.fix_instructions ? '\nПравки: ' + m.fix_instructions : ''}`
      ).join('\n');
      return `Результат проверки: ${verdict}\n${details}`;
    }
    case 'ESCALATION':
      return 'После нескольких попыток автоматическая проверка не одобрила сообщение. Рекомендую составить касание вручную — последняя версия и причины показаны выше.';
    case 'LOST_DEAL':
      return output?._lostText || 'Сделка отмечена как потерянная.';
    case 'DISQUALIFICATION':
      return output?.diagnostic_output?.disqualification_reason || 'Сделка не квалифицирована.';
    case 'FINAL_OUTPUT':
      return output?._finalText || 'Сессия завершена.';
    default:
      return JSON.stringify(output, null, 2) || 'Обрабатываю...';
  }
}

// Один шаг машины состояний. managerInput — текст, который менеджер только что отправил.
async function advance(dealId, managerInput) {
  const deal = await db.getDeal(dealId);
  const memory = (await db.loadMemory(dealId)) || {
    session_number: 1, previous_touchpoints: [], confirmed_facts: [], open_questions: []
  };

 const allMessages = await db.getMessages(dealId);
  const dialogHistory = allMessages
    .filter(m => m.role === 'user' || m.role === 'agent')
    .map(m => `[${m.role === 'user' ? 'Менеджер' : 'Агент'}]: ${m.content}`)
    .join('\n\n');

  const baseInput = {
    deal: {
      client: deal.client,
      product: deal.product,
      deal_size: deal.deal_size,
      industry: deal.industry,
      last_contact: deal.last_contact,
      days_silent: deal.days_silent
    },
    materials: {
      correspondence: managerInput,
      dialog_history: dialogHistory,
      user_assessment: deal.criteria
    },
    memory
  };

  let nextState = deal.current_state;
  let output = {};

  switch (deal.current_state) {
    case 'INIT':
    case 'COLLECTING':
    case 'SOPRANO_INTERVIEW': {
      const plannerResult = await callAgent('planner', baseInput);
      output.planner_output = plannerResult?.planner_output;

      if (plannerResult?.planner_output?.clarification_needed?.required) {
        nextState = 'SOPRANO_INTERVIEW';
        break;
      }

      const diagnosticResult = await callAgent('diagnostic', { ...baseInput, planner_output: output.planner_output });
      output.diagnostic_output = diagnosticResult?.diagnostic_output;

      if (diagnosticResult?.diagnostic_output?.clarification_needed?.required) {
        nextState = 'SOPRANO_INTERVIEW';
        break;
      }
      if (diagnosticResult?.diagnostic_output?.conflicts_require_confirmation) {
        nextState = 'CONFLICT_RESOLUTION';
        break;
      }
      nextState = 'DIAGNOSING';
      break;
    }

    case 'DIAGNOSING': {
      // Переход — показать диагностику и сразу пойти в стратегию (либо конфликт уже отработан выше)
      const strategyInput = { ...baseInput, diagnostic_output: deal.last_diagnostic_output };
      const strategyResult = await callAgent('strategy', strategyInput);
      output.strategy_output = strategyResult?.strategy_output;

      if (strategyResult?.strategy_output?.deal_health === 'потеряна') {
        nextState = 'LOST_DEAL';
        break;
      }
      if (strategyResult?.strategy_output?.primary_strategy === 'Disqualification') {
        nextState = 'DISQUALIFICATION';
        break;
      }
      nextState = 'STRATEGY_SELECTION';
      break;
    }

    case 'CONFLICT_RESOLUTION': {
      const diagnosticResult = await callAgent('diagnostic', {
        ...baseInput,
        manager_conflict_response: { new_facts: managerInput }
      });
      output.diagnostic_output = diagnosticResult?.diagnostic_output;
      nextState = 'DIAGNOSING';
      break;
    }

    case 'STRATEGY_SELECTION': {
      const composerInput = {
        ...baseInput,
        strategy_output: deal.last_strategy_output,
        channel_history: memory?.do_not_repeat?.channels_last_used?.slice(0, CONFIG.CHANNEL_HISTORY_SIZE) || [],
        message_length_limits: CONFIG.MAX_MESSAGE_LENGTH,
        iteration: 1
      };
      const composerResult = await callAgent('composer', composerInput, 5000);
      output.composer_output = composerResult?.composer_output;
      nextState = 'COMPOSING';
      break;
    }

    case 'COMPOSING': {
      const composerOutput = { composer_output: deal.last_composer_output };
      const lengthCheck = validateMessageLength(composerOutput);

      if (!lengthCheck.valid) {
        output.reviewer_output = {
          verdict: 'НА ДОРАБОТКУ',
          messages_reviewed: lengthCheck.violations.map((v) => ({
            touchpoint_number: v.touchpoint,
            verdict: 'НА ДОРАБОТКУ',
            failed_criteria: ['channel_fit'],
            fix_instructions: `Сообщение для ${v.channel} слишком длинное: ${v.current}/${v.max} символов.`
          }))
        };
        nextState = 'REVIEWING';
        break;
      }

      const reviewerResult = await callAgent('reviewer', {
        ...baseInput,
        strategy_output: deal.last_strategy_output,
        composer_output: deal.last_composer_output
      });
      output.reviewer_output = reviewerResult?.reviewer_output;
      nextState = 'REVIEWING';
      break;
    }

    case 'REVIEWING': {
      const approved = deal.last_reviewer_output?.verdict === 'ОДОБРЕНО';
      const iterations = (deal.composer_iterations || 1);

      if (approved) {
        nextState = 'MEMORY_UPDATE';
      } else if (iterations >= CONFIG.MAX_COMPOSER_ITERATIONS) {
        nextState = 'ESCALATION';
      } else {
        // Возврат к Composer с фидбэком
        const composerInput = {
          ...baseInput,
          strategy_output: deal.last_strategy_output,
          previous_composer_feedback: deal.last_reviewer_output,
          message_length_limits: CONFIG.MAX_MESSAGE_LENGTH,
          iteration: iterations + 1
        };
        const composerResult = await callAgent('composer', composerInput, 5000);
        output.composer_output = composerResult?.composer_output;
        output._composer_iterations = iterations + 1;
        nextState = 'COMPOSING';
      }
      break;
    }

    case 'ESCALATION':
    case 'MEMORY_UPDATE':
    case 'LOST_DEAL':
    case 'DISQUALIFICATION': {
      const memoryInput = {
        ...baseInput,
        strategy_output: deal.last_strategy_output,
        composer_output: deal.last_composer_output,
        reviewer_output: deal.last_reviewer_output
      };
      const memoryResult = await callAgent('memory', memoryInput, 6000);
      await db.saveMemory(dealId, memoryResult?.memory_output);

      output._finalText = formatFinalSummary(memoryResult?.memory_output, deal.last_strategy_output, deal.last_composer_output);
      nextState = 'FINAL_OUTPUT';
      break;
    }

    case 'FINAL_OUTPUT': {
      // Новая сессия по той же сделке
      nextState = 'INIT';
      output = {};
      break;
    }

    default:
      nextState = 'INIT';
  }

  // Сохранить промежуточные выходы агентов на сделке для следующего шага
  const statePatch = { current_state: nextState };
  if (output.diagnostic_output) statePatch.last_diagnostic_output = output.diagnostic_output;
  if (output.strategy_output) statePatch.last_strategy_output = output.strategy_output;
  if (output.composer_output) statePatch.last_composer_output = output.composer_output;
  if (output.reviewer_output) statePatch.last_reviewer_output = output.reviewer_output;
  if (output._composer_iterations) statePatch.composer_iterations = output._composer_iterations;

  if (output.diagnostic_output?.criteria_assessment) {
    const c = output.diagnostic_output.criteria_assessment;
    statePatch.criteria = {
      financial: c.financial_capacity?.status || c.financial?.status || deal.criteria.financial,
      need: c.need?.status || deal.criteria.need,
      trust: c.trust?.status || deal.criteria.trust,
      authority: c.authority?.status || deal.criteria.authority,
      urgency: c.urgency?.status || deal.criteria.urgency
    };
  }

  await db.updateDealState(dealId, statePatch);

 const chatText = formatAgentReplyForChat(nextState, output)
    || formatAgentReplyForChat(deal.current_state, output);

  return { nextState, chatText, raw: output };
}

function formatFinalSummary(memoryOutput, strategyOutput, composerOutput) {
  if (!memoryOutput) return 'Сессия завершена.';
  const lines = [
    'ИТОГ СЕССИИ',
    strategyOutput?.main_blocker ? `Блокер: ${strategyOutput.main_blocker}` : null,
    strategyOutput?.primary_strategy ? `Стратегия: ${strategyOutput.primary_strategy}` : null,
    composerOutput?.messages?.length ? `Одобренные касания: ${composerOutput.messages.length}` : null,
    memoryOutput.session_summary ? `Резюме: ${JSON.stringify(memoryOutput.session_summary)}` : null
  ].filter(Boolean);
  return lines.join('\n');
}

module.exports = { advance };
