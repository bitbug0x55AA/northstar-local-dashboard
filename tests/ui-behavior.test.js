const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const appDirectory = path.join(__dirname, '..', 'app');
const script = name => fs.readFileSync(path.join(appDirectory, name), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

function createDom(body) {
  const dom = new JSDOM(`<!doctype html><html lang="en"><body>${body}</body></html>`, {
    runScripts: 'outside-only',
    url: 'http://127.0.0.1/'
  });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  return dom;
}

function plannerShared(request = async () => ({})) {
  return {
    escapeHtml: value => String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character])),
    tr: (_zh, en) => en,
    dateText: value => String(value ?? ''),
    categoryText: value => value,
    request
  };
}

test('observability combines tab, level, status and query filters after real DOM events', async () => {
  const dom = createDom('<main id="view-observability"></main>');
  const requests = [];
  dom.window.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => 'application/json' },
      json: async () => ({ events: [], summary: { total: 0, openAlerts: 0, critical: 0, byTab: {} } })
    };
  };
  dom.window.eval(script('observability.js'));
  await dom.window.observability.load();

  dom.window.document.querySelector('[data-obs-tab="security"]').click();
  await settle();
  const level = dom.window.document.querySelector('#obsLevel');
  level.value = 'warning';
  level.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await settle();
  const status = dom.window.document.querySelector('#obsStatus');
  status.value = 'open';
  status.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await settle();
  const query = dom.window.document.querySelector('#obsQuery');
  query.value = 'quota alert';
  query.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await settle();

  const lastGet = [...requests].reverse().find(request => !request.options.method);
  const params = new URL(lastGet.url, 'http://127.0.0.1').searchParams;
  assert.deepStrictEqual(Object.fromEntries(params), { tab: 'security', level: 'warning', status: 'open', q: 'quota alert' });
  dom.window.close();
});

test('fitness keeps strength, hike, new and edit form modes mutually consistent', async () => {
  const dom = createDom('<main id="fitnessRoot"></main>');
  dom.window.NorthstarPlannerShared = plannerShared();
  dom.window.confirm = () => true;
  dom.window.eval(script('planner-fitness.js'));
  const applied = [];
  const state = {
    data: {
      fitness: {
        profile: null,
        weightLogs: [],
        hikes: [],
        plans: [{ id: 'plan-a', name: 'Plan A', focus: 'Strength' }],
        strengthLogs: [{
          id: 'record-1', session: 'plan-a', performedAt: '2026-08-01T09:00:00.000Z', durationMinutes: 45,
          exercises: [{ exerciseName: 'Squat', loadKg: 80, reps: 5, sets: 3, setsArePerSide: false }],
          rpe: 7, quality: 4, soreness24: 2, soreness48: 1, notes: 'steady'
        }]
      }
    },
    llm: { configured: false },
    fitnessMode: null,
    fitnessSession: null,
    fitnessRecordId: null,
    fitnessExercises: null,
    fitnessReview: null
  };
  const apply = async operations => { applied.push(operations); state.render(); };
  state.render = () => {
    dom.window.document.querySelector('#fitnessRoot').innerHTML = dom.window.NorthstarPlannerFitness.render(state.data, state);
    dom.window.NorthstarPlannerFitness.bind(state, apply, assert.fail);
  };
  state.render();

  dom.window.document.querySelector('[data-fitness-log="strength"]').click();
  assert.strictEqual(state.fitnessMode, 'strength');
  assert.ok(dom.window.document.querySelector('#fitnessRpe'));
  assert.strictEqual(dom.window.document.querySelector('#fitnessDistance'), null);
  dom.window.document.querySelector('.fitness-close').click();
  assert.strictEqual(state.fitnessMode, null);

  dom.window.document.querySelector('[data-fitness-log="hike"]').click();
  assert.strictEqual(state.fitnessMode, 'hike');
  assert.ok(dom.window.document.querySelector('#fitnessDistance'));
  assert.strictEqual(dom.window.document.querySelector('#fitnessRpe'), null);
  dom.window.document.querySelector('.fitness-close').click();

  dom.window.document.querySelector('[data-fitness-edit="record-1"]').click();
  assert.strictEqual(state.fitnessMode, 'strength');
  assert.strictEqual(state.fitnessRecordId, 'record-1');
  assert.strictEqual(dom.window.document.querySelector('.fitness-exercise-name').value, 'Squat');
  dom.window.document.querySelector('.fitness-save').click();
  await settle();

  assert.strictEqual(applied.length, 1);
  assert.strictEqual(applied[0][0].type, 'update_fitness_session');
  assert.strictEqual(applied[0][0].id, 'record-1');
  assert.strictEqual(state.fitnessMode, null);
  assert.strictEqual(dom.window.document.querySelector('.fitness-modal-backdrop'), null, 'saving must close the rendered modal as well as reset state');
  dom.window.close();
});

test('security roadmap completes edit, cancel and save state transitions', async () => {
  const dom = createDom('<main id="securityRoot"></main>');
  dom.window.NorthstarPlannerShared = plannerShared();
  dom.window.confirm = () => true;
  dom.window.eval(script('planner-security.js'));
  const applied = [];
  const data = {
    milestones: [{ id: 'mile-1', domain: 'security', milestoneType: 'course', title: 'Reverse Engineering', year: '2026', period: 'Q3', status: 'in-progress', progress: 40, notes: 'labs' }],
    progressLogs: []
  };
  const state = { editingMilestoneId: null };
  const render = () => {
    dom.window.document.querySelector('#securityRoot').innerHTML = dom.window.NorthstarPlannerSecurity.render(data, state, () => [], 'Security');
    dom.window.NorthstarPlannerSecurity.bind(state, async operations => applied.push(operations), render, assert.fail);
  };
  render();

  dom.window.document.querySelector('.security-edit-milestone').click();
  assert.strictEqual(state.editingMilestoneId, 'mile-1');
  assert.strictEqual(dom.window.document.querySelector('#securityMilestoneTitle').value, 'Reverse Engineering');
  assert.ok(dom.window.document.querySelector('#securityCancelMilestone'));
  dom.window.document.querySelector('#securityCancelMilestone').click();
  assert.strictEqual(state.editingMilestoneId, null);
  assert.strictEqual(dom.window.document.querySelector('#securityCancelMilestone'), null);

  dom.window.document.querySelector('.security-edit-milestone').click();
  dom.window.document.querySelector('#securityMilestoneTitle').value = 'Advanced Reverse Engineering';
  dom.window.document.querySelector('#securityMilestoneProgress').value = '65';
  dom.window.document.querySelector('#securitySaveMilestone').click();
  await settle();

  assert.strictEqual(applied.length, 1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(applied[0][0])), {
    type: 'update_milestone', id: 'mile-1', domain: 'security', milestoneType: 'course', title: 'Advanced Reverse Engineering',
    year: '2026', period: 'Q3', status: 'in-progress', progress: 65, notes: 'labs'
  });
  assert.strictEqual(state.editingMilestoneId, null);
  assert.strictEqual(dom.window.document.querySelector('#securityCancelMilestone'), null);
  dom.window.close();
});

test('planner LLM preview cannot apply operations before explicit confirmation', async () => {
  const dom = createDom('<main id="llmRoot"></main>');
  const operations = [{ type: 'create_task', title: 'Run auth lab' }];
  const requests = [];
  dom.window.NorthstarPlannerShared = plannerShared(async (url, options) => {
    requests.push({ url, options });
    return { operations };
  });
  dom.window.eval(script('planner-llm.js'));
  const state = { configured: true, tested: false, testing: false };
  const applied = [];
  dom.window.document.querySelector('#llmRoot').innerHTML = dom.window.NorthstarPlannerLlm.render(state);
  dom.window.NorthstarPlannerLlm.bind(state, async (...args) => applied.push(args), assert.fail);
  dom.window.document.querySelector('#plannerNaturalInput').value = 'Finish the auth lab';

  dom.window.document.querySelector('#plannerInterpret').click();
  await settle();
  assert.strictEqual(requests.length, 1);
  assert.strictEqual(applied.length, 0, 'previewing must not write planner data');
  assert.ok(dom.window.document.querySelector('#plannerConfirm'));

  dom.window.document.querySelector('#plannerConfirm').click();
  await settle();
  assert.deepStrictEqual(applied, [[operations, true]]);
  dom.window.close();
});
