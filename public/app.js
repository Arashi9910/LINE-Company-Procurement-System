const status = document.querySelector('#status');

try {
  const response = await fetch('/api/config');
  if (!response.ok) throw new Error('設定載入失敗');
  const config = await response.json();
  status.textContent = config.liffId
    ? '系統已就緒，正在連接 LINE…'
    : '系統骨架已就緒，等待設定 LIFF。';
} catch (error) {
  status.textContent = error.message;
}
