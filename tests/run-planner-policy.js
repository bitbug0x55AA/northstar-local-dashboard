const assert = require('assert');
const { validateProposal, validateOperations } = require('../server/planner-validator');
const { applyOperations } = require('../server/planner-store');

const proposal = validateProposal({
  needsConfirmation: false,
  clarification: null,
  operations: [{
    type: 'create_task',
    title: '  Safe task  ',
    status: 'not-a-real-status',
    priority: 'not-a-real-priority',
    dueAt: '2026-08-09',
    source: 'manual',
    run_command: 'never'
  }]
});

assert.equal(proposal.needsConfirmation, true);
assert.equal(proposal.operations[0].title, 'Safe task');
assert.equal(proposal.operations[0].status, 'planned');
assert.equal(proposal.operations[0].priority, 'medium');
assert.equal(proposal.operations[0].source, 'llm');
assert.equal(Object.prototype.hasOwnProperty.call(proposal.operations[0], 'run_command'), false);

const clarification = validateProposal({ operations: [], clarification: 'Which project should this task belong to?' });
assert.deepEqual(clarification.operations, []);
assert.equal(clarification.needsConfirmation, true);
assert.equal(clarification.clarification, 'Which project should this task belong to?');

assert.throws(() => validateProposal({ operations: [{ type: 'delete_task', id: 'x' }] }), /LLM cannot delete/);
assert.equal(validateOperations([{ type: 'delete_task', id: 'x' }], { source: 'manual' }).operations[0].type, 'delete_task');
assert.throws(() => validateProposal({ operations: [{ type: 'create_task', title: 'Bad date', dueAt: 'YYYY-MM-DD' }] }), /placeholder date/);
assert.throws(() => validateProposal({ operations: [{ type: 'create_task', title: 'x'.repeat(1001) }] }), /too long/);
assert.throws(() => validateProposal({ operations: [], clarification: 'x'.repeat(501) }), /too long/);
assert.throws(() => applyOperations([{ type: 'create_task', title: 'Needs confirmation', source: 'llm' }]), /explicit confirmation/);

const manual = validateOperations([{ type: 'log_progress', content: 'Manual note' }], { source: 'manual' });
assert.equal(manual.operations[0].source, 'manual');

const performanceGoal = validateOperations([{ type: 'create_performance_goal', title: 'Local performance goal', weight: 40, successCriteria: 'Objective result' }], { source: 'manual' });
assert.equal(performanceGoal.operations[0].weight, 40);
assert.throws(() => validateProposal({ operations: [{ type: 'create_performance_goal', title: 'Do not send to model', weight: 10 }] }), /cannot process performance-management records/);

const unilateralStrength = validateOperations([{
  type: 'log_fitness_session', plan: 'strength', session: 'A', performedAt: '2026-08-09T10:00:00.000Z',
  durationMinutes: 45, exercises: [{ exerciseName: '单腿 Bench 臀推', sets: 3, setsArePerSide: true, reps: 10, loadKg: 20 }], rpe: 8, quality: 4, notes: ''
}], { source: 'manual' }).operations[0];
assert.equal(unilateralStrength.exercises[0].exerciseName, '单腿 Bench 臀推');
assert.equal(unilateralStrength.exercises[0].sets, 3);
assert.equal(unilateralStrength.exercises[0].reps, 10);
assert.equal(unilateralStrength.exercises[0].setsArePerSide, true);
const updatedStrength = validateOperations([{
  type: 'update_fitness_session', id: 'session-1', plan: 'strength', session: 'A', performedAt: '2026-08-09T10:00:00.000Z',
  durationMinutes: 50, exercises: unilateralStrength.exercises, rpe: 7, quality: 5, soreness24: '', soreness48: '', notes: 'Edited session'
}], { source: 'manual' }).operations[0];
assert.equal(updatedStrength.id, 'session-1');
assert.equal(updatedStrength.exercises.length, 1);
assert.equal(validateOperations([{ type: 'delete_fitness_session', id: 'session-1' }], { source: 'manual' }).operations[0].id, 'session-1');
assert.throws(() => validateOperations([{
  type: 'log_fitness_session', plan: 'strength', session: 'A', durationMinutes: 45,
  exercises: [], rpe: 8, quality: 4
}], { source: 'manual' }), /exercises/);

console.log('Planner policy checks passed');
