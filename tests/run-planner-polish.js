const assert = require('assert');
const http = require('http');
const { GITHUB_POLISH_BATCH_SIZE, polishGithubIssues } = require('../server/planner-llm');

const issues = Array.from({ length: GITHUB_POLISH_BATCH_SIZE + 1 }, (_, index) => ({
  repo: 'demo', number: index + 1, title: `Raw issue ${index + 1}`, labels: [], updatedAt: '2026-08-09T00:00:00Z'
}));
let calls = 0;
const fakeLlm = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    calls += 1;
    const input = JSON.parse(JSON.parse(body).messages[1].content);
    const items = calls === 1 ? input.map(issue => ({
      sourceRef: issue.sourceRef,
      title: `#${issue.number} 优化后的任务 ${issue.number}`,
      notes: '执行摘要',
      category: 'feature',
      tags: ['test']
    })) : [];
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ message: { content: JSON.stringify({ items }) } }));
  });
});

fakeLlm.listen(0, '127.0.0.1', async () => {
  const previousUrl = process.env.NORTHSTAR_LLM_URL;
  const previousModel = process.env.NORTHSTAR_LLM_MODEL;
  process.env.NORTHSTAR_LLM_URL = `http://127.0.0.1:${fakeLlm.address().port}/api/chat`;
  process.env.NORTHSTAR_LLM_MODEL = 'test';
  try {
    const result = await polishGithubIssues(issues, 'zh');
    assert.equal(result.batches, 2);
    assert.equal(result.failedBatches.length, 1);
    assert.equal(result.failedSourceRefs.length, 1);
    assert.equal(result.items[0].title, '#1 优化后的任务 1');
    assert.equal(result.items.at(-1).title, '#5 Raw issue 5');
    assert.equal(calls, 2);
    console.log('Planner GitHub polish batching checks passed');
  } finally {
    if (previousUrl === undefined) delete process.env.NORTHSTAR_LLM_URL; else process.env.NORTHSTAR_LLM_URL = previousUrl;
    if (previousModel === undefined) delete process.env.NORTHSTAR_LLM_MODEL; else process.env.NORTHSTAR_LLM_MODEL = previousModel;
    fakeLlm.close();
  }
});
