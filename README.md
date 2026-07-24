# 小雅·师说 刷课助手 (XiaoYa Study Assistant)

[![Tampermonkey](https://img.shields.io/badge/Tampermonkey-✓-brightgreen)](https://www.tampermonkey.net/)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.2.0-orange)](xiaoya-study-assistant.user.js)

> 小雅智能教学平台（ai-augmented.com）自动化刷课 Tampermonkey 油猴脚本。
>
> 支持华中师范大学、武汉理工大学、南开大学等所有使用小雅平台的高校。

## ✨ 功能

| 功能 | 说明 |
|------|------|
| 🎯 **全自动** | 启动后无需任何操作，自动遍历课程所有视频 |
| 📚 **通用适配** | 任意课程、任意学校均可使用，自动获取课程结构 |
| ▶️ **自动播放** | 进入视频页面自动开始播放 |
| ⏩ **倍速控制** | 支持 1x ~ 5x 可调倍速，默认 2x |
| ⏭️ **自动切集** | 视频结束后自动切换到下一个 |
| 📂 **遍历文件夹** | 自动遍历所有包含视频的文件夹 |
| 🛡️ **防离开暂停** | 最小化/切屏/失去焦点均不会暂停 |
| 💓 **保活机制** | AudioContext + 200ms 保活定时器，浏览器后台也不停 |
| 📝 **弹题检测** | 自动检测并关闭视频播放中的弹窗题目 |
| 🔇 **静音播放** | 自动静音，不打扰 |
| 💾 **进度保存** | 刷新页面后自动恢复进度 |
| 🔄 **进度重置** | 可一键重置从头开始 |
| 📊 **控制面板** | 浮窗控制面板，可拖拽可折叠 |

## 📦 安装

### 前置条件
- 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展（支持 Chrome/Edge/Firefox）

### 安装脚本

**方法一：直接安装（推荐）**
1. 点击 [xiaoya-study-assistant.user.js](https://github.com/Nathan1Jose/xiaoya-study-assistant/raw/main/xiaoya-study-assistant.user.js)
2. Tampermonkey 会自动弹出安装页面
3. 点击「安装」

**方法二：手动安装**
1. 打开 [xiaoya-study-assistant.user.js](xiaoya-study-assistant.user.js)
2. 复制全部代码
3. 点击 Tampermonkey 图标 → 「添加新脚本」
4. 粘贴代码 → `Ctrl+S` 保存

## 🚀 使用

1. 登录小雅平台，进入任意课程页面
2. 页面右上角会出现 **深色浮窗控制面板**
3. 点击 **「▶ 开始」** 启动自动刷课
4. 脚本会自动：
   - 从第一个文件夹的第一个视频开始
   - 以 **2x 倍速** 播放视频
   - 视频结束后自动切到下一集
   - 文件夹内所有视频刷完后自动进入下一个文件夹
   - 全部完成后弹出通知

### 控制面板

```
┌─────────────────────────────┐
│ 📺 小雅刷课     [就绪] [−]  │  ← 可拖拽标题栏
├─────────────────────────────┤
│ 📂 当前：1/6 经济思想...    │  ← 实时进度
│ 🎬 视频：经济思想-第一节    │
│ 📊 进度：3 / 20             │
│ ████████████░░░░░ 65%      │  ← 播放进度条
│ 10:30 / 28:00     65%      │
│ ⏩ 倍速：1x 1.5x [2x] 3x   │
│ 🛡️ 防离开   🔇 静音        │
│ [▶ 开始] [⏹ 停止]          │
│ [⏭ 跳过] [🔄 重置] [自动]  │
└─────────────────────────────┘
```

## 🛡️ 防检测机制

脚本采用 **4 层嵌套防护** 应对平台检测：

| 层级 | 机制 | 说明 |
|:----:|------|------|
| **0** | `staticInstall()` | `@run-at document-start` 第一时间劫持 visibility API |
| **1** | 事件拦截 | 捕获阶段阻止 `visibilitychange` / `blur` 传播 |
| **2** | `pause()` 劫持 | 重写 `HTMLMediaElement.prototype.pause` 阻止暂停 |
| **3** | AudioContext | 后台播放静音音频，防止浏览器冻结标签页 |
| **💓** | 200ms 保活 | 每 200ms 检查视频状态，意外暂停立即恢复 |

## 🔧 技术原理

### 课程结构获取
脚本自动调用小雅平台内部 API：
```
GET /api/jx-iresource/resource/queryCourseResources/v2?group_id={课程ID}
```
从 cookie 读取认证 token，解析 JSON 构建文件夹 → 视频树形结构。
如果 API 失败，自动降级为从页面 DOM 解析。

### 自动播放流程
1. 加载课程数据 → 定位到第一个未完成的视频
2. 等待视频元素加载 → 设置倍速（2x）→ 自动播放
3. 监听 `ended` 事件 → 通过 URL 导航到下一个视频
4. 文件夹完成 → 导航到下一个文件夹
5. 全部完成 → 弹出通知

## 📁 项目结构

```
xiaoya-study-assistant/
├── xiaoya-study-assistant.user.js  # 主脚本（Tampermonkey）
├── README.md                       # 本文件
├── LICENSE                         # MIT 许可证
└── .gitignore
```

## ⚠️ 注意事项

- 视频无法自动播放时，先**点击页面任意位置**再点「开始」
- 建议保持浏览器窗口在前台运行（虽然防离开已启用，但部分学校可能有额外检测）
- 如遇问题，请提交 [Issue](https://github.com/Nathan1Jose/xiaoya-study-assistant/issues)

## 📄 许可证

[MIT License](LICENSE)
