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
    schemaVersion: 1,
    updatedAt: null,
    goals: [],
    projects: [],
    tasks: [],
    events: [],
    progressLogs: []
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
      schemaVersion: 1,
      goals: Array.isArray(parsed.goals) ? parsed.goals : [],
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      events: Array.isArray(parsed.events) ? parsed.events : [],
      progressLogs: Array.isArray(parsed.progressLogs) ? parsed.progressLogs : []
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
  const next = { ...data, schemaVersion: 1, updatedAt: new Date().toISOString() };
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
    const allowed = ['title', 'notes', 'status', 'priority', 'projectId', 'dueAt'];
    for (const key of allowed) {
      if (!(key in operation)) continue;
      if (key === 'title') task.title = required(operation[key], 'Task title');
      else if (key === 'status' && !['planned', 'in-progress', 'done', 'cancelled'].includes(operation[key])) throw new Error('Task status is invalid');
      else if (key === 'priority' && !['low', 'medium', 'high'].includes(operation[key])) throw new Error('Task priority is invalid');
      else if (key === 'dueAt') task.dueAt = isoDate(operation[key], 'Task dueAt');
      else task[key] = asText(operation[key]) || null;
    }
    task.updatedAt = new Date().toISOString();
    return { type, item: task };
  }
  throw new Error(`Unsupported planner operation: ${type || 'unknown'}`);
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
  applyOperations
};
