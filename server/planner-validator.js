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
    output.category = boundedText(output.category, 'Task category', false, 80);
    output.tags = Array.isArray(output.tags) ? output.tags.filter(tag => typeof tag === 'string').map(tag => tag.trim()).filter(Boolean).slice(0, 8) : [];
    output.parentId = boundedText(output.parentId, 'Task parentId');
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
    if (output.category !== undefined) output.category = boundedText(output.category, 'Task category', false, 80);
    if (output.tags !== undefined) output.tags = Array.isArray(output.tags) ? output.tags.filter(tag => typeof tag === 'string').map(tag => tag.trim()).filter(Boolean).slice(0, 8) : [];
    if (output.parentId !== undefined) output.parentId = boundedText(output.parentId, 'Task parentId');
    if (!['title', 'notes', 'status', 'priority', 'dueAt', 'projectId', 'category', 'tags', 'parentId'].some(key => key in output)) throw new Error('Task update has no editable fields');
  } else if (type === 'delete_task') {
    output.id = boundedText(output.id, 'Task id', true);
  } else if (type === 'create_category' || type === 'delete_category') {
    output.name = boundedText(output.name, 'Category name', true, 80);
  } else if (type === 'create_performance_goal') {
    output.title = boundedText(output.title, 'Performance goal title', true, 160);
    output.weight = Number(output.weight);
    if (!Number.isFinite(output.weight) || output.weight < 0 || output.weight > 100) throw new Error('Performance goal weight must be between 0 and 100');
    output.successCriteria = boundedText(output.successCriteria, 'Success criteria', false, 1000);
    output.dueAt = normalizeDate(output.dueAt, 'Goal dueAt');
  } else if (type === 'create_performance_control') {
    output.goalId = boundedText(output.goalId, 'Control goal id', true);
    output.title = boundedText(output.title, 'Control title', true, 160);
    output.frequency = boundedText(output.frequency, 'Control frequency', false, 80);
    output.dueAt = normalizeDate(output.dueAt, 'Control dueAt');
    output.status = ['not-assessed', 'compliant', 'watch', 'exception'].includes(output.status) ? output.status : 'not-assessed';
  } else if (type === 'create_performance_initiative') {
    output.goalId = boundedText(output.goalId, 'Initiative goal id', true);
    output.title = boundedText(output.title, 'Initiative title', true, 160);
    output.status = POLICY.allowedStatuses.includes(output.status) ? output.status : 'planned';
    output.dueAt = normalizeDate(output.dueAt, 'Initiative dueAt');
    output.progress = Number(output.progress);
    if (!Number.isFinite(output.progress) || output.progress < 0 || output.progress > 100) throw new Error('Initiative progress must be between 0 and 100');
    for (const field of ['baseline', 'targetOutcome', 'metricAfter']) output[field] = boundedText(output[field], `Initiative ${field}`, false, 1000);
  } else if (type === 'create_performance_evidence') {
    for (const field of ['goalId', 'controlId', 'initiativeId']) output[field] = boundedText(output[field], `Evidence ${field}`);
    output.occurredAt = normalizeDate(output.occurredAt, 'Evidence occurredAt');
    for (const field of ['contribution', 'outcome', 'metricBefore', 'metricAfter', 'evidenceType', 'evidenceRef', 'confidentiality']) output[field] = boundedText(output[field], `Evidence ${field}`, field === 'contribution' || field === 'outcome' || field === 'evidenceRef', field === 'evidenceRef' ? 500 : 1000);
  } else if (type === 'create_performance_checkpoint') {
    output.title = boundedText(output.title, 'Checkpoint title', true, 160);
    output.dueAt = normalizeDate(output.dueAt, 'Checkpoint dueAt', true);
    output.status = POLICY.allowedStatuses.includes(output.status) ? output.status : 'planned';
    output.requiredOutput = boundedText(output.requiredOutput, 'Checkpoint required output', false, 1000);
  } else if (type === 'update_performance_record') {
    output.recordType = boundedText(output.recordType, 'Performance record type', true, 40);
    if (!['goal', 'control', 'initiative', 'evidence', 'checkpoint'].includes(output.recordType)) throw new Error('Performance record type is invalid');
    output.id = boundedText(output.id, 'Performance record id', true);
    for (const field of ['title', 'successCriteria', 'frequency', 'baseline', 'targetOutcome', 'metricAfter', 'contribution', 'outcome', 'metricBefore', 'metricAfter', 'evidenceType', 'evidenceRef', 'confidentiality', 'requiredOutput']) if (output[field] !== undefined) output[field] = boundedText(output[field], `Performance ${field}`, false, field === 'evidenceRef' ? 500 : 1000);
    if (output.status !== undefined && ![...POLICY.allowedStatuses, 'not-assessed', 'compliant', 'watch', 'exception'].includes(output.status)) throw new Error('Performance status is invalid');
    if (output.dueAt !== undefined) output.dueAt = normalizeDate(output.dueAt, 'Performance dueAt');
    for (const field of ['weight', 'progress']) if (output[field] !== undefined && (!Number.isFinite(Number(output[field])) || Number(output[field]) < 0 || Number(output[field]) > 100)) throw new Error(`Performance ${field} must be between 0 and 100`);
    if (!Object.keys(output).some(key => !['type', 'recordType', 'id', 'source'].includes(key))) throw new Error('Performance update has no editable fields');
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
  if (normalized.operations.some(operation => operation.type === 'delete_task')) throw new Error('LLM cannot delete Planner tasks');
  if (normalized.operations.some(operation => operation.type.includes('performance'))) throw new Error('LLM cannot process performance-management records');
  return { operations: normalized.operations, needsConfirmation: true, clarification };
}

module.exports = { POLICY, validateOperations, validateProposal };
