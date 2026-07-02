let currentVideoName = '';
let currentTreePath = ''; // 当前文件树路径（用于“进入文件夹”模式）

// minimum previewable dimensions (used by updatePreviewEmptyHint)
const PREVIEW_MIN_WIDTH = 330;
const PREVIEW_MIN_HEIGHT = 480; // lowered from original 400 to allow shorter viewports

// 默认显示的树路径（虚拟根目录）
function getDefaultTreePath() {
    return '';
}
// 记住上次打开的文件树路径（localStorage）
function getLastTreePath() {
    try {
        const saved = localStorage.getItem('bililive_last_tree_path');
        if (saved !== null) return String(saved).trim();
    } catch (e) { }
    return '';
}
function saveLastTreePath(path) {
    try {
        localStorage.setItem('bililive_last_tree_path', String(path || '').trim());
    } catch (e) { }
}
let videoTasks = []; // 存储所有视频的任务结构
let __stopTimelineThumbLoading = null;

// 字幕相关状态
let __subtitleData = [];       // [{start, end, text}]
let __subtitleEnabled = false;

// 切片配置：视频预览 / 字幕切片 独立开关
let __videoPreviewEnabled = true;
let __subtitleSliceEnabled = false;

function __flattenVideoTasksToClips() {
    const flat = [];
    for (const t of (videoTasks || [])) {
        const name = String(t?.name || '').trim();
        if (!name) continue;
        const clips = Array.isArray(t?.clips) ? t.clips : [];
        for (const c of clips) {
            const start = Number(c?.start);
            const end = Number(c?.end);
            if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
            if (start < 0 || end <= start) continue;
            flat.push({ name, start, end });
        }
    }
    return flat;
}

function __getTotalClipCountFromVideoTasks() {
    let total = 0;
    for (const t of (videoTasks || [])) {
        const clips = Array.isArray(t?.clips) ? t.clips : [];
        total += clips.length;
    }
    return total;
}
const player = document.getElementById('player');
const playerWrapper = document.getElementById('playerWrapper');
const mergeStatus = document.getElementById('mergeStatus');
const mergeResult = document.getElementById('mergeResult');
const visitCountEl = document.getElementById('visitCount');
const mergeSuccessCountEl = document.getElementById('mergeSuccessCount');
const downloadCountEl = document.getElementById('downloadCount');
const videoContainer = document.getElementById('videoContainer');
const fileTreeDiv = document.getElementById('fileTree');
const previewBtn = document.getElementById('previewBtn');
const videoControlsContainer = document.getElementById('videoControlsContainer');

const progressBar = document.getElementById('progressBar');
let isDragging = false;
const playPauseBtn = document.getElementById('playPauseBtn');
const backwardBtn = document.getElementById('backwardBtn');
const forwardBtn = document.getElementById('forwardBtn');

// 判断视频控制是否就绪（已选择视频 且 已加载预览）
function __isVideoReady() {
    if (!currentVideoName) return false;
    var _previewLoaded = false;
    try {
        var _srcAttr = (player && player.getAttribute) ? String(player.getAttribute('src') || '').trim() : '';
        var _srcProp = (player && typeof player.src === 'string') ? String(player.src || '').trim() : '';
        var _currentSrc = (player && typeof player.currentSrc === 'string') ? String(player.currentSrc || '').trim() : '';
        var _hasSrc = !!(_srcAttr || _srcProp || _currentSrc);
        var _hasMeta = !!(player && Number.isFinite(player.duration) && player.duration > 0);
        // 必须 __mainPreviewActive 为 true 且视频实际有 src 或元数据，才算准备就绪
        // 避免 player.load() 后浏览器未重置 duration/currentSrc 导致误判
        _previewLoaded = !!(__mainPreviewActive) && (_hasSrc || _hasMeta);
    } catch (e) {
        _previewLoaded = !!(__mainPreviewActive);
    }
    return !!_previewLoaded;
}

// 同步所有视频控制按钮/进度条的 disabled 状态
function __syncVideoControlsDisabledState() {
    var _ready = __isVideoReady();
    var _btns = [backwardBtn, playPauseBtn, forwardBtn, quickSetStartBtn, quickSetEndBtn, quickAddClipBtnCtrl, quickPlayClipBtn, fullscreenBtn];
    for (var _i = 0; _i < _btns.length; _i++) {
        if (_btns[_i]) _btns[_i].disabled = !_ready;
    }
    if (speedSelect) speedSelect.disabled = !_ready;
    if (speedSelectToggle) speedSelectToggle.disabled = !_ready;
    if (speedSelectGroup && !_ready) speedSelectGroup.classList.remove('open');
    if (speedSelectMenu) {
        speedSelectMenu.querySelectorAll('.tl-dropdown-item[data-speed]').forEach(function (btn) {
            btn.disabled = !_ready;
        });
    }
    if (progressBar) progressBar.disabled = !_ready;

    // mark control container with a class so default dimming applies before JS runs
    if (videoControlsContainer) {
        if (_ready) {
            videoControlsContainer.classList.add('ready');
        } else {
            videoControlsContainer.classList.remove('ready');
        }
    }
}

// 在合并/切片运行或排队时标记“添加片段”受限，但保留按钮可点击（点击会提示不可添加）
function __isClipEditLocked(state) {
    const s = state && typeof state === 'object' ? state : (__mergeStatusLastState || {});
    return s.running === true || s.queued === true;
}

function __syncClipAddDisabledState(state) {
    try {
        const locked = __isClipEditLocked(state);

        if (confirmAddClipBtn) {
            // 不再真正禁用按钮（保持可点击），仅添加样式提示
            confirmAddClipBtn.classList.toggle('clip-add-locked', locked);
            confirmAddClipBtn.title = locked ? '当前正在切片/队列中，点击将提示无法添加' : '确认添加片段';
        }
        if (quickAddClipBtnCtrl) {
            quickAddClipBtnCtrl.classList.toggle('clip-add-locked', locked);
            quickAddClipBtnCtrl.title = locked ? '当前正在切片/队列中，点击将提示无法添加' : '添加片段';
        }

        // 仅作为视觉/状态标记，供其他逻辑/样式使用
        try { document.body.dataset.clipAddDisabled = locked ? '1' : '0'; } catch (e) { }
    } catch (e) {
        // ignore
    }
}

// 更新：根据状态切换预览区半透明与覆盖文本（未选择或已选择但未预览时半透明）
function refreshVideoStageDim() {
    const stage = document.getElementById('videoStage');
    const overlay = document.getElementById('videoStageOverlay');
    if (!stage) return;

    const noVideo = !currentVideoName;
    const previewLoaded = __isVideoReady();
    const shouldDim = noVideo || (currentVideoName && !previewLoaded);

    stage.classList.toggle('dimmed', shouldDim);

    if (overlay) {
        const textEl = document.getElementById('videoStageOverlayText');
        const pvBtn = document.getElementById('previewBtn');
        const svBtn = document.getElementById('openFileTreeBtnOverlay');

        if (noVideo) {
            // 未选择视频
            overlay.style.display = 'flex';
            overlay.setAttribute('aria-hidden', 'false');
            if (textEl) textEl.textContent = '未选择视频';
            if (pvBtn) pvBtn.style.display = 'none';
            if (svBtn) svBtn.style.display = '';
        } else if (!previewLoaded) {
            // 已选择但未预览：显示预览按钮
            overlay.style.display = 'flex';
            overlay.setAttribute('aria-hidden', 'false');
            if (textEl) textEl.textContent = '';
            if (pvBtn) pvBtn.style.display = '';
            if (svBtn) svBtn.style.display = 'none';
        } else {
            // 已加载预览：隐藏覆盖层
            overlay.style.display = 'none';
            overlay.setAttribute('aria-hidden', 'true');
            if (pvBtn) pvBtn.style.display = 'none';
            if (svBtn) svBtn.style.display = 'none';

            // 如果内部控制仍然保持焦点，移开以避免 aria-hidden 冲突
            if (pvBtn && document.activeElement === pvBtn) {
                pvBtn.blur();
                // 可选：将焦点转回舞台或其他主要控件
                if (stage && typeof stage.focus === 'function') stage.focus();
            }
        }
    }

    // 根据 aria-hidden 设置 inert 属性，防止聚焦与辅助技术访问
    if (overlay) {
        try { overlay.inert = overlay.getAttribute('aria-hidden') === 'true'; } catch (e) { }
    }

    // 更新"选择视频"按钮文本（同步普通与标题紧凑按钮）
    const ftBtns = document.querySelectorAll('.preview-panel .select-video-btn');
    ftBtns.forEach(btn => {
        btn.textContent = noVideo ? '选择视频' : '更换视频';
    });

    // 同步视频控制组件的禁用状态
    __syncVideoControlsDisabledState();
}

// 根据视口尺寸更新小屏提示文本：指出是“宽度不足”还是“高度不足”或两者均不足
// 同时当预览区域不可见时暂停视频/音频播放，避免无意义消耗
function updatePreviewEmptyHint() {
    try {
        const hint = document.querySelector('.preview-panel .panel-title .preview-empty-hint');
        if (!hint) return;

        const w = window.innerWidth || document.documentElement.clientWidth || 0;
        const h = window.innerHeight || document.documentElement.clientHeight || 0;
        const widthTooSmall = (w < PREVIEW_MIN_WIDTH);
        const heightTooSmall = (h < PREVIEW_MIN_HEIGHT);
        const spaceTooSmall = widthTooSmall || heightTooSmall;

        let text = '空间不足，无法显示预览';
        if (widthTooSmall && heightTooSmall) {
            text = '空间不足：宽度和高度均不足，无法显示预览';
        } else if (widthTooSmall) {
            text = '空间不足：宽度不足，无法显示预览';
        } else if (heightTooSmall) {
            text = '空间不足：高度不足，无法显示预览';
        }

        hint.textContent = text;
        hint.title = text;

        // 预览区域太小被隐藏时暂停播放，避免无谓的带宽/解码消耗
        // 全屏状态下不暂停
        if (spaceTooSmall && !document.body.classList.contains('fullscreen-active')) {
            try { if (player && !player.paused) { player.pause(); } } catch (e) { /* ignore */ }
            try { if (audioPlayer && !audioPlayer.paused) { audioPlayer.pause(); } } catch (e) { /* ignore */ }
        }
    } catch (e) {
        /* ignore */
    }
}

const timeDisplay = document.getElementById('timeDisplay');
let quickSetStartBtn = null;
let quickSetEndBtn = null;
let quickAddClipBtnCtrl = null;
let quickPlayClipBtn = null;
const speedSelect = document.getElementById('speedSelect');
const speedSelectGroup = document.getElementById('speedSelectGroup');
const speedSelectToggle = document.getElementById('speedSelectToggle');
const speedSelectMenu = document.getElementById('speedSelectMenu');
const openFileTreeBtnMain = document.getElementById('openFileTreeBtn');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const mainControlsRow = document.querySelector('#videoControlsContainer .buttons-row.main-ctrls');
const mainLeftCtrlGroup = mainControlsRow ? mainControlsRow.querySelector('.ctrl-group.left') : null;
const mainRightCtrlGroup = mainControlsRow ? mainControlsRow.querySelector('.ctrl-group.right') : null;
let ctrlStartDisp = null;
let ctrlEndDisp = null;
const usernameInput = document.getElementById('usernameInput');
const clipTitleInput = document.getElementById('clipTitleInput');
const openHistoryBtn = document.getElementById('openHistoryBtn');
const floatingProgressWidget = document.getElementById('floatingProgressWidget');
const progressModalOverlay = document.getElementById('progressModalOverlay');
const progressModalBody = document.getElementById('progressModalBody');
const progressModalTitle = document.getElementById('progressModalTitle');
const cancelMergeBtnModalFixed = document.getElementById('cancelMergeBtnModalFixed');

function __syncCancelMergeBtnFixed(state) {
    if (!cancelMergeBtnModalFixed) return;

    const s = state && typeof state === 'object' ? state : { running: false };
    const running = s.running === true;
    const status = String(s.status || '').toLowerCase();
    const stage = String(s.stage || '').toLowerCase();
    const token = String(__getMergeToken() || '').trim();
    const jobId = String(s.job_id || '').trim();

    const cancelling = (status === 'cancelling') || (stage === 'cancelling') || (s.cancel_requested === true);
    const isDone = (status === 'done');
    const isError = (status === 'error');
    const isCancelled = (status === 'cancelled') || (stage === 'cancelled');

    // 已确认过的任务或无任务时：隐藏按钮
    if (jobId && jobId === __getAckedJobId()) {
        cancelMergeBtnModalFixed.style.display = 'none';
        return;
    }

    // 任务完成/出错：按钮变为"确认"
    if (!running && (isDone || isError)) {
        cancelMergeBtnModalFixed.style.display = '';
        cancelMergeBtnModalFixed.disabled = false;
        cancelMergeBtnModalFixed.textContent = '确认';
        cancelMergeBtnModalFixed.dataset.mode = 'ack';
        cancelMergeBtnModalFixed.dataset.jobId = jobId;
        // 样式由 CSS [data-mode="ack"] 控制
        return;
    }

    // 已取消/空闲：隐藏按钮
    if (!running && (isCancelled || !token)) {
        cancelMergeBtnModalFixed.style.display = 'none';
        return;
    }

    // 运行中：显示取消按钮
    cancelMergeBtnModalFixed.style.display = '';
    cancelMergeBtnModalFixed.dataset.mode = 'cancel';
    cancelMergeBtnModalFixed.dataset.jobId = '';

    // 恢复默认样式（移除可能存在的 inline style）
    cancelMergeBtnModalFixed.style.background = '';
    cancelMergeBtnModalFixed.style.borderColor = '';

    if (cancelling) {
        cancelMergeBtnModalFixed.disabled = true;
        cancelMergeBtnModalFixed.textContent = '取消中...';
        return;
    }

    cancelMergeBtnModalFixed.disabled = false;
    cancelMergeBtnModalFixed.textContent = '取消当前任务';
}

// 常驻按钮：只绑定一次，根据 mode 分发
if (cancelMergeBtnModalFixed) {
    cancelMergeBtnModalFixed.addEventListener('click', async () => {
        const mode = cancelMergeBtnModalFixed.dataset.mode || 'cancel';

        // ---- 确认模式 ----
        if (mode === 'ack') {
            // apply clear/keep decision from radio
            try {
                const sel = document.querySelector('input[name="clearChoice"]:checked');
                const val = sel ? sel.value : 'keep';
                if (val === 'clear') {
                    videoTasks = [];
tempStart = null;
                    tempEnd = null;
                    updateClipInputs();
                    renderNewClipList();
                    __saveClipToolState();
                    showToast('已清空当前片段列表');
                } else {
                    showToast('已保留片段列表');
                }
            } catch (e) {
                // ignore if radio not present
            }
            const jobId = cancelMergeBtnModalFixed.dataset.jobId || '';
            __ackCurrentMergeResult(jobId);
            return;
        }

        // ---- 取消模式 ----
        cancelMergeBtnModalFixed.style.display = '';

        const ok = await showConfirmModal('确定要取消当前任务吗？', { title: '取消确认', okText: '确认取消' });
        if (!ok) return;

        let canceledQueue = false;
        try {
            cancelMergeBtnModalFixed.disabled = true;
            cancelMergeBtnModalFixed.textContent = '取消中...';

            const s = await __fetchMergeStatus();
            __mergeStatusLastState = s;

            // 若在队列中，则取消排队（不影响正在运行的任务）
            if (s && s.queued === true) {
                await fetch('/api/cancel_merge', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ job_id: String(s.job_id || ''), merge_token: __getMergeToken() })
                });
                showToast('已取消排队任务');
                __setMergeToken('');
                __stopMergeStatusPolling();
                updateFloatingWidget(false);
                try { closeProgressModal(); } catch (e) { }
                try {
                    if (mergeAllBtn) {
                        mergeAllBtn.disabled = false;
                        mergeAllBtn.textContent = '开始合并';
                    }
                } catch (e) { }
                __syncCancelMergeBtnFixed({ running: false });
                canceledQueue = true;
                return;
            }

            if (!(s && s.running === true)) {
                showToast('当前没有可取消的任务');
                __syncCancelMergeBtnFixed(s);
                return;
            }

            await fetch('/api/cancel_merge', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ job_id: String(s.job_id || ''), merge_token: __getMergeToken() })
            });
            showToast('已发送取消请求');
            try { closeProgressModal(); } catch (e) { }
        } catch (e) {
            showToast('取消失败');
        } finally {
            if (!canceledQueue) {
                __startMergeStatusPolling({ forceFast: true });
            }
        }
    });
    // 初始状态：隐藏（无任务时不显示）
    __syncCancelMergeBtnFixed({ running: false });
}

// 悬浮组件交互
if (floatingProgressWidget) {
    floatingProgressWidget.addEventListener('click', () => {
        openProgressModal();
    });
}
if (progressModalOverlay) {
    const closeBtn = progressModalOverlay.querySelector('.close-modal');
    if (closeBtn) closeBtn.addEventListener('click', (e) => {
        // 若已显示合并结果（终态卡片），禁止通过 header × 关闭，必须使用“确认”按钮
        try { if (__getProgressModalHasResultCard()) return; } catch (err) { }
        closeProgressModal();
    });

    progressModalOverlay.addEventListener('click', (e) => {
        if (e.target === progressModalOverlay) {
            // 遮罩点击：若为终态结果卡则禁止关闭
            try { if (__getProgressModalHasResultCard()) return; } catch (err) { }
            closeProgressModal();
        }
    });

    // 阻止在合并完成时按 Esc 关闭进度弹窗（如果需要严格只允许“确认”关闭）
    document.addEventListener('keydown', (e) => {
        try {
            if (e.key === 'Escape' && progressModalOverlay.classList.contains('show') && __getProgressModalHasResultCard()) {
                e.preventDefault();
                e.stopPropagation();
            }
        } catch (err) { }
    });
}

function openProgressModal() {
    if (progressModalOverlay) {
        const myModalId = (window.__modalSeq = (window.__modalSeq || 0) + 1);
        progressModalOverlay.__modalId = myModalId;
        // 记录打开前的焦点，以便关闭时恢复（避免 aria-hidden 报错）
        progressModalOverlay.__previouslyFocused = document.activeElement;
        // clear any lingering hide animation class
        progressModalOverlay.classList.remove('hiding');
        progressModalOverlay.classList.add('show');
        progressModalOverlay.setAttribute('aria-hidden', 'false');
    }
}
function closeProgressModal() {
    if (progressModalOverlay) {
        // add exit animation
        progressModalOverlay.classList.add('hiding');
        // wait for animation duration (match css 0.3s)
        setTimeout(() => {
            // 恢复被隐藏的 header ×（若存在 data 标记）或恢复正常样式
            try {
                const closeBtn = progressModalOverlay.querySelector('.close-modal');
                if (closeBtn) {
                    if (closeBtn.getAttribute('data-hidden-due-result')) {
                        closeBtn.style.display = '';
                        closeBtn.removeAttribute('data-hidden-due-result');
                    }
                    // 清理可能的 disabled/aria 属性（保险）
                    closeBtn.disabled = false;
                    closeBtn.removeAttribute('aria-disabled');
                    closeBtn.style.opacity = '';
                    closeBtn.style.cursor = '';
                }
                progressModalOverlay.classList.remove('result-locked');
            } catch (e) { /* ignore */ }

            __safeHideOverlay(progressModalOverlay);
            // clear content after overlay is hidden to avoid flicker
            if (progressModalBody) progressModalBody.innerHTML = '';
            progressModalOverlay.classList.remove('hiding');
        }, 300);
    }
}
function updateFloatingWidget(show, text, spin) {
    if (!floatingProgressWidget) return;
    if (!show) {
        floatingProgressWidget.style.display = 'none';
        return;
    }
    floatingProgressWidget.style.display = 'flex';
    const txt = floatingProgressWidget.querySelector('.fp-text');
    const spinner = floatingProgressWidget.querySelector('.fp-spinner');
    if (txt) txt.textContent = text || '处理中...';
    if (spinner) spinner.style.display = spin ? 'block' : 'none';
}

// 防止鼠标点击按钮后保留焦点，导致后续空格键触发该按钮：
// 记录最后一次指针类型，若为鼠标，则在 click 后对被点击的 button 执行 blur()
let __lastPointerWasMouse = false;
document.addEventListener('pointerdown', (e) => {
    try { __lastPointerWasMouse = (e && e.pointerType === 'mouse'); } catch (err) { __lastPointerWasMouse = false; }
}, true);
document.addEventListener('click', (e) => {
    try {
        const btn = e.target && e.target.closest ? e.target.closest('button') : null;
        if (btn && __lastPointerWasMouse) {
            try { btn.blur(); } catch (err) { }
        }
    } catch (err) { }
}, true);

// ------------------ 全局合并状态/进度展示 ------------------
let __mergeStatusPollTimer = null; // setTimeout 句柄
let __mergeStatusPollDesired = false; // 是否需要轮询（避免页面打开就一直请求）
let __mergeStatusPollInFlight = false; // 避免并发请求堆积
let __mergeStatusLastState = null;

let __statsPollTimer = null;
let __statsPollDesired = false;
let __statsPollInFlight = false;

function __renderSiteStats(state) {
    const s = state && typeof state === 'object' ? state : {};
    const visitCount = Number(s.visit_count);
    const mergeSuccessCount = Number(s.merge_success_count);
    const downloadCount = Number(s.download_count);

    if (visitCountEl) visitCountEl.textContent = String(Number.isFinite(visitCount) && visitCount >= 0 ? Math.floor(visitCount) : 0);
    if (mergeSuccessCountEl) mergeSuccessCountEl.textContent = String(Number.isFinite(mergeSuccessCount) && mergeSuccessCount >= 0 ? Math.floor(mergeSuccessCount) : 0);
    if (downloadCountEl) downloadCountEl.textContent = String(Number.isFinite(downloadCount) && downloadCount >= 0 ? Math.floor(downloadCount) : 0);
}

async function __fetchSiteStats() {
    try {
        const res = await fetch('/api/stats', { cache: 'no-store' });
        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        return null;
    }
}

function __stopSiteStatsPolling() {
    __statsPollDesired = false;
    if (__statsPollTimer) {
        clearTimeout(__statsPollTimer);
        __statsPollTimer = null;
    }
}

async function __siteStatsTick() {
    if (!__statsPollDesired) {
        __statsPollTimer = null;
        return;
    }
    if (__statsPollInFlight) {
        __statsPollTimer = setTimeout(__siteStatsTick, 500);
        return;
    }
    __statsPollInFlight = true;
    const stats = await __fetchSiteStats();
    __statsPollInFlight = false;

    if (stats) __renderSiteStats(stats);
    __statsPollTimer = setTimeout(__siteStatsTick, 5000);
}

function __startSiteStatsPolling() {
    __statsPollDesired = true;
    if (__statsPollTimer) {
        clearTimeout(__statsPollTimer);
        __statsPollTimer = null;
    }
    __siteStatsTick();
}

function __getMergeToken() {
    const key = 'bililive_merge_token';
    try {
        return String(localStorage.getItem(key) || '').trim();
    } catch (e) {
        return '';
    }
}

function __setMergeToken(token) {
    const key = 'bililive_merge_token';
    const t = String(token || '').trim();
    try {
        if (t) localStorage.setItem(key, t);
        else localStorage.removeItem(key);
    } catch (e) { }
}

// ---- ack mechanism ----
function __getAckedJobId() {
    try { return String(localStorage.getItem('bililive_acked_job_id') || '').trim(); }
    catch (e) { return ''; }
}
function __setAckedJobId(jobId) {
    try {
        const id = String(jobId || '').trim();
        if (id) localStorage.setItem('bililive_acked_job_id', id);
        else localStorage.removeItem('bililive_acked_job_id');
    } catch (e) { }
}
function __ackCurrentMergeResult(jobId) {
    if (jobId) __setAckedJobId(jobId);
    __setMergeToken('');
    updateFloatingWidget(false);
    // let closeProgressModal handle clearing after animation
    try { closeProgressModal(); } catch (e) { }
}

function __pushLocalMergeHistory(item) {
    const key = 'bililive_merge_history';
    try {
        const raw = localStorage.getItem(key);
        const arr = raw ? JSON.parse(raw) : [];
        const next = Array.isArray(arr) ? arr : [];
        next.unshift({
            ts: Date.now(),
            ...item,
        });
        // 去重（按 job_id/out_file）并限制长度
        const seen = new Set();
        const compact = [];
        for (const x of next) {
            const k = String(x?.job_id || x?.out_file || x?.ts || '');
            if (!k || seen.has(k)) continue;
            seen.add(k);
            compact.push(x);
            if (compact.length >= 30) break;
        }
        localStorage.setItem(key, JSON.stringify(compact));
    } catch (e) { }
}

async function __fetchMergeStatus() {
    try {
        const token = __getMergeToken();
        const url = token ? `/api/merge_status?merge_token=${encodeURIComponent(token)}` : '/api/merge_status';
        const res = await fetch(url, { cache: 'no-store' });
        return await res.json();
    } catch (e) {
        return { running: false };
    }
}

function __stopMergeStatusPolling() {
    __mergeStatusPollDesired = false;
    if (__mergeStatusPollTimer) {
        clearTimeout(__mergeStatusPollTimer);
    }
    __mergeStatusPollTimer = null;
}

function __computeNextMergePollMs(state, { forceFast = false } = {}) {
    const s = state && typeof state === 'object' ? state : { running: false };
    const running = s.running === true;

    // 未授权：后端会返回 running=false，这里也直接停止轮询
    const queued = s.queued === true;
    if (!running && !queued && !String(__getMergeToken() || '').trim()) return 0;

    // Already acked: stop polling
    const jobId = String(s.job_id || '').trim();
    if (!running && !queued && jobId && jobId === __getAckedJobId()) return 0;

    // 页面在后台时大幅降频，避免“挂着标签页”刷接口
    if (document.hidden && !forceFast) return 15000;

    // 排队中：以较低频率继续轮询
    if (queued) return forceFast ? 1500 : 3000;

    if (running) {
        return forceFast ? 400 : 500;
    }

    // 不在运行：
    // 1) 如果有 done/error 信息需要展示，短暂再确认一次；
    // 2) 否则直接停止轮询（这是“打开页面就一直查询”的根因）。
    const status = String(s.status || '').toLowerCase();
    // 已完成/出错/取消是终态：展示一次即可停止，避免“终态还在刷接口”。
    if (status === 'done' || status === 'error' || status === 'cancelled') return 0;
    return 0;
}

async function __mergeStatusTick({ forceFast = false } = {}) {
    if (!__mergeStatusPollDesired) {
        __mergeStatusPollTimer = null;
        return;
    }

    // 防止网络慢时 tick 重入导致请求堆叠
    if (__mergeStatusPollInFlight) {
        __mergeStatusPollTimer = setTimeout(() => __mergeStatusTick({ forceFast }), 500);
        return;
    }

    __mergeStatusPollInFlight = true;
    const s = await __fetchMergeStatus();
    __mergeStatusPollInFlight = false;

    __mergeStatusLastState = s;
    __renderMergeStatus(s);

    // 若页面刷新/中途关闭导致 pollJob 没跑完，这里用 merge_status 的终态回填“历史输出”。
    try {
        const status = String(s?.status || '').toLowerCase();
        const outFile = String(s?.out_file || '').trim();
        if (!__isOutputHistoryAutofillSuppressed() && status === 'done' && outFile) {
            __addOutputToHistory(outFile);
            __renderOutputHistory();
        }
    } catch (e) {
        // ignore
    }

    const nextMs = __computeNextMergePollMs(s, { forceFast });
    if (nextMs <= 0) {
        __stopMergeStatusPolling();
        return;
    }
    __mergeStatusPollTimer = setTimeout(() => __mergeStatusTick({ forceFast }), nextMs);
}

function __formatUnixTs(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return '';
    try {
        const d = new Date(n * 1000);
        const pad = (x) => String(x).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    } catch {
        return '';
    }
}

function __getProgressModalHasResultCard() {
    try {
        if (!progressModalBody) return false;
        return !!progressModalBody.querySelector('.merge-result-card');
    } catch (e) {
        return false;
    }
}

function __renderMergeTerminalFromMergeStatus(state) {
    const s = state && typeof state === 'object' ? state : { running: false };
    const status = String(s.status || '').toLowerCase();
    const stage = String(s.stage || '').toLowerCase();
    const outPath = String(s.out_file || '').trim();
    const errorText = String(s.error || '').trim();
    const jobId = String(s.job_id || '').trim();

    // 若 pollJob 已经渲染了结果卡片，这里不要覆盖
    if (__getProgressModalHasResultCard()) return;

    // 仅处理终态；其它情况保持由 running 分支渲染
    if (!(status === 'done' || status === 'error' || status === 'cancelled' || stage === 'cancelled')) return;

    // 已确认过的任务：不再重复渲染完成/错误UI，直接隐藏
    if (jobId && jobId === __getAckedJobId()) {
        updateFloatingWidget(false);
        __syncCancelMergeBtnFixed({ running: false });
        try { if (mergeAllBtn) { mergeAllBtn.disabled = false; mergeAllBtn.textContent = '开始合并'; } } catch (e) { }
        return;
    }

    // 终态：按钮恢复可用（避免一直“提交中/合并中”）
    try {
        if (mergeAllBtn) {
            mergeAllBtn.disabled = false;
            mergeAllBtn.textContent = '开始合并';
        }
    } catch (e) { }

    if (status === 'cancelled' || stage === 'cancelled') {
        updateFloatingWidget(false);
        if (progressModalBody) progressModalBody.innerHTML = '';
        __syncCancelMergeBtnFixed({ running: false });
        return;
    }

    if (status === 'error') {
        updateFloatingWidget(true, '失败', false);
        if (progressModalBody) {
            progressModalBody.innerHTML = `
                <div class="merge-result-card error">
                    <div class="merge-result-icon">❌</div>
                    <div class="merge-result-title">合并失败</div>
                    <div class="merge-result-sub">请检查错误信息后重试</div>
                    <pre class="merge-result-error">${__escapeHtml(errorText || 'Unknown error')}</pre>
                    <div class="merge-result-actions">
                        <button id="copyErrorBtn" type="button">复制错误信息</button>
                    </div>
                </div>
            `;
        }
        __syncCancelMergeBtnFixed({ running: false, status: 'error', job_id: jobId });

        const btn = document.getElementById('copyErrorBtn');
        if (btn) {
            btn.addEventListener('click', () => {
                const text = errorText || 'Unknown error';
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(text).then(() => showToast('错误信息已复制'));
                } else {
                    const ta = document.createElement('textarea');
                    ta.value = text;
                    ta.style.position = 'fixed';
                    ta.style.left = '-9999px';
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    document.body.removeChild(ta);
                    showToast('错误信息已复制');
                }
            });
        }
        return;
    }

    if (status === 'done') {
        updateFloatingWidget(true, '完成', false);

        if (progressModalBody) {
            const safeOutPath = __escapeHtml(outPath || '');
            progressModalBody.innerHTML = `
                <div class="merge-result-card">
                    <div class="merge-result-icon">✅</div>
                    <div class="merge-result-title">合并完成</div>
                    ${safeOutPath ? `<div class="merge-result-filename">${__escapeHtml((outPath || '').split(/[\\\/]/).pop() || '')}</div>` : ''}

                    ${!outPath ? '' : `
                    <div id="fileNotExistWarning" class="merge-result-warning" style="display:none;">⚠ 文件不存在或已被删除</div>
                    `}

                    <div class="merge-result-actions">
                        <button id="downloadClipBtn" type="button">下载视频</button>
                        <button id="copyClipLinkBtn" type="button">复制链接</button>
                    </div>
                    <div class="clear-choice-group">
                            <label class="source-option">
                                <input type="radio" name="clearChoice" value="clear" checked>
                                <div class="source-content">
                                    <span class="source-title">清空片段列表</span>
                                    <span class="source-desc">提交后自动清空</span>
                                </div>
                            </label>
                            <label class="source-option">
                                <input type="radio" name="clearChoice" value="keep">
                                <div class="source-content">
                                    <span class="source-title">保留片段列表</span>
                                    <span class="source-desc">保持列表不变</span>
                                </div>
                            </label>
                        </div>
                    </div>
                </div>
            `;
        }

        __syncCancelMergeBtnFixed({ running: false, status: 'done', job_id: jobId });

        // Auto-open modal so user sees the result
        try { openProgressModal(); } catch (e) { }

        // 在“合并完成”状态下：完全隐藏 header 的 × 按钮（由页面内的确认按钮关闭）
        try {
            if (progressModalOverlay) {
                const closeBtnEl = progressModalOverlay.querySelector('.close-modal');
                if (closeBtnEl) {
                    closeBtnEl.style.display = 'none';
                    closeBtnEl.setAttribute('data-hidden-due-result', '1');
                }
                progressModalOverlay.classList.add('result-locked');
            }
        } catch (e) { /* ignore */ }

        // 文件存在性检查 + 按钮逻辑（异步，不阻塞 UI 更新）
        (async () => {
            if (!outPath) return;
            const downloadHref = `/clips/${encodeURIComponent(outPath)}`;

            async function checkFileExists(fileName) {
                try {
                    const checkRes = await fetch(`/api/check_file/${encodeURIComponent(fileName)}`);
                    const checkData = await checkRes.json();
                    return checkData.exists === true;
                } catch (e) {
                    return false;
                }
            }

            function updateButtonStates(exists) {
                const warning = document.getElementById('fileNotExistWarning');
                const downloadBtn = document.getElementById('downloadClipBtn');
                const copyBtn = document.getElementById('copyClipLinkBtn');

                if (warning) warning.style.display = exists ? 'none' : 'block';
                [downloadBtn, copyBtn].forEach(btn => {
                    if (!btn) return;
                    btn.disabled = !exists;
                });
            }

            // 下载按钮：在点击时做异步存在性校验并触发下载
            const downloadBtn = document.getElementById('downloadClipBtn');
            if (downloadBtn) {
                downloadBtn.addEventListener('click', async () => {
                    const ok = await checkFileExists(outPath);
                    if (!ok) {
                        updateButtonStates(false);
                        showToast('文件不存在，无法下载');
                        return;
                    }
                    const link = document.createElement('a');
                    link.href = downloadHref;
                    link.download = String(outPath).split(/[/\\]/).pop();
                    link.click();
                });
            }

            const copyBtn = document.getElementById('copyClipLinkBtn');
            if (copyBtn) {
                copyBtn.addEventListener('click', async () => {
                    const ok = await checkFileExists(outPath);
                    if (!ok) {
                        updateButtonStates(false);
                        showToast('文件不存在，无法复制链接');
                        return;
                    }
                    try {
                        const url = downloadHref ? (new URL(downloadHref, window.location.href)).toString() : '';
                        if (!url) {
                            showToast('无可复制的链接');
                            return;
                        }
                        if (navigator.clipboard && navigator.clipboard.writeText) {
                            await navigator.clipboard.writeText(url);
                            showToast('已复制下载链接');
                            return;
                        }
                        const ta = document.createElement('textarea');
                        ta.value = url;
                        ta.style.position = 'fixed';
                        ta.style.left = '-9999px';
                        document.body.appendChild(ta);
                        ta.select();
                        document.execCommand('copy');
                        document.body.removeChild(ta);
                        showToast('已复制下载链接');
                    } catch (e) {
                        showToast('复制失败');
                    }
                });
            }
        })();
        return;
    }
}

function __renderMergeStatus(state) {
    const s = state && typeof state === 'object' ? state : { running: false };
    const running = s.running === true;
    const queued = s.queued === true;
    const status = String(s.status || '').toLowerCase();

    // 同步“取消当前任务”按钮状态（常驻按钮）
    __syncCancelMergeBtnFixed(s);
    // 当后端处于运行态（s.running === true）时禁止添加片段
    try { __syncClipAddDisabledState(s); } catch (e) { }

    // ── 排队中：显示排队状态 ──
    if (queued) {
        const pos = Number(s.queue_position ?? 0);
        const len = Number(s.queue_length ?? 0);
        const curEta = String(s.current_task_eta_human || '').trim();
        const etaLine = curEta ? `当前任务剩余 ${curEta}` : '';
        updateFloatingWidget(true, `排队中（第 ${pos} 位，共 ${len} 个等待）`, false);
        if (mergeAllBtn) {
            mergeAllBtn.disabled = false;
            mergeAllBtn.textContent = '排队中...';
        }
        if (progressModalBody) {
            const ahead = Math.max(0, pos - 1);
            const aheadText = ahead > 0 ? `前面还有 ${ahead} 个任务` : '即将开始';
            progressModalBody.innerHTML = `
                <div class="mp-card">
                    <div class="mp-header">
                        <div class="mp-stage">排队中</div>
                    </div>
                    <div class="mp-queue-info">
                        <div class="mp-queue-pos">${aheadText}</div>
                    </div>
                    ${etaLine ? `<div class="mp-queue-eta">${etaLine}</div>` : ''}
                </div>
            `;
        }
        return;
    }

    // 状态文本映射
    const stageRaw = String(s.stage || s.status || '').toLowerCase();
    const stageText = stageRaw === 'slicing' ? '处理中'
        : stageRaw === 'merging' ? '合并中'
            : stageRaw === 'queued' ? '排队中'
                : stageRaw === 'cancelling' ? '取消中'
                    : stageRaw === 'cancelled' ? '已取消'
                        : (status === 'done' ? '完成' : status === 'error' ? '出错' : '');

    const percent = Math.max(0, Math.min(1, Number(s.percent ?? 0)));
    const pctText = `${(percent * 100).toFixed(1)}%`;
    const doneClips = Number(s.done_clips ?? 0);
    const totalClips = Number(s.total_clips ?? 0);
    const current = String(s.current || '').trim();
    const eta = String(s.eta_human || '').trim();

    // 1. 更新悬浮挂件
    if (running) {
        updateFloatingWidget(true, `${stageText} ${pctText}`, true);
        if (mergeAllBtn) {
            // 保持按钮可用，允许继续提交任务加入队列
            mergeAllBtn.disabled = false;
            mergeAllBtn.textContent = (stageRaw === 'merging') ? '正在合并中...' : (stageRaw === 'queued') ? '排队中...' : '正在处理中...';
        }
    } else {
        // 非运行状态：优先用 merge_status 自己渲染终态，避免 pollJob 因 404/多进程等原因失效导致 UI 卡在“合并中”。
        __renderMergeTerminalFromMergeStatus(s);

        // 若未授权/无 token，则隐藏悬浮挂件，避免一直显示旧状态
        try {
            const token = String(__getMergeToken() || '').trim();
            if (!token && !__mergeStatusPollInFlight) {
                updateFloatingWidget(false);
            }
        } catch (e) { }
    }

    // 2. 更新弹窗内容 (仅当任务正在运行或处于中间状态时)
    if (running && progressModalBody) {
        const username = String(s.username || '').trim() || '未知用户';
        const clipsList = Array.isArray(s.clips) ? s.clips : [];

        // 若卡片结构不存在则创建一次（避免每次 poll 重建导致 transition 失效）
        let card = progressModalBody.querySelector('.mp-card');
        if (!card) {
            progressModalBody.innerHTML = `
                <div class="mp-card">
                    <div class="mp-header">
                        <div class="mp-stage"></div>
                        <div class="mp-overall-pct">0%</div>
                        <div class="mp-speed-chip" data-empty="1" hidden title="ffmpeg 处理速度，>1x 表示比实时快">
                            <span class="mp-speed-chip-label">速度</span>
                            <span class="mp-speed-chip-value">—</span>
                        </div>
                    </div>
                    <div class="mp-overall-track">
                        <div class="mp-overall-fill" style="width:0%"></div>
                    </div>
                    <div class="mp-eta-row">
                        <span class="mp-eta-label">预计剩余</span>
                        <span class="mp-eta-value">—</span>
                    </div>
                    <div class="mp-clips-section">
                        <div class="mp-clips-title">全部片段<span class="mp-clips-count"></span></div>
                        <div class="mp-clips-list" role="list"></div>
                    </div>
                </div>
            `;
            card = progressModalBody.querySelector('.mp-card');
        }

        const stageEl = card.querySelector('.mp-stage');
        const etaValEl = card.querySelector('.mp-eta-value');
        const clipsCountEl = card.querySelector('.mp-clips-count');
        const speedChip = card.querySelector('.mp-speed-chip');
        const speedChipVal = card.querySelector('.mp-speed-chip-value');
        const clipsListEl = card.querySelector('.mp-clips-list');

        if (stageEl) stageEl.textContent = stageText || '处理中';
        const overallFill = card.querySelector('.mp-overall-fill');
        const overallPct = card.querySelector('.mp-overall-pct');
        if (overallFill) overallFill.style.width = pctText;
        if (overallPct) overallPct.textContent = pctText;
        if (etaValEl) etaValEl.textContent = eta || '计算中...';
        if (clipsCountEl) {
            if (totalClips > 0) {
                clipsCountEl.textContent = `（${doneClips}/${totalClips}）`;
            } else {
                clipsCountEl.textContent = '';
            }
        }

        // 在 header 右上角显示 ffmpeg speed（从 stats 字符串里抓 speed=…x）
        if (speedChip && speedChipVal) {
            const stats = String((s && s.ffmpeg_stats) || '').trim();
            const m = stats.match(/speed=([0-9]*\.?[0-9]+)\s*x/i);
            const speedVal = m ? (m[1] + 'x') : '';
            if (speedVal) {
                if (speedChipVal.textContent !== speedVal) speedChipVal.textContent = speedVal;
                speedChip.setAttribute('data-empty', '0');
                speedChip.hidden = false;
            } else {
                speedChipVal.textContent = '—';
                speedChip.setAttribute('data-empty', '1');
                speedChip.hidden = true;
            }
        }

        // 渲染"全部片段"紧凑网格，或合并阶段显示合并进度
        if (clipsListEl) {
            if (stageRaw === 'merging') {
                // 合并阶段：显示合并进度条，不显示片段网格
                const mergeSeconds = Number(s.processed_seconds ?? 0);
                const totalSeconds = Number(s.total_seconds ?? 1);
                const mergePct = totalSeconds > 0 ? Math.min(1, mergeSeconds / totalSeconds) : 0;
                clipsListEl.innerHTML =
                    `<div class="mp-merge-section">
                        <div class="mp-merge-title">合并音视频</div>
                        <div class="mp-merge-bar-wrap">
                            <div class="mp-merge-bar-fill" style="width:${(mergePct * 100).toFixed(1)}%"></div>
                        </div>
                        <div class="mp-merge-info">${__formatClipTime(mergeSeconds)} / ${__formatClipTime(totalSeconds)}</div>
                    </div>`;
            } else {
                __renderClipList(clipsListEl, clipsList);
            }
        }

    }

}

function __formatClipTime(t) {
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0) return '00:00';
    const total = Math.floor(n);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (x) => String(x).padStart(2, '0');
    if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`;
    return `${pad(m)}:${pad(s)}`;
}

function __renderClipList(container, clips) {
    // 已有行：按 data-index 复用；缺失行：append；多余行：remove
    const existingRows = new Map();
    container.querySelectorAll('.mp-clip-row').forEach((row) => {
        const k = row.getAttribute('data-index');
        if (k !== null) existingRows.set(k, row);
    });

    const seen = new Set();
    clips.forEach((c, i) => {
        const idx = String(c && c.index !== undefined ? c.index : i);
        seen.add(idx);

        let row = existingRows.get(idx);
        if (!row) {
            row = document.createElement('div');
            row.className = 'mp-clip-row';
            row.setAttribute('data-index', idx);
            row.setAttribute('data-status', 'pending');
            row.setAttribute('role', 'listitem');
            row.innerHTML = `
                <div class="mp-clip-idx"></div>
                <div class="mp-clip-status"></div>
                <div class="mp-clip-meta">
                    <div class="mp-clip-name"></div>
                    <div class="mp-clip-time"></div>
                </div>
                <div class="mp-clip-bar-wrap mp-clip-bar-pending">
                    <div class="mp-clip-bar"><div class="mp-clip-bar-fill" style="width:0%"></div></div>
                    <div class="mp-clip-pct"></div>
                </div>
            `;
            container.appendChild(row);
        }

        const status = String(c && c.status || 'pending').toLowerCase();
        const progress = Math.max(0, Math.min(1, Number((c && c.progress) || 0)));
        const videoName = String((c && c.video) || '');
        const startT = c && c.start !== undefined ? c.start : 0;
        const endT = c && c.end !== undefined ? c.end : 0;
        const totalInVideo = (c && c.total_in_video) || 0;
        const clipInVideo = (c && c.clip_index_in_video) || 0;
        const total = clips.length;

        const idxEl = row.querySelector('.mp-clip-idx');
        const statusEl = row.querySelector('.mp-clip-status');
        const nameEl = row.querySelector('.mp-clip-name');
        const timeEl = row.querySelector('.mp-clip-time');
        const barWrap = row.querySelector('.mp-clip-bar-wrap');
        const barFill = row.querySelector('.mp-clip-bar-fill');
        const pctTxt = row.querySelector('.mp-clip-pct');

        if (idxEl) idxEl.textContent = `[${(c && c.global_index) || (i + 1)}/${total}]`;
        if (statusEl) {
            const icon = status === 'done' ? '✓'
                : status === 'running' ? '▶'
                    : '○';
            statusEl.textContent = icon;
            statusEl.className = 'mp-clip-status mp-clip-status-' + status;
        }
        if (nameEl) {
            const label = totalInVideo > 1
                ? `${videoName} · ${clipInVideo}/${totalInVideo}`
                : videoName;
            nameEl.textContent = label;
            nameEl.title = label;
        }
        if (timeEl) timeEl.textContent = `${__formatClipTime(startT)} – ${__formatClipTime(endT)}`;
        if (pctTxt) pctTxt.textContent = `${(progress * 100).toFixed(0)}%`;

        // 先更新状态类（影响背景/颜色/光晕），再设置 bar 宽度
        if (barWrap) {
            barWrap.className = 'mp-clip-bar-wrap mp-clip-bar-' + status;
            barWrap.setAttribute('data-status', status);
        }
        if (row && row.getAttribute('data-status') !== status) {
            row.setAttribute('data-status', status);
        }

        // 直接设置内联 width:%（最稳的进度条实现，不依赖 transform 渲染路径）
        if (barFill) {
            const w = progress * 100;  // 0..100
            const wp = w.toFixed(2) + '%';
            try {
                barFill.style.width = wp;
                barFill.style.minWidth = w > 0 ? '2px' : '0px';
                barFill.style.transform = 'none';
                barFill.style.transformOrigin = '';
                barFill.setAttribute('data-progress', w.toFixed(1));
                barFill.setAttribute('data-w', wp);
                barFill.setAttribute('data-status', status);
            } catch (e) {
                // 静默忽略单个 bar 的错误
            }
        }
    });

    // 移除多余的行（状态变化时数量减少等边界情况）
    existingRows.forEach((row, k) => {
        if (!seen.has(k)) row.remove();
    });
}

function __startMergeStatusPolling(opts = {}) {
    const forceFast = opts && opts.forceFast === true;
    __mergeStatusPollDesired = true;

    // 如果已有定时器（尤其是后台的长定时器），先清除，以便立即刷新
    if (__mergeStatusPollTimer) {
        clearTimeout(__mergeStatusPollTimer);
        __mergeStatusPollTimer = null;
    }

    // 先立即拉一次；后续根据状态自适应调度/停止
    __mergeStatusTick({ forceFast });
}

// 从后台切回前台时补一次刷新
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        // 切回前台时补一次刷新；若发现正在合并，会自动进入轮询
        __startMergeStatusPolling({ forceFast: true });
    }
});

function __setVideoContainerExpanded(expanded) {
    if (!videoContainer) return;
    videoContainer.classList.toggle('video-container-expanded', !!expanded);
    videoContainer.classList.toggle('video-container-compact', !expanded);

    // 把紧凑模式的“选择视频”按钮在标题与预览下方之间切换（保留同一 DOM 节点，事件监听不受影响）
    try {
        const btn = document.getElementById('openFileTreeBtnCompact');
        if (!btn) return;
        const panelTitle = videoContainer.querySelector('.panel-title');
        if (!panelTitle) return;

        if (!expanded) {
            // 紧凑（或折叠）状态：把按钮移到 #videoContainer 下，样式会把它显示在预览下方
            if (btn.parentElement !== videoContainer) videoContainer.appendChild(btn);
            btn.classList.add('moved-below');
        } else {
            // 展开状态：把按钮移回标题区（恢复原来位置）
            if (btn.parentElement !== panelTitle) panelTitle.appendChild(btn);
            btn.classList.remove('moved-below');
        }
    } catch (e) { /* ignore */ }
    // 更新小屏提示文本（指示宽 / 高 哪个不足）
    try { if (typeof updatePreviewEmptyHint === 'function') updatePreviewEmptyHint(); } catch (e) { /* ignore */ }
}

// ------------------ 预览播放进度保存/恢复 ------------------
// 说明：仅针对“预览”播放行为做续播；数据保存在浏览器 localStorage。
// 只保存“一条记录”（最后一次预览的视频 + 其播放时间）。
const VIDEO_PROGRESS_SINGLE_KEY = 'videoProgress:single';
const VIDEO_PROGRESS_SAVE_INTERVAL_MS = 2000; // 节流保存频率
const VIDEO_PROGRESS_MIN_SAVE_SECONDS = 2; // 太靠前不保存
const VIDEO_PROGRESS_CLEAR_NEAR_END_SECONDS = 3; // 接近结束自动清除进度

let __restoreProgressForVideo = null;
let __lastProgressSaveAt = 0;
let __mainPreviewActive = false;

let __rvfcActive = false;
let __rvfcLastMediaTime = null;
let __rvfcSupportsRvfc = false;

function __loadProgressSingle() {
    try {
        const raw = localStorage.getItem(VIDEO_PROGRESS_SINGLE_KEY);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        const name = String(obj?.name || '');
        const t = Number(obj?.t);
        if (!name) return null;
        if (!Number.isFinite(t) || t < 0) return null;
        return { name, t, at: Number(obj?.at) || 0 };
    } catch (e) {
        return null;
    }
}

function __clearProgressSingle() {
    try {
        localStorage.removeItem(VIDEO_PROGRESS_SINGLE_KEY);
    } catch (e) {
        // ignore
    }
}

function __saveProgress(videoName, currentTime, duration, options) {
    if (!videoName) return;
    const opts = options && typeof options === 'object' ? options : {};
    const t = Number(currentTime);
    const d = Number(duration);
    if (!Number.isFinite(t) || t < 0) return;
    if (!opts.allowEarly && t < VIDEO_PROGRESS_MIN_SAVE_SECONDS) return;

    // 播放到末尾附近：认为已看完，清除进度，避免下次从结尾继续
    if (Number.isFinite(d) && d > 0 && t >= Math.max(0, d - VIDEO_PROGRESS_CLEAR_NEAR_END_SECONDS)) {
        const saved = __loadProgressSingle();
        if (saved && saved.name === videoName) {
            __clearProgressSingle();
        }
        return;
    }

    try {
        localStorage.setItem(VIDEO_PROGRESS_SINGLE_KEY, JSON.stringify({
            name: String(videoName),
            t: roundToMs(t),
            at: Date.now(),
        }));
    } catch (e) {
        // ignore
    }
}

function __getCurrentVideoDurationForProgress() {
    try {
        const d = Number(player && player.duration);
        return Number.isFinite(d) && d > 0 ? d : 0;
    } catch (e) {
        return 0;
    }
}

function __getSubtitlePageProgressTime() {
    if (!__subtitleData || !__subtitleData.length) return NaN;
    const firstIdx = __subtitlePageIndex * __subtitlePageSize;
    if (firstIdx < 0 || firstIdx >= __subtitleData.length) return NaN;

    try {
        const t = Number(player && player.currentTime);
        const idx = Number.isFinite(t) ? __findSubtitleIndex(t) : -1;
        if (idx >= firstIdx && idx < Math.min(__subtitleData.length, firstIdx + __subtitlePageSize)) {
            return t;
        }
    } catch (e) { }

    return Number(__subtitleData[firstIdx].start);
}

function __saveSubtitlePageProgress() {
    const t = __getSubtitlePageProgressTime();
    if (!Number.isFinite(t) || t < 0) return;
    __saveProgress(currentVideoName, t, __getCurrentVideoDurationForProgress(), { allowEarly: true });
}

function __saveSubtitleIndexProgress(idx) {
    if (!__subtitleData || idx < 0 || idx >= __subtitleData.length) return;
    const t = Number(__subtitleData[idx].start);
    if (!Number.isFinite(t) || t < 0) return;
    __saveProgress(currentVideoName, t, __getCurrentVideoDurationForProgress(), { allowEarly: true });
}

function __maybeRestoreProgress() {
    if (!__restoreProgressForVideo) return;
    if (!currentVideoName || __restoreProgressForVideo !== currentVideoName) return;

    const saved = __loadProgressSingle();
    __restoreProgressForVideo = null;
    if (!saved) return;
    if (saved.name !== currentVideoName) return;

    const d = Number(player.duration);
    const target = Number(saved.t);
    if (!Number.isFinite(target) || target < 0) return;
    if (Number.isFinite(d) && d > 0 && target >= d - VIDEO_PROGRESS_CLEAR_NEAR_END_SECONDS) return;

    // 仅在 metadata ready 后设置 currentTime 才可靠
    try {
        __seekPrecise(target);
        if (typeof progressBar !== 'undefined' && progressBar) {
            progressBar.value = target;
            updateProgress(target, player.duration);
        }
        timeDisplay.textContent = `${formatSubtitleTime(target)} / ${formatSubtitleTime(player.duration || 0)}`;
        showToast(`已从上次进度继续：${formatTime(target)}`);
    } catch (e) {
        // ignore
    }
}

// ------------------ 用户名 & 片段列表持久化 ------------------
// 说明：把用户名和 videoTasks(片段列表)持久化到 localStorage，刷新页面不丢。
const CLIP_TOOL_STATE_KEY = 'clipTool:state:v1';
// 用户对“是否自动恢复上次片段列表”的偏好： 'ask' | 'always' | 'never'

// 弹窗处于展示/等待用户选择时，阻止 pagehide/visibility 导致保存覆盖本地已保存的片段列表
let __restorePromptActive = false;
const BILI_UPLOAD_TAGS_KEY = 'biliUpload:tags:v1';
const OUTPUT_HISTORY_KEY = 'clipTool:outputs:v1';
const OUTPUT_HISTORY_AUTOFILL_SUPPRESS_KEY = 'clipTool:outputs:autofill_suppress:v1';

function __isOutputHistoryAutofillSuppressed() {
    try {
        return String(localStorage.getItem(OUTPUT_HISTORY_AUTOFILL_SUPPRESS_KEY) || '').trim() === '1';
    } catch (e) {
        return false;
    }
}

function __setOutputHistoryAutofillSuppressed(flag) {
    try {
        if (flag) localStorage.setItem(OUTPUT_HISTORY_AUTOFILL_SUPPRESS_KEY, '1');
        else localStorage.removeItem(OUTPUT_HISTORY_AUTOFILL_SUPPRESS_KEY);
    } catch (e) {
        // ignore
    }
}

function __loadOutputHistory() {
    try {
        const raw = localStorage.getItem(OUTPUT_HISTORY_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return [];
        // shape: [{file, at}]
        const out = [];
        for (const it of arr) {
            const file = String(it?.file || '').trim();
            const at = Number(it?.at) || 0;
            if (!file) continue;
            out.push({ file, at });
        }
        // 新 -> 旧
        out.sort((a, b) => (b.at || 0) - (a.at || 0));
        return out;
    } catch (e) {
        return [];
    }
}

function __saveOutputHistory(list) {
    try {
        localStorage.setItem(OUTPUT_HISTORY_KEY, JSON.stringify(list || []));
    } catch (e) {
        // ignore
    }

    // 历史为空：视为用户主动清空，禁止通过 merge_status 自动回填旧记录。
    // 历史非空：允许自动回填（例如页面刷新时补写“刚完成但 pollJob 未跑完”的记录）。
    try {
        const n = Array.isArray(list) ? list.length : 0;
        __setOutputHistoryAutofillSuppressed(n === 0);
    } catch (e) {
        // ignore
    }
}

function __addOutputToHistory(file) {
    const f = String(file || '').trim();
    if (!f) return;
    const list = __loadOutputHistory();
    // 去重：同名只保留一条（更新时间）
    const now = Date.now();
    const filtered = list.filter(x => x.file !== f);
    filtered.unshift({ file: f, at: now });
    // 限制数量，避免无限增长
    const MAX_ITEMS = 20;
    __saveOutputHistory(filtered.slice(0, MAX_ITEMS));
}

// ------------------ 历史输出弹窗 ------------------
let __historyModalInited = false;
let __historyModalEls = null;

function __initHistoryModalOnce() {
    if (__historyModalInited) return;

    const overlay = document.getElementById('historyModalOverlay');
    const closeX = document.getElementById('historyModalCloseX');
    const closeBtn = document.getElementById('historyModalClose');
    const body = document.getElementById('historyModalBody');
    const title = document.getElementById('historyModalTitle');

    if (!overlay || !closeX || !closeBtn || !body || !title) return;

    __historyModalEls = { overlay, closeX, closeBtn, body, title };
    __historyModalInited = true;

    const closeModal = () => {
        __safeHideOverlay(overlay);
    };

    closeX.addEventListener('click', closeModal);
    closeBtn.addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeModal();
    });
    document.addEventListener('keydown', (e) => {
        if (!overlay.classList.contains('show')) return;
        if (e.key === 'Escape') closeModal();
    });
}

function __openHistoryModal() {
    __initHistoryModalOnce();
    if (!__historyModalEls) {
        showToast('历史输出弹窗初始化失败');
        return;
    }
    const myModalId = (window.__modalSeq = (window.__modalSeq || 0) + 1);
    __historyModalEls.overlay.__previouslyFocused = document.activeElement;
    __historyModalEls.overlay.__modalId = myModalId;
    __historyModalEls.overlay.classList.add('show');
    __historyModalEls.overlay.setAttribute('aria-hidden', 'false');
    __renderOutputHistory();
}

if (openHistoryBtn) {
    openHistoryBtn.addEventListener('click', () => __openHistoryModal());
}

// ------------------ 投稿弹窗（替代页面内展开表单） ------------------
let __uploadModalInited = false;
let __uploadModalUploading = false;
let __uploadModalFileName = '';
let __uploadModalEls = null;
let __uploadModalTags = [];

let __uploadPollTimer = null;
let __uploadPollInFlight = false;

function __getUploadToken() {
    const key = 'bililive_upload_token';
    try {
        return String(localStorage.getItem(key) || '').trim();
    } catch (e) {
        return '';
    }
}

function __setUploadToken(token) {
    const key = 'bililive_upload_token';
    const t = String(token || '').trim();
    try {
        if (t) localStorage.setItem(key, t);
        else localStorage.removeItem(key);
    } catch (e) { }
}

function __stopUploadPolling() {
    if (__uploadPollTimer) clearTimeout(__uploadPollTimer);
    __uploadPollTimer = null;
}

async function __fetchUploadStatus() {
    const token = __getUploadToken();
    const url = token ? `/api/upload_status?upload_token=${encodeURIComponent(token)}` : '/api/upload_status';
    try {
        const res = await fetch(url, { cache: 'no-store' });
        return await res.json();
    } catch (e) {
        return { running: false };
    }
}

function __renderUploadProgress(state, resultEl) {
    const s = state && typeof state === 'object' ? state : { running: false };
    const running = s.running === true;
    const status = String(s.status || '').toLowerCase();
    const pct = Math.max(0, Math.min(1, Number(s.percent ?? 0)));
    const pctText = `${(pct * 100).toFixed(1)}%`;
    const speed = String(s.speed || '').trim();
    const eta = String(s.eta || '').trim();
    const progressLine = String(s.progress_line || '').trim();
    const logs = Array.isArray(s.logs) ? s.logs : [];

    const metaParts = [];
    if (speed) metaParts.push(`速度：${speed}`);
    if (eta) metaParts.push(`剩余：${eta}`);
    const metaText = metaParts.join(' · ');
    const safeLogs = logs.slice(-200).reverse().map(x => String(x)).join('\\n');
    const rawLineHtml = progressLine
        ? `<div class="upload-progress-rawline">${__escapeHtml(progressLine)}</div>`
        : '<div class="upload-progress-rawline" style="opacity:0.55;">（等待输出…）</div>';

    if (!running && !status) {
        resultEl.innerHTML = '';
        return;
    }

    if (status === 'done') {
        resultEl.innerHTML = `
            <div class="upload-progress">
                <div class="upload-progress-top">
                    <div class="upload-progress-title" style="color:rgba(140,255,140,0.95);">投稿完成</div>
                    <div class="upload-progress-percent">100.0%</div>
                </div>
                <div class="upload-progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100">
                    <div class="upload-progress-bar-fill" style="width:100%;"></div>
                </div>
                <div class="upload-progress-meta">${__escapeHtml(metaText)}</div>
                ${rawLineHtml}
                ${safeLogs ? `<pre class="upload-progress-logs">${__escapeHtml(safeLogs)}</pre>` : ''}
            </div>
        `;
        return;
    }
    if (status === 'error') {
        const err = String(s.error || '').trim();
        const errHtml = err ? `投稿失败：\n${__escapeHtml(err)}` : '投稿失败';
        resultEl.innerHTML = `
            <pre style="color:red;">${errHtml}</pre>
            <div class="upload-progress">
                <div class="upload-progress-top">
                    <div class="upload-progress-title">错误详情</div>
                    <div class="upload-progress-percent">${pctText}</div>
                </div>
                <div class="upload-progress-meta">${__escapeHtml(metaText)}</div>
                ${rawLineHtml}
                ${safeLogs ? `<pre class="upload-progress-logs">${__escapeHtml(safeLogs)}</pre>` : ''}
            </div>
        `;
        return;
    }
    if (status === 'cancelled') {
        resultEl.innerHTML = `
            <div class="upload-progress">
                <div class="upload-progress-top">
                    <div class="upload-progress-title" style="color:#ffb0b0;">已停止投稿</div>
                    <div class="upload-progress-percent">${pctText}</div>
                </div>
                <div class="upload-progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${(pct * 100).toFixed(1)}">
                    <div class="upload-progress-bar-fill" style="width:${(pct * 100).toFixed(2)}%;"></div>
                </div>
                <div class="upload-progress-meta">${__escapeHtml(metaText)}</div>
                ${rawLineHtml}
                ${safeLogs ? `<pre class="upload-progress-logs">${__escapeHtml(safeLogs)}</pre>` : ''}
            </div>
        `;
        return;
    }

    resultEl.innerHTML = `
        <div class="upload-progress">
            <div class="upload-progress-top">
                <div class="upload-progress-title">投稿中</div>
                <div class="upload-progress-percent">${pctText}</div>
            </div>
            <div class="upload-progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${(pct * 100).toFixed(1)}">
                <div class="upload-progress-bar-fill" style="width:${(pct * 100).toFixed(2)}%;"></div>
            </div>
            <div class="upload-progress-meta">${__escapeHtml(metaText)}</div>
            ${rawLineHtml}
            <pre class="upload-progress-logs">${__escapeHtml(safeLogs)}</pre>
        </div>
    `;
}

async function __uploadPollTick(resultEl, submitBtn, stopBtn, hintEl, setDisabled) {
    if (__uploadPollInFlight) {
        __uploadPollTimer = setTimeout(() => __uploadPollTick(resultEl, submitBtn, stopBtn, hintEl, setDisabled), 800);
        return;
    }

    __uploadPollInFlight = true;
    const s = await __fetchUploadStatus();
    __uploadPollInFlight = false;

    __renderUploadProgress(s, resultEl);
    const status = String(s?.status || '').toLowerCase();
    const running = s?.running === true;

    if (running) {
        hintEl.style.display = 'block';
        hintEl.textContent = '投稿进行中（实时进度/日志），如卡住可停止投稿。';
        submitBtn.textContent = '投稿中...';
        submitBtn.disabled = true;
        stopBtn.style.display = '';
        stopBtn.disabled = false;
        setDisabled(true);
        __uploadModalUploading = true;
        __uploadPollTimer = setTimeout(() => __uploadPollTick(resultEl, submitBtn, stopBtn, hintEl, setDisabled), 1000);
        return;
    }

    __stopUploadPolling();
    __uploadModalUploading = false;

    if (status === 'done') {
        hintEl.style.display = 'none';
        stopBtn.style.display = 'none';
        submitBtn.textContent = '投稿成功！';
        submitBtn.disabled = true;
        __setUploadToken('');
        return;
    }
    if (status === 'cancelled') {
        hintEl.style.display = 'none';
        stopBtn.style.display = 'none';
        submitBtn.textContent = '重新投稿';
        submitBtn.disabled = false;
        setDisabled(false);
        __setUploadToken('');
        const reason = String(s?.cancel_reason || '').toLowerCase();
        if (reason === 'user') {
            showToast('取消成功');
        }
        return;
    }

    // error 或其他终态
    hintEl.style.display = 'none';
    stopBtn.style.display = 'none';
    submitBtn.textContent = '重新投稿';
    submitBtn.disabled = false;
    setDisabled(false);
    __setUploadToken('');
}

const BILI_TAG_MAX_COUNT = 10;
const BILI_TAG_MAX_LEN = 20;

function __escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function __splitTags(raw) {
    const s0 = String(raw ?? '').trim();
    if (!s0) return [];
    const s = s0
        .replace(/\\r/g, '\\n')
        .replace(/[，、；;]/g, ',')
        .replace(/\\n/g, ' ');
    return s
        .split(/[\\s,]+/)
        .map(x => String(x || '').trim())
        .filter(Boolean);
}

function __dedupeTags(tags) {
    const out = [];
    const seen = new Set();
    for (const t of (tags || [])) {
        const tag = String(t || '').trim();
        if (!tag) continue;
        const key = tag.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(tag);
    }
    return out;
}

function __resetUploadModalTagsFromRaw(raw) {
    __uploadModalTags = __dedupeTags(__splitTags(raw)).slice(0, BILI_TAG_MAX_COUNT);
}

function __renderUploadModalTagsUi(tagsChips, tagsInput, tagsHint) {
    const arr = Array.isArray(__uploadModalTags) ? __uploadModalTags : [];
    const chipsHtml = arr.map((t, i) => {
        const safe = __escapeHtml(t);
        return `<span class="bili-tag-chip" data-i="${i}">${safe}<button type="button" class="bili-tag-remove" data-i="${i}" aria-label="删除">×</button></span>`;
    }).join('');
    tagsChips.innerHTML = chipsHtml;

    if (arr.length >= BILI_TAG_MAX_COUNT) {
        tagsInput.placeholder = `最多 ${BILI_TAG_MAX_COUNT} 个标签`;
    } else {
        tagsInput.placeholder = '回车添加标签，支持空格/逗号';
    }
    tagsHint.textContent = `已添加 ${arr.length}/${BILI_TAG_MAX_COUNT} 个；回车/空格/逗号添加，退格删除最后一个。`;
}

function __initUploadModalOnce() {
    if (__uploadModalInited) return;

    const overlay = document.getElementById('uploadModalOverlay');
    const closeX = document.getElementById('uploadModalCloseX');
    const cancelBtn = document.getElementById('uploadModalCancel');
    const stopBtn = document.getElementById('uploadModalStop');
    const submitBtn = document.getElementById('uploadModalSubmit');
    const fileEl = document.getElementById('uploadModalFile');
    const titleInput = document.getElementById('uploadModalTitle');
    const descInput = document.getElementById('uploadModalDesc');
    const tagsEditor = document.getElementById('uploadModalTagsEditor');
    const tagsChips = document.getElementById('uploadModalTagsChips');
    const tagsInput = document.getElementById('uploadModalTags');
    const tagsHint = document.getElementById('uploadModalTagsHint');
    const hintEl = document.getElementById('uploadModalHint');
    const resultEl = document.getElementById('uploadModalResult');

    if (!overlay || !closeX || !cancelBtn || !stopBtn || !submitBtn || !fileEl || !titleInput || !descInput || !tagsEditor || !tagsChips || !tagsInput || !tagsHint || !hintEl || !resultEl) {
        return;
    }

    __uploadModalEls = { overlay, closeX, cancelBtn, stopBtn, submitBtn, fileEl, titleInput, descInput, tagsEditor, tagsChips, tagsInput, tagsHint, hintEl, resultEl };
    __uploadModalInited = true;

    const renderTags = () => __renderUploadModalTagsUi(tagsChips, tagsInput, tagsHint);

    const persistTags = () => {
        __saveBiliUploadTags((__uploadModalTags || []).join(' '));
    };

    const setTagsFromRaw = (raw) => {
        __resetUploadModalTagsFromRaw(raw);
        renderTags();
        persistTags();
    };

    const addTagsFromRaw = (raw) => {
        const incoming = __splitTags(raw);
        if (!incoming.length) return;

        const current = Array.isArray(__uploadModalTags) ? __uploadModalTags.slice() : [];
        const merged = current.concat(incoming);
        const deduped = __dedupeTags(merged);

        // 单标签长度限制
        for (const t of deduped) {
            if (String(t).length > BILI_TAG_MAX_LEN) {
                showToast(`标签过长（最多${BILI_TAG_MAX_LEN}字）：${t}`);
                return;
            }
        }

        if (deduped.length > BILI_TAG_MAX_COUNT) {
            showToast(`标签最多 ${BILI_TAG_MAX_COUNT} 个`);
            __uploadModalTags = deduped.slice(0, BILI_TAG_MAX_COUNT);
        } else {
            __uploadModalTags = deduped;
        }

        renderTags();
        persistTags();
    };

    const setDisabled = (disabled) => {
        titleInput.disabled = !!disabled;
        descInput.disabled = !!disabled;
        tagsInput.disabled = !!disabled;
        tagsEditor.classList.toggle('disabled', !!disabled);
        submitBtn.disabled = !!disabled;
    };

    const closeModal = async (force = false) => {
        if (!force && __uploadModalUploading) {
            const ok = await showConfirmModal('正在投稿中，确定要关闭投稿窗口吗？', {
                title: '确认关闭',
                okText: '关闭',
                cancelText: '继续投稿',
            });
            if (!ok) return;
        }

        __uploadModalUploading = false;
        __uploadModalFileName = '';
        setDisabled(false);
        __stopUploadPolling();
        hintEl.style.display = 'none';
        __safeHideOverlay(overlay);
    };

    // 标签编辑器交互（B站式 chip 输入）
    tagsEditor.addEventListener('click', () => {
        if (tagsInput.disabled) return;
        tagsInput.focus();
    });

    tagsChips.addEventListener('click', (e) => {
        const btn = e.target?.closest?.('.bili-tag-remove');
        if (!btn) return;
        if (tagsInput.disabled) return;
        const i = Number(btn.getAttribute('data-i'));
        if (!Number.isFinite(i)) return;
        __uploadModalTags = (__uploadModalTags || []).filter((_, idx) => idx !== i);
        renderTags();
        persistTags();
        tagsInput.focus();
    });

    tagsInput.addEventListener('keydown', (e) => {
        if (e.isComposing) return;

        // 回车 / 逗号 / 空格：提交当前输入为标签
        if (e.key === 'Enter' || e.key === ',' || e.key === '，' || e.key === ' ' || e.key === ';' || e.key === '；') {
            const raw = String(tagsInput.value || '').trim();
            if (raw) {
                e.preventDefault();
                addTagsFromRaw(raw);
                tagsInput.value = '';
                return;
            }
        }

        // 退格：空输入时删除最后一个标签
        if (e.key === 'Backspace') {
            const raw = String(tagsInput.value || '');
            if (!raw && (__uploadModalTags || []).length) {
                __uploadModalTags = (__uploadModalTags || []).slice(0, -1);
                renderTags();
                persistTags();
            }
        }
    });

    tagsInput.addEventListener('paste', (e) => {
        if (tagsInput.disabled) return;
        const text = e.clipboardData?.getData?.('text');
        if (!text) return;
        e.preventDefault();
        addTagsFromRaw(text);
        tagsInput.value = '';
    });

    tagsInput.addEventListener('blur', () => {
        const raw = String(tagsInput.value || '').trim();
        if (raw) {
            addTagsFromRaw(raw);
            tagsInput.value = '';
        }
    });

    // 初始化一次渲染
    setTagsFromRaw(__loadBiliUploadTags());

    submitBtn.addEventListener('click', async () => {
        const fileName = String(__uploadModalFileName || '').trim();
        const title = String(titleInput.value || '').trim();
        const desc = String(descInput.value || '').trim();

        // 若输入框里还有未提交的内容，先吞进去
        const pending = String(tagsInput.value || '').trim();
        if (pending) {
            addTagsFromRaw(pending);
            tagsInput.value = '';
        }

        const tags = (__uploadModalTags || []).join(',');
        __saveBiliUploadTags((__uploadModalTags || []).join(' '));

        if (!fileName || !title) {
            showToast('标题不能为空');
            titleInput.focus();
            return;
        }

        // 禁用表单，显示投稿提示 **仅在验证通过后**
        __uploadModalUploading = true;
        setDisabled(true);
        submitBtn.textContent = '投稿中...';
        hintEl.style.display = 'block';
        hintEl.textContent = '投稿过程中可能会因为网络原因出现异常提示，不用担心，投稿正在进行中，可以联系xct258获取帮助...';
        resultEl.innerHTML = '';
        stopBtn.style.display = '';
        stopBtn.disabled = false;

        const userName = (document.getElementById('usernameInput')?.value || '').trim();
        const fullDesc = `投稿用户：${userName}\n\n${desc}\n\n使用投稿工具投稿\n\n项目地址：\nhttps://github.com/xct258/web-video-clip`;

        try {
            const formData = new FormData();
            formData.append('file', fileName);
            formData.append('title', title);
            formData.append('description', fullDesc);
            formData.append('tags', tags);

            const coverInput = document.getElementById('uploadModalCover');
            if (coverInput && coverInput.files && coverInput.files[0]) {
                const f = coverInput.files[0];
                if (!f.type.startsWith('image/')) {
                    showToast('封面必须是图片格式');
                    titleInput.focus();
                    setDisabled(false);
                    submitBtn.textContent = '投稿到B站';
                    hintEl.style.display = 'none';
                    stopBtn.style.display = 'none';
                    __uploadModalUploading = false;
                    return;
                }
                if (f.size > 5 * 1024 * 1024) {
                    showToast('封面图片不能超过 5MB');
                    titleInput.focus();
                    setDisabled(false);
                    submitBtn.textContent = '投稿到B站';
                    hintEl.style.display = 'none';
                    stopBtn.style.display = 'none';
                    __uploadModalUploading = false;
                    return;
                }
                formData.append('cover', f);

            }

            const res = await fetch('/api/upload_bili', {
                method: 'POST',
                body: formData
            });
            const data = await res.json();

            if (!data.success) {
                __uploadModalUploading = false;
                submitBtn.textContent = '重新投稿';
                setDisabled(false);
                stopBtn.style.display = 'none';
                resultEl.innerHTML = `<pre style="color:red;">投稿失败：\n${data.error || data.message}</pre>`;
                return;
            }

            // 测试模式：直接展示命令预览
            if (data.cmd_preview && !data.upload_token) {
                __uploadModalUploading = false;
                submitBtn.textContent = '投稿成功！';
                submitBtn.disabled = true;
                hintEl.style.display = 'none';
                stopBtn.style.display = 'none';
                resultEl.innerHTML = `<pre style="color:green;">测试模式（未实际上传）：\n${data.cmd_preview}</pre>`;
                return;
            }

            // 真实上传：保存 token 并轮询进度
            __setUploadToken(data.upload_token || '');
            __stopUploadPolling();
            __uploadPollTimer = setTimeout(() => __uploadPollTick(resultEl, submitBtn, stopBtn, hintEl, setDisabled), 200);
        } catch (e) {
            console.error(e);
            __uploadModalUploading = false;
            submitBtn.textContent = '重新投稿';
            setDisabled(false);
            stopBtn.style.display = 'none';
            resultEl.innerHTML = `<pre style="color:red;">投稿异常：\n${e}</pre>`;
        }
    });

    stopBtn.addEventListener('click', async () => {
        if (!__uploadModalUploading) return;
        const ok = await showConfirmModal('确定要停止当前投稿吗？', {
            title: '停止投稿',
            okText: '停止投稿',
            cancelText: '继续投稿',
        });
        if (!ok) return;

        try {
            stopBtn.disabled = true;
            const token = __getUploadToken();
            const res = await fetch('/api/cancel_upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ upload_token: token || null }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                showToast(data.detail || data.message || '停止失败');
                stopBtn.disabled = false;
                return;
            }
            showToast('已发送停止请求');
            __stopUploadPolling();
            __uploadPollTimer = setTimeout(() => __uploadPollTick(resultEl, submitBtn, stopBtn, hintEl, setDisabled), 300);
        } catch (e) {
            showToast('停止失败');
            stopBtn.disabled = false;
        }
    });

    cancelBtn.addEventListener('click', () => closeModal(false));
    closeX.addEventListener('click', () => closeModal(false));
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeModal(false);
    });
    document.addEventListener('keydown', (e) => {
        if (!overlay.classList.contains('show')) return;
        if (e.key === 'Escape') closeModal(false);
    });

    // 封面上传交互逻辑
    const coverInput = document.getElementById('uploadModalCover');
    const coverBtn = document.getElementById('uploadModalCoverBtn');
    const coverInfo = document.getElementById('uploadModalCoverInfo');
    const coverFileName = document.getElementById('coverFileName');
    const coverRemoveBtn = document.getElementById('coverRemoveBtn');

    if (coverInput && coverBtn && coverInfo) {
        // 点击按钮触发文件选择
        coverBtn.addEventListener('click', () => coverInput.click());

        // 文件选择变化
        coverInput.addEventListener('change', () => {
            const file = coverInput.files[0];
            if (!file) return;

            if (!file.type.startsWith('image/')) {
                showToast('请选择图片文件');
                coverInput.value = '';
                return;
            }

            // 更新 UI：显示文件名，隐藏上传按钮，显示信息条
            coverFileName.textContent = file.name;
            coverBtn.style.display = 'none';
            coverInfo.style.display = 'flex';
        });

        // 移除封面
        if (coverRemoveBtn) {
            coverRemoveBtn.addEventListener('click', () => {
                coverInput.value = '';
                coverInfo.style.display = 'none';
                coverBtn.style.display = 'flex';
            });
        }
    }
}

function __openUploadModal(fileName) {
    // ensure history/modal overlays are hidden so upload modal isn't obscured
    try {
        const histOverlay = document.getElementById('historyModalOverlay');
        if (histOverlay && histOverlay.classList.contains('show')) {
            __safeHideOverlay(histOverlay);
        }
    } catch (e) { /* ignore */ }

    __initUploadModalOnce();
    if (!__uploadModalEls) {
        showToast('投稿弹窗初始化失败');
        return;
    }

    const { overlay, submitBtn, stopBtn, fileEl, titleInput, descInput, tagsEditor, tagsChips, tagsInput, tagsHint, hintEl, resultEl } = __uploadModalEls;
    const f = String(fileName || '').trim();
    if (!f) {
        showToast('缺少文件名');
        return;
    }

    __uploadModalFileName = f;
    __uploadModalUploading = false;

    fileEl.textContent = f;
    titleInput.value = '';
    descInput.value = '';

    const savedTags = __loadBiliUploadTags();
    __resetUploadModalTagsFromRaw(savedTags || '');
    tagsInput.value = '';
    __renderUploadModalTagsUi(tagsChips, tagsInput, tagsHint);

    // 重置封面选择状态
    const coverInput = document.getElementById('uploadModalCover');
    const coverBtn = document.getElementById('uploadModalCoverBtn');
    const coverInfo = document.getElementById('uploadModalCoverInfo');
    if (coverInput && coverBtn && coverInfo) {
        coverInput.value = '';
        coverInfo.style.display = 'none';
        coverBtn.style.display = 'flex';
    }

    hintEl.style.display = 'none';
    resultEl.innerHTML = '';
    submitBtn.textContent = '投稿到B站';
    submitBtn.disabled = false;
    stopBtn.style.display = 'none';
    stopBtn.disabled = false;

    // 分配一次性 modal token，表示当前上传弹窗为“活跃”实例
    const myModalId = (window.__modalSeq = (window.__modalSeq || 0) + 1);
    overlay.__modalId = myModalId;
    overlay.__previouslyFocused = document.activeElement;

    overlay.classList.add('show');
    overlay.setAttribute('aria-hidden', 'false');
    setTimeout(() => titleInput.focus(), 0);

    // 若存在未完成的投稿（例如页面刷新后），打开弹窗时自动恢复进度展示
    try {
        const token = __getUploadToken();
        if (token) {
            __stopUploadPolling();
            __uploadPollTimer = setTimeout(() => __uploadPollTick(resultEl, submitBtn, stopBtn, hintEl, (d) => {
                titleInput.disabled = !!d;
                descInput.disabled = !!d;
                tagsInput.disabled = !!d;
                tagsEditor.classList.toggle('disabled', !!d);
                submitBtn.disabled = !!d;
            }), 200);
        }
    } catch (e) {
        // ignore
    }
}

function __removeOutputFromHistory(file) {
    const f = String(file || '').trim();
    if (!f) return;
    const list = __loadOutputHistory().filter(x => x.file !== f);
    __saveOutputHistory(list);
}

function __mountUploadForm(containerEl, fileName) {
    __openUploadModal(fileName);
}

function __renderOutputHistory() {
    const host = document.getElementById('historyModalBody');
    if (!host) return;

    const list = __loadOutputHistory();
    if (openHistoryBtn) {
        openHistoryBtn.style.display = list.length ? '' : 'none';
        openHistoryBtn.textContent = list.length ? `历史输出（${list.length}）` : '历史输出';
    }

    if (__historyModalEls && __historyModalEls.title) {
        __historyModalEls.title.textContent = list.length ? `历史输出（${list.length}）` : '历史输出';
    }

    if (!list.length) {
        host.innerHTML = '<div style="text-align:center; padding:18px; opacity:0.75;">暂无历史输出</div>';
        return;
    }

    const itemsHtml = list.map((it) => {
        const file = it.file;
        const safeFile = String(file).replace(/"/g, '&quot;');
        const safeFileName = String(file).split(/[/\\]/).pop().replace(/"/g, '&quot;');
        return `
            <div class="glass" style="padding:10px; margin-top:10px;" data-output-item="${safeFile}">
                <div style="font-weight:bold; white-space:normal; overflow-wrap:anywhere; word-break:break-word; margin-bottom:8px;">${safeFileName}</div>
                <div class="output-status" style="display:none; font-size:12px; color:#ff9999; margin-bottom:6px;">⚠ 文件不存在</div>
                <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; justify-content:flex-end;">
                    <a href="/clips/${encodeURIComponent(file)}" download="${safeFileName}" class="download-link">
                        <button type="button" class="download-btn">下载</button>
                    </a>
                    <button type="button" class="openUploadBtn" data-file="${safeFile}">投稿</button>
                    <button type="button" class="removeOutputBtn" data-file="${safeFile}" style="background:rgba(255, 100, 100, 0.2);">移除</button>
                </div>
            </div>
        `;
    }).join('');

    host.innerHTML = itemsHtml;

    // 异步检查文件是否存在
    host.querySelectorAll('[data-output-item]').forEach(async (item) => {
        const file = item.getAttribute('data-output-item');
        if (!file) return;

        try {
            const res = await fetch(`/api/check_file/${encodeURIComponent(file)}`);
            const data = await res.json();
            const exists = data.exists === true;

            const statusDiv = item.querySelector('.output-status');
            const downloadBtn = item.querySelector('.download-btn');
            const downloadLink = item.querySelector('.download-link');
            const uploadBtn = item.querySelector('.openUploadBtn');

            if (!exists) {
                // 文件不存在
                if (statusDiv) {
                    statusDiv.style.display = 'block';
                }
                if (downloadBtn) {
                    downloadBtn.disabled = true;
                }
                if (downloadLink) {
                    downloadLink.style.pointerEvents = 'none';
                }
                if (uploadBtn) {
                    uploadBtn.disabled = true;
                }
            }
        } catch (e) {
            // 检查失败时假定文件不存在
            const statusDiv = item.querySelector('.output-status');
            const downloadBtn = item.querySelector('.download-btn');
            const downloadLink = item.querySelector('.download-link');
            const uploadBtn = item.querySelector('.openUploadBtn');

            if (statusDiv) {
                statusDiv.style.display = 'block';
                statusDiv.textContent = '⚠ 无法验证文件';
            }
            if (downloadBtn) {
                downloadBtn.disabled = true;
            }
            if (downloadLink) {
                downloadLink.style.pointerEvents = 'none';
            }
            if (uploadBtn) {
                uploadBtn.disabled = true;
            }
        }
    });

    host.querySelectorAll('.removeOutputBtn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const file = String(btn.getAttribute('data-file') || '').trim();
            if (file) {
                try {
                    const res = await fetch('/api/delete_output', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ file }),
                    });
                    await res.json().catch(() => ({}));
                } catch (e) {
                    // ignore
                }
            }

            __removeOutputFromHistory(file);
            __renderOutputHistory();

            // 如果删空了：自动关闭弹窗并隐藏按钮
            if (__loadOutputHistory().length === 0) {
                const overlay = document.getElementById('historyModalOverlay');
                if (overlay) __safeHideOverlay(overlay);
            }
        });
    });

    host.querySelectorAll('.openUploadBtn').forEach(btn => {
        btn.addEventListener('click', () => {
            const file = btn.getAttribute('data-file');
            __openUploadModal(file);
        });
    });
}

function __sanitizeVideoTasks(v) {
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const item of v) {
        if (!item || typeof item !== 'object') continue;
        const name = String(item.name || '').trim();
        if (!name) continue;
        const clipsIn = Array.isArray(item.clips) ? item.clips : [];
        const clips = [];
        for (const c of clipsIn) {
            const start = Number(c?.start);
            const end = Number(c?.end);
            if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
            if (start < 0 || end <= start) continue;
            clips.push({ start, end });
        }
        if (clips.length === 0) continue;
        out.push({ name, clips });
    }
    return out;
}

function __decodeHtmlEntitiesLite(s) {
    return String(s ?? '')
        .replace(/&quot;/g, '"')
        .replace(/&#34;/g, '"')
        .replace(/&#x22;/gi, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/gi, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function __extractBalancedJsonCandidate(text, startIndex) {
    const s = String(text ?? '');
    const open = s[startIndex];
    const close = open === '{' ? '}' : (open === '[' ? ']' : '');
    if (!close) return '';

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = startIndex; i < s.length; i++) {
        const ch = s[i];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }
        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch === open) {
            depth++;
        } else if (ch === close) {
            depth--;
            if (depth === 0) return s.slice(startIndex, i + 1);
        }
    }
    return '';
}

function __tryParseClipImportJson(candidate) {
    const raw = String(candidate ?? '').trim().replace(/^\uFEFF/, '');
    if (!raw) return null;

    const variants = [raw];
    if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
        variants.push(raw.slice(1, -1));
    }
    if (raw.includes('\\"')) {
        variants.push(raw.replace(/\\"/g, '"'));
    }

    for (const v of variants) {
        try {
            const parsed = JSON.parse(v);
            if (typeof parsed === 'string') {
                const inner = parsed.trim();
                if (inner && inner !== v) {
                    try { return JSON.parse(inner); } catch (e) { }
                }
            }
            return parsed;
        } catch (e) {
            // try next variant
        }
    }
    return null;
}

function __extractClipImportJsonCandidates(text) {
    const base = __decodeHtmlEntitiesLite(text).trim();
    if (!base) return [];

    const candidates = [];
    const seen = new Set();
    const push = (v) => {
        const x = String(v ?? '').trim();
        if (!x || seen.has(x)) return;
        seen.add(x);
        candidates.push(x);
    };

    const sources = [base];
    if (base.includes('\\"')) sources.push(base.replace(/\\"/g, '"'));

    for (const s of sources) {
        push(s);

        const commentRe = /(?:TAG:)?comment\s*[:=]\s*/ig;
        let match;
        while ((match = commentRe.exec(s)) && candidates.length < 40) {
            const from = match.index + match[0].length;
            const nextObject = s.indexOf('{', from);
            const nextArray = s.indexOf('[', from);
            const positions = [nextObject, nextArray].filter(i => i >= 0).sort((a, b) => a - b);
            if (!positions.length) continue;
            const candidate = __extractBalancedJsonCandidate(s, positions[0]);
            if (candidate) push(candidate);
        }

        for (let i = 0; i < s.length && candidates.length < 40; i++) {
            if (s[i] !== '{' && s[i] !== '[') continue;
            const candidate = __extractBalancedJsonCandidate(s, i);
            if (!candidate) continue;
            if (candidate.includes('clips') || candidate.includes('schema') || candidate.includes('selected_video') || candidate.includes('source_start') || candidate.includes('"name"')) {
                push(candidate);
            }
        }
    }

    return candidates;
}

function __metadataObjectToVideoTasks(meta) {
    if (!meta || typeof meta !== 'object') return [];
    const clipsIn = Array.isArray(meta.clips) ? meta.clips : [];
    if (!clipsIn.length) return [];

    const grouped = [];
    const byName = new Map();
    const addClip = (name, start, end) => {
        const safeName = String(name || '').trim();
        const s = Number(start);
        let e = Number(end);
        if (!safeName || !Number.isFinite(s)) return;
        if (!Number.isFinite(e)) return;
        if (s < 0 || e <= s) return;
        let item = byName.get(safeName);
        if (!item) {
            item = { name: safeName, clips: [] };
            byName.set(safeName, item);
            grouped.push(item);
        }
        item.clips.push({ start: s, end: e });
    };

    for (const clip of clipsIn) {
        if (!clip || typeof clip !== 'object') continue;
        const name = String(
            clip.selected_video || clip.video || clip.video_name || clip.name || clip.source_video || ''
        ).trim();
        let start = Number(clip.source_start ?? clip.start);
        let end = Number(clip.source_end ?? clip.end);
        if ((!Number.isFinite(start) || !Number.isFinite(end) || end <= start) && Number.isFinite(Number(clip.source_fps))) {
            const fps = Number(clip.source_fps);
            const startFrame = Number(clip.start_frame);
            const endFrame = Number(clip.end_frame);
            if (fps > 0 && Number.isFinite(startFrame) && Number.isFinite(endFrame) && endFrame >= startFrame) {
                start = startFrame / fps;
                end = (endFrame + 1) / fps;
            }
        }
        if (Number.isFinite(start) && (!Number.isFinite(end) || end <= start) && Number.isFinite(Number(clip.duration))) {
            end = start + Number(clip.duration);
        }
        addClip(name, start, end);
    }

    return __sanitizeVideoTasks(grouped);
}

function __collectClipMetadataCommentStrings(value, out = [], depth = 0) {
    if (depth > 8 || value == null) return out;
    if (typeof value === 'string') return out;
    if (Array.isArray(value)) {
        value.forEach(item => __collectClipMetadataCommentStrings(item, out, depth + 1));
        return out;
    }
    if (typeof value !== 'object') return out;
    for (const [key, val] of Object.entries(value)) {
        const k = String(key || '').toLowerCase();
        if (typeof val === 'string' && (k === 'comment' || k === 'description' || k.endsWith(':comment'))) {
            out.push(val);
        } else if (val && typeof val === 'object') {
            __collectClipMetadataCommentStrings(val, out, depth + 1);
        }
    }
    return out;
}

function __coerceClipImportPayloadToVideoTasks(payload, seen = new Set()) {
    const direct = __sanitizeVideoTasks(payload);
    if (direct.length) return direct;

    if (typeof payload === 'string') {
        return __parseClipImportMetadataText(payload, seen);
    }
    if (!payload || typeof payload !== 'object') return [];
    if (seen.has(payload)) return [];
    seen.add(payload);

    for (const key of ['videoTasks', 'videos', 'tasks']) {
        const nested = __sanitizeVideoTasks(payload[key]);
        if (nested.length) return nested;
    }

    const fromMetadata = __metadataObjectToVideoTasks(payload);
    if (fromMetadata.length) return fromMetadata;

    const comments = __collectClipMetadataCommentStrings(payload);
    for (const comment of comments) {
        const fromComment = __parseClipImportMetadataText(comment, seen);
        if (fromComment.length) return fromComment;
    }

    return [];
}

function __parseClipImportMetadataText(text, seen = new Set()) {
    const candidates = __extractClipImportJsonCandidates(text);
    for (const candidate of candidates) {
        const parsed = __tryParseClipImportJson(candidate);
        if (parsed == null) continue;
        const tasks = __coerceClipImportPayloadToVideoTasks(parsed, seen);
        if (tasks.length) return tasks;
    }
    return [];
}

async function __applyImportedVideoTasks(rawTasks, sourceLabel) {
    const imported = __sanitizeVideoTasks(rawTasks);
    if (!imported.length) {
        showToast(`${sourceLabel || '导入内容'}中没有有效片段`, 'warning');
        return false;
    }
    const clipCount = imported.reduce((n, v) => n + v.clips.length, 0);
    const existingCount = __getTotalClipCountFromVideoTasks();
    let doReplace = true;
    if (existingCount > 0) {
        try {
            doReplace = await showConfirmModal(
                `当前有 ${existingCount} 个片段，导入将替换全部。确认导入 ${clipCount} 个新片段？`,
                { title: '导入片段', okText: '替换导入', cancelText: '取消' }
            );
        } catch (e) { doReplace = true; }
    }
    if (!doReplace) return false;
    videoTasks.length = 0;
    videoTasks.push(...imported);
    renderNewClipList();
    __saveClipToolState();
    showToast(`已导入 ${clipCount} 个片段`, 'success');
    return true;
}

async function __loadClipToolState() {
    // 用户名立即恢复，不等待
    try {
        const raw = localStorage.getItem(CLIP_TOOL_STATE_KEY);
        if (raw) {
            const obj = JSON.parse(raw);
            const savedUsername = String(obj?.username ?? '').trim();
            if (usernameInput && savedUsername) {
                usernameInput.value = savedUsername;
            }
        }
    } catch (e) {}

    // 为避免弹窗抢先于页面内容显示，先等待页面完全加载
    if (document.readyState !== 'complete') {
        await new Promise(resolve => window.addEventListener('load', resolve));
    }
    // 额外延迟 1.5 秒再执行恢复逻辑（给出轻微缓冲）
    await new Promise(resolve => setTimeout(resolve, 1500));

    try {
        const raw = localStorage.getItem(CLIP_TOOL_STATE_KEY);
        if (!raw) return;
        const obj = JSON.parse(raw);

        // 检查是否存在已保存的片段列表
        const savedTasks = __sanitizeVideoTasks(obj?.videoTasks);
        if (savedTasks.length > 0) {
            try {
                // 查询后端合并状态：
                // - 运行中（running === true）：自动恢复片段，避免用户错过正在进行的任务
                // - 已完成（status === 'done'）：说明用户很可能已提交并完成合并，自动清空本地保存的片段（保留用户名）
                // - 其它/未知：提示用户是否恢复（原有行为）
                const mergeState = await __fetchMergeStatus();
                const status = String((mergeState && mergeState.status) || '').toLowerCase();

                if (mergeState && mergeState.running === true) {
                    videoTasks = Array.isArray(savedTasks) ? JSON.parse(JSON.stringify(savedTasks)) : [];
                    renderNewClipList();
                    try { __saveClipToolState(); } catch (e) { }
                    try { showToast('检测到正在运行的切片任务，已自动恢复片段', 'info', 3000); } catch (e) { }

                } else if (status === 'done') {
                    // 已完成状态也恢复片段而不自动删除，让用户在结果卡片中选择是否清空
                    try {
                        videoTasks = Array.isArray(savedTasks) ? JSON.parse(JSON.stringify(savedTasks)) : [];
                        renderNewClipList();
                        try { __saveClipToolState(); } catch (e) { }
                        try { showToast('检测到上次合并任务已完成，片段已恢复，可在结果框中选择是否清空', 'info', 4000); } catch (e) { }
                    } catch (e) {
                        // ignore
                    }

                } else {
                    // 其它情况仍然提示用户是否恢复（保持原行为）
                    try { askToRestoreClips(savedTasks); } catch (e) { /* fallback: 不恢复 */ }
                }
            } catch (e) {
                // 若检查失败则回退为弹窗提示（保持向后兼容）
                try { askToRestoreClips(savedTasks); } catch (err) { }
            }
        }
    } catch (e) {
        // ignore
    }
}

/**
 * 在页面加载时询问用户是否恢复上次保存的片段列表
 * - savedTasks: 已清洗合规的片段任务数组
 */
function askToRestoreClips(savedTasks) {
    try {
        // 不再读取或尊重“记住我的选择”偏好：始终提示用户是否恢复已保存片段（不自动恢复/忽略）

        // 构建模态（复用已有 modal 样式），并增加“记住我的选择”复选框 —— 更大且响应式的布局，增强键盘交互
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-labelledby', 'restoreModalTitle');
        overlay.setAttribute('aria-describedby', 'restoreModalDesc');
        overlay.style.zIndex = '11000';

        const modal = document.createElement('div');
        modal.className = 'modal restore-modal';

        modal.innerHTML = `
            <div class="modal-header" style="display:flex; gap:12px; align-items:center;">
                <div aria-hidden="true">⚠️</div>
                <div id="restoreModalTitle">检测到已保存的片段列表</div>
            </div>
            <!-- 片段预览：显示每个视频名及其起止时间（带响应式滚动容器以防过长） -->
            <div id="restoreClipsList" style="margin-top:12px; padding:8px; border-radius:6px; background:rgba(255,255,255,0.02); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.02); font-size:13px;"></div>
            <div class="modal-actions restore-actions" style="padding-top:8px; justify-content:flex-end;">
                <div class="restore-buttons" style="display:flex; gap:10px;">
                    <button class="modal-btn" id="restoreClipsIgnoreBtn">不恢复</button>
                    <button class="modal-btn modal-btn-primary" id="restoreClipsLoadBtn">恢复片段</button>
                </div>
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        // 在提示框中渲染具体片段（起止时间与时长）
        try {
            const listHost = overlay.querySelector('#restoreClipsList');
            if (listHost) {
                if (!Array.isArray(savedTasks) || savedTasks.length === 0) {
                    listHost.innerHTML = '<div style="color:var(--muted-color);">无可恢复的片段</div>';
                } else {
                    const frag = document.createDocumentFragment();
                    savedTasks.forEach(video => {
                        const vidWrap = document.createElement('div');
                        vidWrap.style.marginBottom = '8px';

                        const title = document.createElement('div');
                        title.style.fontWeight = '600';
                        title.style.fontSize = '13px';
                        title.style.marginBottom = '6px';
                        title.style.color = 'var(--accent-color)';
                        title.textContent = video.name || '(unknown)';
                        vidWrap.appendChild(title);

                        (video.clips || []).forEach(c => {
                            const row = document.createElement('div');
                            row.style.display = 'flex';
                            row.style.justifyContent = 'space-between';
                            row.style.gap = '8px';
                            row.style.padding = '4px 6px';
                            row.style.borderRadius = '4px';
                            row.style.background = 'rgba(0,0,0,0.03)';
                            row.style.marginBottom = '6px';

                            const left = document.createElement('div');
                            left.style.fontFamily = 'monospace';
                            left.style.color = 'var(--muted-color)';
                            left.style.fontSize = '13px';
                            left.textContent = `${formatTime(c.start)} ➔ ${formatTime(c.end)}`;

                            const right = document.createElement('div');
                            right.style.fontFamily = 'monospace';
                            right.style.color = 'var(--muted-color)';
                            right.style.fontSize = '12px';
                            const dur = Math.max(0, Number(c.end) - Number(c.start));
                            right.textContent = `时长 ${formatTime(dur)}`;

                            row.appendChild(left);
                            row.appendChild(right);
                            vidWrap.appendChild(row);
                        });

                        frag.appendChild(vidWrap);
                    });
                    listHost.appendChild(frag);
                }
            }
        } catch (e) { /* ignore preview render errors */ }

        // 标记弹窗处于等待用户选择（避免刷新/切后台时把空 videoTasks 覆盖到 localStorage）
        __restorePromptActive = true;
        setTimeout(() => overlay.classList.add('show'), 10);

        const close = () => {
            try { document.removeEventListener('keydown', kbHandler); } catch (e) { }
            try { __safeHideOverlay(overlay); } catch (e) { }
            // 关闭时清除标记
            __restorePromptActive = false;
            setTimeout(() => { try { overlay.remove(); } catch (e) { } }, 220);
        };

        // 禁止通过点击遮罩或按 Esc 关闭 —— 仅允许通过“恢复片段/不恢复”退出
        overlay.addEventListener('click', (ev) => {
            if (ev.target === overlay) {
                ev.stopPropagation();
            }
        });

        const loadBtn = overlay.querySelector('#restoreClipsLoadBtn');
        const ignoreBtn = overlay.querySelector('#restoreClipsIgnoreBtn');

        if (loadBtn) {
            loadBtn.addEventListener('click', () => {
                try {
                    videoTasks = Array.isArray(savedTasks) ? JSON.parse(JSON.stringify(savedTasks)) : [];
                    renderNewClipList();
                    try { __saveClipToolState(); } catch (e) { }
                } catch (e) { /* ignore */ }
                close();
            });
        }

        if (ignoreBtn) {
            ignoreBtn.addEventListener('click', () => {
                try {
                    // 用户明确选择不恢复：清除本地保存的片段（保留其它字段如 username）
                    try {
                        const raw = localStorage.getItem(CLIP_TOOL_STATE_KEY);
                        if (raw) {
                            const st = JSON.parse(raw);
                            st.videoTasks = [];
                            localStorage.setItem(CLIP_TOOL_STATE_KEY, JSON.stringify(st));
                        }
                    } catch (err) { /* ignore */ }
                } catch (e) { }
                close();
            });
        }

        // 键盘支持：Enter = 恢复；Tab 在两个控件间循环（焦点陷阱）；屏蔽 Esc
        const focusables = [];
        if (ignoreBtn) focusables.push(ignoreBtn);
        if (loadBtn) focusables.push(loadBtn);

        const kbHandler = (ev) => {
            if (ev.key === 'Escape') { ev.preventDefault(); return; }
            if (ev.key === 'Enter') { ev.preventDefault(); loadBtn && loadBtn.click(); return; }
            if (ev.key === 'Tab') {
                ev.preventDefault();
                const idx = focusables.indexOf(document.activeElement);
                const dir = ev.shiftKey ? -1 : 1;
                const next = (idx === -1) ? 0 : (idx + dir + focusables.length) % focusables.length;
                focusables[next].focus();
                return;
            }
        };
        document.addEventListener('keydown', kbHandler);

        // 初始焦点（优先恢复按钮）
        (loadBtn || ignoreBtn) && (loadBtn || ignoreBtn).focus();
    } catch (e) {
        // fail silently
    }
}

function __saveClipToolState() {
    try {
        const state = {
            username: String(usernameInput?.value ?? '').trim(),
            videoTasks: __sanitizeVideoTasks(videoTasks),
            at: Date.now(),
        };
        localStorage.setItem(CLIP_TOOL_STATE_KEY, JSON.stringify(state));
    } catch (e) {
        // ignore
    }
}

function __exportClips() {
    const tasks = __sanitizeVideoTasks(videoTasks);
    if (!tasks.length) {
        showToast('没有片段可以导出', 'warning');
        return;
    }
    const blob = new Blob([JSON.stringify(tasks, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.download = `clips_${ts}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`已导出 ${tasks.reduce((n, v) => n + v.clips.length, 0)} 个片段`, 'success');
}

function __importClipsFromFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.style.display = 'none';
    const cleanup = () => {
        try { window.removeEventListener('focus', onWindowFocus); } catch (e) { }
        try { if (input.parentNode) document.body.removeChild(input); } catch (e) { }
    };
    const onWindowFocus = () => {
        setTimeout(() => {
            if (!input.files || input.files.length === 0) cleanup();
        }, 300);
    };
    input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) {
            cleanup();
            return;
        }
        try {
            const text = await file.text();
            const raw = JSON.parse(text);
            await __applyImportedVideoTasks(raw, '导入文件');
        } catch (e) {
            showToast('导入失败：文件格式不正确', 'error');
        } finally {
            cleanup();
        }
    });
    document.body.appendChild(input);
    window.addEventListener('focus', onWindowFocus);
    input.click();
}

function __importClips() {
    try {
        const existing = document.getElementById('clipImportModalOverlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'clipImportModalOverlay';
        overlay.className = 'modal-overlay clip-import-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-labelledby', 'clipImportModalTitle');
        overlay.setAttribute('aria-hidden', 'true');
        overlay.__previouslyFocused = document.activeElement;

        const modal = document.createElement('div');
        modal.className = 'modal clip-import-modal';
        modal.innerHTML = `
            <div class="modal-header clip-import-header">
                <span id="clipImportModalTitle">导入片段</span>
            </div>
            <div class="modal-body clip-import-body">
                <div class="clip-import-intro">请选择导入来源。导出文件用于恢复之前保存的 JSON；成品视频元数据支持粘贴 comment 字段或 ffprobe 输出。</div>
                <div class="source-selection-group clip-import-source-group">
                    <label class="source-option">
                        <input type="radio" name="clipImportSource" value="file" checked>
                        <div class="source-content">
                            <span class="source-title">从导出的文件导入</span>
                            <span class="source-desc">选择之前导出的 clips_*.json 文件</span>
                        </div>
                    </label>
                    <label class="source-option">
                        <input type="radio" name="clipImportSource" value="metadata">
                        <div class="source-content">
                            <span class="source-title">从成品视频元数据导入</span>
                            <span class="source-desc">粘贴切片成品视频里的 comment 元数据</span>
                        </div>
                    </label>
                </div>
                <div id="clipImportMetadataPanel" class="clip-import-metadata-panel" hidden>
                    <label for="clipImportMetadataInput">成品视频元数据</label>
                    <textarea id="clipImportMetadataInput" spellcheck="false" placeholder='示例：{"schema":"bililive-slicer.clips.v1","clips":[...]}'></textarea>
                    <div class="clip-import-meta-hint">支持直接粘贴 JSON、comment={...}、TAG:comment={...} 或 ffprobe JSON 输出。</div>
                </div>
            </div>
            <div class="modal-actions">
                <button id="clipImportCancel" class="modal-btn" type="button">取消</button>
                <button id="clipImportConfirm" class="modal-btn modal-btn-primary" type="button">选择文件</button>
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        const fileRadio = overlay.querySelector('input[name="clipImportSource"][value="file"]');
        const metadataRadio = overlay.querySelector('input[name="clipImportSource"][value="metadata"]');
        const panel = overlay.querySelector('#clipImportMetadataPanel');
        const textarea = overlay.querySelector('#clipImportMetadataInput');
        const cancelBtn = overlay.querySelector('#clipImportCancel');
        const confirmBtn = overlay.querySelector('#clipImportConfirm');

        const close = () => {
            try { document.removeEventListener('keydown', onKeyDown); } catch (e) { }
            try { __safeHideOverlay(overlay); } catch (e) { }
            setTimeout(() => { try { overlay.remove(); } catch (e) { } }, 220);
        };

        const updateMode = () => {
            const isMetadata = !!metadataRadio?.checked;
            if (panel) panel.hidden = !isMetadata;
            if (confirmBtn) confirmBtn.textContent = isMetadata ? '导入元数据' : '选择文件';
            if (isMetadata && textarea) setTimeout(() => textarea.focus(), 0);
        };

        const confirmImport = async () => {
            if (metadataRadio?.checked) {
                const text = String(textarea?.value || '').trim();
                if (!text) {
                    showToast('请先粘贴成品视频元数据', 'warning');
                    if (textarea) textarea.focus();
                    return;
                }
                const parsed = __parseClipImportMetadataText(text);
                if (!__sanitizeVideoTasks(parsed).length) {
                    showToast('成品视频元数据中没有有效片段', 'warning');
                    if (textarea) textarea.focus();
                    return;
                }
                close();
                setTimeout(() => __applyImportedVideoTasks(parsed, '成品视频元数据'), 180);
                return;
            }
            close();
            setTimeout(() => __importClipsFromFile(), 180);
        };

        const onKeyDown = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                close();
                return;
            }
            if (e.key === 'Enter' && e.target !== textarea) {
                e.preventDefault();
                confirmImport();
                return;
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && e.target === textarea) {
                e.preventDefault();
                confirmImport();
            }
        };

        if (fileRadio) fileRadio.addEventListener('change', updateMode);
        if (metadataRadio) metadataRadio.addEventListener('change', updateMode);
        if (cancelBtn) cancelBtn.addEventListener('click', close);
        if (confirmBtn) confirmBtn.addEventListener('click', confirmImport);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        document.addEventListener('keydown', onKeyDown);

        setTimeout(() => {
            overlay.classList.add('show');
            overlay.setAttribute('aria-hidden', 'false');
            if (confirmBtn) confirmBtn.focus();
        }, 10);
    } catch (e) {
        __importClipsFromFile();
    }
}

if (usernameInput) {
    usernameInput.addEventListener('input', () => __saveClipToolState());
}

function __loadBiliUploadTags() {
    try {
        return String(localStorage.getItem(BILI_UPLOAD_TAGS_KEY) || '').trim();
    } catch (e) {
        return '';
    }
}

function __saveBiliUploadTags(rawTags) {
    try {
        const v = String(rawTags ?? '').trim();
        localStorage.setItem(BILI_UPLOAD_TAGS_KEY, v);
    } catch (e) {
        // ignore
    }
}

// New Elements
const clipWorkshopPanel = document.getElementById('clipWorkshopPanel');
const currentVideoLabel = document.getElementById('currentVideoLabel');
const setStartBtn = document.getElementById('setStartBtn');
const setEndBtn = document.getElementById('setEndBtn');
const newClipStartIn = document.getElementById('newClipStart');
const newClipEndIn = document.getElementById('newClipEnd');
const confirmAddClipBtn = document.getElementById('confirmAddClipBtn');
const newClipListContainer = document.getElementById('clipListModalBody');
const clearAllClipsFn = document.getElementById('clipListClearAllBtn');
const openClipListBtn = document.getElementById('openClipListBtn');

let tempStart = null;
let tempEnd = null;
let tempStartFrame = null;
let tempEndFrame = null;
const dynamicImageUrl = 'https://random-image.xct258.top/';
// const dynamicImageUrl = 'http://192.168.50.4:8181/';

// ------------------ Toast 工具 ------------------
function ensureToastHost() {
    let host = document.getElementById('toastHost');
    if (!host) {
        host = document.createElement('div');
        host.id = 'toastHost';
        host.className = 'toast-host';
        host.setAttribute('aria-live', 'polite');
        host.setAttribute('aria-atomic', 'true');
        document.body.appendChild(host);
    }

    // 强制关键布局样式（但只初始化一次），避免 showToast 高频时反复写 style 导致卡顿
    if (host.dataset.toastInited !== '1') {
        host.dataset.toastInited = '1';
        host.style.position = 'fixed';
        host.style.top = 'auto';
        host.style.bottom = 'calc(108px + env(safe-area-inset-bottom))';
        host.style.left = '0';
        host.style.right = '0';
        host.style.zIndex = '2147483647';
        host.style.display = 'flex';
        host.style.flexDirection = 'column';
        host.style.alignItems = 'center';
        host.style.gap = '10px';
        host.style.width = '100%';
        host.style.padding = '0 16px';
        host.style.boxSizing = 'border-box';
        host.style.pointerEvents = 'none';
    }
    return host;
}

const __toastConfig = {
    maxToasts: 4,
};

function __toastNormalizeText(v) {
    return (v ?? '').toString().trim();
}

function __toastHideElement(toastEl) {
    if (!toastEl || !toastEl.isConnected) return;
    if (toastEl.classList.contains('toast-hiding')) return;
    toastEl.classList.add('toast-hiding');
    const remove = () => {
        toastEl.removeEventListener('transitionend', onEnd);
        if (toastEl.isConnected) toastEl.remove();
    };
    const onEnd = (e) => {
        if (e.propertyName === 'max-height' || e.propertyName === 'opacity') {
            remove();
        }
    };
    toastEl.addEventListener('transitionend', onEnd);
    setTimeout(remove, 420);
}

function showToast(message, type = 'info', timeout = 2600, title = '') {
    const host = ensureToastHost();

    const msgText = __toastNormalizeText(message);
    const titleText = __toastNormalizeText(title);
    if (!msgText && !titleText) return;

    // 每次调用都创建新 Toast（不合并、不限流）
    const toast = document.createElement('div');
    toast.className = `toast toast-${type} toast-enter`;
    toast.setAttribute('role', 'status');
    toast.style.position = 'relative';
    toast.style.boxSizing = 'border-box';
    toast.style.pointerEvents = 'auto';
    window.__toastZ = (window.__toastZ || 10000) + 1;
    toast.style.zIndex = String(window.__toastZ);

    const body = document.createElement('div');
    body.className = 'toast-body';

    if (titleText) {
        const titleEl = document.createElement('div');
        titleEl.className = 'toast-title';
        titleEl.textContent = titleText;
        body.appendChild(titleEl);
    }

    const msgEl = document.createElement('div');
    msgEl.className = 'toast-msg';
    msgEl.textContent = msgText;
    body.appendChild(msgEl);
    toast.appendChild(body);

    host.appendChild(toast);
    // 说明：仅用 requestAnimationFrame 有时会在首次绘制前移除 class，导致过渡不触发（尤其是 drag/drop 事件后）
    // 这里先强制一次 reflow，再用 setTimeout 推迟到事件循环后，确保动画稳定触发。
    try { toast.getBoundingClientRect(); } catch (e) { }
    setTimeout(() => toast.classList.remove('toast-enter'), 0);

    // 限制堆叠数量：超出时优雅隐藏最旧的
    while (host.children.length > __toastConfig.maxToasts) {
        const oldest = host.firstElementChild;
        if (!oldest) break;
        // 超过 4 条：最旧的立即消失
        oldest.remove();
    }

    if (timeout && timeout > 0) {
        setTimeout(() => __toastHideElement(toast), timeout);
    }
    toast.addEventListener('click', () => __toastHideElement(toast));
}

// ------------------ Modal 工具 ------------------
function __safeHideOverlay(overlay) {
    if (!overlay) return;
    try {
        // 如果遮罩内有正在被聚焦的元素，尝试把焦点恢复到打开时记录的元素；否则 blur 当前元素。
        try {
            const active = document.activeElement;
            if (active && overlay.contains(active)) {
                const prev = overlay.__previouslyFocused;
                if (prev && typeof prev.focus === 'function') {
                    try { prev.focus({ preventScroll: true }); } catch (e) { try { prev.focus(); } catch (e) { } }
                } else {
                    try { active.blur(); } catch (e) { /* ignore */ }
                }
            }
        } catch (e) { /* ignore */ }

        overlay.classList.remove('show');
        overlay.setAttribute('aria-hidden', 'true');
        try { overlay.__modalId = null; } catch (e) { }
        try { overlay.__previouslyFocused = null; } catch (e) { }
    } catch (err) {
        // 最终兜底：确保可见性被清理
        try { overlay.classList.remove('show'); } catch (e) { }
        try { overlay.setAttribute('aria-hidden', 'true'); } catch (e) { }
    }
}

function showConfirmModal(message, opts = {}) {
    const overlay = document.getElementById('modalOverlay');
    const titleEl = document.getElementById('modalTitle');
    const msgEl = document.getElementById('modalMessage');
    const okBtn = document.getElementById('modalOk');
    const cancelBtn = document.getElementById('modalCancel');
    if (!overlay || !titleEl || !msgEl || !okBtn || !cancelBtn) {
        // 兜底：如果 DOM 不存在，就退回原生 confirm
        return Promise.resolve(confirm(message));
    }

    const title = (opts.title ?? '提示').toString();
    const okText = (opts.okText ?? '确定').toString();
    const cancelText = (opts.cancelText ?? '取消').toString();

    titleEl.textContent = title;
    // message may contain HTML for checkbox insertion later
    if (typeof message === 'string') {
        msgEl.textContent = message;
    } else {
        msgEl.textContent = '';
    }
    okBtn.textContent = okText;
    cancelBtn.textContent = cancelText;

    // 新的 modal token：任何挂起的“恢复取消按钮”任务在 token 不匹配时应被忽略
    const myModalId = (window.__modalSeq = (window.__modalSeq || 0) + 1);
    overlay.__modalId = myModalId;

    // 清理并立即显示取消按钮（confirm 必须显示取消）
    if (cancelBtn) {
        if (cancelBtn.__restoreTimer) { clearTimeout(cancelBtn.__restoreTimer); cancelBtn.__restoreTimer = null; }
        if (cancelBtn.__restoreListener) { overlay.removeEventListener('transitionend', cancelBtn.__restoreListener); cancelBtn.__restoreListener = null; }
        try { cancelBtn.style.display = ''; } catch (e) { }
        cancelBtn.__hiddenBy = null;
    }

    overlay.__previouslyFocused = document.activeElement;
    overlay.classList.add('show');
    overlay.setAttribute('aria-hidden', 'false');

    return new Promise((resolve) => {
        const cleanup = () => {
            __safeHideOverlay(overlay);
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
            overlay.removeEventListener('click', onOverlay);
            document.removeEventListener('keydown', onKeyDown);
        };

        const onOk = () => {
            cleanup(); resolve(true);
        };
        const onCancel = () => { cleanup(); resolve(false); };
        const onOverlay = (e) => {
            if (e.target === overlay) { cleanup(); resolve(false); }
        };
        const onKeyDown = (e) => {
            if (e.key === 'Escape') { cleanup(); resolve(false); }
            if (e.key === 'Enter') { cleanup(); resolve(true); }
        };

        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        overlay.addEventListener('click', onOverlay);
        document.addEventListener('keydown', onKeyDown);

        setTimeout(() => okBtn.focus(), 0);
    });
}

function showPromptModal(message, opts = {}) {
    const overlay = document.getElementById('modalOverlay');
    const titleEl = document.getElementById('modalTitle');
    const msgEl = document.getElementById('modalMessage');
    const okBtn = document.getElementById('modalOk');
    const cancelBtn = document.getElementById('modalCancel');
    if (!overlay || !titleEl || !msgEl || !okBtn || !cancelBtn) {
        const fallback = window.prompt((message ?? '').toString(), (opts.defaultValue ?? '').toString());
        return Promise.resolve(fallback);
    }

    const title = (opts.title ?? '提示').toString();
    const okText = (opts.okText ?? '确定').toString();
    const cancelText = (opts.cancelText ?? '取消').toString();
    const defaultValue = (opts.defaultValue ?? '').toString();

    titleEl.textContent = title;
    msgEl.textContent = '';
    const wrapper = document.createElement('div');
    wrapper.style.display = 'flex';
    wrapper.style.flexDirection = 'column';
    wrapper.style.gap = '10px';
    const label = document.createElement('div');
    label.textContent = (message ?? '').toString();
    const input = document.createElement('input');
    input.type = 'text';
    input.value = defaultValue;
    input.placeholder = (opts.placeholder ?? '').toString();
    input.autocomplete = 'off';
    input.style.width = '100%';
    wrapper.appendChild(label);
    wrapper.appendChild(input);
    msgEl.replaceChildren(wrapper);
    okBtn.textContent = okText;
    cancelBtn.textContent = cancelText;

    const myModalId = (window.__modalSeq = (window.__modalSeq || 0) + 1);
    overlay.__modalId = myModalId;
    if (cancelBtn) {
        if (cancelBtn.__restoreTimer) { clearTimeout(cancelBtn.__restoreTimer); cancelBtn.__restoreTimer = null; }
        if (cancelBtn.__restoreListener) { overlay.removeEventListener('transitionend', cancelBtn.__restoreListener); cancelBtn.__restoreListener = null; }
        try { cancelBtn.style.display = ''; } catch (e) { }
        cancelBtn.__hiddenBy = null;
    }

    overlay.__previouslyFocused = document.activeElement;
    overlay.classList.add('show');
    overlay.setAttribute('aria-hidden', 'false');

    return new Promise((resolve) => {
        const cleanup = () => {
            __safeHideOverlay(overlay);
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
            overlay.removeEventListener('click', onOverlay);
            document.removeEventListener('keydown', onKeyDown);
        };
        const onOk = () => { const value = input.value; cleanup(); resolve(value); };
        const onCancel = () => { cleanup(); resolve(null); };
        const onOverlay = (e) => { if (e.target === overlay) { cleanup(); resolve(null); } };
        const onKeyDown = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); cleanup(); resolve(null); }
            if (e.key === 'Enter') { e.preventDefault(); onOk(); }
        };

        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        overlay.addEventListener('click', onOverlay);
        document.addEventListener('keydown', onKeyDown);
        setTimeout(() => { try { input.focus(); input.select(); } catch (e) { } }, 0);
    });
}

// ------------------ 时间转换 ------------------
function formatTime(seconds) {
    let s = Number(seconds);
    if (!Number.isFinite(s) || s < 0) s = 0;
    const fps = __getVideoFpsSync();
    if (!Number.isFinite(fps) || fps <= 0) {
        const whole = Math.floor(s);
        const cs = Math.floor((s - whole) * 100);
        const hrs = Math.floor(whole / 3600);
        const mins = Math.floor((whole % 3600) / 60);
        const secs = whole % 60;
        return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
    }
    const frameNum = Math.max(0, Math.round(s * fps));
    const h = Math.floor(frameNum / (3600 * fps));
    const rem1 = frameNum % (3600 * fps);
    const m = Math.floor(rem1 / (60 * fps));
    const rem2 = rem1 % (60 * fps);
    const sec = Math.floor(rem2 / fps);
    const fr = rem2 % fps;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}:${String(fr).padStart(2, '0')}`;
}

function formatSubtitleTime(seconds) {
    let s = Number(seconds);
    if (!Number.isFinite(s) || s < 0) s = 0;
    const whole = Math.floor(s);
    let cs = Math.round((s - whole) * 100);
    let totalSeconds = whole;
    if (cs >= 100) {
        totalSeconds += 1;
        cs = 0;
    }
    const hrs = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(cs).padStart(2, '0')}`;
}

// 移动端用更紧凑的格式：去掉小时位（仅当 < 1h），帧格式
// 视口 < 560px 时调用，否则走 formatTime
function __formatTimeForViewport(seconds) {
    let s = Number(seconds);
    if (!Number.isFinite(s) || s < 0) s = 0;
    const narrow = (typeof window !== 'undefined') && (window.innerWidth || 0) > 0 && window.innerWidth < 560;
    if (!narrow) return formatTime(s);
    const fps = __getVideoFpsSync();
    if (!Number.isFinite(fps) || fps <= 0) {
        const whole = Math.floor(s);
        const cs = Math.floor((s - whole) * 100);
        const mins = Math.floor(whole / 60);
        const secs = whole % 60;
        return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
    }
    const frameNum = Math.max(0, Math.round(s * fps));
    const m = Math.floor(frameNum / (60 * fps));
    const rem = frameNum % (60 * fps);
    const sec = Math.floor(rem / fps);
    const fr = rem % fps;
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}:${String(fr).padStart(2, '0')}`;
}

function roundToMs(seconds) {
    let s = Number(seconds);
    if (!Number.isFinite(s)) return 0;
    if (s < 0) s = 0;
    return Math.round(s * 1000) / 1000;
}

function roundToSubtitleTime(seconds) {
    let s = Number(seconds);
    if (!Number.isFinite(s)) return 0;
    if (s < 0) s = 0;
    return Math.round(s * 100) / 100;
}

function __seekPrecise(targetSeconds) {
    const dur = Number(player && player.duration) || 0;
    const t = Math.max(0, Math.min(Number(targetSeconds) || 0, dur > 0 ? dur : 0));
    if (player) player.currentTime = t;
    return t;
}

function __isMediaRangeBuffered(media, start, end) {
    if (!media || !media.buffered) return false;
    const rangeStart = Math.max(0, Number(start) || 0);
    const rangeEnd = Math.max(rangeStart, Number(end) || rangeStart);
    if (rangeEnd <= rangeStart) return true;
    try {
        for (let i = 0; i < media.buffered.length; i++) {
            if (media.buffered.start(i) <= rangeStart + 0.05 && media.buffered.end(i) >= rangeEnd - 0.05) {
                return true;
            }
        }
    } catch (e) { }
    return false;
}

function __waitMediaRangeBuffered(media, start, end, isActive, timeoutMs = 30000) {
    if (!media) return Promise.resolve(false);
    if (__isMediaRangeBuffered(media, start, end)) return Promise.resolve(true);
    return new Promise(function (resolve) {
        let done = false;
        const events = ['progress', 'canplay', 'canplaythrough', 'loadeddata', 'seeked', 'durationchange'];
        const cleanup = function (ok) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            events.forEach(function (eventName) { media.removeEventListener(eventName, check); });
            resolve(ok);
        };
        const check = function () {
            if (typeof isActive === 'function' && !isActive()) {
                cleanup(false);
                return;
            }
            if (__isMediaRangeBuffered(media, start, end)) cleanup(true);
        };
        const timer = setTimeout(function () { cleanup(false); }, timeoutMs);
        events.forEach(function (eventName) { media.addEventListener(eventName, check); });
        try { media.preload = 'auto'; } catch (e) { }
        check();
    });
}

let __videoFpsCache = null; // { name, fps }
const __DEFAULT_FPS = 30; // fallback when fps unavailable

async function __fetchVideoFps(videoName) {
    try {
        const res = await fetch(`/api/video_fps/${encodeURIComponent(videoName)}`);
        if (!res.ok) return null;
        const data = await res.json();
        const fps = Number(data?.fps);
        const startPts = Number(data?.start_pts) || 0;
        return (Number.isFinite(fps) && fps > 0) ? { fps, startPts } : null;
    } catch (e) { return null; }
}

async function __ensureVideoFps() {
    if (!currentVideoName) { __videoFpsCache = null; return __DEFAULT_FPS; }
    if (__videoFpsCache && __videoFpsCache.name === currentVideoName) return __videoFpsCache.fps;
    const info = await __fetchVideoFps(currentVideoName);
    const resolvedFps = (info?.fps) || __DEFAULT_FPS;
    const startPts = (info?.startPts) || 0;
    __videoFpsCache = { name: currentVideoName, fps: resolvedFps, startPts: startPts };
    return resolvedFps;
}

function __getVideoFpsSync() {
    if (__videoFpsCache && __videoFpsCache.name === currentVideoName) return __videoFpsCache.fps;
    return __DEFAULT_FPS;
}

function __getStartPts() {
    if (__videoFpsCache && __videoFpsCache.name === currentVideoName) return __videoFpsCache.startPts || 0;
    return 0;
}

function roundToFrame(seconds, fps) {
    const s = Number(seconds);
    if (!Number.isFinite(s)) return 0;
    const f = Number(fps);
    if (!Number.isFinite(f) || f <= 0) return roundToMs(s);
    const frameNum = Math.round(s * f);
    return frameNum / f;
}

async function roundToFrameAsync(seconds) {
    const fps = await __ensureVideoFps();
    return roundToFrame(seconds, fps);
}

function __roundClipTime(seconds) {
    return roundToFrame(seconds, __getVideoFpsSync());
}

function __getFrameInterval() {
    var fps = __getVideoFpsSync();
    return (fps && fps > 0) ? (1.0 / fps) : (1.0 / 30);
}

function __getFrameIntervalForVideo(videoName) {
    if (Array.isArray(videoTasks)) {
        for (var i = 0; i < videoTasks.length; i++) {
            if (videoTasks[i].name === videoName && videoTasks[i].fps > 0) {
                return 1.0 / videoTasks[i].fps;
            }
        }
    }
    return __getFrameInterval();
}

function _parseTimeStr(str) {
    const raw = String(str ?? '').trim();
    if (!raw) return NaN;

    const normalized = raw.replace(',', '.');
    const parts = normalized.split(':');
    if (parts.length < 1 || parts.length > 4) return NaN;

    // HH:MM:SS:FF (帧格式)
    if (parts.length === 4) {
        const hh = Number(parts[0].trim());
        const mm = Number(parts[1].trim());
        const ss = Number(parts[2].trim());
        const ff = Number(parts[3].trim());
        if (!Number.isFinite(hh) || !Number.isFinite(mm) || !Number.isFinite(ss) || !Number.isFinite(ff)) return NaN;
        const fps = __getVideoFpsSync();
        return hh * 3600 + mm * 60 + ss + (fps > 0 ? ff / fps : ff / 30);
    }

    const last = parts[parts.length - 1].trim();
    const secs = Number(last);
    if (!Number.isFinite(secs)) return NaN;

    let total = secs;
    if (parts.length >= 2) {
        const mm = Number(parts[parts.length - 2].trim());
        if (!Number.isFinite(mm)) return NaN;
        total += mm * 60;
    }
    if (parts.length === 3) {
        const hh = Number(parts[0].trim());
        if (!Number.isFinite(hh)) return NaN;
        total += hh * 3600;
    }
    return total;
}

function parseTime(str) {
    const total = _parseTimeStr(str);
    if (!Number.isFinite(total)) return NaN;
    return __roundClipTime(total);
}

function parseTimeSub(str) {
    const total = _parseTimeStr(str);
    if (!Number.isFinite(total)) return NaN;
    return total < 0 ? NaN : total;
}

// ------------------ 获取并设置强调色 ------------------
async function fetchThemeColor(url) {
    try {
        const res = await fetch(url, { method: 'HEAD' });
        const themeColor = res.headers.get('x-theme-color');
        return themeColor || '79,158,255';
    } catch (e) {
        console.warn('无法获取 x-theme-color', e);
        return '79,158,255';
    }
}

function parseCssColor(colorString) {
    if (!colorString) return null;
    const hex = colorString.trim().match(/^#?([0-9a-f]{6})$/i);
    if (hex) {
        const value = hex[1];
        return [
            parseInt(value.slice(0, 2), 16),
            parseInt(value.slice(2, 4), 16),
            parseInt(value.slice(4, 6), 16),
        ];
    }
    const parts = colorString.match(/\d+(?:\.\d+)?/g);
    if (!parts || parts.length < 3) return null;
    return parts.slice(0, 3).map((value) => Math.max(0, Math.min(255, Number(value))));
}

function colorLuminance(rgb) {
    const channels = rgb.map((value) => {
        const channel = value / 255;
        return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrastRatio(colorA, colorB) {
    const light = Math.max(colorLuminance(colorA), colorLuminance(colorB));
    const dark = Math.min(colorLuminance(colorA), colorLuminance(colorB));
    return (light + 0.05) / (dark + 0.05);
}

function pickReadableTextColor(backgroundRgb, preferredTextRgb) {
    const candidates = [[255, 255, 255], [0, 0, 0]];
    if (preferredTextRgb) candidates.unshift(preferredTextRgb);
    return candidates.reduce((best, current) => (
        contrastRatio(backgroundRgb, current) > contrastRatio(backgroundRgb, best) ? current : best
    ));
}

function setAccentColor(rgbString, textColorString) {
    const accentRgb = parseCssColor(rgbString) || [79, 158, 255];
    const textRgb = pickReadableTextColor(accentRgb, parseCssColor(textColorString));
    const rgb = accentRgb.join(',');
    document.documentElement.style.setProperty('--accent-color', `rgb(${rgb})`);
    document.documentElement.style.setProperty('--btn-bg', `rgba(${rgb},0.4)`);
    document.documentElement.style.setProperty('--btn-hover', `rgba(${rgb},0.6)`);
    document.documentElement.style.setProperty('--accent-text-color', `rgb(${textRgb.join(',')})`);
}

// ------------------ 背景图预加载 ------------------
function preloadImage(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.src = url;
        img.onload = resolve;
        img.onerror = reject;
    });
}

// ------------------ 页面初始化 ------------------
async function initPage() {
    const loadingOverlay = document.getElementById('loadingOverlay');
    const mainContent = document.getElementById('mainContent');

    const introOverlay = document.getElementById('siteIntroOverlay');
    const introOk = document.getElementById('siteIntroOk');
    const introCloseX = document.getElementById('siteIntroCloseX');
    const introNoMore = document.getElementById('siteIntroNoMore');

    const INTRO_KEY = 'bililive_site_intro_dismissed_v1';
    const shouldShowIntro = () => {
        try { return localStorage.getItem(INTRO_KEY) !== '1'; } catch (e) { return true; }
    };
    const closeIntro = () => {
        try {
            if (introNoMore && introNoMore.checked) {
                try { localStorage.setItem(INTRO_KEY, '1'); } catch (e) { }
            }
        } catch (e) { }
        if (introOverlay) {
            // 添加退出动画类并移除可见标记
            introOverlay.classList.add('hiding');
            introOverlay.classList.remove('visible');

            // 动画结束后真正隐藏 (400ms match CSS)
            setTimeout(() => {
                // Fix: 移除 focus 避免 aria-hidden 报错
                try {
                    if (document.activeElement && introOverlay.contains(document.activeElement)) {
                        document.activeElement.blur();
                    }
                } catch (e) { }

                introOverlay.classList.remove('show');
                introOverlay.classList.remove('hiding');
                introOverlay.setAttribute('aria-hidden', 'true');
                try { introOverlay.__modalId = null; } catch (e) { }
            }, 400);
        }
    };
    const showIntro = () => {
        if (!introOverlay) return;
        const myModalId = (window.__modalSeq = (window.__modalSeq || 0) + 1);
        introOverlay.__modalId = myModalId;
        introOverlay.classList.remove('hiding');
        introOverlay.classList.remove('visible');
        introOverlay.classList.add('show');
        introOverlay.setAttribute('aria-hidden', 'false');
        // 等待渲染并在两个 animation frame 后添加 visible，这样
        // 浏览器不会将 show/visible 合并，保证动画触发。
        try { void introOverlay.offsetHeight; } catch (e) { }
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                if (introOverlay.__modalId !== myModalId) return;
                introOverlay.classList.add('visible');
            });
        });
        // 不自动 focus（避免打开时看到焦点框）；保留键盘关闭（Esc）和按钮点击行为.
    };

    // 内容默认先隐藏：2 秒后与说明弹窗一起出现
    try {
        if (mainContent) {
            mainContent.style.display = 'none';
        }
    } catch (e) { }

    // 绑定一次性事件（重复调用 initPage 也不会造成太多重复；这里做最小防护）
    try {
        if (introOk && !introOk.__bound) {
            introOk.__bound = true;
            introOk.addEventListener('click', closeIntro);
        }
        if (introCloseX && !introCloseX.__bound) {
            introCloseX.__bound = true;
            introCloseX.addEventListener('click', closeIntro);
        }
        if (introOverlay && !introOverlay.__bound) {
            introOverlay.__bound = true;
            introOverlay.addEventListener('click', (e) => {
                if (e.target === introOverlay) closeIntro();
            });
            document.addEventListener('keydown', (e) => {
                if (introOverlay.classList.contains('show') && e.key === 'Escape') {
                    closeIntro();
                }
            });
        }
    } catch (e) { }

    try {
        const res = await fetch(dynamicImageUrl);

        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);

        // 背景图淡入
        document.documentElement.style.setProperty('--bg-image', `url(${objectUrl})`);
        document.body.classList.add('bg-ready');
    } catch (e) {
        console.warn("背景图片加载失败，使用默认背景", e);
        // 背景失败也进入“就绪”态（仍保持纯色背景）
        document.body.classList.add('bg-ready');
    } finally {
        // 淡出 loadingOverlay，让用户先看到背景
        try {
            if (loadingOverlay) {
                loadingOverlay.classList.add('hidden');
                setTimeout(() => {
                    try { loadingOverlay.style.display = 'none'; } catch (e) { }
                }, 480);
            }
        } catch (e) { }

        // 1 秒后：同时显示页面内容 + “网站说明”全屏弹窗（如未关闭“不再提示”）
        setTimeout(() => {
            try {
                if (mainContent) {
                    mainContent.style.display = 'block';
                    mainContent.classList.add('anim-fade-in');
                }
            } catch (e) { }

            // 自动滚动到视频预览区：仅在页面初始滚动位置为顶端时触发，尊重 prefers-reduced-motion
            try {
                if ((window.scrollY || 0) === 0) {
                    const videoEl = document.getElementById('videoContainer');
                    if (videoEl) {
                        const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
                        // 等待 fade-in 动画与布局稳定后再滚动（避免跳动）
                        setTimeout(() => {
                            requestAnimationFrame(() => {
                                try {
                                    const rect = videoEl.getBoundingClientRect();
                                    const inView = rect.top >= 0 && rect.bottom <= (window.innerHeight || document.documentElement.clientHeight);
                                    if (!inView) {
                                        videoEl.scrollIntoView({ behavior: prefersReduced ? 'auto' : 'smooth', block: 'center' });
                                    }
                                } catch (e) { }
                            });
                        }, 600);
                    }
                }
            } catch (e) { }

            // 额外延迟 1 秒显示说明弹窗
            setTimeout(() => {
                try {
                    if (shouldShowIntro()) showIntro();
                } catch (e) { }
            }, 1000);
        }, 2000);

        await __loadClipToolState();
        // 根据当前（或最近一次）合并状态同步“添加片段”控件的启用/禁用
        try { __syncClipAddDisabledState(__mergeStatusLastState || {}); } catch (e) { }
        try {
            const total = __getTotalClipCountFromVideoTasks();
        } catch (e) { }
        __renderOutputHistory();
        loadFileTree(getLastTreePath() || getDefaultTreePath()); // 恢复上次打开的路径，无记录则用当前月份
        __startMergeStatusPolling();
        __startSiteStatsPolling();
        refreshVideoStageDim();

        // 初始化并绑定：在窗口尺寸变化时更新“空间不足”提示（显示宽/高哪个不足）
        try { if (typeof updatePreviewEmptyHint === 'function') updatePreviewEmptyHint(); } catch (e) { }
        try { window.addEventListener('resize', () => { try { updatePreviewEmptyHint(); } catch (e) { } }, { passive: true }); } catch (e) { }
    }
}

// ------------------ 文件树弹窗 ------------------
function __openFileTreeModal() {
    const overlay = document.getElementById('fileTreeModalOverlay');
    const ft = document.getElementById('fileTree');
    if (overlay) {
        // 分配一次性 modal token，避免其它残留回调影响此 overlay
        const myModalId = (window.__modalSeq = (window.__modalSeq || 0) + 1);
        overlay.__modalId = myModalId;

        overlay.__previouslyFocused = document.activeElement;
        overlay.classList.add('show');
        overlay.setAttribute('aria-hidden', 'false');
        // 恢复上次打开的路径，无记录则用当前月份
        loadFileTree(getLastTreePath() || getDefaultTreePath());
        // focus file list for keyboard users and center selected item
        if (ft) {
            setTimeout(() => {
                try { ft.focus({ preventScroll: true }); } catch (e) { ft.focus(); }
                const sel = ft.querySelector('span.selected');
                if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'center' });
            }, 80);
        }
    }
}
function __closeFileTreeModal() {
    const overlay = document.getElementById('fileTreeModalOverlay');
    if (overlay) {
        __safeHideOverlay(overlay);
    }
}

// "选择视频" 按钮（视频预览区内）
if (openFileTreeBtnMain) {
    openFileTreeBtnMain.addEventListener('click', (e) => {
        e.stopPropagation();
        __openFileTreeModal();
    });
}
// 顶部独立视频选择按钮
const openFileTreeBtnTop = document.getElementById('openFileTreeBtnTop');
if (openFileTreeBtnTop) {
    openFileTreeBtnTop.addEventListener('click', (e) => {
        e.stopPropagation();
        __openFileTreeModal();
    });
}
// 紧凑标题内的“选择视频”按钮（供空间不足时使用）
const openFileTreeBtnCompact = document.getElementById('openFileTreeBtnCompact');
if (openFileTreeBtnCompact) {
    openFileTreeBtnCompact.addEventListener('click', (e) => {
        e.stopPropagation();
        __openFileTreeModal();
    });
}
const openFileTreeBtnOverlay = document.getElementById('openFileTreeBtnOverlay');
if (openFileTreeBtnOverlay) {
    openFileTreeBtnOverlay.addEventListener('click', (e) => {
        e.stopPropagation();
        __openFileTreeModal();
    });
}

// 同步“紧凑标题”按钮的位置：
// - 在容器处于紧凑或视口确实太小时，按钮成为 #videoContainer 的直接子元素（显示在预览下方）
// - 否则把按钮移回标题区。保证在窗口缩放或 JS 切换时位置始终正确
(function () {
    try {
        const vc = document.getElementById('videoContainer');
        const btn = openFileTreeBtnCompact;
        if (!vc || !btn) return;
        const panelTitle = vc.querySelector('.panel-title');
        const mq = window.matchMedia('(max-width: 479.98px), (max-height: 459.98px)');

        function syncBtn() {
            const shouldBeCompact = mq.matches || vc.classList.contains('video-container-compact');
            if (shouldBeCompact) {
                if (btn.parentElement !== vc) vc.appendChild(btn);
                btn.classList.add('moved-below');
            } else {
                if (panelTitle && btn.parentElement !== panelTitle) panelTitle.appendChild(btn);
                btn.classList.remove('moved-below');
            }
        }

        // 监听 media query 与窗口缩放（兼容旧浏览器）
        if (mq.addEventListener) mq.addEventListener('change', syncBtn); else mq.addListener(syncBtn);
        window.addEventListener('resize', syncBtn);
        // 初始化一次
        syncBtn();
    } catch (e) { /* ignore */ }
})();

// 文件树弹窗关闭按钮
const fileTreeModalCloseX = document.getElementById('fileTreeModalCloseX');
const fileTreeModalClose = document.getElementById('fileTreeModalClose');
const fileTreeModalOverlay = document.getElementById('fileTreeModalOverlay');
if (fileTreeModalCloseX) fileTreeModalCloseX.addEventListener('click', __closeFileTreeModal);
if (fileTreeModalClose) fileTreeModalClose.addEventListener('click', __closeFileTreeModal);
if (fileTreeModalOverlay) {
    fileTreeModalOverlay.addEventListener('click', (e) => {
        if (e.target === fileTreeModalOverlay) __closeFileTreeModal();
    });
}

// ------------------ 文件树 ------------------
async function loadFileTree(path = '', sourceLi = null) {
    // 切换当前路径（空字符串表示根目录）
    if (!path) {
        path = getDefaultTreePath();
    }
    currentTreePath = String(path || '').trim();

    // Loading UI: 若由某个目录点击触发，则在该 li 显示 spinner；否则在整个列表右上显示全局 spinner。
    if (sourceLi) {
        sourceLi.classList.add('loading');
    } else {
        fileTreeDiv.classList.add('loading');
    }

    let tree = [];
    try {
        const treeReq = fetch(`/api/tree?path=${encodeURIComponent(currentTreePath)}`);
        const durReq = fetch(`/api/dir_durations?path=${encodeURIComponent(currentTreePath)}`);

        const [treeRes, durRes] = await Promise.all([treeReq, durReq]);
        tree = await treeRes.json();
        let durMap = {};
        try {
            durMap = await durRes.json();
        } catch (e) { /* 如果时长接口失败，忽略 */ }

        // 把时长注入到节点上，createTree 会直接呈现时长
        if (Array.isArray(tree) && durMap && typeof durMap === 'object') {
            tree.forEach(n => {
                if (n && n.type === 'file' && n.basename && durMap[n.basename]) {
                    n.duration = durMap[n.basename];
                }
            });
        }

        // 自动后退逻辑：如果当前目录（非根目录）没有内容，自动返回上级
        if (currentTreePath && Array.isArray(tree) && tree.length === 0) {
            const parts = currentTreePath.split('/').filter(Boolean);
            const parent = parts.slice(0, -1).join('/');
            console.log(`目录空或失效，自动回退: ${currentTreePath} -> ${parent || '/'}`);
            return loadFileTree(parent || '');
        }

        // 确定有效后记入存储
        saveLastTreePath(currentTreePath);

    } catch (err) {
        console.error('加载目录或时长失败', err);
    } finally {
        if (sourceLi) sourceLi.classList.remove('loading');
        else fileTreeDiv.classList.remove('loading');
    }

    // 渲染结果（在时长准备好后一次性更新 DOM，避免点击后立即切换导致内容缺失）
    fileTreeDiv.innerHTML = '';

    // 顶部路径 / 返回头部（进入目录模式）
    // 在模态窗口内我们使用模态顶栏显示路径，因此不在 modal 内创建列表 header（避免重复显示）。
    if (!fileTreeDiv.closest('.filetree-modal')) {
        const header = document.createElement('div');
        header.className = 'file-tree-header';
        const pathLabel = document.createElement('div');
        pathLabel.className = 'path';
        pathLabel.textContent = currentTreePath || '/';
        header.appendChild(pathLabel);
        fileTreeDiv.appendChild(header);
    }

    /* 更新模态顶栏的独立“返回”按钮（如果存在），并把路径同步到模态顶栏显示 */
    try {
        const modalBack = document.getElementById('fileTreeModalBackBtn');
        const modalPath = document.getElementById('fileTreeModalPath');
        if (modalPath) modalPath.textContent = currentTreePath || '/';
        if (modalBack) {
            // 当文件树位于模态内时，显示模态顶栏的返回按钮（位于路径左侧）；非模态场景下隐藏该按钮
            if (fileTreeDiv.closest('.filetree-modal')) {
                modalBack.style.display = '';
            } else {
                modalBack.style.display = 'none';
            }
            // 根目录或已在"压制版"顶层时禁用返回（再往上没有意义，会循环）
            // 处于虚拟根目录时禁用返回
            const isAtRoot = !currentTreePath;
            modalBack.disabled = isAtRoot;
            modalBack.onclick = () => {
                if (isAtRoot) return;
                const parts = currentTreePath.split('/').filter(Boolean);
                const parent = parts.slice(0, -1).join('/');
                loadFileTree(parent || '');
            };
        }
    } catch (e) { /* ignore */ }

    function formatSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    // 创建当前目录的扁平化列表（目录点击为“进入”）
    function createTree(nodes) {
        const ul = document.createElement('ul');
        nodes.forEach(node => {
            const li = document.createElement('li');
            const span = document.createElement('span');

            // 显示逻辑：优先使用 basename
            const displayName = node.basename || node.name;
            // 把文件名与时长放在垂直堆叠的容器中，确保时长显示在文件名下方
            let label = `<div class="file-label"><div class="file-name">${displayName}</div>`;

            if (node.type === 'file') {
                let metaStr = '';
                if (node.duration && node.duration > 0) {
                    metaStr = '⏱ ' + formatTime(node.duration);
                }
                if (metaStr) {
                    label += `<div class="file-duration">${metaStr}</div>`;
                }
            }
            label += `</div>`;
            span.innerHTML = label;
            span.setAttribute('data-name', node.name || node.basename || '');
            // 将完整文件名设为 title，便于鼠标悬停查看完整名称
            try {
                span.title = String(displayName || '');
                const nameDiv = span.querySelector('.file-name');
                if (nameDiv) nameDiv.title = String(displayName || '');
            } catch (e) { /* ignore */ }

            if (node.type === 'dir') {
                // 进入目录（不再就地展开）
                span.className = 'dir';
                span.addEventListener('click', e => {
                    e.stopPropagation();
                    if (typeof __stopTimelineThumbLoading === 'function') {
                        try { __stopTimelineThumbLoading(); } catch (err) { }
                    }
                    // 在被点击的 li 旁显示加载中提示，之后再加载目录内容
                    li.classList.add('loading');
                    loadFileTree(node.path, li);
                });
                li.appendChild(span);
            } else {
                const ext = (node.name || '').split('.').pop().toLowerCase();
                if (['mp4', 'mkv', 'ts', 'flv', 'mov', 'avi', 'webm', 'm4v'].includes(ext)) {
                    span.className = 'file video-file';
                } else {
                    span.className = 'file';
                }
                span.addEventListener('click', e => {
                    e.stopPropagation();

                    // 如果当前已选中，再次点击则取消选择并清理状态
                    const wasSelected = span.classList.contains('selected');
                    if (wasSelected) {
                        fileTreeDiv.querySelectorAll('span.selected').forEach(el => el.classList.remove('selected'));

                        // 清理全局选择状态与播放器（避免后台加载）
                        currentVideoName = '';
                        __mainPreviewActive = false;
                        __subtitleData = [];
                        __subtitleEnabled = false;
                        __subtitleSelectedIndex = -1;
                        __subtitleEditingIndex = -1;
                        __subtitleEditOrigData = null;
                        __subtitlePageIndex = 0;
                        __hideSubtitleSlicePanel();
                        __syncSubtitleToolbar();
                        __stopAudioPlayback();
                        __clearVideoSegmentEnd();
                        __audioSrc = null;
                        __audioSrcVideoName = '';
                        try {
                            if (player && player.pause) player.pause();
                            if (player && player.removeAttribute) { player.removeAttribute('src'); player.load && player.load(); }
                        } catch (err) { /* ignore */ }

                        // 隐藏 UI 元素并清空标签（显示占位提示）
                        const infoBlock = document.getElementById('currentVideoInfoBlock');
                        if (infoBlock) infoBlock.style.display = 'none';
                        const previewArea = document.getElementById('previewActionArea');
                        if (previewArea) previewArea.style.display = 'none';
                        const _titleEl = document.getElementById('videoTitleFilename');
                        if (_titleEl) { _titleEl.textContent = '请选择视频'; _titleEl.title = ''; }
                        const videoLabel = document.getElementById('currentVideoLabel');
                        if (videoLabel) videoLabel.textContent = '';

                        tempStart = null; tempEnd = null;
                        updateClipInputs();
                        renderNewClipList();
                        refreshVideoStageDim();

                        // 重置独立的视频选择信息
                        const vsi2 = document.getElementById('videoSelectInfo');
                        if (vsi2) { vsi2.textContent = '未选择视频'; vsi2.style.color = 'var(--muted-color)'; }
                        const smp2 = document.getElementById('sliceConfigPanel');
                        if (smp2) smp2.style.display = 'none';
                        const previewBody = document.getElementById('videoPreviewBody');
                        if (previewBody) previewBody.style.display = 'none';
                        if (videoPreviewPanel) videoPreviewPanel.style.display = '';
                        return;
                    }

                    // 普通选择逻辑（选中当前文件）
                    fileTreeDiv.querySelectorAll('span.selected').forEach(el => el.classList.remove('selected'));
                    span.classList.add('selected');

                    // 如果点击的是当前已选中的视频，保持预览/编辑状态不变
                    if (currentVideoName === node.name) {
                        return;
                    }

                    // 不在选择时加载视频（只有点击“预览”才会加载）
                    // 若播放器当前已加载不同文件，则卸载它以避免后台下载/播放
                    try {
                        const videoSrc = `/api/video/${encodeURIComponent(node.name)}`;
                        const currentSrc = (player && player.getAttribute) ? (player.getAttribute('src') || '') : '';
                        if (currentSrc && currentSrc !== videoSrc) {
                            try { player.pause(); } catch (e) { }
                            try { player.removeAttribute('src'); } catch (e) { }
                            try { player.load(); } catch (e) { }
                            __mainPreviewActive = false;
                        }
                    } catch (e) { /* ignore */ }

                    // 切换视频时清理上一视频的字幕音频/片段播放状态
                    try { __stopAudioPlayback(); } catch (e) { }
                    try { __clearVideoSegmentEnd(); } catch (e) { }
                    try { __audioSrc = null; __audioSrcVideoName = ''; } catch (e) { }

                    __setVideoContainerExpanded(false);

                    document.getElementById('previewActionArea').style.display = 'block';
                    const _videoName = node.basename || node.name;
                    const _titleEl2 = document.getElementById('videoTitleFilename');
                    if (_titleEl2) { _titleEl2.textContent = _videoName; _titleEl2.title = _videoName; }

                    currentVideoName = node.name;
                    // 选中文件但尚未点击"预览"：认为预览尚未激活
                    __mainPreviewActive = false;
                    // 强制刷新时间轴，清空旧波形数据
                    if (typeof window.__tlRenderTimeline === 'function') {
                        window.__tlRenderTimeline();
                    }
                    const videoLabel2 = document.getElementById('currentVideoLabel');
                    if (videoLabel2) videoLabel2.textContent = node.basename || node.name;
                    document.getElementById('currentVideoInfoBlock').style.display = 'block';
                    refreshVideoStageDim();

                    // 更新独立的视频选择信息
                    const vsi = document.getElementById('videoSelectInfo');
                    if (vsi) { vsi.textContent = node.basename || node.name; vsi.style.color = ''; }
                    // 显示切片配置面板
                    const smp = document.getElementById('sliceConfigPanel');
                    if (smp) smp.style.display = '';
                    __updateSliceConfigUI();

                    // 选择文件后不再自动关闭文件树弹窗 — 由用户手动关闭以便连续选择/对比
                    //（保留注释以便将来恢复自动关闭）
                    // __closeFileTreeModal();

                    tempStart = null;
                    tempEnd = null;
                    updateClipInputs();
                    renderNewClipList();

                    // 选择视频后只加载字幕；FPS 在真正需要视频预览/帧精确操作时再加载
                    __loadSubtitle();
                });
                li.appendChild(span);
            }
            ul.appendChild(li);
        });
        return ul;
    }

    fileTreeDiv.appendChild(createTree(tree));

    // 恢复当前已选视频的高亮标记（避免 data-name 含特殊字符破坏 CSS 选择器）
    if (currentVideoName) {
        fileTreeDiv.querySelectorAll('span[data-name]').forEach(s => {
            if (s.getAttribute('data-name') === currentVideoName) s.classList.add('selected');
        });
    }

    // 空状态提示：当前目录下没有任何文件和子目录时，显示提示
    if (Array.isArray(tree) && tree.length === 0) {
        const emptyHint = document.createElement('div');
        emptyHint.className = 'file-tree-empty-hint';
        emptyHint.textContent = '暂无可用视频文件';
        emptyHint.style.textAlign = 'center';
        emptyHint.style.padding = '32px 16px';
        emptyHint.style.color = 'var(--muted-color, #888)';
        emptyHint.style.fontSize = '14px';
        fileTreeDiv.appendChild(emptyHint);
    }

    /* 时长在渲染前已一次性加载并注入到节点中（以避免视图切换后再填充引起的闪烁）。 */
}

function __capturePageScrollState() {
    const main = document.getElementById('mainContent');
    const doc = document.scrollingElement || document.documentElement;
    return {
        main,
        mainTop: main ? main.scrollTop : 0,
        mainLeft: main ? main.scrollLeft : 0,
        doc,
        docTop: doc ? doc.scrollTop : 0,
        docLeft: doc ? doc.scrollLeft : 0,
        winX: window.scrollX || 0,
        winY: window.scrollY || 0,
    };
}

function __restorePageScrollState(state) {
    if (!state) return;
    try {
        if (state.main) {
            state.main.scrollTop = state.mainTop;
            state.main.scrollLeft = state.mainLeft;
        }
    } catch (e) { }
    try {
        if (state.doc) {
            state.doc.scrollTop = state.docTop;
            state.doc.scrollLeft = state.docLeft;
        }
    } catch (e) { }
    try { window.scrollTo(state.winX, state.winY); } catch (e) { }
}

function __restorePageScrollStateSoon(state) {
    __restorePageScrollState(state);
    requestAnimationFrame(() => {
        __restorePageScrollState(state);
        requestAnimationFrame(() => __restorePageScrollState(state));
    });
}

function __withStablePageScroll(fn) {
    const state = __capturePageScrollState();
    try {
        return fn();
    } finally {
        __restorePageScrollStateSoon(state);
    }
}

// ------------------ 渲染片段列表 (重构) ------------------
// ── 批量删除状态 ──
let __clipListBatchMode = false;
let __clipListSelected = new Set();

function __resetClipListBatchMode() {
    __clipListBatchMode = false;
    __clipListSelected = new Set();
    const footer = document.querySelector('.clip-list-modal-footer');
    if (footer) footer.classList.remove('clip-list-batch-active');
    const overlay = document.getElementById('clipListModalOverlay');
    if (overlay) overlay.classList.remove('clip-list-batch-active');
    const batchBtn = document.getElementById('clipListBatchDeleteBtn');
    if (batchBtn) {
        batchBtn.textContent = '勾选删除';
        batchBtn.classList.remove('batch-delete', 'active');
    }
}

function __toggleClipListBatchMode() {
    __clipListBatchMode = !__clipListBatchMode;
    if (!__clipListBatchMode) {
        __clipListSelected = new Set();
    }
    const footer = document.querySelector('.clip-list-modal-footer');
    if (footer) footer.classList.toggle('clip-list-batch-active', __clipListBatchMode);
    const overlay = document.getElementById('clipListModalOverlay');
    if (overlay) overlay.classList.toggle('clip-list-batch-active', __clipListBatchMode);
    const batchBtn = document.getElementById('clipListBatchDeleteBtn');
    if (batchBtn) {
        if (__clipListBatchMode) {
            batchBtn.textContent = '取消';
            batchBtn.classList.add('active');
        } else {
            batchBtn.textContent = '勾选删除';
            batchBtn.classList.remove('batch-delete', 'active');
        }
    }
    __syncBatchDeleteButton();
}

function __syncBatchDeleteButton() {
    const batchBtn = document.getElementById('clipListBatchDeleteBtn');
    if (!batchBtn || !__clipListBatchMode) return;
    const count = __clipListSelected.size;
    if (count > 0) {
        batchBtn.textContent = `删除 ${count} 个`;
        batchBtn.classList.add('batch-delete');
    } else {
        batchBtn.textContent = '取消';
        batchBtn.classList.remove('batch-delete');
    }
}

function __toggleClipSelection(globalIdx) {
    if (!__clipListBatchMode) return;
    if (__clipListSelected.has(globalIdx)) {
        __clipListSelected.delete(globalIdx);
    } else {
        __clipListSelected.add(globalIdx);
    }
    __syncBatchDeleteButton();
    // update checkbox visual
    const card = newClipListContainer.querySelector(`.clip-card[data-gidx="${globalIdx}"]`);
    if (card) {
        const cb = card.querySelector('.clip-checkbox');
        if (cb) cb.checked = __clipListSelected.has(globalIdx);
        card.classList.toggle('clip-selected', __clipListSelected.has(globalIdx));
    }
}

function __formatDuration(seconds) {
    const s = Math.round(Number(seconds));
    if (!Number.isFinite(s) || s < 0) return '0s';
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    const rs = s % 60;
    if (m < 60) return rs > 0 ? `${m}m ${rs}s` : `${m}m`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

function __createClipListEmptyEl() {
    const el = document.createElement('div');
    el.className = 'clip-list-empty';
    el.innerHTML = '<div class="clip-list-empty-icon">📋</div><div>暂无待合并片段</div>';
    return el;
}

function __getSubtitlePreviewForClip(start, end) {
    if (!__subtitleData || !__subtitleData.length) return '';
    for (const s of __subtitleData) {
        if (s.start < end && s.end > start) {
            const t = String(s.text || '').trim();
            if (t) return t;
        }
    }
    return '';
}

function renderNewClipList() {
    const scrollState = __capturePageScrollState();

    var totalClips = __getTotalClipCountFromVideoTasks();
    if (openClipListBtn) {
        openClipListBtn.textContent = '待合并片段 (' + totalClips + ')';
        openClipListBtn.disabled = false;
    }

    // clean up stale selection indices
    const flat = __flattenVideoTasksToClips();
    for (const idx of __clipListSelected) {
        if (idx < 0 || idx >= flat.length) __clipListSelected.delete(idx);
    }
    __syncBatchDeleteButton();

    const validTasks = videoTasks.filter(v => v.clips.length > 0);

    if (validTasks.length === 0) {
        try { __updateSubtitleSliceState(); } catch (e) { }
        newClipListContainer.replaceChildren(__createClipListEmptyEl());
        __restorePageScrollStateSoon(scrollState);
        return;
    }

    const frag = document.createDocumentFragment();
    let globalClipIndex = 0;
    let __mainListDragFromIndex = null;

    const reorderByGlobalIndex = (fromIdx, toIdx) => {
        if (__isClipEditLocked()) {
            showAlertModal('当前正在切片或已有合并任务排队，无法调整片段顺序');
            return;
        }
        const from = Number(fromIdx);
        const to = Number(toIdx);
        if (!Number.isFinite(from) || !Number.isFinite(to)) return;
        if (from === to) return;

        // flatten with references to actual clip objects
        const flat = [];
        for (const task of videoTasks) {
            for (const clip of task.clips) {
                flat.push({ name: task.name, clip });
            }
        }
        if (from < 0 || from >= flat.length) return;
        if (to < 0 || to >= flat.length) return;

        // reorder
        const moving = flat.splice(from, 1)[0];
        flat.splice(to, 0, moving);

        // rebuild videoTasks, grouping consecutive clips with same video name
        const newTasks = [];
        let currentTask = null;
        for (const item of flat) {
            if (!currentTask || currentTask.name !== item.name) {
                currentTask = { name: item.name, clips: [] };
                newTasks.push(currentTask);
            }
            currentTask.clips.push(item.clip);
        }
        videoTasks = newTasks;

        renderNewClipList();
        __saveClipToolState();
        showToast(`片段 ${from + 1} 移动到 片段 ${to + 1}`, 'info', 3000);
    };

    const clearDragState = () => {
        __mainListDragFromIndex = null;
        newClipListContainer.querySelectorAll('.clip-card.dragging, .clip-card.drag-before, .clip-card.drag-after')
            .forEach(el => el.classList.remove('dragging', 'drag-before', 'drag-after'));
    };

    const isLocked = __isClipEditLocked();

    videoTasks.forEach((video, taskIdx) => {
        if (video.clips.length === 0) return;

        // group title
        const title = document.createElement('div');
        title.className = 'clip-list-group-title';
        title.textContent = video.name;
        frag.appendChild(title);

        video.clips.forEach((c, clipIdx) => {
            globalClipIndex++;
            const globalIdx = globalClipIndex - 1;

            const card = document.createElement('div');
            card.className = 'clip-card';
            card.dataset.gidx = String(globalIdx);
            if (isLocked) card.classList.add('locked');
            else card.draggable = true;

            // ── checkbox (batch mode) ──
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'clip-checkbox';
            cb.checked = __clipListSelected.has(globalIdx);
            cb.addEventListener('change', (e) => {
                e.stopPropagation();
                if (!__clipListBatchMode) return;
                __toggleClipSelection(globalIdx);
            });

            // ── index ──
            const idxEl = document.createElement('span');
            idxEl.className = 'clip-index';
            idxEl.textContent = String(globalClipIndex);

            // ── body ──
            const body = document.createElement('div');
            body.className = 'clip-body';

            // row1: times + duration
            const row1 = document.createElement('div');
            row1.className = 'clip-body-row1';

            const times = document.createElement('span');
            times.className = 'clip-times';
            times.textContent = `${formatSubtitleTime(c.start)} – ${formatSubtitleTime(c.end)}`;

            const dur = document.createElement('span');
            dur.className = 'clip-duration';
            dur.textContent = __formatDuration(c.end - c.start);

            row1.appendChild(times);
            row1.appendChild(dur);

            // row2: frame info + subtitle preview
            const row2 = document.createElement('div');
            row2.className = 'clip-body-row2';

            let frameText = '';
            if (c._frameStart != null && c._frameEnd != null) {
                frameText = `#${c._frameStart}→${c._frameEnd}`;
            } else {
                const fps = __getVideoFpsSync();
                const sf = fps > 0 ? Math.round(c.start * fps) : null;
                const ef = fps > 0 ? Math.round(c.end * fps) : null;
                if (sf !== null && ef !== null) frameText = `#${sf}→${ef}`;
            }
            if (frameText) {
                const frameEl = document.createElement('span');
                frameEl.className = 'clip-frame';
                frameEl.textContent = frameText;
                row2.appendChild(frameEl);
            }

            const subText = __getSubtitlePreviewForClip(c.start, c.end);
            if (subText) {
                const subEl = document.createElement('span');
                subEl.className = 'clip-subtitle-preview';
                subEl.textContent = subText;
                row2.appendChild(subEl);
            }

            body.appendChild(row1);
            body.appendChild(row2);

            // ── delete button ──
            const delBtn = document.createElement('button');
            delBtn.className = 'clip-delete-btn';
            delBtn.textContent = '×';
            delBtn.title = '删除此片段';
            delBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (__isClipEditLocked()) {
                    showAlertModal('当前正在切片或已有合并任务排队，无法删除片段');
                    return;
                }
                try {
                    const startText = formatTime(c.start);
                    const endText = formatTime(c.end);
                    const cs = Number(c.start), ce = Number(c.end);
                    const fileName = String(video && video.name ? video.name.split('/').pop() : '');
                    var subLines = '';
                    if (__subtitleData && __subtitleData.length) {
                        var subs = __subtitleData.filter(function (s) {
                            if (!(s.start < ce && s.end > cs)) return false;
                            if (c._subEnd !== undefined && s.start === c._subEnd) return false;
                            if (c._subStart !== undefined && s.end === c._subStart) return false;
                            return true;
                        }).map(function (s) { return s.text; });
                        if (subs.length) {
                            subLines = '\n字幕：\n  -  「' + subs.join('」\n  -  「') + '」';
                        }
                    }
                    const ok = await showConfirmModal(`文件：${fileName}\n片段：${startText} - ${endText}${subLines}\n\n确定要删除该片段吗？`, { title: '删除确认', okText: '删除', cancelText: '取消' });
                    if (!ok) return;
                } catch (e) { return; }

                video.clips.splice(clipIdx, 1);
                if (video.clips.length === 0) {
                    videoTasks.splice(taskIdx, 1);
                }
                __clipListSelected.delete(globalIdx - 1);
                renderNewClipList();
                __saveClipToolState();
                showToast('片段已删除');
            });

            // ── drag events ──
            if (!isLocked) {
                card.addEventListener('dragstart', (e) => {
                    if (__isClipEditLocked()) {
                        showAlertModal('当前正在切片或已有合并任务排队，无法调整片段顺序');
                        e.preventDefault();
                        return;
                    }
                    __mainListDragFromIndex = globalIdx;
                    card.classList.add('dragging');
                    try {
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', String(globalIdx));
                    } catch (err) { }
                });

                card.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    try { e.dataTransfer.dropEffect = 'move'; } catch (err) { }
                    if (__mainListDragFromIndex === null) return;
                    const rect = card.getBoundingClientRect();
                    const y = e.clientY - rect.top;
                    const mid = rect.height / 2;
                    card.classList.toggle('drag-before', y <= mid);
                    card.classList.toggle('drag-after', y > mid);
                });

                card.addEventListener('dragleave', () => {
                    card.classList.remove('drag-before', 'drag-after');
                });

                card.addEventListener('drop', (e) => {
                    e.preventDefault();
                    if (__isClipEditLocked()) {
                        showAlertModal('当前正在切片或已有合并任务排队，无法调整片段顺序');
                        clearDragState();
                        return;
                    }
                    const from = __mainListDragFromIndex;
                    let to = globalIdx;
                    if (card.classList.contains('drag-after')) {
                        to = globalIdx + 1;
                    }
                    clearDragState();
                    if (from === null || from === undefined) return;
                    reorderByGlobalIndex(from, to);
                });

                card.addEventListener('dragend', () => {
                    clearDragState();
                });
            }

            // ── click for batch select ──
            if (!isLocked) {
                card.addEventListener('click', () => {
                    if (__clipListBatchMode) {
                        __toggleClipSelection(globalIdx);
                    }
                });
            }

            card.appendChild(cb);
            card.appendChild(idxEl);
            card.appendChild(body);
            card.appendChild(delBtn);
            frag.appendChild(card);
        });
    });

    try { __updateSubtitleSliceState(); } catch (e) { }
    newClipListContainer.replaceChildren(frag);
    __restorePageScrollStateSoon(scrollState);
}

function __updateSubtitleSliceState() {
    if (subtitleSlicePanel && subtitleSlicePanel.style.display !== 'none') {
        __subtitleAddedCacheKey = '';
        __renderSubtitleList();
    }
}


// ==================== 帧精确播放器（WebCodecs + mp4box.js） ====================

class FrameAccuratePlayer {
    constructor(canvas, audioEl) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.audio = audioEl || null;
        this.fps = 30;
        this.totalFrames = 0;
        this.currentFrame = 0;
        this.playing = false;
        this._frames = new Map();
        this._sampleQueue = [];
        this._decoder = null;
        this._file = null;
        this._ready = false;
        this._startTime = 0;
        this._rafId = null;
        this._preloadRange = 300;
        this._seekRequested = -1;
        this._frameCallbacks = [];
        this._tsToFrameIdx = new Map();
        this._firstFrameTs = null;
        this._sampleIndex = 0;
        this._frameIdxMin = undefined;
        this._playEndFrame = Infinity;
        this._playStartFrame = 0;
        this.onEnd = null;
        this._maxLoadSize = 0;
    }

    get ready() { return this._ready; }
    get currentTime() { return this.fps > 0 ? this.currentFrame / this.fps : 0; }
    get duration() { return this.fps > 0 ? this.totalFrames / this.fps : 0; }

    onFrame(cb) { this._frameCallbacks.push(cb); }

    async load(url, options = {}) {
        this._reset();
        try {
            const maxSize = options.maxSize || 0;
            if (maxSize > 0) {
                const headResp = await fetch(url, { method: 'HEAD' });
                const cl = parseInt(headResp.headers.get('Content-Length') || '0');
                if (cl > maxSize) {
                    throw new Error(`File too large (${(cl/1024/1024).toFixed(0)}MB > ${(maxSize/1024/1024).toFixed(0)}MB)`);
                }
                this._maxLoadSize = maxSize;
            }
            const resp = await fetch(url);
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            return await this._loadFromResponse(resp);
        } catch (e) {
            console.warn('FrameAccuratePlayer load failed:', e);
            this._ready = false;
            throw e;
        }
    }

    async _loadFromResponse(resp) {
        const self = this;
        const mp4boxFile = MP4Box.createFile();
        this._file = mp4boxFile;

        return new Promise((resolve, reject) => {
            mp4boxFile.onReady = (info) => {
                try {
                    const vt = info.videoTracks[0];
                    if (!vt) { reject(new Error('No video track')); return; }
                    const tb = vt.timescale;
                    const dur = vt.movie_duration;
                    self.fps = vt.nb_samples / (dur / tb);
                    self.totalFrames = vt.nb_samples;
                    self.canvas.width = vt.video.width;
                    self.canvas.height = vt.video.height;

                    const avcc = vt.trak?.mdia?.minf?.stbl?.stsd?.entries?.[0]?.avcC?.data;
                    const description = avcc ? new Uint8Array(avcc) : null;

                    self._decoder = new VideoDecoder({
                        output: (frame) => self._onDecodedFrame(frame),
                        error: (e) => console.error('VideoDecoder error:', e),
                    });
                    self._decoder.configure({
                        codec: vt.codec || 'avc1.64001F',
                        codedWidth: vt.video.width,
                        codedHeight: vt.video.height,
                        ...(description ? { description } : {}),
                    });
                    self._ready = true;
                    self._flushQueue();
                    resolve();
                } catch (e) { reject(e); }
            };

            mp4boxFile.onSamples = (id, user, samples) => {
                for (const s of samples) {
                    const idx = Math.round(s.cts / s.timescale * self.fps);
                    if (self._frameIdxMin === undefined || idx < self._frameIdxMin) self._frameIdxMin = idx;
                    self._sampleQueue.push({
                        data: s.data,
                        ts: s.cts,
                        dur: s.duration,
                        isKey: s.is_sync,
                        frameIdx: idx,
                    });
                }
                if (self._ready) self._flushQueue();
                if (self._seekRequested >= 0) self._doSeek(self._seekRequested);
            };

            mp4boxFile.onError = (e) => reject(new Error('mp4box error: ' + e));

            resp.arrayBuffer().then(buf => {
                mp4boxFile.appendBuffer(buf);
                mp4boxFile.flush();
            }).catch(reject);
        });
    }

    _flushQueue() {
        while (this._sampleQueue.length && this._decoder && this._decoder.decodeQueueSize < 30) {
            const s = this._sampleQueue.shift();
            try {
                this._tsToFrameIdx.set(s.ts, s.frameIdx);
                this._decoder.decode(new EncodedVideoChunk({
                    type: s.isKey ? 'key' : 'delta',
                    timestamp: s.ts,
                    duration: s.dur,
                    data: s.data,
                }));
            } catch (e) { }
        }
    }

    _onDecodedFrame(frame) {
        const ts = frame.timestamp;
        let idx = this._tsToFrameIdx.get(ts);
        if (idx === undefined) {
            const fallback = Math.round(ts / 1e6 * this.fps);
            idx = fallback;
            this._tsToFrameIdx.set(ts, fallback);
        }
        const normalizedIdx = (this._frameIdxMin != null) ? idx - this._frameIdxMin : idx;
        const old = this._frames.get(normalizedIdx);
        if (old) old.close();
        this._frames.set(normalizedIdx, frame);
        for (const k of this._frames.keys()) {
            if (Math.abs(k - this.currentFrame) > this._preloadRange * 2) {
                const f = this._frames.get(k);
                if (f) f.close();
                this._frames.delete(k);
            }
        }
        if (normalizedIdx === this.currentFrame || normalizedIdx === this.currentFrame + 1) {
            this._renderFrame(frame);
        }
    }

    _renderFrame(frame) {
        if (!frame) {
            // Try nearest available
            for (let off = 0; off < 10; off++) {
                const f = this._frames.get(this.currentFrame - off);
                if (f) { frame = f; break; }
            }
            if (!frame) return;
        }
        this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
        const n = this.currentFrame;
        this.ctx.fillStyle = 'rgba(0,0,0,0.6)';
        this.ctx.fillRect(4, 4, 90, 26);
        this.ctx.fillStyle = '#4f9eff';
        this.ctx.font = 'bold 18px monospace';
        this.ctx.fillText('#' + n, 8, 24);
        for (const cb of this._frameCallbacks) cb(n);
    }

    _render() {
        const frame = this._frames.get(this.currentFrame);
        this._renderFrame(frame);
    }

    seekToFrame(n) {
        n = Math.max(0, Math.min(n, this.totalFrames - 1));
        if (n === this.currentFrame) return;

        this.currentFrame = n;
        if (this.audio && this.fps > 0) {
            try { this.audio.currentTime = n / this.fps; } catch (e) { }
        }

        const frame = this._frames.get(n);
        if (frame) {
            this._renderFrame(frame);
            return;
        }

        // 需要 seek 解码——当前简单实现：跳到最近关键帧重新开始
        this._seekRequested = n;
        this._doSeek(n);
    }

    _doSeek(n) {
        if (!this._file) return;
        // 重置解码器
        if (this._decoder && this._decoder.state !== 'closed') {
            try { this._decoder.close(); } catch (e) { }
        }
        this._decoder = null;
        // 清空队列和帧缓存
        this._sampleQueue = [];
        for (const f of this._frames.values()) {
            try { f.close(); } catch (e) { }
        }
        this._frames.clear();

        // 重新配置解码器并 seek
        const vt = this._file.info?.videoTracks?.[0];
        if (!vt) return;
        const avcc = vt.trak?.mdia?.minf?.stbl?.stsd?.entries?.[0]?.avcC?.data;
        const description = avcc ? new Uint8Array(avcc) : null;

        const self = this;
        this._decoder = new VideoDecoder({
            output: (frame) => self._onDecodedFrame(frame),
            error: (e) => console.error('seek decode error:', e),
        });
        this._decoder.configure({
            codec: vt.codec || 'avc1.64001F',
            codedWidth: vt.video.width,
            codedHeight: vt.video.height,
            ...(description ? { description } : {}),
        });
        this._ready = true;
        this._sampleIndex = n;
        this._firstFrameTs = null;
        this._frameIdxMin = undefined;
        this._seekRequested = -1;

        // 从目标帧前若干帧开始 seek
        const seekFrame = Math.max(0, n - 30);
        const seekTime = seekFrame / this.fps;
        this._file.setExtractionOptions(vt.id, null, { nbSamples: this.totalFrames - seekFrame });
        this._file.seek(seekTime, true);
        this._flushQueue();
    }

    play(startFrame, endFrame) {
        if (!this._ready || this.playing) return;
        if (startFrame != null) {
            this._playStartFrame = Math.max(0, Math.min(startFrame, this.totalFrames - 1));
        } else {
            this._playStartFrame = this.currentFrame;
        }
        this._playEndFrame = (endFrame != null)
            ? Math.min(endFrame, this.totalFrames - 1)
            : (this.totalFrames - 1);
        this.seekToFrame(this._playStartFrame);
        this.playing = true;
        this._startTime = performance.now() / 1000 - this.currentFrame / this.fps;
        if (this.audio) {
            try { this.audio.currentTime = this.currentFrame / this.fps; this.audio.play().catch(() => {}); } catch (e) { }
        }
        this._tick();
    }

    pause() {
        this.playing = false;
        if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
        if (this.audio) { try { this.audio.pause(); } catch (e) { } }
    }

    stop() {
        this.pause();
        this.seekToFrame(this._playStartFrame);
    }

    _tick() {
        if (!this.playing) return;
        const elapsed = performance.now() / 1000 - this._startTime;
        const frame = Math.round(elapsed * this.fps);
        if (frame > this._playEndFrame || frame >= this.totalFrames) {
            this.pause();
            if (this.onEnd) this.onEnd();
            return;
        }
        if (frame !== this.currentFrame && frame >= 0) {
            this.currentFrame = frame;
            this._render();
            this._flushQueue();
        }
        this._rafId = requestAnimationFrame(() => this._tick());
    }

    _reset() {
        this.pause();
        if (this._decoder) { try { this._decoder.close(); } catch (e) { } }
        this._decoder = null;
        for (const f of this._frames.values()) { try { f.close(); } catch (e) { } }
        this._frames.clear();
        this._sampleQueue = [];
        this._ready = false;
        this.totalFrames = 0;
        this.currentFrame = 0;
        this._seekRequested = -1;
        this._playEndFrame = Infinity;
        this._playStartFrame = 0;
        this.onEnd = null;
    }

    destroy() { this._reset(); }
}

let __framePlayer = null;
let __framePlayerActive = false;

async function __initFramePlayer(videoUrl, audioUrl) {
    const canvas = document.getElementById('frameCanvas');
    const audio = document.getElementById('audioPlayer');
    if (!canvas) return null;

    if (!__framePlayer) {
        __framePlayer = new FrameAccuratePlayer(canvas, audio);
    }
    await __framePlayer.load(videoUrl);

    __videoFpsCache = { name: currentVideoName, fps: __framePlayer.fps };

    canvas.style.display = 'block';
    document.getElementById('player').style.display = 'none';

    __framePlayerActive = true;
    return __framePlayer;
}

function __destroyFramePlayer() {
    if (__framePlayer) {
        __framePlayer.pause();
        __framePlayer.destroy();
    }
    __framePlayer = null;
    __framePlayerActive = false;
    const canvas = document.getElementById('frameCanvas');
    if (canvas) canvas.style.display = 'none';
    const v = document.getElementById('player');
    if (v) v.style.display = 'block';
}

function __startRvfcLoop() {
    if (__rvfcActive) return;
    if (__framePlayerActive) return;
    __rvfcSupportsRvfc = typeof player.requestVideoFrameCallback === 'function';
    if (!__rvfcSupportsRvfc) return;
    __rvfcActive = true;
    __rvfcLastMediaTime = null;
    function callback(now, metadata) {
        if (!__rvfcActive || __framePlayerActive) return;
        __rvfcLastMediaTime = metadata.mediaTime;
        player.requestVideoFrameCallback(callback);
    }
    player.requestVideoFrameCallback(callback);
}

function __stopRvfcLoop() {
    __rvfcActive = false;
    __rvfcLastMediaTime = null;
}

// ------------------ 片段预览（播放切片成品，100% 一致） ------------------

function __getSelectedSourceMode() {
    return document.querySelector('input[name="sourceMode"]:checked')?.value || 'encode';
}

function __buildMergeVideosPayload() {
    return (videoTasks || []).filter(v => Array.isArray(v?.clips) && v.clips.length > 0)
        .map(function (v) {
            return {
                name: v.name,
                clips: v.clips.map(function (c) {
                    return { start: Number(c.start), end: Number(c.end) };
                })
            };
        });
}

function __previewClip(name, start, end, label) {
    const overlay = document.getElementById('clipPreviewOverlay');
    const player = document.getElementById('clipPreviewPlayer');
    const title = document.getElementById('clipPreviewTitle');
    const closeBtn = document.getElementById('clipPreviewClose');
    if (!overlay || !player) return;

    title.textContent = `片段预览 – ${label}`;
    const sourceMode = __getSelectedSourceMode();
    const url = `/api/preview_clip?name=${encodeURIComponent(name)}&start=${Number(start)}&end=${Number(end)}&source_mode=${encodeURIComponent(sourceMode)}`;
    player.src = url;
    overlay.style.display = '';

    function close() {
        player.pause();
        player.removeAttribute('src');
        player.load();
        overlay.style.display = 'none';
    }

    closeBtn.onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    document.addEventListener('keydown', function escHandler(e) {
        if (e.key === 'Escape' && overlay.style.display !== 'none') {
            close();
            document.removeEventListener('keydown', escHandler);
        }
    });
}

// ------------------ 新版交互逻辑 ------------------

// 帧精确播放器优先，否则回退原生 video
function __getCurrentPlayTime() {
    if (__framePlayerActive && __framePlayer && __framePlayer.ready) {
        const fn = __framePlayer.currentFrame;
        return { time: fn / __framePlayer.fps, frame: fn, fps: __framePlayer.fps, t: fn / __framePlayer.fps };
    }
    const fps = __getVideoFpsSync() || 30;
    const startPts = __getStartPts();
    const t = (__rvfcActive && __rvfcLastMediaTime != null) ? __rvfcLastMediaTime : player.currentTime;
    const fn = fps > 0 ? Math.round(Math.max(0, t - startPts) * fps) : null;
    // time = 文件原始 PTS（带偏移，供 ffmpeg -ss 使用）
    // frame = 内容帧号（扣掉偏移，供显示使用）
    return { time: __roundClipTime(t), frame: fn, fps: fps, t: t };
}

// 更新输入框显示
function updateClipInputs() {
    newClipStartIn.value = tempStart !== null ? formatTime(tempStart) : '';
    newClipEndIn.value = tempEnd !== null ? formatTime(tempEnd) : '';

    if (tempStart !== null) newClipStartIn.style.borderColor = 'var(--accent-color)';
    else newClipStartIn.style.borderColor = 'var(--border-color)';

    if (tempEnd !== null) newClipEndIn.style.borderColor = 'var(--accent-color)';
    else newClipEndIn.style.borderColor = 'var(--border-color)';

    // 同步更新控制栏常驻显示
    if (ctrlStartDisp) ctrlStartDisp.textContent = tempStart !== null ? formatTime(tempStart) : '--:--:--';
    if (ctrlEndDisp) ctrlEndDisp.textContent = tempEnd !== null ? formatTime(tempEnd) : '--:--:--';

    // 刷新时间轴手柄和选区
    if (typeof window.__tlUpdateHandles === 'function') window.__tlUpdateHandles();
    if (typeof window.__tlUpdateSelection === 'function') window.__tlUpdateSelection();
}

// 允许手动输入时间
function handleManualTimeInput(e, isStart) {
    const val = e.target.value.trim();
    if (!val) {
        if (isStart) tempStart = null;
        else tempEnd = null;
        e.target.style.borderColor = 'var(--border-color)';
        return;
    }

    const sec = parseTime(val);
    if (Number.isFinite(sec)) {
        const rounded = __roundClipTime(sec);
        if (isStart) tempStart = rounded;
        else tempEnd = rounded;
        e.target.style.borderColor = 'var(--accent-color)';
    } else {
        // 解析失败
        e.target.style.borderColor = 'red';
    }
}

newClipStartIn.addEventListener('input', (e) => handleManualTimeInput(e, true));
newClipEndIn.addEventListener('input', (e) => handleManualTimeInput(e, false));

if (setStartBtn) {
    setStartBtn.addEventListener('click', () => {
        // 未选择视频 -> 提示选择；已选择但未预览 -> 提示先预览后设点
        if (!currentVideoName) {
            showAlertModal('请先选择视频');
            return;
        }

        // 要求用户必须先打开预览（主播放器可见并已加载 src，或合并预览弹窗已打开并加载视频）
        const hasActivePreview = (() => {
            if (__framePlayerActive && __framePlayer && __framePlayer.ready) return true;
            try {
                if (player) {
                    const psrc = player.getAttribute('src') || player.currentSrc || '';
                    const vis = (playerWrapper && window.getComputedStyle(playerWrapper).display !== 'none');
                    if (psrc && vis) return true;
                }
            } catch (e) { }
            return false;
        })();

        if (!hasActivePreview) {
            showToast('已选择视频，请先点击预览以加载视频，再设定起点');
            return;
        }

        const r = __getCurrentPlayTime(); tempStart = r.time; tempStartFrame = r.frame;
        updateClipInputs();
        showToast(`起点: ${formatTime(r.time)}`);

        // 如果终点已设，自动尝试添加片段
        if (tempEnd !== null) {
            __doAddClip();
        }
    });
}

if (setEndBtn) {
    setEndBtn.addEventListener('click', () => {
        if (!currentVideoName) {
            showAlertModal('请先选择视频');
            return;
        }

        const hasActivePreview = (() => {
            if (__framePlayerActive && __framePlayer && __framePlayer.ready) return true;
            try {
                if (player) {
                    const psrc = player.getAttribute('src') || player.currentSrc || '';
                    const vis = (playerWrapper && window.getComputedStyle(playerWrapper).display !== 'none');
                    if (psrc && vis) return true;
                }
            } catch (e) { }
            return false;
        })();

        if (!hasActivePreview) {
            showToast('已选择视频，请先点击预览以加载视频，再设定终点');
            return;
        }

        const r = __getCurrentPlayTime(); tempEnd = r.time; tempEndFrame = r.frame;
        updateClipInputs();
        showToast(`终点: ${formatTime(r.time)}`);
    });
}

// clip-ctrl 按钮现在在 renderTimeline 中动态创建并绑定事件

// ---- 添加片段核心逻辑（W键和Add按钮共用）----
async function __doAddClip({ silent = false } = {}) {
    await __ensureVideoFps();
    if (__isClipEditLocked()) {
        showAlertModal('当前正在切片或已有合并任务排队，无法添加片段');
        return false;
    }
    if (!currentVideoName) {
        showAlertModal('请先选择视频');
        return false;
    }
    if (tempStart === null || tempEnd === null) {
        if (!silent) showToast('请先设定起点和终点');
        return false;
    }
    const newStart = __roundClipTime(Math.min(tempStart, tempEnd));
    const newEnd = __roundClipTime(Math.max(tempStart, tempEnd));
    if (newEnd <= newStart) {
        if (!silent) showToast('终点时间必须大于起点时间');
        return false;
    }

    let task = null;
    for (let i = videoTasks.length - 1; i >= 0; i--) {
        if (videoTasks[i].name === currentVideoName) {
            task = videoTasks[i];
            break;
        }
    }
    if (!task) {
        task = { name: currentVideoName, clips: [], fps: __getVideoFpsSync() };
        videoTasks.push(task);
    }

    // 重叠检查
    for (const vTask of videoTasks) {
        if (vTask.name !== currentVideoName) continue;
        for (const clip of vTask.clips) {
            if (newStart < clip.end && newEnd > clip.start) {
                showToast(`片段重叠：与已存在片段 [${formatTime(clip.start)} - ${formatTime(clip.end)}] 冲突`);
                return false;
            }
        }
    }

    const clipObj = { start: newStart, end: newEnd };
    if (tempStartFrame != null && tempEndFrame != null) {
        clipObj._frameStart = Math.min(tempStartFrame, tempEndFrame);
        clipObj._frameEnd = Math.max(tempStartFrame, tempEndFrame);
    }
    task.clips.push(clipObj);
    const addedIdx = task.clips.length - 1;
    tempStartFrame = tempEndFrame = null;
    tempStart = null;
    tempEnd = null;
    requestAnimationFrame(function () {
        __withStablePageScroll(function () {
            updateClipInputs();
            if (typeof window.__tlSuppressAutoFollow === 'function') {
                window.__tlSuppressAutoFollow(300);
            }
            if (typeof window.__tlSuppressObserverFlush === 'function') {
                window.__tlSuppressObserverFlush();
            }
            renderNewClipList();
            if (typeof window.__tlRenderTimeline === 'function') {
                window.__tlRenderTimeline();
            }
            if (typeof window.__tlSelectOnlyClip === 'function') {
                window.__tlSelectOnlyClip(task.name, clipObj, addedIdx);
            }
        });
        __saveClipToolState();
        showToast('✓ 片段已添加');
    });
    return true;
}

confirmAddClipBtn.addEventListener('click', () => __doAddClip());

clearAllClipsFn.addEventListener('click', async () => {
    try {
        if (__isClipEditLocked()) {
            showAlertModal('当前正在切片或已有合并任务排队，无法清空片段');
            return;
        }
    } catch (e) { /* ignore */ }

    const ok = await showConfirmModal('确定清空所有待合并的片段吗？', {
        title: '清空确认',
        okText: '清空',
        cancelText: '取消'
    });
    if (ok) {
        videoTasks = [];
        __resetClipListBatchMode();
        renderNewClipList();
        __saveClipToolState();
        showToast('已清空');
    }
});

const previewAllClipsBtn = document.getElementById('clipListPreviewAllBtn');
if (previewAllClipsBtn) {
    previewAllClipsBtn.addEventListener('click', () => {
        __openAllPreviewModal();
    });
}

// ── 全部预览弹窗（独立播放器，连续播放所有片段）──
let __allModalPlaybackClips = null;
let __allModalPlaybackToken = 0;
let __allModalRafId = null;
let __allModalUserPaused = false;
let __allModalCumulative = []; // cumulative offset of each clip's start within total timeline
let __allModalTotalDur = 0;

function __buildAllModalCumulative(clips) {
    const cum = [];
    let acc = 0;
    for (const c of clips) {
        cum.push(acc);
        acc += Math.max(0, c.end - c.start);
    }
    return { cum, total: acc };
}

function __seekAllModalToGlobal(pct) {
    const clips = __allModalPlaybackClips;
    const cum = __allModalCumulative;
    const total = __allModalTotalDur;
    if (!clips || !cum.length || total <= 0) return;
    const target = (pct / 100) * total;
    // find clip
    let clipIdx = cum.length - 1;
    for (let i = 0; i < cum.length; i++) {
        const cEnd = cum[i] + Math.max(0, clips[i].end - clips[i].start);
        if (target < cEnd) { clipIdx = i; break; }
    }
    const localOffset = Math.max(0, target - cum[clipIdx]);
    const clip = clips[clipIdx];
    const player = document.getElementById('allPreviewPlayer');
    const audio = document.getElementById('allPreviewAudio');
    const useVideo = __isVideoPreviewActive();
    const media = useVideo ? player : audio;
    if (!media) return;

    // if switching clip, restart playback from that clip
    if (clipIdx !== __allModalPlaybackIndex) {
        const token = __allModalPlaybackToken;
        __allModalPlaybackIndex = clipIdx;
        media.removeAttribute('src');
        media.load();
        __playAllModalClip(clipIdx, token, localOffset);
    } else {
        media.currentTime = clip.start + localOffset;
        __syncAllModalProgress();
    }
}

function __formatModalMediaTime(t) {
    const s = Math.max(0, Math.floor(Number(t) || 0));
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function __syncAllModalProgress() {
    const overlay = document.getElementById('allPreviewOverlay');
    if (!overlay || !overlay.classList.contains('show')) return;
    const clips = __allModalPlaybackClips;
    const cum = __allModalCumulative;
    const total = __allModalTotalDur;
    const player = document.getElementById('allPreviewPlayer');
    const audio = document.getElementById('allPreviewAudio');
    if (!clips || !cum.length || __allModalPlaybackIndex < 0) return;
    const clip = clips[__allModalPlaybackIndex];
    if (!clip) return;
    const useVideo = __isVideoPreviewActive();
    const media = useVideo ? player : audio;
    if (!media) return;
    const ct = Number(media.currentTime) || 0;
    const globalPos = cum[__allModalPlaybackIndex] + Math.max(0, ct - clip.start);
    const pct = total > 0 ? Math.min(100, (globalPos / total) * 100) : 0;
    const bar = document.getElementById('allPreviewProgressBar');
    const fill = document.getElementById('allPreviewProgressFill');
    const timeDisp = document.getElementById('allPreviewTimeDisplay');
    if (bar) bar.value = pct;
    if (fill) fill.style.width = pct + '%';
    if (timeDisp) timeDisp.textContent = `${__formatModalMediaTime(globalPos)} / ${__formatModalMediaTime(total)}`;
}

function __setAllModalPlaying(playing) {
    const btn = document.getElementById('allPreviewPlayBtn');
    if (!btn) return;
    btn.textContent = playing ? '⏸' : '▶';
    btn.title = playing ? '暂停' : '播放';
}

function __toggleAllModalPlay() {
    const clips = __allModalPlaybackClips;
    if (!clips) return;
    const player = document.getElementById('allPreviewPlayer');
    const audio = document.getElementById('allPreviewAudio');
    const useVideo = __isVideoPreviewActive();
    const media = useVideo ? player : audio;
    if (!media) return;
    if (media.paused) {
        __allModalUserPaused = false;
        media.play().catch(() => {});
        __setAllModalPlaying(true);
    } else {
        __allModalUserPaused = true;
        media.pause();
        __setAllModalPlaying(false);
    }
}

function __openAllPreviewModal() {
    const clips = __collectAllPreviewClips();
    if (clips.length === 0) { showToast('没有片段可以播放'); return; }

    const overlay = document.getElementById('allPreviewOverlay');
    const player = document.getElementById('allPreviewPlayer');
    const audio = document.getElementById('allPreviewAudio');
    const loading = document.getElementById('allPreviewLoading');
    if (!overlay || !player) return;

    // stop any existing playback
    __allModalPlaybackToken++;
    if (__allModalRafId) { cancelAnimationFrame(__allModalRafId); __allModalRafId = null; }
    if (__allModalPlaybackClips) {
        try { player.pause(); player.removeAttribute('src'); player.load(); } catch (e) { }
        try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch (e) { }
    }

    __allModalPlaybackClips = clips;
    __allModalPlaybackIndex = -1;
    __allModalUserPaused = false;
    const { cum, total } = __buildAllModalCumulative(clips);
    __allModalCumulative = cum;
    __allModalTotalDur = total;
    const token = ++__allModalPlaybackToken;

    const useVideo = __isVideoPreviewActive();
    player.style.display = useVideo ? 'block' : 'none';
    audio.style.display = useVideo ? 'none' : 'block';
    const modalBody = overlay.querySelector('.all-preview-modal-body');
    if (modalBody) modalBody.classList.toggle('audio-mode', !useVideo);

    overlay.style.display = '';
    overlay.classList.add('show');

    const progress = document.getElementById('allPreviewProgress');
    if (progress) progress.textContent = `片段 0/${clips.length}`;
    if (loading) loading.classList.add('show');
    __setAllModalPlaying(true);

    // render clip list
    const listEl = document.getElementById('allPreviewClipList');
    if (listEl) {
        const frag = document.createDocumentFragment();
        let lastVideoName = '';
        let groupIdx = 0;
        let currentGroup = null;
        let currentBody = null;
        clips.forEach((c, i) => {
            const name = String(c.name || '').split('/').pop() || '';
            if (name !== lastVideoName) {
                lastVideoName = name;
                groupIdx = 0;

                const group = document.createElement('div');
                group.className = 'all-preview-clip-group';

                const header = document.createElement('div');
                header.className = 'all-preview-clip-header';
                header.innerHTML = '<span class="apch-toggle">▼</span><span class="apch-label">' + __escapeHtml(name) + '</span>';
                header.addEventListener('click', function () {
                    const body = this.nextElementSibling;
                    if (!body) return;
                    const collapsed = body.classList.toggle('collapsed');
                    this.querySelector('.apch-toggle').textContent = collapsed ? '▶' : '▼';
                });
                group.appendChild(header);

                currentBody = document.createElement('div');
                currentBody.className = 'all-preview-clip-body';
                group.appendChild(currentBody);

                frag.appendChild(group);
                currentGroup = group;
            }
            groupIdx++;
            const item = document.createElement('div');
            item.className = 'all-preview-clip-item';
            item.dataset.apIdx = String(i);
            const dur = Math.max(0, c.end - c.start);
            item.innerHTML = '<span class="apci-idx">片段' + groupIdx + '</span>'
                + '<span class="apci-time">' + formatSubtitleTime(c.start) + ' – ' + formatSubtitleTime(c.end) + '</span>';
            currentBody.appendChild(item);
        });
        listEl.replaceChildren(frag);
    }

    __playAllModalClip(0, token, 0);
}

let __allModalPlaybackIndex = -1;

async function __playAllModalClip(index, token, seekOffset) {
    const clips = __allModalPlaybackClips;
    if (!clips || token !== __allModalPlaybackToken) return;

    if (__allModalRafId) { cancelAnimationFrame(__allModalRafId); __allModalRafId = null; }

    const player = document.getElementById('allPreviewPlayer');
    const audio = document.getElementById('allPreviewAudio');
    const loading = document.getElementById('allPreviewLoading');
    const progress = document.getElementById('allPreviewProgress');

    if (index >= clips.length) {
        // reached end — stop, don't close
        if (loading) loading.classList.remove('show');
        if (progress) progress.textContent = `播放完毕  ${clips.length}/${clips.length}`;
        __setAllModalPlaying(false);
        const listEl = document.getElementById('allPreviewClipList');
        if (listEl) listEl.querySelectorAll('.all-preview-clip-item.active').forEach(el => el.classList.remove('active'));
        // pause media
        const useVideo = __isVideoPreviewActive();
        const m = useVideo ? player : audio;
        if (m) try { m.pause(); } catch (e) {}
        return;
    }

    const clip = clips[index];
    if (!clip) { __closeAllPreviewModal(); return; }

    __allModalPlaybackIndex = index;
    if (progress) progress.textContent = `片段 ${index + 1}/${clips.length}`;
    if (loading) loading.classList.add('show');
    __setAllModalPlaying(true);

    // highlight active clip in list
    const listEl = document.getElementById('allPreviewClipList');
    if (listEl) {
        listEl.querySelectorAll('.all-preview-clip-item.active').forEach(el => el.classList.remove('active'));
        const activeEl = listEl.querySelector('.all-preview-clip-item[data-ap-idx="' + index + '"]');
        if (activeEl) {
            activeEl.classList.add('active');
            // expand parent group if collapsed
            const body = activeEl.closest('.all-preview-clip-body');
            if (body && body.classList.contains('collapsed')) {
                body.classList.remove('collapsed');
                const header = body.previousElementSibling;
                if (header && header.classList.contains('all-preview-clip-header')) {
                    const tog = header.querySelector('.apch-toggle');
                    if (tog) tog.textContent = '▼';
                }
            }
            activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
    }

    const useVideo = __isVideoPreviewActive();
    const media = useVideo ? player : audio;
    const url = useVideo
        ? '/api/video/' + encodeURIComponent(clip.name)
        : '/api/audio/' + encodeURIComponent(clip.name);

    // check if we need to switch source (skip if same)
    const currentSrc = String(media.getAttribute('src') || '').trim();
    if (currentSrc !== url) {
        media.removeAttribute('src');
        media.load();
        media.src = url;
        media.load();
        try {
            await new Promise((resolve, reject) => {
                const onMeta = () => { media.removeEventListener('loadedmetadata', onMeta); resolve(); };
                const onErr = () => { media.removeEventListener('error', onErr); reject(); };
                media.addEventListener('loadedmetadata', onMeta);
                media.addEventListener('error', onErr);
                setTimeout(() => { media.removeEventListener('loadedmetadata', onMeta); resolve(); }, 10000);
            });
        } catch (e) {
            if (token !== __allModalPlaybackToken) return;
            if (loading) loading.classList.remove('show');
            showToast('加载失败', 'error');
            __closeAllPreviewModal();
            return;
        }
    }

    if (token !== __allModalPlaybackToken) return;
    if (loading) loading.classList.remove('show');

    // seek: start + optional offset
    const seekTarget = clip.start + (seekOffset || 0);
    try { media.currentTime = seekTarget; } catch (e) { }
    try { await media.play(); } catch (e) {
        if (token !== __allModalPlaybackToken) return;
        showToast('播放失败', 'error');
        __closeAllPreviewModal();
        return;
    }

    __syncAllModalProgress();

    // monitor until end time
    const token2 = token;
    const endTime = clip.end;
    const onEnded = () => { if (token2 === __allModalPlaybackToken) __playAllModalClip(index + 1, token2); };
    media.addEventListener('ended', onEnded, { once: true });

    // resume from user pause
    if (__allModalUserPaused) {
        media.pause();
        __setAllModalPlaying(false);
    }

    const checkTime = () => {
        if (token2 !== __allModalPlaybackToken) { __allModalRafId = null; return; }
        __syncAllModalProgress();
        if (!__allModalUserPaused && (media.currentTime || 0) >= endTime - 0.1) {
            media.removeEventListener('ended', onEnded);
            __playAllModalClip(index + 1, token2);
            return;
        }
        __allModalRafId = requestAnimationFrame(checkTime);
    };
    __allModalRafId = requestAnimationFrame(checkTime);
}

function __closeAllPreviewModal() {
    const overlay = document.getElementById('allPreviewOverlay');
    const player = document.getElementById('allPreviewPlayer');
    const audio = document.getElementById('allPreviewAudio');
    if (!overlay) return;
    __allModalPlaybackToken++;
    __allModalPlaybackClips = null;
    __allModalPlaybackIndex = -1;
    __allModalCumulative = [];
    __allModalTotalDur = 0;
    if (__allModalRafId) { cancelAnimationFrame(__allModalRafId); __allModalRafId = null; }
    try { player.pause(); player.removeAttribute('src'); player.load(); } catch (e) { }
    try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch (e) { }
    overlay.classList.remove('show');
    setTimeout(() => { overlay.style.display = 'none'; }, 300);
}

// close handlers
document.getElementById('allPreviewClose')?.addEventListener('click', __closeAllPreviewModal);
document.getElementById('allPreviewOverlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'allPreviewOverlay') __closeAllPreviewModal();
});
// play/pause
document.getElementById('allPreviewPlayBtn')?.addEventListener('click', __toggleAllModalPlay);
// progress bar seeking (global progress)
const __allPreviewBar = document.getElementById('allPreviewProgressBar');
if (__allPreviewBar) {
    __allPreviewBar.addEventListener('input', function () {
        __seekAllModalToGlobal(Number(this.value));
    });
    __allPreviewBar.addEventListener('change', function () {
        __allModalUserPaused = false;
        __setAllModalPlaying(true);
        const player = document.getElementById('allPreviewPlayer');
        const audio = document.getElementById('allPreviewAudio');
        const media = __isVideoPreviewActive() ? player : audio;
        if (media) media.play().catch(() => {});
    });
}
// click on progress wrap (for easier seeking)
const __allPreviewWrap = document.querySelector('.all-preview-progress-wrap');
if (__allPreviewWrap) {
    __allPreviewWrap.addEventListener('click', function (e) {
        if (e.target.closest('.all-preview-progress-bar')) return;
        const rect = this.getBoundingClientRect();
        const pct = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
        __seekAllModalToGlobal(pct);
        __allModalUserPaused = false;
        __setAllModalPlaying(true);
        const player = document.getElementById('allPreviewPlayer');
        const audio = document.getElementById('allPreviewAudio');
        const media = __isVideoPreviewActive() ? player : audio;
        if (media) media.play().catch(() => {});
    });
}

const batchDeleteBtn = document.getElementById('clipListBatchDeleteBtn');
if (batchDeleteBtn) {
    batchDeleteBtn.addEventListener('click', async () => {
        if (__clipListBatchMode && __clipListSelected.size > 0) {
            // perform batch delete
            const count = __clipListSelected.size;
            const ok = await showConfirmModal(`确定删除选中的 ${count} 个片段吗？`, {
                title: '批量删除确认',
                okText: '删除',
                cancelText: '取消'
            });
            if (!ok) return;
            // collect indices to delete (sorted descending to avoid index shift)
            const sorted = [...__clipListSelected].sort((a, b) => b - a);
            for (const globalIdx of sorted) {
                let acc = 0;
                for (let t = 0; t < videoTasks.length; t++) {
                    const clips = videoTasks[t].clips;
                    for (let c = 0; c < clips.length; c++) {
                        if (acc === globalIdx) {
                            clips.splice(c, 1);
                            if (clips.length === 0) {
                                videoTasks.splice(t, 1);
                            }
                            break;
                        }
                        acc++;
                    }
                    if (acc > globalIdx) break;
                }
            }
            __resetClipListBatchMode();
            renderNewClipList();
            __saveClipToolState();
            showToast(`已删除 ${count} 个片段`);
            return;
        }
        __toggleClipListBatchMode();
    });
}

document.getElementById('clipListExportBtn')?.addEventListener('click', __exportClips);
document.getElementById('clipListImportBtn')?.addEventListener('click', __importClips);

const clipListModalOverlay = document.getElementById('clipListModalOverlay');
const clipListModalClose = document.getElementById('clipListModalClose');
if (openClipListBtn) {
    openClipListBtn.addEventListener('click', function () {
        if (!clipListModalOverlay) return;
        __resetClipListBatchMode();
        clipListModalOverlay.style.display = '';
        clipListModalOverlay.classList.add('show');
        renderNewClipList();
    });
}
function __closeClipListModal() {
    if (clipListModalOverlay) {
        __resetClipListBatchMode();
        clipListModalOverlay.classList.remove('show');
        setTimeout(function () { clipListModalOverlay.style.display = 'none'; }, 300);
    }
}
if (clipListModalClose) clipListModalClose.addEventListener('click', __closeClipListModal);
if (clipListModalOverlay) {
    clipListModalOverlay.addEventListener('click', function (e) {
        if (e.target === clipListModalOverlay) __closeClipListModal();
    });
}

// ------------------ 文件名预览 ------------------
function updateFilenamePreview() {
    // 兼容后端逻辑：Default username='user', clipTitle='merged'
    const uVal = document.getElementById('usernameInput')?.value.trim();
    const cVal = document.getElementById('clipTitleInput')?.value.trim();
    const username = uVal || 'user';
    const clipTitle = cVal || 'merged';

    // 保持与后端 datetime.now().strftime("%Y%m%d-%H%M%S") 一致
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const YYYY = now.getFullYear();
    const MM = pad(now.getMonth() + 1);
    const DD = pad(now.getDate());
    const HH = pad(now.getHours());
    const min = pad(now.getMinutes());
    const ts = `${YYYY}${MM}${DD}_${HH}${min}`;

    // 格式：用户名-片段名-时间戳.mp4
    const preview = `${username}-${clipTitle}-${ts}.mp4`;
    const previewDiv = document.getElementById('filenamePreview');
    const previewText = document.getElementById('filenamePreviewText');

    if (previewText) previewText.textContent = preview;
    if (previewDiv) previewDiv.style.display = 'block';
}

const __fnUsernameInput = document.getElementById('usernameInput');
const __fnClipTitleInput = document.getElementById('clipTitleInput');

if (__fnUsernameInput) __fnUsernameInput.addEventListener('input', updateFilenamePreview);
if (__fnClipTitleInput) __fnClipTitleInput.addEventListener('input', updateFilenamePreview);

// 每秒刷新一次时间戳
setInterval(updateFilenamePreview, 1000);
// 初始化显示
window.addEventListener('load', updateFilenamePreview);
// 同时也尝试立即执行一次（针对动态加载等情况）
setTimeout(updateFilenamePreview, 500);

// ------------------ 提交任务 ------------------
document.getElementById('mergeAllBtn').addEventListener('click', async () => {
    // 如果已有运行中的合并，避免重复提交（排队由后端处理）
    if (__mergeStatusLastState && __mergeStatusLastState.running === true) {
        showToast('已有合并任务正在进行，请等待完成');
        return;
    }
    if (__mergeStatusLastState && __mergeStatusLastState.queued === true) {
        showToast('已在队列中，请稍候');
        return;
    }

    let videosToSend = null;

    // 过滤掉 clips 为空的任务组（清空/删除后可能残留空壳）
    videosToSend = __buildMergeVideosPayload();
    if (!videosToSend || videosToSend.length === 0) {
        showAlertModal('请至少添加一个视频片段');
        return;
    }

    // 总时长限制：90 分钟
    const MAX_TOTAL_SECONDS = 90 * 60;

    let totalSeconds = 0;
    for (const v of videosToSend) {
        const clips = Array.isArray(v?.clips) ? v.clips : [];
        for (const c of clips) {
            const s = Number(c?.start);
            const e = Number(c?.end);
            if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
            totalSeconds += (e - s);
        }
    }
    if (totalSeconds > MAX_TOTAL_SECONDS) {
        const maxMinutes = MAX_TOTAL_SECONDS / 60;
        showAlertModal(
            `总时长不能超过 ${maxMinutes} 分钟（当前 ${formatTime(totalSeconds)}）。请删除或缩短片段后重试。`,
            { title: '时长超限' }
        );
        return;
    }

    // 提交前确认：提示成功后将自动清空片段列表
    try {
        const ok = await showConfirmModal(
            '开始合并后，若合并成功将自动清空当前片段列表（避免重复提交）。是否继续？',
            { title: '开始合并确认', okText: '开始合并', cancelText: '取消' }
        );
        if (!ok) return;
    } catch (e) {
        // 若弹窗不可用则降级：不阻断提交流程
    }

    const username = document.getElementById('usernameInput').value.trim();
    if (!username) {
        showToast('请输入用户名');
        return;
    }

    const clipTitle = (document.getElementById('clipTitleInput')?.value || '').trim();
    const sourceMode = __getSelectedSourceMode();

    updateFloatingWidget(true, '提交任务...', true);
    mergeAllBtn.disabled = true;
    mergeAllBtn.textContent = '提交中...';

    // POST 时把 username 也传给后端
    const res = await fetch('/api/slice_merge_all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videos: videosToSend, username: username, out_basename: clipTitle || null, source_mode: sourceMode })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        updateFloatingWidget(false);
        mergeAllBtn.disabled = false;
        mergeAllBtn.textContent = '开始合并';
        showToast(data.detail || data.message || '提交失败');
        __startMergeStatusPolling({ forceFast: true });
        return;
    }

    // 保存本次任务 token（只有持有者才能看到进度/取消任务）
    __setMergeToken(data.merge_token || '');
    __setAckedJobId(''); // clear old ack

    // 立即恢复按钮状态，允许继续提交下一个任务（队列模式）
    try {
        if (mergeAllBtn) {
            mergeAllBtn.disabled = false;
            mergeAllBtn.textContent = '开始合并';
        }
    } catch (e) { }

    // 新任务开始：允许历史自动回填（仅用于补写“刚完成但未及时写入历史”的记录）
    __setOutputHistoryAutofillSuppressed(false);
    __pushLocalMergeHistory({
        job_id: data.job_id,
        username,
        out_file: data.out_file,
    });
    __startMergeStatusPolling({ forceFast: true });
    pollJob(data.job_id);
});

async function pollJob(jobId) {
    const res = await fetch(`/api/job/${jobId}`);
    const job = await res.json();
    if (job.status === 'done') {
        const outPath = String(job.out_path || '').trim();
        const safeOutPath = __escapeHtml(outPath || '');
        const downloadHref = outPath ? `/clips/${encodeURIComponent(outPath)}` : '';

        // 检查文件是否存在
        let fileExists = false;
        if (outPath) {
            try {
                const checkRes = await fetch(`/api/check_file/${encodeURIComponent(outPath)}`);
                const checkData = await checkRes.json();
                fileExists = checkData.exists === true;
            } catch (e) {
                fileExists = false;
            }
        }

        updateFloatingWidget(true, '完成', false);
        mergeAllBtn.disabled = false;
        mergeAllBtn.textContent = '开始合并';

        if (progressModalBody) {
            progressModalBody.innerHTML = `
                <div class="merge-result-card">
                    <div class="merge-result-icon">✅</div>
                    <div class="merge-result-title">合并完成</div>

                    ${safeOutPath ? `<div class="merge-result-filename">${__escapeHtml((outPath || '').split(/[\\\/]/).pop() || '')}</div>` : ''}
                    
                    ${!fileExists && outPath ? '<div id="fileNotExistWarning" class="merge-result-warning">⚠ 文件不存在或已被删除</div>' : '<div id="fileNotExistWarning" class="merge-result-warning" style="display:none;">⚠ 文件不存在或已被删除</div>'}

                    <div class="merge-result-actions">
                        <button id="downloadClipBtn" type="button" ${!fileExists ? 'disabled' : ''}>
                            下载视频${!fileExists ? ' (失效)' : ''}
                        </button>
                        <button id="copyClipLinkBtn" type="button" ${!fileExists ? 'disabled' : ''}>
                            复制链接${!fileExists ? ' (失效)' : ''}
                        </button>
                    </div>
                    <div class="clear-choice-group">
                            <label class="source-option">
                                <input type="radio" name="clearChoice" value="clear" checked>
                                <div class="source-content">
                                    <span class="source-title">清空片段列表</span>
                                    <span class="source-desc">提交后自动清空</span>
                                </div>
                            </label>
                            <label class="source-option">
                                <input type="radio" name="clearChoice" value="keep">
                                <div class="source-content">
                                    <span class="source-title">保留片段列表</span>
                                    <span class="source-desc">保持列表不变</span>
                                </div>
                            </label>
                        </div>
                    </div>
                </div>
            `;

            // no inline confirm button needed; action handled by fixed button listener
        }

        // 终态：按钮切换为确认模式
        __syncCancelMergeBtnFixed({ running: false, status: 'done', job_id: jobId });

        __addOutputToHistory(job.out_path);
        __renderOutputHistory();

        // (旧逻辑已搬移到卡片内按钮事件)
        try {
            // no-op placeholder to maintain structure
        } catch (e) {
            // ignore
        }

        // 辅助函数：检查文件是否存在
        async function checkFileExists(fileName) {
            try {
                const checkRes = await fetch(`/api/check_file/${encodeURIComponent(fileName)}`);
                const checkData = await checkRes.json();
                return checkData.exists === true;
            } catch (e) {
                return false;
            }
        }

        // 辅助函数：更新按钮状态
        function updateButtonStates(exists) {
            const warning = document.getElementById('fileNotExistWarning');
            const downloadBtn = document.getElementById('downloadClipBtn');
            const copyBtn = document.getElementById('copyClipLinkBtn');

            if (warning) {
                warning.style.display = exists ? 'none' : 'block';
            }

            [downloadBtn, copyBtn].forEach(btn => {
                if (!btn) return;
                btn.disabled = !exists;

                // 更新按钮文本
                const originalText = btn.textContent.replace('（文件不存在）', '').trim();
                btn.textContent = exists ? originalText : `${originalText}（文件不存在）`;
            });
        }

        // 下载按钮
        const downloadBtn = document.getElementById('downloadClipBtn');
        if (downloadBtn) {
            downloadBtn.addEventListener('click', async () => {
                const exists = await checkFileExists(outPath);
                if (!exists) {
                    updateButtonStates(false);
                    showToast('文件不存在，无法下载');
                    return;
                }

                // 触发下载
                const link = document.createElement('a');
                link.href = downloadHref;
                link.download = String(outPath).split(/[/\\]/).pop();
                link.click();
            });
        }

        // 复制链接按钮
        const copyBtn = document.getElementById('copyClipLinkBtn');
        if (copyBtn) {
            copyBtn.addEventListener('click', async () => {
                const exists = await checkFileExists(outPath);
                if (!exists) {
                    updateButtonStates(false);
                    showToast('文件不存在，无法复制链接');
                    return;
                }

                try {
                    const url = downloadHref ? (new URL(downloadHref, window.location.href)).toString() : '';
                    if (!url) {
                        showToast('无可复制的链接');
                        return;
                    }
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        await navigator.clipboard.writeText(url);
                        showToast('已复制下载链接');
                        return;
                    }
                    // 兜底：旧浏览器
                    const ta = document.createElement('textarea');
                    ta.value = url;
                    ta.style.position = 'fixed';
                    ta.style.left = '-9999px';
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    document.body.removeChild(ta);
                    showToast('已复制下载链接');
                } catch (e) {
                    showToast('复制失败');
                }
            });
        }
    } else if (job.status === 'error') {
        const errorText = job.error || 'Unknown error';
        updateFloatingWidget(true, '失败', false);
        mergeAllBtn.disabled = false;
        mergeAllBtn.textContent = '开始合并';

        if (progressModalBody) {
            progressModalBody.innerHTML = `
                <div class="merge-result-card error">
                    <div class="merge-result-icon">❌</div>
                    <div class="merge-result-title">合并失败</div>
                    <div class="merge-result-sub">请检查错误信息后重试</div>
                    <pre class="merge-result-error">${__escapeHtml(errorText)}</pre>
                    <div class="merge-result-actions">
                        <button id="copyErrorBtn" type="button">复制错误信息</button>
                    </div>
                </div>
            `;
        }

        __syncCancelMergeBtnFixed({ running: false, status: 'error', job_id: jobId });

        const btn = document.getElementById('copyErrorBtn');
        if (btn) {
            btn.addEventListener('click', () => {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(errorText).then(() => showToast('错误信息已复制'));
                } else {
                    const ta = document.createElement('textarea');
                    ta.value = errorText;
                    ta.style.position = 'fixed';
                    ta.style.left = '-9999px';
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    document.body.removeChild(ta);
                    showToast('错误信息已复制');
                }
            });
        }
    } else if (job.status === 'cancelled') {
        // 用户主动取消：不在页面上留下“已取消/用户取消合并”等内容
        updateFloatingWidget(false);
        mergeAllBtn.disabled = false;
        mergeAllBtn.textContent = '开始合并';
        // 终态：禁用取消按钮，但保持显示
        __syncCancelMergeBtnFixed({ running: false });
        // 取消成功：关闭进度弹窗 (body will be cleared after animation)
        try { closeProgressModal(); } catch (e) { }
        showToast('取消成功');
    } else {
        setTimeout(() => pollJob(jobId), 800);
    }
}

// ------------------ 初始化页面 ------------------
initPage();

function showAlertModal(message, opts = {}) {
    const overlay = document.getElementById('modalOverlay');
    const titleEl = document.getElementById('modalTitle');
    const msgEl = document.getElementById('modalMessage');
    const okBtn = document.getElementById('modalOk');
    const cancelBtn = document.getElementById('modalCancel');

    if (!overlay || !titleEl || !msgEl || !okBtn) {
        alert(message);
        return Promise.resolve();
    }

    const title = (opts.title ?? '提示').toString();
    const okText = (opts.okText ?? '确定').toString();

    titleEl.textContent = title;
    msgEl.textContent = (message ?? '').toString();
    okBtn.textContent = okText;

    // 分配一次性 modal token，标识当前这个 show 请求为“隐藏取消按钮”的所有者
    const myModalId = (window.__modalSeq = (window.__modalSeq || 0) + 1);
    overlay.__modalId = myModalId;

    if (cancelBtn) {
        try {
            // 先清理旧的恢复任务与监听器，再标记由本次 modal 隐藏取消按钮
            if (cancelBtn.__restoreTimer) { clearTimeout(cancelBtn.__restoreTimer); cancelBtn.__restoreTimer = null; }
            if (cancelBtn.__restoreListener) { overlay.removeEventListener('transitionend', cancelBtn.__restoreListener); cancelBtn.__restoreListener = null; }
            cancelBtn.__hiddenBy = myModalId;
            cancelBtn.style.display = 'none';
        } catch (e) { }
    }

    overlay.__previouslyFocused = document.activeElement;
    overlay.classList.add('show');
    overlay.setAttribute('aria-hidden', 'false');

    return new Promise((resolve) => {
        const cleanup = () => {
            // 先移除可见性，再稍后恢复取消按钮，避免在遮罩淡出动画期间看到“取消”按钮闪现
            __safeHideOverlay(overlay);

            okBtn.removeEventListener('click', onOk);
            overlay.removeEventListener('click', onOverlay);
            document.removeEventListener('keydown', onKeyDown);

            if (cancelBtn) {
                try {
                    // 仅在隐藏时恢复：捕获“隐藏者”token，恢复前校验 token 是否仍一致（防止竞态）
                    const hideOwner = cancelBtn.__hiddenBy ?? null;

                    if (cancelBtn.__restoreTimer) { clearTimeout(cancelBtn.__restoreTimer); cancelBtn.__restoreTimer = null; }
                    if (cancelBtn.__restoreListener) { overlay.removeEventListener('transitionend', cancelBtn.__restoreListener); cancelBtn.__restoreListener = null; }

                    const restoreIfUnchanged = () => {
                        try {
                            if ((cancelBtn.__hiddenBy ?? null) === hideOwner) {
                                cancelBtn.style.display = '';
                                cancelBtn.__hiddenBy = null;
                            }
                        } catch (e) { }
                    };

                    // 如果 overlay 仍可见（正在淡出），等待 transitionend；否则立即恢复（但仍需校验 token）
                    const visibleNow = !!(overlay && parseFloat(window.getComputedStyle(overlay).opacity) > 0);
                    if (visibleNow) {
                        const onEnd = (ev) => {
                            if (ev.target === overlay && (ev.propertyName === 'opacity' || ev.propertyName === 'visibility')) {
                                restoreIfUnchanged();
                                overlay.removeEventListener('transitionend', onEnd);
                                cancelBtn.__restoreListener = null;
                                if (cancelBtn.__restoreTimer) { clearTimeout(cancelBtn.__restoreTimer); cancelBtn.__restoreTimer = null; }
                            }
                        };
                        cancelBtn.__restoreListener = onEnd;
                        overlay.addEventListener('transitionend', onEnd);

                        // 兜底：若 transitionend 未触发，稍后强制恢复（短超时），但仍先校验 token
                        cancelBtn.__restoreTimer = setTimeout(() => {
                            restoreIfUnchanged();
                            if (cancelBtn.__restoreListener) { overlay.removeEventListener('transitionend', cancelBtn.__restoreListener); cancelBtn.__restoreListener = null; }
                            cancelBtn.__restoreTimer = null;
                        }, 380);
                    } else {
                        restoreIfUnchanged();
                    }
                } catch (e) { }
            }
        };

        const onOk = () => { cleanup(); resolve(true); };
        const onOverlay = (e) => { if (e.target === overlay) { cleanup(); resolve(false); } };
        const onKeyDown = (e) => {
            if (e.key === 'Escape') { cleanup(); resolve(false); }
            if (e.key === 'Enter') { cleanup(); resolve(true); }
        };

        okBtn.addEventListener('click', onOk);
        overlay.addEventListener('click', onOverlay);
        document.addEventListener('keydown', onKeyDown);

        setTimeout(() => okBtn.focus(), 0);
    });
}

// 点击"预览"按钮
previewBtn.addEventListener('click', async () => {
    if (!currentVideoName) {
        showAlertModal('请先选择视频');
        return;
    }
    if (!__videoPreviewEnabled) {
        showToast('请先开启视频预览');
        return;
    }

    const ok = await showConfirmModal(
        '预览视频会消耗大量流量，访问用户较多时可能出现卡顿。\n注意：预览画质可能与最终合并画质不同，仅供效果参考。\n\n确定要加载预览吗？',
        { title: '流量提示', okText: '加载预览', cancelText: '取消' }
    );
    if (!ok) return;

    playerWrapper.style.display = 'flex';
    __setVideoContainerExpanded(true);
    __mainPreviewActive = true;
    try { refreshVideoStageDim(); } catch (e) { }
    __refreshPreviewInteractiveState();
    showVideoLoadingHint('正在连接视频源…');

    // 加载原生 video
    player.src = '/api/video/' + encodeURIComponent(currentVideoName);
    _startVideoLoadWatcher(currentVideoName);
    __restoreProgressForVideo = currentVideoName;
    player.addEventListener('canplay', __maybeRestoreProgress, { once: true });

    // 获取 fps + 首帧偏移用于帧号显示
    __videoFpsCache = null;
    __ensureVideoFps().catch(() => { });

    __startRvfcLoop();

    __loadSubtitle();

    updateClipInputs();
    renderNewClipList();
});

function __seekBySeconds(seconds, label) {
    if (!__isVideoReady()) return;
    player.pause();
    const t = __seekPrecise((player.currentTime || 0) + seconds);
    updateProgress(t, player.duration);
    if (typeof progressBar !== 'undefined' && progressBar) progressBar.value = t;
    try { showToast(`${label} — ${formatTime(t)}`); } catch (err) { }
}

function __seekBack5() { __seekBySeconds(-5, '后退 5 秒'); }
function __seekBack1() { __seekBySeconds(-1, '后退 1 秒'); }
function __seekForward1() { __seekBySeconds(1, '前进 1 秒'); }
function __seekForward5() { __seekBySeconds(5, '前进 5 秒'); }

function __syncSpeedSelectVisualState() {
    if (!speedSelect) return;
    const val = String(speedSelect.value || '1.0');
    if (speedSelectToggle) speedSelectToggle.textContent = `${val}x ▾`;
    if (speedSelectMenu) {
        speedSelectMenu.querySelectorAll('.tl-dropdown-item[data-speed]').forEach(function (btn) {
            btn.classList.toggle('active', String(btn.dataset.speed || '') === val);
        });
    }
}

function __refreshPreviewInteractiveState() {
    try { __syncVideoControlsDisabledState(); } catch (e) { }
    try { __syncSpeedSelectVisualState(); } catch (e) { }
    try {
        const hasTimeline = !!document.getElementById('tlWrap');
        const dur = Number(player && player.duration);
        const canTimelineInteractNow = !!(currentVideoName && Number.isFinite(dur) && dur > 0 && __isVideoReady());
        const zoomToggleEl = document.querySelector('#timelineArea .tl-dropdown .tl-btn');
        const timelineStateStale = !!(zoomToggleEl && zoomToggleEl.disabled === canTimelineInteractNow);

        if ((!hasTimeline || timelineStateStale) && typeof window.__tlRenderTimeline === 'function') {
            window.__tlRenderTimeline();
        } else {
            if (typeof window.__tlUpdatePlayhead === 'function') {
                window.__tlUpdatePlayhead(player.currentTime || 0);
            }
            if (typeof window.__tlUpdateSelection === 'function') {
                window.__tlUpdateSelection();
            }
        }
    } catch (e) { }
}

// 倍速控制
if (speedSelect) {
    speedSelect.addEventListener('change', () => {
        player.playbackRate = parseFloat(speedSelect.value);
        __syncSpeedSelectVisualState();
        // 用户选择完速率后把焦点移回播放器（保证全局快捷键如 Space/Arrow 可用）
        try { speedSelect.blur(); } catch (e) { }
        setTimeout(() => { try { if (playerWrapper && typeof playerWrapper.focus === 'function') playerWrapper.focus({ preventScroll: true }); } catch (e) { } }, 0);
    });

    __syncSpeedSelectVisualState();
}

if (speedSelectToggle && speedSelectGroup) {
    speedSelectToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        if (speedSelectToggle.disabled) return;
        // 关闭同级下拉菜单
        document.querySelectorAll('.tl-dropdown.open').forEach(dd => { if (dd !== speedSelectGroup) dd.classList.remove('open'); });
        speedSelectGroup.classList.toggle('open');
    });
}

if (speedSelectMenu && speedSelectGroup && speedSelect) {
    speedSelectMenu.querySelectorAll('.tl-dropdown-item[data-speed]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (btn.disabled) return;
            const nextSpeed = String(btn.dataset.speed || '').trim();
            if (!nextSpeed) return;
            speedSelect.value = nextSpeed;
            speedSelect.dispatchEvent(new Event('change', { bubbles: true }));
            speedSelectGroup.classList.remove('open');
        });
    });

    document.addEventListener('click', (e) => {
        if (!speedSelectGroup.contains(e.target)) speedSelectGroup.classList.remove('open');
    });
}

// 全屏控制
if (fullscreenBtn) {
    fullscreenBtn.addEventListener('click', () => {
        fullscreenBtn.blur(); // 移除焦点，防止后续按空格误触发按钮点击或残留焦点样式
        if (!document.fullscreenElement && !document.webkitFullscreenElement) {
            // 进入全屏
            if (playerWrapper.requestFullscreen) {
                playerWrapper.requestFullscreen();
            } else if (playerWrapper.webkitRequestFullscreen) {
                playerWrapper.webkitRequestFullscreen();
            }
        } else {
            // 退出全屏
            if (document.exitFullscreen) {
                document.exitFullscreen();
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            }
        }
    });
}

// ------------------ 自定义播放控制 ------------------
function togglePlay() {
    if (!__isVideoReady()) return;
    if (player.paused) {
        player.play().catch(() => {});
    } else {
        player.pause();
    }
}

playPauseBtn.addEventListener('click', togglePlay);

if (backwardBtn) {
    backwardBtn.addEventListener('click', () => {
        if (!__isVideoReady() || !player.duration) return;
        __seekPrecise((player.currentTime || 0) - 5);
        if (typeof triggerBtnFeedback === 'function') triggerBtnFeedback(backwardBtn);
    });
}

if (forwardBtn) {
    forwardBtn.addEventListener('click', () => {
        if (!__isVideoReady() || !player.duration) return;
        __seekPrecise((player.currentTime || 0) + 5);
        if (typeof triggerBtnFeedback === 'function') triggerBtnFeedback(forwardBtn);
    });
}

// ------------------ 移动端全屏时自动锁定横屏 ------------------
function tryLockLandscape() {
    try {
        if (screen && screen.orientation && screen.orientation.lock) {
            // 返回 Promise，可能会被拒绝，捕获后不影响主流程
            screen.orientation.lock('landscape').catch(e => console.debug('orientation.lock failed', e));
        } else if (screen && screen.lockOrientation) {
            // 旧 API
            try { screen.lockOrientation('landscape'); } catch (e) { console.debug('lockOrientation failed', e); }
        }
    } catch (e) {
        console.debug('tryLockLandscape error', e);
    }
}

function tryUnlockOrientation() {
    try {
        if (screen && screen.orientation && screen.orientation.unlock) {
            try { screen.orientation.unlock(); } catch (e) { console.debug('orientation.unlock failed', e); }
        } else if (screen && screen.unlockOrientation) {
            try { screen.unlockOrientation(); } catch (e) { console.debug('unlockOrientation failed', e); }
        }
    } catch (e) {
        console.debug('tryUnlockOrientation error', e);
    }
}

// ------------------ 全屏时 Toast 可见性修复 ------------------
// Fullscreen API：进入全屏后，通常只有“全屏元素及其子元素”会被绘制。
// toastHost 默认在 body 下，会导致全屏时看不到消息推送。
let __toastHostHomeParent = null;
let __toastHostHomeNextSibling = null;
let __toastHostHomeBottom = null;
let __toastHostFullscreenResizeHandler = null;

function __computeFullscreenToastBottomPx() {
    // 控制栏在全屏时 bottom: 30px；Toast 需要抬高到控制栏上方
    const baseBottom = 30;
    const gap = 14;
    let controlsH = 0;
    try {
        const rect = videoControlsContainer?.getBoundingClientRect();
        controlsH = Math.max(0, Math.ceil(Number(rect?.height || 0)));
    } catch (e) {
        controlsH = 0;
    }
    // 最小给一个合理值，避免 rect 取不到导致 Toast 贴底
    return Math.max(120, baseBottom + controlsH + gap);
}

function __ensureToastHostInFullscreen(fullscreenEl) {
    const host = ensureToastHost();
    if (!host || !fullscreenEl) return;

    if (!__toastHostHomeParent) {
        __toastHostHomeParent = host.parentElement;
        __toastHostHomeNextSibling = host.nextSibling;
        __toastHostHomeBottom = host.style.bottom || '';
    }

    if (host.parentElement !== fullscreenEl) {
        fullscreenEl.appendChild(host);
    }

    // 控制栏在全屏时使用了很大的 z-index，Toast 需要更高/同级才能显示在上层
    host.style.zIndex = '2147483647';

    // 抬高 Toast，避免遮挡底部控制栏
    const bottomPx = __computeFullscreenToastBottomPx();
    host.style.bottom = `calc(${bottomPx}px + env(safe-area-inset-bottom))`;

    // 全屏时窗口尺寸变化（含缩放/旋转）需要更新 bottom
    if (!__toastHostFullscreenResizeHandler) {
        __toastHostFullscreenResizeHandler = () => {
            const el = document.fullscreenElement || document.webkitFullscreenElement;
            if (el !== playerWrapper) return;
            const px = __computeFullscreenToastBottomPx();
            host.style.bottom = `calc(${px}px + env(safe-area-inset-bottom))`;
        };
        window.addEventListener('resize', __toastHostFullscreenResizeHandler, { passive: true });
    }
}

function __restoreToastHostAfterFullscreen() {
    const host = document.getElementById('toastHost');
    if (!host || !__toastHostHomeParent) return;

    if (host.parentElement !== __toastHostHomeParent) {
        __toastHostHomeParent.insertBefore(host, __toastHostHomeNextSibling);
    }
    host.style.zIndex = '2147483647';

    // 恢复默认 bottom
    if (__toastHostHomeBottom !== null) {
        host.style.bottom = __toastHostHomeBottom;
    }

    if (__toastHostFullscreenResizeHandler) {
        window.removeEventListener('resize', __toastHostFullscreenResizeHandler);
        __toastHostFullscreenResizeHandler = null;
    }
}

let __wasCompactBeforeFullscreen = false;

function onFullScreenChange() {
    const el = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement;
    const videoStageEl = document.getElementById('videoStage');

    if (el) {
        // 已进入全屏，尝试锁定横屏（仅在支持的环境有效）
        tryLockLandscape();

        // 进入全屏：把 toastHost 移到全屏元素内部，确保消息推送可见
        if (el === playerWrapper) {
            __ensureToastHostInFullscreen(el);

            // 标记 body 为全屏状态，使 CSS 小屏媒体查询中的隐藏规则不生效
            try { document.body.classList.add('fullscreen-active'); } catch (e) { /* ignore */ }

            // 进入全屏时禁用紧凑模式：先记住当前是否处于紧凑状态，再强制展开
            try {
                __wasCompactBeforeFullscreen = !!(videoContainer && videoContainer.classList.contains('video-container-compact'));
                if (__wasCompactBeforeFullscreen) {
                    __setVideoContainerExpanded(true);
                }
            } catch (e) { /* ignore */ }

            // 回退：在 JS 中为 video-stage 设置内联样式，确保全屏时真正铺满（防止 CSS 缓存或浏览器差异）
            try {
                if (videoStageEl) {
                    videoStageEl.style.aspectRatio = 'auto';
                    videoStageEl.style.maxHeight = 'none';
                    videoStageEl.style.width = '100%';
                    videoStageEl.style.height = '100%';
                    videoStageEl.style.margin = '0';
                }
            } catch (e) { /* ignore */ }
        }
    } else {
        // 退出全屏，尝试解锁
        tryUnlockOrientation();

        // 退出全屏：恢复 toastHost 原位置
        __restoreToastHostAfterFullscreen();

        // 移除 body 全屏标记
        try { document.body.classList.remove('fullscreen-active'); } catch (e) { /* ignore */ }

        // 退出全屏时恢复紧凑模式（如果进入全屏前处于紧凑状态）
        try {
            if (__wasCompactBeforeFullscreen) {
                __setVideoContainerExpanded(false);
                __wasCompactBeforeFullscreen = false;
            }
        } catch (e) { /* ignore */ }

        // 移除回退内联样式，恢复由 CSS 控制的布局
        try {
            if (videoStageEl) {
                videoStageEl.style.removeProperty('aspect-ratio');
                videoStageEl.style.removeProperty('max-height');
                videoStageEl.style.removeProperty('width');
                videoStageEl.style.removeProperty('height');
                videoStageEl.style.removeProperty('margin');
            }
        } catch (e) { /* ignore */ }
    }
}

document.addEventListener('fullscreenchange', onFullScreenChange);
document.addEventListener('webkitfullscreenchange', onFullScreenChange);
document.addEventListener('mozfullscreenchange', onFullScreenChange);
document.addEventListener('MSFullscreenChange', onFullScreenChange);

// 单击播放/暂停（增加延迟以区分双击全屏）
let clickTimer = null;

function __isPlayerWrapperFullscreen() {
    const el = document.fullscreenElement || document.webkitFullscreenElement;
    return !!el && (el === playerWrapper);
}

function __getControlsOpacity() {
    if (!videoControlsContainer) return 0;
    const style = window.getComputedStyle(videoControlsContainer);
    const opacity = parseFloat(style.opacity || '0');
    return Number.isFinite(opacity) ? opacity : 0;
}

// 记录“控制栏刚刚处于完全显示/被交互过”的时间点：用于在 click 发生时判断
let __controlsLastFullVisibleAt = 0;
let __lastPointerDownAt = 0;
let __lastPointerDownControlsOpacity = 0;

// Timer / helper for showing controls when user touches the progress bar in fullscreen
let __progressControlsVisibleTimer = null;
function __ensureProgressControlsVisible(timeout = 2200) {
    if (!playerWrapper || !__isPlayerWrapperFullscreen()) return;
    playerWrapper.classList.add('controls-visible');
    if (__progressControlsVisibleTimer) { clearTimeout(__progressControlsVisibleTimer); __progressControlsVisibleTimer = null; }
    __progressControlsVisibleTimer = setTimeout(() => {
        try { playerWrapper.classList.remove('controls-visible'); } catch (e) { }
        __progressControlsVisibleTimer = null;
    }, timeout);
}
function __clearProgressControlsVisible(shortDelay = 200) {
    if (__progressControlsVisibleTimer) { clearTimeout(__progressControlsVisibleTimer); __progressControlsVisibleTimer = null; }
    // small delay to allow click/drag to finish
    setTimeout(() => { try { playerWrapper.classList.remove('controls-visible'); } catch (e) { } }, shortDelay);
}

function __markControlsFullVisible() {
    __controlsLastFullVisibleAt = Date.now();
}

if (videoControlsContainer) {
    // hover / touch / 点击等都认为控制栏处于“完全显示”上下文
    videoControlsContainer.addEventListener('mouseenter', __markControlsFullVisible);
    videoControlsContainer.addEventListener('mousemove', __markControlsFullVisible);
    videoControlsContainer.addEventListener('pointerdown', __markControlsFullVisible, true);
    videoControlsContainer.addEventListener('touchstart', __markControlsFullVisible, { passive: true });
}

if (playerWrapper) {
    // 在 pointerdown 捕获阶段记录当时的控制栏 opacity（比 click 时更接近“点击前状态”）
    playerWrapper.addEventListener('pointerdown', () => {
        if (!__isPlayerWrapperFullscreen()) return;
        __lastPointerDownAt = Date.now();
        __lastPointerDownControlsOpacity = __getControlsOpacity();
    }, true);

    // 关键逻辑：全屏时如果控制栏“完全显示”，点击控制栏外只半隐藏，不触发播放/暂停
    playerWrapper.addEventListener('click', (e) => {
        if (!__isPlayerWrapperFullscreen()) return;

        // 点击在控制栏内部：不拦截，保持按钮/进度条等原功能
        if (e.target && e.target.closest && e.target.closest('.video-controls')) return;

        const now = Date.now();
        const pointerDownFresh = __lastPointerDownAt && (now - __lastPointerDownAt) <= 500;
        const wasFullyByPointerDown = pointerDownFresh && (__lastPointerDownControlsOpacity >= 0.95);
        // 关键：仅以“点击当下”是否完全显示为准，避免鼠标移出后仍需点击两次
        const controlsFullyShown = (__getControlsOpacity() >= 0.95) || wasFullyByPointerDown;

        if (!controlsFullyShown) return;

        // 只“半隐藏”：强制回到 0.4（解决某些移动端 hover 粘住/状态不及时的问题）
        playerWrapper.classList.add('controls-force-dim');

        // 阻止继续冒泡到 video 的 click（避免播放/暂停被触发）
        e.preventDefault();
        e.stopPropagation();
    }, true);

    // 用户移动/触摸后，解除强制半透明，让 hover 规则接管
    const __clearForceDim = () => {
        if (!__isPlayerWrapperFullscreen()) return;
        playerWrapper.classList.remove('controls-force-dim');
    };
    playerWrapper.addEventListener('mousemove', __clearForceDim, { passive: true });
    playerWrapper.addEventListener('touchstart', __clearForceDim, { passive: true });
    if (videoControlsContainer) {
        videoControlsContainer.addEventListener('mouseenter', __clearForceDim);
    }
}

player.addEventListener('click', () => {
    if (clickTimer) {
        clearTimeout(clickTimer);
        clickTimer = null;
    } else {
        clickTimer = setTimeout(() => {
            togglePlay();
            clickTimer = null;
        }, 220); // 延迟220ms，留出双击时间
    }
});

player.addEventListener('play', () => {
    playPauseBtn.textContent = '暂停';
    __mainPreviewActive = true;
    refreshVideoStageDim();
    __refreshPreviewInteractiveState();
});

player.addEventListener('pause', () => {
    playPauseBtn.textContent = '播放';
    __saveProgress(currentVideoName, player.currentTime, player.duration);
    refreshVideoStageDim();
    __refreshPreviewInteractiveState();
});

player.addEventListener('ended', () => {
    const saved = __loadProgressSingle();
    if (saved && saved.name === currentVideoName) {
        __clearProgressSingle();
    }
    refreshVideoStageDim();
    __refreshPreviewInteractiveState();
});

player.addEventListener('loadedmetadata', __refreshPreviewInteractiveState);
player.addEventListener('loadeddata', __refreshPreviewInteractiveState);
player.addEventListener('canplay', __refreshPreviewInteractiveState);
player.addEventListener('durationchange', __refreshPreviewInteractiveState);
player.addEventListener('emptied', __refreshPreviewInteractiveState);
player.addEventListener('emptied', __stopRvfcLoop);
player.addEventListener('canplay', __maybeRestoreProgress, { once: true });

// 播放器进度更新（视觉 + 缓冲显示 + 片段联动）
function updateProgress(val, max) {
    const played = (max && max > 0) ? ((val / max) * 100) : 0;
    // 尝试获取缓冲结束位置
    let bufferPct = 0;
    try {
        if (player && player.buffered && player.buffered.length) {
            const end = player.buffered.end(player.buffered.length - 1);
            bufferPct = (max && max > 0) ? Math.min(100, (end / max) * 100) : 0;
        }
    } catch (e) { bufferPct = 0; }
    const playedPct = Math.max(0, Math.min(100, played || 0));
    const bufPct = Math.max(playedPct, Math.min(100, bufferPct || 0));

    // 计算片段色块：将所有标记的片段作为主进度条背景的一部分
    let clipGradients = "";
    try {
        const flat = __flattenVideoTasksToClips();
        if (flat.length > 0 && max > 0) {
            // 构造多个叠加的线性渐变层，每个代表一个片段
            const layers = flat.map(c => {
                const s = (c.start / max) * 100;
                const e = (c.end / max) * 100;
                return `linear-gradient(to right, transparent ${s}%, rgba(79, 158, 255, 0.4) ${s}%, rgba(79, 158, 255, 0.4) ${e}%, transparent ${e}%)`;
            });
            clipGradients = layers.join(", ") + ", ";
        }
    } catch (e) { }

    if (progressBar) {
        // 多层背景：最上层是各个片段色块，底层是播放/缓冲进度
        progressBar.style.background = clipGradients + `linear-gradient(to right, var(--accent-color) 0%, var(--accent-color) ${playedPct}%, rgba(255,255,255,0.12) ${playedPct}%, rgba(255,255,255,0.12) ${bufPct}%, rgba(255,255,255,0.06) ${bufPct}%, rgba(255,255,255,0.06) 100%)`;
        progressBar.setAttribute('aria-valuenow', String(Math.round(playedPct)));
    }
}

// Progress bar interaction (keyboard + input)
if (typeof progressBar !== 'undefined' && progressBar) {
    const progressTooltip = document.getElementById('progressTooltip');
    let _tooltipHideTimer = null;

    function syncProgressBarRangeToDuration() {
        if (!progressBar || !player) return;
        const dur = Number(player.duration);
        const validDur = Number.isFinite(dur) && dur > 0 ? dur : 0;
        progressBar.min = '0';
        progressBar.max = String(validDur);
        progressBar.setAttribute('aria-valuemin', '0');
        progressBar.setAttribute('aria-valuemax', String(Math.round(validDur)));
        if (!isDragging) {
            const cur = Number(player.currentTime) || 0;
            progressBar.value = String(Math.max(0, Math.min(cur, validDur || 0)));
        }
    }

    function showProgressTooltipAt(value) {
        if (!progressTooltip || !progressBar) return;
        const max = Number(progressBar.max) || 0;
        const pct = (max > 0) ? (Number(value) / max) : 0;
        const clamped = Math.max(0, Math.min(1, pct));
        const leftPct = clamped * 100;
        progressTooltip.style.left = leftPct + '%';
        // tooltip 在拖动时显示拖动位置的时间（由调用方传入 value）
        progressTooltip.textContent = formatTime(Number(value) || 0);
        progressTooltip.classList.add('show');
        progressTooltip.setAttribute('aria-hidden', 'false');
        if (_tooltipHideTimer) { clearTimeout(_tooltipHideTimer); _tooltipHideTimer = null; }
    }
    function hideProgressTooltip(delay = 120) {
        if (!progressTooltip) return;
        if (_tooltipHideTimer) clearTimeout(_tooltipHideTimer);
        _tooltipHideTimer = setTimeout(() => {
            progressTooltip.classList.remove('show');
            progressTooltip.setAttribute('aria-hidden', 'true');
            _tooltipHideTimer = null;
        }, delay);
    }

    // pointer/touch support + dragging flag
    progressBar.addEventListener('pointerdown', (ev) => { isDragging = true; showProgressTooltipAt(Number(progressBar.value)); if (__isPlayerWrapperFullscreen()) __ensureProgressControlsVisible(); });
    document.addEventListener('pointerup', (ev) => {
        if (isDragging) {
            isDragging = false;
            hideProgressTooltip(220);
            try {
                if (playerWrapper && typeof playerWrapper.focus === 'function') playerWrapper.focus({ preventScroll: true });
                else if (player && typeof player.focus === 'function') player.focus();
            } catch (err) { /* ignore */ }
            if (__isPlayerWrapperFullscreen()) __clearProgressControlsVisible();
        }
    });
    progressBar.addEventListener('pointermove', (ev) => { if (isDragging) showProgressTooltipAt(Number(progressBar.value)); });

    progressBar.addEventListener('touchstart', (ev) => { isDragging = true; showProgressTooltipAt(Number(progressBar.value)); if (__isPlayerWrapperFullscreen()) __ensureProgressControlsVisible(); });
    document.addEventListener('touchend', (ev) => {
        if (isDragging) {
            isDragging = false;
            hideProgressTooltip(220);
            try {
                if (playerWrapper && typeof playerWrapper.focus === 'function') playerWrapper.focus({ preventScroll: true });
                else if (player && typeof player.focus === 'function') player.focus();
            } catch (err) { /* ignore */ }
            if (__isPlayerWrapperFullscreen()) __clearProgressControlsVisible();
        }
    });

    progressBar.addEventListener('input', () => {
        try { if (typeof window.__tlSuppressAutoFollow === 'function') window.__tlSuppressAutoFollow(450); } catch (e) { }
        const v = Number(progressBar.value) || 0;
        // 拖动时只在 tooltip 显示拖动位置时间；页面其它地方（如 timeDisplay）保持显示当前播放时间
        const cur = formatSubtitleTime(player.currentTime || 0);
        const dur = formatSubtitleTime(player.duration || 0);
        timeDisplay.textContent = `${cur} / ${dur}`;
        updateProgress(v, player.duration);
        // show tooltip during interaction (tooltip shows scrubbed position)
        showProgressTooltipAt(v);
        // 同步联动时间轴播放头
        if (typeof window.__tlUpdatePlayhead === 'function') window.__tlUpdatePlayhead(v);
    });

    progressBar.addEventListener('change', () => {
        try { if (typeof window.__tlSuppressAutoFollow === 'function') window.__tlSuppressAutoFollow(700); } catch (e) { }
        const target = __seekPrecise(Number(progressBar.value) || 0);
        try { if (typeof window.__tlUpdatePlayhead === 'function') window.__tlUpdatePlayhead(target); } catch (e) { }
        __saveProgress(currentVideoName, player.currentTime, player.duration);
        hideProgressTooltip(400);
        try { if (playerWrapper && typeof playerWrapper.focus === 'function') playerWrapper.focus({ preventScroll: true }); } catch (e) { }
    });

    progressBar.addEventListener('click', () => {
        try { if (typeof window.__tlSuppressAutoFollow === 'function') window.__tlSuppressAutoFollow(700); } catch (e) { }
        const dur = Number(player.duration) || 0;
        if (!(dur > 0)) return;
        const target = __seekPrecise(Number(progressBar.value) || 0);
        try { if (typeof window.__tlUpdatePlayhead === 'function') window.__tlUpdatePlayhead(target); } catch (e) { }
        __saveProgress(currentVideoName, player.currentTime, player.duration);
        updateProgress(player.currentTime, player.duration);
    });

    // keyboard accessibility + brief tooltip
    progressBar.addEventListener('keydown', (ev) => {
        if (!player || !player.duration) return;
        let handled = false;
        switch (ev.key) {
            case 'ArrowLeft': __seekPrecise(Math.max(0, (player.currentTime || 0) - 5)); handled = true; break;
            case 'ArrowRight': __seekPrecise(Math.min(player.duration, (player.currentTime || 0) + 5)); handled = true; break;
            case 'Home': __seekPrecise(0); handled = true; break;
            case 'End': __seekPrecise(player.duration || 0); handled = true; break;
            case 'PageUp': __seekPrecise(Math.min(player.duration, (player.currentTime || 0) + 10)); handled = true; break;
            case 'PageDown': __seekPrecise(Math.max(0, (player.currentTime || 0) - 10)); handled = true; break;
            case ' ':
            case 'Spacebar':
                // 进度条获得焦点时，空格切换播放/暂停（与全局空格行为保持一致）
                togglePlay();
                triggerBtnFeedback(playPauseBtn);
                handled = true;
                break;
        }
        if (handled) {
            updateProgress(player.currentTime, player.duration);
            progressBar.value = player.currentTime;
            showProgressTooltipAt(player.currentTime);
            __saveProgress(currentVideoName, player.currentTime, player.duration);
            ev.preventDefault();
            hideProgressTooltip(700);
        }
    });

    progressBar.addEventListener('focus', () => { showProgressTooltipAt(Number(progressBar.value || player.currentTime || 0)); });
    progressBar.addEventListener('blur', () => { hideProgressTooltip(120); });

    player.addEventListener('loadedmetadata', syncProgressBarRangeToDuration);
    player.addEventListener('durationchange', syncProgressBarRangeToDuration);
    player.addEventListener('emptied', syncProgressBarRangeToDuration);
    syncProgressBarRangeToDuration();
}

player.addEventListener('timeupdate', () => {
    const cur = formatSubtitleTime(player.currentTime);
    const dur = formatSubtitleTime(player.duration || 0);
    timeDisplay.textContent = `${cur} / ${dur}`;

    // 更新进度条位置和视觉（非拖拽时）
    if (progressBar && !isDragging) {
        progressBar.value = player.currentTime;
        updateProgress(player.currentTime, player.duration);
    }

    // 节流保存播放进度
    const now = Date.now();
    if (now - __lastProgressSaveAt >= VIDEO_PROGRESS_SAVE_INTERVAL_MS) {
        __lastProgressSaveAt = now;
        __saveProgress(currentVideoName, player.currentTime, player.duration);
    }
});

player.addEventListener('seeked', () => {
    __rvfcLastMediaTime = null;
    if (progressBar) {
        progressBar.value = player.currentTime;
        updateProgress(player.currentTime, player.duration);
    }
});

// ---------- 字幕功能 ----------
async function __loadSubtitle() {
    if (!currentVideoName) return;
    __subtitleData = [];
    __subtitleEnabled = false;
    __subtitleSelectedIndex = -1;
    __subtitleEditingIndex = -1;
    __subtitleEditOrigData = null;
    __subtitlePageIndex = 0;
    __syncSubtitleToolbar();

    try {
        const resp = await fetch(`/api/subtitle/${encodeURIComponent(currentVideoName)}?fmt=json&_t=${Date.now()}`, { cache: 'no-store' });
        if (!resp.ok) return;
        const data = await resp.json();
        if (!data || !Array.isArray(data.subtitles) || data.subtitles.length === 0) return;

        __subtitleData = data.subtitles.map(function (s) {
            return { start: s.start, end: s.end, text: s.text };
        });
        __subtitleEnabled = true;

        // 从统一进度定位字幕页：找到保存时间对应的字幕，计算页码
        var saved = __loadProgressSingle();
        if (saved && saved.name === currentVideoName) {
            var subIdx = __findSubtitleIndex(saved.t);
            if (subIdx >= 0) {
                __subtitlePageIndex = Math.floor(subIdx / __subtitlePageSize);
            }
        }
        __syncSubtitleToolbar();
    } catch (e) {
        console.warn('字幕加载失败:', e);
    }
}

function __findSubtitleIndex(time) {
    if (!__subtitleData.length) return -1;
    const subs = __subtitleData;
    let lo = 0;
    let hi = subs.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const item = subs[mid];
        if (time >= item.start && time < item.end) return mid;
        if (time < item.start) hi = mid - 1;
        else lo = mid + 1;
    }
    return -1;
}

// ---------- 字幕切片功能 ----------
let __audioSrc = null;
let __audioSrcVideoName = '';
let __audioPlayingIndex = -1;
let __audioLoadingIndex = -1;
let __audioSegmentEnd = 0;
let __audioRafId = null;
let __audioSegmentTimeoutId = null;
let __audioPlaybackToken = 0;
let __audioPendingLoadedmeta = null;
let __audioPendingPlaying = null;
let __subtitleAudioPlaybackStarted = false;
let __subtitleItemEls = [];
let __subtitleListInited = false;
let __subtitleSelectedIndex = -1;
let __subtitleEditingIndex = -1;
let __subtitleEditOrigData = null;
const SUBTITLE_VIRTUAL_ROW_HEIGHT = 86;
const SUBTITLE_VIRTUAL_BUFFER = 8;
const SUBTITLE_PAGE_SIZE_MIN = 4;
const SUBTITLE_PAGE_SIZE_MAX = 14;
const SUBTITLE_PAGE_SIZE_FALLBACK = 8;
let __subtitlePageSize = SUBTITLE_PAGE_SIZE_FALLBACK;
let __subtitlePageIndex = 0;
let __subtitlePageSizeViewportHeight = null;
let __subtitleVirtualStart = -1;
let __subtitleVirtualEnd = -1;
let __subtitleVirtualScrollBound = false;
let __subtitleVirtualScrollRaf = null;
let __subtitleResizeRaf = null;
let __subtitleAddedFlags = [];
let __subtitleAddedCacheKey = '';
let __subtitleLastPageIndex = -1;
const audioPlayer = document.getElementById('audioPlayer');
const subtitleSlicePanel = document.getElementById('subtitleSlicePanel');
const subtitleListContainer = document.getElementById('subtitleListContainer');
const subtitleToolbarPlayBtn = document.getElementById('subtitleToolbarPlayBtn');
const subtitleToolbarEditBtn = document.getElementById('subtitleToolbarEditBtn');
const subtitleToolbarAddBtn = document.getElementById('subtitleToolbarAddBtn');
const subtitleToolbarSaveBtn = document.getElementById('subtitleToolbarSaveBtn');
const subtitleToolbarCancelBtn = document.getElementById('subtitleToolbarCancelBtn');
const subtitleToolbarDeleteBtn = document.getElementById('subtitleToolbarDeleteBtn');
const subtitlePager = document.getElementById('subtitlePager');
const subtitlePrevPageBtn = document.getElementById('subtitlePrevPageBtn');
const subtitleNextPageBtn = document.getElementById('subtitleNextPageBtn');
const subtitlePageInfo = document.getElementById('subtitlePageInfo');
const subtitlePageJumpInput = document.getElementById('subtitlePageJumpInput');
const subtitlePageJumpBtn = document.getElementById('subtitlePageJumpBtn');
const subtitlePageUndoBtn = document.getElementById('subtitlePageUndoBtn');

function __showSubtitleSlicePanel() {
    if (!subtitleSlicePanel || !__subtitleData.length) return;
    subtitleSlicePanel.style.display = '';
    __renderSubtitleList();
    __syncSubtitleToolbar();
}

function __hideSubtitleSlicePanel() {
    if (!subtitleSlicePanel) return;
    subtitleSlicePanel.style.display = 'none';
}

function __resetSubtitleVirtualList() {
    __subtitleItemEls = [];
    __subtitleListInited = false;
    __subtitleVirtualStart = -1;
    __subtitleVirtualEnd = -1;
}

function __calculateSubtitlePageSize() {
    if (!subtitleListContainer || !subtitleSlicePanel || subtitleSlicePanel.style.display === 'none') return __subtitlePageSize;
    const rect = subtitleListContainer.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const pagerHeight = subtitlePager && subtitlePager.style.display !== 'none' ? subtitlePager.offsetHeight : 42;
    const availableHeight = Math.max(0, viewportHeight - rect.top - pagerHeight - 24);
    const rawSize = Math.floor(availableHeight / SUBTITLE_VIRTUAL_ROW_HEIGHT);
    return Math.max(SUBTITLE_PAGE_SIZE_MIN, Math.min(SUBTITLE_PAGE_SIZE_MAX, rawSize || SUBTITLE_PAGE_SIZE_MIN));
}

function __updateSubtitlePageSize() {
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    if (__subtitlePageSizeViewportHeight !== null && viewportHeight === __subtitlePageSizeViewportHeight) return false;
    const nextSize = __calculateSubtitlePageSize();
    __subtitlePageSizeViewportHeight = viewportHeight;
    if (nextSize === __subtitlePageSize) return false;
    const anchor = __getSelectedSubtitleIndex() >= 0
        ? __getSelectedSubtitleIndex()
        : Math.max(0, __subtitlePageIndex * __subtitlePageSize);
    __subtitlePageSize = nextSize;
    __subtitlePageIndex = Math.floor(anchor / __subtitlePageSize);
    __subtitleListInited = false;
    return true;
}

function __getSubtitlePageCount() {
    return Math.max(1, Math.ceil(__subtitleData.length / __subtitlePageSize));
}

function __clampSubtitlePage() {
    const pageCount = __getSubtitlePageCount();
    __subtitlePageIndex = Math.max(0, Math.min(__subtitlePageIndex, pageCount - 1));
}

function __syncSubtitlePager() {
    if (!subtitlePager) return;
    const total = __subtitleData.length;
    const pageCount = __getSubtitlePageCount();
    __clampSubtitlePage();
    subtitlePager.style.display = total > __subtitlePageSize ? '' : 'none';
    if (subtitlePageInfo) subtitlePageInfo.textContent = '第 ' + (__subtitlePageIndex + 1) + ' / ' + pageCount + ' 页，共 ' + total + ' 条，每页 ' + __subtitlePageSize + ' 条';
    if (subtitlePrevPageBtn) subtitlePrevPageBtn.disabled = __subtitlePageIndex <= 0;
    if (subtitleNextPageBtn) subtitleNextPageBtn.disabled = __subtitlePageIndex >= pageCount - 1;
}

function __setSubtitlePage(pageIndex) {
    const prevPage = __subtitlePageIndex;
    __subtitlePageIndex = Number(pageIndex) || 0;
    __clampSubtitlePage();
    if (prevPage === __subtitlePageIndex && __subtitleListInited) {
        __syncSubtitlePager();
        return;
    }
    __deselectSubtitle();
    __subtitleListInited = false;
    __renderSubtitleList();
    __saveSubtitlePageProgress();
}

function __getSelectedSubtitleIndex() {
    return (__subtitleSelectedIndex >= 0 && __subtitleSelectedIndex < __subtitleData.length) ? __subtitleSelectedIndex : -1;
}

function __selectSubtitleIndex(idx, shouldPlay) {
    if (idx < 0 || idx >= __subtitleData.length) return;
    const prev = __subtitleSelectedIndex;
    __subtitleSelectedIndex = idx;
    __saveSubtitleIndexProgress(idx);
    __refreshSubtitleRowsForIndexes(prev, idx);
    __syncSubtitleToolbar();
    if (shouldPlay) {
        if (__subtitleEditingIndex === idx) {
            __playSubtitleVideoSegmentWithEdit(idx);
        } else {
            __playSubtitleVideoSegment(idx);
        }
    }
}

function __deselectSubtitle() {
    const prev = __subtitleSelectedIndex;
    if (prev < 0) return;
    if (__subtitleEditingIndex >= 0) {
        __cancelSubtitleEdit();
    }
    __subtitleSelectedIndex = -1;
    __subtitleEditingIndex = -1;
    __refreshSubtitleRowsForIndexes(prev);
    __syncSubtitleToolbar();
}

function __syncSubtitleToolbar() {
    const idx = __getSelectedSubtitleIndex();
    const hasSelected = idx >= 0;
    const isEditing = hasSelected && __subtitleEditingIndex === idx;
    const isAdded = hasSelected && __isSubtitleAddedByIndex(idx);
    const isLoading = hasSelected && idx === __audioLoadingIndex;
    const isPlaying = hasSelected && idx === __audioPlayingIndex && !isLoading;
    const isVideoActive = __isVideoPreviewActive();

    if (subtitleToolbarPlayBtn) {
        subtitleToolbarPlayBtn.disabled = !hasSelected;
        subtitleToolbarPlayBtn.textContent = isLoading ? '加载' : (isPlaying ? '停止' : '播放');
        subtitleToolbarPlayBtn.title = isLoading ? '加载中…' : (isPlaying ? '停止播放' : (isVideoActive ? '播放当前字幕视频' : '播放当前字幕音频'));
        subtitleToolbarPlayBtn.classList.toggle('playing', isPlaying);
        subtitleToolbarPlayBtn.classList.toggle('loading', isLoading);
    }
    if (subtitleToolbarEditBtn) subtitleToolbarEditBtn.disabled = !hasSelected || isEditing;
    if (subtitleToolbarAddBtn) {
        subtitleToolbarAddBtn.disabled = !hasSelected || isEditing;
        subtitleToolbarAddBtn.textContent = isAdded ? '移除片段' : '添加片段';
        subtitleToolbarAddBtn.title = isAdded ? '删除与此字幕重叠的片段' : '添加当前字幕为片段';
    }
    if (subtitleToolbarSaveBtn) subtitleToolbarSaveBtn.disabled = !isEditing;
    if (subtitleToolbarCancelBtn) subtitleToolbarCancelBtn.disabled = !isEditing;
    if (subtitleToolbarDeleteBtn) subtitleToolbarDeleteBtn.disabled = !isEditing;
}

function __makeSubtitleAddedCacheKey() {
    const parts = [String(currentVideoName || ''), String(__subtitleData.length)];
    for (const t of (videoTasks || [])) {
        if (String(t?.name || '') !== String(currentVideoName || '')) continue;
        const clips = Array.isArray(t?.clips) ? t.clips : [];
        for (const c of clips) {
            parts.push([c.start, c.end, c._subStart, c._subEnd].map(v => String(v ?? '')).join(','));
        }
    }
    return parts.join('|');
}

function __ensureSubtitleAddedCache() {
    const key = __makeSubtitleAddedCacheKey();
    if (key === __subtitleAddedCacheKey && __subtitleAddedFlags.length === __subtitleData.length) return;

    __subtitleAddedCacheKey = key;
    __subtitleAddedFlags = new Array(__subtitleData.length).fill(false);
    if (!currentVideoName || !__subtitleData.length) return;

    let clips = [];
    for (const t of (videoTasks || [])) {
        if (String(t?.name || '') !== String(currentVideoName || '')) continue;
        clips = clips.concat(Array.isArray(t?.clips) ? t.clips : []);
    }
    clips = clips
        .map(c => ({
            start: Number(c.start),
            end: Number(c.end),
            _subStart: c._subStart,
            _subEnd: c._subEnd,
        }))
        .filter(c => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start)
        .sort((a, b) => a.start - b.start);
    if (!clips.length) return;

    let clipIdx = 0;
    for (let i = 0; i < __subtitleData.length; i++) {
        const sub = __subtitleData[i];
        const subStart = Number(sub.start);
        const subEnd = Number(sub.end);
        if (!Number.isFinite(subStart) || !Number.isFinite(subEnd)) continue;

        while (clipIdx < clips.length && clips[clipIdx].end <= subStart) clipIdx++;
        for (let j = clipIdx; j < clips.length; j++) {
            const clip = clips[j];
            if (clip.start >= subEnd) break;
            if (subStart < clip.end && subEnd > clip.start) {
                if (clip._subEnd !== undefined && subStart === clip._subEnd) continue;
                if (clip._subStart !== undefined && subEnd === clip._subStart) continue;
                __subtitleAddedFlags[i] = true;
                break;
            }
        }
    }
}

function __isSubtitleAddedByIndex(idx) {
    __ensureSubtitleAddedCache();
    return !!__subtitleAddedFlags[idx];
}

function __ensureSubtitleVirtualScrollBound() {
    if (!subtitleListContainer || __subtitleVirtualScrollBound) return;
    __subtitleVirtualScrollBound = true;
    subtitleListContainer.addEventListener('scroll', function () {
        if (__subtitleVirtualScrollRaf) return;
        __subtitleVirtualScrollRaf = requestAnimationFrame(function () {
            __subtitleVirtualScrollRaf = null;
            if (subtitleSlicePanel && subtitleSlicePanel.style.display === 'none') return;
            __renderSubtitleList();
        });
    }, { passive: true });
}

function __getSubtitleVisibleRange() {
    const total = __subtitleData.length;
    __updateSubtitlePageSize();
    __clampSubtitlePage();
    const start = Math.min(total, __subtitlePageIndex * __subtitlePageSize);
    const end = Math.min(total, start + __subtitlePageSize);
    return { start, end };
}

function __createSubtitleItemEl(i) {
    const sub = __subtitleData[i];
    const el = document.createElement('div');
    el.className = 'subtitle-list-item';
    el.dataset.subtitleIndex = String(i);
    el.title = '点击跳转到此位置';
    const isEditing = (__subtitleEditingIndex === i);
    if (isEditing) {
        const orig = __subtitleEditOrigData || sub;
        el.innerHTML = '<span class="sub-time">'
            + '<button class="sub-time-btn" data-field="start" data-step="-0.1">-0.1</button>'
            + '<input class="sub-time-input" data-field="start" value="' + formatSubtitleTime(orig.start) + '" title="开始时间">'
            + '<button class="sub-time-btn" data-field="start" data-step="0.1">+0.1</button>'
            + ' → '
            + '<button class="sub-time-btn" data-field="end" data-step="-0.1">-0.1</button>'
            + '<input class="sub-time-input" data-field="end" value="' + formatSubtitleTime(orig.end) + '" title="结束时间">'
            + '<button class="sub-time-btn" data-field="end" data-step="0.1">+0.1</button>'
            + '</span>'
            + '<span class="sub-text-edit"><textarea class="sub-textarea">' + __escapeHtml(orig.text) + '</textarea></span>';
    } else {
        el.innerHTML = '<span class="sub-time">'
            + '<span class="sub-time-value" data-field="start" title="开始时间">' + formatSubtitleTime(sub.start) + '</span>'
            + ' → '
            + '<span class="sub-time-value" data-field="end" title="结束时间">' + formatSubtitleTime(sub.end) + '</span>'
            + '</span>'
            + '<span class="sub-text">' + __escapeHtml(sub.text) + '</span>';
    }
    __applySubtitleRowState(i, el);
    return el;
}

function __applySubtitleRowState(idx, elArg) {
    const el = elArg || __subtitleItemEls[idx];
    if (!el) return;
    const isVideoActive = __isVideoPreviewActive();
    const curIdx = (isVideoActive && player && !player.paused) ? __findSubtitleIndex(player.currentTime || 0) : -1;
    const isActive = idx === curIdx;
    const isLoading = idx === __audioLoadingIndex;
    const isPlaying = idx === __audioPlayingIndex && !isLoading;
    const isAdded = __isSubtitleAddedByIndex(idx);

    el.classList.toggle('active', isActive);
    el.classList.toggle('selected', idx === __subtitleSelectedIndex);
    el.classList.toggle('playing', isPlaying);
    el.classList.toggle('loading', isLoading);
    el.classList.toggle('added', isAdded);
    __syncSubtitleToolbar();
}

function __refreshSubtitleRowsForIndexes() {
    const seen = new Set();
    for (let i = 0; i < arguments.length; i++) {
        const idx = Number(arguments[i]);
        if (!Number.isFinite(idx) || idx < 0 || idx >= __subtitleData.length || seen.has(idx)) continue;
        seen.add(idx);
        __applySubtitleRowState(idx);
    }
}

function __refreshVisibleSubtitleRows() {
    for (let i = __subtitleVirtualStart; i < __subtitleVirtualEnd; i++) {
        __applySubtitleRowState(i);
    }
}

function __rerenderSubtitleRow(idx) {
    const oldEl = __subtitleItemEls[idx];
    if (!oldEl || !oldEl.parentNode) return false;
    const nextEl = __createSubtitleItemEl(idx);
    oldEl.replaceWith(nextEl);
    __subtitleItemEls[idx] = nextEl;
    return true;
}

function __scrollSubtitleIndexIntoView(idx, behavior) {
    if (!subtitleListContainer || idx < 0 || idx >= __subtitleData.length) return;
    __setSubtitlePage(Math.floor(idx / __subtitlePageSize));
}

function __buildSubtitleItemEls() {
    __resetSubtitleVirtualList();
    __renderSubtitleList();
}

function __renderSubtitleList() {
    if (!subtitleListContainer || !__subtitleData.length) return;
    __ensureSubtitleVirtualScrollBound();
    __ensureSubtitleAddedCache();

    const total = __subtitleData.length;
    if (__subtitleSelectedIndex >= total) __subtitleSelectedIndex = -1;
    const range = __getSubtitleVisibleRange();
    const start = range.start;
    const end = range.end;
    if (__subtitleListInited && start === __subtitleVirtualStart && end === __subtitleVirtualEnd) {
        __refreshVisibleSubtitleRows();
        __syncSubtitlePager();
        return;
    }

    __subtitleItemEls = [];
    __subtitleVirtualStart = start;
    __subtitleVirtualEnd = end;
    const fragment = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
        const el = __createSubtitleItemEl(i);
        fragment.appendChild(el);
        __subtitleItemEls[i] = el;
    }
    subtitleListContainer.replaceChildren(fragment);
    __subtitleListInited = true;
    __syncSubtitlePager();
}

// 点击页面其他区域取消选中字幕，编辑模式下自动放弃更改
document.addEventListener('click', function (e) {
    const prev = __subtitleSelectedIndex;
    if (prev < 0) return;
    if (e.target.closest('.subtitle-list-item, .subtitle-toolbar, .subtitle-pager, input, textarea, button, #subtitleSlicePanel')) return;
    if (__subtitleEditingIndex >= 0) {
        __cancelSubtitleEdit();
    }
    __subtitleSelectedIndex = -1;
    __subtitleEditingIndex = -1;
    __refreshSubtitleRowsForIndexes(prev);
    __syncSubtitleToolbar();
});

// 事件委托（单监听器，避免每项独立 addEventListener）
if (subtitleListContainer) {
    subtitleListContainer.addEventListener('click', function (e) {
        {
            const btn = e.target.closest('.sub-time-btn');
            if (btn) {
                const item = btn.closest('.subtitle-list-item');
                if (!item) return;
                const field = btn.dataset.field;
                const step = parseFloat(btn.dataset.step);
                if (!Number.isFinite(step)) return;
                const inp = item.querySelector('.sub-time-input[data-field="' + field + '"]');
                if (!inp) return;
                const otherField = field === 'start' ? 'end' : 'start';
                const otherInp = item.querySelector('.sub-time-input[data-field="' + otherField + '"]');
                const val = parseTimeSub(inp.value);
                const otherVal = otherInp ? parseTimeSub(otherInp.value) : NaN;
                if (!Number.isFinite(val)) return;
                let newVal = Math.round((val + step) * 100) / 100;
                if (newVal < 0) newVal = 0;
                if (field === 'start' && Number.isFinite(otherVal) && newVal >= otherVal) return;
                if (field === 'end' && Number.isFinite(otherVal) && newVal <= otherVal) return;
                inp.value = formatSubtitleTime(newVal);
                return;
            }
        }
        const item = e.target.closest('.subtitle-list-item');
        if (!item) return;
        const idx = parseInt(item.dataset.subtitleIndex, 10);
        if (!Number.isFinite(idx) || idx < 0 || idx >= __subtitleData.length) return;

        if (e.target.closest('input, textarea')) {
            return;
        }
        if (__subtitleEditingIndex >= 0 && __subtitleEditingIndex !== idx) {
            __cancelSubtitleEdit();
        }
        const isAlreadySelected = __subtitleSelectedIndex === idx;
        __selectSubtitleIndex(idx, isAlreadySelected);
    });
}

if (subtitlePrevPageBtn) {
    subtitlePrevPageBtn.addEventListener('click', function () {
        __setSubtitlePage(__subtitlePageIndex - 1);
    });
}

if (subtitleNextPageBtn) {
    subtitleNextPageBtn.addEventListener('click', function () {
        __setSubtitlePage(__subtitlePageIndex + 1);
    });
}

function __jumpToSubtitlePage(page) {
    const val = String(page).trim();
    if (!val) return;
    const p = parseInt(val, 10);
    if (!Number.isFinite(p) || p < 1) return;
    const pageCount = __getSubtitlePageCount();
    const target = Math.min(p, pageCount) - 1;
    if (target === __subtitlePageIndex) return;
    __subtitleLastPageIndex = __subtitlePageIndex;
    if (subtitlePageUndoBtn) subtitlePageUndoBtn.style.display = '';
    __setSubtitlePage(target);
}

function __undoSubtitlePageJump() {
    if (__subtitleLastPageIndex < 0) return;
    const prev = __subtitleLastPageIndex;
    __subtitleLastPageIndex = -1;
    if (subtitlePageUndoBtn) subtitlePageUndoBtn.style.display = 'none';
    __setSubtitlePage(prev);
}

if (subtitlePageJumpInput) {
    subtitlePageJumpInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            __jumpToSubtitlePage(subtitlePageJumpInput.value);
            subtitlePageJumpInput.value = '';
        }
    });
}
if (subtitlePageJumpBtn) {
    subtitlePageJumpBtn.addEventListener('click', function () {
        __jumpToSubtitlePage(subtitlePageJumpInput.value);
        subtitlePageJumpInput.value = '';
    });
}
if (subtitlePageUndoBtn) {
    subtitlePageUndoBtn.addEventListener('click', __undoSubtitlePageJump);
}

window.addEventListener('resize', function () {
    if (!subtitleSlicePanel || subtitleSlicePanel.style.display === 'none') return;
    if (__subtitleResizeRaf) return;
    __subtitleResizeRaf = requestAnimationFrame(function () {
        __subtitleResizeRaf = null;
        if (__updateSubtitlePageSize()) __renderSubtitleList();
        else __syncSubtitlePager();
    });
}, { passive: true });

if (subtitleToolbarPlayBtn) {
    subtitleToolbarPlayBtn.addEventListener('click', function () {
        const idx = __getSelectedSubtitleIndex();
        if (idx < 0) { showToast('请先选择一条字幕'); return; }
        if (__subtitleEditingIndex === idx) {
            __playSubtitleVideoSegmentWithEdit(idx);
        } else {
            __playSubtitleVideoSegment(idx);
        }
    });
}

if (subtitleToolbarEditBtn) {
    subtitleToolbarEditBtn.addEventListener('click', function () {
        const idx = __getSelectedSubtitleIndex();
        if (idx < 0) { showToast('请先选择一条字幕'); return; }
        __enterSubtitleEditMode(idx);
    });
}

if (subtitleToolbarAddBtn) {
    subtitleToolbarAddBtn.addEventListener('click', function () {
        const idx = __getSelectedSubtitleIndex();
        if (idx < 0) { showToast('请先选择一条字幕'); return; }
        if (__isSubtitleAddedByIndex(idx)) {
            __removeOverlappingClips(idx);
        } else {
            __addSubtitleAsClip(idx);
        }
    });
}

if (subtitleToolbarSaveBtn) {
    subtitleToolbarSaveBtn.addEventListener('click', function () {
        const idx = __getSelectedSubtitleIndex();
        if (idx < 0 || __subtitleEditingIndex !== idx) { showToast('当前没有正在编辑的字幕'); return; }
        __saveSubtitleEdit(idx);
    });
}

if (subtitleToolbarCancelBtn) {
    subtitleToolbarCancelBtn.addEventListener('click', function () {
        if (__subtitleEditingIndex < 0) { showToast('当前没有正在编辑的字幕'); return; }
        __cancelSubtitleEdit();
    });
}

if (subtitleToolbarDeleteBtn) {
    subtitleToolbarDeleteBtn.addEventListener('click', function () {
        const idx = __getSelectedSubtitleIndex();
        if (idx < 0 || __subtitleEditingIndex !== idx) { showToast('请先进入字幕编辑'); return; }
        __deleteSubtitleEntry(idx);
    });
}

function __isSubtitleOverlappingExisting(startSec, endSec) {
    if (!currentVideoName) return false;
    for (const t of (videoTasks || [])) {
        if (String(t?.name || '') !== currentVideoName) continue;
        const clips = Array.isArray(t?.clips) ? t.clips : [];
        for (const c of clips) {
            const cs = Number(c.start), ce = Number(c.end);
            if (startSec < ce && endSec > cs) {
                // 边界相等不算重叠（相邻片段）
                if (c._subEnd !== undefined && startSec === c._subEnd) continue;
                if (c._subStart !== undefined && endSec === c._subStart) continue;
                return true;
            }
        }
    }
    return false;
}

const SUBTITLE_ADJACENT_EPS = 0.001;

function __isSubtitleClipAdjacentToRange(rangeSubStart, rangeSubEnd, rangeStart, rangeEnd, clip) {
    if (!clip) return false;
    const clipSubStart = Number(clip._subStart);
    const clipSubEnd = Number(clip._subEnd);
    if (!Number.isFinite(clipSubStart) || !Number.isFinite(clipSubEnd)) return false;

    const clipStart = Number(clip.start);
    const clipEnd = Number(clip.end);
    const rawAdjacent = Math.abs(rangeSubStart - clipSubEnd) <= SUBTITLE_ADJACENT_EPS
        || Math.abs(rangeSubEnd - clipSubStart) <= SUBTITLE_ADJACENT_EPS;
    const roundedAdjacent = Number.isFinite(clipStart) && Number.isFinite(clipEnd) && (
        Math.abs(rangeStart - clipEnd) <= SUBTITLE_ADJACENT_EPS
        || Math.abs(rangeEnd - clipStart) <= SUBTITLE_ADJACENT_EPS
    );
    return rawAdjacent || roundedAdjacent;
}

function __subtitleClipOverlapsRange(rangeStart, rangeEnd, clip) {
    const clipStart = Number(clip && clip.start);
    const clipEnd = Number(clip && clip.end);
    if (!Number.isFinite(clipStart) || !Number.isFinite(clipEnd)) return false;
    return rangeStart < clipEnd - SUBTITLE_ADJACENT_EPS && rangeEnd > clipStart + SUBTITLE_ADJACENT_EPS;
}

function __clearVideoSegmentEnd() {
    if (__videoSegmentRafId) {
        cancelAnimationFrame(__videoSegmentRafId);
        __videoSegmentRafId = null;
    }
    if (__videoSegmentTimeoutId) {
        clearTimeout(__videoSegmentTimeoutId);
        __videoSegmentTimeoutId = null;
    }
    __videoSegmentPlaybackStarted = false;
    __videoSegmentFailHandler = null;
}

function __failActiveVideoSegmentPlayback() {
    if (!__videoSegmentPlaybackStarted || typeof __videoSegmentFailHandler !== 'function') return false;
    const fail = __videoSegmentFailHandler;
    fail();
    return true;
}
var __videoSegmentRafId = null;
var __videoSegmentTimeoutId = null;
var __videoSegmentPlaybackStarted = false;
var __videoSegmentFailHandler = null;
var __inlinePlayToken = 0;

function __stopInlineClipPlayback() {
    __inlinePlayToken++;
    __clearVideoSegmentEnd();
    if (__framePlayerActive && __framePlayer) {
        __framePlayer.pause();
    }
    if (__audioPlayingIndex >= 0) {
        __audioPlayingIndex = -1;
        __audioSegmentEnd = 0;
    }
}

async function __switchToVideo(videoName) {
    if (!videoName || videoName === currentVideoName) return true;
    try {
        const ok = await showConfirmModal(
            `此片段来自「${videoName}」，当前预览中未加载该视频。\n是否切换到该视频并播放此片段？`,
            { title: '切换视频', okText: '切换', cancelText: '取消' }
        );
        if (!ok) return false;
    } catch (e) {
        return false;
    }

    __destroyFramePlayer();
    currentVideoName = videoName;
    __mainPreviewActive = true;
    playerWrapper.style.display = 'flex';
    __setVideoContainerExpanded(true);
    __refreshPreviewInteractiveState();
    player.src = '/api/video/' + encodeURIComponent(videoName);
    __restoreProgressForVideo = videoName;
    __videoFpsCache = null;

    await new Promise((resolve) => {
        player.addEventListener('canplay', resolve, { once: true });
        setTimeout(resolve, 15000);
    }).catch(() => {});
    try { await __ensureVideoFps(); } catch (e) { }

    __loadSubtitle();
    return true;
}

let __allPlaybackClips = null;
let __allPlaybackIndex = -1;
let __allPlaybackRafId = null;
let __allPlaybackTimeoutId = null;
let __allPlaybackToken = 0;
let __allAudioPlaybackClips = null;
let __allAudioPlaybackIndex = -1;
let __allAudioPlaybackRafId = null;
let __allAudioPlaybackTimeoutId = null;
let __allAudioPlaybackToken = 0;
let __allPreviewLoading = false;
function __collectAllPreviewClips() {
    const clips = [];
    for (const task of (videoTasks || [])) {
        for (const c of (task.clips || [])) {
            const start = Number(c.start);
            const end = Number(c.end);
            if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
                clips.push({ start, end, name: task.name });
            }
        }
    }
    return clips;
}

function __isAllPreviewPlaybackActive() {
    return !!(__allPlaybackClips || __allAudioPlaybackClips);
}

function __syncAllPreviewButton() {
    const active = __isAllPreviewPlaybackActive();
    if (previewAllClipsBtn) {
        previewAllClipsBtn.textContent = __allPreviewLoading ? '加载中…' : (active ? '停止预览' : '预览全部');
        previewAllClipsBtn.title = __allPreviewLoading ? '正在加载预览片段，点击可停止' : (active ? '停止当前预览' : '预览全部片段');
        previewAllClipsBtn.classList.toggle('preview-active', active);
    }
}

function __stopAllVideoPreviewPlayback(pause = true) {
    __allPlaybackToken++;
    if (__allPlaybackRafId) {
        cancelAnimationFrame(__allPlaybackRafId);
        __allPlaybackRafId = null;
    }
    if (__allPlaybackTimeoutId) {
        clearTimeout(__allPlaybackTimeoutId);
        __allPlaybackTimeoutId = null;
    }
    __allPlaybackClips = null;
    __allPlaybackIndex = -1;
    __allPreviewLoading = false;
    if (pause && player) {
        try { player.pause(); } catch (e) { }
    }
    __syncAllPreviewButton();
}

function __stopAllAudioPreviewPlayback(pause = true) {
    __allAudioPlaybackToken++;
    __allAudioPlaybackClips = null;
    __allAudioPlaybackIndex = -1;
    __allPreviewLoading = false;
    try { __clearAudioBufferHint(); } catch (e) { }
    if (__allAudioPlaybackRafId) {
        cancelAnimationFrame(__allAudioPlaybackRafId);
        __allAudioPlaybackRafId = null;
    }
    if (__allAudioPlaybackTimeoutId) {
        clearTimeout(__allAudioPlaybackTimeoutId);
        __allAudioPlaybackTimeoutId = null;
    }
    if (pause && audioPlayer) {
        try { audioPlayer.pause(); } catch (e) { }
    }
    if (audioPlayer) {
        try { audioPlayer.onended = null; } catch (e) { }
    }
    __syncAllPreviewButton();
}

window.__tlStopAllPreview = function (showMessage = false) {
    __stopAllVideoPreviewPlayback(true);
    __stopAllAudioPreviewPlayback(true);
    __syncAllPreviewButton();
    if (showMessage) showToast('已停止预览');
};

async function __playAllAudioClipAt(index, token) {
    if (token !== __allAudioPlaybackToken || !__allAudioPlaybackClips) return;
    const clip = __allAudioPlaybackClips[index];
    if (!clip) {
        __stopAllAudioPreviewPlayback(true);
        return;
    }

    if (!(await __ensureAudioSourceForVideo(clip.name))) {
        __stopAllAudioPreviewPlayback(true);
        return;
    }
    if (token !== __allAudioPlaybackToken || !audioPlayer) return;

    __allAudioPlaybackIndex = index;
    __audioPlayingIndex = -1;
    __audioLoadingIndex = -1;
    __audioSegmentEnd = Number(clip.end) || 0;
    __audioPlaybackToken++;
    if (__allAudioPlaybackRafId) {
        cancelAnimationFrame(__allAudioPlaybackRafId);
        __allAudioPlaybackRafId = null;
    }

    const playCurrent = async () => {
        if (token !== __allAudioPlaybackToken || !__allAudioPlaybackClips) return;
        try { audioPlayer.currentTime = Math.max(0, Number(clip.start) || 0); } catch (e) { }
        const startTime = Math.max(0, Number(clip.start) || 0);
        const endTime = Math.max(Number(clip.start) || 0, Number(clip.end) || 0);
        __allPreviewLoading = true;
        __syncAllPreviewButton();
        showToast('正在加载预览片段…', 'info', 1200);
        const buffered = await __waitMediaRangeBuffered(audioPlayer, startTime, endTime, function () {
            return token === __allAudioPlaybackToken && !!__allAudioPlaybackClips;
        });
        if (token === __allAudioPlaybackToken) {
            __allPreviewLoading = false;
            __syncAllPreviewButton();
        }
        if (!buffered || token !== __allAudioPlaybackToken || !__allAudioPlaybackClips) {
            if (token === __allAudioPlaybackToken) showToast('片段加载失败，请稍后重试', 'error');
            __stopAllAudioPreviewPlayback(false);
            return;
        }
        let advanced = false;
        const advance = () => {
            if (advanced) return;
            advanced = true;
            if (__allAudioPlaybackRafId) { cancelAnimationFrame(__allAudioPlaybackRafId); __allAudioPlaybackRafId = null; }
            if (__allAudioPlaybackTimeoutId) { clearTimeout(__allAudioPlaybackTimeoutId); __allAudioPlaybackTimeoutId = null; }
            try { audioPlayer.pause(); } catch (e) { }
            __playAllAudioClipAt(index + 1, token);
        };
        audioPlayer.onended = function () {
            if (token !== __allAudioPlaybackToken) return;
            advance();
        };
        audioPlayer.play().then(function () {
            if (token !== __allAudioPlaybackToken || !__allAudioPlaybackClips) return;
            const duration = Math.max(0, endTime - (Number(audioPlayer.currentTime) || startTime));
            __allAudioPlaybackTimeoutId = setTimeout(advance, duration * 1000);
            (function rafLoop() {
                if (token !== __allAudioPlaybackToken || !__allAudioPlaybackClips) return;
                if ((audioPlayer.currentTime || 0) >= endTime) {
                    advance();
                    return;
                }
                __allAudioPlaybackRafId = requestAnimationFrame(rafLoop);
            })();
        }).catch(function () {
            if (token === __allAudioPlaybackToken) __stopAllAudioPreviewPlayback(false);
        });
    };

    if (audioPlayer.readyState >= 1 && Number.isFinite(audioPlayer.duration)) {
        playCurrent();
    } else {
        const onLoaded = () => {
            audioPlayer.removeEventListener('loadedmetadata', onLoaded);
            if (token !== __allAudioPlaybackToken) return;
            playCurrent();
        };
        audioPlayer.addEventListener('loadedmetadata', onLoaded);
        try { audioPlayer.load(); } catch (e) { }
    }
}

function __startAllAudioPreviewPlayback(clips) {
    if (!audioPlayer) {
        showToast('音频播放器不可用', 'error');
        return;
    }
    if (__allPlaybackRafId) {
        cancelAnimationFrame(__allPlaybackRafId);
        __allPlaybackRafId = null;
    }
    __allPlaybackClips = null;
    __allPlaybackIndex = -1;
    __stopAudioPlayback();
    __stopInlineClipPlayback();
    try { if (player && !player.paused) player.pause(); } catch (e) { }
    __allAudioPlaybackClips = clips;
    __allAudioPlaybackIndex = -1;
    const token = ++__allAudioPlaybackToken;
    __syncAllPreviewButton();
    showToast('使用音频预览全部片段');
    __playAllAudioClipAt(0, token);
}

window.__tlPlayAllClips = function () {
    if (__isAllPreviewPlaybackActive()) {
        window.__tlStopAllPreview(true);
        return;
    }

    const clips = __collectAllPreviewClips();
    if (clips.length === 0) { showToast('没有片段可以播放'); return; }
    if (__isSubtitleAudioOnlyMode() || !__isVideoPreviewActive()) {
        __startAllAudioPreviewPlayback(clips);
        return;
    }
    __stopAllAudioPreviewPlayback(true);
    if (__allPlaybackRafId) cancelAnimationFrame(__allPlaybackRafId);
    if (__allPlaybackTimeoutId) clearTimeout(__allPlaybackTimeoutId);
    __allPlaybackClips = clips;
    __allPlaybackIndex = 0;
    __syncAllPreviewButton();
    const token = ++__allPlaybackToken;
    __playAllVideoClipAt(0, token);
};

async function __playAllVideoClipAt(index, token) {
    if (token !== __allPlaybackToken || !__allPlaybackClips) return;
    const clip = __allPlaybackClips[index];
    if (!clip) {
        __stopAllVideoPreviewPlayback(true);
        return;
    }

    if (clip.name !== currentVideoName) {
        const switched = await __switchToVideo(clip.name);
        if (!switched || token !== __allPlaybackToken || !__allPlaybackClips) {
            __stopAllVideoPreviewPlayback(true);
            return;
        }
    }

    __allPlaybackIndex = index;
    const startTime = Math.max(0, Number(clip.start) || 0);
    const endTime = Math.max(startTime, Number(clip.end) || startTime);
    let advanced = false;
    const advance = () => {
        if (advanced) return;
        advanced = true;
        if (__allPlaybackRafId) { cancelAnimationFrame(__allPlaybackRafId); __allPlaybackRafId = null; }
        if (__allPlaybackTimeoutId) { clearTimeout(__allPlaybackTimeoutId); __allPlaybackTimeoutId = null; }
        try { player.pause(); } catch (e) { }
        __playAllVideoClipAt(index + 1, token);
    };

    __seekPrecise(startTime);
    __allPreviewLoading = true;
    __syncAllPreviewButton();
    showToast('正在加载预览片段…', 'info', 1200);
    const bufEnd = Math.min(startTime + 1, endTime);
    const buffered = await __waitMediaRangeBuffered(player, startTime, bufEnd, function () {
        return token === __allPlaybackToken && !!__allPlaybackClips;
    }, 15000);
    if (token === __allPlaybackToken) {
        __allPreviewLoading = false;
        __syncAllPreviewButton();
    }
    if (!buffered || token !== __allPlaybackToken || !__allPlaybackClips) {
        if (token === __allPlaybackToken) showToast('片段加载失败，请稍后重试', 'error');
        __stopAllVideoPreviewPlayback(false);
        return;
    }
    player.play().then(() => {
        if (token !== __allPlaybackToken || !__allPlaybackClips) return;
        const duration = Math.max(0, endTime - (Number(player.currentTime) || startTime));
        __allPlaybackTimeoutId = setTimeout(advance, duration * 1000);
        (function rafLoop() {
            if (token !== __allPlaybackToken || !__allPlaybackClips) return;
            if ((Number(player.currentTime) || 0) >= endTime) {
                advance();
                return;
            }
            __allPlaybackRafId = requestAnimationFrame(rafLoop);
        })();
    }).catch(() => { if (token === __allPlaybackToken) __stopAllVideoPreviewPlayback(false); });
}

async function __playClipRange(start, end, videoName) {
    if (videoName && videoName !== currentVideoName) {
        const switched = await __switchToVideo(videoName);
        if (!switched) return;
    }
    if (!__isVideoPreviewActive()) {
        showToast('请先加载视频预览');
        return;
    }
    __stopInlineClipPlayback();
    if (__framePlayerActive && __framePlayer && __framePlayer.ready) {
        const fps = __framePlayer.fps;
        const startFrame = Math.round(start * fps);
        const endFrame = Math.round(end * fps);
        __framePlayer.play(startFrame, Math.max(startFrame, endFrame - 1));
        return;
    }
    const token = ++__inlinePlayToken;
    const fps = __getVideoFpsSync() || 30;
    __seekPrecise(start);
    var stopInlineVideoSegment = function () {
        if (token !== __inlinePlayToken) return;
        __clearVideoSegmentEnd();
        player.pause();
    };
    __videoSegmentPlaybackStarted = false;
    __videoSegmentFailHandler = function () {
        stopInlineVideoSegment();
        showToast('视频片段播放卡顿，播放失败，请重试', 'error');
    };
    player.play().then(function () {
        if (token === __inlinePlayToken) __videoSegmentPlaybackStarted = true;
    }).catch(() => {});
    (function raf() {
        if (token !== __inlinePlayToken) return;
        if (player.currentTime >= end - 1 / fps) {
            stopInlineVideoSegment();
            return;
        }
        __videoSegmentRafId = requestAnimationFrame(raf);
    })();
}

function __isVideoPreviewActive() {
    return !!(player && player.duration && player.readyState >= 2 && __mainPreviewActive);
}

async function __ensureAudioSourceForVideo(videoName) {
    const name = String(videoName || '').trim();
    if (!name || !audioPlayer) return false;
    const audioUrl = '/api/audio/' + encodeURIComponent(name);
    const curSrc = audioPlayer.getAttribute('src') || '';
    if (__audioSrcVideoName === name && __audioSrc === audioUrl && curSrc === audioUrl) return true;

    try {
        const resp = await fetch('/api/audio_available/' + encodeURIComponent(name));
        const data = await resp.json();
        if (!data || !data.available) {
            showToast('未找到音频文件', 'error');
            return false;
        }
        __audioSrc = audioUrl;
        __audioSrcVideoName = name;
        audioPlayer.src = audioUrl;
        try { audioPlayer.load(); } catch (e) { }
        return true;
    } catch (e) {
        showToast('获取音频失败', 'error');
        return false;
    }
}

async function __playSubtitleVideoSegmentWithEdit(idx) {
    if (idx < 0 || idx >= __subtitleData.length) return;
    if (!currentVideoName) return;
    let item = __subtitleItemEls[idx];
    if (!item) {
        __scrollSubtitleIndexIntoView(idx, 'auto');
        __renderSubtitleList();
        item = __subtitleItemEls[idx];
    }
    if (!item) return;
    const startInput = item.querySelector('.sub-time-input[data-field="start"]');
    const endInput = item.querySelector('.sub-time-input[data-field="end"]');
    if (!startInput || !endInput) return;
    const start = parseTimeSub(startInput.value);
    const end = parseTimeSub(endInput.value);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return;
    await __playSubtitleSegment(idx, start, end);
}

async function __playSubtitleVideoSegment(idx) {
    if (idx < 0 || idx >= __subtitleData.length) return;
    const sub = __subtitleData[idx];
    if (!currentVideoName) return;
    const start = roundToSubtitleTime(sub.start);
    const end = roundToSubtitleTime(sub.end);
    if (start >= end) return;
    await __playSubtitleSegment(idx, start, end);
}

async function __playSubtitleSegment(idx, start, end) {
    if (idx >= 0) __saveSubtitleIndexProgress(idx);

    if (__isVideoPreviewActive()) {
        if (__framePlayerActive && __framePlayer && __framePlayer.ready) {
            if (__audioPlayingIndex === idx && __framePlayer.playing) {
                const prevPlaying = __audioPlayingIndex;
                const prevLoading = __audioLoadingIndex;
                __framePlayer.pause();
                __audioPlayingIndex = -1;
                __audioSegmentEnd = 0;
                __refreshSubtitleRowsForIndexes(prevPlaying, prevLoading);
                return;
            }
            const prevPlaying = __audioPlayingIndex;
            const prevLoading = __audioLoadingIndex;
            if (__audioPlayingIndex >= 0) {
                __framePlayer.pause();
                __audioPlayingIndex = -1;
                __audioSegmentEnd = 0;
            }
            __audioPlayingIndex = idx;
            __audioSegmentEnd = end;
            __clearVideoSegmentEnd();
            const fps = __framePlayer.fps;
            const startFrame = Math.round(start * fps);
            const endFrame = Math.round(end * fps);
            __framePlayer.play(startFrame, endFrame);
            __refreshSubtitleRowsForIndexes(prevPlaying, prevLoading, idx);
            return;
        }

        // 视频预览模式：控制 video player
        if (__audioPlayingIndex === idx && player && !player.paused) {
            const prevPlaying = __audioPlayingIndex;
            const prevLoading = __audioLoadingIndex;
            player.pause();
            __audioPlayingIndex = -1;
            __audioSegmentEnd = 0;
            __refreshSubtitleRowsForIndexes(prevPlaying, prevLoading);
            return;
        }
        const prevPlaying = __audioPlayingIndex;
        const prevLoading = __audioLoadingIndex;
        if (__audioPlayingIndex >= 0) {
            player.pause();
            __audioPlayingIndex = -1;
            __audioSegmentEnd = 0;
        }
        __audioPlayingIndex = idx;
        __audioSegmentEnd = end;
        __clearVideoSegmentEnd();
        __seekPrecise(start);
        var segToken = ++__audioPlaybackToken;
        var segEnd = end;
        var segIdx = idx;
        var stopVideoSegment = function () {
            if (segToken !== __audioPlaybackToken || __audioPlayingIndex !== segIdx) return;
            __clearVideoSegmentEnd();
            player.pause();
            if (__audioPlayingIndex === segIdx) {
                __audioPlayingIndex = -1;
                __audioSegmentEnd = 0;
            }
            __refreshSubtitleRowsForIndexes(segIdx);
        };
        __videoSegmentPlaybackStarted = false;
        __videoSegmentFailHandler = function () {
            stopVideoSegment();
            showToast('视频片段播放卡顿，播放失败，请重试', 'error');
        };
        const bufferEnd = Math.min(start + 1, segEnd);
        const buffered = await __waitMediaRangeBuffered(player, start, bufferEnd, function () {
            return segToken === __audioPlaybackToken && __audioPlayingIndex === segIdx;
        }, 15000);
        if (!buffered || segToken !== __audioPlaybackToken || __audioPlayingIndex !== segIdx) {
            if (segToken === __audioPlaybackToken) showToast('字幕片段加载失败，请稍后重试', 'error');
            if (segToken === __audioPlaybackToken || __audioPlayingIndex === segIdx) {
                player.pause();
                __audioPlayingIndex = -1;
                __audioSegmentEnd = 0;
            }
            __refreshSubtitleRowsForIndexes(segIdx);
            return;
        }
        player.play().then(function () {
            if (segToken !== __audioPlaybackToken || __audioPlayingIndex !== segIdx) return;
            __videoSegmentPlaybackStarted = true;
            var duration = Math.max(0, segEnd - (Number(player.currentTime) || start));
            __videoSegmentTimeoutId = setTimeout(stopVideoSegment, duration * 1000);
            (function rafLoop() {
                if (segToken !== __audioPlaybackToken || __audioPlayingIndex !== segIdx) return;
                if ((Number(player.currentTime) || 0) >= segEnd) {
                    stopVideoSegment();
                    return;
                }
                __videoSegmentRafId = requestAnimationFrame(rafLoop);
            })();
        }).catch(function () {
            if (segToken === __audioPlaybackToken && __audioPlayingIndex === segIdx) {
                player.pause();
                __audioPlayingIndex = -1;
                __audioSegmentEnd = 0;
                __refreshSubtitleRowsForIndexes(segIdx);
            }
        });
        __refreshSubtitleRowsForIndexes(prevPlaying, prevLoading, idx);
        return;
    }

    // 无预览 → 播放音频
    if (__audioPlayingIndex === idx && audioPlayer && !audioPlayer.paused) {
        __stopAudioPlayback();
        return;
    }
    __stopAudioPlayback();
    if (!currentVideoName) return;
    if (!(await __ensureAudioSourceForVideo(currentVideoName))) return;
    if (!audioPlayer) return;

    const prevPlaying = __audioPlayingIndex;
    const prevLoading = __audioLoadingIndex;
    __subtitleAudioPlaybackStarted = false;
    __audioPlayingIndex = idx;
    __audioLoadingIndex = idx;
    __audioSegmentEnd = end;
    const token = ++__audioPlaybackToken;

    const loadingTimeout = setTimeout(function () {
        if (token === __audioPlaybackToken && __audioPlayingIndex === idx && __audioLoadingIndex === idx) {
            __stopAudioPlayback();
            showToast('字幕片段加载超时，请重试', 'error');
        }
    }, 10000);

    // 同一文件不重新加载，避免慢网络下反复重下
    const curSrc = audioPlayer.getAttribute('src') || '';
    if (curSrc !== __audioSrc) audioPlayer.src = __audioSrc;

    const startPlayback = async () => {
        if (token !== __audioPlaybackToken) return;
        try { audioPlayer.currentTime = start; } catch (e) { }
        const audioBufferEnd = Math.min(start + 1, end);
        const buffered = await __waitMediaRangeBuffered(audioPlayer, start, audioBufferEnd, function () {
            return token === __audioPlaybackToken && __audioPlayingIndex === idx;
        }, 15000);
        if (!buffered || token !== __audioPlaybackToken || __audioPlayingIndex !== idx) {
            clearTimeout(loadingTimeout);
            if (token === __audioPlaybackToken) showToast('字幕片段加载失败，请稍后重试', 'error');
            if (token === __audioPlaybackToken || __audioPlayingIndex === idx) {
                __stopAudioPlayback();
            }
            return;
        }

        const onPlaying = () => {
            if (token !== __audioPlaybackToken) return;
            clearTimeout(loadingTimeout);
            audioPlayer.removeEventListener('playing', onPlaying);
            __audioPendingPlaying = null;
            __subtitleAudioPlaybackStarted = true;
            __audioLoadingIndex = -1;
            __refreshSubtitleRowsForIndexes(idx);

            audioPlayer.onpause = function () {
                if (token === __audioPlaybackToken) __onAudioSegmentEnd();
            };
            audioPlayer.onended = function () {
                if (token === __audioPlaybackToken) __onAudioSegmentEnd();
            };

            var aToken = token;
            var aEnd = end;
            var aIdx = idx;
            var stopAudioSegment = function () {
                if (aToken !== __audioPlaybackToken || __audioPlayingIndex !== aIdx) return;
                __onAudioSegmentEnd();
            };
            var duration = Math.max(0, aEnd - (Number(audioPlayer.currentTime) || start));
            __audioSegmentTimeoutId = setTimeout(stopAudioSegment, duration * 1000);
            (function rafLoop() {
                if (aToken !== __audioPlaybackToken || __audioPlayingIndex !== aIdx) return;
                if ((Number(audioPlayer.currentTime) || 0) >= aEnd) {
                    stopAudioSegment();
                    return;
                }
                __audioRafId = requestAnimationFrame(rafLoop);
            })();
        };
        if (__audioPendingPlaying) {
            audioPlayer.removeEventListener('playing', __audioPendingPlaying);
        }
        __audioPendingPlaying = onPlaying;
        audioPlayer.addEventListener('playing', onPlaying);

        audioPlayer.play().catch(function () {
            if (token === __audioPlaybackToken) __stopAudioPlayback();
        });
    };

    if (audioPlayer.readyState >= 1 && Number.isFinite(audioPlayer.duration)) {
        startPlayback().catch(function () {
            if (token === __audioPlaybackToken) __stopAudioPlayback();
        });
    } else {
        const onLoaded = () => {
            audioPlayer.removeEventListener('loadedmetadata', onLoaded);
            __audioPendingLoadedmeta = null;
            if (token !== __audioPlaybackToken) return;
            startPlayback().catch(function () {
                if (token === __audioPlaybackToken) __stopAudioPlayback();
            });
        };
        if (__audioPendingLoadedmeta) {
            audioPlayer.removeEventListener('loadedmetadata', __audioPendingLoadedmeta);
        }
        __audioPendingLoadedmeta = onLoaded;
        audioPlayer.addEventListener('loadedmetadata', onLoaded);
        try { audioPlayer.load(); } catch (e) { }
    }
    __refreshSubtitleRowsForIndexes(prevPlaying, prevLoading, idx);
}

function __onAudioSegmentEnd() {
    const wasPlaying = __audioPlayingIndex >= 0;
    const prevPlaying = __audioPlayingIndex;
    const prevLoading = __audioLoadingIndex;
    __audioPlayingIndex = -1;
    __audioLoadingIndex = -1;
    __subtitleAudioPlaybackStarted = false;
    __audioSegmentEnd = 0;
    __audioPlaybackToken++;
    try { __clearAudioBufferHint(); } catch (e) { }
    if (__audioRafId) { cancelAnimationFrame(__audioRafId); __audioRafId = null; }
    if (__audioSegmentTimeoutId) { clearTimeout(__audioSegmentTimeoutId); __audioSegmentTimeoutId = null; }
    if (__audioPendingLoadedmeta && audioPlayer) {
        audioPlayer.removeEventListener('loadedmetadata', __audioPendingLoadedmeta);
        __audioPendingLoadedmeta = null;
    }
    if (__audioPendingPlaying && audioPlayer) {
        audioPlayer.removeEventListener('playing', __audioPendingPlaying);
        __audioPendingPlaying = null;
    }
    if (audioPlayer) {
        audioPlayer.onpause = null;
        audioPlayer.onended = null;
        audioPlayer.pause();
    }
    if (wasPlaying) __refreshSubtitleRowsForIndexes(prevPlaying, prevLoading);
}

function __stopAudioPlayback() {
    try { __stopAllAudioPreviewPlayback(false); } catch (e) { }
    const prevPlaying = __audioPlayingIndex;
    const prevLoading = __audioLoadingIndex;
    __audioPlayingIndex = -1;
    __audioLoadingIndex = -1;
    __subtitleAudioPlaybackStarted = false;
    __audioSegmentEnd = 0;
    __audioPlaybackToken++;
    try { __clearAudioBufferHint(); } catch (e) { }
    if (__audioRafId) { cancelAnimationFrame(__audioRafId); __audioRafId = null; }
    if (__audioSegmentTimeoutId) { clearTimeout(__audioSegmentTimeoutId); __audioSegmentTimeoutId = null; }
    if (__audioPendingLoadedmeta && audioPlayer) {
        audioPlayer.removeEventListener('loadedmetadata', __audioPendingLoadedmeta);
        __audioPendingLoadedmeta = null;
    }
    if (__audioPendingPlaying && audioPlayer) {
        audioPlayer.removeEventListener('playing', __audioPendingPlaying);
        __audioPendingPlaying = null;
    }
    if (audioPlayer) {
        audioPlayer.onpause = null;
        audioPlayer.onended = null;
        audioPlayer.pause();
    }
    __refreshSubtitleRowsForIndexes(prevPlaying, prevLoading);
}

async function __addSubtitleAsClip(idx) {
    if (idx < 0 || idx >= __subtitleData.length) return;
    if (typeof __isClipEditLocked === 'function' && __isClipEditLocked()) {
        showToast('合并任务进行中，无法添加片段', 'error');
        return;
    }
    const sub = __subtitleData[idx];
    if (!currentVideoName) {
        showToast('请先选择视频', 'error');
        return;
    }

    var task = null;
    for (var i = 0; i < videoTasks.length; i++) {
        if (videoTasks[i].name === currentVideoName) {
            task = videoTasks[i];
            break;
        }
    }
    if (!task) {
        task = { name: currentVideoName, clips: [] };
        videoTasks.push(task);
    }

    var roundedStart = roundToSubtitleTime(sub.start);
    var roundedEnd = roundToSubtitleTime(sub.end);
    var mergeClipIndexes = [];
    var mergedStart = roundedStart;
    var mergedEnd = roundedEnd;
    var mergedSubStart = sub.start;
    var mergedSubEnd = sub.end;
    var changedMerge = true;
    while (changedMerge) {
        changedMerge = false;
        for (var j = 0; j < task.clips.length; j++) {
            if (mergeClipIndexes.indexOf(j) !== -1) continue;
            var c = task.clips[j];
            if (__isSubtitleClipAdjacentToRange(mergedSubStart, mergedSubEnd, mergedStart, mergedEnd, c)) {
                mergeClipIndexes.push(j);
                mergedStart = Math.min(mergedStart, Number(c.start));
                mergedEnd = Math.max(mergedEnd, Number(c.end));
                mergedSubStart = Math.min(mergedSubStart, Number(c._subStart));
                mergedSubEnd = Math.max(mergedSubEnd, Number(c._subEnd));
                changedMerge = true;
            }
        }
    }

    var isOverlap = false;
    for (var overlapIdx = 0; overlapIdx < task.clips.length; overlapIdx++) {
        if (mergeClipIndexes.indexOf(overlapIdx) !== -1) continue;
        if (__subtitleClipOverlapsRange(mergedStart, mergedEnd, task.clips[overlapIdx])) {
            isOverlap = true;
            break;
        }
    }
    if (isOverlap) {
        showToast('片段重叠，无法添加', 'error');
        return;
    }

    var nextClip = { start: mergedStart, end: mergedEnd, _subStart: mergedSubStart, _subEnd: mergedSubEnd };
    if (mergeClipIndexes.length > 0) {
        var insertAt = Math.min.apply(null, mergeClipIndexes);
        mergeClipIndexes.sort(function (a, b) { return b - a; });
        for (var k = 0; k < mergeClipIndexes.length; k++) {
            task.clips.splice(mergeClipIndexes[k], 1);
        }
        task.clips.splice(insertAt, 0, nextClip);
    } else {
        task.clips.push(nextClip);
    }

    if (typeof __withStablePageScroll === 'function') {
        __withStablePageScroll(function () {
            if (typeof window.__tlSuppressAutoFollow === 'function') window.__tlSuppressAutoFollow(300);
            if (typeof window.__tlSuppressObserverFlush === 'function') window.__tlSuppressObserverFlush();
            renderNewClipList();
            if (typeof window.__tlRenderTimeline === 'function') window.__tlRenderTimeline();
        });
    } else {
        renderNewClipList();
    }
    __saveClipToolState();
    __subtitleAddedCacheKey = '';
    __syncSubtitleToolbar();
    showToast(mergeClipIndexes.length > 0 ? '已合并相邻字幕片段' : '已添加字幕片段');
}

async function __removeOverlappingClips(idx) {
    if (idx < 0 || idx >= __subtitleData.length) return;
    if (!currentVideoName) return;
    const sub = __subtitleData[idx];
    const start = sub.start, end = sub.end;

    // 先收集要删除的片段
    var toRemove = [];
    for (var i = 0; i < videoTasks.length; i++) {
        var task = videoTasks[i];
        if (String(task?.name || '') !== currentVideoName) continue;
        var clips = Array.isArray(task?.clips) ? task.clips : [];
        for (var j = 0; j < clips.length; j++) {
            var c = clips[j];
            var cs = Number(c.start), ce = Number(c.end);
            if (start < ce && end > cs) {
                // 边界相等不算重叠（相邻片段）
                if (c._subEnd !== undefined && start === c._subEnd) continue;
                if (c._subStart !== undefined && end === c._subStart) continue;
                toRemove.push({ taskIdx: i, clipIdx: j, clip: c });
            }
        }
    }

    if (toRemove.length === 0) {
        showToast('未找到重叠片段', 'error');
        return;
    }

    // 构建确认信息
    var msgLines = toRemove.map(function (r) {
        var cs = Number(r.clip.start), ce = Number(r.clip.end);
        var subs = __subtitleData.filter(function (s) {
            if (!(s.start < ce && s.end > cs)) return false;
            // 边界相等的字幕不显示
            if (r.clip._subEnd !== undefined && s.start === r.clip._subEnd) return false;
            if (r.clip._subStart !== undefined && s.end === r.clip._subStart) return false;
            return true;
        }).map(function (s) { return s.text; });
        var subText = subs.length ? '\n  -  「' + subs.join('」\n  -  「') + '」' : '';
        return formatTime(cs) + ' - ' + formatTime(ce) + subText;
    });
    var ok = await showConfirmModal(
        '将删除以下片段：\n' + msgLines.join('\n'),
        { title: '删除确认', okText: '删除', cancelText: '取消' }
    );
    if (!ok) return;

    // 执行删除（倒序避免索引偏移）
    toRemove.sort(function (a, b) { return b.clipIdx - a.clipIdx; });
    var taskIdx = toRemove[0].taskIdx;
    var task = videoTasks[taskIdx];
    for (var k = 0; k < toRemove.length; k++) {
        task.clips.splice(toRemove[k].clipIdx, 1);
    }
    if (task.clips.length === 0) {
        videoTasks.splice(taskIdx, 1);
    }
    renderNewClipList();
__saveClipToolState();
    __subtitleAddedCacheKey = '';
    __syncSubtitleToolbar();
    showToast('已删除重叠片段');
}

// ---------- 字幕编辑模式 ----------
function __enterSubtitleEditMode(idx) {
    if (idx < 0 || idx >= __subtitleData.length) return;
    const prevEditing = __subtitleEditingIndex;
    if (__subtitleEditingIndex >= 0) {
        __cancelSubtitleEdit();
    }
    __subtitleEditingIndex = idx;
    __subtitleEditOrigData = {
        start: __subtitleData[idx].start,
        end: __subtitleData[idx].end,
        text: __subtitleData[idx].text,
    };
    if (!__rerenderSubtitleRow(idx)) {
        __scrollSubtitleIndexIntoView(idx, 'auto');
        __renderSubtitleList();
    }
    __refreshSubtitleRowsForIndexes(prevEditing, idx);
    __syncSubtitleToolbar();
}

function __cancelSubtitleEdit() {
    if (__subtitleEditingIndex < 0) return;
    const prevEditing = __subtitleEditingIndex;
    __subtitleEditingIndex = -1;
    __subtitleEditOrigData = null;
    if (!__rerenderSubtitleRow(prevEditing)) {
        __renderSubtitleList();
    }
    __syncSubtitleToolbar();
}

async function __getSubtitleEditUsername(actionText) {
    const currentUsername = String(usernameInput?.value || '').trim();
    if (currentUsername) return currentUsername;

    const input = await showPromptModal('请输入用户名称，用于记录本次字幕变更：', {
        title: '用户名称',
        okText: '继续',
        cancelText: '取消',
        placeholder: '输入用户名称',
    });
    if (input === null) {
        showToast('已取消' + (actionText || '字幕修改'), 'info');
        return '';
    }
    const username = String(input || '').trim();
    if (username) {
        if (usernameInput) usernameInput.value = username;
        try { __saveClipToolState(); } catch (e) { }
        return username;
    }
    showToast('用户名称不能为空，已取消' + (actionText || '字幕修改'), 'warning');
    try { usernameInput?.focus(); } catch (e) { }
    return '';
}

async function __deleteSubtitleEntry(idx) {
    if (idx < 0 || idx >= __subtitleData.length) return;
    if (__subtitleEditingIndex !== idx) return;

    const username = await __getSubtitleEditUsername('删除字幕');
    if (!username) return;

    var ok = await showConfirmModal('确定要删除此字幕条目吗？', { title: '删除确认', okText: '删除', cancelText: '取消' });
    if (!ok) return;

    try {
        const resp = await fetch('/api/subtitle/' + encodeURIComponent(currentVideoName), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: username,
                edits: [{ index: idx, start: 0, end: 0, text: '', delete: true }],
            }),
        });
        if (!resp.ok) {
            const err = await resp.json().catch(function () { return { detail: '删除失败' }; });
            showToast(err.detail || '删除失败', 'error');
            return;
        }
        const data = await resp.json();
        if (data.subtitles) {
            __subtitleData = data.subtitles.map(function (s) {
                return { start: s.start, end: s.end, text: s.text };
            });
        }
        __subtitleEditingIndex = -1;
        __subtitleEditOrigData = null;
        if (__subtitleSelectedIndex >= __subtitleData.length) __subtitleSelectedIndex = Math.max(0, __subtitleData.length - 1);
        __subtitleAddedCacheKey = '';
        __resetSubtitleVirtualList();
        __renderSubtitleList();
        __syncSubtitleToolbar();
        showToast('字幕已删除', 'success');
    } catch (e) {
        showToast('删除失败: ' + (e.message || e), 'error');
    }
}

async function __saveSubtitleEdit(idx) {
    if (idx < 0 || idx >= __subtitleData.length) return;
    if (__subtitleEditingIndex !== idx) return;

    const oldSub = __subtitleData[idx];
    const oldRoundedStart = roundToSubtitleTime(oldSub.start);
    const oldRoundedEnd = roundToSubtitleTime(oldSub.end);

    const username = await __getSubtitleEditUsername('保存字幕');
    if (!username) return;

    let item = __subtitleItemEls[idx];
    if (!item) {
        __scrollSubtitleIndexIntoView(idx, 'auto');
        __renderSubtitleList();
        item = __subtitleItemEls[idx];
    }
    if (!item) return;

    const startInput = item.querySelector('.sub-time-input[data-field="start"]');
    const endInput = item.querySelector('.sub-time-input[data-field="end"]');
    const textarea = item.querySelector('.sub-textarea');
    if (!startInput || !endInput || !textarea) return;

    const newStart = parseTimeSub(startInput.value);
    const newEnd = parseTimeSub(endInput.value);
    const newText = textarea.value.trim();

    if (!Number.isFinite(newStart) || newStart < 0) {
        showToast('无效的开始时间', 'error');
        return;
    }
    if (!Number.isFinite(newEnd) || newEnd < 0) {
        showToast('无效的结束时间', 'error');
        return;
    }
    if (newStart >= newEnd) {
        showToast('开始时间不能晚于结束时间', 'error');
        return;
    }
    if (!newText) {
        showToast('字幕文字不能为空', 'error');
        return;
    }

    const newRoundedStart = roundToSubtitleTime(newStart);
    const newRoundedEnd = roundToSubtitleTime(newEnd);

    try {
        const resp = await fetch('/api/subtitle/' + encodeURIComponent(currentVideoName), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: username,
                edits: [{ index: idx, start: newRoundedStart, end: newRoundedEnd, text: newText }],
            }),
        });
        if (!resp.ok) {
            const err = await resp.json().catch(function () { return { detail: '保存失败' }; });
            showToast(err.detail || '保存失败', 'error');
            return;
        }
        const data = await resp.json();
        // Refresh subtitle data from response
        if (data.subtitles) {
            __subtitleData = data.subtitles.map(function (s) {
                return { start: s.start, end: s.end, text: s.text };
            });
        }
        __subtitleEditingIndex = -1;
        __subtitleEditOrigData = null;
        __subtitleAddedCacheKey = '';

        // Sync timeline clips that have the same original subtitle time range
        if (currentVideoName) {
            const matchedClips = [];
            for (const t of (videoTasks || [])) {
                if (String(t?.name || '') !== currentVideoName) continue;
                for (let ci = 0; ci < (t.clips || []).length; ci++) {
                    const c = t.clips[ci];
                    const cs = Number(c.start), ce = Number(c.end);
                    const cSubS = Number(c._subStart), cSubE = Number(c._subEnd);
                    if (Number.isFinite(cSubS) && Number.isFinite(cSubE)) {
                        if (cSubS === oldSub.start && cSubE === oldSub.end) {
                            matchedClips.push({ task: t, clip: c, ci });
                        }
                    } else if (cs === oldRoundedStart && ce === oldRoundedEnd) {
                        matchedClips.push({ task: t, clip: c, ci });
                    }
                }
            }
            if (matchedClips.length > 0) {
                for (const m of matchedClips) {
                    m.clip.start = newRoundedStart;
                    m.clip.end = newRoundedEnd;
                    m.clip._subStart = newRoundedStart;
                    m.clip._subEnd = newRoundedEnd;
                }
                if (typeof window.__tlSuppressAutoFollow === 'function') window.__tlSuppressAutoFollow(300);
                if (typeof window.__tlSuppressObserverFlush === 'function') window.__tlSuppressObserverFlush();
                renderNewClipList();
                if (typeof window.__tlRenderTimeline === 'function') window.__tlRenderTimeline();
                __saveClipToolState();
            }
            if (!__rerenderSubtitleRow(idx)) {
                __renderSubtitleList();
            }
            __syncSubtitleToolbar();
            if (matchedClips.length > 0) {
                showToast('字幕已保存，已同步 ' + matchedClips.length + ' 个片段', 'success');
            } else {
                showToast('字幕已保存', 'success');
            }
        } else {
            if (!__rerenderSubtitleRow(idx)) {
                __renderSubtitleList();
            }
            __syncSubtitleToolbar();
            showToast('字幕已保存', 'success');
        }
    } catch (e) {
        showToast('保存失败: ' + (e.message || e), 'error');
    }
}

// ---------- 字幕列表高亮更新（视频播放时） ----------
var __subtitleLastListHighlight = -1;
var __subtitleScrollDebounce = null;
if (player) {
    player.addEventListener('timeupdate', function () {
        if (!__subtitleEnabled || !__subtitleData.length) return;
        if (!subtitleListContainer || !subtitleSlicePanel) return;
        if (subtitleSlicePanel.style.display === 'none') return;

        var idx = __findSubtitleIndex(player.currentTime);
        if (idx !== __subtitleLastListHighlight) {
            var prevIdx = __subtitleLastListHighlight;
            __subtitleLastListHighlight = idx;
            if (!player.paused) {
                __refreshSubtitleRowsForIndexes(prevIdx, idx);
            }
            if (idx >= 0 && __audioPlayingIndex < 0 && !player.paused) {
                // 防抖：边界处避免频繁滚动，等 300ms 再居中
                if (__subtitleScrollDebounce) clearTimeout(__subtitleScrollDebounce);
                __subtitleScrollDebounce = setTimeout(function () {
                    if (__subtitleLastListHighlight !== idx) return;
                    __scrollSubtitleIndexIntoView(idx, 'smooth');
                }, 300);
            }
        }
    });
}

// 修改 __loadSubtitle 在加载后更新面板
var __origLoadSubtitle = __loadSubtitle;
__loadSubtitle = async function () {
    await __origLoadSubtitle();
    __resetSubtitleVirtualList();
    __subtitleAddedCacheKey = '';
    if (__subtitleEnabled && __subtitleData.length > 0) {
        __stopAudioPlayback();
        __audioSrc = null;
        __audioSrcVideoName = '';
    }
    __updateSliceConfigUI();
};

// ---------- 切片配置 ----------
var videoPreviewPanel = document.getElementById('videoPreviewPanel');
var manualSliceControls = document.getElementById('manualSliceControls');

function __isSubtitleAudioOnlyMode() {
    return !!(currentVideoName && __subtitleSliceEnabled && !__videoPreviewEnabled);
}

function __disableMainVideoPreview() {
    try { if (player && !player.paused) player.pause(); } catch (e) { }
    try { if (player && player.removeAttribute) player.removeAttribute('src'); } catch (e) { }
    try { if (player && typeof player.load === 'function') player.load(); } catch (e) { }
    try { if (typeof __destroyFramePlayer === 'function') __destroyFramePlayer(); } catch (e) { }
    try { if (typeof __stopTimelineThumbLoading === 'function') __stopTimelineThumbLoading(); } catch (e) { }
    try { hideVideoLoadingHint(); } catch (e) { }
    __mainPreviewActive = false;
    __framePlayerActive = false;
    __rvfcActive = false;
    __setVideoContainerExpanded(false);
    refreshVideoStageDim();
    __refreshPreviewInteractiveState();
}

function __updateSliceConfigUI() {
    const cfgPanel = document.getElementById('sliceConfigPanel');
    const previewBody = document.getElementById('videoPreviewBody');
    const hasSubtitles = __subtitleEnabled && __subtitleData.length > 0;
    const audioOnlyMode = __isSubtitleAudioOnlyMode();

    if (cfgPanel) cfgPanel.style.display = currentVideoName ? '' : 'none';

    if (currentVideoName) {
        if (!__videoPreviewEnabled) __disableMainVideoPreview();
        if (previewBody) previewBody.style.display = __videoPreviewEnabled ? '' : 'none';
        if (videoPreviewPanel) videoPreviewPanel.style.display = __videoPreviewEnabled ? '' : 'none';
        refreshVideoStageDim();
    } else {
        // 未选择视频：隐藏所有
        if (previewBody) previewBody.style.display = 'none';
        if (videoPreviewPanel) videoPreviewPanel.style.display = 'none';
        try { player.pause(); if (player && player.removeAttribute) { player.removeAttribute('src'); player.load && player.load(); } __mainPreviewActive = false; } catch (e) { }
        refreshVideoStageDim();
    }

    // 字幕切片面板、复选框
    const subCb = document.getElementById('enableSubtitleSlice');
    if (subCb) {
        subCb.disabled = !hasSubtitles;
    }
    if (__subtitleSliceEnabled && hasSubtitles) {
        __showSubtitleSlicePanel();
    } else {
        __hideSubtitleSlicePanel();
    }

    // manualSliceControls always visible when video selected
    if (manualSliceControls) manualSliceControls.style.display = currentVideoName && !audioOnlyMode ? '' : 'none';

    try { if (typeof window.__tlRenderTimeline === 'function') window.__tlRenderTimeline(); } catch (e) { }

    __saveSliceConfigState();
}

function __saveSliceConfigState() {
    try {
        localStorage.setItem('slice_config_sub', __subtitleSliceEnabled ? '1' : '0');
        localStorage.setItem('slice_config_video_preview', __videoPreviewEnabled ? '1' : '0');
    } catch (e) { }
}

(function __initSliceConfigPanel() {
    const videoPreviewCb = document.getElementById('enableVideoPreview');
    const subCb = document.getElementById('enableSubtitleSlice');

    try {
        const savedV = localStorage.getItem('slice_config_video_preview');
        if (savedV !== null) __videoPreviewEnabled = (savedV === '1');
        const savedS = localStorage.getItem('slice_config_sub');
        if (savedS !== null) __subtitleSliceEnabled = (savedS === '1');
    } catch (e) { }

    if (videoPreviewCb) {
        videoPreviewCb.checked = __videoPreviewEnabled;
        videoPreviewCb.addEventListener('change', function () {
            __videoPreviewEnabled = this.checked;
            __updateSliceConfigUI();
        });
    }

    if (subCb) {
        subCb.checked = __subtitleSliceEnabled;
        subCb.addEventListener('change', function () {
            __subtitleSliceEnabled = this.checked;
            if (__subtitleSliceEnabled && currentVideoName && !__subtitleEnabled) {
                __loadSubtitle();
            }
            __updateSliceConfigUI();
        });
    }

    __updateSliceConfigUI();
})();

// 在取消选择视频时也隐藏面板
var __origDeselectVideo = null;

// ---------- 视频加载网络提示：若加载超过 1.2s 或触发 waiting/stalled 则提示用户 ----------
let __videoLoadHintTimer = null;
let __videoLoadHintHideTimer = null;
let __videoLoadSlowTimer = null;
let __videoLoadTimeoutTimer = null;
let __videoPlaybackBuffering = false;
let __videoLoadHintSeq = 0;
function showVideoLoadingHint(text = '视频加载中…') {
    const el = document.getElementById('videoLoadingHint');
    const stage = document.getElementById('videoStage');
    if (stage) stage.classList.add('loading');
    if (!el) return;
    el.textContent = text;
    if (__videoLoadHintHideTimer) {
        clearTimeout(__videoLoadHintHideTimer);
        __videoLoadHintHideTimer = null;
    }
    el.style.display = 'flex';
    el.classList.remove('hiding');
    requestAnimationFrame(() => {
        el.classList.add('show');
    });
}
function hideVideoLoadingHint() {
    __videoLoadHintSeq++;
    if (__videoLoadHintTimer) { clearTimeout(__videoLoadHintTimer); __videoLoadHintTimer = null; }
    if (__videoLoadSlowTimer) { clearTimeout(__videoLoadSlowTimer); __videoLoadSlowTimer = null; }
    if (__videoLoadTimeoutTimer) { clearTimeout(__videoLoadTimeoutTimer); __videoLoadTimeoutTimer = null; }
    const el = document.getElementById('videoLoadingHint');
    const stage = document.getElementById('videoStage');
    if (stage) stage.classList.remove('loading');
    if (!el) return;
    el.classList.remove('show');
    el.classList.add('hiding');
    if (__videoLoadHintHideTimer) {
        clearTimeout(__videoLoadHintHideTimer);
    }
    __videoLoadHintHideTimer = setTimeout(() => {
        el.classList.remove('hiding');
        __videoLoadHintHideTimer = null;
    }, 230);
}
function __shouldShowVideoLoadingHint(startTime) {
    if (!player || player.error || player.ended) return false;
    if (!currentVideoName || !__mainPreviewActive) return false;
    if (__videoPlaybackBuffering) return !player.paused;
    if (player.readyState >= 3) return false;
    if (!player.seeking && player.paused) return false;
    if (!player.seeking && Number.isFinite(startTime) && Math.abs((player.currentTime || 0) - startTime) > 0.05) return false;
    return true;
}
function __scheduleVideoLoadingHint(text, delayMs = 320) {
    const seq = ++__videoLoadHintSeq;
    const startTime = player ? player.currentTime : 0;
    if (__videoLoadHintTimer) { clearTimeout(__videoLoadHintTimer); __videoLoadHintTimer = null; }
    __videoLoadHintTimer = setTimeout(() => {
        __videoLoadHintTimer = null;
        if (seq !== __videoLoadHintSeq) return;
        if (__shouldShowVideoLoadingHint(startTime)) showVideoLoadingHint(text);
        else hideVideoLoadingHint();
    }, delayMs);
}
function __hideVideoLoadingHintIfPlayable() {
    if (!player) return;
    if (player.readyState >= 3) {
        __videoPlaybackBuffering = false;
        hideVideoLoadingHint();
    }
}
function __isPreviewLoadPending(videoName) {
    if (!player || !currentVideoName || !__mainPreviewActive) return false;
    if (videoName && currentVideoName !== videoName) return false;
    if (player.error || player.readyState >= 3) return false;
    return true;
}
function _startVideoLoadWatcher(videoName, slowMs = 1200, timeoutMs = 15000) {
    const seq = ++__videoLoadHintSeq;
    const stage = document.getElementById('videoStage');
    if (stage) stage.classList.add('loading');
    if (__videoLoadHintTimer) { clearTimeout(__videoLoadHintTimer); __videoLoadHintTimer = null; }
    if (__videoLoadSlowTimer) { clearTimeout(__videoLoadSlowTimer); __videoLoadSlowTimer = null; }
    if (__videoLoadTimeoutTimer) { clearTimeout(__videoLoadTimeoutTimer); __videoLoadTimeoutTimer = null; }

    __videoLoadSlowTimer = setTimeout(() => {
        __videoLoadSlowTimer = null;
        if (seq !== __videoLoadHintSeq || !__isPreviewLoadPending(videoName)) return;
        showVideoLoadingHint('视频加载中（网络较慢），请稍候…');
    }, slowMs);

    __videoLoadTimeoutTimer = setTimeout(() => {
        __videoLoadTimeoutTimer = null;
        if (seq !== __videoLoadHintSeq || !__isPreviewLoadPending(videoName)) return;
        showVideoLoadingHint('视频仍在加载，可能是网络较慢或视频较大…');
        showToast('视频仍在加载，请稍候或稍后重试', 'warning', 4200);
    }, timeoutMs);
}
player.addEventListener('canplay', () => { __videoPlaybackBuffering = false; hideVideoLoadingHint(); });
player.addEventListener('canplaythrough', () => { __videoPlaybackBuffering = false; hideVideoLoadingHint(); });
player.addEventListener('playing', () => { __videoPlaybackBuffering = false; hideVideoLoadingHint(); });
player.addEventListener('loadeddata', () => { __videoPlaybackBuffering = false; hideVideoLoadingHint(); });
player.addEventListener('seeked', () => { __videoPlaybackBuffering = false; hideVideoLoadingHint(); });
player.addEventListener('timeupdate', () => { __hideVideoLoadingHintIfPlayable(); });
player.addEventListener('progress', () => { __hideVideoLoadingHintIfPlayable(); });
player.addEventListener('pause', () => { __videoPlaybackBuffering = false; hideVideoLoadingHint(); });
player.addEventListener('error', () => { __videoPlaybackBuffering = false; hideVideoLoadingHint(); showToast('视频加载失败', 'error'); });
player.addEventListener('waiting', () => {
    __videoPlaybackBuffering = true;
    if (__failActiveVideoSegmentPlayback()) return;
    __scheduleVideoLoadingHint('缓冲中…', 320);
});
player.addEventListener('stalled', () => {
    __videoPlaybackBuffering = true;
    if (__failActiveVideoSegmentPlayback()) return;
    __scheduleVideoLoadingHint('视频加载中（网络不稳定）…', 700);
});

let __audioBufferHintTimer = null;
let __audioBufferHintActive = false;
function __scheduleAudioBufferHint(text, delayMs = 500) {
    if (!audioPlayer) return;
    if (__audioBufferHintTimer) clearTimeout(__audioBufferHintTimer);
    if (__audioPlayingIndex >= 0 && __subtitleAudioPlaybackStarted) {
        __stopAudioPlayback();
        showToast('音频播放卡顿，播放失败，请重试', 'error');
        return;
    }
    const playingIdx = __audioPlayingIndex;
    __audioBufferHintTimer = setTimeout(() => {
        __audioBufferHintTimer = null;
        if (!audioPlayer || audioPlayer.paused || audioPlayer.ended) return;
        __audioBufferHintActive = true;
        if (playingIdx >= 0 && __audioPlayingIndex === playingIdx) {
            __audioLoadingIndex = playingIdx;
            __refreshSubtitleRowsForIndexes(playingIdx);
        }
        showToast(text, 'info', 2200);
    }, delayMs);
}
function __clearAudioBufferHint() {
    if (__audioBufferHintTimer) {
        clearTimeout(__audioBufferHintTimer);
        __audioBufferHintTimer = null;
    }
    if (!__audioBufferHintActive) return;
    __audioBufferHintActive = false;
    const loadingIdx = __audioLoadingIndex;
    if (loadingIdx >= 0) {
        __audioLoadingIndex = -1;
        __refreshSubtitleRowsForIndexes(loadingIdx);
    }
}
if (audioPlayer) {
    audioPlayer.addEventListener('waiting', () => { __scheduleAudioBufferHint('音频加载中，请稍候…', 420); });
    audioPlayer.addEventListener('stalled', () => { __scheduleAudioBufferHint('音频加载中（网络不稳定），请稍候…', 700); });
    audioPlayer.addEventListener('playing', __clearAudioBufferHint);
    audioPlayer.addEventListener('canplay', __clearAudioBufferHint);
    audioPlayer.addEventListener('canplaythrough', __clearAudioBufferHint);
    audioPlayer.addEventListener('error', () => { __clearAudioBufferHint(); showToast('音频加载失败', 'error'); });
}

// 页面隐藏/关闭时也保存一次（移动端/切后台更可靠）
window.addEventListener('pagehide', () => {
    if (typeof __stopTimelineThumbLoading === 'function') {
        try { __stopTimelineThumbLoading(); } catch (err) { }
    }
    __saveProgress(currentVideoName, player.currentTime, player.duration);
    // 若正在等待恢复提示选择，避免把当前（可能为空的）videoTasks 覆盖到 localStorage
    if (!__restorePromptActive) __saveClipToolState();
});

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        __saveProgress(currentVideoName, player.currentTime, player.duration);
        if (!__restorePromptActive) __saveClipToolState();
    }
});

// ------------------ 播放器双击全屏 ------------------
player.addEventListener('dblclick', () => {
    // 未选择视频或未进入预览时，忽略双击（避免误触进入/退出全屏）
    if (!__isVideoReady()) return;

    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        // 进入全屏
        if (playerWrapper.requestFullscreen) {
            playerWrapper.requestFullscreen();
        } else if (playerWrapper.webkitRequestFullscreen) {
            playerWrapper.webkitRequestFullscreen();
        }
    } else {
        // 退出全屏
        if (document.exitFullscreen) {
            document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
        }
    }
});

// ------------------ 快捷键支持 ------------------
function triggerBtnFeedback(btn) {
    if (!btn) return;
    btn.classList.add('click-anim');
    setTimeout(() => btn.classList.remove('click-anim'), 200);
}

document.addEventListener('keydown', (e) => {
    // 忽略输入/可编辑区域和表单控件 keydown，防止空格键意外触发全局快捷键或双触发按钮
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT' || e.target.tagName === 'BUTTON' || e.target.isContentEditable) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    // 未选择视频或未预览时，禁用所有视频相关快捷键
    if (!__isVideoReady()) return;

    const key = e.key.toLowerCase();

    // [Q] 设定起点（从当前播放头位置取值）
    if (key === 'q') {
        if (typeof window.__tlDeselectAllClips === 'function') __tlDeselectAllClips();
        const r = __getCurrentPlayTime(); const attempted = r.time; tempStartFrame = r.frame;

        // 若已设终点且起点晚于终点，则提示并不更新
        if (tempEnd !== null && attempted > tempEnd) {
            showToast('起点不能晚于终点，请先调整终点或重置起点', 'warning');
            return;
        }

        tempStart = attempted;
        // 如果已经有终点，则自动添加片段（UI 更新由 __doAddClip 内部 rAF 统一处理）
        if (tempEnd !== null) {
            __doAddClip();
        } else {
            updateClipInputs();
            showToast(`起点: ${formatTime(r.time)}`);
            if (quickSetStartBtn) triggerBtnFeedback(quickSetStartBtn);
        }
    }
    // [W] 设定终点，若起点已设定则自动添加片段
    else if (key === 'w') {
        if (tempStart === null) {
            showToast('请先设置起点', 'info');
            return;
        }
        if (typeof window.__tlDeselectAllClips === 'function') __tlDeselectAllClips();
        const r = __getCurrentPlayTime(); const attempted = r.time; tempEndFrame = r.frame;

        // 若已设起点且终点早于起点，则提示并不更新
        if (attempted < tempStart) {
            showToast('终点不能早于起点，请先调整起点或重置终点', 'warning');
            return;
        }

        tempEnd = attempted;
        // 起点已设，自动提交（UI 更新由 __doAddClip 内部 rAF 统一处理）
        __doAddClip();
    }
    // [C] 手动添加片段（作为备选快捷键）
    else if (key === 'c' || key === 'enter') {
        e.preventDefault();
        if (__mergeStatusLastState && __mergeStatusLastState.running === true) return;
        __doAddClip();
        triggerBtnFeedback(confirmAddClipBtn);
        triggerBtnFeedback(quickAddClipBtnCtrl);
    }
    // [P] 预览选中片段
    else if (key === 'p') {
        quickPlayClipBtn.click();
        triggerBtnFeedback(quickPlayClipBtn);
    }
    // [ [ ] 回到片段起点（不播放）
    else if (key === '[') {
        e.preventDefault();
        if (!currentVideoName || tempStart === null) return;
        try {
            player.pause();
            __seekPrecise(Number(tempStart));
        } catch (err) {
            // ignore
        }
    }
    // [D / Shift+D] 跳转到起点（选中片段则用片段起点），无Shift时播放
    else if (key === 'd') {
        e.preventDefault();
        const sel = (typeof window.__tlGetSelectedClipsSorted === 'function') ? window.__tlGetSelectedClipsSorted() : [];
        const t = sel.length > 0 ? sel[0].start : (tempStart !== null ? Number(tempStart) : null);
        if (t !== null && currentVideoName && __isVideoReady()) {
            try {
                if (e.shiftKey) player.pause();
                __seekPrecise(t);
                if (!e.shiftKey) player.play().catch(() => {});
            } catch (err) { }
        } else {
            showToast('请先设置起点', 'info');
        }
    }
    // [J / Shift+J] 跳转到终点（选中片段则用片段终点），无Shift时播放
    else if (key === 'j') {
        e.preventDefault();
        const sel = (typeof window.__tlGetSelectedClipsSorted === 'function') ? window.__tlGetSelectedClipsSorted() : [];
        const t = sel.length > 0 ? sel[sel.length - 1].end : (tempEnd !== null ? Number(tempEnd) : null);
        if (t !== null && currentVideoName && __isVideoReady()) {
            try {
                if (e.shiftKey) player.pause();
                __seekPrecise(t);
                if (!e.shiftKey) player.play().catch(() => {});
            } catch (err) { }
        } else {
            showToast('请先设置终点', 'info');
        }
    }
    // [ArrowLeft] 播放头后退1秒
    else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        try { __seekPrecise((player.currentTime || 0) - 1); } catch (err) { }
    }
    // [ArrowRight] 播放头前进1秒
    else if (e.key === 'ArrowRight') {
        e.preventDefault();
        try { __seekPrecise((player.currentTime || 0) + 1); } catch (err) { }
    }
    // [Space] 播放/暂停
    else if (key === ' ') {
        e.preventDefault();
        togglePlay();
        triggerBtnFeedback(playPauseBtn);
    }
});

// ==================== 时间轴编辑器 v2.1（含缩放 / 平移）====================

(function () {
    'use strict';

    let __tlTooltip = null;
    let __tlTimerAF = null;
    let __tlDragging = null;   // 'start' | 'end' | null
    let __tlDragDuration = 0;
    let __tlDragTrackEl = null;

    // ---- 缩放 / 滚动条状态 ----
    let __tlZoom = 1;
    let __tlFollowPlayhead = true;
    let __tlSuppressFollowUntil = 0;
    let __tlSelectedClipKeys = new Set();
    let __tlDeleteSelectedBtn = null;
    let __tlSelectedPlayback = null;
    let __tlThumbEnabled = false;
    let __tlZoomToggleBtn = null;
    let __tlZoomAutoAppliedKey = '';
    let __tlRenderedClips = [];
    let __tlResizeObserver = null;
    let __tlMediaResetKey = '';
    function _tlThumbDisplayWidth(container) {
        const h = Math.max(1, (container && container.clientHeight) || 48);
        return Math.max(1, Math.round(h * 16 / 9));
    }

    function _tlCalcThumbStep() {
        const dur = _tlDur();
        if (!dur) return 30;
        const inner = _tlInner();
        const pxWidth = Math.max(0, inner ? inner.clientWidth : 0);
        const thumbW = _tlThumbDisplayWidth(__tlThumbLastStrip);
        const target = pxWidth > 0 ? Math.max(1, Math.ceil(pxWidth / thumbW) + 1) : 60;
        let step = Math.max(1, Math.floor(dur / target));
        step = Math.min(step, 600);
        return step;
    }
    let __tlThumbLastStrip = null;
    let __tlThumbLastDur = 0;
    let __tlThumbLastData = [];
    let __tlThumbLastStep = 0;
    let __tlThumbAbortController = null;
    const __tlThumbCache = new Map();
    const __tlThumbJobs = new Map();
    let __tlThumbRenderToken = 0;
    let __tlBoxSelecting = false;
    let __tlBoxMoved = false;
    let __tlBoxStartX = 0;
    let __tlBoxStartY = 0;
    let __tlSuppressWrapClick = false;
    const TL_ZOOM_LEVELS = [1, 2, 4, 8, 16, 32, 64, 128, 256];
    const TL_CLIP_COLOR_RGBS = [
        '79,158,255',
        '100,220,120',
        '255,180,80',
        '205,140,255',
        '255,120,170',
        '90,220,230'
    ];
    // 滚动条拖拽状态
    let __tlSbDragging = false;
    let __tlSbStartX = 0;
    let __tlSbStartSL = 0;
    let __tlSbHintAt = 0;

    // ---- 波形可视化状态 ----
    let __tlWaveformEnabled = true;
    let __tlWaveformCanvas = null;
    let __tlWaveformData = null;    // {peaks:[], duration, samples}
    let __tlWaveformAbortController = null;
    const __tlWaveformCache = new Map();
    const __tlWaveformJobs = new Map();
    let __tlWaveformRenderToken = 0;

    // ---- 播放头拖拽状态 ----
    let __tlPlayheadDragging = false;

    function _tlMaybeShowFollowSbHint() {
        if (!__tlFollowPlayhead) return;
        const now = Date.now();
        if (now - __tlSbHintAt < 1200) return;
        __tlSbHintAt = now;
        try { showToast('已手动滚动时间轴；保持“跟随播放”时，播放中会继续自动居中'); } catch (err) { }
    }

    // ---- 格式化工具 ----
    function _tlFmt(s) {
        s = Math.max(0, Math.floor(Number(s) || 0));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
        return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    }

    function _tlFmtFull(s) {
        s = Math.max(0, Math.floor(Number(s) || 0));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    }

    function _tlDur() {
        try { const d = player && player.duration; return (isFinite(d) && d > 0) ? d : 0; } catch (e) { return 0; }
    }

    function _tlThumbKey(stepSec) {
        const dur = _tlDur();
        if (!currentVideoName || !dur) return '';
        return `${currentVideoName}__${Math.round(dur)}__${stepSec}`;
    }

    function _tlWaitVideoEvent(video, eventName) {
        return new Promise((resolve, reject) => {
            const onOk = () => {
                video.removeEventListener(eventName, onOk);
                video.removeEventListener('error', onErr);
                resolve();
            };
            const onErr = () => {
                video.removeEventListener(eventName, onOk);
                video.removeEventListener('error', onErr);
                reject(new Error(`video event failed: ${eventName}`));
            };
            video.addEventListener(eventName, onOk, { once: true });
            video.addEventListener('error', onErr, { once: true });
        });
    }

    async function _tlSeekVideoTo(video, t) {
        const d = Number(video.duration) || 0;
        const target = Math.max(0, Math.min(Math.max(0, d - 0.05), t));
        await new Promise((resolve, reject) => {
            const onSeeked = () => {
                video.removeEventListener('seeked', onSeeked);
                video.removeEventListener('error', onErr);
                resolve();
            };
            const onErr = () => {
                video.removeEventListener('seeked', onSeeked);
                video.removeEventListener('error', onErr);
                reject(new Error('seek failed'));
            };
            video.addEventListener('seeked', onSeeked, { once: true });
            video.addEventListener('error', onErr, { once: true });
            try { video.currentTime = target; } catch (e) { reject(e); }
        });
    }

    function _tlAbortThumbLoading() {
        if (__tlThumbAbortController) {
            try { __tlThumbAbortController.abort(); } catch (e) { }
            __tlThumbAbortController = null;
        }
        try { __tlThumbJobs.clear(); } catch (e) { }
    }
    __stopTimelineThumbLoading = _tlAbortThumbLoading;

    function _tlBeginThumbLoading() {
        _tlAbortThumbLoading();
        __tlThumbAbortController = new AbortController();
        return __tlThumbAbortController;
    }

    async function _tlBuildThumbs(stepSec = _tlCalcThumbStep(), onPartial = null, signal = null) {
        const dur = _tlDur();
        if (!dur || !currentVideoName || !__isVideoReady()) return [];

        const step = Math.max(1, Math.floor(Number(stepSec) || _tlCalcThumbStep()));
        const params = new URLSearchParams({
            name: currentVideoName,
            step: String(step),
            width: '640',
            height: '360',
            quality: '10'
        });

        const streamRes = await fetch(`/api/thumb_manifest_stream?${params.toString()}`, { signal });
        if (!streamRes.ok) throw new Error(`thumb stream failed: ${streamRes.status}`);

        if (!streamRes.body) {
            const fallbackRes = await fetch(`/api/thumb_manifest?${params.toString()}`, { signal });
            if (!fallbackRes.ok) throw new Error(`thumb manifest failed: ${fallbackRes.status}`);
            const fallbackData = await fallbackRes.json();
            const thumbs = Array.isArray(fallbackData?.thumbs) ? fallbackData.thumbs : [];
            const cleaned = thumbs
                .filter(x => x && typeof x.time === 'number' && typeof x.url === 'string')
                .map(x => ({
                    time: Math.max(0, Number(x.time) || 0),
                    url: x.url
                }));
            if (typeof onPartial === 'function') onPartial(cleaned);
            return cleaned;
        }

        const reader = streamRes.body.getReader();
        const decoder = new TextDecoder('utf-8');
        const thumbs = [];
        let buf = '';
        let pendingPartialCount = 0;
        let lastPartialAt = 0;

        const pushPartial = (force = false) => {
            if (typeof onPartial !== 'function') return;
            const now = Date.now();
            pendingPartialCount += 1;
            if (!force && pendingPartialCount < 3 && (now - lastPartialAt) < 120) return;
            pendingPartialCount = 0;
            lastPartialAt = now;
            onPartial(thumbs.slice());
        };

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() || '';

            for (const raw of lines) {
                const line = (raw || '').trim();
                if (!line) continue;
                try {
                    const item = JSON.parse(line);
                    if (item && item.type === 'thumb' && typeof item.time === 'number' && typeof item.url === 'string') {
                        thumbs.push({ time: Math.max(0, Number(item.time) || 0), url: item.url });
                        pushPartial(false);
                    }
                } catch (e) { }
            }
        }

        if (buf.trim()) {
            try {
                const item = JSON.parse(buf.trim());
                if (item && item.type === 'thumb' && typeof item.time === 'number' && typeof item.url === 'string') {
                    thumbs.push({ time: Math.max(0, Number(item.time) || 0), url: item.url });
                    pushPartial(false);
                }
            } catch (e) { }
        }

        thumbs.sort((a, b) => a.time - b.time);
        pushPartial(true);
        return thumbs;
    }

    async function _tlEnsureThumbs(stepSec = _tlCalcThumbStep(), onPartial = null, signal = null) {
        const key = _tlThumbKey(stepSec);
        if (!key) return [];
        if (__tlThumbCache.has(key)) {
            const cached = __tlThumbCache.get(key) || [];
            if (!Array.isArray(cached) || cached.length === 0) {
                __tlThumbCache.delete(key);
            } else {
                if (typeof onPartial === 'function') onPartial(cached);
                return cached;
            }
        }
        if (__tlThumbJobs.has(key)) return __tlThumbJobs.get(key);

        const job = (async () => {
            try {
                const thumbs = await _tlBuildThumbs(stepSec, onPartial, signal);
                if (Array.isArray(thumbs) && thumbs.length > 0) {
                    __tlThumbCache.set(key, thumbs);
                } else {
                    __tlThumbCache.delete(key);
                }
                return thumbs;
            } finally {
                __tlThumbJobs.delete(key);
            }
        })();
        __tlThumbJobs.set(key, job);
        return job;
    }

    function _tlRenderThumbStrip(container, dur, thumbs, stepSec = _tlCalcThumbStep()) {
        if (!container) return;
        container.innerHTML = '';
        if (!dur || !Array.isArray(thumbs) || thumbs.length === 0) return;

        const thumbW = _tlThumbDisplayWidth(container);
        for (const thumb of thumbs) {
            if (!thumb || typeof thumb.time !== 'number' || !thumb.url) continue;
            const t = Math.max(0, Number(thumb.time) || 0);
            if (t > dur) continue;
            const leftPct = (t / dur) * 100;
            const seg = document.createElement('div');
            seg.className = 'timeline-thumb';
            seg.style.left = leftPct + '%';
            seg.style.width = thumbW + 'px';
            seg.style.backgroundImage = `url(${thumb.url})`;
            container.appendChild(seg);
        }
    }

    function _tlRerenderThumbStripByZoom() {
        if (!__tlThumbEnabled) return;
        if (!__tlThumbLastStrip || !__tlThumbLastStrip.isConnected) return;
        if (!__tlThumbLastDur || !Array.isArray(__tlThumbLastData) || __tlThumbLastData.length === 0) return;
        const nextStep = _tlCalcThumbStep();
        if (nextStep === __tlThumbLastStep) {
            _tlRenderThumbStrip(__tlThumbLastStrip, __tlThumbLastDur, __tlThumbLastData, nextStep);
            return;
        }

        __tlThumbLastStep = 0;
        __tlThumbLastData = [];
        _tlRenderThumbStrip(__tlThumbLastStrip, __tlThumbLastDur, [], nextStep);

        const myToken = ++__tlThumbRenderToken;
        const ctrl = _tlBeginThumbLoading();
        _tlEnsureThumbs(nextStep, (partialThumbs) => {
            if (myToken !== __tlThumbRenderToken) return;
            if (!__tlThumbLastStrip || !__tlThumbLastStrip.isConnected) return;
            if (!__tlThumbEnabled) return;
            __tlThumbLastStep = nextStep;
            __tlThumbLastData = partialThumbs;
            _tlRenderThumbStrip(__tlThumbLastStrip, __tlThumbLastDur, partialThumbs, nextStep);
        }, ctrl.signal).then(thumbs => {
            if (myToken !== __tlThumbRenderToken) return;
            if (!__tlThumbLastStrip || !__tlThumbLastStrip.isConnected) return;
            if (!__tlThumbEnabled) return;
            __tlThumbLastStep = nextStep;
            __tlThumbLastData = thumbs;
            _tlRenderThumbStrip(__tlThumbLastStrip, __tlThumbLastDur, thumbs, nextStep);
        }).catch(() => { });
    }

    // ---- 波形可视化 ----
    function _tlWaveformKey() {
        const dur = _tlDur();
        if (!currentVideoName || !dur) return '';
        return `${currentVideoName}__${Math.round(dur)}`;
    }

    function _tlAbortWaveformLoading() {
        if (__tlWaveformAbortController) {
            try { __tlWaveformAbortController.abort(); } catch (e) { }
            __tlWaveformAbortController = null;
        }
    }

    async function _tlFetchWaveform(signal) {
        const dur = _tlDur();
        if (!dur || !currentVideoName || !__isVideoReady()) return null;
        const key = _tlWaveformKey();
        if (!key) return null;
        if (__tlWaveformCache.has(key)) return __tlWaveformCache.get(key);
        if (__tlWaveformJobs.has(key)) return __tlWaveformJobs.get(key);

        const samples = Math.max(200, Math.min(2000, Math.round(dur / 0.5)));
        const params = new URLSearchParams({ name: currentVideoName, samples: String(samples) });
        const job = (async () => {
            try {
                const res = await fetch(`/api/waveform?${params.toString()}`, { signal });
                if (!res.ok) return null;
                const data = await res.json();
                if (data && Array.isArray(data.peaks) && data.peaks.length > 0) {
                    __tlWaveformCache.set(key, data);
                    return data;
                }
                return null;
            } catch (e) {
                return null;
            } finally {
                __tlWaveformJobs.delete(key);
            }
        })();
        __tlWaveformJobs.set(key, job);
        return job;
    }

    function _tlRenderWaveformCanvas(canvas, peaks) {
        if (!canvas || !peaks || peaks.length === 0) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, w, h);

        const barCount = peaks.length;
        const barWidth = w / barCount;
        const midY = h / 2;

        // gradient from accent color
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, 'rgba(79, 158, 255, 0.85)');
        grad.addColorStop(0.5, 'rgba(79, 158, 255, 0.55)');
        grad.addColorStop(1, 'rgba(79, 158, 255, 0.85)');
        ctx.fillStyle = grad;

        for (let i = 0; i < barCount; i++) {
            const amp = Math.max(0, Math.min(1, peaks[i] || 0));
            const barH = Math.max(1, amp * midY * 0.92);
            const x = i * barWidth;
            ctx.fillRect(x, midY - barH, Math.max(0.8, barWidth - 0.3), barH * 2);
        }
    }

    function _tlRerenderWaveformByZoom() {
        if (!__tlWaveformEnabled) return;
        if (!__tlWaveformCanvas || !__tlWaveformCanvas.isConnected) return;
        if (!__tlWaveformData || !Array.isArray(__tlWaveformData.peaks)) return;
        _tlRenderWaveformCanvas(__tlWaveformCanvas, __tlWaveformData.peaks);
    }

    function _tlAutoZoomByDuration(durationSec) {
        const d = Number(durationSec) || 0;
        // auto-zoom ramp is deliberately shifted upwards so that
        // even relatively short durations use a larger scale by
        // default.  we also support the new high zoom levels.
        if (d <= 15 * 60) return 2;
        if (d <= 30 * 60) return 4;
        if (d <= 60 * 60) return 8;
        if (d <= 120 * 60) return 16;
        if (d <= 240 * 60) return 32;
        if (d <= 360 * 60) return 64;
        if (d <= 720 * 60) return 128;
        return 256;
    }

    function _tlTooltipEl() {
        if (!__tlTooltip) __tlTooltip = document.getElementById('timelineTooltip');
        return __tlTooltip;
    }

    function _showTip(html, x, y) {
        const t = _tlTooltipEl(); if (!t) return;
        t.innerHTML = html; t.classList.add('visible');
        const tw = t.offsetWidth, th = t.offsetHeight;
        let lx = x + 14, ly = y - th - 8;
        if (lx + tw > window.innerWidth - 8) lx = x - tw - 14;
        if (ly < 8) ly = y + 14;
        t.style.left = lx + 'px'; t.style.top = ly + 'px';
    }
    function _hideTip() { const t = _tlTooltipEl(); if (t) t.classList.remove('visible'); }

    // ---- 获取 inner / wrap 元素 ----
    function _tlInner() { return document.getElementById('tlInner'); }
    function _tlWrap() { return document.getElementById('tlWrap'); }

    // ---- 把像素 X（相对 inner）转换为时间 ----
    function _tlXToTime(x) {
        const dur = _tlDur();
        const inner = _tlInner();
        if (!inner || !dur) return 0;
        return Math.max(0, Math.min(dur, (x / inner.offsetWidth) * dur));
    }

    // ---- 把时间转为 inner 内 left 像素 ----
    function _tlTimeToX(t) {
        const dur = _tlDur();
        const inner = _tlInner();
        if (!inner || !dur) return 0;
        return (t / dur) * inner.offsetWidth;
    }

    // ---- 把 clientX 换算到 inner 内 X ----
    function _tlClientToInnerX(clientX) {
        const inner = _tlInner();
        if (!inner) return 0;
        const rect = inner.getBoundingClientRect();
        return clientX - rect.left;
    }

    // ---- 读 tempStart / tempEnd ----
    function _getTS() { try { return (typeof tempStart === 'number' && isFinite(tempStart)) ? tempStart : null; } catch (e) { return null; } }
    function _getTE() { try { return (typeof tempEnd === 'number' && isFinite(tempEnd)) ? tempEnd : null; } catch (e) { return null; } }

    // ---- 写 tempStart / tempEnd ----
    function _applyStart(t) {
        try { tempStart = __roundClipTime(Math.max(0, Math.min(t, _tlDur()))); if (typeof updateClipInputs === 'function') updateClipInputs(); } catch (e) { }
    }
    function _applyEnd(t) {
        try { tempEnd = __roundClipTime(Math.max(0, Math.min(t, _tlDur()))); if (typeof updateClipInputs === 'function') updateClipInputs(); } catch (e) { }
    }

    function _tlClipKey(taskName, clip, clipIndex) {
        return `${taskName}__${Number(clip.start)}__${Number(clip.end)}__${clipIndex}`;
    }

    function _tlGetSelectedClipsSorted() {
        const picked = [];
        for (const task of (videoTasks || [])) {
            const clips = task.clips || [];
            for (let i = 0; i < clips.length; i++) {
                const c = clips[i];
                const key = _tlClipKey(task.name, c, i);
                if (!__tlSelectedClipKeys.has(key)) continue;
                const s = Number(c.start);
                const e = Number(c.end);
                if (!isFinite(s) || !isFinite(e) || e <= s) continue;
                picked.push({ key, start: s, end: e });
            }
        }
        picked.sort((a, b) => (a.start - b.start) || (a.end - b.end));
        return picked;
    }

    function _tlStopSelectedPlayback() {
        __tlSelectedPlayback = null;
    }

    function _tlHandleSelectedPlayback() {
        if (!__tlSelectedPlayback) return;
        const state = __tlSelectedPlayback;
        const cur = state.clips[state.index];
        if (!cur) { _tlStopSelectedPlayback(); return; }
        const now = Number(player.currentTime) || 0;
        const fps = __getVideoFpsSync() || 30;
        if (now < cur.end - 1 / fps) return;

        if (state.index < state.clips.length - 1) {
            state.index += 1;
            const next = state.clips[state.index];
            try {
                __seekPrecise(next.start);
                if (player.paused) player.play().catch(() => { });
            } catch (e) { }
            return;
        }

        _tlStopSelectedPlayback();
        try {
            player.pause();
            __seekPrecise(cur.end);
        } catch (e) { }
    }

    function _tlTryPlaySelectedClips() {
        if (__tlSelectedPlayback && (__tlSelectedPlayback.clips || []).length > 0) {
            try { player.play().catch(() => { }); } catch (e) { }
            return true;
        }
        const clips = _tlGetSelectedClipsSorted();
        if (clips.length === 0) {
            try { showToast('请先选择片段', 'info'); } catch (e) { }
            return false;
        }
        __tlSelectedPlayback = { clips, index: 0 };
        try {
            __seekPrecise(clips[0].start);
            player.play().catch(() => { });
        } catch (e) { }
        return true;
    }

    function _tlRefreshDeleteSelectedBtn() {
        if (!__tlDeleteSelectedBtn) return;
        const n = __tlSelectedClipKeys.size;
        __tlDeleteSelectedBtn.disabled = n === 0;
        __tlDeleteSelectedBtn.textContent = n > 0 ? `删除所选(${n})` : '删除所选';
    }

    function _tlDeleteSelectedClips() {
        if (__tlSelectedClipKeys.size === 0) return;
        _hideTip();
        _tlStopSelectedPlayback();

        let removed = 0;
        for (const task of (videoTasks || [])) {
            const src = task.clips || [];
            const next = [];
            for (let i = 0; i < src.length; i++) {
                const c = src[i];
                const key = _tlClipKey(task.name, c, i);
                if (__tlSelectedClipKeys.has(key)) {
                    removed += 1;
                } else {
                    next.push(c);
                }
            }
            task.clips = next;
        }
        for (let i = videoTasks.length - 1; i >= 0; i--) {
            if (!videoTasks[i].clips || videoTasks[i].clips.length === 0) videoTasks.splice(i, 1);
        }

        __tlSelectedClipKeys.clear();
        _tlRefreshDeleteSelectedBtn();

        if (removed > 0) {
            try {
} catch (e) { }
            try { __saveClipToolState(); } catch (e) { }
            try { renderNewClipList(); } catch (e) { }
            try { renderTimeline(); } catch (e) { }
        }
    }

    function _tlApplySelectedVisuals() {
        for (const c of (__tlRenderedClips || [])) {
            c.el.classList.toggle('selected', __tlSelectedClipKeys.has(c.key));
        }
        _tlRefreshDeleteSelectedBtn();
    }

    function _tlRectIntersects(a, b) {
        return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    }

    function _tlUpdateBoxSelection(clientX, clientY) {
        const wrap = _tlWrap();
        const box = document.getElementById('tlBoxSelectRect');
        if (!wrap || !box) return;

        const wr = wrap.getBoundingClientRect();
        const sx = Math.max(wr.left, Math.min(wr.right, __tlBoxStartX));
        const sy = Math.max(wr.top, Math.min(wr.bottom, __tlBoxStartY));
        const cx = Math.max(wr.left, Math.min(wr.right, clientX));
        const cy = Math.max(wr.top, Math.min(wr.bottom, clientY));

        const left = Math.min(sx, cx);
        const top = Math.min(sy, cy);
        const width = Math.abs(cx - sx);
        const height = Math.abs(cy - sy);

        __tlBoxMoved = __tlBoxMoved || width > 4 || height > 4;
        if (!__tlBoxMoved) {
            box.style.display = 'none';
            return;
        }

        box.style.display = '';
        box.style.left = (left - wr.left) + 'px';
        box.style.top = (top - wr.top) + 'px';
        box.style.width = width + 'px';
        box.style.height = height + 'px';

        const hitRect = { left, top, right: left + width, bottom: top + height };
        const next = new Set();
        for (const c of (__tlRenderedClips || [])) {
            const cr = c.el.getBoundingClientRect();
            if (_tlRectIntersects(hitRect, cr)) next.add(c.key);
        }

        let changed = next.size !== __tlSelectedClipKeys.size;
        if (!changed) {
            for (const k of next) {
                if (!__tlSelectedClipKeys.has(k)) { changed = true; break; }
            }
        }
        if (!changed) return;

        __tlSelectedClipKeys = next;
        _tlStopSelectedPlayback();
        _tlApplySelectedVisuals();
    }

    // ---- 更新自定义滚动条滑块 ----
    function _tlSbUpdate() {
        const wrap = _tlWrap();
        const sb = document.getElementById('tlScrollbar');
        const thumb = document.getElementById('tlScrollThumb');
        if (!wrap || !sb || !thumb) return;
        const hint = document.getElementById('tlEmptyHint');
        if (hint) hint.style.transform = `translateX(${wrap.scrollLeft}px)`;
        if (__tlZoom <= 1) {
            const thumbW = Math.max(10, wrap.clientWidth / __tlZoom);
            thumb.style.width = thumbW + 'px';
            thumb.style.left = '0px';
            sb.style.display = 'none';
        } else {
            sb.style.display = '';
            const thumbW = Math.max(10, wrap.clientWidth / __tlZoom);
            const sbW = sb.clientWidth;
            thumb.style.width = Math.min(thumbW, sbW) + 'px';
            const maxSL = wrap.scrollWidth - wrap.clientWidth;
            const scrollRatio = maxSL > 0 ? wrap.scrollLeft / maxSL : 0;
            const maxLeft = Math.max(0, sbW - Math.min(thumbW, sbW));
            thumb.style.left = (scrollRatio * maxLeft) + 'px';
        }
    }

    // ---- 跟随播放头自动滚动 ----
    function _tlFollowScroll(targetTime) {
        if (!__tlFollowPlayhead || __tlZoom <= 1 || __tlSbDragging || __tlDragging) return;
        if (Date.now() < __tlSuppressFollowUntil) return;
        const wrap = _tlWrap();
        const inner = _tlInner();
        const dur = _tlDur();
        if (!wrap || !inner || !dur) return;

        const innerW = inner.offsetWidth || inner.clientWidth || 0;
        const wrapW = wrap.clientWidth || 0;
        if (!innerW || !wrapW || innerW <= wrapW) return;

        const x = Math.max(0, Math.min(innerW, (targetTime / dur) * innerW));
        const maxSL = innerW - wrapW;
        const desired = Math.max(0, Math.min(maxSL, x - wrapW * 0.5));
        wrap.scrollLeft = desired;
    }

    // ---- 应用缩放（更新 inner 宽度 + 刷新标尺）----
    function _applyZoom() {
        const wrap = _tlWrap();
        const inner = _tlInner();
        if (!wrap || !inner) return;

        const wrapW = wrap.clientWidth;
        if (wrapW > 0) {
            inner.style.width = (wrapW * __tlZoom) + 'px';
        } else {
            inner.style.width = '100%';
        }

        // 同步挡位按钮高亮
        if (__tlZoomToggleBtn) {
            __tlZoomToggleBtn.textContent = (Number(__tlZoom) === 1 ? '全图' : `${__tlZoom}×`) + ' ▾';
        }
        document.querySelectorAll('.tl-dropdown-item[data-zoom]').forEach(b => {
            b.classList.toggle('active', Number(b.dataset.zoom) === __tlZoom);
        });

        // 延迟至下一帧再更新，确保 inner.offsetWidth 等布局值已生效（避免缩放时选区/手柄位置错位）
        requestAnimationFrame(() => {
            _tlUpdateHandles();
            _tlUpdateSelection();
            _tlUpdatePlayhead(undefined, { follow: false });
            _tlRerenderThumbStripByZoom();
            _tlRerenderWaveformByZoom();
            _tlSbUpdate();
        });
    }

    // ==================== 主渲染 ====================
    function renderTimeline() {
        const area = document.getElementById('timelineArea');
        if (!area) return;
        area.style.overflowAnchor = 'none';
        const dur = _tlDur();
        const canTimelineInteract = !!(currentVideoName && dur > 0 && __isVideoReady());
        const mediaKey = canTimelineInteract ? `${currentVideoName}__${Math.round(dur)}` : '';
        if (mediaKey !== __tlMediaResetKey) {
            _tlAbortWaveformLoading();
            __tlWaveformRenderToken += 1;
            __tlWaveformData = null;
            _tlAbortThumbLoading();
            __tlThumbRenderToken += 1;
            __tlThumbLastData = [];
            __tlThumbCache.clear();
            __tlMediaResetKey = mediaKey;
        }
        const zoomKey = canTimelineInteract ? `${currentVideoName}__${Math.round(dur)}` : '';
        if (zoomKey && zoomKey !== __tlZoomAutoAppliedKey) {
            __tlZoom = _tlAutoZoomByDuration(dur);
            __tlZoomAutoAppliedKey = zoomKey;
        }
        area.style.display = '';

        const flatAll = __flattenVideoTasksToClips();
        const prevScrollLeft = _tlWrap()?.scrollLeft || 0;
        const prevAreaHeight = area.offsetHeight;
        area.style.minHeight = prevAreaHeight + 'px';
        area.innerHTML = '';

        // 容器
        const ctn = document.createElement('div');
        ctn.className = 'timeline-container';

        // 标题行（含挡位按钮组）
        const title = document.createElement('div');
        title.className = 'timeline-container-title';
        if (mainLeftCtrlGroup) {
            mainLeftCtrlGroup.style.display = 'none';
        }

        const zoomGroup = document.createElement('span');
        zoomGroup.className = 'tl-dropdown';
        const zoomToggle = document.createElement('button');
        zoomToggle.className = 'tl-btn';
        zoomToggle.type = 'button';
        zoomToggle.textContent = (__tlZoom === 1 ? '全图' : `${__tlZoom}×`) + ' ▾';
        zoomToggle.title = '选择时间轴缩放倍率';
        zoomToggle.disabled = !canTimelineInteract;
        __tlZoomToggleBtn = zoomToggle;
        const zoomMenu = document.createElement('div');
        zoomMenu.className = 'tl-dropdown-menu';
        TL_ZOOM_LEVELS.forEach(z => {
            const btn = document.createElement('button');
            btn.className = 'tl-dropdown-item' + (z === __tlZoom ? ' active' : '');
            btn.dataset.zoom = z;
            btn.textContent = z === 1 ? '全图' : `${z}×`;
            btn.type = 'button';
            btn.disabled = !canTimelineInteract;
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                __tlZoom = z;
                _applyZoom();
                zoomGroup.classList.remove('open');
            });
            zoomMenu.appendChild(btn);
        });
        zoomToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!canTimelineInteract) return;
            // 关闭同级下拉菜单
            document.querySelectorAll('.tl-dropdown.open').forEach(dd => { if (dd !== zoomGroup) dd.classList.remove('open'); });
            zoomGroup.classList.toggle('open');
        });
        zoomGroup.appendChild(zoomToggle);
        zoomGroup.appendChild(zoomMenu);
        const followBtn = document.createElement('button');
        followBtn.className = 'tl-btn tl-follow-btn' + (__tlFollowPlayhead ? ' active' : '');
        followBtn.type = 'button';
        followBtn.textContent = '跟随播放';
        followBtn.title = '自动跟随播放指针滚动';
        followBtn.disabled = !canTimelineInteract;
        const thumbBtn = document.createElement('button');
        thumbBtn.className = 'tl-btn tl-thumb-btn' + (__tlThumbEnabled ? ' active' : '');
        thumbBtn.type = 'button';
        thumbBtn.textContent = '缩略图';
        thumbBtn.title = '显示/隐藏时间轴缩略图';
        thumbBtn.disabled = !canTimelineInteract;
        const waveformBtn = document.createElement('button');
        waveformBtn.className = 'tl-btn tl-waveform-btn' + (__tlWaveformEnabled ? ' active' : '');
        waveformBtn.type = 'button';
        waveformBtn.textContent = '波形';
        waveformBtn.title = '显示/隐藏音频波形';
        waveformBtn.disabled = !canTimelineInteract;

        const compactActionsGroup = document.createElement('span');
        compactActionsGroup.className = 'tl-dropdown tl-compact-actions';
        const compactActionsToggle = document.createElement('button');
        compactActionsToggle.className = 'tl-btn';
        compactActionsToggle.type = 'button';
        compactActionsToggle.textContent = '更多 ▾';
        compactActionsToggle.title = '更多时间轴操作';
        compactActionsToggle.disabled = !canTimelineInteract;
        const compactActionsMenu = document.createElement('div');
        compactActionsMenu.className = 'tl-dropdown-menu';
        const compactFollowItem = document.createElement('button');
        compactFollowItem.className = 'tl-dropdown-item';
        compactFollowItem.type = 'button';
        compactFollowItem.textContent = '跟随播放';
        compactFollowItem.disabled = !canTimelineInteract;
        const compactThumbItem = document.createElement('button');
        compactThumbItem.className = 'tl-dropdown-item';
        compactThumbItem.type = 'button';
        compactThumbItem.textContent = '缩略图';
        compactThumbItem.disabled = !canTimelineInteract;
        const compactWaveformItem = document.createElement('button');
        compactWaveformItem.className = 'tl-dropdown-item';
        compactWaveformItem.type = 'button';
        compactWaveformItem.textContent = '波形';
        compactWaveformItem.disabled = !canTimelineInteract;
        compactActionsMenu.appendChild(compactFollowItem);
        compactActionsMenu.appendChild(compactThumbItem);
        compactActionsMenu.appendChild(compactWaveformItem);
        compactActionsGroup.appendChild(compactActionsToggle);
        compactActionsGroup.appendChild(compactActionsMenu);

        function _syncFollowThumbWaveformState() {
            followBtn.classList.toggle('active', __tlFollowPlayhead);
            thumbBtn.classList.toggle('active', __tlThumbEnabled);
            waveformBtn.classList.toggle('active', __tlWaveformEnabled);
            compactFollowItem.classList.toggle('active', __tlFollowPlayhead);
            compactThumbItem.classList.toggle('active', __tlThumbEnabled);
            compactWaveformItem.classList.toggle('active', __tlWaveformEnabled);
        }

        function _toggleFollowPlayhead() {
            if (!canTimelineInteract) return;
            __tlFollowPlayhead = !__tlFollowPlayhead;
            _syncFollowThumbWaveformState();
            if (__tlFollowPlayhead) _tlFollowScroll(player.currentTime || 0);
        }

        followBtn.addEventListener('click', _toggleFollowPlayhead);
        compactFollowItem.addEventListener('click', (e) => {
            e.stopPropagation();
            _toggleFollowPlayhead();
            compactActionsGroup.classList.remove('open');
        });
        compactActionsToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!canTimelineInteract) return;
            compactActionsGroup.classList.toggle('open');
        });

        let _toggleThumb = null;
        let _toggleWaveform = null;
        thumbBtn.addEventListener('click', () => {
            if (_toggleThumb) _toggleThumb();
        });
        compactThumbItem.addEventListener('click', (e) => {
            e.stopPropagation();
            if (_toggleThumb) _toggleThumb();
            compactActionsGroup.classList.remove('open');
        });
        waveformBtn.addEventListener('click', () => {
            if (_toggleWaveform) _toggleWaveform();
        });
        compactWaveformItem.addEventListener('click', (e) => {
            e.stopPropagation();
            if (_toggleWaveform) _toggleWaveform();
            compactActionsGroup.classList.remove('open');
        });

        const jumpGroup = document.createElement('span');
        jumpGroup.className = '';
        const jumpButtons = [
            { text: '-5s', title: '后退5秒', click: __seekBack5 },
            { text: '-1s', title: '后退1秒', click: __seekBack1 },
            { text: '+1s', title: '前进1秒', click: __seekForward1 },
            { text: '+5s', title: '前进5秒', click: __seekForward5 }
        ];
        jumpButtons.forEach(item => {
            const btn = document.createElement('button');
            btn.className = 'tl-btn';
            btn.type = 'button';
            btn.textContent = item.text;
            btn.title = item.title;
            btn.disabled = !canTimelineInteract;
            btn.addEventListener('click', () => { item.click(); });
            jumpGroup.appendChild(btn);
        });
        const delSelectedBtn = document.createElement('button');
        delSelectedBtn.className = 'tl-btn';
        delSelectedBtn.type = 'button';
        delSelectedBtn.textContent = '删除所选';
        delSelectedBtn.title = '删除已选中的时间轴片段';
        delSelectedBtn.addEventListener('click', () => { _tlDeleteSelectedClips(); });
        __tlDeleteSelectedBtn = delSelectedBtn;

        // ========== 工具栏布局 ==========
        const barLeft = document.createElement('span');
        barLeft.className = 'tl-bar-left';
        if (backwardBtn) { backwardBtn.classList.add('tl-btn'); barLeft.appendChild(backwardBtn); }
        if (playPauseBtn) { playPauseBtn.classList.add('tl-btn'); barLeft.appendChild(playPauseBtn); }
        if (forwardBtn) { forwardBtn.classList.add('tl-btn'); barLeft.appendChild(forwardBtn); }
        if (timeDisplay) barLeft.appendChild(timeDisplay);

        const barCenter = document.createElement('span');
        barCenter.className = 'tl-bar-center';
        // 倍速
        if (speedSelectGroup) {
            barCenter.appendChild(speedSelectGroup);
        }
        // 缩放
        barCenter.appendChild(zoomGroup);

        // ---- 裁切控制按钮（动态创建，包在 clip-group 子容器里） ----
        const clipGroup = document.createElement('span');
        clipGroup.className = 'tl-clip-group';

        quickSetStartBtn = document.createElement('button');
        quickSetStartBtn.className = 'tl-btn tl-clip-mark';
        quickSetStartBtn.type = 'button';
        quickSetStartBtn.title = '设为起点 [Q]';
        quickSetStartBtn.disabled = !canTimelineInteract;
        const startLabel = document.createElement('span');
        startLabel.className = 'clip-ctrl-mark-label';
        startLabel.textContent = 'Start [Q]';
        ctrlStartDisp = document.createElement('span');
        ctrlStartDisp.className = 'clip-ctrl-mark-time';
        ctrlStartDisp.textContent = tempStart !== null ? formatTime(tempStart) : '--:--:--';
        quickSetStartBtn.appendChild(startLabel);
        quickSetStartBtn.appendChild(ctrlStartDisp);
        quickSetStartBtn.addEventListener('click', () => {
            if (!currentVideoName || !__isVideoReady()) return;
            const r = __getCurrentPlayTime(); const attempted = r.time; tempStartFrame = r.frame;

            // 若已设终点且起点晚于终点，则提示并不更新
            if (tempEnd !== null && attempted > tempEnd) {
                showToast('起点不能晚于终点，请先调整终点或重置起点', 'warning');
                return;
            }

        tempStart = attempted;
            updateClipInputs();
            showToast(`起点: ${formatTime(r.time)}`);

            // 如果已设终点，则自动尝试添加片段
            if (tempEnd !== null) {
                __doAddClip();
            }
        });
        clipGroup.appendChild(quickSetStartBtn);

        quickSetEndBtn = document.createElement('button');
        quickSetEndBtn.className = 'tl-btn tl-clip-mark';
        quickSetEndBtn.type = 'button';
        quickSetEndBtn.title = '设为终点并自动添加 [W]';
        quickSetEndBtn.disabled = !canTimelineInteract;
        const endLabel = document.createElement('span');
        endLabel.className = 'clip-ctrl-mark-label';
        endLabel.textContent = 'End [W]';
        ctrlEndDisp = document.createElement('span');
        ctrlEndDisp.className = 'clip-ctrl-mark-time';
        ctrlEndDisp.textContent = tempEnd !== null ? formatTime(tempEnd) : '--:--:--';
        quickSetEndBtn.appendChild(endLabel);
        quickSetEndBtn.appendChild(ctrlEndDisp);
        quickSetEndBtn.addEventListener('click', () => {
            if (!currentVideoName || !__isVideoReady()) return;
            if (tempStart === null) {
                showToast('请先设置起点', 'info');
                return;
            }
            const r = __getCurrentPlayTime(); const attempted = r.time; tempEndFrame = r.frame;

            // 若已设起点且终点早于起点，则提示并不更新
            if (attempted < tempStart) {
                showToast('终点不能早于起点，请先调整起点或重置终点', 'warning');
                return;
            }

            tempEnd = attempted;
            updateClipInputs();
            showToast(`终点: ${formatTime(r.time)}`);
            __doAddClip();
        });
        clipGroup.appendChild(quickSetEndBtn);

        quickPlayClipBtn = document.createElement('button');
        quickPlayClipBtn.className = 'tl-btn';
        quickPlayClipBtn.type = 'button';
        quickPlayClipBtn.textContent = '▶Play';
        quickPlayClipBtn.title = '预览选中片段 [P]';
        quickPlayClipBtn.disabled = !canTimelineInteract;
        quickPlayClipBtn.addEventListener('click', () => {
            triggerBtnFeedback(quickPlayClipBtn);
            if (!currentVideoName || !__isVideoReady()) return;
            if (typeof window.__tlTryPlaySelectedClips === 'function') window.__tlTryPlaySelectedClips();
        });
        clipGroup.appendChild(quickPlayClipBtn);
        barCenter.appendChild(clipGroup);

        // ---- D/J 导航按钮 —— 单独分组 ----
        const navGroup = document.createElement('span');
        navGroup.className = 'tl-anchor-group';

        const jumpStartBtn = document.createElement('button');
        jumpStartBtn.className = 'tl-btn';
        jumpStartBtn.type = 'button';
        jumpStartBtn.textContent = '⤒D';
        jumpStartBtn.title = '从起点播放（选中片段则用片段起点） [D]';
        jumpStartBtn.disabled = !canTimelineInteract;
        jumpStartBtn.addEventListener('click', () => {
            const sel = _tlGetSelectedClipsSorted();
            const t = sel.length > 0 ? sel[0].start : (tempStart !== null ? Number(tempStart) : null);
            if (t !== null && currentVideoName && __isVideoReady()) {
                try { __seekPrecise(t); player.play().catch(() => {}); } catch (err) { }
            } else {
                showToast('请先设置起点', 'info');
            }
        });
        navGroup.appendChild(jumpStartBtn);

        const jumpEndBtn = document.createElement('button');
        jumpEndBtn.className = 'tl-btn';
        jumpEndBtn.type = 'button';
        jumpEndBtn.textContent = '⤓J';
        jumpEndBtn.title = '从终点播放（选中片段则用片段终点） [J]';
        jumpEndBtn.disabled = !canTimelineInteract;
        jumpEndBtn.addEventListener('click', () => {
            const sel = _tlGetSelectedClipsSorted();
            const t = sel.length > 0 ? sel[sel.length - 1].end : (tempEnd !== null ? Number(tempEnd) : null);
            if (t !== null && currentVideoName && __isVideoReady()) {
                try { __seekPrecise(t); player.play().catch(() => {}); } catch (err) { }
            } else {
                showToast('请先设置终点', 'info');
            }
        });
        navGroup.appendChild(jumpEndBtn);
        barCenter.appendChild(navGroup);

        const barRight = document.createElement('span');
        barRight.className = 'tl-bar-right';
        // “更多”菜单（次要功能）
        const moreGroup = document.createElement('span');
        moreGroup.className = 'tl-dropdown tl-dropdown-right';
        const moreToggle = document.createElement('button');
        moreToggle.className = 'tl-btn';
        moreToggle.type = 'button';
        moreToggle.textContent = '•••';
        moreToggle.title = '更多操作';
        moreToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            // 关闭同级下拉菜单
            document.querySelectorAll('.tl-dropdown.open').forEach(dd => { if (dd !== moreGroup) dd.classList.remove('open'); });
            moreGroup.classList.toggle('open');
        });
        const moreMenu = document.createElement('div');
        moreMenu.className = 'tl-dropdown-menu';

        // “更多”菜单项
        const moreItems = [
            { label: '跟随播放', active: __tlFollowPlayhead, click: () => { _toggleFollowPlayhead(); } },
            { label: '缩略图',   active: __tlThumbEnabled,     click: () => { if (_toggleThumb) _toggleThumb(); } },
            { label: '波形',     active: __tlWaveformEnabled,  click: () => { if (_toggleWaveform) _toggleWaveform(); } },
            'sep',
            { label: '删除所选',  click: () => { _tlDeleteSelectedClips(); }, ref: 'delSelected' }
        ];

        const __moreMenuItemEls = {};
        moreItems.forEach(item => {
            if (item === 'sep') {
                const sep = document.createElement('div');
                sep.className = 'tl-dropdown-sep';
                moreMenu.appendChild(sep);
                return;
            }
            const btn = document.createElement('button');
            btn.className = 'tl-dropdown-item' + (item.active ? ' active' : '');
            btn.type = 'button';
            btn.textContent = item.label;
            btn.disabled = !canTimelineInteract;
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                item.click();
                // toggle类菜单项刷新状态而不关闭
                if (['跟随播放','缩略图','波形'].includes(item.label)) {
                    _syncMoreMenuState();
                } else {
                    moreGroup.classList.remove('open');
                }
            });
            if (item.ref) __moreMenuItemEls[item.ref] = btn;
            if (['跟随播放','缩略图','波形'].includes(item.label)) __moreMenuItemEls[item.label] = btn;
            moreMenu.appendChild(btn);
        });

        function _syncMoreMenuState() {
            if (__moreMenuItemEls['跟随播放']) __moreMenuItemEls['跟随播放'].classList.toggle('active', __tlFollowPlayhead);
            if (__moreMenuItemEls['缩略图']) __moreMenuItemEls['缩略图'].classList.toggle('active', __tlThumbEnabled);
            if (__moreMenuItemEls['波形']) __moreMenuItemEls['波形'].classList.toggle('active', __tlWaveformEnabled);
        }

        // 替换原来的 _syncFollowThumbWaveformState
        const _origSync = _syncFollowThumbWaveformState;
        _syncFollowThumbWaveformState = function() {
            _origSync();
            _syncMoreMenuState();
        };

        // delSelectedBtn 引用转移到菜单项
        __tlDeleteSelectedBtn = __moreMenuItemEls.delSelected || delSelectedBtn;

        moreGroup.appendChild(moreToggle);
        moreGroup.appendChild(moreMenu);
        barRight.appendChild(moreGroup);

        if (openFileTreeBtnMain) { openFileTreeBtnMain.classList.add('tl-btn'); barRight.appendChild(openFileTreeBtnMain); }
        if (fullscreenBtn) { fullscreenBtn.classList.add('tl-btn'); barRight.appendChild(fullscreenBtn); }

        title.appendChild(barLeft);
        title.appendChild(barCenter);
        title.appendChild(barRight);

        // 动态检测工具栏溢出，自动切换布局
        let _tlRafId = 0;
        let _tlCheckWrapScheduled = false;
        function _tlCheckWrap() {
            // 还原：把 right 移回 title
            if (barRight.parentNode !== title) {
                title.appendChild(barRight);
                barCenter.classList.remove('tl-right-merged');
            }
            title.classList.remove('tl-wrapped');

            const centerOverflows = barCenter.scrollWidth > barCenter.clientWidth + 1;
            if (!centerOverflows) return;

            title.classList.add('tl-wrapped');

            // 检查中间栏是否内部换行（高度超过单行）
            const firstBtn = barCenter.querySelector('.tl-btn');
            const singleRowH = firstBtn ? firstBtn.offsetHeight : 24;
            const centerWrapsInternally = barCenter.offsetHeight > singleRowH * 1.5;

            if (centerWrapsInternally) {
                // 把 right 移入 center，用 CSS order 插到 speed+zoom 后、QWCP 前
                barCenter.appendChild(barRight);
                barCenter.classList.add('tl-right-merged');
            }
        }

        function _tlCheckWrapScheduledRaf() {
            if (_tlCheckWrapScheduled) return;
            _tlCheckWrapScheduled = true;
            cancelAnimationFrame(_tlRafId);
            _tlRafId = requestAnimationFrame(() => {
                _tlCheckWrapScheduled = false;
                _tlCheckWrap();
            });
        }

        if (__tlResizeObserver) {
            try { __tlResizeObserver.disconnect(); } catch (e) { }
            __tlResizeObserver = null;
        }
        __tlResizeObserver = new ResizeObserver(_tlCheckWrapScheduledRaf);
        __tlResizeObserver.observe(title);
        // 初始检查
        _tlCheckWrapScheduledRaf();

        // 全局点击关闭所有下拉菜单
        title.addEventListener('click', (e) => {
            title.querySelectorAll('.tl-dropdown.open').forEach(dd => {
                if (!dd.contains(e.target)) dd.classList.remove('open');
            });
        });

        // 下拉菜单打开时动态限制 max-height 不超出预览区域
        function _capDropdownHeight(dropdown) {
            const menu = dropdown.querySelector('.tl-dropdown-menu');
            if (!menu) return;
            menu.style.maxHeight = '';
            requestAnimationFrame(() => {
                const boundary = dropdown.closest('.preview-panel') || dropdown.closest('#playerWrapper') || document.documentElement;
                const boundaryRect = boundary.getBoundingClientRect();
                const menuRect = menu.getBoundingClientRect();
                const topLimit = boundaryRect.top + 4;
                if (menuRect.top < topLimit) {
                    const cap = Math.max(60, menuRect.bottom - topLimit);
                    menu.style.maxHeight = cap + 'px';
                }
            });
        }

        // 监听所有 dropdown 的 open 变化
        const _ddObserver = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (m.type === 'attributes' && m.attributeName === 'class') {
                    const dd = m.target;
                    if (dd.classList.contains('tl-dropdown') && dd.classList.contains('open')) {
                        _capDropdownHeight(dd);
                    }
                }
            }
        });
        title.querySelectorAll('.tl-dropdown').forEach(dd => {
            _ddObserver.observe(dd, { attributes: true, attributeFilter: ['class'] });
        });

        ctn.appendChild(title);

        // wrap（可视窗口，overflow:hidden，scrollLeft 控制平移）
        const wrap = document.createElement('div');
        wrap.className = 'timeline-wrap';
        wrap.id = 'tlWrap';
        wrap.style.overflowX = 'hidden';
        wrap.style.position = 'relative';

        // inner（实际内容宽度 = wrap宽 × zoom）
        const inner = document.createElement('div');
        inner.className = 'timeline-inner';
        inner.id = 'tlInner';
        inner.style.position = 'relative';
        inner.style.width = '100%'; // 初始为 100%，_applyZoom 会更新

        const track = document.createElement('div');
        track.className = 'timeline-track';
        track.classList.toggle('has-thumbs', !!__tlThumbEnabled);
        const thumbsStrip = document.createElement('div');
        thumbsStrip.className = 'timeline-thumbs';
        __tlThumbLastStrip = thumbsStrip;
        __tlThumbLastDur = dur;
        __tlThumbLastData = [];
        __tlThumbLastStep = 0;
        track.appendChild(thumbsStrip);
        _tlRenderThumbStrip(thumbsStrip, dur, [], _tlCalcThumbStep());

        // ---- 波形 canvas ----
        const waveformCanvas = document.createElement('canvas');
        waveformCanvas.className = 'timeline-waveform';
        waveformCanvas.style.display = __tlWaveformEnabled ? '' : 'none';
        __tlWaveformCanvas = waveformCanvas;
        track.appendChild(waveformCanvas);
        track.classList.toggle('has-waveform', !!__tlWaveformEnabled);
        if (__tlWaveformEnabled && __tlWaveformData && Array.isArray(__tlWaveformData.peaks)) {
            requestAnimationFrame(() => {
                if (waveformCanvas.isConnected && __tlWaveformEnabled) {
                    _tlRenderWaveformCanvas(waveformCanvas, __tlWaveformData.peaks);
                }
            });
        }

        _toggleThumb = () => {
            if (!canTimelineInteract) return;
            __tlThumbEnabled = !__tlThumbEnabled;
            // 互斥：开启缩略图时关闭波形
            if (__tlThumbEnabled && __tlWaveformEnabled) {
                __tlWaveformEnabled = false;
                waveformCanvas.style.display = 'none';
                track.classList.remove('has-waveform');
                _tlAbortWaveformLoading();
                __tlWaveformRenderToken += 1;
                __tlWaveformData = null;
            }
            try { track.classList.toggle('has-thumbs', !!__tlThumbEnabled); } catch (e) { }
            _syncFollowThumbWaveformState();
            // when enabling, hide existing empty hint; re-show when disabling if needed
            const hintEl = document.getElementById('tlEmptyHint');
            if (hintEl) {
                hintEl.style.display = __tlThumbEnabled ? 'none' : '';
            }
            if (!__tlThumbEnabled) {
                _tlAbortThumbLoading();
                __tlThumbRenderToken += 1;
                __tlThumbLastData = [];
                __tlThumbLastStep = 0;
                _tlRenderThumbStrip(thumbsStrip, dur, [], _tlCalcThumbStep());
                return;
            }
            if (!(currentVideoName && dur > 0 && __isVideoReady())) return;
            const myToken = ++__tlThumbRenderToken;
            const ctrl = _tlBeginThumbLoading();
            const thumbStep = _tlCalcThumbStep();
            _tlEnsureThumbs(thumbStep, (partialThumbs) => {
                if (myToken !== __tlThumbRenderToken) return;
                if (!thumbsStrip.isConnected) return;
                if (!__tlThumbEnabled) return;
                __tlThumbLastDur = dur;
                __tlThumbLastData = partialThumbs;
                __tlThumbLastStep = thumbStep;
                _tlRenderThumbStrip(thumbsStrip, dur, partialThumbs, thumbStep);
            }, ctrl.signal).then(thumbs => {
                if (myToken !== __tlThumbRenderToken) return;
                if (!thumbsStrip.isConnected) return;
                if (!__tlThumbEnabled) return;
                __tlThumbLastDur = dur;
                __tlThumbLastData = thumbs;
                __tlThumbLastStep = thumbStep;
                _tlRenderThumbStrip(thumbsStrip, dur, thumbs, thumbStep);
            }).catch(() => { });
        };
        _syncFollowThumbWaveformState();

        // ---- 波形开关 ----
        _toggleWaveform = () => {
            if (!canTimelineInteract) return;
            __tlWaveformEnabled = !__tlWaveformEnabled;
            // 互斥：开启波形时关闭缩略图
            if (__tlWaveformEnabled && __tlThumbEnabled) {
                __tlThumbEnabled = false;
                track.classList.remove('has-thumbs');
                _tlAbortThumbLoading();
                __tlThumbRenderToken += 1;
                __tlThumbLastData = [];
                _tlRenderThumbStrip(thumbsStrip, dur, [], _tlCalcThumbStep());
                const hintEl = document.getElementById('tlEmptyHint');
                if (hintEl) hintEl.style.display = '';
            }
            waveformCanvas.style.display = __tlWaveformEnabled ? '' : 'none';
            track.classList.toggle('has-waveform', !!__tlWaveformEnabled);
            _syncFollowThumbWaveformState();
            if (!__tlWaveformEnabled) {
                _tlAbortWaveformLoading();
                __tlWaveformRenderToken += 1;
                __tlWaveformData = null;
                return;
            }
            if (!(currentVideoName && dur > 0 && __isVideoReady())) return;
            const myToken = ++__tlWaveformRenderToken;
            __tlWaveformAbortController = new AbortController();
            _tlFetchWaveform(__tlWaveformAbortController.signal).then(data => {
                if (myToken !== __tlWaveformRenderToken) return;
                if (!waveformCanvas.isConnected) return;
                if (!__tlWaveformEnabled) return;
                if (data && Array.isArray(data.peaks)) {
                    __tlWaveformData = data;
                    _tlRenderWaveformCanvas(waveformCanvas, data.peaks);
                }
            }).catch(() => { });
        };

        // 如果波形已启用，自动加载
        if (__tlWaveformEnabled && currentVideoName && dur > 0 && __isVideoReady()) {
            const myToken = ++__tlWaveformRenderToken;
            __tlWaveformAbortController = new AbortController();
            _tlFetchWaveform(__tlWaveformAbortController.signal).then(data => {
                if (myToken !== __tlWaveformRenderToken) return;
                if (!waveformCanvas.isConnected) return;
                if (!__tlWaveformEnabled) return;
                if (data && Array.isArray(data.peaks)) {
                    __tlWaveformData = data;
                    _tlRenderWaveformCanvas(waveformCanvas, data.peaks);
                }
            }).catch(() => { });
        }

        __tlRenderedClips = [];

        const emptyHintText = (!currentVideoName || !dur)
            ? '请先选择视频并点击预览'
            : ((flatAll.length === 0 && !__tlThumbEnabled) ? '按 Q 设起点，按 W 自动添加片段' : '');

        // 片段色块
        const validKeys = new Set();

        let clipColorIndex = 0;
        for (const task of (videoTasks || [])) {
            const clips = task.clips || [];
            for (let ci = 0; ci < clips.length; ci++) {
                if (!dur) continue;
                const c = clips[ci];
                const lp = c.start / dur * 100;
                const wp = Math.max((c.end - c.start) / dur * 100, 0);
                const clipKey = _tlClipKey(task.name, c, ci);
                const clipColor = TL_CLIP_COLOR_RGBS[clipColorIndex % TL_CLIP_COLOR_RGBS.length];
                clipColorIndex += 1;
                validKeys.add(clipKey);
                const el = document.createElement('div');
                el.className = 'timeline-clip' + (__tlSelectedClipKeys.has(clipKey) ? ' selected' : '');
                el.style.left = lp + '%';
                el.style.width = wp + '%';
                el.style.setProperty('--tl-clip-rgb', clipColor);
                __tlRenderedClips.push({ key: clipKey, el });

                el.addEventListener('mouseenter', e => {
                    const d = Math.max(0, c.end - c.start);
                    _showTip(`<div>起点：${_tlFmtFull(c.start)}</div><div>终点：${_tlFmtFull(c.end)}</div><div>时长：${_tlFmtFull(d)}</div>`,
                        e.clientX, e.clientY);
                });
                el.addEventListener('mousemove', e => {
                    const d = Math.max(0, c.end - c.start);
                    _showTip(`<div>起点：${_tlFmtFull(c.start)}</div><div>终点：${_tlFmtFull(c.end)}</div><div>时长：${_tlFmtFull(d)}</div>`,
                        e.clientX, e.clientY);
                });
                el.addEventListener('mouseleave', _hideTip);
                el.addEventListener('click', ev => {
                    ev.stopPropagation();
                    if (__tlSelectedPlayback && __tlSelectedClipKeys.has(clipKey)) {
                        const clips = _tlGetSelectedClipsSorted();
                        const targetIdx = clips.findIndex(x => x.key === clipKey);
                        if (targetIdx !== -1) {
                            __tlSelectedPlayback = { clips, index: targetIdx };
                            try {
                                __seekPrecise(clips[targetIdx].start);
                                if (player.paused) player.play().catch(() => { });
                            } catch (e) { }
                            return;
                        }
                    }
                    if (__tlSelectedClipKeys.has(clipKey)) {
                        __tlSelectedClipKeys.delete(clipKey);
                        el.classList.remove('selected');
                    } else {
                        __tlSelectedClipKeys.add(clipKey);
                        el.classList.add('selected');
                    }
                    _tlStopSelectedPlayback();
                    _tlRefreshDeleteSelectedBtn();
                });
                track.appendChild(el);
            }
        }

        __tlSelectedClipKeys = new Set([...__tlSelectedClipKeys].filter(k => validKeys.has(k)));
        if (__tlSelectedClipKeys.size === 0) _tlStopSelectedPlayback();
        _tlRefreshDeleteSelectedBtn();

        if (__tlThumbEnabled && currentVideoName && dur > 0 && __isVideoReady()) {
            const myToken = ++__tlThumbRenderToken;
            const ctrl = _tlBeginThumbLoading();
            const thumbStep = _tlCalcThumbStep();
            _tlEnsureThumbs(thumbStep, (partialThumbs) => {
                if (myToken !== __tlThumbRenderToken) return;
                if (!thumbsStrip.isConnected) return;
                if (!__tlThumbEnabled) return;
                __tlThumbLastDur = dur;
                __tlThumbLastData = partialThumbs;
                __tlThumbLastStep = thumbStep;
                _tlRenderThumbStrip(thumbsStrip, dur, partialThumbs, thumbStep);
            }, ctrl.signal).then(thumbs => {
                if (myToken !== __tlThumbRenderToken) return;
                if (!thumbsStrip.isConnected) return;
                if (!__tlThumbEnabled) return;
                __tlThumbLastDur = dur;
                __tlThumbLastData = thumbs;
                __tlThumbLastStep = thumbStep;
                _tlRenderThumbStrip(thumbsStrip, dur, thumbs, thumbStep);
            }).catch(() => { });
        }

        // 播放头
        const ph = document.createElement('div');
        ph.className = 'timeline-playhead';
        ph.id = 'tlPlayhead';
        ph.style.left = '0%';
        track.appendChild(ph);
        // arrows placed alongside so we can manually sync position
        const arrowTop = document.createElement('div');
        arrowTop.className = 'timeline-playhead-arrow-top';
        arrowTop.id = 'tlPlayheadArrowTop';
        const arrowBottom = document.createElement('div');
        arrowBottom.className = 'timeline-playhead-arrow-bottom';
        arrowBottom.id = 'tlPlayheadArrowBottom';
        track.appendChild(arrowTop);
        track.appendChild(arrowBottom);

        // 时间游标（hover）
        const cur = document.createElement('div');
        cur.className = 'timeline-time-cursor';
        cur.id = 'tlTimeCursor';
        cur.style.display = 'none';
        track.appendChild(cur);

        // 播放头顶部箭头支持拖拽定位（剪映风格）
        arrowTop.style.pointerEvents = 'all';
        arrowTop.style.cursor = 'ew-resize';
        arrowTop.addEventListener('mousedown', e => {
            e.stopPropagation();
            e.preventDefault();
            if (!canTimelineInteract) return;
            __tlPlayheadDragging = true;
            ph.classList.add('dragging');
            document.body.style.userSelect = 'none';
            // 拖拽时暂停播放
            try { if (!player.paused) player.pause(); } catch (err) { }
        });

        // Q 手柄（起点）
        const hStart = _makeHandle('start', 'Q');
        hStart.id = 'tlHandleStart';
        track.appendChild(hStart);

        // W 手柄（终点）
        const hEnd = _makeHandle('end', 'W');
        hEnd.id = 'tlHandleEnd';
        track.appendChild(hEnd);

        inner.appendChild(track);
        wrap.appendChild(inner);
        ctn.appendChild(wrap);

        // ---- 自定义滚动条 ----
        const sb = document.createElement('div');
        sb.className = 'tl-scrollbar';
        sb.id = 'tlScrollbar';
        sb.style.display = 'none'; // 1× 时隐藏
        const sbThumb = document.createElement('div');
        sbThumb.className = 'tl-scrollbar-thumb';
        sbThumb.id = 'tlScrollThumb';
        sb.appendChild(sbThumb);
        ctn.appendChild(sb);
        area.appendChild(ctn);

        // ---- 滚动条拖拽 ----
        sbThumb.addEventListener('mousedown', e => {
            e.preventDefault();
            __tlSbDragging = true;
            __tlSbStartX = e.clientX;
            __tlSbStartSL = wrap.scrollLeft;
            _tlMaybeShowFollowSbHint();
            document.body.style.userSelect = 'none';
        });
        sbThumb.addEventListener('touchstart', e => {
            // 触摸拖拽滚动条
            __tlSbDragging = true;
            __tlSbStartX = e.touches[0]?.clientX || 0;
            __tlSbStartSL = wrap.scrollLeft;
            _tlMaybeShowFollowSbHint();
        }, { passive: true });

        // 点击滚动槽（非滑块）：跳转
        sb.addEventListener('click', e => {
            if (e.target === sbThumb) return;
            _tlMaybeShowFollowSbHint();
            const rect = sb.getBoundingClientRect();
            const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / sb.clientWidth));
            const maxSL = wrap.scrollWidth - wrap.clientWidth;
            wrap.scrollLeft = ratio * maxSL;
            _tlSbUpdate();
        });
        // 同步 wrap 滚动 → 更新滑块
        wrap.addEventListener('scroll', _tlSbUpdate);

        // ---- 同步设置 inner 宽度并恢复滚动位置（避免闪烁）----
        const wrapW = wrap.clientWidth;
        if (wrapW > 0) {
            inner.style.width = (wrapW * __tlZoom) + 'px';
        }
        if (prevScrollLeft > 0) wrap.scrollLeft = prevScrollLeft;

        // ---- 应用当前缩放（构建标尺 + 更新宽度）----
        requestAnimationFrame(() => {
            _applyZoom();
            _tlUpdatePlayhead(undefined, { follow: false });
            _tlUpdateHandles();
            _tlUpdateSelection();
            _tlCheckWrap();
            requestAnimationFrame(() => { area.style.minHeight = ''; });
        });

        // （滚轮 / 中键平移已移除，改用挡位按钮 + 自定义滚动条）

        // ---- 交互：点击时间轴移动播放头 ----
        wrap.addEventListener('click', e => {
            zoomGroup.classList.remove('open');
            if (__tlSuppressWrapClick) { __tlSuppressWrapClick = false; return; }
            if (e.target.closest('.timeline-handle') || e.target.closest('.timeline-clip') || e.target.closest('.timeline-playhead-arrow-top')) return;
            if (!canTimelineInteract) return;
            const innerX = _tlClientToInnerX(e.clientX);
            const t = _tlXToTime(innerX);
            try {
                player.pause();
                __seekPrecise(t);
            } catch (err) { }
        });

        // ---- 交互：hover 时间游标 ----
        wrap.addEventListener('mousemove', e => {
            if (!currentVideoName || !_tlDur() || !__isVideoReady()) {
                const curEl = document.getElementById('tlTimeCursor');
                if (curEl) curEl.style.display = 'none';
                _hideTip();
                return;
            }
            if (e.target.closest('.timeline-clip')) return;
            const innerX = _tlClientToInnerX(e.clientX);
            const pct = Math.max(0, Math.min(1, innerX / (inner.offsetWidth || 1)));
            const curEl = document.getElementById('tlTimeCursor');
            if (curEl) { curEl.style.left = (pct * 100) + '%'; curEl.style.display = ''; }
            if (!__tlDragging) _showTip(`<div>${_tlFmtFull(pct * _tlDur())}</div>`, e.clientX, e.clientY);
        });

        wrap.addEventListener('mouseleave', () => {
            const curEl = document.getElementById('tlTimeCursor');
            if (curEl) curEl.style.display = 'none';
            _hideTip();
        });

        // 保存轨道引用供拖拽使用
        __tlDragTrackEl = inner;

        // 联动更新主进度条视觉（显示片段色块）
        if (typeof updateProgress === 'function') updateProgress(player.currentTime, player.duration);
    }

    // ---- 构造手柄 DOM ----
    function _makeHandle(type, key) {
        const h = document.createElement('div');
        h.className = `timeline-handle timeline-handle-${type}`;
        h.style.left = '-100px';
        h.style.pointerEvents = 'none';
        h.innerHTML = `
            <div class="timeline-handle-line"></div>
            <div class="timeline-handle-cap">
                <div class="timeline-handle-arrow"></div>
                <div class="timeline-handle-key">${key}</div>
            </div>`;
        return h;
    }

    // ---- 全局 mousemove（播放头拖拽 + 锚点拖拽 + 手柄拖拽 + 平移结束）----
    document.addEventListener('mousemove', e => {
        // 关闭框选功能：即使 __tlBoxSelecting 为 true，也不做处理
        // 播放头拖拽（剪映风格 scrub）
        if (__tlPlayheadDragging) {
            const inner = _tlInner() || __tlDragTrackEl;
            if (!inner) return;
            const rect = inner.getBoundingClientRect();
            const dur = _tlDur();
            if (!dur) return;
            const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            const t = pct * dur;
            try { __seekPrecise(t); } catch (err) { }
            _showTip(`<div>${_tlFmtFull(t)}</div>`, e.clientX, e.clientY);
            return;
        }
        // 手柄拖拽
        if (__tlDragging) {
            const inner = _tlInner() || __tlDragTrackEl;
            if (!inner) return;
            const rect = inner.getBoundingClientRect();
            const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            const t = pct * __tlDragDuration;
            if (__tlDragging === 'start') {
                _applyStart(t);
                _showTip(`Start: ${_tlFmtFull(t)}`, e.clientX, e.clientY);
            } else {
                _applyEnd(t);
                _showTip(`End: ${_tlFmtFull(t)}`, e.clientX, e.clientY);
            }
            _tlUpdateHandles();
            _tlUpdateSelection();
            return;
        }
        // 滚动条拖拽
        if (__tlSbDragging) {
            const sb = document.getElementById('tlScrollbar');
            const wrap = _tlWrap();
            if (!sb || !wrap) return;
            const rect = sb.getBoundingClientRect();
            const thumbW = Math.max(10, wrap.clientWidth / __tlZoom);
            const maxL = sb.clientWidth - thumbW;
            if (maxL <= 0) return;

            const deltaX = e.clientX - __tlSbStartX;
            let newL = ((__tlSbStartSL / (wrap.scrollWidth - wrap.clientWidth)) * maxL) + deltaX;
            // 因为 scrollBar 逻辑稍微复杂点，换个思路：直接计算偏移比例
            const moveRatio = deltaX / maxL;
            const maxSL = wrap.scrollWidth - wrap.clientWidth;
            wrap.scrollLeft = __tlSbStartSL + moveRatio * maxSL;
            _tlSbUpdate();
        }
    });

    document.addEventListener('mouseup', e => {
        // 框选模式已关闭，直接处理拖拽结束
        if (__tlDragging) {
            const cls = `timeline-handle-${__tlDragging}`;
            document.querySelector(`.${cls}`)?.classList.remove('dragging');
            __tlDragging = null;
            document.body.style.userSelect = '';
            _hideTip();
        }
        if (__tlPlayheadDragging) {
            __tlPlayheadDragging = false;
            const ph = document.getElementById('tlPlayhead');
            if (ph) ph.classList.remove('dragging');
            document.body.style.userSelect = '';
            _hideTip();
        }
        if (__tlSbDragging) {
            __tlSbDragging = false;
            document.body.style.userSelect = '';
        }
    });

    document.addEventListener('touchmove', e => {
        if (!__tlSbDragging) return;
        e.preventDefault();
        const sb = document.getElementById('tlScrollbar');
        const wrap = _tlWrap();
        if (!sb || !wrap) return;
        const rect = sb.getBoundingClientRect();
        const thumbW = Math.max(10, wrap.clientWidth / __tlZoom);
        const maxL = sb.clientWidth - thumbW;
        if (maxL <= 0) return;

        const touch = e.touches[0];
        const deltaX = (touch?.clientX || 0) - __tlSbStartX;
        const moveRatio = deltaX / maxL;
        const maxSL = wrap.scrollWidth - wrap.clientWidth;
        wrap.scrollLeft = __tlSbStartSL + moveRatio * maxSL;
        _tlSbUpdate();
    });

    document.addEventListener('touchend', () => {
        if (__tlSbDragging) {
            __tlSbDragging = false;
        }
        if (!__tlDragging) return;
        const cls = `timeline-handle-${__tlDragging}`;
        document.querySelector(`.${cls}`)?.classList.remove('dragging');
        __tlDragging = null;
        _hideTip();
    });

    // ---- 更新手柄位置（基于 inner 宽度）----
    function _tlUpdateHandles() {
        const dur = _tlDur();
        const hs = document.getElementById('tlHandleStart');
        const he = document.getElementById('tlHandleEnd');
        if (!dur || !currentVideoName || !__isVideoReady()) {
            if (hs) hs.style.left = '-100px';
            if (he) he.style.left = '-100px';
            return;
        }
        const ts = _getTS();
        const te = _getTE();
        if (hs) hs.style.left = (ts !== null) ? (ts / dur * 100) + '%' : '-100px';
        if (he) he.style.left = (te !== null) ? (te / dur * 100) + '%' : '-100px';
    }

    // ---- 更新选区 ----
    function _tlUpdateSelection() {
        // 选区框已被移除，不再渲染
    }

    // ---- 更新播放头 ----
    function _tlUpdatePlayhead(time, options = {}) {
        const ph = document.getElementById('tlPlayhead'); if (!ph) return;
        const arrowTopEl = document.getElementById('tlPlayheadArrowTop');
        const arrowBottomEl = document.getElementById('tlPlayheadArrowBottom');
        const dur = _tlDur();
        if (!dur || !currentVideoName || !__isVideoReady()) {
            ph.style.display = 'none';
            if (arrowTopEl) arrowTopEl.style.display = 'none';
            if (arrowBottomEl) arrowBottomEl.style.display = 'none';
            return;
        }
        ph.style.display = '';
        if (arrowTopEl) arrowTopEl.style.display = '';
        if (arrowBottomEl) arrowBottomEl.style.display = '';
        const target = (typeof time === 'number') ? time : (player.currentTime || 0);
        const pct = (Math.max(0, Math.min(1, target / dur)) * 100) + '%';
        try {
            ph.style.left = pct;
            if (arrowTopEl) arrowTopEl.style.left = pct;
            if (arrowBottomEl) arrowBottomEl.style.left = pct;
        } catch (e) { }
        if (!options || options.follow !== false) {
            _tlFollowScroll(target);
        }
    }

    // ---- 播放头动画 ----
    function _startLoop() {
        if (__tlTimerAF) return;
        (function tick() {
            _tlUpdatePlayhead();
            _tlHandleSelectedPlayback();
            // 在动画循环中同步更新播放器主进度条，确保其与时间轴播放头完全平滑同步
            if (!__tlDragging && typeof isDragging !== 'undefined' && !isDragging && typeof updateProgress === 'function') {
                if (typeof progressBar !== 'undefined' && progressBar) {
                    progressBar.value = player.currentTime || 0;
                    updateProgress(player.currentTime, player.duration);
                }
            }
            __tlTimerAF = requestAnimationFrame(tick);
        })();
    }
    function _stopLoop() { if (__tlTimerAF) { cancelAnimationFrame(__tlTimerAF); __tlTimerAF = null; } }

    // ---- 播放器事件 ----
    try {
        player.addEventListener('play', _startLoop);
        player.addEventListener('pause', () => { _stopLoop(); _tlUpdatePlayhead(); });
        player.addEventListener('ended', () => { _stopLoop(); _tlUpdatePlayhead(); });
        player.addEventListener('seeked', _tlUpdatePlayhead);
        player.addEventListener('timeupdate', () => { if (player.paused) _tlUpdatePlayhead(); });
        player.addEventListener('loadedmetadata', renderTimeline);
    } catch (e) { }

    // ---- MutationObserver：片段列表变化 → 刷新时间轴 ----
    let __tlDebounce = null;
    let __tlSuppressNextObserverRefresh = false;
    function _scheduleRefresh() {
        if (__tlSuppressNextObserverRefresh) {
            __tlSuppressNextObserverRefresh = false;
            return;
        }
        if (__tlDebounce) return;
        __tlDebounce = setTimeout(() => { __tlDebounce = null; try { renderTimeline(); } catch (e) { } }, 60);
    }
    try {
        const clipListEl = document.getElementById('clipListModalBody');
        if (clipListEl) new MutationObserver(_scheduleRefresh).observe(clipListEl, { childList: true, subtree: true });
    } catch (e) { }

    // ---- MutationObserver：起终点变化 → 更新手柄 ----
    // 初始渲染
    try { renderTimeline(); } catch (e) { }

    // 暴露
    window.__tlRenderTimeline = renderTimeline;
    window.__tlUpdateSelection = _tlUpdateSelection;
    window.__tlUpdateHandles = _tlUpdateHandles;
    window.__tlUpdatePlayhead = _tlUpdatePlayhead;
    window.__tlTryPlaySelectedClips = _tlTryPlaySelectedClips;
    window.__tlGetSelectedClipsSorted = _tlGetSelectedClipsSorted;
    window.__tlSelectOnlyClip = function (taskName, clip, clipIndex) {
        const key = _tlClipKey(taskName, clip, clipIndex);
        __tlSelectedClipKeys = new Set([key]);
        _tlApplySelectedVisuals();
    };
    window.__tlDeselectAllClips = function () {
        __tlSelectedClipKeys = new Set();
        _tlStopSelectedPlayback();
        _tlApplySelectedVisuals();
    };
    window.__tlSuppressAutoFollow = function (ms) {
        const hold = Math.max(0, Number(ms) || 0);
        __tlSuppressFollowUntil = Date.now() + hold;
    };
    window.__tlSuppressObserverFlush = function () {
        __tlSuppressNextObserverRefresh = true;
        if (__tlDebounce) { clearTimeout(__tlDebounce); __tlDebounce = null; }
    };

})();
