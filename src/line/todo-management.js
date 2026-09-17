const text = (value, extra = {}) => ({ type: 'text', text: value, wrap: true, color: '#e2e8ed', size: 'sm', ...extra });
export const todoButton = (label, data) => ({ type: 'button', height: 'sm', style: 'primary', color: '#294c40', margin: 'sm', action: { type: 'postback', label, data: `todo:ui:${data}` } });
export function todoPanel(title, contents, buttons = []) {
  return { type: 'flex', altText: title, contents: { type: 'bubble', size: 'mega',
    body: { type: 'box', layout: 'vertical', spacing: 'md', backgroundColor: '#171e26', contents: [text(title, { weight: 'bold', size: 'lg' }), ...contents] },
    ...(buttons.length ? { footer: { type: 'box', layout: 'vertical', backgroundColor: '#171e26', contents: buttons } } : {})
  } };
}
export function buildTodoMenu(admin) {
  return todoPanel('待辦選單', [text('請選擇要進行的操作。')], [
    todoButton('今日待辦', 'list:all'), todoButton('我的待辦', 'list:mine'),
    todoButton('撤回完成', 'tasks:reopen:1'),
    ...(admin ? [todoButton('管理今日工作', 'tasks:t:1'), todoButton('管理固定工作', 'tasks:f:1')] : []),
    todoButton('取消目前操作', 'cancel')
  ]);
}
function slicePage(items, page, size = 6) {
  const total = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(Math.max(1, page || 1), total);
  return { items: items.slice((current - 1) * size, current * size), current, total };
}
export function buildTaskPicker(tasks, mode, page) {
  const batch = slicePage(tasks, page);
  const contents = batch.items.map(task => ({ type: 'box', layout: 'vertical', spacing: 'sm', contents: [
    text(task.title, { weight: 'bold' }), text(`${task.ownerName || '待指派'}${task.date ? ` · ${task.date}` : ''}`, { size: 'xs', color: '#9ba9b9' }),
    ...(mode === 'reopen' ? [todoButton('撤回完成', `begin:reopen:t:${task.id}`)] : [
      todoButton('修改名稱', `begin:rename:${mode}:${task.id}`), todoButton('指派負責人', `begin:assign:${mode}:${task.id}`)
    ])
  ] }));
  return todoPanel(mode === 'reopen' ? '選擇要撤回的工作' : mode === 'f' ? '管理固定工作' : '管理今日工作', [
    text(`第 ${batch.current} / ${batch.total} 頁`, { size: 'xs' }),
    ...(contents.length ? contents : [text('目前沒有符合的工作。')])
  ], [
    ...(batch.current > 1 ? [todoButton('上一批', `tasks:${mode}:${batch.current - 1}`)] : []),
    ...(batch.current < batch.total ? [todoButton('下一批', `tasks:${mode}:${batch.current + 1}`)] : []),
    todoButton('回待辦選單', 'menu')
  ]);
}
export function buildOwnerPicker(members, token, page) {
  const batch = slicePage(members, page, 8);
  return todoPanel('選擇負責人', [text('只列出已啟用的授權成員。'), text(`第 ${batch.current} / ${batch.total} 頁`, { size: 'xs' })], [
    todoButton('待指派', `owner:${token}:pending`),
    ...batch.items.map(member => todoButton(member.name.slice(0, 35), `owner:${token}:${member.id}`)),
    ...(batch.current > 1 ? [todoButton('上一批', `owners:${token}:${batch.current - 1}`)] : []),
    ...(batch.current < batch.total ? [todoButton('下一批', `owners:${token}:${batch.current + 1}`)] : []),
    todoButton('取消', `cancel:${token}`)
  ]);
}
export function buildRenamePrompt(target, token) {
  return todoPanel('修改工作名稱', [text(target.title, { weight: 'bold' }), text('請輸入「改名 新名稱」。例如：改名 整理新品照片'), text('本次操作限發起者，10 分鐘內有效。', { size: 'xs', color: '#9ba9b9' })], [todoButton('取消', `cancel:${token}`)]);
}
export function buildEditConfirmation(target, draft, token) {
  const detail = draft.action === 'rename' ? `新名稱：${draft.title}` : draft.action === 'assign' ? `新負責人：${draft.ownerName || '待指派'}` : '將恢復為未完成，清除本次完成時間。';
  return todoPanel('確認變更', [text(target.title, { weight: 'bold' }), text(detail),
    ...(draft.templates ? [text('固定工作變更影響之後產生的清單；今天的工作需另外修改。', { size: 'xs', color: '#9ba9b9' })] : [])
  ], [todoButton('確認儲存', `confirm:${token}`), todoButton('取消', `cancel:${token}`)]);
}
