export const TODO_PAGE_SIZE = 6;
const OWNER_PAGE_SIZE = 3;
const dark = { background: '#171e26', header: '#1d2732', text: '#e2e8ed', muted: '#9ba9b9', green: '#93bba8', button: '#294c40' };
const darkText = (text, extra = {}) => ({ type: 'text', text, wrap: true, size: 'sm', color: dark.text, ...extra });

function ownerPages(tasks) {
  const groups = new Map();
  for (const task of tasks) {
    const key = task.ownerId || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }
  const pages = [];
  for (const group of groups.values()) {
    for (let offset = 0; offset < group.length; offset += OWNER_PAGE_SIZE) {
      pages.push({ group, tasks: group.slice(offset, offset + OWNER_PAGE_SIZE) });
    }
  }
  return pages.length ? pages : [{ group: [], tasks: [] }];
}

function buildOwnerBubble({ group, tasks }, { date, title, templates, page, totalPages }) {
  const owner = group[0]?.ownerId ? `${group[0].ownerName || '負責人'}的工作` : '待指派工作';
  const completed = group.filter(task => task.status === '已完成').length;
  return {
    type: 'bubble', size: 'mega',
    header: { type: 'box', layout: 'vertical', spacing: 'md', backgroundColor: dark.header, contents: [
      darkText(`${date} / ${title}`, { size: 'xs', color: dark.muted }),
      darkText(group.length ? owner : title, { size: 'xl', weight: 'bold' }),
      darkText(templates ? `固定工作 ${group.length} 項` : `負責 ${group.length} 項  /  已完成 ${completed} 項`, { size: 'xs', color: dark.green }),
      ...(!templates && group.length ? [{ type: 'box', layout: 'horizontal', height: '4px', backgroundColor: '#34414b', contents: [
        ...(completed ? [{ type: 'box', layout: 'vertical', flex: completed, backgroundColor: '#6b9f8b', contents: [] }] : []),
        ...(completed < group.length ? [{ type: 'box', layout: 'vertical', flex: group.length - completed, contents: [] }] : [])
      ] }] : [])
    ] },
    body: { type: 'box', layout: 'vertical', spacing: 'lg', backgroundColor: dark.background, contents: tasks.length ? tasks.map(task => {
      const status = templates ? (task.enabled === '是' ? '已啟用' : '已停用') : task.status === '已完成' ? '✓ 已完成' : task.ownerId ? '未完成' : '待指派';
      return { type: 'box', layout: 'horizontal', spacing: 'md', contents: [
        { type: 'box', layout: 'vertical', flex: 1, spacing: 'sm', contents: [
          darkText(task.title, { size: 'md', weight: 'bold' }),
          darkText(status, { size: 'xs', color: task.status === '已完成' ? dark.green : dark.muted }),
          ...(!templates && task.date < date && task.status !== '已完成' ? [darkText(`先前未完成 · ${task.date}`, { size: 'xs', color: '#d5b37b' })] : [])
        ] },
        ...(!templates && task.ownerId && task.status === '未完成' ? [{
          type: 'button', style: 'primary', height: 'sm', flex: 0, color: dark.button,
          action: { type: 'postback', label: '✓ 完成', data: `todo:complete:${task.id}` }
        }] : [])
      ] };
    }) : [darkText('目前沒有待辦事項。', { color: dark.muted })] },
    footer: { type: 'box', layout: 'vertical', backgroundColor: dark.background, contents: [
      darkText(`${totalPages > 1 ? '左右滑動查看其他工作 · ' : ''}${page} / ${totalPages}`, { size: 'xs', color: dark.muted })
    ] }
  };
}

// LINE allows up to 12 bubbles and 50 KB per carousel. Leave room below the limit.
export function buildTodoCarousel(tasks, { date, title = '今日待辦', page = 1, templates = false }) {
  const pages = ownerPages(tasks);
  const totalPages = pages.length;
  const start = Math.max(1, Math.min(page, totalPages));
  const bubbles = [];
  for (let current = start; current <= totalPages && bubbles.length < 12; current += 1) {
    const bubble = buildOwnerBubble(pages[current - 1], {
      date, title, page: current, totalPages, templates
    });
    const candidate = { type: 'carousel', contents: [...bubbles, bubble] };
    if (bubbles.length && Buffer.byteLength(JSON.stringify(candidate), 'utf8') > 48000) break;
    bubbles.push(bubble);
  }
  const last = start + bubbles.length - 1;
  const command = templates ? '固定待辦' : '今日待辦';
  return {
    type: 'flex', altText: `${title} ${date}（${start === last ? start : `${start}-${last}`}/${totalPages}）`,
    contents: bubbles.length === 1 ? bubbles[0] : { type: 'carousel', contents: bubbles },
    ...(last < totalPages ? { quickReply: { items: [{
      type: 'action', action: { type: 'message', label: '載入更多待辦', text: `${command} ${last + 1}` }
    }] } } : {})
  };
}

export function buildTodoPage(tasks, { date, title = '今日待辦', page = 1, totalPages = 1, templates = false }) {
  const text = (value, extra = {}) => ({ type: 'text', text: value, wrap: true, size: 'sm', ...extra });
  const contents = tasks.map((task) => ({
    type: 'box', layout: 'vertical', spacing: 'sm', margin: 'lg',
    contents: [
      text(`${templates ? (task.enabled === '是' ? '📋' : '停用') : (task.status === '已完成' ? '✅' : '□')} ${task.title}`, { weight: 'bold' }),
      text(`負責人：${task.ownerName || '待指派'}`),
      text(`${task.id}${!templates && task.date < date ? `｜先前未完成 ${task.date}` : ''}`, { size: 'xs', color: '#666666' }),
      ...(!templates && task.status === '未完成' && task.ownerId ? [{
        type: 'button', height: 'sm', style: 'primary', color: '#06c755',
        action: { type: 'postback', label: '✅ 完成', data: `todo:complete:${task.id}` }
      }] : [])
    ]
  }));
  const command = templates ? '固定待辦' : '今日待辦';
  const navigation = [];
  if (page > 1) navigation.push({ type: 'action', action: { type: 'message', label: '上一頁', text: `${command} ${page - 1}` } });
  if (page < totalPages) navigation.push({ type: 'action', action: { type: 'message', label: '下一頁', text: `${command} ${page + 1}` } });
  return {
    type: 'flex', altText: `${title} ${date}（${page}/${totalPages}）`,
    contents: {
      type: 'bubble', size: 'mega',
      body: { type: 'box', layout: 'vertical', contents: [
        text(`${title}｜${date}`, { weight: 'bold', size: 'lg' }),
        text(`第 ${page} / ${totalPages} 頁`),
        ...(contents.length ? contents : [text('目前沒有待辦事項。')])
      ] }
    },
    ...(navigation.length ? { quickReply: { items: navigation } } : {})
  };
}

export function buildTodoCompletion(task) {
  const text = (value, extra = {}) => darkText(value, extra);
  const completedAt = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(new Date(task.completedAt));
  return {
    type: 'flex', altText: `✅ 已完成：${task.title}`,
    contents: {
      type: 'bubble', body: { type: 'box', layout: 'vertical', spacing: 'md', backgroundColor: dark.background, contents: [
        text('✅ 已完成', { size: 'xl', weight: 'bold', color: dark.green }),
        text(task.title, { weight: 'bold' }),
        text(`負責人：${task.ownerName}`, { size: 'sm' }),
        text(`工作日期：${task.date}\n完成時間：${completedAt}`, { size: 'sm' }),
        text('已儲存完成紀錄。原清單不會自動更新，請按下方查看最新狀態。', { size: 'xs', color: dark.muted })
      ] },
      footer: { type: 'box', layout: 'vertical', backgroundColor: dark.background, contents: [{
        type: 'button', style: 'primary', color: dark.button,
        action: { type: 'message', label: '查看最新待辦', text: '今日待辦' }
      }] }
    }
  };
}
