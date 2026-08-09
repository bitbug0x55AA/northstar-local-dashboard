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

function normalizedChoice(value, label, choices, fallback = null) {
  const text = asText(value).toLowerCase();
  if (!text) return fallback;
  if (!choices.includes(text)) throw new Error(`${label} is invalid`);
  return text;
}

function normalizedCount(value, label) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be zero or greater`);
  return number;
}

function normalizeFitnessExercises(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) throw new Error('Fitness exercises must contain between 1 and 20 items');
  return value.map((exercise, index) => {
    if (!exercise || typeof exercise !== 'object' || Array.isArray(exercise)) throw new Error(`Fitness exercise ${index + 1} is invalid`);
    const output = { exerciseName: boundedText(exercise.exerciseName, 'Fitness exercise name', true, 120) };
    output.setsArePerSide = exercise.setsArePerSide === true || exercise.setsArePerSide === 'true';
    for (const field of ['sets', 'reps', 'loadKg']) {
      const number = Number(exercise[field]);
      if (!Number.isFinite(number) || number < 0) throw new Error(`Fitness exercise ${field} is invalid`);
      output[field] = number;
    }
    return output;
  });
}

function normalizeFitnessSession(output, { includeId = false } = {}) {
  if (includeId) output.id = boundedText(output.id, 'Fitness session id', true);
  output.plan = boundedText(output.plan, 'Fitness plan', true, 40);
  if (output.plan !== 'strength') throw new Error('Fitness plan is invalid');
  output.session = boundedText(output.session, 'Fitness session', true, 80);
  output.performedAt = normalizeDate(output.performedAt, 'Fitness performedAt') || new Date().toISOString();
  output.exercises = normalizeFitnessExercises(output.exercises);
  for (const field of ['durationMinutes', 'rpe', 'quality', 'soreness24', 'soreness48']) {
    if (['soreness24', 'soreness48'].includes(field) && (output[field] === '' || output[field] === null || output[field] === undefined)) { output[field] = null; continue; }
    const value = Number(output[field]);
    if (!Number.isFinite(value) || value < 0 || (['rpe', 'soreness24', 'soreness48'].includes(field) && value > 10) || (field === 'quality' && value > 5)) throw new Error(`Fitness ${field} is invalid`);
    output[field] = value;
  }
  output.notes = boundedText(output.notes, 'Fitness notes', false, 1000);
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
  } else if (type === 'update_event') {
    output.id = boundedText(output.id, 'Event id', true);
    if (output.title !== undefined) output.title = boundedText(output.title, 'Event title', true);
    if (output.notes !== undefined) output.notes = boundedText(output.notes, 'Event notes');
    if (output.startAt !== undefined) output.startAt = normalizeDate(output.startAt, 'Event startAt', true);
    if (output.endAt !== undefined) output.endAt = normalizeDate(output.endAt, 'Event endAt');
    if (!['title', 'notes', 'startAt', 'endAt'].some(key => key in output)) throw new Error('Event update has no editable fields');
  } else if (type === 'delete_event') {
    output.id = boundedText(output.id, 'Event id', true);
  } else if (type === 'create_milestone' || type === 'update_milestone') {
    if (type === 'update_milestone') output.id = boundedText(output.id, 'Milestone id', true);
    if (output.domain !== undefined || type === 'create_milestone') { output.domain = boundedText(output.domain, 'Milestone domain', true, 30); if (!['security', 'github'].includes(output.domain)) throw new Error('Milestone domain is invalid'); }
    if (output.milestoneType !== undefined || type === 'create_milestone') output.milestoneType = boundedText(output.milestoneType, 'Milestone type', true, 40);
    if (output.title !== undefined || type === 'create_milestone') output.title = boundedText(output.title, 'Milestone title', true, 200);
    for (const field of ['period', 'year', 'repo', 'target', 'notes']) if (output[field] !== undefined) output[field] = boundedText(output[field], `Milestone ${field}`, false, field === 'notes' ? 1000 : 160);
    if (output.status !== undefined || type === 'create_milestone') output.status = POLICY.allowedStatuses.includes(output.status) ? output.status : 'planned';
    if (output.progress !== undefined || type === 'create_milestone') { output.progress = Number(output.progress || 0); if (!Number.isFinite(output.progress) || output.progress < 0 || output.progress > 100) throw new Error('Milestone progress must be between 0 and 100'); }
    if (output.status === 'done') output.progress = 100;
    if (type === 'update_milestone' && !Object.keys(output).some(key => !['type', 'id', 'source'].includes(key))) throw new Error('Milestone update has no editable fields');
  } else if (type === 'delete_milestone') {
    output.id = boundedText(output.id, 'Milestone id', true);
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
  } else if (type === 'create_category' || type === 'update_category' || type === 'delete_category') {
    if (type === 'update_category') output.oldName = boundedText(output.oldName, 'Existing category name', true, 80);
    output.name = boundedText(output.name, 'Category name', true, 80);
    if (output.labelEn !== undefined) output.labelEn = boundedText(output.labelEn, 'English category label', false, 80);
    if (output.module !== undefined) output.module = normalizedChoice(output.module, 'Category module', ['none', 'roadmap', 'github', 'performance', 'fitness']);
  } else if (['create_fitness_plan', 'update_fitness_plan', 'delete_fitness_plan'].includes(type)) {
    if (type !== 'create_fitness_plan') output.id = boundedText(output.id, 'Fitness plan id', true);
    if (type !== 'delete_fitness_plan') {
      output.name = boundedText(output.name, 'Fitness plan name', true, 120);
      for (const field of ['labelEn', 'focus', 'focusEn']) output[field] = boundedText(output[field], `Fitness plan ${field}`, false, 500);
    }
  } else if (['create_performance_target', 'update_performance_target', 'delete_performance_target'].includes(type)) {
    if (type !== 'create_performance_target') output.id = boundedText(output.id, 'Performance target id', true);
    if (type !== 'delete_performance_target') {
      output.name = boundedText(output.name, 'Performance target name', true, 120);
      output.labelEn = boundedText(output.labelEn, 'Performance target English label', false, 120);
      output.target = normalizedCount(output.target, 'Performance target');
    }
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
    output.reviewer = boundedText(output.reviewer, 'Control reviewer', false, 160);
    output.lastTestedAt = normalizeDate(output.lastTestedAt, 'Control lastTestedAt');
    output.evidenceRef = boundedText(output.evidenceRef, 'Control evidenceRef', false, 500);
  } else if (type === 'create_performance_initiative') {
    output.goalId = boundedText(output.goalId, 'Initiative goal id', true);
    output.title = boundedText(output.title, 'Initiative title', true, 160);
    output.status = POLICY.allowedStatuses.includes(output.status) ? output.status : 'planned';
    output.dueAt = normalizeDate(output.dueAt, 'Initiative dueAt');
    output.progress = Number(output.progress);
    if (!Number.isFinite(output.progress) || output.progress < 0 || output.progress > 100) throw new Error('Initiative progress must be between 0 and 100');
    for (const field of ['baseline', 'targetOutcome', 'metricAfter', 'roleScope', 'ipClassification']) output[field] = boundedText(output[field], `Initiative ${field}`, false, 1000);
    output.productionApproved = normalizedChoice(output.productionApproved, 'Initiative productionApproved', ['yes', 'no', 'n/a'], 'no');
    output.adoptedBeyondTeam = normalizedChoice(output.adoptedBeyondTeam, 'Initiative adoptedBeyondTeam', ['yes', 'no', 'n/a'], 'no');
    output.evidenceRef = boundedText(output.evidenceRef, 'Initiative evidenceRef', false, 500);
  } else if (type === 'create_performance_evidence') {
    for (const field of ['goalId', 'controlId', 'initiativeId']) output[field] = boundedText(output[field], `Evidence ${field}`);
    output.occurredAt = normalizeDate(output.occurredAt, 'Evidence occurredAt');
    for (const field of ['contribution', 'outcome', 'metricBefore', 'metricAfter', 'measurementMethod', 'evidenceType', 'evidenceRef', 'confidentiality', 'stakeholder', 'reviewer']) output[field] = boundedText(output[field], `Evidence ${field}`, field === 'contribution' || field === 'outcome' || field === 'evidenceRef', field === 'evidenceRef' ? 500 : 1000);
    output.productionUse = normalizedChoice(output.productionUse, 'Evidence productionUse', ['yes', 'no', 'n/a'], 'no');
    output.crossTeamImpact = normalizedChoice(output.crossTeamImpact, 'Evidence crossTeamImpact', ['yes', 'no', 'n/a'], 'no');
    output.reviewedAt = normalizeDate(output.reviewedAt, 'Evidence reviewedAt');
  } else if (type === 'create_performance_checkpoint') {
    output.title = boundedText(output.title, 'Checkpoint title', true, 160);
    output.dueAt = normalizeDate(output.dueAt, 'Checkpoint dueAt', true);
    output.status = POLICY.allowedStatuses.includes(output.status) ? output.status : 'planned';
    output.requiredOutput = boundedText(output.requiredOutput, 'Checkpoint required output', false, 1000);
    output.completedAt = normalizeDate(output.completedAt, 'Checkpoint completedAt');
    output.evidenceRef = boundedText(output.evidenceRef, 'Checkpoint evidenceRef', false, 500);
  } else if (type === 'create_performance_monthly_review') {
    output.month = normalizeDate(output.month, 'Monthly review month', true);
    output.kriResult = Number(output.kriResult);
    if (!Number.isFinite(output.kriResult) || output.kriResult < 0 || output.kriResult > 100) throw new Error('Monthly review KRI result must be between 0 and 100');
    output.ttcCorrections = normalizedCount(output.ttcCorrections, 'Monthly review TTC corrections');
    output.overdueCount = normalizedCount(output.overdueCount, 'Monthly review overdue count');
    for (const field of ['sirComplete', 'queueHealthy', 'workTimely', 'rasMet', 'materialMiss']) output[field] = normalizedChoice(output[field], `Monthly review ${field}`, ['yes', 'no', 'n/a'], 'n/a');
    output.evidenceRef = boundedText(output.evidenceRef, 'Monthly review evidenceRef', false, 500);
    output.reviewer = boundedText(output.reviewer, 'Monthly review reviewer', false, 160);
    output.reviewedAt = normalizeDate(output.reviewedAt, 'Monthly review reviewedAt');
  } else if (type === 'create_performance_activity') {
    output.goalId = boundedText(output.goalId, 'Activity goal id');
    output.activityType = boundedText(output.activityType, 'Activity type', true, 80);
    output.title = boundedText(output.title, 'Activity title', true, 160);
    output.occurredAt = normalizeDate(output.occurredAt, 'Activity occurredAt');
    output.role = boundedText(output.role, 'Activity role', false, 160);
    output.requiredOutcome = boundedText(output.requiredOutcome, 'Activity required outcome', false, 1000);
    output.ownedAction = boundedText(output.ownedAction, 'Activity owned action', false, 1000);
    output.dueAt = normalizeDate(output.dueAt, 'Activity dueAt');
    output.status = POLICY.allowedStatuses.includes(output.status) ? output.status : 'planned';
    output.externalCollaboration = normalizedChoice(output.externalCollaboration, 'Activity externalCollaboration', ['yes', 'no', 'n/a'], 'no');
    output.evidenceRef = boundedText(output.evidenceRef, 'Activity evidenceRef', false, 500);
  } else if (type === 'create_performance_promotion') {
    output.capability = boundedText(output.capability, 'Promotion capability', true, 160);
    for (const field of ['currentEvidence', 'evidenceRef', 'managerAssessment', 'gapAction']) output[field] = boundedText(output[field], `Promotion ${field}`, false, field === 'evidenceRef' ? 500 : 1000);
    output.dueAt = normalizeDate(output.dueAt, 'Promotion dueAt');
    output.status = POLICY.allowedStatuses.includes(output.status) ? output.status : 'planned';
  } else if (type === 'update_performance_record') {
    output.recordType = boundedText(output.recordType, 'Performance record type', true, 40);
    if (!['goal', 'control', 'initiative', 'evidence', 'checkpoint', 'monthlyReview', 'activity', 'promotion'].includes(output.recordType)) throw new Error('Performance record type is invalid');
    output.id = boundedText(output.id, 'Performance record id', true);
    for (const field of ['title', 'successCriteria', 'frequency', 'baseline', 'targetOutcome', 'metricAfter', 'contribution', 'outcome', 'metricBefore', 'metricAfter', 'evidenceType', 'evidenceRef', 'confidentiality', 'requiredOutput']) if (output[field] !== undefined) output[field] = boundedText(output[field], `Performance ${field}`, false, field === 'evidenceRef' ? 500 : 1000);
    if (output.status !== undefined && ![...POLICY.allowedStatuses, 'not-assessed', 'compliant', 'watch', 'exception'].includes(output.status)) throw new Error('Performance status is invalid');
    if (output.dueAt !== undefined) output.dueAt = normalizeDate(output.dueAt, 'Performance dueAt');
    for (const field of ['weight', 'progress']) if (output[field] !== undefined && (!Number.isFinite(Number(output[field])) || Number(output[field]) < 0 || Number(output[field]) > 100)) throw new Error(`Performance ${field} must be between 0 and 100`);
    if (!Object.keys(output).some(key => !['type', 'recordType', 'id', 'source'].includes(key))) throw new Error('Performance update has no editable fields');
  } else if (type === 'delete_performance_record') {
    output.recordType = boundedText(output.recordType, 'Performance record type', true, 40);
    if (!['goal', 'control', 'initiative', 'evidence', 'checkpoint', 'monthlyReview', 'activity', 'promotion'].includes(output.recordType)) throw new Error('Performance record type is invalid');
    output.id = boundedText(output.id, 'Performance record id', true);
  } else if (type === 'log_fitness_session') {
    normalizeFitnessSession(output);
  } else if (type === 'update_fitness_session') {
    normalizeFitnessSession(output, { includeId: true });
  } else if (type === 'delete_fitness_session') {
    output.id = boundedText(output.id, 'Fitness session id', true);
  } else if (type === 'log_hike') {
    output.performedAt = normalizeDate(output.performedAt, 'Hike performedAt') || new Date().toISOString();
    for (const field of ['durationMinutes', 'distanceKm', 'elevationM', 'effort']) {
      const value = Number(output[field]);
      if (!Number.isFinite(value) || value < 0 || (field === 'effort' && value > 10)) throw new Error(`Hike ${field} is invalid`);
      output[field] = value;
    }
    output.notes = boundedText(output.notes, 'Hike notes', false, 1000);
  } else if (type === 'update_fitness_profile') {
    for (const field of ['heightCm', 'weightKg']) {
      const value = Number(output[field]);
      if (!Number.isFinite(value) || value <= 0 || value > (field === 'heightCm' ? 260 : 400)) throw new Error(`Fitness ${field} is invalid`);
      output[field] = value;
    }
  } else if (type === 'log_fitness_weight') {
    output.weightKg = Number(output.weightKg);
    if (!Number.isFinite(output.weightKg) || output.weightKg <= 0 || output.weightKg > 400) throw new Error('Fitness weightKg is invalid');
    output.measuredAt = normalizeDate(output.measuredAt, 'Fitness measuredAt') || new Date().toISOString();
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
  if (normalized.operations.some(operation => operation.type.startsWith('delete_'))) throw new Error('LLM cannot delete Planner records');
  if (normalized.operations.some(operation => operation.type.includes('performance'))) throw new Error('LLM cannot process performance-management records');
  if (normalized.operations.some(operation => operation.type.includes('fitness') || operation.type === 'log_hike')) throw new Error('LLM cannot process private tracking records');
  return { operations: normalized.operations, needsConfirmation: true, clarification };
}

module.exports = { POLICY, validateOperations, validateProposal };
