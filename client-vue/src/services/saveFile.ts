import { isTauri } from '@tauri-apps/api/core';

/** 返回 false 表示用户取消保存；失败交给调用方提示，保留录制内容供重试。 */
export async function saveFile(blob: Blob, filename: string): Promise<boolean> {
  if (isTauri()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const mp4 = blob.type.includes('mp4');
    const path = await save({
      defaultPath: filename,
      filters: [{ name: mp4 ? 'MP4 视频' : 'WebM 视频', extensions: [mp4 ? 'mp4' : 'webm'] }],
    });
    if (!path) return false;
    const { writeFile } = await import('@tauri-apps/plugin-fs');
    // dialog 插件只为用户选中的路径授权，无需向 WebView 开放整个文件系统。
    await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    return true;
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
