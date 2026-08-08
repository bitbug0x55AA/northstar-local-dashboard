const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const appDirectory = path.join(__dirname, '..', 'app');
const sources = fs.readdirSync(appDirectory)
  .filter(name => /\.(?:js|html)$/.test(name))
  .map(name => ({ name, content: fs.readFileSync(path.join(appDirectory, name), 'utf8') }));
const combined = sources.map(source => source.content).join('\n');

test('core dashboard language switch has bidirectional labels and Chinese fallbacks', () => {
  const app = sources.find(source => source.name === 'app.js').content;
  for (const [zh, en] of [
    ['总览', 'Overview'], ['发布版本', 'Releases'], ['计划看板', 'Planning Board'],
    ['CI 状态', 'CI Status'], ['合并编排', 'Merge Orchestrator'], ['审查', "Review:'审查'"]
  ]) {
    assert.ok(app.includes(zh), `missing Chinese label: ${zh}`);
    assert.ok(app.includes(en), `missing English label or Chinese fallback mapping: ${en}`);
  }
  assert.match(app, /function renderGithubSubnav\(\)/, 'sub-navigation must re-render after a language change');
  assert.match(app, /renderGithubSubnav\(\);/, 'the language-aware sub-navigation renderer must run with each render');
  assert.match(app, /document\.documentElement\.lang=isEnglish\(\)\?'en':'zh-CN'/, 'the document language must track the selected language');
});

test('observability UI has a bilingual rendering contract', () => {
  const observability = sources.find(source => source.name === 'observability.js').content;
  assert.match(observability, /const tr = \(zh, en\) => document\.documentElement\.lang === 'en' \? en : zh/, 'observability must use the selected document language');
  for (const [zh, en] of [
    ['日志与审计', 'Logs & Audit'], ['事件总数', 'Total Events'], ['未处理告警', 'Open Alerts'],
    ['如何阅读这些日志', 'How to read these logs'], ['刷新', 'Refresh'], ['没有事件符合这些筛选条件。', 'No events match these filters.']
  ]) {
    assert.ok(observability.includes(`tr('${zh}', '${en}')`), `missing observability translation pair: ${zh} / ${en}`);
  }
  assert.doesNotMatch(observability, /<h1>Logs & Audit<|>↻ Refresh<|>Total Events</u, 'observability UI text must not bypass the translator');
});

test('every rendered button has an explicit interaction contract', () => {
  const buttonTags = sources.flatMap(source => source.content.match(/<button\b[^>]*>/g) || []);
  assert.ok(buttonTags.length >= 30, 'expected the full dashboard button surface to be scanned');
  const handledDataAttributes = ['data-view', 'data-github-subview', 'data-github-view', 'data-go', 'data-planner-tab', 'data-planner-sidepage', 'data-obs-tab'];
  const handledClasses = ['ci-check', 'planner-complete', 'planner-edit', 'planner-delete', 'planner-remove-category', 'obs-action'];

  for (const button of buttonTags) {
    const id = button.match(/\bid=["']([^"']+)["']/)?.[1];
    const hasHandledDataAttribute = handledDataAttributes.some(attribute => button.includes(attribute));
    const hasHandledClass = handledClasses.some(className => new RegExp(`\\b${className}\\b`).test(button));
    const hasRegisteredIdHandler = id && (
      combined.includes(`#${id}`) || combined.includes(`id==='${id}'`) || combined.includes(`id === '${id}'`)
    );
    assert.ok(hasHandledDataAttribute || hasHandledClass || hasRegisteredIdHandler, `dead button contract: ${button}`);
  }
  assert.match(combined, /#avatarButton[\s\S]*addEventListener\('click'/, 'the avatar button must navigate instead of being inert');
  const mergeOrchestrator = sources.find(source => source.name === 'merge-orchestrator.js').content;
  assert.match(mergeOrchestrator, /if \(!view\.classList\.contains\('active-view'\)\) return;/, 'background GitHub observers must not override another button-driven view change');
});

test('GitHub sidebar parent has an accessible expand and collapse contract', () => {
  const index = sources.find(source => source.name === 'index.html').content;
  const mergeOrchestrator = sources.find(source => source.name === 'merge-orchestrator.js').content;
  assert.match(index, /data-github-subnav hidden/, 'the child navigation must start collapsed');
  assert.match(mergeOrchestrator, /nav\.hidden\s*=\s*!expanded/, 'the parent toggle must control child visibility');
  assert.match(mergeOrchestrator, /toggle\.setAttribute\('aria-expanded', String\(expanded\)\)/, 'the parent toggle must expose its state to assistive technology');
  assert.match(mergeOrchestrator, /toggle\.addEventListener\('click'/, 'the GitHub parent navigation needs a click handler');
  assert.match(mergeOrchestrator, /setSubnavExpanded\(false\)/, 'navigating away from GitHub must collapse its child navigation');
});
