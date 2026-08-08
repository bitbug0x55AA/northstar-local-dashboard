const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { POLICY, validateProposal } = require('./planner-validator');

const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'planner-system-prompt.txt'), 'utf8').trim();
const GITHUB_POLISH_VERSION = 'github-polish-v3';

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
    keep_alive: process.env.NORTHSTAR_LLM_KEEP_ALIVE || '5m',
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

function githubIssueRef(repo, number) {
  return `github:${String(repo || '').trim()}#${number}`;
}

function rawGithubPolish(issue) {
  const labels = (issue.labels || []).join(', ');
  return {
    sourceRef: githubIssueRef(issue.repo, issue.number),
    title: `#${issue.number} ${String(issue.title || '').trim()}`.slice(0, 1000),
    notes: [`GitHub: ${issue.repo}`, issue.url ? `URL: ${issue.url}` : '', labels ? `Labels: ${labels}` : ''].filter(Boolean).join('\n').slice(0, 1000),
    category: labels || 'general',
    tags: (issue.labels || []).slice(0, 6)
  };
}

async function polishGithubIssues(issues, language = 'zh') {
  const candidates = (Array.isArray(issues) ? issues : []).filter(issue => issue && issue.repo && issue.number != null && issue.title).slice(0, 20);
  const fallback = candidates.map(rawGithubPolish);
  const endpoint = process.env.NORTHSTAR_LLM_URL || '';
  const model = process.env.NORTHSTAR_LLM_MODEL || '';
  if (!endpoint || !model || !candidates.length) return { items: fallback, used: 0, fallback: true };

  const system = [
    'You polish GitHub issues into concise personal-planner entries.',
    'Return JSON only in this shape: {"items":[{"sourceRef":"...","title":"...","notes":"...","category":"...","tags":["..."]}]}',
    'Keep exactly one output item for each input sourceRef. Never invent facts, dates, priorities, status, IDs, or repository names.',
    'The title should be a clear, action-oriented task title, preserving the issue number prefix.',
    'The notes should be a concise 1-3 sentence execution-oriented summary, followed by the original GitHub URL and labels when present.',
    'Use category for a short grouping such as architecture, bugfix, feature, security, testing, documentation, maintenance, or research.',
    'Extract 2-5 useful tags for technology, domain, stage, or risk. Do not invent tags unsupported by the issue.',
    `Write the polished text in ${language === 'en' ? 'English' : 'Simplified Chinese'}, while keeping code names and issue numbers unchanged.`
  ].join('\n');
  const input = candidates.map(issue => ({
    sourceRef: githubIssueRef(issue.repo, issue.number),
    repo: issue.repo,
    number: issue.number,
    title: String(issue.title).slice(0, 300),
    labels: (issue.labels || []).slice(0, 8),
    url: issue.url || null,
    body: issue.body ? String(issue.body).slice(0, 1200) : null
  }));
  try {
    const isOllamaApi = /\/api\/chat(?:\?|$)/i.test(endpoint);
    const response = await requestJson(endpoint, isOllamaApi ? {
      model, stream: false, format: 'json', keep_alive: process.env.NORTHSTAR_LLM_KEEP_ALIVE || '5m',
      messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(input) }]
    } : {
      model, temperature: 0, messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(input) }], response_format: { type: 'json_object' }
    });
    const content = response.choices?.[0]?.message?.content || response.message?.content || response.output_text;
    const parsed = extractJson(content);
    const byRef = new Map((parsed.items || []).map(item => [String(item.sourceRef || ''), item]));
    const items = fallback.map(item => {
      const polished = byRef.get(item.sourceRef);
      if (!polished || typeof polished.title !== 'string' || !polished.title.trim()) return item;
      return {
        sourceRef: item.sourceRef,
        title: polished.title.trim().slice(0, 1000),
        notes: typeof polished.notes === 'string' && polished.notes.trim() ? polished.notes.trim().slice(0, 1000) : item.notes,
        category: typeof polished.category === 'string' && polished.category.trim() ? polished.category.trim().slice(0, 80) : item.category,
        tags: Array.isArray(polished.tags) ? polished.tags.filter(tag => typeof tag === 'string' && tag.trim()).map(tag => tag.trim().slice(0, 40)).slice(0, 6) : item.tags
      };
    });
    return { items, used: items.filter((item, index) => item.title !== fallback[index].title || item.notes !== fallback[index].notes || item.category !== fallback[index].category || JSON.stringify(item.tags) !== JSON.stringify(fallback[index].tags)).length, fallback: false };
  } catch (error) {
    return { items: fallback, used: 0, fallback: true, error: error.message };
  }
}

module.exports = { GITHUB_POLISH_VERSION, interpretPlannerInput, polishGithubIssues };
