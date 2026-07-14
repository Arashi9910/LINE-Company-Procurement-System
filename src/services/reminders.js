function taipeiDateKey(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export async function runReminders({ repository, messenger, at = new Date(), pendingAfterHours = 24 }) {
  const [candidates, fallbackGroupId] = await Promise.all([
    repository.listReminderCandidates({ at, pendingAfterHours }),
    repository.getNotificationGroupId()
  ]);
  const dateKey = taipeiDateKey(at);
  const sent = [];

  for (const candidate of candidates) {
    const groupId = candidate.groupId || fallbackGroupId;
    if (!groupId) continue;
    const key = `reminder-${dateKey}-${candidate.kind}-${candidate.requestId}`;
    const reserved = await repository.reserveReminder({
      key,
      requestId: candidate.requestId,
      at,
      summary: candidate.kind === 'pending' ? '待確認超過門檻' : '逾期未到貨'
    });
    if (!reserved) continue;
    await messenger.pushReminder(groupId, candidate);
    sent.push({ requestId: candidate.requestId, kind: candidate.kind });
  }

  return { candidates: candidates.length, sent };
}
