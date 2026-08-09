const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { validateOperations } = require('./planner-validator');

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const DEFAULT_DIR = process.platform === 'win32' && HOME
  ? path.join(HOME, 'AppData', 'Roaming', 'Northstar', 'planner')
  : path.join(HOME || process.cwd(), '.northstar', 'planner');
const DATA_DIR = process.env.NORTHSTAR_PLANNER_DIR || DEFAULT_DIR;
const DATA_FILE = path.join(DATA_DIR, 'planner-data.json');
const BACKUP_FILE = path.join(DATA_DIR, 'planner-data.json.bak');

function emptyPlanner() {
  return {
    schemaVersion: 2,
    updatedAt: null,
    goals: [],
    projects: [],
    tasks: [],
    events: [],
    progressLogs: [],
    performance: { goals: [], controls: [], initiatives: [], evidence: [], checkpoints: [] },
    categories: ['安全技能学习与实验室', 'GitHub 开源项目', '工作绩效管理', '个人健身']
  };
}

function asText(value, fallback = '') {
  return String(value ?? fallback).trim();
}

function readPlanner() {
  if (!fs.existsSync(DATA_FILE)) return emptyPlanner();
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return {
      ...emptyPlanner(),
      ...parsed,
      schemaVersion: 2,
      goals: Array.isArray(parsed.goals) ? parsed.goals : [],
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      events: Array.isArray(parsed.events) ? parsed.events : [],
      progressLogs: Array.isArray(parsed.progressLogs) ? parsed.progressLogs : [],
      performance: normalizePerformance(parsed.performance),
      categories: Array.isArray(parsed.categories) ? parsed.categories.map(item => asText(item)).filter(Boolean).slice(0, 30) : emptyPlanner().categories
    };
  } catch (error) {
    const parseError = new Error('Planner data could not be read');
    parseError.cause = error;
    throw parseError;
  }
}

function writePlanner(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, BACKUP_FILE);
  const next = { ...data, schemaVersion: 2, performance: normalizePerformance(data.performance), updatedAt: new Date().toISOString() };
  const tempFile = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(tempFile, DATA_FILE);
  } finally {
    try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch {}
  }
  return next;
}

function required(value, label) {
  const text = asText(value);
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function isoDate(value, label, optional = true) {
  const text = asText(value);
  if (!text && optional) return null;
  if (!text || Number.isNaN(new Date(text).getTime())) throw new Error(`${label} must be a valid date`);
  return new Date(text).toISOString();
}

function findById(items, id, label) {
  const item = items.find(entry => entry.id === id);
  if (!item) throw new Error(`${label} was not found`);
  return item;
}

function normalizePerformance(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    goals: Array.isArray(source.goals) ? source.goals : [],
    controls: Array.isArray(source.controls) ? source.controls : [],
    initiatives: Array.isArray(source.initiatives) ? source.initiatives : [],
    evidence: Array.isArray(source.evidence) ? source.evidence : [],
    checkpoints: Array.isArray(source.checkpoints) ? source.checkpoints : []
  };
}

function performanceRecord(data, type, operation) {
  const performance = data.performance = normalizePerformance(data.performance);
  const collectionByType = { goal: 'goals', control: 'controls', initiative: 'initiatives', evidence: 'evidence', checkpoint: 'checkpoints' };
  const collection = collectionByType[type];
  if (!collection) throw new Error('Performance record type is invalid');
  const now = new Date().toISOString();
  const record = { id: randomUUID(), type, createdAt: now, updatedAt: now };
  if (type === 'goal') Object.assign(record, { title: operation.title, weight: operation.weight, successCriteria: operation.successCriteria || null, dueAt: operation.dueAt || null, status: 'not-assessed' });
  if (type === 'control') Object.assign(record, { goalId: operation.goalId, title: operation.title, frequency: operation.frequency || null, dueAt: operation.dueAt || null, status: operation.status });
  if (type === 'initiative') Object.assign(record, { goalId: operation.goalId, title: operation.title, status: operation.status, dueAt: operation.dueAt || null, progress: operation.progress, baseline: operation.baseline || null, targetOutcome: operation.targetOutcome || null, metricAfter: operation.metricAfter || null });
  if (type === 'evidence') Object.assign(record, { goalId: operation.goalId || null, controlId: operation.controlId || null, initiativeId: operation.initiativeId || null, occurredAt: operation.occurredAt || now, contribution: operation.contribution, outcome: operation.outcome, metricBefore: operation.metricBefore || null, metricAfter: operation.metricAfter || null, evidenceType: operation.evidenceType || null, evidenceRef: operation.evidenceRef, confidentiality: operation.confidentiality || 'internal' });
  if (type === 'checkpoint') Object.assign(record, { title: operation.title, dueAt: operation.dueAt || null, status: operation.status, requiredOutput: operation.requiredOutput || null });
  performance[collection].unshift(record);
  return record;
}

function updatePerformanceRecord(data, operation) {
  const collection = { goal: 'goals', control: 'controls', initiative: 'initiatives', evidence: 'evidence', checkpoint: 'checkpoints' }[operation.recordType];
  const record = findById(normalizePerformance(data.performance)[collection], operation.id, 'Performance record');
  const allowed = ['title', 'status', 'dueAt', 'weight', 'progress', 'successCriteria', 'frequency', 'baseline', 'targetOutcome', 'metricAfter', 'contribution', 'outcome', 'metricBefore', 'evidenceType', 'evidenceRef', 'confidentiality', 'requiredOutput'];
  for (const field of allowed) if (field in operation) record[field] = operation[field];
  record.updatedAt = new Date().toISOString();
  return record;
}

function createTask(data, operation) {
  const now = new Date().toISOString();
  const task = {
    id: randomUUID(),
    type: 'task',
    title: required(operation.title, 'Task title'),
    notes: asText(operation.notes),
    status: ['planned', 'in-progress', 'done', 'cancelled'].includes(operation.status) ? operation.status : 'planned',
    priority: ['low', 'medium', 'high'].includes(operation.priority) ? operation.priority : 'medium',
    dueAt: isoDate(operation.dueAt, 'Task dueAt'),
    projectId: asText(operation.projectId) || null,
    source: asText(operation.source) || 'manual',
    sourceRef: asText(operation.sourceRef) || null,
    sourceUpdatedAt: asText(operation.sourceUpdatedAt) || null,
    sourcePolishVersion: asText(operation.sourcePolishVersion) || null,
    category: asText(operation.category) || null,
    tags: Array.isArray(operation.tags) ? operation.tags.map(tag => asText(tag)).filter(Boolean).slice(0, 8) : [],
    parentId: asText(operation.parentId) || null,
    createdAt: now,
    updatedAt: now
  };
  data.tasks.unshift(task);
  return task;
}

function createEvent(data, operation) {
  const startAt = isoDate(operation.startAt, 'Event startAt', false);
  const endAt = isoDate(operation.endAt, 'Event endAt');
  if (endAt && new Date(endAt) < new Date(startAt)) throw new Error('Event endAt must be after startAt');
  const now = new Date().toISOString();
  const event = {
    id: randomUUID(),
    type: 'event',
    title: required(operation.title, 'Event title'),
    notes: asText(operation.notes),
    startAt,
    endAt,
    source: asText(operation.source) || 'manual',
    createdAt: now,
    updatedAt: now
  };
  data.events.push(event);
  return event;
}

function applyOperation(data, operation) {
  if (!operation || typeof operation !== 'object') throw new Error('Each planner operation must be an object');
  const type = asText(operation.type);
  if (type === 'create_task') return { type, item: createTask(data, operation) };
  if (type === 'create_performance_goal') return { type, item: performanceRecord(data, 'goal', operation) };
  if (type === 'create_performance_control') return { type, item: performanceRecord(data, 'control', operation) };
  if (type === 'create_performance_initiative') return { type, item: performanceRecord(data, 'initiative', operation) };
  if (type === 'create_performance_evidence') return { type, item: performanceRecord(data, 'evidence', operation) };
  if (type === 'create_performance_checkpoint') return { type, item: performanceRecord(data, 'checkpoint', operation) };
  if (type === 'update_performance_record') return { type, item: updatePerformanceRecord(data, operation) };
  if (type === 'create_category') {
    const name = required(operation.name, 'Category name');
    data.categories = Array.isArray(data.categories) ? data.categories : [];
    if (!data.categories.includes(name)) data.categories.push(name);
    return { type, item: name };
  }
  if (type === 'delete_category') {
    const name = required(operation.name, 'Category name');
    if (data.tasks.some(task => task.category === name)) throw new Error('Move or delete tasks in this category before removing it');
    data.categories = (data.categories || []).filter(category => category !== name);
    return { type, item: name };
  }
  if (type === 'create_event') return { type, item: createEvent(data, operation) };
  if (type === 'log_progress') {
    const log = {
      id: randomUUID(),
      type: 'progress_log',
      content: required(operation.content, 'Progress content'),
      projectId: asText(operation.projectId) || null,
      occurredAt: isoDate(operation.occurredAt, 'Progress occurredAt') || new Date().toISOString(),
      source: asText(operation.source) || 'manual',
      createdAt: new Date().toISOString()
    };
    data.progressLogs.unshift(log);
    return { type, item: log };
  }
  if (type === 'update_task') {
    const task = findById(data.tasks, required(operation.id, 'Task id'), 'Task');
    const allowed = ['title', 'notes', 'status', 'priority', 'projectId', 'dueAt', 'sourceRef', 'category', 'tags', 'parentId'];
    for (const key of allowed) {
      if (!(key in operation)) continue;
      if (key === 'title') task.title = required(operation[key], 'Task title');
      else if (key === 'status' && !['planned', 'in-progress', 'done', 'cancelled'].includes(operation[key])) throw new Error('Task status is invalid');
      else if (key === 'priority' && !['low', 'medium', 'high'].includes(operation[key])) throw new Error('Task priority is invalid');
      else if (key === 'dueAt') task.dueAt = isoDate(operation[key], 'Task dueAt');
      else if (key === 'sourceRef') task.sourceRef = asText(operation[key]) || null;
      else if (key === 'category') task.category = asText(operation[key]) || null;
      else if (key === 'tags') task.tags = Array.isArray(operation[key]) ? operation[key].map(tag => asText(tag)).filter(Boolean).slice(0, 8) : [];
      else if (key === 'parentId') task.parentId = asText(operation[key]) || null;
      else task[key] = asText(operation[key]) || null;
    }
    task.updatedAt = new Date().toISOString();
    return { type, item: task };
  }
  if (type === 'delete_task') {
    const id = required(operation.id, 'Task id');
    const index = data.tasks.findIndex(entry => entry.id === id);
    if (index < 0) throw new Error('Task was not found');
    const [task] = data.tasks.splice(index, 1);
    return { type, item: task };
  }
  throw new Error(`Unsupported planner operation: ${type || 'unknown'}`);
}

function githubIssueRef(repo, number) {
  return `github:${String(repo || '').trim()}#${number}`;
}

function githubIssueStatus(issue) {
  const labels = (issue.labels || []).map(label => String(label).toLowerCase());
  return labels.some(label => ['in-progress', 'in progress', 'doing'].includes(label)) ? 'in-progress' : 'planned';
}

function githubIssuePriority(issue) {
  const labels = (issue.labels || []).map(label => String(label).toLowerCase());
  if (labels.some(label => ['urgent', 'critical', 'blocker'].includes(label))) return 'high';
  if (labels.includes('low')) return 'low';
  return 'medium';
}

function githubIssueNotes(repo, issue) {
  const labels = (issue.labels || []).join(', ');
  return [`GitHub: ${repo}`, issue.url ? `URL: ${issue.url}` : '', labels ? `Labels: ${labels}` : ''].filter(Boolean).join('\n');
}

function ensureGithubProject(data, repo) {
  const sourceRef = `github:${asText(repo.name)}`;
  let project = data.projects.find(item => item.source === 'github' && item.sourceRef === sourceRef);
  const now = new Date().toISOString();
  if (!project) {
    project = {
      id: randomUUID(), type: 'project', name: asText(repo.name), description: asText(repo.description),
      status: 'active', source: 'github', sourceRef, url: asText(repo.url) || null,
      createdAt: now, updatedAt: now
    };
    data.projects.unshift(project);
    return { project, created: true };
  }
  Object.assign(project, {
    name: asText(repo.name) || project.name,
    description: asText(repo.description) || project.description,
    url: asText(repo.url) || project.url || null,
    updatedAt: now
  });
  return { project, created: false };
}

function syncGithubToPlanner(githubData) {
  const data = readPlanner();
  const repos = Array.isArray(githubData?.repos) ? githubData.repos : [];
  const githubTasks = data.tasks.filter(task => task.source === 'github' && task.sourceRef);
  const byRef = new Map(githubTasks.map(task => [task.sourceRef, task]));
  const results = { projectsCreated: 0, projectsUpdated: 0, created: 0, updated: 0, completed: 0, skipped: 0 };
  const now = new Date().toISOString();

  for (const repo of repos) {
    const repoName = asText(repo.name);
    if (!repoName) continue;
    const projectResult = ensureGithubProject(data, repo);
    if (projectResult.created) results.projectsCreated += 1;
    else results.projectsUpdated += 1;
    const project = projectResult.project;
    for (const issue of Array.isArray(repo.issues) ? repo.issues : []) {
      if (!issue || issue.number == null || !asText(issue.title)) { results.skipped += 1; continue; }
      const sourceRef = githubIssueRef(repoName, issue.number);
      const existing = byRef.get(sourceRef);
      const hasPolishPayload = Object.prototype.hasOwnProperty.call(issue, 'plannerPolishVersion');
      const fields = {
        title: hasPolishPayload ? (asText(issue.plannerTitle) || `#${issue.number} ${asText(issue.title)}`) : (existing?.title || `#${issue.number} ${asText(issue.title)}`),
        notes: hasPolishPayload ? (asText(issue.plannerNotes) || githubIssueNotes(repoName, issue)) : (existing?.notes || githubIssueNotes(repoName, issue)),
        status: githubIssueStatus(issue),
        priority: githubIssuePriority(issue),
        projectId: project.id,
        source: 'github',
        sourceRef,
        sourceUpdatedAt: asText(issue.updatedAt) || null,
        sourcePolishVersion: hasPolishPayload ? (asText(issue.plannerPolishVersion) || 'github-raw-v2') : (existing?.sourcePolishVersion || 'github-raw-v2'),
        category: hasPolishPayload ? (asText(issue.plannerCategory) || 'general') : (existing?.category || 'general'),
        tags: hasPolishPayload ? (Array.isArray(issue.plannerTags) ? issue.plannerTags : []) : (existing?.tags || []),
        parentId: project.id
      };
      if (existing) {
        if (existing.sourceUpdatedAt && existing.sourceUpdatedAt === fields.sourceUpdatedAt && existing.sourcePolishVersion === fields.sourcePolishVersion && existing.projectId === project.id) continue;
        Object.assign(existing, fields, { updatedAt: now });
        results.updated += 1;
      } else {
        const task = createTask(data, fields);
        byRef.set(sourceRef, task);
        results.created += 1;
      }
    }

    for (const issue of Array.isArray(repo.closedIssues) ? repo.closedIssues : []) {
      if (!issue || issue.number == null) continue;
      const existing = byRef.get(githubIssueRef(repoName, issue.number));
      if (existing && existing.status !== 'done') {
        existing.status = 'done';
        existing.projectId = project.id;
        existing.updatedAt = now;
        results.completed += 1;
      }
    }
  }

  return { data: writePlanner(data), results };
}

function applyOperations(operations, options = {}) {
  const validation = validateOperations(operations, { source: 'manual' });
  if (validation.operations.some(operation => operation.source === 'llm') && options.confirmed !== true) {
    throw new Error('LLM planner changes require explicit confirmation');
  }
  const data = readPlanner();
  const results = validation.operations.map(operation => applyOperation(data, operation));
  return { data: writePlanner(data), results };
}

module.exports = {
  DATA_FILE,
  readPlanner,
  applyOperations,
  syncGithubToPlanner
};
