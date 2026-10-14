# 项目图标

当前界面使用 Iconfont「nearlink」项目导出的本地字体。

- 项目：https://www.iconfont.cn/manage/index?manage_type=myprojects&projectId=5242382
- 字体：iconfont.woff2、iconfont.woff、iconfont.ttf
- 图标样式及类名：iconfont.css

使用 `<i class="iconfont icon-dianhua" aria-hidden="true"></i>`，类名以下载包的 iconfont.css 为准。
入口 main.ts 直接引入此目录的 iconfont.css，CSS 使用同目录的字体文件。纯图标按钮须提供 aria-label。

更新时将同一次下载的 Iconfont 文件整包复制或剪切到此目录并覆盖，确保 iconfont.css 与字体文件同时更新，无需修改入口或字体路径。保留本说明和 LICENSE。
下载包附带的 demo、JS 和 JSON 不由应用入口加载。此目录已排除 Prettier，保留下载包原始格式；项目自定义样式放在组件或 src/style 中，避免更新时被覆盖。
挂断图标已为横向，不需要额外旋转。Naive UI 内置图标仍由组件库管理，动态语音波形由组件绘制。

public/favicon.svg 仍采用 Remix Icon v4.6.0 的 computer-line 字形。
LICENSE 为此 favicon 素材的 Apache-2.0 授权，不代表 Iconfont 商城图标的授权。
商城图标来源及授权以 Iconfont 项目和原作者说明为准。

项目控件尺寸和历史业务类名映射由 `src/style/icons.css` 维护，在下载包之后加载；不要将其复制到下载包中。新增原始类名可直接使用，替换下载包不会覆盖项目样式。
