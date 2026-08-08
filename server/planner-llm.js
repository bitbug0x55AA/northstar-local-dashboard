const http = require('http');
const https = require('https');

function requestJson(target, body, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const transport = url.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);
    const request = transport.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: timeoutMs
    }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        let parsed;
        try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
        if (response.statusCode >= 400) {
          reject(new Error(parsed.error?.message || parsed.message || `Local LLM returned ${response.statusCode}`));
          return;
        }
        resolve(parsed);
      });
    });
    request.on('timeout', () => request.destroy(new Error('Local LLM request timed out')));
    request.on('error', reject);
    request.write(payload);
    request.end();
  });
}

function extractJson(text) {
  const cleaned = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch {}
  }
  throw new Error('Local LLM did not return valid JSON');
}

async function interpretPlannerInput(input) {
  const endpoint = process.env.NORTHSTAR_LLM_URL || '';
  const model = process.env.NORTHSTAR_LLM_MODEL || '';
  if (!endpoint || !model) {
    const error = new Error('Local LLM is not configured. Set NORTHSTAR_LLM_URL and NORTHSTAR_LLM_MODEL.');
    error.statusCode = 503;
    throw error;
  }
  const todayDate = new Date();
  const today = todayDate.toISOString().slice(0, 10);
  const tomorrowDate = new Date(todayDate.getTime() + 86400000);
  const tomorrow = tomorrowDate.toISOString().slice(0, 10);
  const prompt = [
    'You are the Northstar Personal Planner parser.',
    'Convert the user message into concrete JSON operations. Do not answer conversationally.',
    'Return JSON only: {"operations":[],"needsConfirmation":true,"clarification":null}.',
    'Allowed operation types and fields:',
    '- create_task: title, notes, status (planned|in-progress|done|cancelled), priority (low|medium|high), dueAt',
    '- create_event: title, startAt, endAt, notes',
    '- log_progress: content, occurredAt',
    '- update_task: id, and one of title, notes, status, priority, dueAt',
    `Today in the user local timezone is ${today}. Resolve 今天/today to this date and 明天/tomorrow to the next date.`,
    'If the user says something was completed, always create a log_progress operation.',
    'If a future activity is requested without an exact time, create a task with a date-only dueAt instead of inventing a time.',
    'Never output placeholder dates such as YYYY-MM-DD; every date value must be a real ISO date or null.',
    'Never delete data, modify GitHub, execute commands, or invent project IDs.',
    'Example input: 今天完成 CDSA 复习，明天安排 OST2 学习两小时',
    `Example output: {"operations":[{"type":"log_progress","content":"完成 CDSA 复习","occurredAt":"${today}"},{"type":"create_task","title":"OST2 学习","dueAt":"${tomorrow}"}],"needsConfirmation":true,"clarification":null}`
  ].join('\n');
  const messages = [{ role: 'system', content: prompt }, { role: 'user', content: String(input || '').slice(0, 4000) }];
  const isOllamaApi = /\/api\/chat(?:\?|$)/i.test(endpoint);
  const response = await requestJson(endpoint, isOllamaApi ? {
    model,
    stream: false,
    format: 'json',
    messages
  } : {
    model,
    temperature: 0,
    messages,
    response_format: { type: 'json_object' }
  });
  const content = response.choices?.[0]?.message?.content || response.message?.content || response.output_text;
  const parsed = extractJson(content);
  if (!parsed || !Array.isArray(parsed.operations)) throw new Error('Local LLM response is missing operations');
  if (parsed.operations.length > 20) throw new Error('Local LLM returned too many operations');
  return {
    operations: parsed.operations,
    needsConfirmation: parsed.needsConfirmation !== false,
    clarification: parsed.clarification || null
  };
}

module.exports = { interpretPlannerInput };
