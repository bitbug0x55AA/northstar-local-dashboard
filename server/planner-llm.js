const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { POLICY, validateProposal } = require('./planner-validator');

const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'planner-system-prompt.txt'), 'utf8').trim();

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
          const error = new Error(parsed.error?.message || parsed.message || `Local LLM returned ${response.statusCode}`);
          error.statusCode = response.statusCode;
          reject(error);
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
  const userInput = String(input || '').trim().slice(0, POLICY.maxInputChars);
  if (!userInput) throw new Error('Planner input is required');
  const todayDate = new Date();
  const today = todayDate.toISOString().slice(0, 10);
  const tomorrow = new Date(todayDate.getTime() + 86400000).toISOString().slice(0, 10);
  const prompt = [SYSTEM_PROMPT, `Today in the user local timezone is ${today}. Tomorrow is ${tomorrow}.`].join('\n\n');
  const messages = [{ role: 'system', content: prompt }, { role: 'user', content: userInput }];
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
  return validateProposal(extractJson(content));
}

module.exports = { interpretPlannerInput };
