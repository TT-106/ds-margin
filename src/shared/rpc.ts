export async function rpc<T>(action: string, data?: unknown): Promise<T> {
  let response: { ok: boolean; value?: T; error?: string };
  try { response = await chrome.runtime.sendMessage({ source: 'ds-margin', action, data }); }
  catch { throw new Error('扩展连接已更新或中断，请刷新 DeepSeek 页面后重试'); }
  if (!response?.ok) {
    if (action.startsWith('side.') && response?.error === '未知操作') {
      throw new Error('旁问后台仍是旧版。请在 chrome://extensions/ 重新加载「DS Margin · 留白」，再刷新 DeepSeek。');
    }
    throw new Error(response?.error ?? '操作未完成');
  }
  return response.value as T;
}
