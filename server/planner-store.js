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
const MODULE_TYPES = ['roadmap', 'github', 'performance', 'fitness'];

function emptyPlanner() {
  return {
    schemaVersion: 3,
    updatedAt: null,
    goals: [],
    projects: [],
    tasks: [],
    events: [],
    milestones: [],
    progressLogs: [],
    fitness: { profile: null, weightLogs: [], strengthLogs: [], hikes: [], plans: [] },
    performance: { goals: [], controls: [], initiatives: [], evidence: [], checkpoints: [], monthlyReviews: [], activities: [], promotion: [], targets: [] },
    categories: [],
    settings: { categoryLabels: [], modules: { roadmap: null, github: null, performance: null, fitness: null } }
  };
}

function asText(value, fallback = '') {
  return String(value ?? fallback).trim();
}

function normalizeSettings(value, categories = []) {
  const source = value && typeof value === 'object' ? value : {};
  const modules = source.modules && typeof source.modules === 'object' ? source.modules : {};
  const validCategories = new Set(categories);
  return {
    categoryLabels: Array.isArray(source.categoryLabels) ? source.categoryLabels.map(item => ({
      category: asText(item?.category),
      labelEn: asText(item?.labelEn)
    })).filter(item => validCategories.has(item.category)).slice(0, 30) : [],
    modules: Object.fromEntries(MODULE_TYPES.map(type => {
      const category = asText(modules[type]);
      return [type, validCategories.has(category) ? category : null];
    }))
  };
}

function readPlanner() {
  if (!fs.existsSync(DATA_FILE)) return emptyPlanner();
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const data = {
      ...emptyPlanner(),
      ...parsed,
      schemaVersion: 3,
      goals: Array.isArray(parsed.goals) ? parsed.goals : [],
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      events: Array.isArray(parsed.events) ? parsed.events : [],
      milestones: Array.isArray(parsed.milestones) ? parsed.milestones : [],
      progressLogs: Array.isArray(parsed.progressLogs) ? parsed.progressLogs : [],
      fitness: normalizeFitness(parsed.fitness),
      performance: normalizePerformance(parsed.performance),
      categories: Array.isArray(parsed.categories) ? parsed.categories.map(item => asText(item)).filter(Boolean).slice(0, 30) : []
    };
    data.settings = normalizeSettings(parsed.settings, data.categories);
    const githubCategory = data.settings.modules.github;
    const seenGithubRefs = new Set();
    data.tasks = data.tasks.filter(task => {
      if (task.source !== 'github') return true;
      if (githubCategory) task.category = githubCategory;
      if (!task.sourceRef || !seenGithubRefs.has(task.sourceRef)) { seenGithubRefs.add(task.sourceRef); return true; }
      return false;
    });
    return data;
  } catch (error) {
    const parseError = new Error('Planner data could not be read');
    parseError.cause = error;
    throw parseError;
  }
}

function writePlanner(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, BACKUP_FILE);
  const categories = Array.isArray(data.categories) ? data.categories.map(item => asText(item)).filter(Boolean).slice(0, 30) : [];
  const next = { ...data, schemaVersion: 3, categories, settings: normalizeSettings(data.settings, categories), fitness: normalizeFitness(data.fitness), performance: normalizePerformance(data.performance), updatedAt: new Date().toISOString() };
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
    checkpoints: Array.isArray(source.checkpoints) ? source.checkpoints : [],
    monthlyReviews: Array.isArray(source.monthlyReviews) ? source.monthlyReviews : [],
    activities: Array.isArray(source.activities) ? source.activities : [],
    promotion: Array.isArray(source.promotion) ? source.promotion : [],
    targets: Array.isArray(source.targets) ? source.targets : []
  };
}

function normalizeFitness(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    profile: source.profile && typeof source.profile === 'object' ? { heightCm: Number(source.profile.heightCm) || null, weightKg: Number(source.profile.weightKg) || null, updatedAt: source.profile.updatedAt || null } : null,
    weightLogs: Array.isArray(source.weightLogs) ? source.weightLogs : [],
    strengthLogs: Array.isArray(source.strengthLogs) ? source.strengthLogs : [],
    hikes: Array.isArray(source.hikes) ? source.hikes : [],
    plans: Array.isArray(source.plans) ? source.plans : []
  };
}

function performanceRecord(data, type, operation) {
  const performance = data.performance = normalizePerformance(data.performance);
  const collectionByType = { goal: 'goals', control: 'controls', initiative: 'initiatives', evidence: 'evidence', checkpoint: 'checkpoints', monthlyReview: 'monthlyReviews', activity: 'activities', promotion: 'promotion' };
  const collection = collectionByType[type];
  if (!collection) throw new Error('Performance record type is invalid');
  const now = new Date().toISOString();
  const record = { id: randomUUID(), type, createdAt: now, updatedAt: now };
  if (type === 'goal') Object.assign(record, { title: operation.title, weight: operation.weight, successCriteria: operation.successCriteria || null, dueAt: operation.dueAt || null, status: 'not-assessed' });
  if (type === 'control') Object.assign(record, { goalId: operation.goalId, title: operation.title, frequency: operation.frequency || null, dueAt: operation.dueAt || null, status: operation.status, reviewer: operation.reviewer || null, lastTestedAt: operation.lastTestedAt || null, evidenceRef: operation.evidenceRef || null });
  if (type === 'initiative') Object.assign(record, { goalId: operation.goalId, title: operation.title, status: operation.status, dueAt: operation.dueAt || null, progress: operation.progress, baseline: operation.baseline || null, targetOutcome: operation.targetOutcome || null, metricAfter: operation.metricAfter || null, roleScope: operation.roleScope || null, productionApproved: operation.productionApproved || 'no', adoptedBeyondTeam: operation.adoptedBeyondTeam || 'no', evidenceRef: operation.evidenceRef || null, ipClassification: operation.ipClassification || null });
  if (type === 'evidence') Object.assign(record, { goalId: operation.goalId || null, controlId: operation.controlId || null, initiativeId: operation.initiativeId || null, occurredAt: operation.occurredAt || now, contribution: operation.contribution, outcome: operation.outcome, metricBefore: operation.metricBefore || null, metricAfter: operation.metricAfter || null, measurementMethod: operation.measurementMethod || null, evidenceType: operation.evidenceType || null, evidenceRef: operation.evidenceRef, confidentiality: operation.confidentiality || 'internal', productionUse: operation.productionUse || 'no', crossTeamImpact: operation.crossTeamImpact || 'no', stakeholder: operation.stakeholder || null, reviewer: operation.reviewer || null, reviewedAt: operation.reviewedAt || null });
  if (type === 'checkpoint') Object.assign(record, { title: operation.title, dueAt: operation.dueAt || null, status: operation.status, requiredOutput: operation.requiredOutput || null, completedAt: operation.completedAt || null, evidenceRef: operation.evidenceRef || null });
  if (type === 'monthlyReview') Object.assign(record, { month: operation.month, kriResult: operation.kriResult, ttcCorrections: operation.ttcCorrections, sirComplete: operation.sirComplete, queueHealthy: operation.queueHealthy, workTimely: operation.workTimely, rasMet: operation.rasMet, overdueCount: operation.overdueCount, materialMiss: operation.materialMiss, evidenceRef: operation.evidenceRef || null, reviewer: operation.reviewer || null, reviewedAt: operation.reviewedAt || null });
  if (type === 'activity') Object.assign(record, { goalId: operation.goalId || null, activityType: operation.activityType, title: operation.title, occurredAt: operation.occurredAt || null, role: operation.role || null, requiredOutcome: operation.requiredOutcome || null, ownedAction: operation.ownedAction || null, dueAt: operation.dueAt || null, status: operation.status, externalCollaboration: operation.externalCollaboration || 'no', evidenceRef: operation.evidenceRef || null });
  if (type === 'promotion') Object.assign(record, { capability: operation.capability, currentEvidence: operation.currentEvidence || null, evidenceRef: operation.evidenceRef || null, managerAssessment: operation.managerAssessment || null, gapAction: operation.gapAction || null, dueAt: operation.dueAt || null, status: operation.status });
  performance[collection].unshift(record);
  return record;
}

function updatePerformanceRecord(data, operation) {
  const collection = { goal: 'goals', control: 'controls', initiative: 'initiatives', evidence: 'evidence', checkpoint: 'checkpoints', monthlyReview: 'monthlyReviews', activity: 'activities', promotion: 'promotion' }[operation.recordType];
  const record = findById(normalizePerformance(data.performance)[collection], operation.id, 'Performance record');
  const allowed = ['title', 'status', 'dueAt', 'weight', 'progress', 'successCriteria', 'frequency', 'baseline', 'targetOutcome', 'metricAfter', 'contribution', 'outcome', 'metricBefore', 'evidenceType', 'evidenceRef', 'confidentiality', 'requiredOutput', 'reviewer', 'lastTestedAt', 'roleScope', 'productionApproved', 'adoptedBeyondTeam', 'ipClassification', 'measurementMethod', 'productionUse', 'crossTeamImpact', 'stakeholder', 'reviewedAt', 'completedAt', 'month', 'kriResult', 'ttcCorrections', 'sirComplete', 'queueHealthy', 'workTimely', 'rasMet', 'overdueCount', 'materialMiss', 'activityType', 'occurredAt', 'role', 'ownedAction', 'externalCollaboration', 'capability', 'currentEvidence', 'managerAssessment', 'gapAction'];
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

function createMilestone(data, operation) {
  const now = new Date().toISOString();
  const milestone = { id: randomUUID(), type: 'milestone', domain: operation.domain, milestoneType: operation.milestoneType, title: operation.title, period: operation.period || null, year: operation.year || null, status: operation.status || 'planned', progress: Number(operation.progress || 0), repo: operation.repo || null, target: operation.target || null, notes: operation.notes || '', createdAt: now, updatedAt: now };
  data.milestones.unshift(milestone); return milestone;
}

function updateMilestone(data, operation) { const milestone = findById(data.milestones, operation.id, 'Milestone'); for (const field of ['domain', 'milestoneType', 'title', 'period', 'year', 'status', 'progress', 'repo', 'target', 'notes']) if (field in operation) milestone[field] = operation[field]; milestone.updatedAt = new Date().toISOString(); return milestone; }

function updateEvent(data, operation) { const event = findById(data.events, operation.id, 'Event'); for (const field of ['title', 'notes', 'startAt', 'endAt']) if (field in operation) event[field] = operation[field]; if (event.endAt && new Date(event.endAt) <= new Date(event.startAt)) throw new Error('Event endAt must be after startAt'); event.updatedAt = new Date().toISOString(); return event; }

function logFitnessSession(data, operation) {
  const record = { id: randomUUID(), type: 'strength', ...operation, createdAt: new Date().toISOString() };
  delete record.type;
  data.fitness = normalizeFitness(data.fitness);
  data.fitness.strengthLogs.unshift({ ...record, type: 'strength' });
  return record;
}

function logHike(data, operation) {
  const record = { id: randomUUID(), type: 'hike', ...operation, createdAt: new Date().toISOString() };
  delete record.type;
  data.fitness = normalizeFitness(data.fitness);
  data.fitness.hikes.unshift({ ...record, type: 'hike' });
  return record;
}

function updateFitnessProfile(data, operation) {
  data.fitness = normalizeFitness(data.fitness);
  data.fitness.profile = { heightCm: operation.heightCm, weightKg: operation.weightKg, updatedAt: new Date().toISOString() };
  return data.fitness.profile;
}

function logFitnessWeight(data, operation) {
  data.fitness = normalizeFitness(data.fitness);
  const record = { id: randomUUID(), weightKg: operation.weightKg, measuredAt: operation.measuredAt, createdAt: new Date().toISOString() };
  data.fitness.weightLogs.unshift(record);
  if (data.fitness.profile) data.fitness.profile.weightKg = operation.weightKg;
  return record;
}

function updateFitnessSession(data, operation) {
  data.fitness = normalizeFitness(data.fitness);
  const record = findById(data.fitness.strengthLogs, operation.id, 'Fitness session');
  for (const field of ['plan', 'session', 'performedAt', 'durationMinutes', 'exercises', 'rpe', 'quality', 'soreness24', 'soreness48', 'notes']) record[field] = operation[field];
  record.updatedAt = new Date().toISOString();
  return record;
}

function deleteFitnessSession(data, operation) {
  data.fitness = normalizeFitness(data.fitness);
  const index = data.fitness.strengthLogs.findIndex(record => record.id === operation.id);
  if (index < 0) throw new Error('Fitness session not found');
  return data.fitness.strengthLogs.splice(index, 1)[0];
}

function saveCategory(data, operation, updating = false) {
  data.categories = Array.isArray(data.categories) ? data.categories : [];
  data.settings = normalizeSettings(data.settings, data.categories);
  const oldName = updating ? required(operation.oldName, 'Existing category name') : null;
  const name = required(operation.name, 'Category name');
  if (updating && !data.categories.includes(oldName)) throw new Error('Category was not found');
  if ((!updating || oldName !== name) && data.categories.includes(name)) throw new Error('Category already exists');
  if (updating) {
    data.categories[data.categories.indexOf(oldName)] = name;
    for (const task of data.tasks) if (task.category === oldName) task.category = name;
    for (const type of MODULE_TYPES) if (data.settings.modules[type] === oldName) data.settings.modules[type] = name;
    data.settings.categoryLabels = data.settings.categoryLabels.filter(item => item.category !== oldName);
  } else {
    data.categories.push(name);
  }
  if (operation.labelEn) data.settings.categoryLabels.push({ category: name, labelEn: operation.labelEn });
  if (operation.module) {
    for (const type of MODULE_TYPES) if (data.settings.modules[type] === name) data.settings.modules[type] = null;
    if (operation.module !== 'none') data.settings.modules[operation.module] = name;
  }
  return { name, labelEn: operation.labelEn || null, module: operation.module || null };
}

function deleteCategory(data, operation) {
  const name = required(operation.name, 'Category name');
  if (data.tasks.some(task => task.category === name)) throw new Error('Move or delete tasks in this category before removing it');
  data.categories = (data.categories || []).filter(category => category !== name);
  data.settings = normalizeSettings(data.settings, data.categories);
  return name;
}

function configuredRecord(data, collection, operation, mode) {
  const owner = collection === 'plans' ? (data.fitness = normalizeFitness(data.fitness)) : (data.performance = normalizePerformance(data.performance));
  if (mode === 'create') {
    const item = { id: randomUUID(), name: operation.name, labelEn: operation.labelEn || null };
    if (collection === 'plans') Object.assign(item, { focus: operation.focus || null, focusEn: operation.focusEn || null });
    else item.target = operation.target;
    owner[collection].push(item);
    return item;
  }
  const index = owner[collection].findIndex(item => item.id === operation.id);
  if (index < 0) throw new Error('Configured item was not found');
  if (mode === 'delete') return owner[collection].splice(index, 1)[0];
  const item = owner[collection][index];
  for (const field of collection === 'plans' ? ['name', 'labelEn', 'focus', 'focusEn'] : ['name', 'labelEn', 'target']) if (field in operation) item[field] = operation[field];
  return item;
}

function deletePerformanceRecord(data, operation) {
  const collection = { goal: 'goals', control: 'controls', initiative: 'initiatives', evidence: 'evidence', checkpoint: 'checkpoints', monthlyReview: 'monthlyReviews', activity: 'activities', promotion: 'promotion' }[operation.recordType];
  const items = normalizePerformance(data.performance)[collection];
  const index = items.findIndex(item => item.id === operation.id);
  if (index < 0) throw new Error('Performance record was not found');
  return items.splice(index, 1)[0];
}

function applyOperation(data, operation) {
  if (!operation || typeof operation !== 'object') throw new Error('Each planner operation must be an object');
  const type = asText(operation.type);
  if (type === 'create_task') return { type, item: createTask(data, operation) };
  if (type === 'create_milestone') return { type, item: createMilestone(data, operation) };
  if (type === 'update_milestone') return { type, item: updateMilestone(data, operation) };
  if (type === 'delete_milestone') { const index = data.milestones.findIndex(item => item.id === operation.id); if (index < 0) throw new Error('Milestone was not found'); return { type, item: data.milestones.splice(index, 1)[0] }; }
  if (type === 'create_performance_goal') return { type, item: performanceRecord(data, 'goal', operation) };
  if (type === 'create_performance_control') return { type, item: performanceRecord(data, 'control', operation) };
  if (type === 'create_performance_initiative') return { type, item: performanceRecord(data, 'initiative', operation) };
  if (type === 'create_performance_evidence') return { type, item: performanceRecord(data, 'evidence', operation) };
  if (type === 'create_performance_checkpoint') return { type, item: performanceRecord(data, 'checkpoint', operation) };
  if (type === 'create_performance_monthly_review') return { type, item: performanceRecord(data, 'monthlyReview', operation) };
  if (type === 'create_performance_activity') return { type, item: performanceRecord(data, 'activity', operation) };
  if (type === 'create_performance_promotion') return { type, item: performanceRecord(data, 'promotion', operation) };
  if (type === 'update_performance_record') return { type, item: updatePerformanceRecord(data, operation) };
  if (type === 'delete_performance_record') return { type, item: deletePerformanceRecord(data, operation) };
  if (type === 'create_category') return { type, item: saveCategory(data, operation) };
  if (type === 'update_category') return { type, item: saveCategory(data, operation, true) };
  if (type === 'delete_category') return { type, item: deleteCategory(data, operation) };
  if (type === 'create_fitness_plan') return { type, item: configuredRecord(data, 'plans', operation, 'create') };
  if (type === 'update_fitness_plan') return { type, item: configuredRecord(data, 'plans', operation, 'update') };
  if (type === 'delete_fitness_plan') return { type, item: configuredRecord(data, 'plans', operation, 'delete') };
  if (type === 'create_performance_target') return { type, item: configuredRecord(data, 'targets', operation, 'create') };
  if (type === 'update_performance_target') return { type, item: configuredRecord(data, 'targets', operation, 'update') };
  if (type === 'delete_performance_target') return { type, item: configuredRecord(data, 'targets', operation, 'delete') };
  if (type === 'create_event') return { type, item: createEvent(data, operation) };
  if (type === 'update_event') return { type, item: updateEvent(data, operation) };
  if (type === 'delete_event') { const index = data.events.findIndex(item => item.id === operation.id); if (index < 0) throw new Error('Event was not found'); return { type, item: data.events.splice(index, 1)[0] }; }
  if (type === 'log_fitness_session') return { type, item: logFitnessSession(data, operation) };
  if (type === 'delete_fitness_session') return { type, item: deleteFitnessSession(data, operation) };
  if (type === 'log_hike') return { type, item: logHike(data, operation) };
  if (type === 'update_fitness_profile') return { type, item: updateFitnessProfile(data, operation) };
  if (type === 'log_fitness_weight') return { type, item: logFitnessWeight(data, operation) };
  if (type === 'update_fitness_session') return { type, item: updateFitnessSession(data, operation) };
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
        category: data.settings.modules.github || null,
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
