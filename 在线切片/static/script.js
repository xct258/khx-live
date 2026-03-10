let currentVideoName = '';
let currentTreePath = ''; // 当前文件树路径（用于“进入文件夹”模式）

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

// 合并顺序覆盖（用于“预览队列拖拽排序”后，提交时按该顺序合并）
let __mergeOrderOverride = null; // [{name,start,end}]
function __invalidateMergeOrderOverride() {
    __mergeOrderOverride = null;
}

function __clipKey(name, start, end) {
    return `${String(name)}|${Number(start)}|${Number(end)}`;
}

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

function __isMergeOrderOverrideValid() {
    if (!Array.isArray(__mergeOrderOverride)) return false;
    const current = __flattenVideoTasksToClips();
    if (__mergeOrderOverride.length !== current.length) return false;

    const counts = new Map();
    for (const c of current) {
        const k = __clipKey(c.name, c.start, c.end);
        counts.set(k, (counts.get(k) || 0) + 1);
    }
    for (const c of __mergeOrderOverride) {
        const name = String(c?.name || '').trim();
        const start = Number(c?.start);
        const end = Number(c?.end);
        if (!name || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;
        const k = __clipKey(name, start, end);
        const left = (counts.get(k) || 0) - 1;
        if (left < 0) return false;
        if (left === 0) counts.delete(k);
        else counts.set(k, left);
    }
    return true;
}

function __buildVideoTasksFromFlatClips(flat) {
    const list = Array.isArray(flat) ? flat : [];
    const tasks = [];
    let lastTask = null;
    for (const c of list) {
        const name = String(c?.name || '').trim();
        const start = Number(c?.start);
        const end = Number(c?.end);
        if (!name || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
        if (!lastTask || lastTask.name !== name) {
            lastTask = { name, clips: [] };
            tasks.push(lastTask);
        }
        lastTask.clips.push({ start, end });
    }
    return tasks;
}

function __applyMergeOrderOverrideToVideoTasks(opts = {}) {
    const shouldRender = opts.render !== false;
    const shouldSave = opts.save === true;

    if (!__isMergeOrderOverrideValid()) return false;
    videoTasks = __buildVideoTasksFromFlatClips(__mergeOrderOverride);
    if (shouldRender) renderNewClipList();
    if (shouldSave) __saveClipToolState();
    return true;
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
        _previewLoaded = !!(__mainPreviewActive) || _hasSrc || _hasMeta;
    } catch (e) {
        _previewLoaded = !!(__mainPreviewActive);
    }
    return !!_previewLoaded;
}

// 同步所有视频控制按钮/进度条的 disabled 状态
function __syncVideoControlsDisabledState() {
    var _ready = __isVideoReady();
    var _btns = [playPauseBtn, quickSetStartBtn, quickSetEndBtn, quickAddClipBtnCtrl, quickPlayClipBtn, fullscreenBtn];
    for (var _i = 0; _i < _btns.length; _i++) {
        if (_btns[_i]) _btns[_i].disabled = !_ready;
    }
    if (speedSelect) speedSelect.disabled = !_ready;
    if (speedSelectToggle) speedSelectToggle.disabled = !_ready;
    if (speedSelectGroup && !_ready) speedSelectGroup.classList.remove('open');
    if (speedSelectMenu) {
        speedSelectMenu.querySelectorAll('.tl-zoom-menu-item[data-speed]').forEach(function (btn) {
            btn.disabled = !_ready;
        });
    }
    if (progressBar) progressBar.disabled = !_ready;
}

// 在合并/切片运行时标记“添加片段”受限，但保留按钮可点击（点击会提示不可添加）
function __syncClipAddDisabledState(state) {
    try {
        const s = state && typeof state === 'object' ? state : (__mergeStatusLastState || { running: false });
        const running = s.running === true;
        const disabled = !!running; // 仅作为内部标志使用

        if (confirmAddClipBtn) {
            // 不再真正禁用按钮（保持可点击），仅添加样式提示
            confirmAddClipBtn.classList.toggle('clip-add-locked', disabled);
            confirmAddClipBtn.title = disabled ? '当前正在切片，点击将提示无法添加' : '确认添加片段';
        }
        if (quickAddClipBtnCtrl) {
            quickAddClipBtnCtrl.classList.toggle('clip-add-locked', disabled);
            quickAddClipBtnCtrl.title = disabled ? '当前正在切片，点击将提示无法添加' : '添加片段';
        }

        // 仅作为视觉/状态标记，供其他逻辑/样式使用
        try { document.body.dataset.clipAddDisabled = disabled ? '1' : '0'; } catch (e) { }
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
function updatePreviewEmptyHint() {
    try {
        const hint = document.querySelector('.preview-panel .panel-title .preview-empty-hint');
        if (!hint) return;

        const w = window.innerWidth || document.documentElement.clientWidth || 0;
        const h = window.innerHeight || document.documentElement.clientHeight || 0;
        const widthTooSmall = (w < 330);
        const heightTooSmall = (h < 530);

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
    } catch (e) {
        /* ignore */
    }
}

const timeDisplay = document.getElementById('timeDisplay');
const quickSetStartBtn = document.getElementById('quickSetStartBtn');
const quickSetEndBtn = document.getElementById('quickSetEndBtn');
const quickAddClipBtnCtrl = document.getElementById('quickAddClipBtnCtrl');
const quickPlayClipBtn = document.getElementById('quickPlayClipBtn');
const speedSelect = document.getElementById('speedSelect');
const speedSelectGroup = document.getElementById('speedSelectGroup');
const speedSelectToggle = document.getElementById('speedSelectToggle');
const speedSelectMenu = document.getElementById('speedSelectMenu');
const openFileTreeBtnMain = document.getElementById('openFileTreeBtn');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const mainControlsRow = document.querySelector('#videoControlsContainer .buttons-row.main-ctrls');
const mainLeftCtrlGroup = mainControlsRow ? mainControlsRow.querySelector('.ctrl-group.left') : null;
const mainRightCtrlGroup = mainControlsRow ? mainControlsRow.querySelector('.ctrl-group.right') : null;
const ctrlStartDisp = document.getElementById('ctrlStartDisp');
const ctrlEndDisp = document.getElementById('ctrlEndDisp');
const usernameInput = document.getElementById('usernameInput');
const clipTitleInput = document.getElementById('clipTitleInput');
const openHistoryBtn = document.getElementById('openHistoryBtn');
const previewMergeBtn = document.getElementById('previewMergeBtn');
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
                    __invalidateMergeOrderOverride();
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

        try {
            cancelMergeBtnModalFixed.disabled = true;
            cancelMergeBtnModalFixed.textContent = '取消中...';

            const s = await __fetchMergeStatus();
            __mergeStatusLastState = s;
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
            __startMergeStatusPolling({ forceFast: true });
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
    if (!running && !String(__getMergeToken() || '').trim()) return 0;

    // Already acked: stop polling
    const jobId = String(s.job_id || '').trim();
    if (!running && jobId && jobId === __getAckedJobId()) return 0;

    // 页面在后台时大幅降频，避免“挂着标签页”刷接口
    if (document.hidden && !forceFast) return 15000;

    if (running) {
        return forceFast ? 800 : 1200;
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
                    <div class="merge-result-title">合并失败</div>
                    <div class="merge-result-sub">请检查错误信息后重试</div>
                    
                    <pre class="merge-result-error">${__escapeHtml(errorText || 'Unknown error')}</pre>
                    
                    <div>
                        <button id="copyErrorBtn" type="button">
                            复制错误信息
                        </button>
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
                    <div class="merge-result-title">合并完成</div>
                    ${safeOutPath ? `<div>${__escapeHtml((outPath || '').split(/[\\\/]/).pop() || '')}</div>` : ''}

                    ${!outPath ? '' : `
                    <div id="fileNotExistWarning" style="display:none; color:#ff8080; font-size:12px; background:rgba(255,0,0,0.1); padding:8px; border-radius:6px; width:100%;">⚠ 文件不存在或已被删除</div>
                    `}

                    <div class="merge-result-actions">
                            <button id="downloadClipBtn" type="button">
                                下载视频
                            </button>
                            <button id="copyClipLinkBtn" type="button">
                                复制链接
                            </button>
                    </div>
                    <div class="clear-choice-group" style="display:flex; gap:8px; justify-content:center; flex-wrap:wrap; margin-top:6px;">
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
    const status = String(s.status || '').toLowerCase();

    // 同步“取消当前任务”按钮状态（常驻按钮）
    __syncCancelMergeBtnFixed(s);
    // 当后端处于运行态（s.running === true）时禁止添加片段
    try { __syncClipAddDisabledState(s); } catch (e) { }


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
            mergeAllBtn.disabled = true;
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
        const pctNow = (percent * 100);

        progressModalBody.innerHTML = `
            <div class="mp-card">
                <div class="mp-header">
                    <div class="mp-stage">${stageText || '处理中'}</div>
                    <div class="mp-percent">${pctText}</div>
                </div>

                <div class="mp-bar-wrapper" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${(pctNow).toFixed(1)}">
                    <div class="mp-bar-fill" style="width:${(pctNow).toFixed(2)}%"></div>
                </div>

                <div class="mp-details">
                    <div class="mp-stat-item" style="text-align:right;">
                        <span class="mp-label">预计剩余</span>
                        <span class="mp-value">${eta || '计算中...'}</span>
                    </div>
                    

                </div>
            </div>
        `;

        // 常驻按钮在模板里，避免被 innerHTML 覆盖；这里不再重复生成/绑定

        // 强制应用进度条宽度，避免 style 属性格式或 NaN 导致不可见；使用上次宽度平滑过渡到目标宽度以避免回跳
        (function applyProgressWidth() {
            try {
                const bar = progressModalBody.querySelector('.mp-bar-fill');
                const wrapper = progressModalBody.querySelector('.mp-bar-wrapper');
                let w = Number.isFinite(pctNow) ? Number(pctNow) : (Number(percent) * 100);
                if (!Number.isFinite(w) || isNaN(w)) w = 0;
                w = Math.max(0, Math.min(100, w));

                if (bar && wrapper) {
                    // 读取上一次记录的宽度（优先 dataset），或当前 style，或通过计算获得
                    let prev = 0;
                    const ds = bar.dataset ? bar.dataset.lastWidth : undefined;
                    if (ds !== undefined && ds !== null && ds !== '') {
                        prev = Number(ds) || 0;
                    } else if (bar.style && bar.style.width) {
                        prev = parseFloat(bar.style.width) || 0;
                    } else {
                        const cw = wrapper.clientWidth || 1;
                        prev = cw ? (bar.offsetWidth / cw) * 100 : 0;
                    }
                    prev = Math.max(0, Math.min(100, prev));

                    // 若与目标相差非常小，直接设置目标以避免触发过渡
                    if (Math.abs(w - prev) < 0.01) {
                        bar.style.width = w.toFixed(2) + '%';
                    } else {
                        // 先确保元素有当前宽度，再在下一帧切换到目标，保持平滑过渡
                        bar.style.width = prev.toFixed(2) + '%';
                        bar.style.minWidth = (w > 0 && w < 1) ? '3px' : '';
                        bar.style.opacity = '1';
                        requestAnimationFrame(() => {
                            try { bar.style.width = w.toFixed(2) + '%'; } catch (e) { }
                        });
                    }
                    bar.dataset.lastWidth = String(w);
                } else if (bar) {
                    // 缺少 wrapper 情况：直接设置
                    bar.style.width = w.toFixed(2) + '%';
                    bar.dataset.lastWidth = String(w);
                }

                if (wrapper) wrapper.setAttribute('aria-valuenow', w.toFixed(1));
            } catch (e) {
                // ignore
            }
        })();


    }
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

function __saveProgress(videoName, currentTime, duration) {
    if (!videoName) return;
    const t = Number(currentTime);
    const d = Number(duration);
    if (!Number.isFinite(t) || t < VIDEO_PROGRESS_MIN_SAVE_SECONDS) return;

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
            t: Math.floor(t),
            at: Date.now(),
        }));
    } catch (e) {
        // ignore
    }
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
    if (!Number.isFinite(target) || target < VIDEO_PROGRESS_MIN_SAVE_SECONDS) return;
    if (Number.isFinite(d) && d > 0 && target >= d - VIDEO_PROGRESS_CLEAR_NEAR_END_SECONDS) return;

    // 仅在 metadata ready 后设置 currentTime 才可靠
    try {
        player.currentTime = target;
        // 立即更新 UI（某些浏览器对 currentTime 赋值不会同步触发 timeupdate）
        if (typeof progressBar !== 'undefined' && progressBar) {
            progressBar.value = target;
            updateProgress(target, player.duration);
        }
        timeDisplay.textContent = `${formatTime(target)} / ${formatTime(player.duration || 0)}`;
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
                <div style="font-weight:bold; white-space:normal; overflow-wrap:anywhere; word-break:break-word; margin-bottom:8px;">${safeFile}</div>
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

async function __loadClipToolState() {
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

        // 恢复用户名（立即恢复，不提示）
        const savedUsername = String(obj?.username ?? '').trim();
        if (usernameInput && savedUsername) {
            usernameInput.value = savedUsername;
        }

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
const newClipListContainer = document.getElementById('newClipListContainer');
const clearAllClipsFn = document.getElementById('clearAllClipsFn');

let tempStart = null;
let tempEnd = null;
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
    msgEl.textContent = (message ?? '').toString();
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

        const onOk = () => { cleanup(); resolve(true); };
        const onCancel = () => { cleanup(); resolve(false); };
        const onOverlay = (e) => {
            // 点击遮罩关闭（等价取消），点击弹窗本体不关闭
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

        // 默认把焦点放到“确定”按钮
        setTimeout(() => okBtn.focus(), 0);
    });
}

// ------------------ 时间转换 ------------------
function formatTime(seconds) {
    let s = Number(seconds);
    if (!Number.isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function roundToMs(seconds) {
    let s = Number(seconds);
    if (!Number.isFinite(s)) return 0;
    if (s < 0) s = 0;
    return Math.round(s * 1000) / 1000;
}

function formatTimeMs(seconds) {
    let s = Number(seconds);
    if (!Number.isFinite(s) || s < 0) s = 0;

    const rounded = roundToMs(s);
    let whole = Math.floor(rounded);
    let ms = Math.round((rounded - whole) * 1000);
    if (ms >= 1000) {
        whole += 1;
        ms = 0;
    }

    const hrs = Math.floor(whole / 3600);
    const mins = Math.floor((whole % 3600) / 60);
    const secs = whole % 60;
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function parseTime(str) {
    const raw = String(str ?? '').trim();
    if (!raw) return NaN;

    // 兼容：00:01:02.345 / 01:02.345 / 62.345；也接受逗号小数
    const normalized = raw.replace(',', '.');
    const parts = normalized.split(':');
    if (parts.length < 1 || parts.length > 3) return NaN;

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

    return roundToMs(total);
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

function setAccentColor(rgbString) {
    const rgb = rgbString.match(/\d+/g).join(',');
    document.documentElement.style.setProperty('--accent-color', `rgb(${rgb})`);
    document.documentElement.style.setProperty('--btn-bg', `rgba(${rgb},0.4)`);
    document.documentElement.style.setProperty('--btn-hover', `rgba(${rgb},0.6)`);
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
        const themeColor = res.headers.get('x-theme-color') || '79,158,255';
        setAccentColor(themeColor);

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
                            try {
                                const rect = videoEl.getBoundingClientRect();
                                const inView = rect.top >= 0 && rect.bottom <= (window.innerHeight || document.documentElement.clientHeight);
                                if (!inView) {
                                    videoEl.scrollIntoView({ behavior: prefersReduced ? 'auto' : 'smooth', block: 'center' });
                                }
                            } catch (e) { }
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
        }, 1000);

        await __loadClipToolState();
        // 根据当前（或最近一次）合并状态同步“添加片段”控件的启用/禁用
        try { __syncClipAddDisabledState(__mergeStatusLastState || {}); } catch (e) { }
        try {
            const total = __getTotalClipCountFromVideoTasks();
            const show = Number(total) > 0;
            if (previewMergeBtn) previewMergeBtn.style.display = show ? '' : 'none';
            if (clearAllClipsFn) clearAllClipsFn.style.display = show ? '' : 'none';
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
                        return;
                    }

                    // 普通选择逻辑（选中当前文件）
                    fileTreeDiv.querySelectorAll('span.selected').forEach(el => el.classList.remove('selected'));
                    span.classList.add('selected');

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

                    __setVideoContainerExpanded(false);

                    document.getElementById('previewActionArea').style.display = 'block';
                    const _videoName = node.basename || node.name;
                    const _titleEl2 = document.getElementById('videoTitleFilename');
                    if (_titleEl2) { _titleEl2.textContent = _videoName; _titleEl2.title = _videoName; }

                    currentVideoName = node.name;
                    // 选中文件但尚未点击“预览”：认为预览尚未激活
                    __mainPreviewActive = false;
                    const videoLabel2 = document.getElementById('currentVideoLabel');
                    if (videoLabel2) videoLabel2.textContent = node.basename || node.name;
                    document.getElementById('currentVideoInfoBlock').style.display = 'block';
                    refreshVideoStageDim();

                    // 选择文件后不再自动关闭文件树弹窗 — 由用户手动关闭以便连续选择/对比
                    //（保留注释以便将来恢复自动关闭）
                    // __closeFileTreeModal();

                    tempStart = null;
                    tempEnd = null;
                    updateClipInputs();
                    renderNewClipList();
                });
                li.appendChild(span);
            }
            ul.appendChild(li);
        });
        return ul;
    }

    fileTreeDiv.appendChild(createTree(tree));

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

// ------------------ 渲染片段列表 (重构) ------------------
function renderNewClipList() {
    newClipListContainer.innerHTML = '';

    // 片段列表为空时隐藏“预览合并/清空”按钮
    const __updateClipListActionButtons = () => {
        try {
            const total = __getTotalClipCountFromVideoTasks();
            const show = Number(total) > 0;
            if (previewMergeBtn) previewMergeBtn.style.display = show ? '' : 'none';
            if (clearAllClipsFn) clearAllClipsFn.style.display = show ? '' : 'none';
        } catch (e) { }
    };

    // 若存在合法的顺序覆盖，则先把 videoTasks 同步为该顺序，保证主列表/预览/提交一致
    __applyMergeOrderOverrideToVideoTasks({ render: false, save: false });

    // 过滤掉空任务，避免显示空行
    // 但不要永久删除，因为可能用户正在操作
    const validTasks = videoTasks.filter(v => v.clips.length > 0);

    if (validTasks.length === 0) {
        newClipListContainer.innerHTML = '<div style="text-align:center; padding:20px; color:var(--muted-color);">暂无片段</div>';
        __updateClipListActionButtons();
        return;
    }

    __updateClipListActionButtons();

    let globalClipIndex = 0; // 全局计数器

    let __mainListDragFromIndex = null;

    const reorderByGlobalIndex = (fromIdx, toIdx) => {
        const from = Number(fromIdx);
        const to = Number(toIdx);
        if (!Number.isFinite(from) || !Number.isFinite(to)) return;
        if (from === to) return;

        const flat = __flattenVideoTasksToClips();
        if (from < 0 || from >= flat.length) return;
        if (to < 0 || to >= flat.length) return;

        const moving = flat.splice(from, 1)[0];
        flat.splice(to, 0, moving);
        __mergeOrderOverride = flat;
        __applyMergeOrderOverrideToVideoTasks({ render: false, save: false });
        renderNewClipList();
        __saveClipToolState();

        // 直接显示 "片段 X 移动到 片段 Y"
        showToast(`片段 ${from + 1} 移动到 片段 ${to + 1}`, 'info', 3000);
    };

    // 如果相邻的两个任务是同一个视频，其实在显示上可以合并，
    // 但由于我们的逻辑是 A->B->A，所以不应该合并。这里直接按 videoTasks 顺序渲染即可。

    videoTasks.forEach((video, taskIdx) => {
        if (video.clips.length === 0) return;

        const vidGroup = document.createElement('div');
        vidGroup.style.marginBottom = '10px';
        vidGroup.innerHTML = `<div style="font-weight:bold; font-size:13px; color:var(--accent-color); margin-bottom:4px; white-space:normal; overflow-wrap:anywhere; word-break:break-word;">${video.name}</div>`;

        video.clips.forEach((c, clipIdx) => {
            globalClipIndex++; // 递增全局序号
            const globalIdx = globalClipIndex - 1;

            const item = document.createElement('div');
            item.className = 'glass';
            item.style.padding = '8px';
            item.style.marginBottom = '6px';
            item.style.display = 'flex';
            item.style.justifyContent = 'space-between';
            item.style.alignItems = 'center';
            item.draggable = true;
            item.dataset.gidx = String(globalIdx);

            // 拖拽排序（全局顺序）
            item.addEventListener('dragstart', (e) => {
                __mainListDragFromIndex = globalIdx;
                try {
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', String(globalIdx));
                } catch (err) { }
            });
            item.addEventListener('dragover', (e) => {
                e.preventDefault();
                try { e.dataTransfer.dropEffect = 'move'; } catch (err) { }
            });
            item.addEventListener('drop', (e) => {
                e.preventDefault();
                const from = __mainListDragFromIndex;
                __mainListDragFromIndex = null;
                if (from === null || from === undefined) return;
                reorderByGlobalIndex(from, globalIdx);
            });
            item.addEventListener('dragend', () => {
                __mainListDragFromIndex = null;
            });

            const info = document.createElement('div');
            // 使用全局序号
            info.innerHTML = `
                <span style="display:inline-block; width:20px; font-weight:bold; color:var(--accent-color);">${globalClipIndex}.</span>
                <span style="font-family:monospace;">${formatTime(c.start)}</span> 
                <span style="color:var(--muted-color);">➔</span> 
                <span style="font-family:monospace;">${formatTime(c.end)}</span>
            `;

            const delBtn = document.createElement('button');
            delBtn.textContent = '×';
            delBtn.style.padding = '2px 8px';
            delBtn.style.marginLeft = '10px';
            delBtn.title = '删除此片段';
            delBtn.style.background = 'rgba(255, 100, 100, 0.2)';
            delBtn.addEventListener('click', async () => {
                // 运行态保护：正在切片时禁止删除片段并以弹窗提示
                try {
                    if (__mergeStatusLastState && __mergeStatusLastState.running === true) {
                        showAlertModal('当前正在切片，无法删除片段');
                        return;
                    }
                } catch (e) { /* ignore and proceed */ }

                // 确认删除（显示片段时长以便识别）
                try {
                    const startText = formatTime(c.start);
                    const endText = formatTime(c.end);
                    const fileName = String(video && video.name ? video.name.split('/').pop() : '');
                    const ok = await showConfirmModal(`文件：${fileName}\n片段：${startText} - ${endText}\n\n确定要删除该片段吗？`, { title: '删除确认', okText: '删除', cancelText: '取消' });
                    if (!ok) return;
                } catch (e) {
                    // 若弹窗不可用则降级：直接返回（避免误删）
                    return;
                }

                video.clips.splice(clipIdx, 1);
                if (video.clips.length === 0) {
                    videoTasks.splice(taskIdx, 1);
                }
                renderNewClipList();
                __invalidateMergeOrderOverride();
                __saveClipToolState();
                showToast('片段已删除');
            });

            item.appendChild(info);
            item.appendChild(delBtn);
            vidGroup.appendChild(item);
        });
        newClipListContainer.appendChild(vidGroup);
    });
}

// ------------------ 合并效果预览（按顺序串播） ------------------
let __mergePreviewInited = false;
let __mergePreviewEls = null;
let __mergePreviewQueue = [];
let __mergePreviewIndex = 0;
let __mergePreviewTimeUpdateHandler = null;
let __mergePreviewAdvancing = false;
let __mergePreviewActiveStart = 0;
let __mergePreviewActiveEnd = 0;
let __mergePreviewDragging = false;
let __mergePreviewTotalDuration = 0;
let __mergePreviewTotalProgressBase = 0; // 当前片段开始前的累计时长
let __mergePreviewQueueItemEls = [];
let __mergePreviewDragFromIndex = null;
let __mergePreviewCurrentKey = '';

function __mergePreviewClipKey(c) {
    if (!c) return '';
    return `${String(c.name)}|${Number(c.start)}|${Number(c.end)}`;
}

function __mergePreviewRecomputeSeqAndOffsets() {
    let acc = 0;
    for (let i = 0; i < __mergePreviewQueue.length; i++) {
        const c = __mergePreviewQueue[i];
        if (!c) continue;
        c.seq = i + 1;
        c.offset = acc;
        acc += Math.max(0, Number(c.duration) || 0);
    }
    __mergePreviewTotalDuration = acc;
}

function __mergePreviewApplyOverrideFromQueue() {
    __mergeOrderOverride = (__mergePreviewQueue || []).map(c => ({
        name: String(c?.name || ''),
        start: Number(c?.start),
        end: Number(c?.end)
    })).filter(c => c.name && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start);
}

function __mergePreviewReorder(fromIndex, toIndex) {
    const from = Number(fromIndex);
    const to = Number(toIndex);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return;
    if (from === to) return;
    if (from < 0 || from >= __mergePreviewQueue.length) return;
    if (to < 0 || to >= __mergePreviewQueue.length) return;

    const moving = __mergePreviewQueue.splice(from, 1)[0];
    __mergePreviewQueue.splice(to, 0, moving);
    __mergePreviewRecomputeSeqAndOffsets();

    // 保持当前播放片段不变（按 key 定位）
    if (__mergePreviewCurrentKey) {
        const newIndex = __mergePreviewQueue.findIndex(c => __mergePreviewClipKey(c) === __mergePreviewCurrentKey);
        if (newIndex >= 0) __mergePreviewIndex = newIndex;
    }

    // 更新总进度相关基准（不重载视频，避免播放中断）
    const active = __mergePreviewQueue[__mergePreviewIndex];
    if (active) {
        __mergePreviewTotalProgressBase = Number(active.offset || 0);
    }

    // 更新 UI（侧栏/进度条/时间）
    __mergePreviewRenderQueueSidebar();
    __mergePreviewUpdateQueueActive();

    if (__mergePreviewEls) {
        const { progress, timeEl } = __mergePreviewEls;
        const totalDur = Math.max(0, __mergePreviewTotalDuration);
        progress.max = String(totalDur);
        const curTotal = __mergePreviewGetTotalPosForCurrent();
        if (!__mergePreviewDragging) {
            progress.value = String(curTotal);
            const percent = totalDur > 0 ? (curTotal / totalDur) * 100 : 0;
            progress.style.background = `linear-gradient(to right, var(--accent-color) 0%, var(--accent-color) ${percent}%, rgba(255,255,255,0.06) ${percent}%, rgba(255,255,255,0.06) 100%)`;
        }
        timeEl.textContent = `${formatTime(curTotal)} / ${formatTime(totalDur)}`;
    }

    __mergePreviewApplyOverrideFromQueue();

    // 同步到主列表（让“待合并片段列表”也立即体现新的顺序）
    __applyMergeOrderOverrideToVideoTasks({ render: true, save: true });

    // 提示顺序已更新（无撤销）
    try {
        // 直接显示 "片段 X 移动到 片段 Y"（合并预览）
        showToast(`片段 ${from + 1} 移动到 片段 ${to + 1}`, 'info', 3000);
    } catch (e) { /* ignore */ }
}

function __mergePreviewRenderQueueSidebar() {
    if (!__mergePreviewEls) return;
    const { queueListEl, queueMetaEl, v } = __mergePreviewEls;
    if (!queueListEl) return;

    queueListEl.innerHTML = '';
    __mergePreviewQueueItemEls = [];

    const total = __mergePreviewQueue.length;
    for (let i = 0; i < total; i++) {
        const c = __mergePreviewQueue[i];
        if (!c) continue;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'merge-preview-queue-item';
        btn.dataset.index = String(i);
        btn.draggable = true;

        const row1 = document.createElement('div');
        row1.className = 'row1';

        const name = document.createElement('div');
        name.className = 'name';
        name.textContent = `${i + 1}. ${c.name}`;

        row1.appendChild(name);

        const row2 = document.createElement('div');
        row2.className = 'row2';
        row2.textContent = `片段：${formatTime(c.start)} - ${formatTime(c.end)}\n时长：${formatTime(c.duration)}`;

        btn.appendChild(row1);
        btn.appendChild(row2);

        btn.addEventListener('click', () => {
            const shouldPlay = v ? !v.paused : true;
            __mergePreviewGoto(i, shouldPlay);
        });

        // 拖拽排序（HTML5 drag&drop）
        btn.addEventListener('dragstart', (e) => {
            __mergePreviewDragFromIndex = i;
            try {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', String(i));
            } catch (err) { }
        });
        btn.addEventListener('dragover', (e) => {
            e.preventDefault();
            try { e.dataTransfer.dropEffect = 'move'; } catch (err) { }
        });
        btn.addEventListener('drop', (e) => {
            e.preventDefault();
            const from = __mergePreviewDragFromIndex;
            __mergePreviewDragFromIndex = null;
            if (from === null || from === undefined) return;
            __mergePreviewReorder(from, i);
        });
        btn.addEventListener('dragend', () => {
            __mergePreviewDragFromIndex = null;
        });

        queueListEl.appendChild(btn);
        __mergePreviewQueueItemEls.push(btn);
    }

    if (queueMetaEl) {
        queueMetaEl.textContent = `${total} 段 · 总时长 ${formatTime(Math.max(0, __mergePreviewTotalDuration))}`;
    }

    __mergePreviewUpdateQueueActive();
}

function __mergePreviewUpdateQueueActive() {
    if (!__mergePreviewQueueItemEls || __mergePreviewQueueItemEls.length === 0) return;
    for (let i = 0; i < __mergePreviewQueueItemEls.length; i++) {
        const el = __mergePreviewQueueItemEls[i];
        if (!el) continue;
        if (i === __mergePreviewIndex) el.classList.add('active');
        else el.classList.remove('active');
    }

    // 尽量保证当前项可见
    const activeEl = __mergePreviewQueueItemEls[__mergePreviewIndex];
    if (activeEl && typeof activeEl.scrollIntoView === 'function') {
        try { activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { }
    }
}

function __initMergePreviewOnce() {
    if (__mergePreviewInited) return;

    const overlay = document.getElementById('mergePreviewOverlay');
    const closeX = document.getElementById('mergePreviewCloseX');
    const nowEl = document.getElementById('mergePreviewNow');
    const v = document.getElementById('mergePreviewPlayer');
    const playPauseBtn = document.getElementById('mergePreviewPlayPause');
    const progress = document.getElementById('mergePreviewProgress');
    const timeEl = document.getElementById('mergePreviewTime');
    const queueMetaEl = document.getElementById('mergePreviewQueueMeta');
    const queueListEl = document.getElementById('mergePreviewQueueList');

    if (!overlay || !closeX || !nowEl || !v || !playPauseBtn || !progress || !timeEl) return;

    __mergePreviewEls = { overlay, closeX, nowEl, v, playPauseBtn, progress, timeEl, queueMetaEl, queueListEl };
    __mergePreviewInited = true;

    const closeModal = () => {
        try { v.pause(); } catch (e) { }
        if (__mergePreviewTimeUpdateHandler) {
            v.removeEventListener('timeupdate', __mergePreviewTimeUpdateHandler);
            __mergePreviewTimeUpdateHandler = null;
        }
        __mergePreviewAdvancing = false;
        __mergePreviewDragging = false;
        v.removeAttribute('src');
        v.removeAttribute('data-video-src');
        try { v.srcObject = null; } catch (e) { }
        try { v.load(); } catch (e) { }

        // 重置 UI
        playPauseBtn.textContent = '播放';
        progress.value = '0';
        progress.max = '0';
        timeEl.textContent = '00:00:00 / 00:00:00';

        // 清理队列侧栏
        __mergePreviewQueueItemEls = [];
        if (queueListEl) queueListEl.innerHTML = '';
        if (queueMetaEl) queueMetaEl.textContent = '';

        overlay.classList.remove('show');
        // 如果弹窗内部有焦点元素（例如 closeX），移除焦点再隐藏
        try {
            const active = document.activeElement;
            if (active && overlay.contains(active)) {
                active.blur();
            }
        } catch (e) { }
        overlay.setAttribute('aria-hidden', 'true');
        // 应用 inert 以防意外聚焦或被辅助工具访问
        try { overlay.inert = true; } catch (e) { }
        try { overlay.__modalId = null; } catch (e) { }
    };

    closeX.addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeModal();
    });
    document.addEventListener('keydown', (e) => {
        if (!overlay.classList.contains('show')) return;
        if (e.key === 'Escape') closeModal();
    });

    // 自定义播放/暂停
    playPauseBtn.addEventListener('click', () => {
        if (v.paused) v.play().catch(() => { });
        else v.pause();
    });

    // 进度条拖拽
    progress.addEventListener('mousedown', () => __mergePreviewDragging = true);
    progress.addEventListener('mouseup', () => __mergePreviewDragging = false);
    progress.addEventListener('touchstart', () => __mergePreviewDragging = true, { passive: true });
    progress.addEventListener('touchend', () => __mergePreviewDragging = false, { passive: true });

    progress.addEventListener('input', () => {
        const val = Number(progress.value);
        const totalDur = Math.max(0, __mergePreviewTotalDuration);
        const clampedTotal = Math.max(0, Math.min(val, totalDur));

        // 将“总时间轴”映射到具体片段
        const mapped = __mergePreviewFindIndexByTotalPos(clampedTotal);
        const idx = mapped.index;
        const inClip = mapped.inClip;
        if (Number.isFinite(idx) && idx !== __mergePreviewIndex) {
            // 跳到对应片段（不自动播放由当前播放状态决定）
            const shouldPlay = !v.paused;
            __mergePreviewGoto(idx, shouldPlay);
        }
        // 定位到片段内时间
        try { v.currentTime = __mergePreviewActiveStart + Math.max(0, inClip); } catch (e) { }

        // 仅更新显示（避免等待 timeupdate）
        timeEl.textContent = `${formatTime(clampedTotal)} / ${formatTime(totalDur)}`;
        const percent = totalDur > 0 ? (clampedTotal / totalDur) * 100 : 0;
        progress.style.background = `linear-gradient(to right, var(--accent-color) 0%, var(--accent-color) ${percent}%, rgba(255,255,255,0.06) ${percent}%, rgba(255,255,255,0.06) 100%)`;
    });

    // 同步按钮状态
    v.addEventListener('play', () => { playPauseBtn.textContent = '暂停'; });
    v.addEventListener('pause', () => { playPauseBtn.textContent = '播放'; });

    // 点击视频也切换播放/暂停（保持轻量交互）
    v.addEventListener('click', () => {
        if (v.paused) v.play().catch(() => { });
        else v.pause();
    });
}

function __buildMergePreviewQueue() {
    const queue = [];
    let seq = 0;
    let acc = 0;
    for (const task of (videoTasks || [])) {
        const name = String(task?.name || '').trim();
        if (!name) continue;
        const clips = Array.isArray(task?.clips) ? task.clips : [];
        for (const c of clips) {
            const start = Number(c?.start);
            const end = Number(c?.end);
            if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
            if (start < 0 || end <= start) continue;
            seq += 1;
            const duration = end - start;
            const offset = acc;
            acc += duration;
            queue.push({ seq, name, start, end, duration, offset });
        }
    }
    __mergePreviewTotalDuration = acc;
    return queue;
}

function __buildMergePreviewQueueFromOverride(overrideList) {
    const queue = [];
    let seq = 0;
    let acc = 0;
    const list = Array.isArray(overrideList) ? overrideList : [];
    for (const c of list) {
        const name = String(c?.name || '').trim();
        const start = Number(c?.start);
        const end = Number(c?.end);
        if (!name) continue;
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
        if (start < 0 || end <= start) continue;
        seq += 1;
        const duration = end - start;
        const offset = acc;
        acc += duration;
        queue.push({ seq, name, start, end, duration, offset });
    }
    __mergePreviewTotalDuration = acc;
    return queue;
}

function __mergePreviewGetTotalPosForCurrent() {
    // 当前片段内相对时间 + 该片段之前的累计偏移
    const dur = Math.max(0, __mergePreviewActiveEnd - __mergePreviewActiveStart);
    const v = __mergePreviewEls?.v;
    const curRel = v ? Math.max(0, Math.min(dur, Number(v.currentTime) - __mergePreviewActiveStart)) : 0;
    return Math.max(0, Math.min(__mergePreviewTotalDuration, __mergePreviewTotalProgressBase + curRel));
}

function __mergePreviewFindIndexByTotalPos(totalPos) {
    const pos = Math.max(0, Math.min(totalPos, __mergePreviewTotalDuration));
    // 简单线性查找：队列最多几十条，足够快
    for (let i = 0; i < __mergePreviewQueue.length; i++) {
        const c = __mergePreviewQueue[i];
        if (!c) continue;
        const start = c.offset;
        const end = c.offset + c.duration;
        if (pos >= start && pos < end) {
            return { index: i, inClip: pos - start };
        }
    }
    // pos==总时长：落到最后一段末尾
    if (__mergePreviewQueue.length) {
        const lastIndex = __mergePreviewQueue.length - 1;
        const last = __mergePreviewQueue[lastIndex];
        return { index: lastIndex, inClip: Math.max(0, last.duration) };
    }
    return { index: 0, inClip: 0 };
}

function __mergePreviewUpdateInfo() {
    if (!__mergePreviewEls) return;
    // 方案C：片段信息由右侧“片段队列”承担，这里无需额外显示
}

function __mergePreviewGoto(index, autoPlay) {
    __initMergePreviewOnce();
    if (!__mergePreviewEls) return;
    const { v, nowEl, progress, timeEl } = __mergePreviewEls;

    const total = __mergePreviewQueue.length;
    if (!total) return;
    __mergePreviewIndex = Math.max(0, Math.min(index, total - 1));
    const clip = __mergePreviewQueue[__mergePreviewIndex];
    if (!clip) return;

    __mergePreviewCurrentKey = __mergePreviewClipKey(clip);

    __mergePreviewUpdateInfo();
    nowEl.textContent = `${clip.seq}. ${clip.name}  [${formatTime(clip.start)} ➔ ${formatTime(clip.end)}]`;
    __mergePreviewUpdateQueueActive();

    __mergePreviewActiveStart = clip.start;
    __mergePreviewActiveEnd = clip.end;
    __mergePreviewTotalProgressBase = Number(clip.offset || 0);
    __mergePreviewDragging = false;

    // 初始化进度条（总时长）
    const totalDur = Math.max(0, __mergePreviewTotalDuration);
    progress.max = String(totalDur);
    progress.value = String(__mergePreviewTotalProgressBase);
    timeEl.textContent = `${formatTime(__mergePreviewTotalProgressBase)} / ${formatTime(totalDur)}`;
    const initPercent = totalDur > 0 ? (__mergePreviewTotalProgressBase / totalDur) * 100 : 0;
    progress.style.background = `linear-gradient(to right, var(--accent-color) 0%, var(--accent-color) ${initPercent}%, rgba(255,255,255,0.06) ${initPercent}%, rgba(255,255,255,0.06) 100%)`;

    // 清理旧的 timeupdate
    if (__mergePreviewTimeUpdateHandler) {
        v.removeEventListener('timeupdate', __mergePreviewTimeUpdateHandler);
        __mergePreviewTimeUpdateHandler = null;
    }
    __mergePreviewAdvancing = false;

    const src = `/api/video/${encodeURIComponent(clip.name)}`;
    const hasSrc = !!(v.getAttribute('src') || v.currentSrc);
    const needReload = !hasSrc || (v.getAttribute('data-video-src') !== src);
    v.setAttribute('data-video-src', src);
    if (needReload) {
        v.src = src;
        // 立即尝试播放（处于用户点击触发的调用栈内），有助于规避浏览器策略
        v.play().catch(err => {
            console.warn('初始尝试播放合并预览失败：', err);
        });
    }

    const seekAndPlay = () => {
        try { v.currentTime = Math.max(0, clip.start); } catch (e) { }
        if (autoPlay) {
            v.play().catch(() => { });
        }
    };

    // readyState>=1 表示 metadata 已可用（duration/seek）
    if (!needReload && v.readyState >= 1) {
        seekAndPlay();
    } else {
        v.addEventListener('loadedmetadata', seekAndPlay, { once: true });
        try { v.load(); } catch (e) { }
    }

    __mergePreviewTimeUpdateHandler = () => {
        if (__mergePreviewAdvancing) return;

        // 更新自定义进度/时间（总时间轴）
        const totalDur = Math.max(0, __mergePreviewTotalDuration);
        const dur = Math.max(0, __mergePreviewActiveEnd - __mergePreviewActiveStart);
        const curRel = Math.max(0, Math.min(dur, Number(v.currentTime) - __mergePreviewActiveStart));
        const curTotal = Math.max(0, Math.min(totalDur, __mergePreviewTotalProgressBase + curRel));
        if (!__mergePreviewDragging) {
            progress.value = String(curTotal);
            const percent = totalDur > 0 ? (curTotal / totalDur) * 100 : 0;
            progress.style.background = `linear-gradient(to right, var(--accent-color) 0%, var(--accent-color) ${percent}%, rgba(255,255,255,0.06) ${percent}%, rgba(255,255,255,0.06) 100%)`;
        }
        timeEl.textContent = `${formatTime(curTotal)} / ${formatTime(totalDur)}`;

        // 留一点余量，避免浮点误差卡住
        if (v.currentTime >= (clip.end - 0.05)) {
            __mergePreviewAdvancing = true;
            try { v.pause(); } catch (e) { }
            setTimeout(() => {
                __mergePreviewAdvancing = false;
                if (__mergePreviewIndex < __mergePreviewQueue.length - 1) {
                    __mergePreviewGoto(__mergePreviewIndex + 1, true);
                } else {
                    showToast('合并预览播放完成');
                }
            }, 80);
        }
    };
    v.addEventListener('timeupdate', __mergePreviewTimeUpdateHandler);
}

function __openMergePreviewModal() {
    __initMergePreviewOnce();
    if (!__mergePreviewEls) {
        showToast('合并预览弹窗初始化失败');
        return;
    }

    // 避免两个播放器同时发声
    try { player.pause(); } catch (e) { }

    const totalClipsNow = __getTotalClipCountFromVideoTasks();
    if (Array.isArray(__mergeOrderOverride) && __mergeOrderOverride.length === totalClipsNow && totalClipsNow > 0) {
        __mergePreviewQueue = __buildMergePreviewQueueFromOverride(__mergeOrderOverride);
    } else {
        __mergePreviewQueue = __buildMergePreviewQueue();
    }
    if (__mergePreviewQueue.length === 0) {
        showToast('暂无片段，无法预览');
        return;
    }

    // 打开预览时同步一次覆盖顺序（确保后续合并提交一致）
    __mergePreviewApplyOverrideFromQueue();

    // 渲染队列侧栏（若 DOM 存在）
    __mergePreviewRenderQueueSidebar();

    __mergePreviewIndex = 0;
    const myModalId = (window.__modalSeq = (window.__modalSeq || 0) + 1);
    __mergePreviewEls.overlay.__previouslyFocused = document.activeElement;
    __mergePreviewEls.overlay.__modalId = myModalId;
    __mergePreviewEls.overlay.classList.add('show');
    __mergePreviewEls.overlay.setAttribute('aria-hidden', 'false');
    try { __mergePreviewEls.overlay.inert = false; } catch (e) { }
    // 自动播放预览，避免用户还需要手动按播放
    __mergePreviewGoto(0, true);
}

if (previewMergeBtn) {
    previewMergeBtn.addEventListener('click', () => __openMergePreviewModal());
}

// ------------------ 新版交互逻辑 ------------------

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
        const rounded = roundToMs(sec);
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
            try {
                if (player) {
                    const psrc = player.getAttribute('src') || player.currentSrc || '';
                    const vis = (playerWrapper && window.getComputedStyle(playerWrapper).display !== 'none');
                    if (psrc && vis) return true;
                }
            } catch (e) { }
            try {
                if (typeof __mergePreviewEls !== 'undefined' && __mergePreviewEls && __mergePreviewEls.overlay && __mergePreviewEls.overlay.classList.contains('show')) {
                    const mv = __mergePreviewEls.v;
                    const msrc = mv && (mv.getAttribute('data-video-src') || mv.currentSrc);
                    if (msrc) return true;
                }
            } catch (e) { }
            return false;
        })();

        if (!hasActivePreview) {
            showToast('已选择视频，请先点击预览以加载视频，再设定起点');
            return;
        }

        tempStart = roundToMs(player.currentTime);
        updateClipInputs();
        showToast(`起点已设定: ${formatTime(tempStart)}`);
    });
}

if (setEndBtn) {
    setEndBtn.addEventListener('click', () => {
        if (!currentVideoName) {
            showAlertModal('请先选择视频');
            return;
        }

        const hasActivePreview = (() => {
            try {
                if (player) {
                    const psrc = player.getAttribute('src') || player.currentSrc || '';
                    const vis = (playerWrapper && window.getComputedStyle(playerWrapper).display !== 'none');
                    if (psrc && vis) return true;
                }
            } catch (e) { }
            try {
                if (typeof __mergePreviewEls !== 'undefined' && __mergePreviewEls && __mergePreviewEls.overlay && __mergePreviewEls.overlay.classList.contains('show')) {
                    const mv = __mergePreviewEls.v;
                    const msrc = mv && (mv.getAttribute('data-video-src') || mv.currentSrc);
                    if (msrc) return true;
                }
            } catch (e) { }
            return false;
        })();

        if (!hasActivePreview) {
            showToast('已选择视频，请先点击预览以加载视频，再设定终点');
            return;
        }

        tempEnd = roundToMs(player.currentTime);
        updateClipInputs();
        showToast(`终点已设定: ${formatTime(tempEnd)}`);
    });
}

// 绑定视频控制区的快捷起点/终点按钮（直接执行，不再依赖片段工坊按钮）
if (quickSetStartBtn) {
    quickSetStartBtn.addEventListener('click', () => {
        if (!currentVideoName) { showAlertModal('请先选择视频'); return; }
        if (!__isVideoReady()) { showToast('请先点击预览以加载视频，再设定起点'); return; }
        const anchorT = (typeof window.__tlGetAnchorTime === 'function') ? window.__tlGetAnchorTime() : null;
        tempStart = roundToMs(anchorT !== null ? anchorT : player.currentTime);
        updateClipInputs();
        showToast(`起点已设定: ${formatTime(tempStart)}`);
    });
}
if (quickSetEndBtn) {
    quickSetEndBtn.addEventListener('click', () => {
        if (!currentVideoName) { showAlertModal('请先选择视频'); return; }
        if (!__isVideoReady()) { showToast('请先点击预览以加载视频，再设定终点'); return; }
        const anchorT = (typeof window.__tlGetAnchorTime === 'function') ? window.__tlGetAnchorTime() : null;
        tempEnd = roundToMs(anchorT !== null ? anchorT : player.currentTime);
        updateClipInputs();
        // 若起点已设定 → 自动提交片段（方案A）
        if (tempStart !== null) {
            __doAddClip();
        } else {
            showToast(`终点已设定: ${formatTime(tempEnd)}，请设定起点`);
        }
    });
}
quickAddClipBtnCtrl.addEventListener('click', () => confirmAddClipBtn.click());

quickPlayClipBtn.addEventListener('click', () => {
    triggerBtnFeedback(quickPlayClipBtn);
    if (!currentVideoName) {
        showAlertModal('请先选择视频');
        return;
    }
    if (!__isVideoReady()) {
        showToast('请先点击预览以加载视频');
        return;
    }
    const played = (typeof window.__tlTryPlaySelectedClips === 'function')
        ? window.__tlTryPlaySelectedClips()
        : false;
    if (!played) showToast('请先在时间轴选中至少一个片段');
});

// ---- 添加片段核心逻辑（W键和Add按钮共用）----
function __doAddClip({ silent = false } = {}) {
    if (__mergeStatusLastState && __mergeStatusLastState.running === true) {
        showAlertModal('当前正在切片，无法添加片段');
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
    const newStart = roundToMs(Math.min(tempStart, tempEnd));
    const newEnd = roundToMs(Math.max(tempStart, tempEnd));
    if (newEnd <= newStart) {
        if (!silent) showToast('终点时间必须大于起点时间');
        return false;
    }

    let task = null;
    if (videoTasks.length > 0) {
        const last = videoTasks[videoTasks.length - 1];
        if (last.name === currentVideoName) task = last;
    }
    if (!task) {
        task = { name: currentVideoName, clips: [] };
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

    task.clips.push({ start: newStart, end: newEnd });
    tempStart = null;
    tempEnd = null;
    updateClipInputs();
    renderNewClipList();
    __invalidateMergeOrderOverride();
    __saveClipToolState();
    showToast('✓ 片段已添加');
    return true;
}

confirmAddClipBtn.addEventListener('click', () => __doAddClip());


clearAllClipsFn.addEventListener('click', async () => {
    // 运行态保护：正在切片时禁止清空并提示用户
    try {
        if (__mergeStatusLastState && __mergeStatusLastState.running === true) {
            showAlertModal('当前正在切片，无法清空片段');
            return;
        }
    } catch (e) { /* ignore */ }

    const ok = await showConfirmModal('确定清空所有待合并的片段吗？', {
        title: '清空确认',
        okText: '清空',
        cancelText: '取消'
    });
    if (ok) {
        // 直接清空任务列表：避免残留空任务导致仍可提交
        videoTasks = [];
        __invalidateMergeOrderOverride();
        renderNewClipList();
        __saveClipToolState();
        showToast('已清空');
    }
});



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
    const totalClipsNow = __getTotalClipCountFromVideoTasks();

    let videosToSend = null;

    // 若存在“预览拖拽排序”的覆盖顺序，则按覆盖顺序提交（预览顺序=合并顺序）
    if (Array.isArray(__mergeOrderOverride) && __mergeOrderOverride.length === totalClipsNow && totalClipsNow > 0) {
        videosToSend = __mergeOrderOverride.map(c => ({
            name: String(c?.name || '').trim(),
            clips: [{ start: Number(c?.start), end: Number(c?.end) }]
        })).filter(v => v.name && Array.isArray(v.clips) && v.clips.length === 1 && Number.isFinite(v.clips[0].start) && Number.isFinite(v.clips[0].end) && v.clips[0].end > v.clips[0].start);
    } else {
        // 过滤掉 clips 为空的任务组（清空/删除后可能残留空壳）
        videosToSend = (videoTasks || []).filter(v => Array.isArray(v?.clips) && v.clips.length > 0);
    }

    if (!videosToSend || videosToSend.length === 0) {
        showAlertModal('请至少添加一个视频片段');
        return;
    }

    // 总时长限制：按切割模式限制（fast: 120 分钟，precise: 30 分钟）
    const cutMode = document.querySelector('input[name="cutMode"]:checked')?.value || 'fast';
    const MAX_TOTAL_SECONDS = (cutMode === 'precise') ? 30 * 60 : 120 * 60;

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
        const FAST_LIMIT_MIN = 120;
        const PRECISE_LIMIT_MIN = 30;
        showAlertModal(
            `总时长不能超过 ${maxMinutes} 分钟（当前 ${formatTime(totalSeconds)}）。\n说明：快速切割 最大 ${FAST_LIMIT_MIN} 分钟；精准切割 最大 ${PRECISE_LIMIT_MIN} 分钟。\n请删除或缩短片段后重试。`,
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
    const sourceMode = document.querySelector('input[name="sourceMode"]:checked')?.value || 'encode';
    // cutMode 已于前面读取用于时长校验

    updateFloatingWidget(true, '提交任务...', true);
    mergeAllBtn.disabled = true;
    mergeAllBtn.textContent = '提交中...';

    // POST 时把 username 也传给后端
    const res = await fetch('/api/slice_merge_all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videos: videosToSend, username: username, out_basename: clipTitle || null, source_mode: sourceMode, cut_mode: cutMode })
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
                    <div class="merge-result-title">合并完成</div>

                    ${safeOutPath ? `<div>${__escapeHtml((outPath || '').split(/[\\\/]/).pop() || '')}</div>` : ''}
                    
                    ${!fileExists && outPath ? '<div id="fileNotExistWarning" style="color:#ff8080; font-size:12px; background:rgba(255,0,0,0.1); padding:8px; border-radius:6px; width:100%;">⚠ 文件不存在或已被删除</div>' : '<div id="fileNotExistWarning" style="display:none; color:#ff8080; font-size:12px; background:rgba(255,0,0,0.1); padding:8px; border-radius:6px; width:100%;">⚠ 文件不存在或已被删除</div>'}

                    <div class="merge-result-actions">
                            <button id="downloadClipBtn" type="button" ${!fileExists ? 'disabled' : ''}>
                                下载视频${!fileExists ? ' (失效)' : ''}
                            </button>
                            <button id="copyClipLinkBtn" type="button" ${!fileExists ? 'disabled' : ''}>
                                复制链接${!fileExists ? ' (失效)' : ''}
                            </button>
                    </div>
                    <div class="clear-choice-group" style="display:flex; gap:8px; justify-content:center; flex-wrap:wrap; margin-top:6px;">
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
                <div class="merge-result-card">
                    <div class="merge-result-header">
                        <div class="merge-result-title" style="color:#ff9999;">合并失败</div>
                        <div class="merge-result-sub">请检查错误信息后重试</div>
                    </div>
                    <pre class="merge-result-error">${__escapeHtml(errorText)}</pre>
                    <div>
                        <button id="copyErrorBtn" type="button" style="background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.2); color:var(--text-color);">复制错误信息</button>
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

// 点击“预览”按钮
previewBtn.addEventListener('click', async () => {
    if (!currentVideoName) {
        showAlertModal('请先选择视频');
        return;
    }

    const ok = await showConfirmModal(
        '预览视频会消耗大量流量，访问用户较多时可能出现卡顿。\n注意：预览画质可能与最终合并画质不同，仅供效果参考。\n您可以在不预览的情况下直接添加片段。\n\n确定要加载预览吗？',
        { title: '流量提示', okText: '加载预览', cancelText: '取消' }
    );
    if (!ok) return;

    player.src = `/api/video/${encodeURIComponent(currentVideoName)}`;
    __restoreProgressForVideo = currentVideoName;
    playerWrapper.style.display = 'flex'; // 显示包裹层
    __setVideoContainerExpanded(true);
    // 标记为已加载预览（立即取消半透明）
    __mainPreviewActive = true;
    try { refreshVideoStageDim(); } catch (e) { }
    __refreshPreviewInteractiveState();

    // 启动加载监测：如果网络差/缓冲较久，会显示“视频加载中”提示
    _startVideoLoadWatcher(1200);

    // 尝试自动播放（点击属于用户操作，浏览器应允许）
    player.play().catch(() => { /* 自动播放可能被策略阻止，忽略 */ });

    // 核心修改：点击预览后，显示片段工坊面板
    // clipWorkshopPanel.style.display = 'block'; // 已经始终显示，无需再次设置
    updateClipInputs();
    renderNewClipList();
});

function __seekBySeconds(seconds, label) {
    if (!__isVideoReady()) return;
    player.pause();
    player.currentTime = Math.max(0, Math.min((player.currentTime || 0) + seconds, player.duration || 0));
    updateProgress(player.currentTime, player.duration);
    if (typeof progressBar !== 'undefined' && progressBar) progressBar.value = player.currentTime;
    try { showToast(`${label} — ${formatTime(player.currentTime)}`); } catch (err) { }
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
        speedSelectMenu.querySelectorAll('.tl-zoom-menu-item[data-speed]').forEach(function (btn) {
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
        const zoomToggleEl = document.querySelector('#timelineArea .tl-zoom-toggle');
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
        speedSelectGroup.classList.toggle('open');
    });
}

if (speedSelectMenu && speedSelectGroup && speedSelect) {
    speedSelectMenu.querySelectorAll('.tl-zoom-menu-item[data-speed]').forEach((btn) => {
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
        player.play();
    } else {
        player.pause();
    }
}

playPauseBtn.addEventListener('click', togglePlay);

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
        const cur = formatTime(player.currentTime || 0);
        const dur = formatTime(player.duration || 0);
        timeDisplay.textContent = `${cur} / ${dur}`;
        updateProgress(v, player.duration);
        // show tooltip during interaction (tooltip shows scrubbed position)
        showProgressTooltipAt(v);
        // 同步联动时间轴播放头
        if (typeof window.__tlUpdatePlayhead === 'function') window.__tlUpdatePlayhead(v);
    });

    progressBar.addEventListener('change', () => {
        try { if (typeof window.__tlSuppressAutoFollow === 'function') window.__tlSuppressAutoFollow(700); } catch (e) { }
        const dur = Number(player.duration) || 0;
        const target = Math.max(0, Math.min(Number(progressBar.value) || 0, dur > 0 ? dur : 0));
        player.currentTime = target;
        try { if (typeof window.__tlUpdatePlayhead === 'function') window.__tlUpdatePlayhead(target); } catch (e) { }
        __saveProgress(currentVideoName, player.currentTime, player.duration);
        hideProgressTooltip(400);
        try { if (playerWrapper && typeof playerWrapper.focus === 'function') playerWrapper.focus({ preventScroll: true }); } catch (e) { }
    });

    progressBar.addEventListener('click', () => {
        try { if (typeof window.__tlSuppressAutoFollow === 'function') window.__tlSuppressAutoFollow(700); } catch (e) { }
        const dur = Number(player.duration) || 0;
        if (!(dur > 0)) return;
        const target = Math.max(0, Math.min(Number(progressBar.value) || 0, dur));
        player.currentTime = target;
        try { if (typeof window.__tlUpdatePlayhead === 'function') window.__tlUpdatePlayhead(target); } catch (e) { }
        __saveProgress(currentVideoName, player.currentTime, player.duration);
        updateProgress(player.currentTime, player.duration);
    });

    // keyboard accessibility + brief tooltip
    progressBar.addEventListener('keydown', (ev) => {
        if (!player || !player.duration) return;
        let handled = false;
        switch (ev.key) {
            case 'ArrowLeft': player.currentTime = Math.max(0, player.currentTime - 5); handled = true; break;
            case 'ArrowRight': player.currentTime = Math.min(player.duration, player.currentTime + 5); handled = true; break;
            case 'Home': player.currentTime = 0; handled = true; break;
            case 'End': player.currentTime = player.duration; handled = true; break;
            case 'PageUp': player.currentTime = Math.min(player.duration, player.currentTime + 10); handled = true; break;
            case 'PageDown': player.currentTime = Math.max(0, player.currentTime - 10); handled = true; break;
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
    const cur = formatTime(player.currentTime);
    const dur = formatTime(player.duration || 0);
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
    if (progressBar) {
        progressBar.value = player.currentTime;
        updateProgress(player.currentTime, player.duration);
    }
});

// ---------- 视频加载网络提示：若加载超过 1.2s 或触发 waiting/stalled 则提示用户 ----------
let __videoLoadHintTimer = null;
let __videoLoadHintHideTimer = null;
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
    if (__videoLoadHintTimer) { clearTimeout(__videoLoadHintTimer); __videoLoadHintTimer = null; }
}
function _startVideoLoadWatcher(timeoutMs = 1200) {
    const stage = document.getElementById('videoStage');
    if (stage) stage.classList.add('loading');
    if (__videoLoadHintTimer) { clearTimeout(__videoLoadHintTimer); __videoLoadHintTimer = null; }
    hideVideoLoadingHint();
    __videoLoadHintTimer = setTimeout(() => {
        const ready = player && (player.readyState >= 3);
        if (!ready) showVideoLoadingHint('视频加载中（网络较慢）…');
        __videoLoadHintTimer = null;
    }, timeoutMs);
}
player.addEventListener('canplay', () => { hideVideoLoadingHint(); });
player.addEventListener('playing', () => { hideVideoLoadingHint(); });
player.addEventListener('loadeddata', () => { hideVideoLoadingHint(); });
player.addEventListener('error', () => { hideVideoLoadingHint(); showToast('视频加载失败', 'error'); });
player.addEventListener('waiting', () => { showVideoLoadingHint('缓冲中…'); });
player.addEventListener('stalled', () => { showVideoLoadingHint('视频加载中（网络不稳定）…'); });



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

    // [Q] 设定起点（从锚点位置读取，无锚点则从播放头）
    if (key === 'q') {
        const anchorT = (typeof window.__tlGetAnchorTime === 'function') ? window.__tlGetAnchorTime() : null;
        tempStart = roundToMs(anchorT !== null ? anchorT : player.currentTime);
        updateClipInputs();
        showToast(`起点已设定: ${formatTime(tempStart)}`);
        if (quickSetStartBtn) triggerBtnFeedback(quickSetStartBtn);
    }
    // [W] 设定终点（从锚点位置读取），若起点已设定则自动添加片段
    else if (key === 'w') {
        const anchorT = (typeof window.__tlGetAnchorTime === 'function') ? window.__tlGetAnchorTime() : null;
        tempEnd = roundToMs(anchorT !== null ? anchorT : player.currentTime);
        updateClipInputs();
        if (quickSetEndBtn) triggerBtnFeedback(quickSetEndBtn);
        if (tempStart !== null) {
            // 起点已设，自动提交
            __doAddClip();
        } else {
            showToast(`终点已设定: ${formatTime(tempEnd)}，请按 Q 设定起点`);
        }
    }
    // [C] 手动添加片段（作为备选快捷键）
    else if (key === 'c' || key === 'enter') {
        e.preventDefault();
        if (__mergeStatusLastState && __mergeStatusLastState.running === true) {
            showAlertModal('当前正在切片，无法添加片段');
            return;
        }
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
        if (!currentVideoName) {
            try { showAlertModal('请先选择视频'); } catch (err) { }
            return;
        }
        if (tempStart === null) {
            try { showToast('未设定片段起点'); } catch (err) { }
            return;
        }
        try {
            player.pause();
            player.currentTime = Number(tempStart);
            try { showToast('已回到片段起点 — ' + formatTime(tempStart)); } catch (err) { }
        } catch (err) {
            // ignore
        }
    }
    // [D] 跳转播放头到锚点
    else if (key === 'd') {
        e.preventDefault();
        if (typeof window.__tlJumpToAnchor === 'function') window.__tlJumpToAnchor();
    }
    // [J] 锚点定位到当前播放头
    else if (key === 'j') {
        e.preventDefault();
        if (typeof window.__tlPlaceAnchorAtPlayhead === 'function') window.__tlPlaceAnchorAtPlayhead();
    }
    // [ArrowLeft] 锚点后退1秒
    else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (typeof window.__tlMoveAnchor === 'function') window.__tlMoveAnchor(-1);
    }
    // [ArrowRight] 锚点前进1秒
    else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (typeof window.__tlMoveAnchor === 'function') window.__tlMoveAnchor(1);
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
    const __tlThumbStepSec = 30;
    let __tlThumbLastStrip = null;
    let __tlThumbLastDur = 0;
    let __tlThumbLastData = [];
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
    let __tlToolbarResizeObserver = null;
    let __tlCompactLayoutRaf = 0;

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

    // ---- 锚点标记状态（固定指针，不随播放移动）----
    let __tlAnchorTime = null;   // 锚点所在时间（秒），null=未放置

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

    async function _tlBuildThumbs(stepSec = __tlThumbStepSec, onPartial = null, signal = null) {
        const dur = _tlDur();
        if (!dur || !currentVideoName || !__isVideoReady()) return [];

        const step = Math.max(30, Math.floor(Number(stepSec) || __tlThumbStepSec));
        const params = new URLSearchParams({
            name: currentVideoName,
            step: String(step),
            width: '128',
            height: '72',
            quality: '8'
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

    async function _tlEnsureThumbs(stepSec = __tlThumbStepSec, onPartial = null, signal = null) {
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

    function _tlRenderThumbStrip(container, dur, thumbs, stepSec = __tlThumbStepSec) {
        if (!container) return;
        container.innerHTML = '';
        if (!dur || !Array.isArray(thumbs) || thumbs.length === 0) return;

        const inner = _tlInner();
        const innerW = Math.max(1, (inner && (inner.offsetWidth || inner.clientWidth)) || container.clientWidth || 1);

        // 目标：每张缩略图在时间轴上保持接近固定像素宽度，避免过宽/过窄
        const targetTilePx = 96;
        const slotCount = Math.max(1, Math.min(320, Math.ceil(innerW / targetTilePx)));
        const slotDur = dur / slotCount;
        if (!(slotDur > 0)) return;

        const loadedMinTime = Math.max(0, Number(thumbs[0]?.time) || 0);
        const loadedMaxTime = Math.max(loadedMinTime, Number(thumbs[thumbs.length - 1]?.time) || 0);
        const loadedCoverEnd = Math.min(dur, loadedMaxTime + slotDur * 0.5);

        let pickIdx = 0;
        for (let i = 0; i < slotCount; i++) {
            const t = i * slotDur;
            if (t < loadedMinTime - slotDur * 0.5) continue;
            if (t > loadedCoverEnd) continue;

            while (pickIdx + 1 < thumbs.length) {
                const a = Math.abs((Number(thumbs[pickIdx]?.time) || 0) - t);
                const b = Math.abs((Number(thumbs[pickIdx + 1]?.time) || 0) - t);
                if (b <= a) pickIdx += 1;
                else break;
            }

            const thumb = thumbs[pickIdx];
            if (!thumb || !thumb.url) continue;
            const thumbTime = Math.max(0, Number(thumb.time) || 0);
            const maxSnap = Math.max(0.5, Number(stepSec) || __tlThumbStepSec);
            if (Math.abs(thumbTime - t) > maxSnap) continue;

            const leftPct = (t / dur) * 100;
            const nextT = (i === slotCount - 1) ? dur : ((i + 1) * slotDur);
            const widthPct = Math.max(0.01, ((nextT - t) / dur) * 100);

            const seg = document.createElement('div');
            seg.className = 'timeline-thumb';
            seg.style.left = leftPct + '%';
            seg.style.width = widthPct + '%';
            seg.style.backgroundImage = `url(${thumb.url})`;
            container.appendChild(seg);
        }
    }

    function _tlRerenderThumbStripByZoom() {
        if (!__tlThumbEnabled) return;
        if (!__tlThumbLastStrip || !__tlThumbLastStrip.isConnected) return;
        if (!__tlThumbLastDur || !Array.isArray(__tlThumbLastData) || __tlThumbLastData.length === 0) return;
        _tlRenderThumbStrip(__tlThumbLastStrip, __tlThumbLastDur, __tlThumbLastData, __tlThumbStepSec);
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
        try { tempStart = Math.max(0, Math.min(t, _tlDur())); if (typeof updateClipInputs === 'function') updateClipInputs(); } catch (e) { }
    }
    function _applyEnd(t) {
        try { tempEnd = Math.max(0, Math.min(t, _tlDur())); if (typeof updateClipInputs === 'function') updateClipInputs(); } catch (e) { }
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
        if (now < cur.end - 0.03) return;

        if (state.index < state.clips.length - 1) {
            state.index += 1;
            const next = state.clips[state.index];
            try {
                player.currentTime = next.start;
                if (player.paused) player.play().catch(() => { });
            } catch (e) { }
            return;
        }

        _tlStopSelectedPlayback();
        try {
            player.pause();
            player.currentTime = cur.end;
        } catch (e) { }
    }

    function _tlTryPlaySelectedClips() {
        if (__tlSelectedPlayback && (__tlSelectedPlayback.clips || []).length > 0) {
            try { player.play().catch(() => { }); } catch (e) { }
            return true;
        }
        const clips = _tlGetSelectedClipsSorted();
        if (clips.length === 0) return false;
        __tlSelectedPlayback = { clips, index: 0 };
        try {
            player.currentTime = clips[0].start;
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
            try { __invalidateMergeOrderOverride(); } catch (e) { }
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
        document.querySelectorAll('.tl-zoom-menu-item[data-zoom]').forEach(b => {
            b.classList.toggle('active', Number(b.dataset.zoom) === __tlZoom);
        });

        _tlUpdateHandles();
        _tlUpdateSelection();
        _tlUpdatePlayhead();
        _tlRerenderThumbStripByZoom();
        _tlRerenderWaveformByZoom();
        _tlUpdateAnchor();
        _tlSbUpdate();
    }

    // ==================== 主渲染 ====================
    function renderTimeline() {
        const area = document.getElementById('timelineArea');
        if (!area) return;
        const dur = _tlDur();
        const canTimelineInteract = !!(currentVideoName && dur > 0 && __isVideoReady());
        const zoomKey = (currentVideoName && dur > 0) ? `${currentVideoName}__${Math.round(dur)}` : '';
        if (zoomKey && zoomKey !== __tlZoomAutoAppliedKey) {
            __tlZoom = _tlAutoZoomByDuration(dur);
            __tlZoomAutoAppliedKey = zoomKey;
        }
        area.style.display = '';

        const flatAll = __flattenVideoTasksToClips();
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
        zoomGroup.className = 'tl-zoom-group tl-zoom-collapsed';
        const zoomToggle = document.createElement('button');
        zoomToggle.className = 'tl-zoom-btn tl-zoom-toggle';
        zoomToggle.type = 'button';
        zoomToggle.textContent = (__tlZoom === 1 ? '全图' : `${__tlZoom}×`) + ' ▾';
        zoomToggle.title = '选择时间轴缩放倍率';
        zoomToggle.disabled = !canTimelineInteract;
        __tlZoomToggleBtn = zoomToggle;
        const zoomMenu = document.createElement('div');
        zoomMenu.className = 'tl-zoom-menu';
        TL_ZOOM_LEVELS.forEach(z => {
            const btn = document.createElement('button');
            btn.className = 'tl-zoom-menu-item' + (z === __tlZoom ? ' active' : '');
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
            zoomGroup.classList.toggle('open');
        });
        zoomGroup.appendChild(zoomToggle);
        zoomGroup.appendChild(zoomMenu);
        const followBtn = document.createElement('button');
        followBtn.className = 'tl-zoom-btn tl-follow-btn' + (__tlFollowPlayhead ? ' active' : '');
        followBtn.type = 'button';
        followBtn.textContent = '跟随播放';
        followBtn.title = '自动跟随播放指针滚动';
        followBtn.disabled = !canTimelineInteract;
        const thumbBtn = document.createElement('button');
        thumbBtn.className = 'tl-zoom-btn tl-thumb-btn' + (__tlThumbEnabled ? ' active' : '');
        thumbBtn.type = 'button';
        thumbBtn.textContent = '缩略图';
        thumbBtn.title = '显示/隐藏时间轴缩略图';
        thumbBtn.disabled = !canTimelineInteract;
        const waveformBtn = document.createElement('button');
        waveformBtn.className = 'tl-zoom-btn tl-waveform-btn' + (__tlWaveformEnabled ? ' active' : '');
        waveformBtn.type = 'button';
        waveformBtn.textContent = '波形';
        waveformBtn.title = '显示/隐藏音频波形';
        waveformBtn.disabled = !canTimelineInteract;

        const compactActionsGroup = document.createElement('span');
        compactActionsGroup.className = 'tl-zoom-group tl-zoom-collapsed tl-compact-actions';
        const compactActionsToggle = document.createElement('button');
        compactActionsToggle.className = 'tl-zoom-btn tl-zoom-toggle';
        compactActionsToggle.type = 'button';
        compactActionsToggle.textContent = '更多 ▾';
        compactActionsToggle.title = '更多时间轴操作';
        compactActionsToggle.disabled = !canTimelineInteract;
        const compactActionsMenu = document.createElement('div');
        compactActionsMenu.className = 'tl-zoom-menu';
        const compactFollowItem = document.createElement('button');
        compactFollowItem.className = 'tl-zoom-menu-item';
        compactFollowItem.type = 'button';
        compactFollowItem.textContent = '跟随播放';
        compactFollowItem.disabled = !canTimelineInteract;
        const compactThumbItem = document.createElement('button');
        compactThumbItem.className = 'tl-zoom-menu-item';
        compactThumbItem.type = 'button';
        compactThumbItem.textContent = '缩略图';
        compactThumbItem.disabled = !canTimelineInteract;
        const compactWaveformItem = document.createElement('button');
        compactWaveformItem.className = 'tl-zoom-menu-item';
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
        jumpGroup.className = 'tl-zoom-group';
        const jumpButtons = [
            { text: '-5s', title: '后退5秒', click: __seekBack5 },
            { text: '-1s', title: '后退1秒', click: __seekBack1 },
            { text: '+1s', title: '前进1秒', click: __seekForward1 },
            { text: '+5s', title: '前进5秒', click: __seekForward5 }
        ];
        jumpButtons.forEach(item => {
            const btn = document.createElement('button');
            btn.className = 'tl-zoom-btn';
            btn.type = 'button';
            btn.textContent = item.text;
            btn.title = item.title;
            btn.disabled = !canTimelineInteract;
            btn.addEventListener('click', () => { item.click(); });
            jumpGroup.appendChild(btn);
        });
        const delSelectedBtn = document.createElement('button');
        delSelectedBtn.className = 'tl-zoom-btn';
        delSelectedBtn.type = 'button';
        delSelectedBtn.textContent = '删除所选';
        delSelectedBtn.title = '删除已选中的时间轴片段';
        delSelectedBtn.addEventListener('click', () => { _tlDeleteSelectedClips(); });
        __tlDeleteSelectedBtn = delSelectedBtn;

        const timelineToolbar = document.createElement('span');
        timelineToolbar.className = 'timeline-toolbar';

        const leftGroup = document.createElement('span');
        leftGroup.className = 'timeline-toolbar-left';
        if (playPauseBtn) leftGroup.appendChild(playPauseBtn);
        if (timeDisplay) leftGroup.appendChild(timeDisplay);
        if (speedSelectGroup) jumpGroup.appendChild(speedSelectGroup);

        const centerGroup = document.createElement('span');
        centerGroup.className = 'timeline-toolbar-center';
        centerGroup.appendChild(jumpGroup);
        centerGroup.appendChild(zoomGroup);
        centerGroup.appendChild(followBtn);
        centerGroup.appendChild(thumbBtn);
        centerGroup.appendChild(waveformBtn);
        centerGroup.appendChild(compactActionsGroup);
        centerGroup.appendChild(delSelectedBtn);

        const rightGroup = document.createElement('span');
        rightGroup.className = 'timeline-toolbar-right';
        if (openFileTreeBtnMain) rightGroup.appendChild(openFileTreeBtnMain);
        if (fullscreenBtn) rightGroup.appendChild(fullscreenBtn);

        let __playBtnMovedByTimeCollapse = false;

        timelineToolbar.appendChild(leftGroup);
        timelineToolbar.appendChild(centerGroup);
        timelineToolbar.appendChild(rightGroup);

        const _syncCompactActionsLayoutNow = () => {
            if (!centerGroup.isConnected) return;
            centerGroup.classList.remove('compact-actions-on');
            const needCompact = (centerGroup.scrollWidth > centerGroup.clientWidth + 1);
            centerGroup.classList.toggle('compact-actions-on', needCompact);
            if (!needCompact) compactActionsGroup.classList.remove('open');
        };

        const _syncToolbarRowsNow = () => {
            if (!timelineToolbar.isConnected) return;

            timelineToolbar.classList.remove('two-row');
            _syncCompactActionsLayoutNow();

            const style = window.getComputedStyle(timelineToolbar);
            const gapX = Number.parseFloat(style.columnGap || style.gap || '8') || 8;
            const requiredOneRow = leftGroup.scrollWidth + centerGroup.scrollWidth + rightGroup.scrollWidth + (gapX * 2);
            const available = timelineToolbar.clientWidth;
            const needTwoRow = requiredOneRow > (available + 1);

            timelineToolbar.classList.toggle('two-row', needTwoRow);

            const timeCollapsed = !!timeDisplay && (timeDisplay.scrollWidth > (timeDisplay.clientWidth + 1));
            const leftGroupCrowded = !!leftGroup && (leftGroup.scrollWidth > (leftGroup.clientWidth + 1));
            const shouldMovePlayBtn = !!playPauseBtn && needTwoRow && (leftGroupCrowded || timeCollapsed || __playBtnMovedByTimeCollapse);
            if (playPauseBtn) {
                if (shouldMovePlayBtn) {
                    if (playPauseBtn.parentElement !== centerGroup) {
                        centerGroup.insertBefore(playPauseBtn, centerGroup.firstChild || null);
                    }
                } else {
                    if (playPauseBtn.parentElement !== leftGroup) {
                        leftGroup.insertBefore(playPauseBtn, timeDisplay || null);
                    }
                }
            }
            __playBtnMovedByTimeCollapse = shouldMovePlayBtn;

            _syncCompactActionsLayoutNow();
        };

        const _syncCompactActionsLayout = () => {
            if (__tlCompactLayoutRaf) cancelAnimationFrame(__tlCompactLayoutRaf);
            __tlCompactLayoutRaf = requestAnimationFrame(() => {
                __tlCompactLayoutRaf = 0;
                _syncToolbarRowsNow();
            });
        };

        title.appendChild(timelineToolbar);
        title.addEventListener('click', (e) => {
            if (!zoomGroup.contains(e.target)) zoomGroup.classList.remove('open');
            if (!compactActionsGroup.contains(e.target)) compactActionsGroup.classList.remove('open');
        });
        ctn.appendChild(title);

        if (__tlToolbarResizeObserver) {
            try { __tlToolbarResizeObserver.disconnect(); } catch (e) { }
            __tlToolbarResizeObserver = null;
        }
        if (typeof ResizeObserver !== 'undefined') {
            __tlToolbarResizeObserver = new ResizeObserver(() => { _syncCompactActionsLayout(); });
            try { __tlToolbarResizeObserver.observe(timelineToolbar); } catch (e) { }
            try { __tlToolbarResizeObserver.observe(centerGroup); } catch (e) { }
            try { __tlToolbarResizeObserver.observe(leftGroup); } catch (e) { }
            try { __tlToolbarResizeObserver.observe(rightGroup); } catch (e) { }
        }
        _syncCompactActionsLayout();

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
        track.appendChild(thumbsStrip);
        _tlRenderThumbStrip(thumbsStrip, dur, [], __tlThumbStepSec);

        // ---- 波形 canvas ----
        const waveformCanvas = document.createElement('canvas');
        waveformCanvas.className = 'timeline-waveform';
        waveformCanvas.style.display = __tlWaveformEnabled ? '' : 'none';
        __tlWaveformCanvas = waveformCanvas;
        track.appendChild(waveformCanvas);
        track.classList.toggle('has-waveform', !!__tlWaveformEnabled);

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
                _tlRenderThumbStrip(thumbsStrip, dur, [], __tlThumbStepSec);
                return;
            }
            if (!(currentVideoName && dur > 0 && __isVideoReady())) return;
            const myToken = ++__tlThumbRenderToken;
            const ctrl = _tlBeginThumbLoading();
            _tlEnsureThumbs(__tlThumbStepSec, (partialThumbs) => {
                if (myToken !== __tlThumbRenderToken) return;
                if (!thumbsStrip.isConnected) return;
                if (!__tlThumbEnabled) return;
                __tlThumbLastDur = dur;
                __tlThumbLastData = partialThumbs;
                _tlRenderThumbStrip(thumbsStrip, dur, partialThumbs, __tlThumbStepSec);
            }, ctrl.signal).then(thumbs => {
                if (myToken !== __tlThumbRenderToken) return;
                if (!thumbsStrip.isConnected) return;
                if (!__tlThumbEnabled) return;
                __tlThumbLastDur = dur;
                __tlThumbLastData = thumbs;
                _tlRenderThumbStrip(thumbsStrip, dur, thumbs, __tlThumbStepSec);
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
                _tlRenderThumbStrip(thumbsStrip, dur, [], __tlThumbStepSec);
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
                                player.currentTime = clips[targetIdx].start;
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
            _tlEnsureThumbs(__tlThumbStepSec, (partialThumbs) => {
                if (myToken !== __tlThumbRenderToken) return;
                if (!thumbsStrip.isConnected) return;
                if (!__tlThumbEnabled) return;
                __tlThumbLastDur = dur;
                __tlThumbLastData = partialThumbs;
                _tlRenderThumbStrip(thumbsStrip, dur, partialThumbs, __tlThumbStepSec);
            }, ctrl.signal).then(thumbs => {
                if (myToken !== __tlThumbRenderToken) return;
                if (!thumbsStrip.isConnected) return;
                if (!__tlThumbEnabled) return;
                __tlThumbLastDur = dur;
                __tlThumbLastData = thumbs;
                _tlRenderThumbStrip(thumbsStrip, dur, thumbs, __tlThumbStepSec);
            }).catch(() => { });
        }

        // 选区背景
        const selEl = document.createElement('div');
        selEl.className = 'timeline-selection';
        selEl.id = 'tlSelection';
        track.appendChild(selEl);

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

        // 锚点标记（固定指针，不随播放移动）
        const anchor = document.createElement('div');
        anchor.className = 'timeline-anchor';
        anchor.id = 'tlAnchor';
        const anchorLine = document.createElement('div');
        anchorLine.className = 'timeline-anchor-line';
        const anchorArrow = document.createElement('div');
        anchorArrow.className = 'timeline-anchor-arrow';
        const anchorLabel = document.createElement('div');
        anchorLabel.className = 'timeline-anchor-label';
        anchorLabel.id = 'tlAnchorLabel';
        anchor.appendChild(anchorLine);
        anchor.appendChild(anchorArrow);
        anchor.appendChild(anchorLabel);
        track.appendChild(anchor);

        // 锚点箭头可拖拽移动
        anchorArrow.addEventListener('mousedown', e => {
            e.stopPropagation();
            e.preventDefault();
            if (!canTimelineInteract) return;
            anchor.dataset.dragging = '1';
            anchor.classList.add('dragging');
            document.body.style.userSelect = 'none';
        });

        // 初始化锚点位置
        if (__tlAnchorTime !== null && dur > 0) {
            anchor.classList.add('active');
            anchor.style.left = (__tlAnchorTime / dur * 100) + '%';
            anchorLabel.textContent = _tlFmtFull(__tlAnchorTime);
        }

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
        if (emptyHintText) {
            const h = document.createElement('div');
            h.className = 'timeline-empty-hint';
            h.id = 'tlEmptyHint';
            h.textContent = emptyHintText;
            h.style.top = '0';
            h.style.bottom = '0';
            h.style.left = '0';
            h.style.right = '0';
            wrap.appendChild(h);
        }
        const boxSel = document.createElement('div');
        boxSel.className = 'timeline-box-select';
        boxSel.id = 'tlBoxSelectRect';
        boxSel.style.display = 'none';
        wrap.appendChild(boxSel);
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

        // ---- 应用当前缩放（构建标尺 + 更新宽度）----
        requestAnimationFrame(() => {
            _applyZoom();
            _tlUpdatePlayhead();
            _tlUpdateHandles();
            _tlUpdateSelection();
        });

        // （滚轮 / 中键平移已移除，改用挡位按钮 + 自定义滚动条）

        // ---- 交互：框选片段 ----
        wrap.addEventListener('mousedown', e => {
            if (e.button !== 0) return;
            if (e.target.closest('.timeline-handle') || e.target.closest('.timeline-clip') || e.target.closest('.timeline-playhead-arrow-top') || e.target.closest('.timeline-anchor-arrow')) return;
            __tlBoxSelecting = true;
            __tlBoxMoved = false;
            __tlBoxStartX = e.clientX;
            __tlBoxStartY = e.clientY;
            document.body.style.userSelect = 'none';
            const box = document.getElementById('tlBoxSelectRect');
            if (box) box.style.display = 'none';
            e.preventDefault();
        });

        // ---- 交互：点击定位锚点标记（不影响播放头）----
        wrap.addEventListener('click', e => {
            zoomGroup.classList.remove('open');
            if (__tlSuppressWrapClick) { __tlSuppressWrapClick = false; return; }
            if (e.target.closest('.timeline-handle') || e.target.closest('.timeline-clip') || e.target.closest('.timeline-playhead-arrow-top') || e.target.closest('.timeline-anchor-arrow')) return;
            if (!canTimelineInteract) return;
            const innerX = _tlClientToInnerX(e.clientX);
            const t = _tlXToTime(innerX);
            _tlPlaceAnchor(t);
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

    // ---- 锚点标记：放置 / 更新 / 跳转 ----
    function _tlPlaceAnchor(t) {
        const dur = _tlDur();
        if (!dur || !currentVideoName || !__isVideoReady()) return;
        __tlAnchorTime = Math.max(0, Math.min(dur, t));
        _tlUpdateAnchor();
    }

    function _tlUpdateAnchor() {
        const el = document.getElementById('tlAnchor');
        const label = document.getElementById('tlAnchorLabel');
        if (!el) return;
        const dur = _tlDur();
        if (__tlAnchorTime === null || !dur || !currentVideoName || !__isVideoReady()) {
            el.classList.remove('active');
            return;
        }
        el.classList.add('active');
        el.style.left = (__tlAnchorTime / dur * 100) + '%';
        if (label) label.textContent = _tlFmtFull(__tlAnchorTime);
    }

    function _tlJumpToAnchor() {
        if (__tlAnchorTime === null) {
            try { showToast('未设定锚点，请先点击时间轴放置锚点'); } catch (e) { }
            return;
        }
        try { player.currentTime = __tlAnchorTime; } catch (e) { }
        try { showToast('已跳转到锚点 ' + _tlFmtFull(__tlAnchorTime)); } catch (e) { }
    }

    function _tlPlaceAnchorAtPlayhead() {
        if (!currentVideoName || !__isVideoReady()) return;
        const t = player.currentTime;
        _tlPlaceAnchor(t);
        try { showToast('锚点已定位到播放头 ' + _tlFmtFull(t)); } catch (e) { }
    }

    function _tlMoveAnchor(deltaSec) {
        if (!currentVideoName || !__isVideoReady()) return;
        const dur = _tlDur();
        if (!dur) return;
        // 若锚点未设定，以当前播放头位置初始化
        if (__tlAnchorTime === null) __tlAnchorTime = player.currentTime || 0;
        __tlAnchorTime = Math.max(0, Math.min(dur, __tlAnchorTime + deltaSec));
        _tlUpdateAnchor();
        try { showToast((deltaSec > 0 ? '锚点前进' : '锚点后退') + ' ' + Math.abs(deltaSec) + 's → ' + _tlFmtFull(__tlAnchorTime)); } catch (e) { }
    }

    function _tlGetAnchorTime() {
        return __tlAnchorTime;
    }

    // ---- 构造手柄 DOM ----
    function _makeHandle(type, key) {
        const h = document.createElement('div');
        h.className = `timeline-handle timeline-handle-${type}`;
        h.style.left = '-100px';
        h.innerHTML = `
            <div class="timeline-handle-line"></div>
            <div class="timeline-handle-cap">
                <div class="timeline-handle-arrow"></div>
                <div class="timeline-handle-key">${key}</div>
            </div>`;

        h.addEventListener('mousedown', e => {
            e.stopPropagation();
            e.preventDefault();
            __tlDragging = type;
            __tlDragDuration = _tlDur();
            h.classList.add('dragging');
            document.body.style.userSelect = 'none';
        });
        h.addEventListener('touchstart', e => {
            e.stopPropagation();
            __tlDragging = type;
            __tlDragDuration = _tlDur();
            h.classList.add('dragging');
        }, { passive: true });
        return h;
    }

    // ---- 全局 mousemove（播放头拖拽 + 锚点拖拽 + 手柄拖拽 + 平移结束）----
    document.addEventListener('mousemove', e => {
        if (__tlBoxSelecting) {
            _tlUpdateBoxSelection(e.clientX, e.clientY);
            return;
        }
        // 播放头拖拽（剪映风格 scrub）
        if (__tlPlayheadDragging) {
            const inner = _tlInner() || __tlDragTrackEl;
            if (!inner) return;
            const rect = inner.getBoundingClientRect();
            const dur = _tlDur();
            if (!dur) return;
            const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            const t = pct * dur;
            try { player.currentTime = t; } catch (err) { }
            _showTip(`<div>${_tlFmtFull(t)}</div>`, e.clientX, e.clientY);
            return;
        }
        // 锚点拖拽
        {
            const anchorEl = document.getElementById('tlAnchor');
            if (anchorEl && anchorEl.dataset.dragging === '1') {
                const inner = _tlInner() || __tlDragTrackEl;
                if (!inner) return;
                const rect = inner.getBoundingClientRect();
                const dur = _tlDur();
                if (!dur) return;
                const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                const t = pct * dur;
                _tlPlaceAnchor(t);
                _showTip(`<div>锚点: ${_tlFmtFull(t)}</div>`, e.clientX, e.clientY);
                return;
            }
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
        if (__tlBoxSelecting) {
            _tlUpdateBoxSelection(e.clientX, e.clientY);
            const box = document.getElementById('tlBoxSelectRect');
            if (box) box.style.display = 'none';
            __tlSuppressWrapClick = __tlBoxMoved;
            __tlBoxSelecting = false;
            __tlBoxMoved = false;
            document.body.style.userSelect = '';
            return;
        }
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
        {
            const anchorEl = document.getElementById('tlAnchor');
            if (anchorEl && anchorEl.dataset.dragging === '1') {
                delete anchorEl.dataset.dragging;
                anchorEl.classList.remove('dragging');
                document.body.style.userSelect = '';
                _hideTip();
            }
        }
        if (__tlSbDragging) {
            __tlSbDragging = false;
            document.body.style.userSelect = '';
        }
    });

    document.addEventListener('touchend', () => {
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
        const dur = _tlDur();
        const sel = document.getElementById('tlSelection'); if (!sel) return;
        if (!dur || !currentVideoName || !__isVideoReady()) {
            sel.style.display = 'none';
            return;
        }
        const ts = _getTS(), te = _getTE();
        if (ts !== null && te !== null && te > ts) {
            sel.style.left = (ts / dur * 100) + '%';
            sel.style.width = ((te - ts) / dur * 100) + '%';
            sel.style.display = '';
        } else {
            sel.style.display = 'none';
        }
    }

    // ---- 更新播放头 ----
    function _tlUpdatePlayhead(time) {
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
        _tlFollowScroll(target);
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
    function _scheduleRefresh() {
        if (__tlDebounce) return;
        __tlDebounce = setTimeout(() => { __tlDebounce = null; try { renderTimeline(); } catch (e) { } }, 60);
    }
    try {
        const clipListEl = document.getElementById('newClipListContainer');
        if (clipListEl) new MutationObserver(_scheduleRefresh).observe(clipListEl, { childList: true, subtree: true });
    } catch (e) { }

    // ---- MutationObserver：起终点变化 → 更新手柄 ----
    try {
        const obs = new MutationObserver(() => { _tlUpdateHandles(); _tlUpdateSelection(); });
        const opts = { childList: true, characterData: true, subtree: true };
        const sd = document.getElementById('ctrlStartDisp');
        const ed = document.getElementById('ctrlEndDisp');
        if (sd) obs.observe(sd, opts);
        if (ed) obs.observe(ed, opts);
    } catch (e) { }

    // 初始渲染
    try { renderTimeline(); } catch (e) { }

    // 暴露
    window.__tlRenderTimeline = renderTimeline;
    window.__tlUpdateSelection = _tlUpdateSelection;
    window.__tlUpdatePlayhead = _tlUpdatePlayhead;
    window.__tlTryPlaySelectedClips = _tlTryPlaySelectedClips;
    window.__tlJumpToAnchor = _tlJumpToAnchor;
    window.__tlPlaceAnchorAtPlayhead = _tlPlaceAnchorAtPlayhead;
    window.__tlMoveAnchor = _tlMoveAnchor;
    window.__tlGetAnchorTime = _tlGetAnchorTime;
    window.__tlSuppressAutoFollow = function (ms) {
        const hold = Math.max(0, Number(ms) || 0);
        __tlSuppressFollowUntil = Date.now() + hold;
    };

})();


