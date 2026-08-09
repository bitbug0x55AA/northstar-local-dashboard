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

test('AI usage keeps the summary renderable when cached data is partial', () => {
  const app = sources.find(source => source.name === 'app.js').content;
  const index = sources.find(source => source.name === 'index.html').content;
  assert.match(app, /function normalizeUsage\(value\)/, 'usage data must be normalized before rendering');
  assert.match(app, /state\.usage=normalizeUsage\(state\.usage\)/, 'every render must recover from partial usage state');
  assert.doesNotMatch(index, /session-monitor\.js/, 'session monitoring must not mutate the usage page from a second render path');
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

function listenedSelectors(content) {
  const selectors = new Set();
  const addMatches = pattern => {
    for (const match of content.matchAll(pattern)) selectors.add(match.groups.selector);
  };

  // Direct listeners and querySelectorAll(...).forEach(button => button.addEventListener(...)).
  addMatches(/(?:querySelector(?:All)?|\$)\(\s*(['"`])(?<selector>[^'"`]+)\1\s*\)[^;\n]{0,240}?addEventListener\(/g);
  for (const match of content.matchAll(/querySelectorAll\(\s*(['"`])(?<selector>[^'"`]+)\1\s*\)\.forEach\(\s*(?<variable>[A-Za-z_$][\w$]*)\s*=>\s*\{?(?<body>[\s\S]{0,800}?)\}\);/g)) {
    if (new RegExp(`\\b${match.groups.variable}\\??\\.addEventListener\\(`).test(match.groups.body)) selectors.add(match.groups.selector);
  }
  // Delegated listeners such as event.target.closest('[data-action]').
  addMatches(/event\.target\.closest\(\s*(['"`])(?<selector>[^'"`]+)\1\s*\)/g);

  // Selectors assigned to a local before the listener is registered.
  for (const match of content.matchAll(/(?:const|let)\s+(?<variable>[A-Za-z_$][\w$]*)\s*=\s*(?:document\.)?(?:querySelector|\$)\(\s*(['"`])(?<selector>[^'"`]+)\2\s*\)/g)) {
    const listener = new RegExp(`\\b${match.groups.variable}\\??\\.addEventListener\\(`);
    if (listener.test(content.slice(match.index))) selectors.add(match.groups.selector);
  }

  // A document-level click listener may intentionally dispatch by element id.
  if (/document\.addEventListener\(\s*['"]click['"]/.test(content)) {
    for (const match of content.matchAll(/\.id\s*===?\s*(['"])(?<id>[^'"]+)\1/g)) selectors.add(`#${match.groups.id}`);
  }
  return selectors;
}

function selectorCoversElement(selector, tag) {
  const id = tag.match(/\bid=["']([^"']+)["']/)?.[1];
  const classes = new Set((tag.match(/\bclass=["']([^"']+)["']/)?.[1] || '').split(/\s+/).filter(Boolean));
  const attributes = new Map([...tag.matchAll(/\b(data-[\w-]+)(?:=["']([^"']*)["'])?/g)].map(match => [match[1], match[2]]));

  return selector.split(',').some(part => {
    const target = part.trim().split(/\s+|>/).filter(Boolean).at(-1) || '';
    const selectorId = target.match(/#([\w-]+)/)?.[1];
    if (selectorId && selectorId !== id) return false;
    const selectorClasses = [...target.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
    if (selectorClasses.some(className => !classes.has(className))) return false;
    const selectorAttributes = [...target.matchAll(/\[(data-[\w-]+)(?:=["']([^"']*)["'])?\]/g)];
    if (selectorAttributes.some(match => !attributes.has(match[1]) || (match[2] !== undefined && attributes.get(match[1]) !== match[2]))) return false;
    const elementName = tag.match(/^<([\w-]+)/)?.[1];
    return target === elementName || Boolean(selectorId || selectorClasses.length || selectorAttributes.length);
  });
}

function enclosingForm(content, buttonIndex) {
  const prefix = content.slice(0, buttonIndex);
  const formStart = prefix.lastIndexOf('<form');
  if (formStart < 0 || formStart < prefix.lastIndexOf('</form>')) return null;
  return content.slice(formStart, content.indexOf('>', formStart) + 1);
}

test('every rendered button is covered by a selector with a real event listener', () => {
  const buttonTags = sources.flatMap(source => [...source.content.matchAll(/<button\b[^>]*>/g)].map(match => ({ source: source.name, content: source.content, index: match.index, button: match[0] })));
  const selectors = new Set(sources.flatMap(source => [...listenedSelectors(source.content)]));
  assert.ok(buttonTags.length >= 80, 'expected the full dashboard button surface to be scanned');
  assert.ok(selectors.size >= 30, 'expected event-bound selectors to be inferred from the UI source');
  assert.ok(![...selectors].some(selector => selectorCoversElement(selector, '<button class="ghost-button feature-added-later">')), 'an unbound class must not pass through a generic button whitelist');

  for (const { source, content, index, button } of buttonTags) {
    const form = /\btype=["']submit["']/.test(button) ? enclosingForm(content, index) : null;
    const hasFormSubmitContract = form && [...selectors].some(selector => selectorCoversElement(selector, form));
    const isCovered = [...selectors].some(selector => selectorCoversElement(selector, button));
    assert.ok(hasFormSubmitContract || isCovered, `dead button contract in ${source}: ${button}`);
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
