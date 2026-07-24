// ==UserScript==
// @name         小雅·师说 刷课助手
// @namespace    https://github.com/Nathan1Jose/xiaoya-study-assistant
// @version      1.2.0
// @description  小雅智能教学平台自动化刷课脚本 - 自动播放视频、支持倍速、自动切集、防离开暂停、自动遍历文件夹，通用适配所有课程
// @author       Nathan1Jose
// @license      MIT
// @match        *://*.ai-augmented.com/app/jx-web/mycourse/*/resource
// @match        *://*.ai-augmented.com/app/jx-web/mycourse/*/resource/*
// @match        *://*.ai-augmented.com/app/jx-web/mycourse/*/resource/*/*
// @match        *://*.ai-augmented.com/app/jx-web/mycourse/*/resource/*/*/*
// @icon         https://www.ai-augmented.com/favicon.ico
// @homepageURL  https://github.com/Nathan1Jose/xiaoya-study-assistant
// @supportURL   https://github.com/Nathan1Jose/xiaoya-study-assistant/issues
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_notification
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // ========================================
    // 课程数据 - 通过API动态获取
    // ========================================
    let COURSE_DATA = { courseId: null, folders: [] };

    /** 从API获取课程文件夹和视频结构 */
    async function fetchCourseStructure(courseId) {
        console.log('[小雅刷课] 🔄 正在获取课程结构...');
        try {
            const token = (document.cookie.match(/HS-prd-access-token=([^;]+)/) || [])[1];
            if (!token) { throw new Error('未找到认证token'); }

            const resp = await fetch('/api/jx-iresource/resource/queryCourseResources/v2?group_id=' + courseId, {
                credentials: 'same-origin',
                headers: {
                    'Accept': 'application/json',
                    'X-Requested-With': 'XMLHttpRequest',
                    'Authorization': 'Bearer ' + token
                }
            });
            const data = await resp.json();
            if (!data.success) { throw new Error(data.message || 'API请求失败'); }

            const items = data.data || [];
            const root = items.find(i => i.name === 'root' && i.type === 1);
            if (!root) { throw new Error('未找到课程根目录'); }

            const folders = items.filter(i => i.type === 1 && i.parent_id === root.id && i.name !== 'root');
            const result = {
                courseId: courseId,
                folders: folders.map(f => ({
                    id: f.id,
                    name: f.name,
                    videos: items
                        .filter(i => i.parent_id === f.id && (i.resource_type === 5 || (i.name && i.name.endsWith('.mp4'))))
                        .map(v => ({ id: v.id, name: v.name }))
                })).filter(f => f.videos.length > 0)
            };

            const total = result.folders.reduce((s, f) => s + f.videos.length, 0);
            console.log('[小雅刷课] ✅ 课程结构:', result.folders.length + '个文件夹, ' + total + '个视频');
            return result;
        } catch (e) {
            console.warn('[小雅刷课] ⚠️ API获取失败:', e.message);
            console.log('[小雅刷课] 🔄 尝试从页面DOM解析...');
            return await parseCourseFromDOM(courseId);
        }
    }

    /** 从DOM解析（API备用） */
    async function parseCourseFromDOM(courseId) {
        await Utils.sleep(3000);
        const folders = [];
        const path = Utils.getPathParts();

        // 如果在文件夹视图
        if (path && path.folderId) {
            const items = document.querySelectorAll('.node-item');
            const videos = [];
            items.forEach((item, idx) => {
                const icon = item.querySelector('use');
                const title = item.querySelector('.node-inner')?.textContent?.trim();
                if (title && icon?.getAttribute('xlink:href') === '#icon-shipin') {
                    videos.push({ id: 'dom_' + idx, name: title });
                }
            });
            const folderName = document.querySelector('.sider_title')?.textContent?.trim() || '课程内容';
            folders.push({ id: path.folderId, name: folderName, videos });
        }

        console.log('[小雅刷课] DOM解析结果:', folders.length + '个文件夹');
        return { courseId, folders };
    }

    /** 加载课程数据（优先缓存，再API） */
    async function loadCourseData() {
        const courseId = Utils.getCourseId();
        if (!courseId) return false;

        try {
            const cached = GM_getValue('xiaoya_course_' + courseId);
            if (cached) {
                const parsed = JSON.parse(cached);
                if (parsed.folders && parsed.folders.length > 0) {
                    COURSE_DATA = parsed;
                    console.log('[小雅刷课] ✅ 使用缓存课程结构');
                    return true;
                }
            }
        } catch (e) {}

        const data = await fetchCourseStructure(courseId);
        if (data && data.folders && data.folders.length > 0) {
            COURSE_DATA = data;
            try { GM_setValue('xiaoya_course_' + courseId, JSON.stringify(data)); } catch (e) {}
            return true;
        }
        return false;
    }

    // ========================================
    // 配置
    // ========================================
    const CONFIG = {
        defaultSpeed: 2.0,
        speeds: [1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0],
        autoPlayDelay: 1500,
        nextVideoDelay: 2000,
        /** 防暂停保活间隔(ms) */
        keepAliveInterval: 2000,
        /** 启用防浏览器离开暂停 */
        antiPause: true,
        /** 静音播放（避免打扰） */
        muted: true,
        /** 视频加载超时(ms) */
        videoLoadTimeout: 120000,
        /** 视频弹出题检测间隔(ms) */
        quizCheckInterval: 3000,
    };

    // ========================================
    // 状态
    // ========================================
    const State = {
        running: false,
        speed: GM_getValue('xiaoya_speed', CONFIG.defaultSpeed),
        autoNext: GM_getValue('xiaoya_autoNext', true),
        currentFolderIndex: -1,
        currentVideoIndex: -1,
        panel: null,
        videoEndedListener: null,
        timeUpdateListener: null,
        progressTimer: null,
    };

    // ========================================
    // 工具函数
    // ========================================
    const Utils = {
        sleep: ms => new Promise(r => setTimeout(r, ms)),

        getCourseId() {
            return window.location.pathname.match(/\/mycourse\/(\d+)/)?.[1] || null;
        },

        getPathParts() {
            const parts = window.location.pathname.split('/');
            const idx = parts.indexOf('resource');
            if (idx === -1) return null;
            return {
                courseId: parts[idx - 1],
                folderId: parts[idx + 1] || null,
                resourceId: parts[idx + 2] || null,
            };
        },

        getVideoElement() {
            return document.querySelector('video');
        },

        /** 获取当前页码对应的文件夹和视频索引 */
        getCurrentPosition() {
            const path = this.getPathParts();
            if (!path || !path.resourceId) return null;
            for (let fi = 0; fi < COURSE_DATA.folders.length; fi++) {
                const folder = COURSE_DATA.folders[fi];
                for (let vi = 0; vi < folder.videos.length; vi++) {
                    if (folder.videos[vi].id === path.resourceId) {
                        return { folderIndex: fi, videoIndex: vi };
                    }
                }
            }
            return null;
        },

        /** 获取侧边栏中当前选中的视频标题 */
        getCurrentVideoTitle() {
            const sel = document.querySelector('.node-selected');
            if (sel) {
                return sel.querySelector('.node-inner')?.textContent?.trim() || '';
            }
            return '';
        },

        /** 格式化时间 */
        formatTime(s) {
            if (!s || isNaN(s)) return '00:00';
            const h = Math.floor(s / 3600);
            const m = Math.floor((s % 3600) / 60);
            const sec = Math.floor(s % 60);
            if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
            return `${m}:${String(sec).padStart(2, '0')}`;
        },

        /** 通过URL导航到视频（同时标记到达后自动播放） */
        navigateToVideo(folderId, videoId) {
            try { GM_setValue('xiaoya_pending_start', true); } catch (e) {}
            const base = window.location.origin;
            const path = `/app/jx-web/mycourse/${COURSE_DATA.courseId}/resource/${folderId}/${videoId}`;
            window.location.href = base + path;
        },

        /** 通过URL导航到文件夹（标记到达后自动播放） */
        navigateToFolder(folderId) {
            try { GM_setValue('xiaoya_pending_start', true); } catch (e) {}
            const base = window.location.origin;
            const path = `/app/jx-web/mycourse/${COURSE_DATA.courseId}/resource/${folderId}`;
            window.location.href = base + path;
        },
    };

    // ========================================
    // 防浏览器离开暂停模块（增强版）
    // ========================================
    const AntiPause = {
        keepAliveTimer: null,
        /** AudioContext 实例（防止浏览器冻结标签页） */
        audioCtx: null,
        /** 是否已安装防护 */
        installed: false,

        /** 立即执行的静态防护（在页面脚本运行前生效） */
        staticInstall() {
            if (typeof document === 'undefined') return;

            // 1. 劫持所有 visibility 相关 API
            try {
                const props = {
                    hidden: { get: () => false },
                    visibilityState: { get: () => 'visible' },
                    webkitHidden: { get: () => false },
                    webkitVisibilityState: { get: () => 'visible' },
                    mozHidden: { get: () => false },
                    mozVisibilityState: { get: () => 'visible' },
                    msHidden: { get: () => false },
                    msVisibilityState: { get: () => 'visible' },
                };
                for (const [key, desc] of Object.entries(props)) {
                    try {
                        Object.defineProperty(document, key, { ...desc, configurable: false });
                    } catch (e) {}
                }
            } catch (e) {}

            // 2. 在捕获阶段阻止所有离开相关事件
            try {
                const blockEvent = (e) => e.stopImmediatePropagation();
                document.addEventListener('visibilitychange', blockEvent, true);
                document.addEventListener('webkitvisibilitychange', blockEvent, true);
                document.addEventListener('mozvisibilitychange', blockEvent, true);
                document.addEventListener('msvisibilitychange', blockEvent, true);
                window.addEventListener('blur', blockEvent, true);
                window.addEventListener('pagehide', blockEvent, true);
                window.addEventListener('focus', blockEvent, true);
            } catch (e) {}

            // 3. 劫持 video.pause() — 让平台永远无法主动暂停
            try {
                const origPause = HTMLMediaElement.prototype.pause;
                HTMLMediaElement.prototype.pause = function () {
                    // 如果是用户手动点击暂停按钮，查看播放状态
                    // 但我们简单粗暴：只要脚本运行中就阻止 pause
                    try {
                        if (window.__XY_AUTO_RUNNING__) {
                            return;
                        }
                    } catch(e) {}
                    return origPause.call(this);
                };
            } catch (e) {}
        },

        /** 完整安装（需在 DOM 就绪后调用） */
        install() {
            if (this.installed) return;
            this.installed = true;
            if (!CONFIG.antiPause) return;

            console.log('[小雅刷课] 🛡️ 安装防暂停保护');

            // 启动 AudioContext 防止浏览器冻结标签页
            this.startAudioContext();

            // 设置全局运行标记
            try { window.__XY_AUTO_RUNNING__ = false; } catch(e) {}

            console.log('[小雅刷课] 🛡️ 防暂停保护安装完成');
        },

        /** 启动 AudioContext 防止浏览器冻结定时器 */
        startAudioContext() {
            try {
                // 创建 AudioContext（部分浏览器需要用户交互后才允许）
                const AudioContextClass = window.AudioContext || window.webkitAudioContext;
                if (!AudioContextClass) return;

                this.audioCtx = new AudioContextClass();
                // 创建一个静音振荡器并持续播放
                const oscillator = this.audioCtx.createOscillator();
                const gain = this.audioCtx.createGain();
                gain.gain.value = 0.001; // 几乎静音
                oscillator.connect(gain);
                gain.connect(this.audioCtx.destination);
                oscillator.start();

                // 如果 AudioContext 被挂起，尝试恢复
                if (this.audioCtx.state === 'suspended') {
                    this.audioCtx.resume();
                }

                // 定期保持 AudioContext 活跃
                this._audioKeepAlive = setInterval(() => {
                    try {
                        if (this.audioCtx && this.audioCtx.state === 'suspended') {
                            this.audioCtx.resume();
                        }
                    } catch(e) {}
                }, 5000);

                console.log('[小雅刷课] ✅ AudioContext 保活已启动');
            } catch (e) {
                console.log('[小雅刷课] ⚠️ AudioContext 启动失败:', e.message);
            }
        },

        /** 设置/清除运行标记（由 Engine 调用） */
        setRunning(running) {
            try { window.__XY_AUTO_RUNNING__ = running; } catch(e) {}
        },

        /** 启动保活定时器 */
        startKeepAlive() {
            this.stopKeepAlive();
            this.setRunning(true);
            if (!CONFIG.antiPause) return;

            console.log('[小雅刷课] 💓 启动保活定时器 (200ms)');

            // 使用非常短的间隔（200ms）来对抗浏览器的后台节流
            this.keepAliveTimer = setInterval(() => {
                const video = Utils.getVideoElement();
                if (!video) return;

                // 1. 同步运行标记
                this.setRunning(true);

                // 2. 确保倍速不被重置
                if (Math.abs(video.playbackRate - State.speed) > 0.1 && !video.paused) {
                    video.playbackRate = State.speed;
                }

                // 3. 如果视频意外暂停且不是因为结束，立刻恢复
                if (video.paused && !video.ended && video.readyState >= 2) {
                    const remaining = video.duration - video.currentTime;
                    if (remaining > 2) {
                        video.play().catch(() => {});
                    }
                }
            }, 200);

            // 额外：每 5 秒尝试唤醒定时器
            this._wakeUpTimer = setInterval(() => {
                if (!this.keepAliveTimer) {
                    this.startKeepAlive();
                }
            }, 5000);
        },

        /** 停止保活定时器 */
        stopKeepAlive() {
            this.setRunning(false);
            if (this.keepAliveTimer) {
                clearInterval(this.keepAliveTimer);
                this.keepAliveTimer = null;
            }
            if (this._wakeUpTimer) {
                clearInterval(this._wakeUpTimer);
                this._wakeUpTimer = null;
            }
            if (this._audioKeepAlive) {
                clearInterval(this._audioKeepAlive);
                this._audioKeepAlive = null;
            }
        },
    };

    // 在脚本加载时立即执行静态防护（此时 @run-at document-start 确保它比页面脚本先跑）
    AntiPause.staticInstall();
    
    // ========================================
    // 视频弹出题检测模块
    // ========================================
    const QuizDetector = {
        timer: null,
        /** 常见的弹题弹窗选择器 */
        popupSelectors: [
            '.el-dialog', '.ant-modal', '.ant-drawer', '.modal-dialog',
            '.video-quiz', '.question-overlay', '.exam-popup',
            '[class*="question"]', '[class*="quiz"]', '[class*="exam"]',
            'iframe[src*="question"]', 'iframe[src*="quiz"]',
        ],
        handled: new Set(),

        start() {
            this.stop();
            console.log('[小雅刷课] 🔍 启动弹题检测');
            this.timer = setInterval(() => this.check(), CONFIG.quizCheckInterval);
        },
        stop() {
            if (this.timer) { clearInterval(this.timer); this.timer = null; }
        },
        check() {
            if (!State.running) return;
            for (const selector of this.popupSelectors) {
                try {
                    const elements = document.querySelectorAll(selector);
                    for (const el of elements) {
                        if (this.isVisible(el) && !this.handled.has(el)) {
                            this.handled.add(el);
                            this.handleQuizPopup(el);
                        }
                    }
                } catch (e) {}
            }
            if (this.handled.size > 100) this.handled = new Set();
        },
        isVisible(el) {
            const style = window.getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden';
        },
        handleQuizPopup(popup) {
            console.log('[小雅刷课] 📝 检测到弹题窗口');

            // 优先找关闭按钮
            const closeBtn = popup.querySelector('.close, .el-dialog__closebtn, .ant-modal-close, [class*="close"]');
            if (closeBtn) { closeBtn.click(); console.log('[小雅刷课] ✅ 已关闭弹题'); return; }

            // 随机选一个选项
            const options = popup.querySelectorAll('label, .option, [class*="option"], input[type="radio"], input[type="checkbox"]');
            if (options.length > 0) {
                const pick = options[Math.floor(Math.random() * options.length)];
                if (pick.type === 'radio' || pick.type === 'checkbox') pick.checked = true;
                else pick.click();
                console.log('[小雅刷课] ✅ 已随机作答弹题');

                // 找提交按钮
                setTimeout(() => {
                    const sub = popup.querySelector('[type="submit"], button:not([disabled]), [class*="submit"], [class*="confirm"]');
                    if (sub) { sub.click(); console.log('[小雅刷课] ✅ 已提交弹题'); }
                }, 800);
            }
        },
    };

    const Engine = {
        /** 启动 */
        async start() {
            if (State.running) return;
            State.running = true;
            State.panel?.updateStatus('运行中...');

            console.log('[小雅刷课] 🚀 开始自动刷课');
            AntiPause.setRunning(true);

            // 加载课程数据（动态获取）
            const dataLoaded = await loadCourseData();
            if (!dataLoaded || COURSE_DATA.folders.length === 0) {
                console.log('[小雅刷课] ❌ 无法获取课程结构，请刷新页面重试');
                State.panel?.updateStatus('❌ 课程数据获取失败');
                State.running = false;
                return;
            }
            console.log('[小雅刷课] 📂 共 ' + COURSE_DATA.folders.length + ' 个文件夹');

            // 安装防离开暂停保护
            AntiPause.install();
            AntiPause.startKeepAlive();

            // 启动弹题检测
            QuizDetector.start();

            // 等待页面加载
            await Utils.sleep(CONFIG.autoPlayDelay);

            // 检测当前所处位置
            const pos = Utils.getCurrentPosition();
            if (pos) {
                // 已经在某个视频页面
                State.currentFolderIndex = pos.folderIndex;
                State.currentVideoIndex = pos.videoIndex;
                console.log(`[小雅刷课] 📍 当前位置: ${COURSE_DATA.folders[pos.folderIndex].name} > ${COURSE_DATA.folders[pos.folderIndex].videos[pos.videoIndex].name}`);
                State.panel?.updateFolderInfo(pos.folderIndex, pos.videoIndex);
                await this.playCurrentVideo();
            } else {
                // 不在视频页面 - 尝试进入第一个未完成的文件夹
                console.log('[小雅刷课] 📍 不在视频页面，尝试定位到第一个视频');
                const saved = this.getProgress();
                if (saved) {
                    // 继续之前的进度
                    State.currentFolderIndex = saved.folderIndex;
                    State.currentVideoIndex = saved.videoIndex;
                    console.log(`[小雅刷课] 🔄 恢复进度: ${COURSE_DATA.folders[saved.folderIndex].name} > ${COURSE_DATA.folders[saved.folderIndex].videos[saved.videoIndex].name}`);
                    this.goToVideo(saved.folderIndex, saved.videoIndex);
                } else {
                    // 从最开始
                    this.goToVideo(0, 0);
                }
            }
        },

        /** 停止 */
        stop() {
            State.running = false;
            State.panel?.updateStatus('已停止');
            this.removeVideoListeners();
            AntiPause.stopKeepAlive();
            QuizDetector.stop();
            if (State.progressTimer) {
                clearInterval(State.progressTimer);
                State.progressTimer = null;
            }
            console.log('[小雅刷课] ⏹ 已停止');
        },

        /** 播放当前视频（含错误处理和静音） */
        async playCurrentVideo() {
            if (!State.running) return;

            // 等待视频元素出现（最长2分钟）
            let video = Utils.getVideoElement();
            if (!video) {
                console.log('[小雅刷课] ⏳ 等待视频元素加载...');
                State.panel?.updateStatus('等待视频加载...');
                for (let i = 0; i < Math.ceil(CONFIG.videoLoadTimeout / 1000); i++) {
                    await Utils.sleep(1000);
                    video = Utils.getVideoElement();
                    if (video && video.readyState >= 1) break;
                }
                if (!video) {
                    console.log('[小雅刷课] ❌ 视频加载超时，跳过本视频');
                    State.panel?.updateStatus('视频超时，跳过');
                    if (State.autoNext) {
                        await Utils.sleep(3000);
                        await this.advanceToNext();
                    }
                    return;
                }
            }

            // 静音播放
            if (CONFIG.muted) {
                video.muted = true;
                video.volume = 0;
            }

            // 设置倍速
            video.playbackRate = State.speed;
            console.log(`[小雅刷课] ⏩ 倍速: ${State.speed}x | ${CONFIG.muted ? '🔇 静音' : '🔊 有声'}`);

            // 更新UI
            const folder = COURSE_DATA.folders[State.currentFolderIndex];
            const videoName = folder?.videos[State.currentVideoIndex]?.name || Utils.getCurrentVideoTitle();
            State.panel?.updateVideoInfo(videoName, video.duration || 0);
            State.panel?.updateFolderInfo(State.currentFolderIndex, State.currentVideoIndex);

            // 添加事件监听
            this.addVideoListeners(video);

            // 尝试播放（参考OCS的playMedia模式）
            const tryPlay = async () => {
                try {
                    await video.play();
                    return true;
                } catch (err) {
                    // 自动播放被阻止，尝试静音后重试
                    if (err.name === 'NotAllowedError') {
                        video.muted = true;
                        try {
                            await video.play();
                            // 如果用户已经与页面交互过，可以恢复音量
                            return true;
                        } catch (e2) {
                            return false;
                        }
                    }
                    return false;
                }
            };

            const played = await tryPlay();
            if (played) {
                console.log('[小雅刷课] ✅ 视频已开始播放');
                State.panel?.updateStatus('▶️ 播放中');
            } else {
                console.log('[小雅刷课] ⚠️ 自动播放失败，请先点击页面任意位置');
                State.panel?.updateStatus('点击页面后重试');
                // 提示用户点击页面
                const clickHandler = () => {
                    document.removeEventListener('click', clickHandler);
                    setTimeout(() => tryPlay().then(success => {
                        if (success) {
                            console.log('[小雅刷课] ✅ 用户点击后播放成功');
                            State.panel?.updateStatus('▶️ 播放中');
                        }
                    }), 500);
                };
                document.addEventListener('click', clickHandler, { once: true });
            }

            // 开始进度追踪
            this.startProgressTracking(video);
        },

        /** 添加视频事件监听 */
        addVideoListeners(video) {
            this.removeVideoListeners();

            State.videoEndedListener = () => {
                console.log('[小雅刷课] ✅ 视频播放完成');
                State.panel?.updateStatus('✅ 已完成');
                if (State.autoNext) {
                    this.advanceToNext();
                }
            };
            video.addEventListener('ended', State.videoEndedListener);
        },

        /** 移除视频事件监听 */
        removeVideoListeners() {
            const video = Utils.getVideoElement();
            if (video) {
                if (State.videoEndedListener) {
                    video.removeEventListener('ended', State.videoEndedListener);
                    State.videoEndedListener = null;
                }
                if (State.timeUpdateListener) {
                    video.removeEventListener('timeupdate', State.timeUpdateListener);
                    State.timeUpdateListener = null;
                }
            }
        },

        /** 前进到下一个视频 */
        async advanceToNext() {
            const folder = COURSE_DATA.folders[State.currentFolderIndex];
            if (!folder) return;

            State.currentVideoIndex++;

            if (State.currentVideoIndex < folder.videos.length) {
                // 同一文件夹下一个视频
                const nextVideo = folder.videos[State.currentVideoIndex];
                console.log(`[小雅刷课] ⏭ 下一个: ${nextVideo.name}`);
                State.panel?.updateStatus(`⏭ ${nextVideo.name}`);
                this.saveProgress();
                Utils.navigateToVideo(folder.id, nextVideo.id);
            } else {
                // 当前文件夹全部完成，进入下一个文件夹
                console.log(`[小雅刷课] 🎉 ${folder.name} 全部完成`);
                State.currentFolderIndex++;
                State.currentVideoIndex = 0;

                if (State.currentFolderIndex < COURSE_DATA.folders.length) {
                    const nextFolder = COURSE_DATA.folders[State.currentFolderIndex];
                    console.log(`[小雅刷课] 📂 进入: ${nextFolder.name}`);
                    State.panel?.updateStatus(`📂 ${nextFolder.name}`);
                    this.saveProgress();
                    Utils.navigateToFolder(nextFolder.id);
                } else {
                    // 全部完成！
                    console.log('[小雅刷课] 🎉🎉🎉 全部课程已完成！');
                    State.panel?.updateStatus('🎉 全部完成！');
                    this.saveProgress(true);
                    try {
                        GM_notification({
                            title: '小雅刷课助手',
                            text: '所有课程视频已全部刷完！🎉',
                            timeout: 10000,
                        });
                    } catch(e) {}
                    this.stop();
                }
            }
        },

        /** 导航到指定视频 */
        goToVideo(folderIndex, videoIndex) {
            const folder = COURSE_DATA.folders[folderIndex];
            if (!folder || !folder.videos[videoIndex]) return;
            State.currentFolderIndex = folderIndex;
            State.currentVideoIndex = videoIndex;
            Utils.navigateToVideo(folder.id, folder.videos[videoIndex].id);
        },

        /** 保存进度 */
        saveProgress(allDone) {
            try {
                GM_setValue('xiaoya_progress_' + COURSE_DATA.courseId, JSON.stringify({
                    folderIndex: State.currentFolderIndex,
                    videoIndex: State.currentVideoIndex,
                    allDone: !!allDone,
                    timestamp: Date.now(),
                }));
            } catch(e) {}
        },

        /** 读取进度 */
        getProgress() {
            try {
                const data = GM_getValue('xiaoya_progress_' + COURSE_DATA.courseId);
                if (data) {
                    const p = JSON.parse(data);
                    if (p.allDone) return null;
                    // 验证数据有效性
                    if (p.folderIndex >= 0 && p.folderIndex < COURSE_DATA.folders.length &&
                        p.videoIndex >= 0 && p.videoIndex < COURSE_DATA.folders[p.folderIndex].videos.length) {
                        return p;
                    }
                }
            } catch(e) {}
            return null;
        },

        /** 重置进度 */
        resetProgress() {
            try {
                GM_setValue('xiaoya_progress_' + COURSE_DATA.courseId, '');
                State.currentFolderIndex = 0;
                State.currentVideoIndex = 0;
            } catch(e) {}
        },

        /** 进度追踪 */
        startProgressTracking(video) {
            if (State.progressTimer) clearInterval(State.progressTimer);

            State.progressTimer = setInterval(() => {
                if (!State.running) return;
                const ct = video.currentTime || 0;
                const dur = video.duration || 1;
                const pct = Math.min(100, Math.round((ct / dur) * 100));
                State.panel?.updatePlayProgress(ct, dur, pct);
            }, 1000);
        },
    };

    // ========================================
    // UI 控制面板
    // ========================================
    const Panel = {
        container: null,

        create() {
            if (this.container) return;

            const p = document.createElement('div');
            p.id = 'xy-auto-panel';
            p.innerHTML = `
                <div class="xy-hd">
                    <span class="xy-tt">📺 小雅刷课</span>
                    <span class="xy-st" id="xy-st">就绪</span>
                    <button class="xy-cb" id="xy-cb">−</button>
                </div>
                <div class="xy-bd">
                    <div class="xy-r">
                        <span class="xy-l">📂 当前：</span>
                        <span class="xy-v" id="xy-folder">-</span>
                    </div>
                    <div class="xy-r">
                        <span class="xy-l">🎬 视频：</span>
                        <span class="xy-v" id="xy-video">-</span>
                    </div>
                    <div class="xy-r">
                        <span class="xy-l">📊 进度：</span>
                        <span class="xy-v" id="xy-progress">-</span>
                    </div>
                    <div class="xy-pb"><div class="xy-pf" id="xy-pf"></div></div>
                    <div class="xy-r xy-pi">
                        <span id="xy-time">00:00 / 00:00</span>
                        <span id="xy-pct">0%</span>
                    </div>
                    <div class="xy-r">
                        <span class="xy-l">⏩ 倍速：</span>
                        <div class="xy-sb" id="xy-sb"></div>
                    </div>
                    <div class="xy-r" style="margin-top: 1px; justify-content: space-between;">
                        <span style="font-size:11px;color:#4fc3f7;" id="xy-anti-status">🛡️ 防离开</span>
                        <span style="font-size:11px;color:#888;" id="xy-mute-status">🔇 静音</span>
                    </div>
                    <div class="xy-ac">
                        <button class="xy-b xy-b1" id="xy-start">▶ 开始</button>
                        <button class="xy-b xy-b2" id="xy-stop">⏹ 停止</button>
                        <button class="xy-b xy-b3" id="xy-skip">⏭ 跳过</button>
                        <button class="xy-b xy-b4" id="xy-reset">🔄 重置</button>
                        <label class="xy-sl">
                            <input type="checkbox" id="xy-an" ${State.autoNext ? 'checked' : ''}>
                            <span>自动</span>
                        </label>
                    </div>
                </div>
            `;
            document.body.appendChild(p);
            this.container = p;
            this.addStyles();
            this.bindEvents();
            this.createSpeedBtns();
            State.panel = this;
            this.makeDraggable(p);
        },

        addStyles() {
            const s = document.createElement('style');
            s.textContent = `
                #xy-auto-panel {
                    position:fixed; top:80px; right:20px; width:300px;
                    background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);
                    border:1px solid rgba(255,255,255,0.1);
                    border-radius:12px; z-index:999999;
                    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
                    font-size:13px; color:#e0e0e0;
                    box-shadow:0 8px 32px rgba(0,0,0,0.4);
                    user-select:none; overflow:hidden;
                    backdrop-filter:blur(10px);
                }
                #xy-auto-panel .xy-hd {
                    display:flex; align-items:center; padding:8px 12px;
                    background:rgba(255,255,255,0.05);
                    border-bottom:1px solid rgba(255,255,255,0.05);
                    cursor:move;
                }
                #xy-auto-panel .xy-tt { font-weight:600; font-size:13px; color:#4fc3f7; flex:1; }
                #xy-auto-panel .xy-st { font-size:11px; padding:1px 8px; border-radius:8px; background:rgba(255,255,255,0.1); color:#aaa; margin-right:6px; }
                #xy-auto-panel .xy-cb { background:none; border:none; color:#666; cursor:pointer; font-size:16px; padding:0 4px; line-height:1; }
                #xy-auto-panel .xy-cb:hover { color:#aaa; }
                #xy-auto-panel .xy-bd { padding:10px 12px; }
                #xy-auto-panel .xy-r { display:flex; align-items:center; margin-bottom:6px; gap:4px; }
                #xy-auto-panel .xy-l { color:#888; min-width:48px; flex-shrink:0; font-size:12px; }
                #xy-auto-panel .xy-v { color:#ccc; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; flex:1; }
                #xy-auto-panel .xy-sb { display:flex; gap:3px; flex-wrap:wrap; }
                #xy-auto-panel .xy-sbtn {
                    padding:1px 7px; border-radius:3px; border:1px solid rgba(255,255,255,0.15);
                    background:rgba(255,255,255,0.05); color:#ccc; cursor:pointer; font-size:11px;
                }
                #xy-auto-panel .xy-sbtn:hover { background:rgba(79,195,247,0.2); }
                #xy-auto-panel .xy-sbtn.on { background:#4fc3f7; color:#1a1a2e; border-color:#4fc3f7; font-weight:600; }
                #xy-auto-panel .xy-pb { height:3px; background:rgba(255,255,255,0.1); border-radius:2px; margin:6px 0 2px; overflow:hidden; }
                #xy-auto-panel .xy-pf { height:100%; width:0%; background:linear-gradient(90deg,#4fc3f7,#00e676); border-radius:2px; transition:width .5s; }
                #xy-auto-panel .xy-pi { justify-content:space-between; font-size:11px; color:#666; margin-top:0; }
                #xy-auto-panel .xy-ac { display:flex; flex-wrap:wrap; gap:4px; margin-top:8px; align-items:center; }
                #xy-auto-panel .xy-b {
                    padding:4px 10px; border:none; border-radius:5px; cursor:pointer; font-size:11px; font-weight:500;
                }
                #xy-auto-panel .xy-b1 { background:#4fc3f7; color:#1a1a2e; }
                #xy-auto-panel .xy-b1:hover { background:#29b6f6; }
                #xy-auto-panel .xy-b2 { background:rgba(255,82,82,0.2); color:#ff5252; }
                #xy-auto-panel .xy-b2:hover { background:rgba(255,82,82,0.3); }
                #xy-auto-panel .xy-b3 { background:rgba(255,193,7,0.15); color:#ffc107; }
                #xy-auto-panel .xy-b3:hover { background:rgba(255,193,7,0.25); }
                #xy-auto-panel .xy-b4 { background:rgba(255,255,255,0.08); color:#aaa; }
                #xy-auto-panel .xy-b4:hover { background:rgba(255,255,255,0.15); }
                #xy-auto-panel .xy-sl { display:flex; align-items:center; gap:3px; font-size:11px; color:#888; cursor:pointer; margin-left:auto; }
                #xy-auto-panel .xy-sl input { accent-color:#4fc3f7; }
            `;
            document.head.appendChild(s);
        },

        bindEvents() {
            document.getElementById('xy-start')?.addEventListener('click', () => Engine.start());
            document.getElementById('xy-stop')?.addEventListener('click', () => Engine.stop());
            document.getElementById('xy-skip')?.addEventListener('click', () => {
                if (State.running) Engine.advanceToNext();
            });
            document.getElementById('xy-reset')?.addEventListener('click', () => {
                if (confirm('确定要重置刷课进度吗？将从第一个视频重新开始。')) {
                    Engine.resetProgress();
                    Engine.stop();
                    this.updateStatus('已重置');
                }
            });
            document.getElementById('xy-an')?.addEventListener('change', e => {
                State.autoNext = e.target.checked;
                try { GM_setValue('xiaoya_autoNext', State.autoNext); } catch(ex) {}
            });
            document.getElementById('xy-cb')?.addEventListener('click', function() {
                const panel = document.getElementById('xy-auto-panel');
                const body = panel.querySelector('.xy-bd');
                const collapsed = body.style.display === 'none';
                body.style.display = collapsed ? '' : 'none';
                this.textContent = collapsed ? '−' : '+';
            });
        },

        createSpeedBtns() {
            const c = document.getElementById('xy-sb');
            if (!c) return;
            CONFIG.speeds.forEach(sp => {
                const btn = document.createElement('button');
                btn.className = 'xy-sbtn' + (sp === State.speed ? ' on' : '');
                btn.textContent = sp + 'x';
                btn.addEventListener('click', () => {
                    State.speed = sp;
                    try { GM_setValue('xiaoya_speed', sp); } catch(e) {}
                    c.querySelectorAll('.xy-sbtn').forEach(b => b.classList.remove('on'));
                    btn.classList.add('on');
                    const v = Utils.getVideoElement();
                    if (v) v.playbackRate = sp;
                });
                c.appendChild(btn);
            });
        },

        makeDraggable(p) {
            const h = p.querySelector('.xy-hd');
            let drag = false, sx, sy, ox, oy;
            h.addEventListener('mousedown', e => {
                if (e.target.closest('.xy-cb')) return;
                drag = true;
                sx = e.clientX; sy = e.clientY;
                const r = p.getBoundingClientRect();
                ox = r.left; oy = r.top;
                p.style.cursor = 'grabbing';
            });
            document.addEventListener('mousemove', e => {
                if (!drag) return;
                p.style.left = (ox + e.clientX - sx) + 'px';
                p.style.top = (oy + e.clientY - sy) + 'px';
                p.style.right = 'auto';
            });
            document.addEventListener('mouseup', () => { drag = false; p.style.cursor = ''; });
        },

        // ---- 更新方法 ----
        updateStatus(text) {
            const el = document.getElementById('xy-st');
            if (el) el.textContent = text;
        },
        updateFolderInfo(folderIndex, videoIndex) {
            const folder = COURSE_DATA.folders[folderIndex];
            const folderEl = document.getElementById('xy-folder');
            if (folderEl) folderEl.textContent = folder ? `${folderIndex + 1}/${COURSE_DATA.folders.length} ${folder.name}` : '-';
            const progressEl = document.getElementById('xy-progress');
            if (progressEl) {
                let total = 0, done = 0;
                for (let i = 0; i < COURSE_DATA.folders.length; i++) {
                    total += COURSE_DATA.folders[i].videos.length;
                    if (i < folderIndex) done += COURSE_DATA.folders[i].videos.length;
                }
                done += (videoIndex + 1);
                progressEl.textContent = `${done} / ${total}`;
            }
        },
        updateVideoInfo(title, duration) {
            const el = document.getElementById('xy-video');
            if (el) el.textContent = title || '-';
        },
        updatePlayProgress(ct, dur, pct) {
            const tEl = document.getElementById('xy-time');
            const pEl = document.getElementById('xy-pct');
            const fEl = document.getElementById('xy-pf');
            if (tEl) tEl.textContent = `${Utils.formatTime(ct)} / ${Utils.formatTime(dur)}`;
            if (pEl) pEl.textContent = `${pct}%`;
            if (fEl) fEl.style.width = `${pct}%`;
        },
    };

    // ========================================
    // 初始化（@run-at document-start 已执行静态防护，这里等待DOM就绪）
    // ========================================
    function init() {
        if (!window.location.hostname.includes('ai-augmented.com')) return;
        if (!window.location.pathname.includes('/mycourse/')) return;

        // DOM 可能还未就绪，等待
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => setTimeout(initUI, 500));
        } else {
            setTimeout(initUI, 500);
        }
    }

    function initUI() {

        console.log('[小雅刷课] 📺 已加载，等待页面就绪...');

        // 尝试预加载课程数据（让面板能显示课程信息）
        setTimeout(async () => {
            try {
                await loadCourseData();
                if (COURSE_DATA.folders.length > 0) {
                    console.log('[小雅刷课] 📂 预加载课程数据成功');
                }
            } catch (e) {}

            Panel.create();

            // 检测当前页面状态
            setTimeout(() => {
                const video = Utils.getVideoElement();
                const pos = Utils.getCurrentPosition();
                if (pos && COURSE_DATA.folders[pos.folderIndex]) {
                    const folder = COURSE_DATA.folders[pos.folderIndex];
                    const vname = folder?.videos[pos.videoIndex]?.name || '';
                    Panel.updateStatus('就绪');
                    Panel.updateFolderInfo(pos.folderIndex, pos.videoIndex);
                    Panel.updateVideoInfo(vname, 0);
                    console.log(`[小雅刷课] 📍 当前位置: ${folder?.name || '?'} > ${vname}`);
                } else if (video) {
                    Panel.updateStatus('就绪');
                } else {
                    const path = Utils.getPathParts();
                    if (path && path.folderId && !path.resourceId) {
                        Panel.updateStatus('就绪 - 文件夹视图');
                    } else {
                        Panel.updateStatus('就绪');
                    }
                }

                // 检测是否有待启动标记（从导航跳转过来）
                const pendingStart = (() => {
                    try { return GM_getValue('xiaoya_pending_start', false); } catch(e) { return false; }
                })();
                if (pendingStart) {
                    try { GM_setValue('xiaoya_pending_start', false); } catch(e) {}
                    console.log('[小雅刷课] 🔄 检测到待启动标记，自动开始刷课');
                    setTimeout(() => Engine.start(), 800);
                }
            }, 1500);
        }, 1500);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
