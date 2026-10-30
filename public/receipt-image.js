// Keep the receiving inputs intact while the user checks a larger product image.
export function receiptImage(item, imageFrame) {
  const urls = [item.variantImageUrl, item.mainImageUrl, item.listImageUrl];
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'receipt-image-button';
  button.setAttribute('aria-label', `放大圖片：${item.displayName}`);
  button.setAttribute('aria-haspopup', 'dialog');
  const frame = imageFrame(urls, item.displayName, 'receipt-image');
  const hint = document.createElement('span');
  hint.textContent = '點圖放大';
  button.append(frame, hint);
  const refresh = () => {
    button.disabled = !frame.querySelector('img');
    hint.textContent = button.disabled ? '無圖片' : '點圖放大';
  };
  // imageFrame removes failed images only after all fallback URLs are exhausted.
  const thumbnail = frame.querySelector('img');
  thumbnail?.addEventListener('error', refresh);
  refresh();
  button.addEventListener('click', () => {
    if (button.disabled) return;
    const dialog = document.createElement('dialog');
    dialog.className = 'receipt-image-dialog';
    dialog.setAttribute('aria-label', item.displayName);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'receipt-image-close';
    close.textContent = '關閉圖片';
    const caption = document.createElement('p');
    caption.textContent = item.displayName;
    const preview = imageFrame([thumbnail.currentSrc || thumbnail.src, ...urls], item.displayName, 'receipt-image-preview');
    dialog.append(close, preview, caption);
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => {
      const rect = dialog.getBoundingClientRect();
      if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right
        || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      button.focus();
    }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
  });
  return button;
}
