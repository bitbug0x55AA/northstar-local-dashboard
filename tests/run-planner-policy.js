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

assert.throws(() => validateProposal({ operations: [{ type: 'delete_task', id: 'x' }] }), /Unsupported planner operation/);
assert.throws(() => validateProposal({ operations: [{ type: 'create_task', title: 'Bad date', dueAt: 'YYYY-MM-DD' }] }), /placeholder date/);
assert.throws(() => validateProposal({ operations: [{ type: 'create_task', title: 'x'.repeat(1001) }] }), /too long/);
assert.throws(() => validateProposal({ operations: [], clarification: 'x'.repeat(501) }), /too long/);
assert.throws(() => applyOperations([{ type: 'create_task', title: 'Needs confirmation', source: 'llm' }]), /explicit confirmation/);

const manual = validateOperations([{ type: 'log_progress', content: 'Manual note' }], { source: 'manual' });
assert.equal(manual.operations[0].source, 'manual');

console.log('Planner policy checks passed');
