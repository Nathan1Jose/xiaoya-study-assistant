# 小雅刷课助手 (XiaoYa Study Assistant)

[![Tampermonkey](https://img.shields.io/badge/Tampermonkey-✓-brightgreen)](https://www.tampermonkey.net/)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.2.0-orange)](xiaoya-study-assistant.user.js)

> 小雅智能教学平台（ai-augmented.com）自动化刷课  | Tampermonkey 油猴无脑安装。
>
> 支持ccnu , whut等所有使用小雅平台的高校。

## 功能

✅ 自动播放视频　✅ 倍速控制 (1x~5x)　✅ 自动切集
✅ 遍历文件夹　　✅ 防离开暂停　　　　✅ 弹题检测
✅ 静音播放　　　✅ 进度保存/恢复　　✅ 控制面板

## 安装

打开 [xiaoya-study-assistant.user.js](https://github.com/Nathan1Jose/xiaoya-study-assistant/raw/main/xiaoya-study-assistant.user.js)，Tampermonkey 会自动识别安装。

## 使用

1. 登录小雅，进入课程页面
2. 右上角控制面板点击 **「▶ 开始」**
3. 脚本自动从第一个视频开始播放，直到全部完成

## 技术

- 调用小雅内部 API 自动获取课程结构，通用适配所有课程
- 4 层防检测：visibility 劫持 → 事件拦截 → pause 劫持 → AudioContext 保活
- 200ms 保活定时器，浏览器后台也不停

## 许可证

MIT
