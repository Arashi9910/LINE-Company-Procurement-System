export const TODO_PAGE_SIZE = 6;

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
