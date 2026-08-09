(function () {
  let plannerData = null;
  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const isEnglish = () => document.documentElement.lang === 'en';
  const tr = (zh, en) => isEnglish() ? en : zh;
  const categoryId = category => `category:${category}`;
  const categoryFromPage = page => page.startsWith('category:') ? page.slice(9) : null;
  const setData = data => { plannerData = data; };
  const categoryText = category => {
    const label = plannerData?.settings?.categoryLabels?.find(item => item.category === category)?.labelEn;
    return isEnglish() && label ? label : category;
  };
  const moduleCategory = (data, type) => data?.settings?.modules?.[type] || null;
  const dateText = value => value ? new Date(value).toLocaleString(isEnglish() ? 'en-AU' : 'zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : tr('未设置日期', 'No date');
  const taskProgress = tasks => tasks.length ? Math.round(tasks.filter(task => task.status === 'done').length / tasks.length * 100) : 0;
  async function request(url, options) { const response = await fetch(url, options); const payload = await response.json().catch(() => ({})); if (!response.ok || payload.error) throw new Error(payload.error || `Request failed (${response.status})`); return payload; }
  window.NorthstarPlannerShared = { escapeHtml, tr, categoryId, categoryFromPage, categoryText, moduleCategory, setData, dateText, taskProgress, request };
}());
