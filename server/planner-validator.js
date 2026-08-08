const fs = require('fs');
const path = require('path');

const POLICY = JSON.parse(fs.readFileSync(path.join(__dirname, 'planner-policy.json'), 'utf8'));

function asText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function boundedText(value, label, required = false, maxLength = POLICY.maxTextChars) {
  const text = asText(value);
  if (required && !text) throw new Error(`${label} is required`);
  if (text.length > maxLength) throw new Error(`${label} is too long`);
  return text || null;
}

function normalizeDate(value, label, required = false) {
  const text = asText(value);
  if (!text) {
    if (required) throw new Error(`${label} is required`);
    return null;
  }
  if (/^YYYY-MM-DD|^yyyy-mm-dd|placeholder/i.test(text)) throw new Error(`${label} contains a placeholder date`);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} must be a valid date`);
  return date.toISOString();
}

function normalizedSource(value, fallback) {
  return value === 'llm' ? 'llm' : fallback;
}

function normalizeOperation(input, source) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Each planner operation must be an object');
  const type = asText(input.type);
  if (!POLICY.allowedOperations[type]) throw new Error(`Unsupported planner operation: ${type || 'unknown'}`);
  const output = { type };
  const allowed = new Set(POLICY.allowedOperations[type]);
  for (const key of Object.keys(input)) {
    if (key !== 'type' && allowed.has(key)) output[key] = input[key];
  }

  if (type === 'create_task') {
    output.title = boundedText(output.title, 'Task title', true);
    output.notes = boundedText(output.notes, 'Task notes');
    output.status = POLICY.allowedStatuses.includes(output.status) ? output.status : 'planned';
    output.priority = POLICY.allowedPriorities.includes(output.priority) ? output.priority : 'medium';
    output.dueAt = normalizeDate(output.dueAt, 'Task dueAt');
    output.projectId = boundedText(output.projectId, 'Task projectId');
    output.sourceRef = boundedText(output.sourceRef, 'Task sourceRef');
  } else if (type === 'create_event') {
    output.title = boundedText(output.title, 'Event title', true);
    output.notes = boundedText(output.notes, 'Event notes');
    output.startAt = normalizeDate(output.startAt, 'Event startAt', true);
    output.endAt = normalizeDate(output.endAt, 'Event endAt');
    if (output.endAt && new Date(output.endAt) < new Date(output.startAt)) throw new Error('Event endAt must be after startAt');
  } else if (type === 'log_progress') {
    output.content = boundedText(output.content, 'Progress content', true);
    output.projectId = boundedText(output.projectId, 'Progress projectId');
    output.occurredAt = normalizeDate(output.occurredAt, 'Progress occurredAt');
  } else if (type === 'update_task') {
    output.id = boundedText(output.id, 'Task id', true);
    if (output.title !== undefined) output.title = boundedText(output.title, 'Task title', true);
    if (output.notes !== undefined) output.notes = boundedText(output.notes, 'Task notes');
    if (output.status !== undefined) {
      if (!POLICY.allowedStatuses.includes(output.status)) throw new Error('Task status is invalid');
    }
    if (output.priority !== undefined) {
      if (!POLICY.allowedPriorities.includes(output.priority)) throw new Error('Task priority is invalid');
    }
    if (output.dueAt !== undefined) output.dueAt = normalizeDate(output.dueAt, 'Task dueAt');
    if (output.projectId !== undefined) output.projectId = boundedText(output.projectId, 'Task projectId');
    if (output.sourceRef !== undefined) output.sourceRef = boundedText(output.sourceRef, 'Task sourceRef');
    if (!['title', 'notes', 'status', 'priority', 'dueAt', 'projectId'].some(key => key in output)) throw new Error('Task update has no editable fields');
  }

  output.source = normalizedSource(output.source, source);
  return output;
}

function validateOperations(operations, options = {}) {
  const source = options.source === 'llm' ? 'llm' : 'manual';
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > POLICY.maxOperations) {
    throw new Error(`Planner operations must contain between 1 and ${POLICY.maxOperations} items`);
  }
  const normalized = operations.map(operation => normalizeOperation(operation, source));
  return { operations: normalized, needsConfirmation: POLICY.requiresConfirmation };
}

function validateProposal(proposal) {
  if (!proposal || typeof proposal !== 'object' || !Array.isArray(proposal.operations)) throw new Error('Local LLM response is missing operations');
  const clarification = boundedText(proposal.clarification, 'Clarification', false, POLICY.maxClarificationChars);
  if (proposal.operations.length === 0) {
    if (!clarification) throw new Error('Local LLM response needs operations or a clarification');
    return { operations: [], needsConfirmation: true, clarification };
  }
  const normalized = validateOperations(proposal.operations, { source: 'llm' });
  return { operations: normalized.operations, needsConfirmation: true, clarification };
}

module.exports = { POLICY, validateOperations, validateProposal };
