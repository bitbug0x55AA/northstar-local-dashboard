(function () {
  const DEFAULT_CATEGORIES = ['安全技能学习与实验室', 'GitHub 开源项目', '工作绩效管理', '个人健身'];
  const WORK_PERFORMANCE_CATEGORY = DEFAULT_CATEGORIES[2];
  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const isEnglish = () => document.documentElement.lang === 'en';
  const tr = (zh, en) => isEnglish() ? en : zh;
  const categoryId = category => `category:${category}`;
  const categoryFromPage = page => page.startsWith('category:') ? page.slice(9) : null;
  const categoryText = category => ({
    '安全技能学习与实验室': tr('安全技能学习与实验室', 'Cybersecurity Learning & Labs'),
    'GitHub 开源项目': tr('GitHub 开源项目', 'GitHub Open Source'),
    '工作绩效管理': tr('工作绩效管理', 'Work Performance'),
    '个人健身': tr('个人健身', 'Personal Fitness')
  }[category] || category);
  const dateText = value => value ? new Date(value).toLocaleString(isEnglish() ? 'en-AU' : 'zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : tr('未设置日期', 'No date');
  const taskProgress = tasks => tasks.length ? Math.round(tasks.filter(task => task.status === 'done').length / tasks.length * 100) : 0;
  async function request(url, options) { const response = await fetch(url, options); const payload = await response.json().catch(() => ({})); if (!response.ok || payload.error) throw new Error(payload.error || `Request failed (${response.status})`); return payload; }
  window.NorthstarPlannerShared = { DEFAULT_CATEGORIES, WORK_PERFORMANCE_CATEGORY, escapeHtml, tr, categoryId, categoryFromPage, categoryText, dateText, taskProgress, request };
}());
