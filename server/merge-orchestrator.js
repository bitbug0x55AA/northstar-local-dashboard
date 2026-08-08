const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MAX_BRANCHES = 8;
const MAX_OUTPUT = 320000;

function text(value) {
  return String(value ?? '').trim();
}

function validRef(value) {
  const ref = text(value);
  return ref === 'HEAD' || (
    ref.length > 0 && ref.length <= 240 &&
    !ref.startsWith('-') &&
    !/[\s~^:?*[\\]/.test(ref) &&
    !ref.includes('..') &&
    !ref.includes('@{')
  );
}

function runGit(repoPath, args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const safePath = repoPath.replace(/\\/g, '/');
    const child = spawn('git', ['-c', `safe.directory=${safePath}`, ...args], { cwd: repoPath, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: 124, stdout, stderr: 'Git command timed out' });
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout = `${stdout}${chunk}`.slice(-MAX_OUTPUT); });
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-MAX_OUTPUT); });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => finish({ code, stdout, stderr }));
  });
}

async function requireGit(repoPath, args, label) {
  const result = await runGit(repoPath, args);
  if (result.code !== 0) {
    throw new Error(`${label}: ${text(result.stderr || result.stdout) || `git exited with ${result.code}`}`);
  }
  return text(result.stdout);
}

async function resolveCommit(repoPath, ref) {
  return requireGit(repoPath, ['rev-parse', '--verify', `${ref}^{commit}`], `无法解析分支 ${ref}`);
}

async function changedFiles(repoPath, fromSha, ref) {
  const output = await requireGit(repoPath, ['diff', '--name-only', `${fromSha}..${ref}`], `无法读取 ${ref} 的变更文件`);
  return [...new Set(output.split(/\r?\n/).map(text).filter(Boolean))].slice(0, 500);
}

function intersection(left, right) {
  const rightSet = new Set(right);
  return left.filter(item => rightSet.has(item));
}

function parseStatus(output) {
  return output.split(/\r?\n/).map(line => line.trimEnd()).filter(Boolean).slice(0, 100).map(line => ({
    code: line.slice(0, 2),
    path: line.slice(3).trim()
  }));
}

function parseConflictFiles(output) {
  const files = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/Merge conflict in (.+)$/i) || line.match(/CONFLICT[^:]*:\s*(?:.*?\s)?([\w./\\-]+)$/i);
    if (match?.[1]) files.push(match[1].trim());
  }
  return [...new Set(files)].slice(0, 100);
}

async function preflightMerge(repoPath, mergeBase, baseRef, sourceRef) {
  const result = await runGit(repoPath, ['merge-tree', '--trivial-merge', mergeBase, baseRef, sourceRef], 30000);
  const output = `${result.stdout}\n${result.stderr}`.trim();
  const conflictFiles = parseConflictFiles(output);
  const hasConflict = result.code !== 0 || /\bCONFLICT\b|both modified|both added|deleted by/i.test(output);
  return {
    status: hasConflict ? 'conflict' : 'clean',
    conflictFiles,
    details: output.split(/\r?\n/).filter(line => /CONFLICT|both modified|both added|deleted by|Auto-merging/i.test(line)).slice(0, 40)
  };
}

function riskFor(branch) {
  if (branch.preflight.status === 'conflict') return 'critical';
  if (branch.overlapWithBase.length > 0) return 'high';
  if (branch.changedFiles.length > 40) return 'medium';
  return 'low';
}

function heuristicOrder(branches) {
  const rank = { low: 0, medium: 1, high: 2, critical: 3 };
  return [...branches].sort((a, b) => {
    const risk = rank[a.risk] - rank[b.risk];
    if (risk) return risk;
    return (a.overlapWithBase.length + a.pairwiseOverlapCount) - (b.overlapWithBase.length + b.pairwiseOverlapCount);
  }).map(branch => branch.name);
}

function requestJson(target, body, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const transport = url.protocol === 'https:' ? require('https') : require('http');
    const payload = JSON.stringify(body);
    const request = transport.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: timeoutMs
    }, response => {
      let bodyText = '';
      response.on('data', chunk => { bodyText += chunk; });
      response.on('end', () => {
        if (response.statusCode >= 400) {
          reject(new Error(`Local LLM returned ${response.statusCode}`));
          return;
        }
        try { resolve(bodyText ? JSON.parse(bodyText) : {}); } catch { reject(new Error('Local LLM returned invalid JSON')); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Local LLM request timed out')));
    request.on('error', reject);
    request.write(payload);
    request.end();
  });
}

function extractJson(value) {
  const cleaned = text(value).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(cleaned); } catch {}
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
  throw new Error('Local LLM did not return a JSON object');
}

async function askLocalPlanner(analysis) {
  const endpoint = process.env.NORTHSTAR_LLM_URL || '';
  const model = process.env.NORTHSTAR_LLM_MODEL || '';
  if (!endpoint || !model) return null;
  const input = {
    base: analysis.base.name,
    branches: analysis.branches.map(branch => ({
      name: branch.name,
      changedFiles: branch.changedFiles.length,
      overlapWithBase: branch.overlapWithBase,
      conflictFiles: branch.preflight.conflictFiles,
      risk: branch.risk
    })),
    pairwiseOverlaps: analysis.pairwiseOverlaps
  };
  const system = [
    'You are a local, read-only Git merge planner.',
    'Analyze the supplied deterministic Git preflight results and explain a safe merge order.',
    'Do not invent dependencies or claim that a merge is safe when Git reported a conflict.',
    'Do not suggest commands, pushes, resets, deletions, or any destructive operation.',
    'Return JSON only: {"summary":"...","order":[{"branch":"...","reason":"..."}],"risks":[{"branch":"...","file":"...","reason":"..."}],"questions":["..."]}.',
    'Use Simplified Chinese.'
  ].join('\n');
  const isOllama = /\/api\/chat(?:\?|$)/i.test(endpoint);
  const response = await requestJson(endpoint, isOllama ? {
    model, stream: false, format: 'json', keep_alive: process.env.NORTHSTAR_LLM_KEEP_ALIVE || '5m',
    messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(input) }]
  } : {
    model, temperature: 0, messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(input) }], response_format: { type: 'json_object' }
  });
  const content = response.choices?.[0]?.message?.content || response.message?.content || response.output_text;
  const parsed = extractJson(content);
  const names = new Set(analysis.branches.map(branch => branch.name));
  const order = Array.isArray(parsed.order) ? parsed.order.filter(item => item && names.has(text(item.branch))).map(item => ({ branch: text(item.branch), reason: text(item.reason).slice(0, 500) })).slice(0, MAX_BRANCHES) : [];
  return {
    summary: text(parsed.summary).slice(0, 1000),
    order,
    risks: Array.isArray(parsed.risks) ? parsed.risks.filter(item => item && names.has(text(item.branch))).map(item => ({ branch: text(item.branch), file: text(item.file).slice(0, 300), reason: text(item.reason).slice(0, 500) })).slice(0, 40) : [],
    questions: Array.isArray(parsed.questions) ? parsed.questions.map(text).filter(Boolean).slice(0, 10) : []
  };
}

async function analyzeMergeWorkspace(input = {}) {
  const requestedPath = text(input.repoPath);
  if (!requestedPath || requestedPath.length > 500) throw new Error('请输入本地 Git 仓库路径');
  const repoPath = path.resolve(requestedPath);
  if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) throw new Error('仓库路径不存在或不是目录');
  const base = text(input.baseBranch) || 'main';
  const branches = [...new Set(String(input.sourceBranches || '').split(/[\r\n,]+/).map(text).filter(Boolean))].slice(0, MAX_BRANCHES);
  if (!validRef(base)) throw new Error('目标分支名称无效');
  if (!branches.length) throw new Error('至少输入一个待合并分支');
  if (branches.some(branch => !validRef(branch))) throw new Error('待合并分支名称包含不安全字符');

  const root = await requireGit(repoPath, ['rev-parse', '--show-toplevel'], '不是有效的 Git 仓库');
  const currentBranch = await requireGit(root, ['branch', '--show-current'], '无法读取当前分支');
  const baseSha = await resolveCommit(root, base);
  const statusOutput = await requireGit(root, ['status', '--porcelain=v1'], '无法读取工作区状态');
  const branchRows = [];
  const baseMergeBase = baseSha;
  const baseChangedFiles = [];

  for (const name of branches) {
    const sha = await resolveCommit(root, name);
    const mergeBase = await requireGit(root, ['merge-base', base, name], `无法计算 ${name} 的共同祖先`);
    const files = await changedFiles(root, mergeBase, name);
    const overlapWithBase = intersection(baseChangedFiles, files);
    const preflight = await preflightMerge(root, mergeBase, base, name);
    branchRows.push({ name, sha, mergeBase, changedFiles: files, overlapWithBase, preflight, pairwiseOverlapCount: 0 });
  }

  // The base branch's own changes are approximated from the common ancestor of all candidates.
  for (const branch of branchRows) {
    const baseFiles = await changedFiles(root, branch.mergeBase, base);
    branch.overlapWithBase = intersection(baseFiles, branch.changedFiles);
  }
  const pairwiseOverlaps = [];
  for (let i = 0; i < branchRows.length; i += 1) {
    for (let j = i + 1; j < branchRows.length; j += 1) {
      const files = intersection(branchRows[i].changedFiles, branchRows[j].changedFiles);
      branchRows[i].pairwiseOverlapCount += files.length;
      branchRows[j].pairwiseOverlapCount += files.length;
      if (files.length) pairwiseOverlaps.push({ branches: [branchRows[i].name, branchRows[j].name], files });
    }
  }
  branchRows.forEach(branch => { branch.risk = riskFor(branch); });
  const analysis = {
    repoPath: root,
    currentBranch,
    base: { name: base, sha: baseSha },
    workingTree: parseStatus(statusOutput),
    branches: branchRows,
    pairwiseOverlaps,
    recommendation: { source: 'heuristic', order: heuristicOrder(branchRows), summary: 'Git 已完成只读预检；实际依赖关系仍需结合代码语义确认。', risks: [], questions: [] },
    generatedAt: new Date().toISOString()
  };
  try {
    const llm = await askLocalPlanner(analysis);
    if (llm && llm.order.length) analysis.recommendation = { ...llm, source: 'local-llm' };
  } catch (error) {
    analysis.recommendation.llmError = error.message;
  }
  return analysis;
}

function configuredRepositoryRoots() {
  const configured = text(process.env.NORTHSTAR_REPO_ROOTS).split(';').filter(Boolean);
  const defaults = [
    process.cwd(),
    path.dirname(__dirname),
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Documents', 'github') : '',
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'source', 'repos') : '',
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'projects') : ''
  ];
  return [...new Set([...configured, ...defaults].map(value => path.resolve(value)).filter(value => fs.existsSync(value)))].slice(0, 8);
}

function repositoryDirectories(root, maxDepth = 2) {
  const found = new Set();
  const queue = [{ directory: root, depth: 0 }];
  while (queue.length && found.size < 100) {
    const current = queue.shift();
    if (!current || !fs.existsSync(current.directory)) continue;
    if (fs.existsSync(path.join(current.directory, '.git'))) {
      found.add(current.directory);
      continue;
    }
    if (current.depth >= maxDepth) continue;
    let entries = [];
    try { entries = fs.readdirSync(current.directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || ['.git', 'node_modules', '.cache', 'AppData'].includes(entry.name)) continue;
      queue.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 });
    }
  }
  return [...found];
}

async function inspectWorkspace(directory) {
  try {
    const root = await requireGit(directory, ['rev-parse', '--show-toplevel'], 'Not a Git repository');
    const currentBranch = await requireGit(root, ['branch', '--show-current'], 'Unable to read current branch');
    const refs = await requireGit(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'], 'Unable to read branches');
    const branches = [...new Set(refs.split(/\r?\n/).map(text).filter(value => value && !['HEAD', 'origin', 'origin/HEAD'].includes(value)))].slice(0, 100);
    return { path: root, name: path.basename(root), currentBranch, branches };
  } catch {
    return null;
  }
}

async function discoverWorkspaces() {
  const directories = configuredRepositoryRoots().flatMap(root => repositoryDirectories(root));
  const unique = [...new Set(directories.map(value => path.resolve(value)))].slice(0, 100);
  const workspaces = [];
  for (const directory of unique) {
    const info = await inspectWorkspace(directory);
    if (info) workspaces.push(info);
  }
  return workspaces.sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { analyzeMergeWorkspace, discoverWorkspaces };
