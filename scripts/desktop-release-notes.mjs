import { pathToFileURL } from 'node:url';

export function desktopReleaseNotes(repository, version) {
  const base = `https://github.com/${repository}/releases/download/desktop-v${version}`;
  return `## 下载 ToDesk 内测版 ${version}

请按电脑系统选择安装包，点击下方对应的下载链接：

| 你的电脑 | 下载入口 | 安装方式 |
| --- | --- | --- |
| Windows 电脑（64 位 Intel / AMD） | [下载 Windows 安装包（.exe）](${base}/ToDesk_${version}_x64-setup.exe) | 双击安装程序 |
| Mac（Apple 芯片，M 系列） | [下载 macOS 安装包 · Apple 芯片（.dmg）](${base}/ToDesk_${version}_aarch64.dmg) | 打开后将 ToDesk 拖入“应用程序” |
| Mac（Intel 芯片） | [下载 macOS 安装包 · Intel 芯片（.dmg）](${base}/ToDesk_${version}_x64.dmg) | 打开后将 ToDesk 拖入“应用程序” |

**不确定 Mac 的芯片？** 点击屏幕左上角苹果菜单 →“关于本机”：显示 Apple M 系列芯片请选择“Apple 芯片”；显示 Intel 处理器请选择“Intel 芯片”。Mac 需要 macOS 12 或更新版本。

**请不要下载 Source code (zip) / Source code (tar.gz) 来安装。** 它们是供开发者使用的源码压缩包。SHA256SUMS.txt 是校验文件，也不是安装包。

## 安装说明

当前 Windows 安装包未签名，macOS 使用临时签名、未经过 Apple 公证，首次打开可能被系统拦截。
安装包连接构建时配置的在线服务；本次发布不包含应用内自动更新。
可使用 [SHA256SUMS.txt](${base}/SHA256SUMS.txt) 校验下载文件。

## 远程控制能力说明

本 Release 的通用安装包未内置实验性原生远控引擎，不能作为已验收的被控端使用；远控入口仍受实际能力和服务器授权限制。本地带引擎的测试安装包与这里的通用安装包不同，请勿用本 Release 覆盖正在进行远控验收的安装包。

${version === '0.5.0-beta.11' ? `本次源码修复了采屏 45 秒和引擎 60 秒的固定退出限制，以及过期输入导致整场协助中断的问题；增加停止原因诊断。带引擎的 macOS Apple 芯片测试包已持续运行超过 3 分 40 秒，跨电脑实际操作和 30 分钟稳定性仍待验收。\n` : ''}
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { GH_REPO, RELEASE_VERSION } = process.env;
  if (!GH_REPO || !RELEASE_VERSION) throw new Error('缺少 GH_REPO 或 RELEASE_VERSION');
  process.stdout.write(desktopReleaseNotes(GH_REPO, RELEASE_VERSION));
}
