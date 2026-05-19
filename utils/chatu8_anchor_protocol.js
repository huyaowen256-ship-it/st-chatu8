import {
    chat,
    eventSource,
    event_types,
    getCurrentChatId,
    messageFormatting,
    saveChatConditional,
    saveSettingsDebounced,
} from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { extensionName, EventType } from './config.js';
import { getChatImage, saveChatImage } from './configDatabase.js';
import {
    DEFAULT_KLEIN_PROMPT_OPTIMIZER_SYSTEM_PROMPT,
    KLEIN_PROMPT_OPTIMIZER_REQUEST_TYPE,
    optimizeKleinPromptIfNeeded,
} from './comfy_prompt_optimizer.js';
import { ensureComfyReferenceBootstrap } from './comfy_reference_bootstrap.js?v=20260519_context_character_v3';

const ANCHOR_PREFIX = 'chatu8_img';
const RESULT_PREFIX = 'chatu8_img_result';
const ERROR_PREFIX = 'chatu8_img_error';
const PLACEHOLDER_PREFIX = 'chatu8_img_placeholder';
const PLACEHOLDER_END_PREFIX = 'chatu8_img_placeholder_end';
const IMAGE_TEXT_OPEN = 'image###';
const IMAGE_TEXT_CLOSE = '###';
const DEFAULT_MAX_ANCHORS = 5;
const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000;
const TRACE_VERSION = '20260519_context_character_v3';
const TRACE_LOG_LIMIT = 30;
const TRACE_DETAIL_STRING_LIMIT = 4000;
const EMPTY_IMAGE_SRC = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
const TRACE_STEP_ORDER = [
    { id: 'detect', label: '识别锚点' },
    { id: 'request', label: '构建请求' },
    { id: 'optimize', label: '优化提示词' },
    { id: 'workflow', label: '参考图/工作流' },
    { id: 'submit', label: '提交 ComfyUI' },
    { id: 'wait', label: '等待结果' },
    { id: 'writeback', label: '写回聊天' },
];
const TRACE_STATUS_LABELS = {
    idle: '待机',
    pending: '待处理',
    running: '运行中',
    done: '完成',
    failed: '失败',
    skipped: '跳过',
};

const DEFAULTS = {
    enableChatu8HiddenJsonAnchors: false,
    enableChatu8ImageTextAnchors: true,
    chatu8HiddenJsonMaxAnchors: DEFAULT_MAX_ANCHORS,
    chatu8HiddenJsonShowFailures: true,
    comfyPromptOptimizerEnabled: false,
    comfyPromptOptimizerMode: 'append',
    comfyPromptOptimizerRequestType: KLEIN_PROMPT_OPTIMIZER_REQUEST_TYPE,
    comfyPromptOptimizerFallbackToRaw: true,
    comfyPromptOptimizerUseManualTraits: true,
    comfyPromptOptimizerUseVisionTraits: false,
    comfyPromptOptimizerVisionMode: 'missing_only',
    comfyPromptOptimizerSystemPrompt: DEFAULT_KLEIN_PROMPT_OPTIMIZER_SYSTEM_PROMPT,
    comfyAutoReferenceBootstrapEnabled: false,
};

const processingMessages = new Set();
const liveAnchorPlaceholders = new Map();
const generatedImageRefUrlCache = new Map();
const hydratingGeneratedImages = new WeakMap();
let queue = Promise.resolve();
let traceConsoleRenderTimer = null;

function settings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = {};
    }

    const data = extension_settings[extensionName];
    for (const [key, value] of Object.entries(DEFAULTS)) {
        if (data[key] === undefined) {
            data[key] = value;
        }
    }

    return data;
}

function isEnabled() {
    const data = settings();
    return data.enableChatu8HiddenJsonAnchors === true || data.enableChatu8ImageTextAnchors === true;
}

function clampMaxAnchors(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return DEFAULT_MAX_ANCHORS;
    }

    return Math.min(DEFAULT_MAX_ANCHORS, Math.max(1, Math.floor(parsed)));
}

function stableHash(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

function safeString(value, fallback = '') {
    if (value === undefined || value === null) {
        return fallback;
    }

    return String(value).trim();
}

function safeNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function promptValueToString(value) {
    if (value === undefined || value === null) {
        return '';
    }

    if (Array.isArray(value)) {
        return value.map(promptValueToString).filter(Boolean).join(', ');
    }

    if (typeof value === 'object') {
        return compactPromptParts([
            value.name,
            value.prompt,
            value.description,
            value.tags,
            value.scene,
        ]) || JSON.stringify(value);
    }

    return safeString(value);
}

function safeCommentJson(value) {
    return JSON.stringify(value)
        .replaceAll('--', '- -')
        .replaceAll('<', '\\u003c')
        .replaceAll('>', '\\u003e');
}

function escapeHtml(value) {
    return safeString(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function escapeRegExp(value) {
    return safeString(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getTraceLog() {
    const data = settings();
    if (!Array.isArray(data.chatu8AnchorTraceLog)) {
        data.chatu8AnchorTraceLog = [];
    }

    return data.chatu8AnchorTraceLog;
}

function trimTraceLog() {
    const log = getTraceLog();
    if (log.length > TRACE_LOG_LIMIT) {
        log.splice(0, log.length - TRACE_LOG_LIMIT);
    }
}

function scheduleTraceConsoleRender() {
    if (traceConsoleRenderTimer || typeof window === 'undefined') {
        return;
    }

    traceConsoleRenderTimer = window.setTimeout(() => {
        traceConsoleRenderTimer = null;
        renderTraceConsole();
    }, 120);
}

function shouldRedactTraceKey(key) {
    return /api[_-]?key|authorization|bearer|password|secret|token/i.test(String(key || ''));
}

function trimTraceString(value, limit = TRACE_DETAIL_STRING_LIMIT) {
    const text = safeString(value);
    if (!text) {
        return '';
    }

    if (/^data:(image|video)\//i.test(text)) {
        const comma = text.indexOf(',');
        const head = comma >= 0 ? text.slice(0, Math.min(comma + 1, 96)) : text.slice(0, 96);
        return `${head}...[${text.length} chars]`;
    }

    if (text.length <= limit) {
        return text;
    }

    return `${text.slice(0, limit)}... [truncated ${text.length - limit} chars]`;
}

function sanitizeTraceValue(value, options = {}) {
    const depth = options.depth || 0;
    const key = options.key || '';
    const redact = options.redact === true;
    if (redact && shouldRedactTraceKey(key)) {
        return '[redacted]';
    }

    if (value instanceof Error) {
        return {
            name: value.name,
            message: value.message,
            stack: trimTraceString(value.stack || ''),
        };
    }

    if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') {
        return value ?? null;
    }

    if (typeof value === 'string') {
        return trimTraceString(value);
    }

    if (Array.isArray(value)) {
        if (depth >= 4) {
            return `[array:${value.length}]`;
        }

        return value.slice(0, 30).map((item, index) => sanitizeTraceValue(item, {
            depth: depth + 1,
            key: `${key}[${index}]`,
            redact,
        }));
    }

    if (typeof value === 'object') {
        if (depth >= 4) {
            return '[object]';
        }

        const result = {};
        for (const [childKey, childValue] of Object.entries(value).slice(0, 80)) {
            result[childKey] = sanitizeTraceValue(childValue, {
                depth: depth + 1,
                key: childKey,
                redact,
            });
        }
        return result;
    }

    return trimTraceString(String(value));
}

function createTraceSteps() {
    const steps = {};
    for (const step of TRACE_STEP_ORDER) {
        steps[step.id] = {
            label: step.label,
            status: 'pending',
        };
    }
    return steps;
}

function findTrace(traceId) {
    return getTraceLog().find((trace) => trace.trace_id === traceId) || null;
}

function selectedTrace() {
    const log = getTraceLog();
    if (!log.length) {
        return null;
    }

    const selectedId = typeof window !== 'undefined' ? window.__stChatu8SelectedTraceId : '';
    return findTrace(selectedId) || log[log.length - 1];
}

function persistTraceLog(render = true) {
    trimTraceLog();
    saveSettingsDebounced();
    if (render) {
        scheduleTraceConsoleRender();
    }
}

function traceEvent(trace, label, detail = {}, persist = true) {
    if (!trace) {
        return;
    }

    if (!Array.isArray(trace.events)) {
        trace.events = [];
    }

    trace.events.push({
        at: new Date().toISOString(),
        label,
        detail: sanitizeTraceValue(detail),
    });
    if (trace.events.length > 80) {
        trace.events.splice(0, trace.events.length - 80);
    }
    trace.updated_at = new Date().toISOString();
    if (persist) {
        persistTraceLog();
    }
    refreshLiveAnchorPlaceholder(trace);
}

function traceStep(trace, stepId, status, detail = {}, persist = true) {
    if (!trace || !stepId) {
        return;
    }

    const now = new Date().toISOString();
    if (!trace.steps || typeof trace.steps !== 'object') {
        trace.steps = createTraceSteps();
    }
    if (!trace.steps[stepId]) {
        trace.steps[stepId] = {
            label: TRACE_STEP_ORDER.find((step) => step.id === stepId)?.label || stepId,
            status: 'pending',
        };
    }

    const step = trace.steps[stepId];
    step.status = status;
    if (!step.started_at && (status === 'running' || status === 'done' || status === 'failed' || status === 'skipped')) {
        step.started_at = now;
    }
    if (status === 'done' || status === 'failed' || status === 'skipped') {
        step.ended_at = now;
    }
    if (detail && Object.keys(detail).length) {
        step.detail = {
            ...(step.detail || {}),
            ...sanitizeTraceValue(detail),
        };
    }

    trace.updated_at = now;
    if (status === 'running' && trace.status !== 'failed') {
        trace.status = 'running';
    }
    traceEvent(trace, `step:${stepId}:${status}`, detail, false);
    if (persist) {
        persistTraceLog();
    }
}

function createTrace(anchor, request, messageId, reason) {
    const now = new Date().toISOString();
    const rawPrompt = safeString(request?.debugPromptRaw || request?.prompt);
    const trace = {
        trace_id: `trace_${Date.now().toString(36)}_${messageId}_${stableHash(`${anchor.id}:${Math.random()}`)}`,
        version: TRACE_VERSION,
        status: 'running',
        reason,
        started_at: now,
        updated_at: now,
        ended_at: null,
        chat_id: getCurrentChatId(),
        message_id: messageId,
        anchor_id: anchor.id,
        anchor_type: anchor.type || 'hidden_json',
        request_id: request?.id || '',
        mode: request?.mode || '',
        workflow_adapter: request?.workflowAdapter || '',
        prompt_preview: trimTraceString(rawPrompt, 220),
        source_context: trimTraceString(request?.debugSourceContext || '', 1200),
        prompt_raw: trimTraceString(rawPrompt),
        prompt_optimized: '',
        prompt_final: '',
        prompt_comfy: '',
        prompt_mismatch: false,
        reference_path: '',
        reference_image: '',
        workflow_adapter_actual: '',
        steps: createTraceSteps(),
        events: [],
    };

    traceStep(trace, 'detect', 'done', {
        anchor_id: anchor.id,
        anchor_type: anchor.type || 'hidden_json',
        source: anchor.data?.source || anchor.type || 'hidden_json',
    }, false);
    traceStep(trace, 'request', request?.prompt ? 'done' : 'failed', {
        request_id: request?.id || '',
        width: request?.width,
        height: request?.height,
        mode: request?.mode || '',
        workflow_adapter: request?.workflowAdapter || '',
        prompt_empty: !request?.prompt,
    }, false);
    return trace;
}

function appendTrace(trace) {
    if (!trace) {
        return;
    }

    const log = getTraceLog();
    log.push(trace);
    trimTraceLog();
    if (typeof window !== 'undefined') {
        window.__stChatu8SelectedTraceId = trace.trace_id;
    }
    persistTraceLog();
}

function finishTrace(trace, status, detail = {}) {
    if (!trace) {
        return;
    }

    const now = new Date().toISOString();
    trace.status = status;
    trace.ended_at = now;
    trace.updated_at = now;
    if (detail && Object.keys(detail).length) {
        trace.final = sanitizeTraceValue(detail);
    }
    traceEvent(trace, `trace:${status}`, detail, false);
    persistTraceLog();
    refreshLiveAnchorPlaceholder(trace);
}

function failTrace(trace, error, detail = {}) {
    if (!trace) {
        return;
    }

    const runningStep = TRACE_STEP_ORDER.find((step) => trace.steps?.[step.id]?.status === 'running')?.id;
    if (runningStep) {
        traceStep(trace, runningStep, 'failed', { error: error?.message || String(error) }, false);
    }
    finishTrace(trace, 'failed', {
        ...detail,
        error: sanitizeTraceValue(error, { redact: true }),
    });
}

function summarizeComfyResponse(response) {
    return sanitizeTraceValue({
        success: response?.success,
        change: response?.change,
        isVideo: response?.isVideo,
        format: response?.format,
        hasImageData: Boolean(response?.imageData || response?.image || response?.url),
        imageData: response?.imageData || response?.image || response?.url || '',
        prompt: response?.prompt,
        error: response?.error,
        message: response?.message,
        exception_type: response?.exception_type,
        exception_message: response?.exception_message,
        node_errors: response?.node_errors || response?.nodeErrors,
        validation_errors: response?.validation_errors || response?.prompt_outputs_failed_validation,
        details: response?.details || response?.detail,
    }, { redact: true });
}

function stringifyComfyErrorDetail(value) {
    if (value === null || value === undefined || value === '') {
        return '';
    }
    if (typeof value === 'string') {
        return value;
    }
    try {
        return JSON.stringify(sanitizeTraceValue(value, { redact: true }));
    } catch (_error) {
        return safeString(value);
    }
}

function comfyResponseErrorText(response) {
    const parts = [
        response?.error,
        response?.message,
        response?.exception_message,
        response?.exception_type,
        response?.node_errors || response?.nodeErrors,
        response?.validation_errors || response?.prompt_outputs_failed_validation,
        response?.details || response?.detail,
    ].map(stringifyComfyErrorDetail).filter(Boolean);
    return shortHumanText(parts.join('\n'), 1200);
}

function normalizePromptForCompare(value) {
    return safeString(value).replace(/\s+/g, ' ').trim();
}

function sameTracePrompt(left, right) {
    const a = normalizePromptForCompare(left);
    const b = normalizePromptForCompare(right);
    return Boolean(a && b && a === b);
}

function currentComfyDebugRecord(response = null) {
    return response?.comfyDebug || (typeof window !== 'undefined' ? window.stChatu8ComfyDebugLast || null : null);
}

function summarizeComfyDebug(debug) {
    if (!debug) {
        return null;
    }

    return sanitizeTraceValue({
        workflowAdapter: debug.workflowAdapter,
        positivePrompt: debug.positivePrompt || debug.klein?.prompt || '',
        debugPromptRaw: debug.debugPromptRaw,
        debugPromptOptimized: debug.debugPromptOptimized,
        debugPromptFinal: debug.debugPromptFinal,
        referencePath: debug.referencePath,
        referenceImageFileName: debug.referenceImageFileName,
        promptOptimizerStatus: debug.promptOptimizerStatus,
        promptOptimizerReason: debug.promptOptimizerReason,
    }, { redact: true });
}

function captureComfyDebugForTrace(trace, response = null) {
    const debug = currentComfyDebugRecord(response);
    if (!trace || !debug) {
        return summarizeComfyDebug(debug);
    }

    const comfyPrompt = safeString(debug.positivePrompt || debug.klein?.prompt || debug.debugPromptFinal || '');
    const requestPrompt = safeString(trace.prompt_final || trace.prompt_optimized || trace.prompt_raw || trace.prompt_preview);
    if (comfyPrompt) {
        trace.prompt_comfy = trimTraceString(comfyPrompt);
    }
    trace.prompt_mismatch = Boolean(comfyPrompt && requestPrompt && !sameTracePrompt(comfyPrompt, requestPrompt));
    trace.reference_path = trimTraceString(debug.referencePath || '');
    trace.reference_image = trimTraceString(debug.referenceImageFileName || '');
    trace.workflow_adapter_actual = safeString(debug.workflowAdapter || trace.workflow_adapter || '');
    return summarizeComfyDebug(debug);
}

function optimizerStepStatus(finalRequest) {
    const status = safeString(finalRequest?.debugPromptOptimizerStatus);
    if (!status || status === 'off' || status === 'raw' || status === 'fallback_raw') {
        return 'skipped';
    }

    return 'done';
}

function currentTraceStep(trace) {
    if (!trace) {
        return null;
    }

    const running = TRACE_STEP_ORDER.find((step) => trace.steps?.[step.id]?.status === 'running');
    if (running) {
        return running;
    }

    const failed = TRACE_STEP_ORDER.find((step) => trace.steps?.[step.id]?.status === 'failed');
    if (failed) {
        return failed;
    }

    const completed = [...TRACE_STEP_ORDER].reverse().find((step) => trace.steps?.[step.id]?.status === 'done' || trace.steps?.[step.id]?.status === 'skipped');
    return completed || TRACE_STEP_ORDER[0];
}

function formatTraceTime(value) {
    if (!value) {
        return '';
    }

    try {
        return new Date(value).toLocaleTimeString();
    } catch (_error) {
        return value;
    }
}

function formatTraceDuration(trace) {
    if (!trace?.started_at) {
        return '';
    }

    const start = new Date(trace.started_at).getTime();
    const end = trace.ended_at ? new Date(trace.ended_at).getTime() : Date.now();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
        return '';
    }

    const seconds = Math.round((end - start) / 1000);
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function traceSettingsSnapshot() {
    const data = settings();
    const requestType = safeString(data.comfyPromptOptimizerRequestType, KLEIN_PROMPT_OPTIMIZER_REQUEST_TYPE);
    const requestConfig = data.llm_request_type_configs?.[requestType] || {};
    return {
        image_text_enabled: data.enableChatu8ImageTextAnchors === true,
        hidden_json_enabled: data.enableChatu8HiddenJsonAnchors === true,
        max_anchors: clampMaxAnchors(data.chatu8HiddenJsonMaxAnchors),
        show_failures: data.chatu8HiddenJsonShowFailures !== false,
        optimizer_enabled: data.comfyPromptOptimizerEnabled === true,
        optimizer_mode: safeString(data.comfyPromptOptimizerMode, 'append'),
        optimizer_request_type: requestType,
        optimizer_api_profile: safeString(requestConfig.api_profile),
        optimizer_context_profile: safeString(requestConfig.context_profile),
        optimizer_fallback_to_raw: data.comfyPromptOptimizerFallbackToRaw !== false,
    };
}

function buildTraceDiagnostics(trace, includeComfyDebug = true) {
    if (!trace) {
        return null;
    }

    return sanitizeTraceValue({
        schema: 'st-chatu8-anchor-trace.v1',
        copied_at: new Date().toISOString(),
        protocol_version: TRACE_VERSION,
        chat_id: getCurrentChatId(),
        settings: traceSettingsSnapshot(),
        prompt_compare: {
            source_context: trace?.source_context || '',
            raw: trace?.prompt_raw || '',
            final: trace?.prompt_final || '',
            comfy: trace?.prompt_comfy || '',
            rewrite_status: tracePromptRewriteStatus(trace),
        },
        trace,
        comfy_debug_last: includeComfyDebug && typeof window !== 'undefined' ? window.stChatu8ComfyDebugLast || null : null,
    }, { redact: true });
}

function traceReadableStatus(status) {
    return TRACE_STATUS_LABELS[status] || safeString(status, '未知');
}

function tracePromptText(trace) {
    return safeString(trace?.prompt_comfy || trace?.prompt_final || trace?.prompt_optimized || trace?.prompt_raw || trace?.prompt_preview);
}

function shortHumanText(value, limit = 140) {
    const text = safeString(value).replace(/\s+/g, ' ');
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function tracePromptRewriteStatus(trace) {
    const rawPrompt = safeString(trace?.prompt_raw || trace?.prompt_preview);
    const finalPrompt = safeString(trace?.prompt_final || trace?.prompt_optimized);
    const comfyPrompt = safeString(trace?.prompt_comfy);
    if (comfyPrompt && finalPrompt && !sameTracePrompt(comfyPrompt, finalPrompt)) {
        return '是：实际送入 ComfyUI 的文本不同';
    }
    if (finalPrompt && rawPrompt && !sameTracePrompt(finalPrompt, rawPrompt)) {
        return '是：请求最终提示词不同';
    }
    if (comfyPrompt || finalPrompt || rawPrompt) {
        return '否';
    }
    return '未记录';
}

function traceSubject(trace) {
    const prompt = tracePromptText(trace);
    const match = prompt.match(/^\s*Subject\s*:\s*([^.\n]+)/i)
        || prompt.match(/(?:角色|人物|主体)\s*[:：]\s*([^，。,\n]+)/);
    return shortHumanText(match?.[1] || '', 80);
}

function traceErrorText(trace) {
    const finalError = trace?.final?.error;
    if (typeof finalError === 'string') {
        return shortHumanText(finalError, 260);
    }
    if (finalError?.message) {
        return shortHumanText(finalError.message, 260);
    }

    const events = Array.isArray(trace?.events) ? trace.events : [];
    for (const event of events.slice().reverse()) {
        const detail = event?.detail || {};
        const error = detail.error || detail.response?.error;
        if (typeof error === 'string') {
            return shortHumanText(error, 260);
        }
        if (error?.message) {
            return shortHumanText(error.message, 260);
        }
    }

    return '';
}

function traceCompactTitle(trace) {
    const subject = traceSubject(trace);
    if (subject) {
        return `主体：${subject}`;
    }
    if (trace?.anchor_id) {
        return `图片锚点：${trace.anchor_id}`;
    }
    return shortHumanText(trace?.prompt_preview || trace?.trace_id || '生图任务', 80);
}

function traceCompactMeta(trace) {
    const step = currentTraceStep(trace);
    const bits = [
        traceReadableStatus(trace?.status),
        step?.label || '',
        formatTraceTime(trace?.updated_at),
        trace?.anchor_id ? `锚点 ${trace.anchor_id}` : '',
    ].filter(Boolean);
    return bits.join(' · ');
}

function traceWorkflowLabel(trace) {
    const actual = safeString(trace?.workflow_adapter_actual);
    const requested = safeString(trace?.workflow_adapter);
    const adapter = actual || requested;
    if (adapter === 'generic-reference') {
        return '当前设置工作流（通用参考图补丁）';
    }
    if (adapter === 'flux2-klein-reference') {
        return 'Klein 参考图适配器';
    }
    if (adapter === 'flux2-klein-no-reference-bootstrap') {
        return '角色首参考图生成工作流';
    }
    if (adapter === 'reference-bootstrap-worker') {
        return '角色首参考图生成工作流';
    }
    return adapter || '默认 ComfyUI';
}

function traceReadableRows(trace) {
    const step = currentTraceStep(trace);
    const subject = traceSubject(trace);
    const error = traceErrorText(trace);
    const reference = trace?.reference_image || trace?.reference_path || '';
    return [
        ['状态', traceReadableStatus(trace?.status)],
        ['当前步骤', step?.label || '待处理'],
        ['更新时间', formatTraceTime(trace?.updated_at)],
        ['耗时', formatTraceDuration(trace)],
        ['主体', subject || '未识别'],
        ['提示词被改写', tracePromptRewriteStatus(trace)],
        ['正文附近', trace?.source_context ? shortHumanText(trace.source_context, 120) : '未记录'],
        ['参考图', reference || '未记录'],
        ['锚点', trace?.anchor_id || '无'],
        ['模式', trace?.mode || '默认'],
        ['工作流', traceWorkflowLabel(trace)],
        ...(error ? [['失败原因', error]] : []),
    ].filter(([, value]) => safeString(value));
}

function buildTracePromptCompareHtml(trace, options = {}) {
    const sourceContext = safeString(trace?.source_context);
    const rawPrompt = safeString(trace?.prompt_raw || trace?.prompt_preview);
    const finalPrompt = safeString(trace?.prompt_final || trace?.prompt_optimized);
    const comfyPrompt = safeString(trace?.prompt_comfy);
    const formatPrompt = (value) => options.fullPrompt ? value : shortHumanText(value, 420);
    const rows = [];

    if (sourceContext) {
        rows.push(['锚点附近正文', formatPrompt(sourceContext)]);
    }
    if (rawPrompt) {
        rows.push(['image### 提示词', formatPrompt(rawPrompt)]);
    }
    if (finalPrompt) {
        rows.push(['请求最终提示词', rawPrompt && sameTracePrompt(finalPrompt, rawPrompt) ? '同 image### 提示词' : formatPrompt(finalPrompt)]);
    }
    if (comfyPrompt) {
        rows.push(['实际送入 ComfyUI', (finalPrompt || rawPrompt) && sameTracePrompt(comfyPrompt, finalPrompt || rawPrompt) ? '同请求最终提示词' : formatPrompt(comfyPrompt)]);
    } else if (trace?.status === 'done') {
        rows.push(['实际送入 ComfyUI', '旧任务未记录，从下一次生成开始会显示']);
    }

    if (!rows.length) {
        return '<div class="st-chatu8-anchor-readable-prompt"><span>提示词链路</span><p>还没有生成到提示词步骤</p></div>';
    }

    const html = rows.map(([label, value]) => (
        `<p><b>${escapeHtml(label)}：</b>${escapeHtml(value)}</p>`
    )).join('');
    return `<div class="st-chatu8-anchor-readable-prompt"><span>提示词链路</span>${html}</div>`;
}

function buildReadableTraceHtml(trace, options = {}) {
    const rows = traceReadableRows(trace).map(([label, value]) => (
        `<div class="st-chatu8-anchor-readable-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`
    )).join('');
    const promptBlock = buildTracePromptCompareHtml(trace, options);
    const hint = options.compact ? '<div class="st-chatu8-anchor-readable-hint">点这里放大查看完整提示词和排查信息</div>' : '';
    return `<div class="st-chatu8-anchor-readable">${rows}${promptBlock}${hint}</div>`;
}

function closeTraceDetailDialog() {
    document.getElementById('st-chatu8-trace-detail-dialog')?.remove();
}

function showTraceDetailDialog(trace) {
    if (!trace || typeof document === 'undefined') {
        return;
    }

    closeTraceDetailDialog();
    const prompt = tracePromptText(trace);
    const overlay = document.createElement('div');
    overlay.id = 'st-chatu8-trace-detail-dialog';
    overlay.className = 'st-chatu8-trace-detail-dialog';

    const panel = document.createElement('div');
    panel.className = 'st-chatu8-trace-detail-panel';

    const header = document.createElement('div');
    header.className = 'st-chatu8-trace-detail-header';
    const title = document.createElement('strong');
    title.textContent = '生图任务详情';
    const close = document.createElement('button');
    close.type = 'button';
    close.title = '关闭';
    close.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    close.addEventListener('click', closeTraceDetailDialog);
    header.append(title, close);

    const body = document.createElement('div');
    body.className = 'st-chatu8-trace-detail-body';
    body.innerHTML = buildReadableTraceHtml(trace, { fullPrompt: true });

    if (prompt) {
        const textarea = document.createElement('textarea');
        textarea.readOnly = true;
        textarea.className = 'st-chatu8-trace-detail-prompt';
        textarea.value = prompt;
        body.appendChild(textarea);
    }

    const actions = document.createElement('div');
    actions.className = 'st-chatu8-trace-detail-actions';
    const copyPrompt = document.createElement('button');
    copyPrompt.type = 'button';
    copyPrompt.textContent = '复制提示词';
    copyPrompt.disabled = !prompt;
    copyPrompt.addEventListener('click', async () => {
        await copyText(prompt);
        copyPrompt.textContent = '已复制';
        setTimeout(() => {
            copyPrompt.textContent = '复制提示词';
        }, 1200);
    });
    const copyJson = document.createElement('button');
    copyJson.type = 'button';
    copyJson.textContent = '复制排查包';
    copyJson.addEventListener('click', async () => {
        await copyText(JSON.stringify(buildTraceDiagnostics(trace, true), null, 2));
        copyJson.textContent = '已复制';
        setTimeout(() => {
            copyJson.textContent = '复制排查包';
        }, 1200);
    });
    actions.append(copyPrompt, copyJson);

    panel.append(header, body, actions);
    overlay.append(panel);
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) {
            closeTraceDetailDialog();
        }
    });
    document.body.appendChild(overlay);
}

function traceStatusClass(status) {
    if (status === 'done') {
        return 'st-chatu8-anchor-status-done';
    }
    if (status === 'failed') {
        return 'st-chatu8-anchor-status-failed';
    }
    if (status === 'running') {
        return 'st-chatu8-anchor-status-running';
    }
    if (status === 'skipped') {
        return 'st-chatu8-anchor-status-skipped';
    }
    return '';
}

function renderTraceSurface({ summary, timeline, list, detail }, options = {}) {
    if (!summary || !timeline || !list || !detail) {
        return false;
    }

    const log = getTraceLog();
    const trace = selectedTrace();
    if (!trace) {
        summary.innerHTML = '<span class="st-chatu8-anchor-status-pill">待机</span><span>暂无生图任务</span>';
        timeline.innerHTML = TRACE_STEP_ORDER.map((step) => `<div class="st-chatu8-anchor-step" data-status="pending">${escapeHtml(step.label)}</div>`).join('');
        list.innerHTML = '<div class="st-chatu8-anchor-trace-meta">暂无日志</div>';
        detail.classList.add('is-humanized');
        detail.textContent = '暂无日志';
        return true;
    }

    const doneCount = log.filter((item) => item.status === 'done').length;
    const failedCount = log.filter((item) => item.status === 'failed').length;
    const activeStep = currentTraceStep(trace);
    const statusLabel = traceReadableStatus(trace.status);
    summary.innerHTML = [
        `<span class="st-chatu8-anchor-status-pill ${traceStatusClass(trace.status)}">${escapeHtml(statusLabel)}</span>`,
        `<strong>${escapeHtml(activeStep?.label || '任务')}</strong>`,
        `<span>${escapeHtml(formatTraceTime(trace.updated_at))}</span>`,
        `<span>${escapeHtml(formatTraceDuration(trace))}</span>`,
        `<span>成功 ${doneCount} / 失败 ${failedCount} / 共 ${log.length}</span>`,
    ].join('');

    timeline.innerHTML = TRACE_STEP_ORDER.map((step) => {
        const state = trace.steps?.[step.id] || { status: 'pending', label: step.label };
        const label = `${step.label} · ${traceReadableStatus(state.status || 'pending')}`;
        return `<div class="st-chatu8-anchor-step" data-status="${escapeHtml(state.status || 'pending')}" title="${escapeHtml(label)}">${escapeHtml(step.label)}</div>`;
    }).join('');

    list.innerHTML = log.slice().reverse().map((item) => {
        const selected = item.trace_id === trace.trace_id ? ' is-selected' : '';
        return [
            `<button class="st-chatu8-anchor-trace-item${selected}" type="button" data-trace-id="${escapeHtml(item.trace_id)}">`,
            `<span class="st-chatu8-anchor-trace-title">${escapeHtml(traceCompactTitle(item))}</span>`,
            `<span class="st-chatu8-anchor-status-pill ${traceStatusClass(item.status)}">${escapeHtml(traceReadableStatus(item.status))}</span>`,
            `<span class="st-chatu8-anchor-trace-meta">${escapeHtml(traceCompactMeta(item))}</span>`,
            '</button>',
        ].join('');
    }).join('');

    for (const button of list.querySelectorAll('[data-trace-id]')) {
        if (button.dataset.stChatu8TraceBound === TRACE_VERSION) {
            continue;
        }
        button.addEventListener('click', () => {
            if (typeof window !== 'undefined') {
                window.__stChatu8SelectedTraceId = button.dataset.traceId;
            }
            renderTraceConsole();
        });
        button.dataset.stChatu8TraceBound = TRACE_VERSION;
    }

    detail.classList.add('is-humanized');
    detail.dataset.traceId = trace.trace_id || '';
    detail.tabIndex = 0;
    detail.title = '点击放大查看完整提示词和排查信息';
    detail.innerHTML = buildReadableTraceHtml(trace, { compact: true });
    if (detail.dataset.stChatu8TraceBound !== TRACE_VERSION) {
        const openDetail = () => showTraceDetailDialog(findTrace(detail.dataset.traceId) || selectedTrace());
        detail.addEventListener('click', openDetail);
        detail.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openDetail();
            }
        });
        detail.dataset.stChatu8TraceBound = TRACE_VERSION;
    }
    return true;
}

function renderTraceConsole() {
    if (typeof document === 'undefined') {
        return;
    }

    renderTraceSurface({
        summary: document.getElementById('st_chatu8_anchor_trace_summary'),
        timeline: document.getElementById('st_chatu8_anchor_trace_timeline'),
        list: document.getElementById('st_chatu8_anchor_trace_list'),
        detail: document.getElementById('st_chatu8_anchor_trace_detail'),
    });
    renderFloatingWorkbench();
}

async function copyText(text) {
    if (typeof navigator !== 'undefined' && navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
}

function setTemporaryTraceStatus(element, text) {
    if (!element) {
        return;
    }

    element.textContent = text;
    setTimeout(() => {
        if (element.textContent === text) {
            element.textContent = '';
        }
    }, 1800);
}

async function copySelectedTraceDiagnostics(statusElement = null) {
    const trace = selectedTrace();
    if (!trace) {
        setTemporaryTraceStatus(statusElement, '无日志');
        return;
    }

    await copyText(JSON.stringify(buildTraceDiagnostics(trace, true), null, 2));
    setTemporaryTraceStatus(statusElement, '已复制');
}

function clearTraceDiagnostics(statusElement = null) {
    settings().chatu8AnchorTraceLog = [];
    if (typeof window !== 'undefined') {
        window.__stChatu8SelectedTraceId = '';
    }
    persistTraceLog();
    setTemporaryTraceStatus(statusElement, '已清空');
}

function bindTraceConsoleUi() {
    if (typeof document === 'undefined') {
        return;
    }

    const copyButton = document.getElementById('st_chatu8_anchor_trace_copy');
    const clearButton = document.getElementById('st_chatu8_anchor_trace_clear');
    const copyStatus = document.getElementById('st_chatu8_anchor_trace_copy_status');

    if (copyButton && copyButton.dataset.stChatu8TraceBound !== TRACE_VERSION) {
        copyButton.addEventListener('click', async () => {
            try {
                await copySelectedTraceDiagnostics(copyStatus);
            } catch (error) {
                if (copyStatus) {
                    copyStatus.textContent = '复制失败';
                }
                console.warn('[st-chatu8] Failed to copy anchor trace diagnostics:', error);
            }
        });
        copyButton.dataset.stChatu8TraceBound = TRACE_VERSION;
    }

    if (clearButton && clearButton.dataset.stChatu8TraceBound !== TRACE_VERSION) {
        clearButton.addEventListener('click', () => {
            clearTraceDiagnostics(copyStatus);
        });
        clearButton.dataset.stChatu8TraceBound = TRACE_VERSION;
    }

    renderTraceConsole();
}

function ensureFloatingWorkbenchStyles() {
    if (typeof document === 'undefined' || document.getElementById('st_chatu8_anchor_workbench_styles')) {
        return;
    }

    const style = document.createElement('style');
    style.id = 'st_chatu8_anchor_workbench_styles';
    style.textContent = `
        #st_chatu8_anchor_workbench {
            position: fixed;
            right: 16px;
            bottom: 78px;
            z-index: 50000;
            width: min(460px, calc(100vw - 24px));
            color: #edf3f7;
            font: 12px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            letter-spacing: 0;
            pointer-events: none;
        }

        #st_chatu8_anchor_workbench *,
        #st_chatu8_anchor_workbench *::before,
        #st_chatu8_anchor_workbench *::after {
            box-sizing: border-box;
            letter-spacing: 0;
        }

        #st_chatu8_anchor_workbench button {
            font: inherit;
        }

        #st_chatu8_anchor_workbench .st-chatu8-anchor-workbench-toggle,
        #st_chatu8_anchor_workbench .st-chatu8-anchor-workbench-panel {
            pointer-events: auto;
        }

        #st_chatu8_anchor_workbench .st-chatu8-anchor-workbench-toggle {
            display: flex;
            align-items: center;
            gap: 9px;
            min-height: 44px;
            max-width: 100%;
            margin-left: auto;
            padding: 8px 11px;
            border: 1px solid rgba(132, 148, 156, 0.38);
            border-radius: 8px;
            background: rgba(16, 20, 24, 0.94);
            color: #edf3f7;
            box-shadow: 0 12px 34px rgba(0, 0, 0, 0.34);
            cursor: pointer;
        }

        #st_chatu8_anchor_workbench.is-open .st-chatu8-anchor-workbench-toggle {
            display: none;
        }

        #st_chatu8_anchor_workbench .st-chatu8-anchor-workbench-dot {
            width: 9px;
            height: 9px;
            flex: 0 0 auto;
            border-radius: 999px;
            background: #8fa2ad;
            box-shadow: 0 0 0 4px rgba(143, 162, 173, 0.14);
        }

        #st_chatu8_anchor_workbench[data-status="running"] .st-chatu8-anchor-workbench-dot {
            background: #72bdff;
            box-shadow: 0 0 0 4px rgba(114, 189, 255, 0.16);
        }

        #st_chatu8_anchor_workbench[data-status="done"] .st-chatu8-anchor-workbench-dot {
            background: #9fd8b0;
            box-shadow: 0 0 0 4px rgba(159, 216, 176, 0.16);
        }

        #st_chatu8_anchor_workbench[data-status="failed"] .st-chatu8-anchor-workbench-dot {
            background: #ff9b9b;
            box-shadow: 0 0 0 4px rgba(255, 155, 155, 0.18);
        }

        #st_chatu8_anchor_workbench .st-chatu8-anchor-workbench-toggle-text {
            display: grid;
            gap: 1px;
            min-width: 0;
            text-align: left;
        }

        #st_chatu8_anchor_workbench .st-chatu8-anchor-workbench-toggle-title {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 13px;
            font-weight: 700;
            line-height: 1.2;
        }

        #st_chatu8_anchor_workbench .st-chatu8-anchor-workbench-toggle-meta {
            max-width: 310px;
            overflow: hidden;
            color: #9fb1b8;
            font-size: 11px;
            line-height: 1.2;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        #st_chatu8_anchor_workbench .st-chatu8-anchor-workbench-panel {
            display: none;
            grid-template-rows: auto auto auto minmax(0, 1fr);
            gap: 10px;
            max-height: min(72vh, 620px);
            overflow: hidden;
            padding: 12px;
            border: 1px solid rgba(132, 148, 156, 0.38);
            border-radius: 8px;
            background: rgba(16, 20, 24, 0.97);
            box-shadow: 0 18px 48px rgba(0, 0, 0, 0.42);
            backdrop-filter: blur(12px);
        }

        #st_chatu8_anchor_workbench.is-open .st-chatu8-anchor-workbench-panel {
            display: grid;
        }

        #st_chatu8_anchor_workbench .st-chatu8-anchor-workbench-head,
        #st_chatu8_anchor_workbench .st-chatu8-anchor-workbench-title,
        #st_chatu8_anchor_workbench .st-chatu8-anchor-workbench-actions,
        #st_chatu8_anchor_workbench .st-chatu8-anchor-summary {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        #st_chatu8_anchor_workbench .st-chatu8-anchor-workbench-head {
            justify-content: space-between;
            min-width: 0;
        }

        #st_chatu8_anchor_workbench .st-chatu8-anchor-workbench-title {
            min-width: 0;
            font-size: 14px;
            font-weight: 800;
        }

        #st_chatu8_anchor_workbench .st-chatu8-anchor-workbench-actions {
            flex: 0 0 auto;
        }

        #st_chatu8_anchor_workbench .st-chatu8-anchor-workbench-copy-status {
            min-width: 54px;
            color: #9fb1b8;
            font-size: 11px;
            text-align: right;
        }

        #st_chatu8_anchor_workbench .st-chatu8-anchor-workbench-icon-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 30px;
            height: 30px;
            border: 1px solid rgba(132, 148, 156, 0.32);
            border-radius: 6px;
            background: rgba(255, 255, 255, 0.04);
            color: #dbe5ea;
            cursor: pointer;
        }

        #st_chatu8_anchor_workbench .st-chatu8-anchor-workbench-icon-btn:hover {
            border-color: rgba(114, 189, 255, 0.56);
            color: #ffffff;
        }

        #st_chatu8_anchor_workbench .st-chatu8-anchor-workbench-icon-btn.danger:hover {
            border-color: rgba(255, 155, 155, 0.62);
            color: #ffb3b3;
        }

        #st_chatu8_anchor_workbench .st-chatu8-anchor-summary {
            flex-wrap: wrap;
            min-height: 28px;
            padding: 8px 0;
            border-top: 1px solid rgba(132, 148, 156, 0.2);
            border-bottom: 1px solid rgba(132, 148, 156, 0.2);
            color: #b8c8ce;
            font-size: 12px;
        }

        #st_chatu8_anchor_workbench .st-chatu8-anchor-summary strong {
            color: inherit;
            font-weight: 800;
        }

        #st_chatu8_anchor_workbench .st-chatu8-anchor-status-pill {
            display: inline-flex;
            align-items: center;
            min-height: 22px;
            padding: 2px 8px;
            border: 1px solid rgba(132, 148, 156, 0.36);
            border-radius: 999px;
            color: #b8c8ce;
            font-size: 11px;
            line-height: 1.2;
            white-space: nowrap;
        }

        #st_chatu8_anchor_workbench .st-chatu8-anchor-status-running {
            border-color: rgba(76, 166, 255, 0.58);
            color: #8cc8ff;
        }

        #st_chatu8_anchor_workbench .st-chatu8-anchor-status-done {
            border-color: rgba(109, 184, 138, 0.58);
            color: #9fd8b0;
        }

        #st_chatu8_anchor_workbench .st-chatu8-anchor-status-failed {
            border-color: rgba(235, 101, 101, 0.62);
            color: #ff9b9b;
        }

        #st_chatu8_anchor_workbench .st-chatu8-anchor-status-skipped {
            border-color: rgba(201, 160, 78, 0.58);
            color: #e2c37e;
        }

        #st_chatu8_anchor_workbench .st-chatu8-anchor-timeline {
            display: grid;
            grid-template-columns: repeat(7, minmax(0, 1fr));
            gap: 5px;
        }

        #st_chatu8_anchor_workbench .st-chatu8-anchor-step {
            display: flex;
            align-items: center;
            justify-content: center;
            min-width: 0;
            min-height: 28px;
            padding: 4px 5px;
            border: 1px solid rgba(132, 148, 156, 0.28);
            border-radius: 6px;
            background: rgba(132, 148, 156, 0.08);
            color: #aebdc5;
            font-size: 11px;
            line-height: 1.15;
            text-align: center;
            word-break: keep-all;
        }

        #st_chatu8_anchor_workbench .st-chatu8-anchor-step[data-status="running"] {
            border-color: rgba(76, 166, 255, 0.58);
            background: rgba(76, 166, 255, 0.1);
            color: #8cc8ff;
        }

        #st_chatu8_anchor_workbench .st-chatu8-anchor-step[data-status="done"] {
            border-color: rgba(109, 184, 138, 0.58);
            background: rgba(109, 184, 138, 0.1);
            color: #9fd8b0;
        }

        #st_chatu8_anchor_workbench .st-chatu8-anchor-step[data-status="failed"] {
            border-color: rgba(235, 101, 101, 0.62);
            background: rgba(235, 101, 101, 0.1);
            color: #ff9b9b;
        }

        #st_chatu8_anchor_workbench .st-chatu8-anchor-step[data-status="skipped"] {
            border-color: rgba(201, 160, 78, 0.58);
            background: rgba(201, 160, 78, 0.1);
            color: #e2c37e;
        }

        #st_chatu8_anchor_workbench .st-chatu8-anchor-log-shell {
            display: grid;
            grid-template-columns: minmax(150px, 0.78fr) minmax(190px, 1.22fr);
            gap: 8px;
            min-height: 190px;
            min-width: 0;
            overflow: hidden;
        }

        #st_chatu8_anchor_workbench .st-chatu8-anchor-trace-list {
            display: grid;
            align-content: start;
            gap: 6px;
            min-width: 0;
            max-height: 260px;
            overflow: auto;
        }

        #st_chatu8_anchor_workbench .st-chatu8-anchor-trace-item {
            display: grid;
            grid-template-columns: minmax(0, 1fr) auto;
            gap: 4px 7px;
            min-height: 42px;
            padding: 7px;
            border: 1px solid rgba(132, 148, 156, 0.24);
            border-radius: 6px;
            background: rgba(0, 0, 0, 0.13);
            color: inherit;
            cursor: pointer;
            text-align: left;
        }

        #st_chatu8_anchor_workbench .st-chatu8-anchor-trace-item:hover,
        #st_chatu8_anchor_workbench .st-chatu8-anchor-trace-item.is-selected {
            border-color: rgba(76, 166, 255, 0.52);
        }

        #st_chatu8_anchor_workbench .st-chatu8-anchor-trace-title,
        #st_chatu8_anchor_workbench .st-chatu8-anchor-trace-meta {
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        #st_chatu8_anchor_workbench .st-chatu8-anchor-trace-title {
            font-size: 12px;
            font-weight: 700;
        }

        #st_chatu8_anchor_workbench .st-chatu8-anchor-trace-meta {
            grid-column: 1 / -1;
            color: #9fb1b8;
            font-size: 11px;
        }

        #st_chatu8_anchor_workbench .st-chatu8-anchor-detail {
            min-height: 190px;
            max-height: 260px;
            min-width: 0;
            margin: 0;
            padding: 9px;
            overflow: auto;
            border: 1px solid rgba(132, 148, 156, 0.24);
            border-radius: 6px;
            background: rgba(0, 0, 0, 0.18);
            color: #dbe5ea;
            font: 11px/1.42 ui-monospace, SFMono-Regular, Consolas, monospace;
            white-space: pre-wrap;
            word-break: break-word;
        }

        #st_chatu8_anchor_workbench .st-chatu8-anchor-detail.is-humanized,
        #st_chatu8_anchor_settings .st-chatu8-anchor-detail.is-humanized {
            cursor: zoom-in;
            white-space: normal;
            word-break: normal;
            font: 12px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }

        .st-chatu8-anchor-readable {
            display: grid;
            gap: 8px;
        }

        .st-chatu8-anchor-readable-row {
            display: grid;
            grid-template-columns: 72px minmax(0, 1fr);
            gap: 8px;
            align-items: start;
        }

        .st-chatu8-anchor-readable-row span,
        .st-chatu8-anchor-readable-prompt span {
            color: #9fb1b8;
            font-size: 11px;
        }

        .st-chatu8-anchor-readable-row strong {
            min-width: 0;
            color: #edf3f7;
            font-weight: 650;
            overflow-wrap: anywhere;
        }

        .st-chatu8-anchor-readable-prompt {
            display: grid;
            gap: 5px;
            padding-top: 4px;
            border-top: 1px solid rgba(132, 148, 156, 0.18);
        }

        .st-chatu8-anchor-readable-prompt p {
            margin: 0;
            color: #dbe5ea;
            overflow-wrap: anywhere;
        }

        .st-chatu8-anchor-readable-prompt p + p {
            margin-top: 6px;
        }

        .st-chatu8-anchor-readable-prompt b {
            color: #f1f7fb;
            font-weight: 700;
        }

        .st-chatu8-anchor-readable-hint {
            display: inline-flex;
            width: fit-content;
            min-height: 26px;
            align-items: center;
            padding: 4px 8px;
            border: 1px solid rgba(76, 166, 255, 0.4);
            border-radius: 6px;
            color: #8cc8ff;
            font-size: 11px;
        }

        .st-chatu8-trace-detail-dialog {
            position: fixed;
            inset: 0;
            z-index: 100000;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 16px;
            background: rgba(0, 0, 0, 0.55);
        }

        .st-chatu8-trace-detail-panel {
            display: grid;
            grid-template-rows: auto minmax(0, 1fr) auto;
            gap: 12px;
            width: min(860px, 100%);
            max-height: 88vh;
            padding: 14px;
            border: 1px solid rgba(132, 148, 156, 0.38);
            border-radius: 8px;
            background: rgba(16, 20, 24, 0.98);
            color: #edf3f7;
            box-shadow: 0 22px 64px rgba(0, 0, 0, 0.48);
            font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }

        .st-chatu8-trace-detail-header,
        .st-chatu8-trace-detail-actions {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
        }

        .st-chatu8-trace-detail-header button,
        .st-chatu8-trace-detail-actions button {
            min-height: 32px;
            padding: 6px 10px;
            border: 1px solid rgba(132, 148, 156, 0.32);
            border-radius: 6px;
            background: rgba(255, 255, 255, 0.05);
            color: #edf3f7;
            cursor: pointer;
        }

        .st-chatu8-trace-detail-body {
            min-height: 0;
            overflow: auto;
            display: grid;
            gap: 10px;
        }

        .st-chatu8-trace-detail-prompt {
            width: 100%;
            min-height: 220px;
            resize: vertical;
            padding: 10px;
            border: 1px solid rgba(132, 148, 156, 0.3);
            border-radius: 6px;
            background: rgba(0, 0, 0, 0.22);
            color: #edf3f7;
            font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace;
        }

        .mes_text .st-chatu8-anchor-live-placeholder {
            display: grid;
            gap: 8px;
            max-width: min(420px, 100%);
            margin: 8px 0;
            padding: 10px;
            border: 1px solid rgba(114, 189, 255, 0.42);
            border-radius: 8px;
            background: rgba(18, 24, 30, 0.82);
            color: #edf3f7;
            box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
        }

        .mes_text img.st-chatu8-generated-image {
            cursor: pointer;
        }

        .mes_text .st-chatu8-generated-image-wrap {
            position: relative;
            display: inline-block;
            max-width: 100%;
            vertical-align: top;
        }

        .mes_text .st-chatu8-generated-image-wrap img.st-chatu8-generated-image {
            display: block;
            max-width: 100%;
            cursor: default;
        }

        .mes_text .st-chatu8-image-regenerate-btn {
            width: 30px;
            height: 30px;
            display: inline-grid;
            place-items: center;
            flex: 0 0 auto;
            padding: 0;
            border: 1px solid rgba(114, 189, 255, 0.5);
            border-radius: 999px;
            background: rgba(18, 24, 30, 0.86);
            color: #dff2ff;
            line-height: 1;
            cursor: pointer;
        }

        .mes_text .st-chatu8-generated-image-wrap > .st-chatu8-image-regenerate-btn {
            position: absolute;
            top: 8px;
            right: 8px;
            z-index: 2;
            box-shadow: 0 6px 18px rgba(0, 0, 0, 0.32);
        }

        .mes_text .st-chatu8-image-regenerate-btn:hover {
            background: rgba(36, 112, 180, 0.92);
            border-color: rgba(157, 208, 255, 0.9);
        }

        .mes_text .st-chatu8-image-regenerate-btn[disabled] {
            cursor: wait;
            opacity: 0.95;
        }

        .mes_text .st-chatu8-image-regenerate-btn-running i,
        .mes_text .st-chatu8-image-regenerate-btn[disabled] i {
            animation: stChatu8AnchorSpin 0.86s linear infinite;
        }

        .mes_text .st-chatu8-anchor-live-placeholder {
            display: inline-flex !important;
            align-items: center;
            gap: 8px;
            max-width: min(360px, 100%);
            min-height: 38px;
            padding: 6px 10px;
        }

        .mes_text .st-chatu8-anchor-live-placeholder .st-chatu8-anchor-live-head {
            display: contents;
        }

        .mes_text .st-chatu8-anchor-live-placeholder .st-chatu8-anchor-live-title {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            min-width: 0;
        }

        .mes_text .st-chatu8-anchor-live-placeholder .st-chatu8-anchor-live-title > span:last-child {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .mes_text .st-chatu8-anchor-live-placeholder .st-chatu8-anchor-live-status,
        .mes_text .st-chatu8-anchor-live-placeholder .st-chatu8-anchor-live-meta,
        .mes_text .st-chatu8-anchor-live-placeholder .st-chatu8-anchor-live-steps,
        .mes_text .st-chatu8-anchor-live-placeholder .st-chatu8-anchor-live-prompt {
            display: none !important;
        }

        .mes_text .st-chatu8-image-error-placeholder {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            max-width: min(720px, 100%);
            margin: 8px 0;
            padding: 6px 10px;
            border: 1px solid rgba(255, 155, 155, 0.46);
            border-radius: 8px;
            background: rgba(32, 18, 18, 0.82);
            color: #ffd6d0;
            font-size: 12px;
            line-height: 1.35;
        }

        .mes_text .st-chatu8-image-error-placeholder span {
            overflow-wrap: anywhere;
        }

        .mes_text .st-chatu8-anchor-live-placeholder[data-status="failed"] {
            border-color: rgba(255, 155, 155, 0.5);
        }

        .mes_text .st-chatu8-anchor-live-placeholder[data-status="done"] {
            border-color: rgba(159, 216, 176, 0.5);
        }

        .mes_text .st-chatu8-anchor-live-head,
        .mes_text .st-chatu8-anchor-live-meta,
        .mes_text .st-chatu8-anchor-live-steps {
            display: flex;
            align-items: center;
            gap: 8px;
            min-width: 0;
        }

        .mes_text .st-chatu8-anchor-live-head {
            justify-content: space-between;
        }

        .mes_text .st-chatu8-anchor-live-title {
            display: flex;
            align-items: center;
            gap: 8px;
            min-width: 0;
            font-weight: 700;
        }

        .mes_text .st-chatu8-anchor-live-spinner {
            width: 14px;
            height: 14px;
            flex: 0 0 auto;
            border: 2px solid rgba(237, 243, 247, 0.24);
            border-top-color: #72bdff;
            border-radius: 999px;
            animation: stChatu8AnchorSpin 0.86s linear infinite;
        }

        .mes_text .st-chatu8-anchor-live-placeholder[data-status="failed"] .st-chatu8-anchor-live-spinner,
        .mes_text .st-chatu8-anchor-live-placeholder[data-status="done"] .st-chatu8-anchor-live-spinner {
            animation: none;
            border-top-color: currentColor;
        }

        .mes_text .st-chatu8-anchor-live-status {
            color: #9fb1b8;
            font-size: 12px;
            white-space: nowrap;
        }

        .mes_text .st-chatu8-anchor-live-meta {
            flex-wrap: wrap;
            color: #b8c8ce;
            font-size: 12px;
        }

        .mes_text .st-chatu8-anchor-live-pill {
            min-height: 22px;
            padding: 2px 7px;
            border: 1px solid rgba(132, 148, 156, 0.28);
            border-radius: 999px;
            background: rgba(132, 148, 156, 0.1);
            line-height: 1.2;
        }

        .mes_text .st-chatu8-anchor-live-steps {
            flex-wrap: wrap;
            gap: 5px;
        }

        .mes_text .st-chatu8-anchor-live-prompt {
            display: grid;
            gap: 5px;
            min-width: 0;
        }

        .mes_text .st-chatu8-anchor-live-prompt summary {
            cursor: pointer;
            color: #b8d7ef;
            font-size: 12px;
            font-weight: 650;
        }

        .mes_text .st-chatu8-anchor-live-prompt pre {
            max-height: 180px;
            margin: 0;
            overflow: auto;
            padding: 8px;
            border: 1px solid rgba(132, 148, 156, 0.24);
            border-radius: 6px;
            background: rgba(0, 0, 0, 0.18);
            color: #dbe5ea;
            font: 12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace;
            overflow-wrap: anywhere;
            white-space: pre-wrap;
        }

        .mes_text .st-chatu8-anchor-live-step {
            min-height: 20px;
            padding: 2px 6px;
            border-radius: 6px;
            background: rgba(132, 148, 156, 0.14);
            color: #aebdc5;
            font-size: 11px;
            line-height: 1.2;
        }

        .mes_text .st-chatu8-anchor-live-step[data-status="running"] {
            background: rgba(114, 189, 255, 0.16);
            color: #9dd0ff;
        }

        .mes_text .st-chatu8-anchor-live-step[data-status="done"] {
            background: rgba(159, 216, 176, 0.14);
            color: #bce8c4;
        }

        .mes_text .st-chatu8-anchor-live-step[data-status="failed"] {
            background: rgba(255, 155, 155, 0.16);
            color: #ffb4a8;
        }

        .mes_text .st-chatu8-anchor-live-step[data-status="skipped"] {
            background: rgba(226, 195, 126, 0.14);
            color: #e2c37e;
        }

        @keyframes stChatu8AnchorSpin {
            to { transform: rotate(360deg); }
        }

        @media (max-width: 640px) {
            #st_chatu8_anchor_workbench {
                right: 8px;
                bottom: 68px;
                width: calc(100vw - 16px);
            }

            #st_chatu8_anchor_workbench .st-chatu8-anchor-workbench-panel {
                max-height: 76vh;
            }

            #st_chatu8_anchor_workbench .st-chatu8-anchor-timeline {
                grid-template-columns: repeat(4, minmax(0, 1fr));
            }

            #st_chatu8_anchor_workbench .st-chatu8-anchor-log-shell {
                grid-template-columns: 1fr;
            }
        }
    `;
    (document.head || document.documentElement).appendChild(style);
}

function ensureFloatingWorkbench() {
    if (typeof document === 'undefined' || !document.body) {
        return null;
    }

    ensureFloatingWorkbenchStyles();
    let root = document.getElementById('st_chatu8_anchor_workbench');
    if (!root) {
        root = document.createElement('div');
        root.id = 'st_chatu8_anchor_workbench';
        root.innerHTML = [
            '<button class="st-chatu8-anchor-workbench-toggle" id="st_chatu8_anchor_workbench_toggle" type="button" title="打开生图工作台">',
            '<span class="st-chatu8-anchor-workbench-dot"></span>',
            '<span class="st-chatu8-anchor-workbench-toggle-text">',
            '<span class="st-chatu8-anchor-workbench-toggle-title"><i class="fa-solid fa-image"></i><span>生图</span></span>',
            '<span class="st-chatu8-anchor-workbench-toggle-meta" id="st_chatu8_anchor_workbench_toggle_meta">待机</span>',
            '</span>',
            '</button>',
            '<section class="st-chatu8-anchor-workbench-panel" id="st_chatu8_anchor_workbench_panel" aria-label="生图工作台">',
            '<div class="st-chatu8-anchor-workbench-head">',
            '<div class="st-chatu8-anchor-workbench-title"><i class="fa-solid fa-route"></i><span>生图工作台</span></div>',
            '<div class="st-chatu8-anchor-workbench-actions">',
            '<span class="st-chatu8-anchor-workbench-copy-status" id="st_chatu8_anchor_workbench_copy_status"></span>',
            '<button class="st-chatu8-anchor-workbench-icon-btn" id="st_chatu8_anchor_workbench_copy" type="button" title="复制排查包"><i class="fa-solid fa-copy"></i></button>',
            '<button class="st-chatu8-anchor-workbench-icon-btn danger" id="st_chatu8_anchor_workbench_clear" type="button" title="清空日志"><i class="fa-solid fa-trash"></i></button>',
            '<button class="st-chatu8-anchor-workbench-icon-btn" id="st_chatu8_anchor_workbench_close" type="button" title="收起"><i class="fa-solid fa-chevron-down"></i></button>',
            '</div>',
            '</div>',
            '<div class="st-chatu8-anchor-summary" id="st_chatu8_anchor_workbench_summary"></div>',
            '<div class="st-chatu8-anchor-timeline" id="st_chatu8_anchor_workbench_timeline"></div>',
            '<div class="st-chatu8-anchor-log-shell">',
            '<div class="st-chatu8-anchor-trace-list" id="st_chatu8_anchor_workbench_list"></div>',
            '<pre class="st-chatu8-anchor-detail" id="st_chatu8_anchor_workbench_detail"></pre>',
            '</div>',
            '</section>',
        ].join('');
        document.body.appendChild(root);
    }

    const toggle = document.getElementById('st_chatu8_anchor_workbench_toggle');
    const close = document.getElementById('st_chatu8_anchor_workbench_close');
    const copy = document.getElementById('st_chatu8_anchor_workbench_copy');
    const clear = document.getElementById('st_chatu8_anchor_workbench_clear');
    const status = document.getElementById('st_chatu8_anchor_workbench_copy_status');

    if (toggle && toggle.dataset.stChatu8TraceBound !== TRACE_VERSION) {
        toggle.addEventListener('click', () => {
            settings().chatu8AnchorWorkbenchOpen = true;
            saveSettingsDebounced();
            renderFloatingWorkbench();
        });
        toggle.dataset.stChatu8TraceBound = TRACE_VERSION;
    }

    if (close && close.dataset.stChatu8TraceBound !== TRACE_VERSION) {
        close.addEventListener('click', () => {
            settings().chatu8AnchorWorkbenchOpen = false;
            saveSettingsDebounced();
            renderFloatingWorkbench();
        });
        close.dataset.stChatu8TraceBound = TRACE_VERSION;
    }

    if (copy && copy.dataset.stChatu8TraceBound !== TRACE_VERSION) {
        copy.addEventListener('click', async () => {
            try {
                await copySelectedTraceDiagnostics(status);
            } catch (error) {
                if (status) {
                    status.textContent = '复制失败';
                }
                console.warn('[st-chatu8] Failed to copy floating anchor trace diagnostics:', error);
            }
        });
        copy.dataset.stChatu8TraceBound = TRACE_VERSION;
    }

    if (clear && clear.dataset.stChatu8TraceBound !== TRACE_VERSION) {
        clear.addEventListener('click', () => clearTraceDiagnostics(status));
        clear.dataset.stChatu8TraceBound = TRACE_VERSION;
    }

    return root;
}

function renderFloatingWorkbench() {
    const root = ensureFloatingWorkbench();
    if (!root) {
        return;
    }

    const data = settings();
    const trace = selectedTrace();
    const activeStep = currentTraceStep(trace);
    const status = trace?.status || 'idle';
    root.dataset.status = status;
    root.classList.toggle('is-open', data.chatu8AnchorWorkbenchOpen === true);

    const toggleMeta = document.getElementById('st_chatu8_anchor_workbench_toggle_meta');
    if (toggleMeta) {
        const statusLabel = traceReadableStatus(status);
        const stepText = activeStep?.label ? ` · ${activeStep.label}` : '';
        const subject = traceSubject(trace);
        const taskText = subject ? ` · 主体：${subject}` : (trace?.anchor_id ? ` · ${trace.anchor_id}` : '');
        toggleMeta.textContent = `${statusLabel}${stepText}${taskText}`.slice(0, 96);
    }

    renderTraceSurface({
        summary: document.getElementById('st_chatu8_anchor_workbench_summary'),
        timeline: document.getElementById('st_chatu8_anchor_workbench_timeline'),
        list: document.getElementById('st_chatu8_anchor_workbench_list'),
        detail: document.getElementById('st_chatu8_anchor_workbench_detail'),
    });
}

function bindFloatingWorkbenchUi() {
    renderFloatingWorkbench();
}

function parseHiddenJsonAnchors(source) {
    const anchors = [];
    let cursor = 0;

    while (cursor < source.length) {
        const start = source.indexOf('<!--', cursor);
        if (start === -1) {
            break;
        }

        const end = source.indexOf('-->', start + 4);
        if (end === -1) {
            break;
        }

        const raw = source.slice(start, end + 3);
        const body = source.slice(start + 4, end).trim();
        const separator = body.indexOf(':');
        const prefix = separator >= 0 ? body.slice(0, separator).trim() : '';
        if (prefix === ANCHOR_PREFIX) {
            const jsonText = body.slice(separator + 1).trim();
            try {
                const data = JSON.parse(jsonText);
                if (data && typeof data === 'object' && !Array.isArray(data)) {
                    const id = safeString(data.id, `anchor_${anchors.length + 1}_${stableHash(raw)}`);
                    anchors.push({ id, data, raw, start, end: end + 3 });
                }
            } catch (error) {
                console.warn('[st-chatu8] Invalid chatu8_img anchor JSON:', error, raw);
            }
        }

        cursor = end + 3;
    }

    return anchors;
}

function extractAnchorSourceContext(source, anchorStart) {
    const before = safeString(source).slice(0, Math.max(0, anchorStart));
    const cleaned = before
        .replace(/<!--\s*chatu8_img_result\s*:[\s\S]*?-->/gi, ' ')
        .replace(/<!--\s*chatu8_img_error\s*:[\s\S]*?-->/gi, ' ')
        .replace(/<!--\s*chatu8_img\s*:[\s\S]*?-->/gi, ' ')
        .replace(/image###[\s\S]*?###/gi, ' ')
        .replace(/\[IMG_GEN\][\s\S]*?\[\/IMG_GEN\]/gi, ' ')
        .replace(/<img\b[\s\S]*?>/gi, ' ')
        .replace(/<video\b[\s\S]*?<\/video>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .trim();
    if (!cleaned) {
        return '';
    }

    const paragraphs = cleaned
        .split(/\n{2,}|\r{2,}/)
        .map((part) => part.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    return trimTraceString(paragraphs.slice(-2).join('\n'), 1200);
}

function parseImageTextAnchors(source) {
    const anchors = [];
    let cursor = 0;

    while (cursor < source.length) {
        const start = source.indexOf(IMAGE_TEXT_OPEN, cursor);
        if (start === -1) {
            break;
        }

        const bodyStart = start + IMAGE_TEXT_OPEN.length;
        const end = source.indexOf(IMAGE_TEXT_CLOSE, bodyStart);
        if (end === -1) {
            break;
        }

        const raw = source.slice(start, end + IMAGE_TEXT_CLOSE.length);
        const prompt = source.slice(bodyStart, end).trim();
        if (prompt) {
            const id = `image_${stableHash(raw)}`;
            anchors.push({
                id,
                type: 'image_text',
                data: {
                    id,
                    prompt,
                    context: extractAnchorSourceContext(source, start),
                    source: 'image_text',
                },
                raw,
                start,
                end: end + IMAGE_TEXT_CLOSE.length,
            });
        }

        cursor = end + IMAGE_TEXT_CLOSE.length;
    }

    return anchors;
}

function parseAnchors(text, options = {}) {
    const source = String(text || '');
    const includeHiddenJson = options.hiddenJson !== false;
    const includeImageText = options.imageText !== false;
    const anchors = [
        ...(includeHiddenJson ? parseHiddenJsonAnchors(source) : []),
        ...(includeImageText ? parseImageTextAnchors(source) : []),
    ];

    return anchors.sort((a, b) => a.start - b.start || a.end - b.end);
}

function parseActiveAnchors(text) {
    const data = settings();
    return parseAnchors(text, {
        hiddenJson: data.enableChatu8HiddenJsonAnchors === true,
        imageText: data.enableChatu8ImageTextAnchors === true,
    });
}

function getModeDefaults(mode) {
    switch (mode) {
        case 'high_quality':
            return { width: 832, height: 1216, label: 'high_quality' };
        case 'nsfw':
            return { width: 768, height: 1024, label: 'nsfw' };
        case 'normal':
        default:
            return { width: 768, height: 1024, label: 'normal' };
    }
}

function numberOrUndefined(value) {
    if (value === undefined || value === null || value === '') {
        return undefined;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function comfySettingDimension(key, fallback) {
    return numberOrUndefined(settings()[key]) || fallback;
}

function compactPromptParts(parts) {
    return parts
        .flatMap((part) => Array.isArray(part) ? part : [part])
        .map((part) => promptValueToString(part))
        .filter(Boolean)
        .join(', ');
}

function buildRequest(anchor, messageId) {
    const data = anchor.data;
    const mode = safeString(data.mode, 'normal');
    const modeDefaults = getModeDefaults(mode);
    const width = numberOrUndefined(data.width) || comfySettingDimension('comfyui_width', modeDefaults.width);
    const height = numberOrUndefined(data.height) || comfySettingDimension('comfyui_height', modeDefaults.height);
    if (anchor.type === 'image_text') {
        const prompt = safeString(data.prompt);
        const seed = numberOrUndefined(data.seed);
        return {
            id: `chatu8_anchor:${messageId}:${anchor.id}:${Date.now()}`,
            prompt,
            width,
            height,
            change: `chatu8_anchor source=image_text mode=${modeDefaults.label} anchor=${anchor.id}`,
            negative_prompt: '',
            seed,
            mode: modeDefaults.label,
            workflowAdapter: 'flux2-klein-reference',
            debugPromptRaw: prompt,
            debugSourceContext: safeString(data.context),
        };
    }

    const prompt = compactPromptParts([
        data.character,
        data.scene,
        data.prompt,
        data.positive,
        data.positive_prompt,
    ]);
    const negativePrompt = compactPromptParts([
        data.negative_prompt,
        data.negative,
        data.uc,
    ]);
    const seed = numberOrUndefined(data.seed);

    return {
        id: `chatu8_anchor:${messageId}:${anchor.id}:${Date.now()}`,
        prompt,
        width,
        height,
        change: `chatu8_anchor mode=${modeDefaults.label} anchor=${anchor.id}`,
        negative_prompt: negativePrompt,
        seed,
        mode: modeDefaults.label,
        debugSourceContext: safeString(data.context),
    };
}

function normalizeMediaUrl(response) {
    const value = response?.imageData || response?.image || response?.url || '';
    if (!value) {
        return '';
    }

    if (/^(data:|https?:|\/)/i.test(value)) {
        return value;
    }

    const format = safeString(response?.format, 'png').replace(/[^a-z0-9.+-]/gi, '') || 'png';
    return `data:image/${format};base64,${value}`;
}

function isDataUrl(value) {
    return /^data:/i.test(safeString(value));
}

function mimeTypeFromDataUrl(value, fallback = 'image/png') {
    const match = safeString(value).match(/^data:([^;,]+)[;,]/i);
    return match?.[1] || fallback;
}

function mimeTypeFromResponse(response) {
    const format = safeString(response?.format, 'png').replace(/[^a-z0-9.+/-]/gi, '') || 'png';
    return format.includes('/') ? format : `image/${format}`;
}

function extensionFromMimeType(mimeType) {
    const value = safeString(mimeType, 'image/png').toLowerCase();
    if (value.includes('jpeg')) {
        return 'jpg';
    }
    if (value.includes('webp')) {
        return 'webp';
    }
    if (value.includes('gif')) {
        return 'gif';
    }
    return 'png';
}

function imageRefId(ref) {
    if (typeof ref === 'string') {
        return ref;
    }

    if (ref && typeof ref === 'object') {
        return safeString(ref.id || ref.imageId || ref.ref || ref.uuid || ref.key);
    }

    return '';
}

async function compactResponseImageForChat(response, request, trace = null) {
    const mediaUrl = normalizeMediaUrl(response);
    const compactEnabled = settings().chatu8CompactGeneratedImages === true;
    if (!compactEnabled) {
        return response;
    }

    if (!mediaUrl || response?.isVideo || !isDataUrl(mediaUrl)) {
        return response;
    }

    const mimeType = mimeTypeFromDataUrl(mediaUrl, mimeTypeFromResponse(response));
    try {
        traceStep(trace, 'writeback', 'running', {
            target: 'chat_image_store',
            bytes: mediaUrl.length,
            mime_type: mimeType,
        });
        const ref = await saveChatImage(mediaUrl, {
            mimeType,
            name: `chatu8_anchor_${Date.now()}.${extensionFromMimeType(mimeType)}`,
            chatId: getCurrentChatId() || '',
        });
        const refId = imageRefId(ref);
        if (!refId) {
            return response;
        }

        generatedImageRefUrlCache.set(refId, mediaUrl);
        return {
            ...response,
            imageData: '',
            image: '',
            url: '',
            chatu8ImageRef: refId,
            chatu8ImageMimeType: mimeType,
            chatu8OriginalMediaLength: mediaUrl.length,
        };
    } catch (error) {
        console.warn('[st-chatu8] Failed to store generated image as chat image ref, falling back to inline image:', error);
        traceStep(trace, 'writeback', 'running', {
            target: 'chat_message',
            image_store: 'failed',
            error: error?.message || String(error),
        });
        return response;
    }
}

function buildResultReplacement(anchor, request, response, trace = null) {
    const title = anchor.type === 'image_text'
        ? safeString(anchor.data.title || anchor.data.caption, '')
        : safeString(anchor.data.title || anchor.data.caption || anchor.id, anchor.id);
    const alt = title.replaceAll('\n', ' ').replaceAll(']', ')').slice(0, 120) || anchor.id;
    const imageRef = safeString(response?.chatu8ImageRef);
    const mediaUrl = normalizeMediaUrl(response);
    const metadata = {
        id: anchor.id,
        request_id: request.id,
        mode: request.mode,
        width: request.width,
        height: request.height,
        seed: request.seed ?? null,
        trace_id: trace?.trace_id || '',
        image_ref: imageRef || '',
        compact_image: Boolean(imageRef),
        generated_at: new Date().toISOString(),
    };
    const marker = `<!--${RESULT_PREFIX}:${safeCommentJson(metadata)}-->`;

    if (!mediaUrl && !imageRef) {
        throw new Error('ComfyUI returned an empty image payload');
    }

    if (response?.isVideo) {
        return `${marker}\n\n${title ? `**${title}**\n\n` : ''}<video controls src="${mediaUrl}"></video>`;
    }

    const width = Number.isFinite(Number(request.width)) ? Math.max(1, Math.floor(Number(request.width))) : '';
    const height = Number.isFinite(Number(request.height)) ? Math.max(1, Math.floor(Number(request.height))) : '';
    const traceId = safeString(trace?.trace_id || '');
    const attrs = [
        'class="st-chatu8-generated-image"',
        'data-st-chatu8-generated="true"',
        `data-st-chatu8-anchor-id="${escapeHtml(anchor.id)}"`,
        `data-st-chatu8-request-id="${escapeHtml(request.id)}"`,
        `data-st-chatu8-trace-id="${escapeHtml(traceId)}"`,
        imageRef ? `data-st-chatu8-image-ref="${escapeHtml(imageRef)}"` : '',
        imageRef ? 'data-st-chatu8-image-ref-status="pending"' : '',
        imageRef ? `data-st-chatu8-image-mime-type="${escapeHtml(response?.chatu8ImageMimeType || '')}"` : '',
        width ? `width="${escapeHtml(width)}"` : '',
        height ? `height="${escapeHtml(height)}"` : '',
        `src="${escapeHtml(imageRef ? EMPTY_IMAGE_SRC : mediaUrl)}"`,
        `alt="${escapeHtml(alt)}"`,
        'title="长按或右键查看最终提示词"',
        'loading="lazy"',
    ].filter(Boolean).join(' ');
    const buttonAttrs = [
        'class="st-chatu8-image-regenerate-btn"',
        'type="button"',
        'title="Regenerate image"',
        `data-st-chatu8-anchor-id="${escapeHtml(anchor.id)}"`,
        `data-st-chatu8-request-id="${escapeHtml(request.id)}"`,
        `data-st-chatu8-trace-id="${escapeHtml(traceId)}"`,
    ].join(' ');
    const wrapperAttrs = [
        'class="st-chatu8-generated-image-wrap"',
        'data-st-chatu8-result-wrap="true"',
        `data-st-chatu8-anchor-id="${escapeHtml(anchor.id)}"`,
        `data-st-chatu8-request-id="${escapeHtml(request.id)}"`,
        `data-st-chatu8-trace-id="${escapeHtml(traceId)}"`,
    ].join(' ');
    return `${marker}\n\n${title ? `**${title}**\n\n` : ''}<span ${wrapperAttrs}><button ${buttonAttrs}><i class="fa-solid fa-rotate-right"></i></button><img ${attrs}></span>`;
}

function storedImageToMediaUrl(value, fallbackMimeType = 'image/png') {
    if (!value) {
        return '';
    }

    if (typeof value === 'string') {
        if (/^(data:|blob:|https?:|\/)/i.test(value)) {
            return value;
        }
        return `data:${fallbackMimeType};base64,${value}`;
    }

    if (typeof Blob !== 'undefined' && value instanceof Blob) {
        return URL.createObjectURL(value);
    }

    if (typeof value === 'object') {
        const nested = value.imageData || value.image || value.url || value.data || value.base64 || '';
        const mimeType = value.mimeType || value.type || fallbackMimeType;
        if (typeof nested === 'string') {
            if (/^(data:|blob:|https?:|\/)/i.test(nested)) {
                return nested;
            }
            return `data:${mimeType};base64,${nested}`;
        }
        if (typeof Blob !== 'undefined' && value.blob instanceof Blob) {
            return URL.createObjectURL(value.blob);
        }
    }

    return '';
}

async function hydrateGeneratedImageNode(image) {
    const refId = safeString(image?.dataset?.stChatu8ImageRef);
    if (!refId) {
        return;
    }

    if (image.dataset.stChatu8ImageRefStatus === 'loaded' && image.src && image.src !== EMPTY_IMAGE_SRC) {
        return;
    }

    const cached = generatedImageRefUrlCache.get(refId);
    if (cached) {
        image.src = cached;
        image.dataset.stChatu8ImageRefStatus = 'loaded';
        return;
    }

    if (hydratingGeneratedImages.get(image) === refId) {
        return;
    }

    hydratingGeneratedImages.set(image, refId);
    image.dataset.stChatu8ImageRefStatus = 'loading';
    try {
        const stored = await getChatImage(refId);
        const mediaUrl = storedImageToMediaUrl(stored, image.dataset.stChatu8ImageMimeType || 'image/png');
        if (!mediaUrl) {
            image.dataset.stChatu8ImageRefStatus = 'missing';
            return;
        }

        generatedImageRefUrlCache.set(refId, mediaUrl);
        if (safeString(image?.dataset?.stChatu8ImageRef) === refId) {
            image.src = mediaUrl;
            image.dataset.stChatu8ImageRefStatus = 'loaded';
        }
    } catch (error) {
        console.warn('[st-chatu8] Failed to hydrate generated image ref:', refId, error);
        image.dataset.stChatu8ImageRefStatus = 'failed';
    } finally {
        if (hydratingGeneratedImages.get(image) === refId) {
            hydratingGeneratedImages.delete(image);
        }
    }
}

function hydrateGeneratedImages(root = document) {
    if (typeof document === 'undefined' || !root) {
        return;
    }

    if (root.matches?.('img.st-chatu8-generated-image[data-st-chatu8-image-ref]')) {
        hydrateGeneratedImageNode(root);
    }

    root.querySelectorAll?.('img.st-chatu8-generated-image[data-st-chatu8-image-ref]').forEach((image) => {
        hydrateGeneratedImageNode(image);
    });
}

function bindGeneratedImageHydration() {
    if (typeof document === 'undefined' || document.documentElement.dataset.stChatu8ImageHydration === TRACE_VERSION) {
        return;
    }

    document.documentElement.dataset.stChatu8ImageHydration = TRACE_VERSION;
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node?.nodeType === 1) {
                    hydrateGeneratedImages(node);
                }
            }
        }
    });
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    setTimeout(() => hydrateGeneratedImages(), 0);
}

function buildErrorReplacement(anchor, error, trace = null) {
    const message = error instanceof Error ? error.message : String(error);
    const traceId = safeString(trace?.trace_id || '');
    const metadata = {
        id: anchor.id,
        trace_id: traceId,
        error: message.slice(0, 500),
        failed_at: new Date().toISOString(),
    };
    const marker = `<!--${ERROR_PREFIX}:${safeCommentJson(metadata)}-->`;

    if (settings().chatu8HiddenJsonShowFailures === false) {
        return marker;
    }

    const buttonAttrs = [
        'class="st-chatu8-image-regenerate-btn st-chatu8-image-regenerate-btn-error"',
        'type="button"',
        'title="Retry image generation"',
        `data-st-chatu8-anchor-id="${escapeHtml(anchor.id)}"`,
        `data-st-chatu8-trace-id="${escapeHtml(traceId)}"`,
    ].join(' ');
    return [
        marker,
        '',
        `<div class="st-chatu8-image-error-placeholder" data-st-chatu8-anchor-id="${escapeHtml(anchor.id)}" data-st-chatu8-trace-id="${escapeHtml(traceId)}">`,
        `<button ${buttonAttrs}><i class="fa-solid fa-rotate-right"></i></button>`,
        `<span>st-chatu8 image anchor "${escapeHtml(anchor.id)}" failed: ${escapeHtml(message)}</span>`,
        '</div>',
    ].join('\n');
}

function getLiveAnchorKey(messageId, anchorId) {
    return `${messageId}:${anchorId}`;
}

function anchorRawHash(anchor) {
    const id = safeString(anchor?.id);
    if (anchor?.type === 'image_text' && id.startsWith('image_')) {
        return id.slice('image_'.length);
    }

    return stableHash(safeString(anchor?.raw));
}

function getStoredAnchorStateEntry(message, anchor) {
    const state = message?.extra?.chatu8HiddenJsonAnchors;
    if (!state || typeof state !== 'object') {
        return null;
    }

    if (state[anchor?.id]) {
        return state[anchor.id];
    }

    const hash = anchorRawHash(anchor);
    const legacyKey = Object.keys(state).find((key) => key === anchor?.id || (hash && key.endsWith(`_${hash}`)));
    return legacyKey ? state[legacyKey] : null;
}

function findPlaceholderRange(source, anchor, trace = null) {
    const text = safeString(source);
    const wantedId = safeString(anchor?.id);
    const wantedTraceId = safeString(trace?.trace_id);
    let cursor = 0;

    while (cursor < text.length) {
        const start = text.indexOf(`<!--${PLACEHOLDER_PREFIX}:`, cursor);
        if (start === -1) {
            return null;
        }

        const startEnd = text.indexOf('-->', start);
        if (startEnd === -1) {
            return null;
        }

        const jsonText = text.slice(start + PLACEHOLDER_PREFIX.length + 5, startEnd).trim();
        let metadata = null;
        try {
            metadata = JSON.parse(jsonText);
        } catch (_error) {
            metadata = null;
        }

        const idMatches = !wantedId || metadata?.id === wantedId;
        const traceMatches = !wantedTraceId || !metadata?.trace_id || metadata.trace_id === wantedTraceId;
        if (idMatches && traceMatches) {
            const endStart = text.indexOf(`<!--${PLACEHOLDER_END_PREFIX}:`, startEnd + 3);
            if (endStart !== -1) {
                const endEnd = text.indexOf('-->', endStart);
                if (endEnd !== -1) {
                    return { start, end: endEnd + 3 };
                }
            }
        }

        cursor = startEnd + 3;
    }

    return null;
}

function replacePersistedPlaceholder(source, anchor, replacement, trace = null) {
    const range = findPlaceholderRange(source, anchor, trace);
    if (!range) {
        return null;
    }

    return `${source.slice(0, range.start)}${replacement}${source.slice(range.end)}`;
}

function replaceAnchorSourceText(message, anchor, replacement) {
    const originalText = typeof message?.mes === 'string' ? message.mes : '';
    if (!originalText) {
        return { text: originalText, method: 'empty_message' };
    }

    if (anchor?.raw && originalText.includes(anchor.raw)) {
        return {
            text: originalText.replace(anchor.raw, replacement),
            method: 'exact_raw',
        };
    }

    const activeAnchors = parseActiveAnchors(originalText);
    const wantedPrompt = safeString(anchor?.data?.prompt);
    const wantedRawHash = stableHash(safeString(anchor?.raw));
    const matchedAnchor = activeAnchors.find((candidate) => {
        if (anchor?.id && candidate.id === anchor.id) {
            return true;
        }

        if (candidate.raw && stableHash(candidate.raw) === wantedRawHash) {
            return true;
        }

        return wantedPrompt && safeString(candidate.data?.prompt) === wantedPrompt;
    });

    if (matchedAnchor?.raw && originalText.includes(matchedAnchor.raw)) {
        return {
            text: originalText.replace(matchedAnchor.raw, replacement),
            method: 'matched_active_anchor',
        };
    }

    return {
        text: originalText,
        method: 'not_found',
    };
}

function buildLiveAnchorPlaceholder(anchor, request, trace) {
    ensureFloatingWorkbenchStyles();
    const status = trace?.status || 'running';
    const statusText = traceReadableStatus(status);
    const step = currentTraceStep(trace);
    const stepText = step?.label || '准备生图';
    const subject = traceSubject(trace);
    const dimensions = request?.width && request?.height ? `${request.width}x${request.height}` : '';
    const promptStatus = tracePromptRewriteStatus(trace);
    const stepsHtml = TRACE_STEP_ORDER.map((item) => {
        const state = trace?.steps?.[item.id]?.status || 'pending';
        return `<span class="st-chatu8-anchor-live-step" data-status="${escapeHtml(state)}">${escapeHtml(item.label)}</span>`;
    }).join('');

    const meta = [
        subject ? `主体：${subject}` : '',
        dimensions ? `尺寸：${dimensions}` : '',
        anchor?.id ? `锚点：${anchor.id}` : '',
        promptStatus && promptStatus !== '未记录' ? `提示词：${promptStatus}` : '',
    ].filter(Boolean).map((item) => `<span class="st-chatu8-anchor-live-pill">${escapeHtml(item)}</span>`).join('');

    return [
        `<!--${PLACEHOLDER_PREFIX}:${safeCommentJson({ id: anchor.id, trace_id: trace?.trace_id || '', status })}-->`,
        `<div class="st-chatu8-anchor-live-placeholder" data-status="${escapeHtml(status)}" data-st-chatu8-anchor-id="${escapeHtml(anchor.id)}" data-st-chatu8-trace-id="${escapeHtml(trace?.trace_id || '')}">`,
        '<div class="st-chatu8-anchor-live-head">',
        '<div class="st-chatu8-anchor-live-title">',
        '<span class="st-chatu8-anchor-live-spinner"></span>',
        `<span>${escapeHtml(stepText)}</span>`,
        '</div>',
        `<span class="st-chatu8-anchor-live-status">${escapeHtml(statusText)}</span>`,
        '</div>',
        `<div class="st-chatu8-anchor-live-meta">${meta || '<span class="st-chatu8-anchor-live-pill">正在提交任务</span>'}</div>`,
        `<div class="st-chatu8-anchor-live-steps">${stepsHtml}</div>`,
        '</div>',
        `<!--${PLACEHOLDER_END_PREFIX}:${escapeHtml(anchor.id)}-->`,
    ].join('');
}

function livePlaceholderEntriesForMessage(messageId) {
    return Array.from(liveAnchorPlaceholders.values()).filter((entry) => Number(entry.messageId) === Number(messageId));
}

function applyStoredAnchorStatePlaceholders(messageId, text) {
    const message = chat[messageId];
    const state = message?.extra?.chatu8HiddenJsonAnchors;
    if (!message || !state || typeof state !== 'object') {
        return String(text || '');
    }

    let result = String(text || '');
    const anchors = parseAnchors(result, { hiddenJson: false, imageText: true }).reverse();
    for (const anchor of anchors) {
        const stateEntry = getStoredAnchorStateEntry(message, anchor);
        const status = safeString(stateEntry?.status);
        if (!['running', 'done', 'failed'].includes(status) || !anchor?.raw || !result.includes(anchor.raw)) {
            continue;
        }

        const trace = stateEntry?.trace_id ? findTrace(stateEntry.trace_id) : null;
        const replacement = status === 'running'
            ? buildLiveAnchorPlaceholder(anchor, { prompt: anchor.data?.prompt }, trace || { status: 'running' })
            : '';
        result = result.replace(anchor.raw, replacement);
    }

    return result;
}

function applyLiveAnchorPlaceholders(messageId, text) {
    let result = applyStoredAnchorStatePlaceholders(messageId, text);
    for (const entry of livePlaceholderEntriesForMessage(messageId)) {
        if (!entry?.anchor?.raw || !result.includes(entry.anchor.raw)) {
            continue;
        }
        result = result.replace(entry.anchor.raw, entry.html || buildLiveAnchorPlaceholder(entry.anchor, entry.request, entry.trace));
    }
    return result;
}

async function showLiveAnchorPlaceholder(messageId, anchor, request, trace) {
    if (!trace?.trace_id) {
        return;
    }

    const html = buildLiveAnchorPlaceholder(anchor, request, trace);
    liveAnchorPlaceholders.set(trace.trace_id, {
        key: getLiveAnchorKey(messageId, anchor.id),
        messageId,
        anchor,
        request,
        trace,
        html,
    });

    const message = chat[messageId];
    const writeback = replaceAnchorSourceText(message, anchor, html);
    if (message && writeback.text !== message.mes) {
        message.mes = writeback.text;
        const state = getMessageState(message);
        state[anchor.id] = {
            ...(state[anchor.id] || {}),
            placeholder_persisted: true,
            placeholder_method: writeback.method,
            updated_at: new Date().toISOString(),
        };
        traceEvent(trace, 'placeholder:message_updated', {
            message_id: messageId,
            anchor_id: anchor?.id || '',
            method: writeback.method,
        }, false);
    }

    await rerenderMessage(messageId, { emitUpdate: false });
}

function refreshLiveAnchorPlaceholder(trace) {
    const entry = trace?.trace_id ? liveAnchorPlaceholders.get(trace.trace_id) : null;
    if (!entry) {
        return;
    }

    if (trace?.status === 'running') {
        return;
    }

    entry.html = buildLiveAnchorPlaceholder(entry.anchor, entry.request, trace);
    rerenderMessage(entry.messageId, { emitUpdate: false }).catch((error) => {
        console.warn('[st-chatu8] Failed to refresh live image placeholder:', error);
    });
}

function clearLiveAnchorPlaceholder(messageId, anchor, trace = null) {
    if (trace?.trace_id) {
        liveAnchorPlaceholders.delete(trace.trace_id);
    }

    const expectedKey = getLiveAnchorKey(messageId, anchor?.id);
    for (const [traceId, entry] of liveAnchorPlaceholders.entries()) {
        if (entry.key === expectedKey) {
            liveAnchorPlaceholders.delete(traceId);
        }
    }
}

function findPromptTraceForImage(image) {
    if (!image) {
        return null;
    }

    const traceId = safeString(image.dataset?.stChatu8TraceId);
    if (traceId) {
        const trace = findTrace(traceId);
        if (trace?.prompt_comfy || trace?.prompt_final || trace?.prompt_optimized || trace?.prompt_raw) {
            return trace;
        }
    }

    const requestId = safeString(image.dataset?.stChatu8RequestId);
    const anchorId = safeString(image.dataset?.stChatu8AnchorId);
    const messageElement = image.closest?.('.mes[mesid]');
    const messageId = Number(messageElement?.getAttribute('mesid'));
    const log = getTraceLog().slice().reverse();

    return log.find((trace) => {
        if (!trace || !(trace.prompt_comfy || trace.prompt_final || trace.prompt_optimized || trace.prompt_raw)) {
            return false;
        }
        if (requestId && trace.request_id === requestId) {
            return true;
        }
        if (anchorId && trace.anchor_id === anchorId && (!Number.isInteger(messageId) || Number(trace.message_id) === messageId)) {
            return true;
        }
        return Number.isInteger(messageId) && Number(trace.message_id) === messageId && trace.status === 'done';
    }) || null;
}

function promptForImage(image) {
    const trace = findPromptTraceForImage(image);
    const prompt = tracePromptText(trace);
    return { trace, prompt };
}

function traceRequestDetail(trace, key) {
    return trace?.steps?.request?.detail?.[key] ?? trace?.steps?.submit?.detail?.[key] ?? trace?.[key];
}

function regenerateAnchorFromImage(image, trace) {
    const prompt = safeString(trace?.prompt_raw || trace?.prompt_preview || trace?.prompt_final || trace?.prompt_optimized || trace?.prompt_comfy);
    if (!prompt) {
        return null;
    }

    const anchorId = safeString(image?.dataset?.stChatu8AnchorId || trace?.anchor_id, `image_regen_${stableHash(prompt)}`);
    return {
        id: anchorId,
        type: trace?.anchor_type || 'image_text',
        data: {
            id: anchorId,
            prompt,
            context: safeString(trace?.source_context),
            source: 'image_regenerate',
            mode: safeString(traceRequestDetail(trace, 'mode') || trace?.mode, 'normal'),
            width: numberOrUndefined(traceRequestDetail(trace, 'width')),
            height: numberOrUndefined(traceRequestDetail(trace, 'height')),
        },
        raw: `${IMAGE_TEXT_OPEN}${prompt}${IMAGE_TEXT_CLOSE}`,
        start: 0,
        end: 0,
    };
}

function generatedImageSelector(image) {
    const wrapper = image?.closest?.('.st-chatu8-generated-image-wrap[data-st-chatu8-result-wrap]');
    const wrapperRequestId = safeString(wrapper?.dataset?.stChatu8RequestId);
    if (wrapperRequestId) {
        return `<span\\b(?=[^>]*\\bdata-st-chatu8-result-wrap="true")(?=[^>]*\\bdata-st-chatu8-request-id="${escapeRegExp(wrapperRequestId)}")[\\s\\S]*?<\\/span>`;
    }

    const wrapperTraceId = safeString(wrapper?.dataset?.stChatu8TraceId);
    if (wrapperTraceId) {
        return `<span\\b(?=[^>]*\\bdata-st-chatu8-result-wrap="true")(?=[^>]*\\bdata-st-chatu8-trace-id="${escapeRegExp(wrapperTraceId)}")[\\s\\S]*?<\\/span>`;
    }

    const errorBox = image?.closest?.('.st-chatu8-image-error-placeholder');
    const errorTraceId = safeString(errorBox?.dataset?.stChatu8TraceId);
    if (errorTraceId) {
        return `<div\\b(?=[^>]*\\bclass="[^"]*st-chatu8-image-error-placeholder)(?=[^>]*\\bdata-st-chatu8-trace-id="${escapeRegExp(errorTraceId)}")[\\s\\S]*?<\\/div>`;
    }

    const requestId = safeString(image?.dataset?.stChatu8RequestId);
    if (requestId) {
        return `<img\\b(?=[^>]*\\bdata-st-chatu8-request-id="${escapeRegExp(requestId)}")[^>]*>`;
    }

    const traceId = safeString(image?.dataset?.stChatu8TraceId);
    if (traceId) {
        return `<img\\b(?=[^>]*\\bdata-st-chatu8-trace-id="${escapeRegExp(traceId)}")[^>]*>`;
    }

    const anchorId = safeString(image?.dataset?.stChatu8AnchorId);
    if (anchorId) {
        return `<img\\b(?=[^>]*\\bdata-st-chatu8-anchor-id="${escapeRegExp(anchorId)}")[^>]*>`;
    }

    return '';
}

function regenerationPlaceholder(anchor, trace) {
    ensureFloatingWorkbenchStyles();
    return [
        `<!--chatu8_img_regenerate:${safeCommentJson({ id: anchor.id, trace_id: trace?.trace_id || '', status: 'running' })}-->`,
        `<div class="st-chatu8-anchor-live-placeholder" data-status="running" data-st-chatu8-regenerate-trace-id="${escapeHtml(trace?.trace_id || '')}"><button class="st-chatu8-image-regenerate-btn st-chatu8-image-regenerate-btn-running" type="button" disabled title="Generating image"><i class="fa-solid fa-rotate-right"></i></button><span>Regenerating image...</span></div>`,
    ].join('');
}

function replaceMessageHtmlByPattern(messageId, pattern, replacement) {
    const message = chat[messageId];
    if (!message || typeof message.mes !== 'string' || !pattern) {
        return false;
    }

    const regex = new RegExp(pattern, 'i');
    if (!regex.test(message.mes)) {
        return false;
    }

    message.mes = message.mes.replace(regex, () => replacement);
    return true;
}

async function writeRegenerationUpdate(messageId, pattern, replacement) {
    if (!replaceMessageHtmlByPattern(messageId, pattern, replacement)) {
        return false;
    }

    await saveChatConditional();
    await rerenderMessage(messageId);
    return true;
}

async function regenerateGeneratedImage(image) {
    const messageElement = image?.closest?.('.mes[mesid]');
    const messageId = Number(messageElement?.getAttribute('mesid'));
    if (!Number.isInteger(messageId) || messageId < 0 || image?.dataset?.stChatu8Regenerating === 'true') {
        return false;
    }

    const trace = findPromptTraceForImage(image);
    const anchor = regenerateAnchorFromImage(image, trace);
    if (!anchor) {
        return false;
    }

    const initialPattern = generatedImageSelector(image);
    if (!initialPattern) {
        return false;
    }

    image.dataset.stChatu8Regenerating = 'true';
    const request = buildRequest(anchor, messageId);
    const newTrace = createTrace(anchor, request, messageId, 'image_click_regenerate');
    appendTrace(newTrace);
    const placeholderPattern = `<div\\b(?=[^>]*\\bdata-st-chatu8-regenerate-trace-id="${escapeRegExp(newTrace.trace_id)}")[\\s\\S]*?<\\/div>`;

    try {
        await writeRegenerationUpdate(messageId, initialPattern, regenerationPlaceholder(anchor, newTrace));

        const message = chat[messageId];
        const referenceReadyRequest = await ensureComfyReferenceBootstrap(request, {
            messageId,
            anchor,
            message,
            trace: newTrace,
            traceStep,
        });
        traceStep(newTrace, 'optimize', 'running', {
            request_type: settings().comfyPromptOptimizerRequestType || KLEIN_PROMPT_OPTIMIZER_REQUEST_TYPE,
            mode: settings().comfyPromptOptimizerMode || 'append',
        });
        const finalRequest = await optimizeKleinPromptIfNeeded(referenceReadyRequest, { messageId, anchor, message });
        newTrace.prompt_optimized = trimTraceString(finalRequest?.debugPromptOptimized || '');
        newTrace.prompt_final = trimTraceString(finalRequest?.debugPromptFinal || finalRequest?.prompt || '');
        traceStep(newTrace, 'optimize', optimizerStepStatus(finalRequest), {
            status: finalRequest?.debugPromptOptimizerStatus || '',
            reason: finalRequest?.debugPromptOptimizerReason || '',
            raw_prompt: finalRequest?.debugPromptRaw || request.prompt,
            optimized_prompt: finalRequest?.debugPromptOptimized || '',
            final_prompt: finalRequest?.debugPromptFinal || finalRequest?.prompt || '',
        });
        traceStep(newTrace, 'workflow', 'done', {
            workflow_adapter: finalRequest?.workflowAdapter || '',
            route: finalRequest?.workflowAdapter === 'flux2-klein-reference' ? 'Klein reference workflow' : 'default ComfyUI workflow',
            reference_matching: finalRequest?.workflowAdapter === 'flux2-klein-reference' ? 'handled by ComfyUI reference route' : '',
        });

        const response = await runComfyRequest(finalRequest, newTrace);
        const comfyDebug = captureComfyDebugForTrace(newTrace, response);
        const storedResponse = await compactResponseImageForChat(response, finalRequest, newTrace);
        traceStep(newTrace, 'writeback', 'running', { target: 'chat_message', message_id: messageId });
        const replacement = buildResultReplacement(anchor, finalRequest, storedResponse, newTrace);
        const wroteFinal = await writeRegenerationUpdate(messageId, placeholderPattern, replacement);
        if (!wroteFinal) {
            await writeRegenerationUpdate(messageId, initialPattern, replacement);
        }
        traceStep(newTrace, 'writeback', 'done', {
            replacement: 'regenerated_result',
            response: summarizeComfyResponse(storedResponse),
            comfy_debug: comfyDebug,
        });
        finishTrace(newTrace, 'done', {
            response: summarizeComfyResponse(storedResponse),
            prompt_comfy: newTrace.prompt_comfy || '',
            prompt_mismatch: newTrace.prompt_mismatch === true,
            reference_image: newTrace.reference_image || '',
        });
        return true;
    } catch (error) {
        failTrace(newTrace, error, { phase: 'regeneration' });
        const fallback = buildErrorReplacement(anchor, error, newTrace);
        const wroteError = await writeRegenerationUpdate(messageId, placeholderPattern, fallback);
        if (!wroteError) {
            await writeRegenerationUpdate(messageId, initialPattern, fallback);
        }
        return true;
    }
}

function closeImagePromptDialog() {
    document.getElementById('st-chatu8-image-prompt-dialog')?.remove();
}

function showImagePromptDialog(prompt, trace = null) {
    closeImagePromptDialog();
    const overlay = document.createElement('div');
    overlay.id = 'st-chatu8-image-prompt-dialog';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px;';
    const panel = document.createElement('div');
    panel.style.cssText = 'width:min(760px,100%);max-height:86vh;background:var(--SmartThemeBodyColor,#fff);color:var(--SmartThemeEmColor,#111);border:1px solid rgba(127,127,127,.35);border-radius:10px;box-shadow:0 16px 48px rgba(0,0,0,.35);display:flex;flex-direction:column;gap:10px;padding:14px;';
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:700;font-size:15px;line-height:1.35;';
    title.textContent = `最终提示词${trace?.anchor_id ? ` · ${trace.anchor_id}` : ''}`;
    const textarea = document.createElement('textarea');
    textarea.readOnly = true;
    textarea.value = prompt;
    textarea.style.cssText = 'width:100%;min-height:220px;max-height:58vh;resize:vertical;box-sizing:border-box;font:13px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;';
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = '复制';
    copy.addEventListener('click', async () => {
        await copyText(prompt);
        copy.textContent = '已复制';
        setTimeout(() => {
            copy.textContent = '复制';
        }, 1200);
    });
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '关闭';
    close.addEventListener('click', closeImagePromptDialog);
    actions.append(copy, close);
    panel.append(title, textarea, actions);
    overlay.append(panel);
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) {
            closeImagePromptDialog();
        }
    });
    document.body.append(overlay);
    textarea.focus();
    textarea.select();
}

function bindGeneratedImagePromptViewer() {
    if (typeof document === 'undefined' || document.documentElement.dataset.stChatu8ImagePromptViewer === TRACE_VERSION) {
        return;
    }

    document.documentElement.dataset.stChatu8ImagePromptViewer = TRACE_VERSION;
    let longPressTimer = null;
    let longPressTarget = null;
    const findImage = (target) => target?.closest?.('img.st-chatu8-generated-image, .mes_text img');
    const clearLongPress = () => {
        if (longPressTimer) {
            clearTimeout(longPressTimer);
        }
        longPressTimer = null;
        longPressTarget = null;
    };
    const openForImage = (image) => {
        const { trace, prompt } = promptForImage(image);
        if (!prompt) {
            return false;
        }
        showImagePromptDialog(prompt, trace);
        return true;
    };

    document.addEventListener('click', (event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
            return;
        }

        const button = event.target?.closest?.('.st-chatu8-image-regenerate-btn:not([disabled])');
        if (!button) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        regenerateGeneratedImage(button).catch((error) => {
            console.warn('[st-chatu8] Failed to regenerate generated image:', error);
        });
    }, true);
    document.addEventListener('contextmenu', (event) => {
        const image = findImage(event.target);
        if (!image || !openForImage(image)) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
    }, true);
    document.addEventListener('touchstart', (event) => {
        const image = findImage(event.target);
        if (!image) {
            return;
        }
        clearLongPress();
        longPressTarget = image;
        longPressTimer = setTimeout(() => {
            if (longPressTarget && openForImage(longPressTarget)) {
                event.preventDefault();
            }
            clearLongPress();
        }, 650);
    }, { passive: false, capture: true });
    document.addEventListener('touchend', clearLongPress, true);
    document.addEventListener('touchcancel', clearLongPress, true);
    document.addEventListener('touchmove', clearLongPress, true);
}

function runComfyRequest(payload, trace = null) {
    return new Promise((resolve, reject) => {
        let timeoutId;
        let settled = false;
        const cleanup = () => {
            clearTimeout(timeoutId);
            eventSource.removeListener(EventType.GENERATE_IMAGE_RESPONSE, onResponse);
        };
        const onResponse = (response) => {
            if (!response || response.id !== payload.id) {
                return;
            }

            settled = true;
            cleanup();
            const comfyDebug = captureComfyDebugForTrace(trace, response);
            if (response.success) {
                traceStep(trace, 'wait', 'done', { response: summarizeComfyResponse(response), comfy_debug: comfyDebug });
                resolve(response);
            } else {
                const error = new Error(comfyResponseErrorText(response) || 'ComfyUI generation failed');
                traceStep(trace, 'wait', 'failed', { response: summarizeComfyResponse(response), comfy_debug: comfyDebug, error: error.message });
                reject(error);
            }
        };

        timeoutId = setTimeout(() => {
            settled = true;
            cleanup();
            const error = new Error(`ComfyUI generation timed out after ${Math.round(DEFAULT_TIMEOUT_MS / 1000)} seconds`);
            traceStep(trace, 'wait', 'failed', { error: error.message });
            reject(error);
        }, DEFAULT_TIMEOUT_MS);

        eventSource.on(EventType.GENERATE_IMAGE_RESPONSE, onResponse);
        traceStep(trace, 'submit', 'running', {
            request_id: payload.id,
            width: payload.width,
            height: payload.height,
            mode: payload.mode,
        });
        traceStep(trace, 'submit', 'done', { request_id: payload.id });
        traceStep(trace, 'wait', 'running', { timeout_ms: DEFAULT_TIMEOUT_MS });
        const emitFailed = (error) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            traceStep(trace, 'submit', 'failed', { error: error?.message || String(error) });
            reject(error);
        };
        try {
            Promise.resolve(eventSource.emit(EventType.GENERATE_IMAGE_REQUEST, payload)).catch(emitFailed);
        } catch (error) {
            emitFailed(error);
        }
    });
}

function getMessageState(message) {
    if (!message.extra || typeof message.extra !== 'object') {
        message.extra = {};
    }

    if (!message.extra.chatu8HiddenJsonAnchors || typeof message.extra.chatu8HiddenJsonAnchors !== 'object') {
        message.extra.chatu8HiddenJsonAnchors = {};
    }

    return message.extra.chatu8HiddenJsonAnchors;
}

function isAnchorPending(stateEntry) {
    if (!stateEntry?.status) {
        return true;
    }

    if (stateEntry.status === 'done') {
        return false;
    }

    if (stateEntry.status === 'running') {
        const trace = stateEntry.trace_id ? findTrace(stateEntry.trace_id) : null;
        if (trace?.status === 'done' || trace?.status === 'failed') {
            return false;
        }
    }

    if (stateEntry.status !== 'running') {
        return false;
    }

    const updatedAt = new Date(stateEntry.updated_at || 0).getTime();
    return !Number.isFinite(updatedAt) || Date.now() - updatedAt > DEFAULT_TIMEOUT_MS;
}

async function rerenderMessage(messageId, options = {}) {
    const message = chat[messageId];
    if (!message) {
        return;
    }
    const renderText = applyLiveAnchorPlaceholders(messageId, message.mes);

    const element = document.querySelector(`.mes[mesid="${String(messageId).replaceAll('"', '\\"')}"] .mes_text`);
    if (element) {
        element.innerHTML = messageFormatting(
            renderText,
            message.name || '',
            Boolean(message.is_system),
            Boolean(message.is_user),
            Number(messageId),
        );
        hydrateGeneratedImages(element);
    }

    if (options.emitUpdate !== false) {
        await eventSource.emit(event_types.MESSAGE_UPDATED, Number(messageId));
    }
}

function replaceAnchorTextForWriteback(message, anchor, replacement, status, trace = null, placeholderHtml = '') {
    const originalText = typeof message?.mes === 'string' ? message.mes : '';
    if (!originalText) {
        return { text: originalText, method: 'empty_message' };
    }

    if (placeholderHtml && originalText.includes(placeholderHtml)) {
        return {
            text: originalText.replace(placeholderHtml, replacement),
            method: 'exact_placeholder',
        };
    }

    const placeholderReplaced = replacePersistedPlaceholder(originalText, anchor, replacement, trace);
    if (placeholderReplaced !== null) {
        return {
            text: placeholderReplaced,
            method: 'persisted_placeholder',
        };
    }

    const sourceReplaced = replaceAnchorSourceText(message, anchor, replacement);
    if (sourceReplaced.text !== originalText) {
        return sourceReplaced;
    }

    if (status === 'done' && anchor?.type !== 'image_text') {
        return {
            text: `${originalText.trimEnd()}\n\n${replacement}`,
            method: 'append_fallback',
        };
    }

    return {
        text: originalText,
        method: 'not_found',
    };
}

async function replaceAnchorInMessage(messageId, anchor, replacement, status, trace = null) {
    const message = chat[messageId];
    if (!message || typeof message.mes !== 'string') {
        return;
    }

    const liveEntry = trace?.trace_id ? liveAnchorPlaceholders.get(trace.trace_id) : null;
    const writeback = replaceAnchorTextForWriteback(message, anchor, replacement, status, trace, liveEntry?.html || '');
    clearLiveAnchorPlaceholder(messageId, anchor, trace);
    if (writeback.text === message.mes) {
        traceEvent(trace, 'writeback:not_found', {
            message_id: messageId,
            anchor_id: anchor?.id || '',
            status,
        });
        await rerenderMessage(messageId, { emitUpdate: false });
        return;
    }

    message.mes = writeback.text;
    const state = getMessageState(message);
    const previous = state[anchor.id] || {};
    state[anchor.id] = {
        ...previous,
        status,
        updated_at: new Date().toISOString(),
        writeback_method: writeback.method,
    };

    traceEvent(trace, 'writeback:message_updated', {
        message_id: messageId,
        anchor_id: anchor?.id || '',
        status,
        method: writeback.method,
    });
    await saveChatConditional();
    await rerenderMessage(messageId);
}

async function processMessage(messageId, reason = 'event') {
    if (!isEnabled()) {
        return;
    }

    const numericId = Number(messageId);
    if (!Number.isInteger(numericId) || numericId < 0 || processingMessages.has(numericId)) {
        return;
    }

    const chatId = getCurrentChatId();
    const message = chat[numericId];
    if (!message || message.is_user || message.is_system || typeof message.mes !== 'string') {
        return;
    }

    const anchors = parseActiveAnchors(message.mes).slice(0, clampMaxAnchors(settings().chatu8HiddenJsonMaxAnchors));
    if (!anchors.length) {
        return;
    }

    const state = getMessageState(message);
    const pending = anchors.filter((anchor) => isAnchorPending(getStoredAnchorStateEntry(message, anchor)));
    if (!pending.length) {
        return;
    }

    processingMessages.add(numericId);
    try {
        console.info(`[st-chatu8] Processing ${pending.length} image anchor(s) for message ${numericId} (${reason})`);
        for (const anchor of pending) {
            if (getCurrentChatId() !== chatId) {
                break;
            }

            const request = buildRequest(anchor, numericId);
            const trace = createTrace(anchor, request, numericId, reason);
            appendTrace(trace);
            if (!request.prompt) {
                const error = new Error('Anchor prompt is empty');
                failTrace(trace, error, { phase: 'request' });
                await replaceAnchorInMessage(numericId, anchor, buildErrorReplacement(anchor, error, trace), 'failed', trace);
                continue;
            }

            state[anchor.id] = {
                status: 'running',
                request_id: request.id,
                trace_id: trace.trace_id,
                updated_at: new Date().toISOString(),
            };
            await showLiveAnchorPlaceholder(numericId, anchor, request, trace);
            saveChatConditional().catch((error) => {
                console.warn('[st-chatu8] Failed to persist live image anchor state:', error);
            });

            try {
                const referenceReadyRequest = await ensureComfyReferenceBootstrap(request, {
                    messageId: numericId,
                    anchor,
                    message,
                    trace,
                    traceStep,
                });
                traceStep(trace, 'optimize', 'running', {
                    request_type: settings().comfyPromptOptimizerRequestType || KLEIN_PROMPT_OPTIMIZER_REQUEST_TYPE,
                    mode: settings().comfyPromptOptimizerMode || 'append',
                });
                const finalRequest = await optimizeKleinPromptIfNeeded(referenceReadyRequest, { messageId: numericId, anchor, message });
                trace.prompt_optimized = trimTraceString(finalRequest?.debugPromptOptimized || '');
                trace.prompt_final = trimTraceString(finalRequest?.debugPromptFinal || finalRequest?.prompt || '');
                traceStep(trace, 'optimize', optimizerStepStatus(finalRequest), {
                    status: finalRequest?.debugPromptOptimizerStatus || '',
                    reason: finalRequest?.debugPromptOptimizerReason || '',
                    raw_prompt: finalRequest?.debugPromptRaw || request.prompt,
                    optimized_prompt: finalRequest?.debugPromptOptimized || '',
                    final_prompt: finalRequest?.debugPromptFinal || finalRequest?.prompt || '',
                });
                traceStep(trace, 'workflow', 'done', {
                    workflow_adapter: finalRequest?.workflowAdapter || '',
                    route: finalRequest?.workflowAdapter === 'flux2-klein-reference' ? 'Klein reference workflow' : 'default ComfyUI workflow',
                    reference_matching: finalRequest?.workflowAdapter === 'flux2-klein-reference' ? 'handled by ComfyUI reference route' : '',
                });

                const response = await runComfyRequest(finalRequest, trace);
                const comfyDebug = captureComfyDebugForTrace(trace, response);
                const storedResponse = await compactResponseImageForChat(response, finalRequest, trace);
                traceStep(trace, 'writeback', 'running', { target: 'chat_message', message_id: numericId });
                await replaceAnchorInMessage(numericId, anchor, buildResultReplacement(anchor, finalRequest, storedResponse, trace), 'done', trace);
                traceStep(trace, 'writeback', 'done', {
                    replacement: 'result',
                    response: summarizeComfyResponse(storedResponse),
                    comfy_debug: comfyDebug,
                });
                finishTrace(trace, 'done', {
                    response: summarizeComfyResponse(storedResponse),
                    prompt_comfy: trace.prompt_comfy || '',
                    prompt_mismatch: trace.prompt_mismatch === true,
                    reference_image: trace.reference_image || '',
                });
            } catch (error) {
                failTrace(trace, error, { phase: 'generation' });
                await replaceAnchorInMessage(numericId, anchor, buildErrorReplacement(anchor, error, trace), 'failed', trace);
            }
        }
    } finally {
        processingMessages.delete(numericId);
    }
}

function enqueueMessage(messageId, reason) {
    queue = queue.then(() => processMessage(messageId, reason)).catch((error) => {
        console.error('[st-chatu8] Image anchor processing failed:', error);
    });
}

function enqueueRecentAnchorMessages(reason = 'initial_scan') {
    if (!Array.isArray(chat) || !isEnabled()) {
        return;
    }

    const start = Math.max(0, chat.length - 50);
    for (let index = start; index < chat.length; index++) {
        const message = chat[index];
        if (!message || message.is_user || message.is_system || typeof message.mes !== 'string') {
            continue;
        }

        if (parseActiveAnchors(message.mes).length) {
            enqueueMessage(index, reason);
        }
    }
}

function bindSettingsUi() {
    const bindingVersion = '4';
    const enable = document.getElementById('st_chatu8_anchor_enable');
    const imageEnable = document.getElementById('st_chatu8_image_anchor_enable');
    const max = document.getElementById('st_chatu8_anchor_max');
    const failures = document.getElementById('st_chatu8_anchor_show_failures');
    const status = document.getElementById('st_chatu8_anchor_status');
    const optimizerEnable = document.getElementById('st_chatu8_klein_prompt_optimizer_enable');
    const optimizerMode = document.getElementById('st_chatu8_klein_prompt_optimizer_mode');
    const optimizerRequestType = document.getElementById('st_chatu8_klein_prompt_optimizer_request_type');
    const optimizerApiProfile = document.getElementById('st_chatu8_klein_prompt_optimizer_api_profile');
    const optimizerApiUrl = document.getElementById('st_chatu8_klein_prompt_optimizer_api_url');
    const optimizerApiKey = document.getElementById('st_chatu8_klein_prompt_optimizer_api_key');
    const optimizerModel = document.getElementById('st_chatu8_klein_prompt_optimizer_model');
    const optimizerTemperature = document.getElementById('st_chatu8_klein_prompt_optimizer_temperature');
    const optimizerTopP = document.getElementById('st_chatu8_klein_prompt_optimizer_top_p');
    const optimizerMaxTokens = document.getElementById('st_chatu8_klein_prompt_optimizer_max_tokens');
    const optimizerBypassProxy = document.getElementById('st_chatu8_klein_prompt_optimizer_bypass_proxy');
    const optimizerContextProfile = document.getElementById('st_chatu8_klein_prompt_optimizer_context_profile');
    const optimizerFallback = document.getElementById('st_chatu8_klein_prompt_optimizer_fallback');
    const optimizerManualTraits = document.getElementById('st_chatu8_klein_prompt_optimizer_manual_traits');
    const optimizerVisionTraits = document.getElementById('st_chatu8_klein_prompt_optimizer_vision_traits');
    const optimizerVisionMode = document.getElementById('st_chatu8_klein_prompt_optimizer_vision_mode');
    const optimizerSystemPrompt = document.getElementById('st_chatu8_klein_prompt_optimizer_system_prompt');
    if (!enable) {
        return;
    }

    const data = settings();
    const getOptimizerRequestType = () => safeString(
        optimizerRequestType?.value || data.comfyPromptOptimizerRequestType,
        KLEIN_PROMPT_OPTIMIZER_REQUEST_TYPE,
    );
    const getProfileConfig = () => {
        const requestType = getOptimizerRequestType();
        if (!data.llm_request_type_configs || typeof data.llm_request_type_configs !== 'object') {
            data.llm_request_type_configs = {};
        }
        if (!data.llm_request_type_configs[requestType]) {
            data.llm_request_type_configs[requestType] = {};
        }
        return data.llm_request_type_configs[requestType];
    };
    const getSelectedOptimizerApiProfileName = () => safeString(
        optimizerApiProfile?.value || getProfileConfig().api_profile,
        '默认',
    );
    const ensureOptimizerApiProfile = (name = getSelectedOptimizerApiProfileName()) => {
        if (!data.llm_profiles || typeof data.llm_profiles !== 'object') {
            data.llm_profiles = {};
        }

        const profileName = safeString(name, '默认');
        if (!data.llm_profiles[profileName] || typeof data.llm_profiles[profileName] !== 'object') {
            data.llm_profiles[profileName] = {};
        }

        const profile = data.llm_profiles[profileName];
        if (profile.temperature === undefined) {
            profile.temperature = 0.7;
        }
        if (profile.top_p === undefined) {
            profile.top_p = 1;
        }
        if (profile.max_tokens === undefined) {
            profile.max_tokens = 1200;
        }
        if (profile.stream === undefined) {
            profile.stream = false;
        }
        if (profile.bypass_proxy === undefined) {
            profile.bypass_proxy = false;
        }

        return profile;
    };
    const setFieldValue = (field, value) => {
        if (!field || document.activeElement === field) {
            return;
        }

        field.value = value === undefined || value === null ? '' : String(value);
    };
    const fillSelect = (select, values, selected) => {
        if (!select) {
            return;
        }

        const options = Array.from(new Set(['默认', ...values.map((value) => safeString(value)).filter(Boolean)]));
        const signature = options.join('\n');
        if (select.dataset.chatu8OptionsSig !== signature) {
            select.innerHTML = '';
            for (const value of options) {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = value;
                select.appendChild(option);
            }
            select.dataset.chatu8OptionsSig = signature;
        }

        select.value = options.includes(selected) ? selected : options[0];
    };
    const updateStatus = () => {
        if (status) {
            const optimizer = data.comfyPromptOptimizerEnabled === true ? `optimizer ${data.comfyPromptOptimizerMode || 'append'}` : 'optimizer off';
            status.textContent = `image### ${data.enableChatu8ImageTextAnchors === true ? 'enabled' : 'disabled'} / chatu8_img ${data.enableChatu8HiddenJsonAnchors === true ? 'enabled' : 'disabled'} / ${optimizer}`;
        }
    };
    const syncOptimizerProfiles = () => {
        const profileConfig = getProfileConfig();
        fillSelect(optimizerApiProfile, Object.keys(data.llm_profiles || {}), safeString(profileConfig.api_profile, '默认'));
        fillSelect(optimizerContextProfile, Object.keys(data.llm_context_profiles || {}), safeString(profileConfig.context_profile, '默认'));
    };
    const syncOptimizerApiProfileFields = () => {
        const profile = ensureOptimizerApiProfile();
        setFieldValue(optimizerApiUrl, profile.api_url || '');
        setFieldValue(optimizerApiKey, profile.api_key || '');
        setFieldValue(optimizerModel, profile.model || '');
        setFieldValue(optimizerTemperature, profile.temperature ?? 0.7);
        setFieldValue(optimizerTopP, profile.top_p ?? 1);
        setFieldValue(optimizerMaxTokens, profile.max_tokens ?? 1200);
        if (optimizerBypassProxy) {
            optimizerBypassProxy.checked = profile.bypass_proxy === true;
        }
    };
    const saveOptimizerApiProfileFields = () => {
        const profile = ensureOptimizerApiProfile();
        if (optimizerApiUrl) {
            profile.api_url = safeString(optimizerApiUrl.value);
        }
        if (optimizerApiKey) {
            profile.api_key = safeString(optimizerApiKey.value);
        }
        if (optimizerModel) {
            profile.model = safeString(optimizerModel.value);
        }
        if (optimizerTemperature) {
            profile.temperature = safeNumber(optimizerTemperature.value, 0.7);
        }
        if (optimizerTopP) {
            profile.top_p = safeNumber(optimizerTopP.value, 1);
        }
        if (optimizerMaxTokens) {
            profile.max_tokens = Math.max(1, Math.floor(safeNumber(optimizerMaxTokens.value, 1200)));
        }
        if (optimizerBypassProxy) {
            profile.bypass_proxy = optimizerBypassProxy.checked;
        }
    };

    syncOptimizerProfiles();
    syncOptimizerApiProfileFields();
    bindTraceConsoleUi();
    if (
        enable.dataset.chatu8AnchorBound === bindingVersion
        && (!imageEnable || imageEnable.dataset.chatu8AnchorBound === bindingVersion)
        && (!optimizerEnable || optimizerEnable.dataset.chatu8AnchorBound === bindingVersion)
    ) {
        return;
    }

    enable.checked = data.enableChatu8HiddenJsonAnchors === true;
    if (imageEnable) {
        imageEnable.checked = data.enableChatu8ImageTextAnchors === true;
    }
    if (max) {
        max.value = String(clampMaxAnchors(data.chatu8HiddenJsonMaxAnchors));
    }
    if (failures) {
        failures.checked = data.chatu8HiddenJsonShowFailures !== false;
    }
    if (optimizerEnable) {
        optimizerEnable.checked = data.comfyPromptOptimizerEnabled === true;
    }
    if (optimizerMode) {
        optimizerMode.value = safeString(data.comfyPromptOptimizerMode, 'append');
    }
    if (optimizerRequestType) {
        optimizerRequestType.value = safeString(data.comfyPromptOptimizerRequestType, KLEIN_PROMPT_OPTIMIZER_REQUEST_TYPE);
    }
    if (optimizerFallback) {
        optimizerFallback.checked = data.comfyPromptOptimizerFallbackToRaw !== false;
    }
    if (optimizerManualTraits) {
        optimizerManualTraits.checked = data.comfyPromptOptimizerUseManualTraits !== false;
    }
    if (optimizerVisionTraits) {
        optimizerVisionTraits.checked = data.comfyPromptOptimizerUseVisionTraits === true;
    }
    if (optimizerVisionMode) {
        optimizerVisionMode.value = safeString(data.comfyPromptOptimizerVisionMode, 'missing_only');
    }
    if (optimizerSystemPrompt) {
        optimizerSystemPrompt.value = safeString(data.comfyPromptOptimizerSystemPrompt, DEFAULT_KLEIN_PROMPT_OPTIMIZER_SYSTEM_PROMPT);
    }
    syncOptimizerProfiles();
    syncOptimizerApiProfileFields();
    updateStatus();

    const save = (event = null) => {
        const shouldReloadProfileFields = event?.target === optimizerApiProfile || event?.target === optimizerRequestType;
        data.enableChatu8HiddenJsonAnchors = enable.checked;
        data.enableChatu8ImageTextAnchors = imageEnable ? imageEnable.checked : true;
        data.chatu8HiddenJsonMaxAnchors = max ? clampMaxAnchors(max.value) : DEFAULT_MAX_ANCHORS;
        data.chatu8HiddenJsonShowFailures = failures ? failures.checked : true;
        data.comfyPromptOptimizerEnabled = optimizerEnable ? optimizerEnable.checked : false;
        data.comfyPromptOptimizerMode = optimizerMode ? safeString(optimizerMode.value, 'append') : 'append';
        data.comfyPromptOptimizerRequestType = optimizerRequestType ? safeString(optimizerRequestType.value, KLEIN_PROMPT_OPTIMIZER_REQUEST_TYPE) : KLEIN_PROMPT_OPTIMIZER_REQUEST_TYPE;
        data.comfyPromptOptimizerFallbackToRaw = optimizerFallback ? optimizerFallback.checked : true;
        data.comfyPromptOptimizerUseManualTraits = optimizerManualTraits ? optimizerManualTraits.checked : true;
        data.comfyPromptOptimizerUseVisionTraits = optimizerVisionTraits ? optimizerVisionTraits.checked : false;
        data.comfyPromptOptimizerVisionMode = optimizerVisionMode ? safeString(optimizerVisionMode.value, 'missing_only') : 'missing_only';
        data.comfyPromptOptimizerSystemPrompt = optimizerSystemPrompt ? safeString(optimizerSystemPrompt.value, DEFAULT_KLEIN_PROMPT_OPTIMIZER_SYSTEM_PROMPT) : DEFAULT_KLEIN_PROMPT_OPTIMIZER_SYSTEM_PROMPT;
        const profileConfig = getProfileConfig();
        if (optimizerApiProfile) {
            profileConfig.api_profile = safeString(optimizerApiProfile.value, '默认');
        }
        if (optimizerContextProfile) {
            profileConfig.context_profile = safeString(optimizerContextProfile.value, '默认');
        }
        if (shouldReloadProfileFields) {
            syncOptimizerProfiles();
            syncOptimizerApiProfileFields();
        } else {
            saveOptimizerApiProfileFields();
            syncOptimizerProfiles();
            syncOptimizerApiProfileFields();
        }
        updateStatus();
        saveSettingsDebounced();
    };

    if (enable.dataset.chatu8AnchorBound !== bindingVersion) {
        enable.addEventListener('change', save);
        enable.dataset.chatu8AnchorBound = bindingVersion;
    }
    if (imageEnable && imageEnable.dataset.chatu8AnchorBound !== bindingVersion) {
        imageEnable.addEventListener('change', save);
        imageEnable.dataset.chatu8AnchorBound = bindingVersion;
    }
    if (max && max.dataset.chatu8AnchorBound !== bindingVersion) {
        max.addEventListener('change', save);
        max.dataset.chatu8AnchorBound = bindingVersion;
    }
    if (failures && failures.dataset.chatu8AnchorBound !== bindingVersion) {
        failures.addEventListener('change', save);
        failures.dataset.chatu8AnchorBound = bindingVersion;
    }
    for (const field of [
        optimizerEnable,
        optimizerMode,
        optimizerRequestType,
        optimizerApiProfile,
        optimizerApiUrl,
        optimizerApiKey,
        optimizerModel,
        optimizerTemperature,
        optimizerTopP,
        optimizerMaxTokens,
        optimizerBypassProxy,
        optimizerContextProfile,
        optimizerFallback,
        optimizerManualTraits,
        optimizerVisionTraits,
        optimizerVisionMode,
        optimizerSystemPrompt,
    ]) {
        if (field && field.dataset.chatu8AnchorBound !== bindingVersion) {
            const eventName = field.tagName === 'TEXTAREA' || (field.tagName === 'INPUT' && !['checkbox', 'radio'].includes(field.type)) ? 'input' : 'change';
            field.addEventListener(eventName, save);
            field.dataset.chatu8AnchorBound = bindingVersion;
        }
    }
}

function installDebugProbe() {
    if (typeof window === 'undefined') {
        return;
    }

    document.documentElement.dataset.stChatu8AnchorProtocol = TRACE_VERSION;
    window.__stChatu8AnchorProtocolDebug = {
        parse(text, activeOnly = false) {
            const anchors = activeOnly ? parseActiveAnchors(text) : parseAnchors(text);
            return anchors.map((anchor) => ({
                id: anchor.id,
                type: anchor.type || 'hidden_json',
                data: anchor.data,
                raw: anchor.raw,
            }));
        },
        requests(text, messageId = 0) {
            return parseActiveAnchors(text)
                .slice(0, clampMaxAnchors(settings().chatu8HiddenJsonMaxAnchors))
                .map((anchor) => buildRequest(anchor, Number(messageId) || 0));
        },
        result(text, response = { imageData: 'data:image/png;base64,AA==', format: 'png' }) {
            const anchor = parseAnchors(text)[0];
            if (!anchor) {
                return null;
            }
            const request = buildRequest(anchor, 0);
            return buildResultReplacement(anchor, request, response);
        },
        isEnabled,
        settings,
        traces() {
            return getTraceLog();
        },
        diagnostics(traceId = '') {
            return buildTraceDiagnostics(findTrace(traceId) || selectedTrace(), true);
        },
        clearTraces() {
            settings().chatu8AnchorTraceLog = [];
            persistTraceLog();
        },
    };
}

function initialize() {
    settings();
    installDebugProbe();
    bindGeneratedImagePromptViewer();
    bindGeneratedImageHydration();
    eventSource.on(event_types.MESSAGE_RECEIVED, (messageId) => enqueueMessage(messageId, 'message_received'));
    eventSource.on(event_types.MESSAGE_SWIPED, (messageId) => enqueueMessage(messageId, 'message_swiped'));
    eventSource.on(event_types.MESSAGE_UPDATED, (messageId) => enqueueMessage(messageId, 'message_updated'));
    eventSource.on(event_types.SETTINGS_LOADED, bindSettingsUi);
    eventSource.on(event_types.SETTINGS_UPDATED, bindSettingsUi);

    setTimeout(bindFloatingWorkbenchUi, 0);
    setTimeout(bindSettingsUi, 0);
    setTimeout(() => enqueueRecentAnchorMessages('initial_scan'), 1200);
    setInterval(bindFloatingWorkbenchUi, 2500);
    setInterval(bindSettingsUi, 1500);
}

initialize();
