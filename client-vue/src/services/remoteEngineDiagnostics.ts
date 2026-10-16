/** Native codes only; never render native paths, process output or credentials. */
export function engineReadinessMessage(reason: string | undefined): string {
  const descriptions: Record<string, string> = {
    REMOTE_ENGINE_PROBE_TIMEOUT: '引擎启动检查超时。请等待 5 秒后点击“刷新可用状态”重试。',
    REMOTE_ENGINE_PROBE_REJECTED: '引擎未完成启动握手，可能已提前退出。请检查安装包启动诊断。',
    REMOTE_IPC_CLOSED: '引擎启动通信已关闭，可能已提前退出。请等待 5 秒后刷新重试。',
    REMOTE_SIDECAR_SPAWN_FAILED: '无法启动包内引擎，请检查文件是否存在、被隔离或访问受限。',
    REMOTE_ENGINE_MANIFEST_CHANGED: '安装包与引擎清单不匹配，请完整重装同一版本。',
    REMOTE_ENGINE_CONTENT_CHANGED: '引擎文件内容校验失败，请检查安装文件是否被替换或损坏。',
    REMOTE_ENGINE_UNLISTED_RESOURCE: '引擎目录出现安装清单之外的文件或目录，请检查安装目录。',
    REMOTE_ENGINE_RESOURCE_UNREADABLE: '引擎资源无法读取，可能缺失、被占用或访问受限。',
    REMOTE_ENGINE_RESOURCE_UNSAFE: '引擎文件类型、链接或权限不符合安装要求。',
    REMOTE_ENGINE_BUNDLE_REJECTED: '引擎资源完整性检查未通过，请检查安装包诊断。',
  };
  const code = reason && /^[A-Z][A-Z_]{1,80}$/.test(reason) ? reason : 'REMOTE_ENGINE_NOT_READY';
  return `${descriptions[code] ?? '本机远控引擎未就绪，请等待 5 秒后刷新重试；若仍失败，请保留错误码进行诊断。'}（${code}）`;
}
