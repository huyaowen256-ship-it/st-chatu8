import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { extensionName } from './config.js';

const VERSION = '20260518_visual_variables_dropdown_v1';
const IMAGE_FILE_PATTERN = /\.(png|jpe?g|webp|gif|bmp|tiff?|avif)$/i;
const MODEL_FILE_PATTERN = /\.(safetensors|ckpt|pt|pth|bin)$/i;
const STRING_CHOICE_LIMIT = 240;
const COMFY_OBJECT_INFO_TIMEOUT = 8000;

const STATIC_INPUT_CHOICES = {
    sampler_name: [
        'euler', 'euler_ancestral', 'heun', 'heunpp2', 'dpm_2', 'dpm_2_ancestral',
        'lms', 'dpm_fast', 'dpm_adaptive', 'dpmpp_2s_ancestral', 'dpmpp_sde',
        'dpmpp_2m', 'dpmpp_2m_sde', 'dpmpp_3m_sde', 'ddim', 'uni_pc', 'uni_pc_bh2',
    ],
    scheduler: ['normal', 'karras', 'exponential', 'sgm_uniform', 'simple', 'ddim_uniform', 'beta'],
    add_noise: ['enable', 'disable'],
    return_with_leftover_noise: ['enable', 'disable'],
    device: ['default', 'cpu', 'cuda'],
    type: ['stable_diffusion', 'stable_cascade', 'sd3', 'stable_audio', 'mochi', 'ltxv', 'pixart', 'hunyuan_video', 'flux'],
    weight_dtype: ['default', 'fp8_e4m3fn', 'fp8_e5m2', 'fp16', 'bf16', 'fp32'],
};

const RUNTIME_REFERENCE_IMAGE_VARIABLES = [
    '%comfyui_reference_image%',
    '%referenceImage%',
    '%comfyuicankaotupian%',
    '%comfyuicankaotupian_1%',
    '%comfyuicankaotupian_2%',
    '%comfyuicankaotupian_3%',
];

const RUNTIME_PROMPT_VARIABLES = [
    '%prompt%',
    '%positive%',
    '%character_identity%',
    '%角色身份信息%',
    '%outfit%',
    '%服装%',
    '%outfit_state%',
    '%服装状态%',
    '%current_frame%',
    '%当前画面%',
    '%debugPromptFinal%',
    '%debugPromptOptimized%',
    '%debugPromptRaw%',
];

const ST_CH_COMFY_VISUAL_PLACEHOLDERS = [
    { placeholder: '%角色身份信息%', label: '角色身份信息（中文占位符）' },
    { placeholder: '%服装%', label: '服装（中文占位符）' },
    { placeholder: '%服装状态%', label: '服装状态（中文占位符）' },
    { placeholder: '%当前画面%', label: '当前画面（中文占位符）' },
    { placeholder: '%character_identity%', label: '角色身份信息' },
    { placeholder: '%outfit%', label: '服装' },
    { placeholder: '%outfit_state%', label: '服装状态' },
    { placeholder: '%current_frame%', label: '当前画面' },
];

const RUNTIME_NEGATIVE_VARIABLES = [
    '%negative_prompt%',
    '%negativePrompt%',
    '%negative%',
];

const TARGETS = {
    worker_import: {
        inputId: 'worker_import_file',
        selectId: 'workerid',
        textareaId: 'worker',
        activeKey: 'workerid',
        valueKey: 'worker',
        title: '生图工作流',
    },
    edit_worker_import: {
        inputId: 'edit_worker_import_file',
        selectId: 'editWorkerid',
        textareaId: 'editWorker',
        activeKey: 'editWorkerid',
        valueKey: 'editWorker',
        title: '修图工作流',
    },
};

const MAIN_TARGET = TARGETS.worker_import;
const EDIT_TARGET = TARGETS.edit_worker_import;
const ALL_WORKFLOW_SELECTS = ['workerid', 'editWorkerid'];

const COMMON_WIDGET_INPUTS = {
    KSampler: ['seed', null, 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'],
    KSamplerAdvanced: ['add_noise', 'noise_seed', null, 'steps', 'cfg', 'sampler_name', 'scheduler', 'start_at_step', 'end_at_step', 'return_with_leftover_noise'],
    CheckpointLoaderSimple: ['ckpt_name'],
    VAELoader: ['vae_name'],
    LoraLoader: ['lora_name', 'strength_model', 'strength_clip'],
    CLIPTextEncode: ['text'],
    SaveImage: ['filename_prefix'],
    PreviewImage: [],
    EmptyLatentImage: ['width', 'height', 'batch_size'],
    LoadImage: ['image', 'upload'],
    CLIPLoader: ['clip_name', 'type', 'device'],
    UNETLoader: ['unet_name', 'weight_dtype'],
    DualCLIPLoader: ['clip_name1', 'clip_name2', 'type', 'device'],
    VAEDecode: [],
    VAEEncode: [],
};

const UI_ONLY_WIDGET_INPUTS = new Set(['control_after_generate']);

let editorState = null;
let comfyObjectInfoCache = null;
let comfyObjectInfoCacheUrl = '';
let comfyObjectInfoLoading = false;
let lastComfyVariableTextTarget = null;

function asString(value) {
    return value == null ? '' : String(value);
}

function trimString(value) {
    return asString(value).trim();
}

function isPlainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

function isWorkflowNode(value) {
    return isPlainObject(value) && ('class_type' in value || 'inputs' in value || '_meta' in value);
}

function isApiWorkflow(value) {
    return isPlainObject(value) && Object.values(value).some(isWorkflowNode);
}

function isUiWorkflow(value) {
    return isPlainObject(value) && Array.isArray(value.nodes) && Array.isArray(value.links);
}

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function settings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = {};
    }
    const data = extension_settings[extensionName];
    if (!isPlainObject(data.workers)) {
        data.workers = {};
    }
    return data;
}

function normalizeComfyUrl(value) {
    return trimString(value).replace(/\/+$/, '');
}

function currentComfyUrl() {
    const data = settings();
    const profile = data.comfyui_profiles?.[data.comfyui_profile_id];
    const input = typeof document !== 'undefined' ? document.getElementById('comfyuiUrl') : null;
    return normalizeComfyUrl(
        input?.value ||
        data.comfyuiUrl ||
        data.comfyui_url ||
        profile?.comfyuiUrl ||
        profile?.comfyui_url ||
        ''
    );
}

function comfyFetchOptions(signal) {
    const options = { signal };
    if (typeof getComfyUIHeaders === 'function') {
        options.headers = getComfyUIHeaders();
    }
    return options;
}

async function refreshComfyObjectInfo(force = false, silent = false) {
    const url = currentComfyUrl();
    if (!url) {
        if (!silent) {
            notify('请先填写 ComfyUI API 地址。', 'warning');
        }
        return null;
    }
    if (!force && comfyObjectInfoCache && comfyObjectInfoCacheUrl === url) {
        return comfyObjectInfoCache;
    }
    if (comfyObjectInfoLoading) {
        return comfyObjectInfoCache;
    }

    const button = document.getElementById('st_chatu8_workflow_refresh_choices');
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), COMFY_OBJECT_INFO_TIMEOUT);
    comfyObjectInfoLoading = true;
    if (button) {
        button.disabled = true;
        button.dataset.loading = 'true';
    }

    try {
        const response = await fetch(`${url}/object_info`, comfyFetchOptions(controller.signal));
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        comfyObjectInfoCache = await response.json();
        comfyObjectInfoCacheUrl = url;
        rerender();
        if (!silent) {
            notify('已刷新 ComfyUI 下拉选项。');
        }
        return comfyObjectInfoCache;
    } catch (error) {
        console.warn('[st-chatu8] refresh ComfyUI object_info failed:', error);
        if (!silent) {
            notify(`刷新下拉选项失败：${error.message || error}`, 'error');
        }
        return null;
    } finally {
        window.clearTimeout(timeout);
        comfyObjectInfoLoading = false;
        if (button) {
            button.disabled = false;
            delete button.dataset.loading;
        }
    }
}

function notify(message, type = 'success') {
    const handler = window.toastr && window.toastr[type];
    if (typeof handler === 'function') {
        handler.call(window.toastr, message);
        return;
    }
    alert(message);
}

function escapeHtml(value) {
    return asString(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function rememberComfyVariableTextTarget(target) {
    if (target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && target.type === 'text')) {
        lastComfyVariableTextTarget = target;
    }
}

function currentComfyVariableTextTarget() {
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement || (active instanceof HTMLInputElement && active.type === 'text')) {
        return active;
    }
    if (lastComfyVariableTextTarget && document.contains(lastComfyVariableTextTarget)) {
        return lastComfyVariableTextTarget;
    }
    return document.querySelector('#st_chatu8_workflow_modal textarea[data-input-name="text"], #st_chatu8_workflow_modal textarea[data-input-name]');
}

function insertComfyVariableIntoTarget(target, placeholder) {
    if (!target) {
        return;
    }
    const current = asString(target.value);
    const start = Number.isInteger(target.selectionStart) ? target.selectionStart : current.length;
    const end = Number.isInteger(target.selectionEnd) ? target.selectionEnd : start;
    target.value = `${current.slice(0, start)}${placeholder}${current.slice(end)}`;
    const cursor = start + placeholder.length;
    target.focus();
    target.setSelectionRange?.(cursor, cursor);
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
}

function isLikelyComfyPlaceholderMenu(element) {
    if (!(element instanceof HTMLElement) || element.dataset.stChatu8VisualVariables === 'true') {
        return false;
    }
    const text = element.innerText || '';
    const tokens = text.match(/%[^%\s]{2,80}%/g) || [];
    const hasKnownComfyToken = tokens.some(token => /%(?:vae|clip|c_quanzhong|c_idquanzhong|c_xijie|ipa|inpaint_image|inpaint_mask|inpaint_denoise|inpaint_positive|inpaint_negative|prompt|negative|width|height|seed|steps|cfg_scale|sampler_name|scheduler)%/i.test(token));
    if (!hasKnownComfyToken && tokens.length < 2) {
        return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 80 && rect.height > 60 && rect.bottom > 0 && rect.right > 0;
}

function augmentComfyPlaceholderMenu() {
    const menus = Array.from(document.body.querySelectorAll('div, ul, section')).filter(isLikelyComfyPlaceholderMenu);
    for (const menu of menus) {
        const childMenus = Array.from(menu.children || []).filter(isLikelyComfyPlaceholderMenu);
        if (childMenus.length) {
            continue;
        }
        menu.dataset.stChatu8VisualVariables = 'true';
        const separator = document.createElement('div');
        separator.style.cssText = 'height:1px;margin:6px 8px;background:rgba(160,170,190,.16);';
        menu.appendChild(separator);
        for (const item of ST_CH_COMFY_VISUAL_PLACEHOLDERS) {
            const button = document.createElement('button');
            button.type = 'button';
            button.style.cssText = 'display:block;width:100%;border:0;background:transparent;color:#6ea8ff;text-align:left;padding:7px 10px;cursor:pointer;font:inherit;';
            button.innerHTML = `<div style="font-weight:700">${escapeHtml(item.placeholder)}</div><div style="margin-top:2px;color:#a8b4bc;font-size:12px">${escapeHtml(item.label)}</div>`;
            button.addEventListener('mousedown', (event) => {
                event.preventDefault();
                event.stopPropagation();
                insertComfyVariableIntoTarget(currentComfyVariableTextTarget(), item.placeholder);
            });
            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
            });
            menu.appendChild(button);
        }
    }
}

function scheduleComfyPlaceholderMenuAugment() {
    setTimeout(augmentComfyPlaceholderMenu, 0);
    setTimeout(augmentComfyPlaceholderMenu, 80);
}

function defaultPresetName(file) {
    return trimString(file?.name || '').replace(/\.json$/i, '') || 'Imported Workflow';
}

function uniquePresetName(baseName) {
    const existing = settings().workers;
    let name = trimString(baseName) || 'Imported Workflow';
    let index = 2;
    while (Object.prototype.hasOwnProperty.call(existing, name)) {
        name = `${baseName} ${index}`;
        index += 1;
    }
    return name;
}

function getCurrentPresetName(target) {
    const data = settings();
    const select = document.getElementById(target.selectId);
    return trimString(select?.value || data[target.activeKey]) || 'Imported Workflow';
}

function getCurrentWorkflowText(target) {
    const data = settings();
    const textarea = document.getElementById(target.textareaId);
    const selected = getCurrentPresetName(target);
    return trimString(textarea?.value || data[target.valueKey] || data.workers?.[selected]);
}

function ensureOption(selectId, name) {
    const select = document.getElementById(selectId);
    if (!select) {
        return null;
    }
    if (!Array.from(select.options || []).some(option => option.value === name)) {
        const option = new Option(name, name);
        option.title = name;
        select.add(option);
    }
    return select;
}

function normalizeInputName(input, index) {
    return trimString(input?.name || input?.label || input?.widget?.name || input?.localized_name) || `input_${index + 1}`;
}

function linkOutputIndex(link) {
    if (Array.isArray(link)) {
        return Number(link[2] || 0);
    }
    return Number(link?.origin_slot ?? link?.originSlot ?? link?.from_slot ?? link?.fromSlot ?? 0);
}

function linkOriginNode(link) {
    if (Array.isArray(link)) {
        return link[1];
    }
    return link?.origin_id ?? link?.originId ?? link?.from_node_id ?? link?.fromNodeId ?? link?.source_id ?? link?.source;
}

function linkTargetNode(link) {
    if (Array.isArray(link)) {
        return link[3];
    }
    return link?.target_id ?? link?.targetId ?? link?.to_node_id ?? link?.toNodeId ?? link?.target;
}

function linkTargetSlot(link) {
    if (Array.isArray(link)) {
        return Number(link[4] || 0);
    }
    return Number(link?.target_slot ?? link?.targetSlot ?? link?.to_slot ?? link?.toSlot ?? 0);
}

function linkId(link) {
    if (Array.isArray(link)) {
        return link[0];
    }
    return link?.id ?? link?.link_id ?? link?.linkId;
}

function getLinkMap(uiWorkflow) {
    const map = new Map();
    for (const link of uiWorkflow.links || []) {
        const id = linkId(link);
        if (id !== undefined && id !== null) {
            map.set(String(id), link);
        }
    }
    return map;
}

function widgetNamesForNode(node) {
    const fromWidgets = Array.isArray(node.widgets)
        ? node.widgets.map(widget => trimString(widget?.name || widget?.label)).filter(Boolean)
        : [];
    if (fromWidgets.length) {
        return fromWidgets;
    }
    return COMMON_WIDGET_INPUTS[node.type] || COMMON_WIDGET_INPUTS[node.class_type] || [];
}

function applyWidgetValues(node, inputs) {
    const values = Array.isArray(node.widgets_values) ? node.widgets_values : [];
    if (!values.length) {
        return;
    }

    const names = widgetNamesForNode(node);
    for (let index = 0; index < values.length; index += 1) {
        const name = names[index];
        if (!name || UI_ONLY_WIDGET_INPUTS.has(name) || Object.prototype.hasOwnProperty.call(inputs, name)) {
            continue;
        }
        inputs[name] = clone(values[index]);
    }
}

function applyUiLinks(node, inputs, linkMap) {
    const uiInputs = Array.isArray(node.inputs) ? node.inputs : [];
    uiInputs.forEach((input, index) => {
        const name = normalizeInputName(input, index);
        let link = input?.link !== undefined && input?.link !== null ? linkMap.get(String(input.link)) : null;
        if (!link && (input?.origin_id !== undefined || input?.originId !== undefined)) {
            link = input;
        }
        if (!link) {
            return;
        }

        const origin = linkOriginNode(link);
        if (origin === undefined || origin === null) {
            return;
        }
        inputs[name] = [String(origin), linkOutputIndex(link)];
    });

    for (const link of linkMap.values()) {
        if (String(linkTargetNode(link)) !== String(node.id)) {
            continue;
        }
        const targetSlot = linkTargetSlot(link);
        const input = uiInputs[targetSlot];
        const name = input ? normalizeInputName(input, targetSlot) : `input_${targetSlot + 1}`;
        if (!Object.prototype.hasOwnProperty.call(inputs, name)) {
            inputs[name] = [String(linkOriginNode(link)), linkOutputIndex(link)];
        }
    }
}

function convertUiWorkflowToApiWorkflow(uiWorkflow) {
    if (!isUiWorkflow(uiWorkflow)) {
        throw new Error('这不是 ComfyUI 界面工作流。');
    }

    const linkMap = getLinkMap(uiWorkflow);
    const apiWorkflow = {};
    for (const node of uiWorkflow.nodes) {
        if (!node || node.id === undefined || node.id === null) {
            continue;
        }
        const classType = trimString(node.type || node.class_type);
        if (!classType) {
            continue;
        }

        const inputs = {};
        applyUiLinks(node, inputs, linkMap);
        applyWidgetValues(node, inputs);

        apiWorkflow[String(node.id)] = {
            inputs,
            class_type: classType,
            _meta: {
                title: trimString(node.title || node.type || node.class_type || node.id),
            },
        };
    }

    if (!Object.keys(apiWorkflow).length) {
        throw new Error('没有在 ComfyUI 界面工作流里找到可用节点。');
    }
    return apiWorkflow;
}

function parseJsonInput(value) {
    if (typeof value === 'string') {
        return JSON.parse(trimString(value));
    }
    return value;
}

function unwrapWorkflow(value) {
    const parsed = parseJsonInput(value);
    if (isApiWorkflow(parsed)) {
        return parsed;
    }
    if (isUiWorkflow(parsed)) {
        return convertUiWorkflowToApiWorkflow(parsed);
    }
    if (isPlainObject(parsed)) {
        for (const key of ['prompt', 'workflow', 'data']) {
            const inner = parsed[key];
            if (isApiWorkflow(inner)) {
                return inner;
            }
            if (isUiWorkflow(inner)) {
                return convertUiWorkflowToApiWorkflow(inner);
            }
            if (typeof inner === 'string') {
                try {
                    return unwrapWorkflow(inner);
                } catch {
                    // Keep trying the other wrappers.
                }
            }
        }
    }
    throw new Error('没有找到可用的 ComfyUI 工作流 JSON。');
}

function workflowContent(value) {
    return JSON.stringify(unwrapWorkflow(value), null, 2);
}

function normalizeWorkflowImports(json, defaultName) {
    try {
        return [{ name: defaultName, content: workflowContent(json) }];
    } catch {
        // A map of named presets is handled below.
    }

    const parsed = parseJsonInput(json);
    if (!isPlainObject(parsed)) {
        return [];
    }

    const imports = [];
    for (const [name, value] of Object.entries(parsed)) {
        try {
            imports.push({
                name: trimString(name) || defaultName,
                content: workflowContent(value),
            });
        } catch {
            // Ignore non-workflow entries in preset bundles.
        }
    }
    return imports;
}

function activateWorkflow(target, name, content) {
    const data = settings();
    data.workers[name] = content;
    data[target.activeKey] = name;
    data[target.valueKey] = content;

    const profile = data.comfyui_profiles?.[data.comfyui_profile_id];
    if (isPlainObject(profile)) {
        profile[target.activeKey] = name;
        profile[target.valueKey] = content;
    }

    for (const selectId of ALL_WORKFLOW_SELECTS) {
        ensureOption(selectId, name);
    }

    const select = ensureOption(target.selectId, name);
    if (select) {
        select.value = name;
        select.dispatchEvent(new Event('change', { bubbles: true }));
    }

    const textarea = document.getElementById(target.textareaId);
    if (textarea) {
        textarea.value = content;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
    }

    saveSettingsDebounced();
}

async function handleImportFile(file, target) {
    if (!file) {
        return;
    }

    const text = await file.text();
    const json = JSON.parse(text);
    const imports = normalizeWorkflowImports(json, defaultPresetName(file));
    if (!imports.length) {
        throw new Error('文件里没有可导入的 ComfyUI 工作流。');
    }

    if (imports.length === 1) {
        const chosen = window.prompt('工作流预设名称', imports[0].name);
        if (!trimString(chosen)) {
            return;
        }
        imports[0].name = trimString(chosen);
    }

    const data = settings();
    for (const item of imports) {
        data.workers[item.name] = item.content;
        for (const selectId of ALL_WORKFLOW_SELECTS) {
            ensureOption(selectId, item.name);
        }
    }

    const active = imports[imports.length - 1];
    activateWorkflow(target, active.name, active.content);
    notify(imports.length === 1
        ? `已导入工作流 "${active.name}"`
        : `已导入 ${imports.length} 个工作流，当前切换到 "${active.name}"`);
}

function getOrCreateInput(target) {
    let input = document.getElementById(target.inputId);
    if (!input) {
        input = document.createElement('input');
        input.type = 'file';
        input.id = target.inputId;
        input.className = 'st-chatu8-file-input';
        input.accept = '.json,application/json';
        input.tabIndex = -1;
        document.body.appendChild(input);
    }
    Object.assign(input.style, {
        position: 'fixed',
        left: '0',
        top: '0',
        width: '1px',
        height: '1px',
        opacity: '0',
        display: 'block',
        pointerEvents: 'none',
        zIndex: '2147483647',
    });
    return input;
}

function openImportPicker(target) {
    const input = getOrCreateInput(target);
    input.value = '';
    input.click();
}

function sortedNodeIds(workflow) {
    return Object.keys(workflow || {}).sort((left, right) => {
        const leftNumber = Number(left);
        const rightNumber = Number(right);
        if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
            return leftNumber - rightNumber;
        }
        return left.localeCompare(right);
    });
}

function nodeTitle(id, node) {
    return trimString(node?._meta?.title || node?.title || node?.class_type || id);
}

function inputSummary(value) {
    if (Array.isArray(value) && value.length === 2 && (typeof value[0] === 'string' || typeof value[0] === 'number')) {
        return `连接到节点 ${value[0]} / 输出 ${value[1]}`;
    }
    if (typeof value === 'string') {
        return value.length > 80 ? `${value.slice(0, 80)}...` : value;
    }
    return JSON.stringify(value);
}

function injectStyles() {
    if (document.getElementById('st_chatu8_visual_workflow_styles')) {
        return;
    }
    const style = document.createElement('style');
    style.id = 'st_chatu8_visual_workflow_styles';
    style.textContent = `
        .st-chatu8-workflow-modal {
            position: fixed;
            inset: 0;
            z-index: 100000;
            background: rgba(10, 14, 18, 0.78);
            display: grid;
            place-items: center;
            padding: 16px;
        }
        .st-chatu8-workflow-editor {
            width: min(1180px, 96vw);
            height: min(820px, 94vh);
            display: grid;
            grid-template-rows: auto minmax(0, 1fr);
            background: #15191d;
            color: #f2f5f7;
            border: 1px solid rgba(220, 232, 238, 0.18);
            border-radius: 8px;
            box-shadow: 0 18px 60px rgba(0, 0, 0, 0.45);
            overflow: hidden;
        }
        .st-chatu8-workflow-toolbar {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 10px;
            border-bottom: 1px solid rgba(220, 232, 238, 0.14);
            background: #1d2328;
        }
        .st-chatu8-workflow-title {
            font-weight: 700;
            min-width: max-content;
        }
        .st-chatu8-workflow-toolbar input {
            min-width: 0;
            flex: 1 1 180px;
            height: 34px;
            border: 1px solid rgba(220, 232, 238, 0.2);
            border-radius: 6px;
            background: #101316;
            color: #f2f5f7;
            padding: 0 10px;
        }
        .st-chatu8-workflow-editor button {
            min-height: 34px;
            border: 1px solid rgba(220, 232, 238, 0.2);
            border-radius: 6px;
            background: #28323a;
            color: #f2f5f7;
            padding: 0 10px;
            cursor: pointer;
        }
        .st-chatu8-workflow-editor button:hover {
            background: #34424d;
        }
        .st-chatu8-workflow-editor button[data-kind="primary"] {
            background: #0f766e;
            border-color: #15978d;
        }
        .st-chatu8-workflow-editor button[data-kind="danger"] {
            background: #7f1d1d;
            border-color: #ad3030;
        }
        .st-chatu8-workflow-body {
            display: grid;
            grid-template-columns: minmax(210px, 300px) minmax(0, 1fr);
            min-height: 0;
        }
        .st-chatu8-workflow-list {
            min-height: 0;
            border-right: 1px solid rgba(220, 232, 238, 0.14);
            background: #101316;
            display: grid;
            grid-template-rows: auto minmax(0, 1fr);
        }
        .st-chatu8-workflow-search {
            margin: 10px;
            height: 34px;
            border: 1px solid rgba(220, 232, 238, 0.2);
            border-radius: 6px;
            background: #171c20;
            color: #f2f5f7;
            padding: 0 10px;
        }
        .st-chatu8-workflow-nodes {
            min-height: 0;
            overflow: auto;
            padding: 0 8px 10px;
        }
        .st-chatu8-workflow-node {
            display: grid;
            gap: 3px;
            width: 100%;
            margin-bottom: 6px;
            padding: 8px;
            text-align: left;
            background: #1a2025;
        }
        .st-chatu8-workflow-node[aria-selected="true"] {
            outline: 2px solid #14b8a6;
            background: #19302f;
        }
        .st-chatu8-workflow-node strong {
            font-size: 13px;
            line-height: 1.25;
        }
        .st-chatu8-workflow-node span {
            color: #a8b4bc;
            font-size: 12px;
            overflow-wrap: anywhere;
        }
        .st-chatu8-workflow-detail {
            min-width: 0;
            min-height: 0;
            overflow: auto;
            padding: 14px;
            display: grid;
            align-content: start;
            gap: 12px;
        }
        .st-chatu8-workflow-node-header,
        .st-chatu8-workflow-input-row,
        .st-chatu8-workflow-raw {
            border: 1px solid rgba(220, 232, 238, 0.14);
            border-radius: 8px;
            background: #1a2025;
            padding: 12px;
        }
        .st-chatu8-workflow-node-header {
            display: grid;
            gap: 10px;
        }
        .st-chatu8-workflow-grid {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 10px;
        }
        .st-chatu8-workflow-field {
            display: grid;
            gap: 5px;
            min-width: 0;
        }
        .st-chatu8-workflow-field label {
            color: #a8b4bc;
            font-size: 12px;
        }
        .st-chatu8-workflow-field input,
        .st-chatu8-workflow-field textarea,
        .st-chatu8-workflow-field select,
        .st-chatu8-workflow-raw textarea {
            width: 100%;
            min-width: 0;
            border: 1px solid rgba(220, 232, 238, 0.2);
            border-radius: 6px;
            background: #101316;
            color: #f2f5f7;
            padding: 8px;
        }
        .st-chatu8-workflow-field textarea,
        .st-chatu8-workflow-raw textarea {
            resize: vertical;
            min-height: 88px;
            font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
            font-size: 12px;
        }
        .st-chatu8-workflow-combo {
            display: grid;
            grid-template-columns: minmax(0, 1fr) minmax(150px, 230px);
            gap: 6px;
            align-items: stretch;
        }
        .st-chatu8-workflow-combo input,
        .st-chatu8-workflow-combo select {
            min-height: 36px;
        }
        .st-chatu8-workflow-combo textarea {
            min-height: 160px;
        }
        .st-chatu8-workflow-combo-textarea select {
            align-self: start;
        }
        .st-chatu8-workflow-editor button[data-loading="true"] {
            opacity: 0.68;
            cursor: wait;
        }
        .st-chatu8-workflow-inputs {
            display: grid;
            gap: 8px;
        }
        .st-chatu8-workflow-input-row {
            display: grid;
            gap: 8px;
        }
        .st-chatu8-workflow-input-title {
            display: flex;
            gap: 8px;
            align-items: center;
            justify-content: space-between;
            color: #dce8ee;
            font-weight: 700;
            overflow-wrap: anywhere;
        }
        .st-chatu8-workflow-chip {
            color: #a8b4bc;
            font-size: 12px;
            overflow-wrap: anywhere;
        }
        .st-chatu8-workflow-raw summary {
            cursor: pointer;
            color: #dce8ee;
            font-weight: 700;
        }
        @media (max-width: 760px) {
            .st-chatu8-workflow-modal {
                padding: 0;
            }
            .st-chatu8-workflow-editor {
                width: 100vw;
                height: 100vh;
                border-radius: 0;
            }
            .st-chatu8-workflow-toolbar {
                flex-wrap: wrap;
            }
            .st-chatu8-workflow-body {
                grid-template-columns: 1fr;
                grid-template-rows: minmax(150px, 32vh) minmax(0, 1fr);
            }
            .st-chatu8-workflow-list {
                border-right: 0;
                border-bottom: 1px solid rgba(220, 232, 238, 0.14);
            }
            .st-chatu8-workflow-grid {
                grid-template-columns: 1fr;
            }
            .st-chatu8-workflow-combo {
                grid-template-columns: 1fr;
            }
            .st-chatu8-workflow-editor button {
                flex: 1 1 auto;
            }
        }
    `;
    document.head.appendChild(style);
}

function removeEditor() {
    document.getElementById('st_chatu8_workflow_modal')?.remove();
    editorState = null;
}

function renderNodeList() {
    const list = document.getElementById('st_chatu8_workflow_nodes');
    if (!list || !editorState) {
        return;
    }

    const query = trimString(document.getElementById('st_chatu8_workflow_search')?.value).toLowerCase();
    const ids = sortedNodeIds(editorState.workflow).filter((id) => {
        const node = editorState.workflow[id];
        const text = `${id} ${nodeTitle(id, node)} ${node?.class_type || ''}`.toLowerCase();
        return !query || text.includes(query);
    });

    list.innerHTML = ids.map((id) => {
        const node = editorState.workflow[id];
        const count = Object.keys(node?.inputs || {}).length;
        return `
            <button type="button" class="st-chatu8-workflow-node" data-node-id="${escapeHtml(id)}" aria-selected="${id === editorState.selectedId ? 'true' : 'false'}">
                <strong>#${escapeHtml(id)} ${escapeHtml(nodeTitle(id, node))}</strong>
                <span>${escapeHtml(node?.class_type || 'Unknown')} · ${count} 个输入</span>
            </button>
        `;
    }).join('');
}

function uniqueStrings(values) {
    const seen = new Set();
    const result = [];
    for (const value of values || []) {
        const text = trimString(value);
        if (!text || seen.has(text)) {
            continue;
        }
        seen.add(text);
        result.push(text);
    }
    return result;
}

function isRuntimeVariableChoice(choice) {
    return /^%[^%\s]+%$/.test(trimString(choice));
}

function isImageFileName(value) {
    return IMAGE_FILE_PATTERN.test(asString(value).split(/[?#]/)[0]);
}

function isModelFileName(value) {
    return MODEL_FILE_PATTERN.test(asString(value).split(/[?#]/)[0]);
}

function inputLooksLikeImage(inputName) {
    return /image|img|ref|reference|mask|参考/i.test(inputName);
}

function inputLooksLikeModel(inputName) {
    return /model|ckpt|checkpoint|vae|lora|clip|unet|adapter|ipadapter|controlnet|upscale|file/i.test(inputName);
}

function nodeClassType(node) {
    return trimString(node?.class_type || node?.type);
}

function isReferenceImageInput(node, inputName) {
    const classType = nodeClassType(node);
    const lowerInput = trimString(inputName).toLowerCase();
    if (/^image$/.test(lowerInput) && /loadimage|load image/i.test(classType)) {
        return true;
    }
    return /reference|ref_image|refimage|cankaotu|comfyuicankaotupian|参考/.test(lowerInput);
}

function runtimeVariableCandidates(node, inputName) {
    const lowerInput = trimString(inputName).toLowerCase();
    if (isReferenceImageInput(node, inputName)) {
        return RUNTIME_REFERENCE_IMAGE_VARIABLES;
    }
    if (/negative|uncond|uc/.test(lowerInput)) {
        return RUNTIME_NEGATIVE_VARIABLES;
    }
    if (lowerInput === 'text' || /prompt|positive/.test(lowerInput)) {
        return RUNTIME_PROMPT_VARIABLES;
    }
    return [];
}

function collectStrings(value, predicate, limit = STRING_CHOICE_LIMIT, depth = 0, seen = new WeakSet(), key = '') {
    const results = [];
    if (results.length >= limit || depth > 7 || value == null) {
        return results;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        const text = trimString(value);
        if (text && text.length <= 400 && predicate(key, text)) {
            results.push(text);
        }
        return results;
    }
    if (typeof value !== 'object') {
        return results;
    }
    if (seen.has(value)) {
        return results;
    }
    seen.add(value);

    const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value);
    for (const [childKey, childValue] of entries) {
        if (results.length >= limit) {
            break;
        }
        results.push(...collectStrings(childValue, predicate, limit - results.length, depth + 1, seen, childKey));
    }
    return results;
}

function workflowChoiceCandidates(node, inputName, currentValue) {
    if (!editorState?.workflow) {
        return [];
    }
    const values = [currentValue];
    const lowerInput = trimString(inputName).toLowerCase();
    const wantsImage = inputLooksLikeImage(lowerInput);
    const wantsModel = inputLooksLikeModel(lowerInput);

    for (const candidateNode of Object.values(editorState.workflow || {})) {
        const inputs = candidateNode?.inputs || {};
        for (const [candidateName, candidateValue] of Object.entries(inputs)) {
            if (!['string', 'number', 'boolean'].includes(typeof candidateValue)) {
                continue;
            }
            const lowerCandidate = candidateName.toLowerCase();
            if (lowerCandidate === lowerInput) {
                values.push(candidateValue);
                continue;
            }
            if (wantsImage && isImageFileName(candidateValue)) {
                values.push(candidateValue);
            } else if (wantsModel && isModelFileName(candidateValue)) {
                values.push(candidateValue);
            }
        }
    }
    return values;
}

function settingsChoiceCandidates(inputName) {
    const lowerInput = trimString(inputName).toLowerCase();
    const wantsImage = inputLooksLikeImage(lowerInput);
    const wantsModel = inputLooksLikeModel(lowerInput);

    return collectStrings(settings(), (key, value) => {
        const lowerKey = trimString(key).toLowerCase();
        if (wantsImage && (isImageFileName(value) || /image|img|ref|reference|path|file|avatar|角色|参考/.test(lowerKey))) {
            return true;
        }
        if (wantsModel && (isModelFileName(value) || /model|ckpt|checkpoint|vae|lora|clip|unet|adapter|ipadapter|controlnet|upscale|file/.test(lowerKey))) {
            return true;
        }
        return false;
    });
}

function choicesFromComfySpec(spec) {
    const values = [];
    const append = (items) => {
        if (!Array.isArray(items)) {
            return;
        }
        for (const item of items) {
            if (['string', 'number', 'boolean'].includes(typeof item)) {
                values.push(item);
            }
        }
    };

    if (Array.isArray(spec)) {
        for (const item of spec) {
            if (Array.isArray(item)) {
                append(item);
            } else if (isPlainObject(item)) {
                append(item.options || item.values || item.choices);
            }
        }
    } else if (isPlainObject(spec)) {
        append(spec.options || spec.values || spec.choices);
    }
    return uniqueStrings(values);
}

function comfyChoiceCandidates(node, inputName) {
    if (isReferenceImageInput(node, inputName)) {
        return [];
    }
    const classType = nodeClassType(node);
    if (!classType || !comfyObjectInfoCache?.[classType]) {
        return [];
    }
    const inputInfo = comfyObjectInfoCache[classType]?.input || {};
    const values = [];
    for (const group of ['required', 'optional', 'hidden']) {
        values.push(...choicesFromComfySpec(inputInfo[group]?.[inputName]));
    }
    return values;
}

function inputChoiceCandidates(node, inputName, currentValue) {
    const lowerInput = trimString(inputName).toLowerCase();
    const current = trimString(currentValue);
    const runtimeChoices = runtimeVariableCandidates(node, inputName);
    const comfyChoices = comfyChoiceCandidates(node, inputName);
    const workflowChoices = workflowChoiceCandidates(node, inputName, currentValue);
    const settingsChoices = settingsChoiceCandidates(inputName);
    const staticChoices = STATIC_INPUT_CHOICES[lowerInput] || [];
    const includeCurrent = current && (
        isRuntimeVariableChoice(current) ||
        comfyChoices.includes(current) ||
        workflowChoices.includes(current) ||
        settingsChoices.includes(current) ||
        staticChoices.includes(current) ||
        runtimeChoices.includes(current)
    );
    return uniqueStrings([
        ...runtimeChoices,
        ...comfyChoices,
        ...workflowChoices,
        ...settingsChoices,
        ...staticChoices,
        ...(includeCurrent ? [current] : []),
    ]);
}

function shouldRenderChoiceInput(inputName, value, choices) {
    const text = asString(value);
    const lowerInput = trimString(inputName).toLowerCase();
    if (!choices.length || text.includes('\n') || text.length > 120) {
        return false;
    }
    const hasRuntimeVariable = choices.some(isRuntimeVariableChoice);
    if ((lowerInput === 'text' || /prompt|positive|negative/.test(lowerInput)) && !hasRuntimeVariable) {
        return false;
    }
    return true;
}

function shouldRenderChoiceTextarea(inputName, choices) {
    const lowerInput = trimString(inputName).toLowerCase();
    const hasRuntimeVariable = choices.some(isRuntimeVariableChoice);
    return choices.length > 0 && hasRuntimeVariable && (lowerInput === 'text' || /prompt|positive|negative/.test(lowerInput));
}

function choiceInputHtml(name, value, choices) {
    const dataName = escapeHtml(encodeURIComponent(name));
    const current = asString(value);
    const options = choices.map((choice) => `
        <option value="${escapeHtml(choice)}"${choice === current ? ' selected' : ''}>${escapeHtml(choice)}</option>
    `).join('');

    return `
        <div class="st-chatu8-workflow-combo">
            <input type="text" data-input-name="${dataName}" data-input-kind="string" data-combo-text="true" value="${escapeHtml(current)}">
            <select data-input-name="${dataName}" data-input-kind="string" data-combo-select="true" title="从已有值中选择">
                <option value="">选择已有值</option>
                ${options}
            </select>
        </div>
    `;
}

function choiceTextareaHtml(name, value, choices) {
    const dataName = escapeHtml(encodeURIComponent(name));
    const current = asString(value);
    const options = choices.map((choice) => `
        <option value="${escapeHtml(choice)}"${choice === current ? ' selected' : ''}>${escapeHtml(choice)}</option>
    `).join('');

    return `
        <div class="st-chatu8-workflow-combo st-chatu8-workflow-combo-textarea">
            <textarea data-input-name="${dataName}" data-input-kind="string" data-combo-text="true">${escapeHtml(current)}</textarea>
            <select data-input-name="${dataName}" data-input-kind="string" data-combo-select="true" title="插入变量">
                <option value="">插入变量</option>
                ${options}
            </select>
        </div>
    `;
}

function inputEditorHtml(name, value, node) {
    const dataName = escapeHtml(encodeURIComponent(name));
    if (typeof value === 'boolean') {
        return `
            <select data-input-name="${dataName}" data-input-kind="boolean">
                <option value="true"${value ? ' selected' : ''}>true</option>
                <option value="false"${!value ? ' selected' : ''}>false</option>
            </select>
        `;
    }
    if (typeof value === 'number') {
        return `<input type="number" step="any" data-input-name="${dataName}" data-input-kind="number" value="${escapeHtml(value)}">`;
    }
    if (typeof value === 'string') {
        const choices = inputChoiceCandidates(node, name, value);
        if (value.length > 80 || value.includes('\n')) {
            if (shouldRenderChoiceTextarea(name, choices)) {
                return choiceTextareaHtml(name, value, choices);
            }
            return `<textarea data-input-name="${dataName}" data-input-kind="string">${escapeHtml(value)}</textarea>`;
        }
        if (shouldRenderChoiceInput(name, value, choices)) {
            return choiceInputHtml(name, value, choices);
        }
        return `<input type="text" data-input-name="${dataName}" data-input-kind="string" value="${escapeHtml(value)}">`;
    }
    return `<textarea data-input-name="${dataName}" data-input-kind="json">${escapeHtml(JSON.stringify(value, null, 2))}</textarea>`;
}

function renderDetail() {
    const detail = document.getElementById('st_chatu8_workflow_detail');
    if (!detail || !editorState) {
        return;
    }

    const workflow = editorState.workflow;
    const ids = sortedNodeIds(workflow);
    if (!ids.length) {
        detail.innerHTML = '<div class="st-chatu8-workflow-node-header">当前工作流没有节点。</div>';
        return;
    }
    if (!workflow[editorState.selectedId]) {
        editorState.selectedId = ids[0];
    }

    const id = editorState.selectedId;
    const node = workflow[id];
    const inputs = node.inputs || {};
    const inputRows = Object.entries(inputs).map(([name, value]) => `
        <div class="st-chatu8-workflow-input-row">
            <div class="st-chatu8-workflow-input-title">
                <span>${escapeHtml(name)}</span>
                <button type="button" data-delete-input="${escapeHtml(encodeURIComponent(name))}" title="删除输入">删除</button>
            </div>
            <div class="st-chatu8-workflow-chip">${escapeHtml(inputSummary(value))}</div>
            <div class="st-chatu8-workflow-field">
                ${inputEditorHtml(name, value, node)}
            </div>
        </div>
    `).join('');

    detail.innerHTML = `
        <div class="st-chatu8-workflow-node-header">
            <div class="st-chatu8-workflow-grid">
                <div class="st-chatu8-workflow-field">
                    <label>节点 ID</label>
                    <input type="text" value="${escapeHtml(id)}" readonly>
                </div>
                <div class="st-chatu8-workflow-field">
                    <label>节点类型 class_type</label>
                    <input type="text" id="st_chatu8_workflow_class_type" value="${escapeHtml(node.class_type || '')}">
                </div>
                <div class="st-chatu8-workflow-field">
                    <label>显示名称</label>
                    <input type="text" id="st_chatu8_workflow_node_title" value="${escapeHtml(nodeTitle(id, node))}">
                </div>
                <div class="st-chatu8-workflow-field">
                    <label>输入数量</label>
                    <input type="text" value="${Object.keys(inputs).length}" readonly>
                </div>
            </div>
            <div>
                <button type="button" id="st_chatu8_workflow_add_input">添加输入</button>
                <button type="button" data-kind="danger" id="st_chatu8_workflow_delete_node">删除节点</button>
            </div>
        </div>
        <div class="st-chatu8-workflow-inputs">
            ${inputRows || '<div class="st-chatu8-workflow-input-row">这个节点没有可编辑输入。</div>'}
        </div>
        <details class="st-chatu8-workflow-raw">
            <summary>完整 JSON</summary>
            <div style="display:grid; gap:8px; margin-top:10px;">
                <textarea id="st_chatu8_workflow_raw_json">${escapeHtml(JSON.stringify(workflow, null, 2))}</textarea>
                <button type="button" id="st_chatu8_workflow_apply_raw">从 JSON 应用</button>
            </div>
        </details>
    `;
}

function rerender() {
    renderNodeList();
    renderDetail();
}

function updateRawJson() {
    const raw = document.getElementById('st_chatu8_workflow_raw_json');
    if (raw && editorState) {
        raw.value = JSON.stringify(editorState.workflow, null, 2);
    }
}

function saveEditorWorkflow(makeCopy = false) {
    if (!editorState) {
        return;
    }
    let name = trimString(document.getElementById('st_chatu8_workflow_preset_name')?.value || editorState.name);
    if (makeCopy) {
        name = trimString(window.prompt('另存为工作流预设名称', uniquePresetName(name))) || '';
    }
    if (!name) {
        notify('请输入工作流预设名称。', 'warning');
        return;
    }

    const content = JSON.stringify(editorState.workflow, null, 2);
    activateWorkflow(editorState.target, name, content);
    editorState.name = name;
    const input = document.getElementById('st_chatu8_workflow_preset_name');
    if (input) {
        input.value = name;
    }
    notify(makeCopy ? `已另存为 "${name}"` : `已保存工作流 "${name}"`);
}

function buildEditor(target, workflow, name) {
    injectStyles();
    removeEditor();

    const ids = sortedNodeIds(workflow);
    editorState = {
        target,
        workflow,
        name,
        selectedId: ids[0] || '',
    };

    const modal = document.createElement('div');
    modal.id = 'st_chatu8_workflow_modal';
    modal.className = 'st-chatu8-workflow-modal';
    modal.innerHTML = `
        <div class="st-chatu8-workflow-editor" role="dialog" aria-modal="true" aria-label="${escapeHtml(target.title)}可视化编辑器">
            <div class="st-chatu8-workflow-toolbar">
                <div class="st-chatu8-workflow-title">${escapeHtml(target.title)}可视化</div>
                <input type="text" id="st_chatu8_workflow_preset_name" value="${escapeHtml(name)}" aria-label="工作流预设名称">
                <button type="button" id="st_chatu8_workflow_import_json">导入 JSON</button>
                <button type="button" data-kind="primary" id="st_chatu8_workflow_save">保存当前</button>
                <button type="button" id="st_chatu8_workflow_save_as">另存为</button>
                <button type="button" id="st_chatu8_workflow_format">格式化</button>
                <button type="button" id="st_chatu8_workflow_close">关闭</button>
                <button type="button" id="st_chatu8_workflow_refresh_choices">刷新选项</button>
                <input type="file" id="st_chatu8_workflow_editor_file" accept=".json,application/json" style="display:none;">
            </div>
            <div class="st-chatu8-workflow-body">
                <div class="st-chatu8-workflow-list">
                    <input class="st-chatu8-workflow-search" id="st_chatu8_workflow_search" type="search" placeholder="搜索节点、类型、ID">
                    <div class="st-chatu8-workflow-nodes" id="st_chatu8_workflow_nodes"></div>
                </div>
                <div class="st-chatu8-workflow-detail" id="st_chatu8_workflow_detail"></div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    rerender();
    refreshComfyObjectInfo(false, true);
}

function openEditor(target = MAIN_TARGET) {
    try {
        const text = getCurrentWorkflowText(target);
        if (!text) {
            notify('当前没有可编辑的工作流。请先导入一个工作流。', 'warning');
            return;
        }
        const workflow = unwrapWorkflow(text);
        buildEditor(target, workflow, getCurrentPresetName(target));
    } catch (error) {
        console.error('[st-chatu8] workflow editor open failed:', error);
        notify(`打开可视化编辑失败：${error.message || error}`, 'error');
    }
}

async function importIntoEditor(file) {
    if (!file || !editorState) {
        return;
    }
    const json = JSON.parse(await file.text());
    const imports = normalizeWorkflowImports(json, defaultPresetName(file));
    if (!imports.length) {
        throw new Error('文件里没有可导入的 ComfyUI 工作流。');
    }
    const chosen = imports[0];
    editorState.workflow = unwrapWorkflow(chosen.content);
    editorState.name = uniquePresetName(chosen.name);
    editorState.selectedId = sortedNodeIds(editorState.workflow)[0] || '';
    const nameInput = document.getElementById('st_chatu8_workflow_preset_name');
    if (nameInput) {
        nameInput.value = editorState.name;
    }
    rerender();
}

function handleEditorClick(event) {
    if (!editorState) {
        return;
    }

    const button = event.target?.closest?.('button');
    if (!button) {
        return;
    }

    const nodeButton = button.closest('.st-chatu8-workflow-node');
    if (nodeButton?.dataset?.nodeId) {
        editorState.selectedId = nodeButton.dataset.nodeId;
        rerender();
        return;
    }

    if (button.id === 'st_chatu8_workflow_close') {
        removeEditor();
        return;
    }
    if (button.id === 'st_chatu8_workflow_save') {
        saveEditorWorkflow(false);
        return;
    }
    if (button.id === 'st_chatu8_workflow_save_as') {
        saveEditorWorkflow(true);
        return;
    }
    if (button.id === 'st_chatu8_workflow_format') {
        updateRawJson();
        notify('已刷新完整 JSON。');
        return;
    }
    if (button.id === 'st_chatu8_workflow_import_json') {
        document.getElementById('st_chatu8_workflow_editor_file')?.click();
        return;
    }
    if (button.id === 'st_chatu8_workflow_refresh_choices') {
        refreshComfyObjectInfo(true, false);
        return;
    }
    if (button.id === 'st_chatu8_workflow_add_input') {
        const name = trimString(window.prompt('输入字段名称'));
        if (!name) {
            return;
        }
        const node = editorState.workflow[editorState.selectedId];
        node.inputs = node.inputs || {};
        if (!Object.prototype.hasOwnProperty.call(node.inputs, name)) {
            node.inputs[name] = '';
        }
        rerender();
        return;
    }
    if (button.id === 'st_chatu8_workflow_delete_node') {
        const id = editorState.selectedId;
        if (!window.confirm(`删除节点 #${id}？`)) {
            return;
        }
        delete editorState.workflow[id];
        editorState.selectedId = sortedNodeIds(editorState.workflow)[0] || '';
        rerender();
        return;
    }
    if (button.id === 'st_chatu8_workflow_apply_raw') {
        try {
            editorState.workflow = unwrapWorkflow(document.getElementById('st_chatu8_workflow_raw_json')?.value || '{}');
            editorState.selectedId = sortedNodeIds(editorState.workflow)[0] || '';
            rerender();
        } catch (error) {
            notify(`JSON 应用失败：${error.message || error}`, 'error');
        }
        return;
    }
    if (button.dataset?.deleteInput) {
        const name = decodeURIComponent(button.dataset.deleteInput);
        const node = editorState.workflow[editorState.selectedId];
        if (node?.inputs) {
            delete node.inputs[name];
            rerender();
        }
    }
}

function handleEditorInput(event) {
    if (!editorState) {
        return;
    }

    if (event.target?.id === 'st_chatu8_workflow_search') {
        renderNodeList();
        return;
    }

    const node = editorState.workflow[editorState.selectedId];
    if (!node) {
        return;
    }

    if (event.target?.id === 'st_chatu8_workflow_class_type') {
        node.class_type = event.target.value;
        renderNodeList();
        updateRawJson();
        return;
    }
    if (event.target?.id === 'st_chatu8_workflow_node_title') {
        node._meta = node._meta || {};
        node._meta.title = event.target.value;
        renderNodeList();
        updateRawJson();
        return;
    }

    const inputName = event.target?.dataset?.inputName;
    if (!inputName) {
        return;
    }

    const name = decodeURIComponent(inputName);
    node.inputs = node.inputs || {};
    const combo = event.target.closest?.('.st-chatu8-workflow-combo');
    if (event.target.dataset.comboSelect === 'true') {
        const textInput = combo?.querySelector?.('[data-combo-text="true"]');
        if (combo?.classList?.contains('st-chatu8-workflow-combo-textarea')) {
            const selectedValue = event.target.value;
            if (textInput && selectedValue) {
                const start = Number.isInteger(textInput.selectionStart) ? textInput.selectionStart : textInput.value.length;
                const end = Number.isInteger(textInput.selectionEnd) ? textInput.selectionEnd : start;
                textInput.value = `${textInput.value.slice(0, start)}${selectedValue}${textInput.value.slice(end)}`;
                const cursor = start + selectedValue.length;
                textInput.focus();
                textInput.setSelectionRange?.(cursor, cursor);
                event.target.value = '';
                node.inputs[name] = textInput.value;
                updateRawJson();
            }
            return;
        }
        if (textInput && textInput.value !== event.target.value) {
            textInput.value = event.target.value;
        }
    } else if (event.target.dataset.comboText === 'true') {
        const select = combo?.querySelector?.('[data-combo-select="true"]');
        if (select) {
            const hasOption = Array.from(select.options || []).some(option => option.value === event.target.value);
            select.value = hasOption ? event.target.value : '';
        }
    }
    try {
        if (event.target.dataset.inputKind === 'number') {
            node.inputs[name] = Number(event.target.value);
        } else if (event.target.dataset.inputKind === 'boolean') {
            node.inputs[name] = event.target.value === 'true';
        } else if (event.target.dataset.inputKind === 'json') {
            node.inputs[name] = JSON.parse(event.target.value);
        } else {
            node.inputs[name] = event.target.value;
        }
        updateRawJson();
    } catch {
        // Leave invalid JSON in the field until the user fixes it.
    }
}

function bindEvents() {
    if (document.documentElement.dataset.stChatu8WorkflowVisualEditor === VERSION) {
        return;
    }
    document.documentElement.dataset.stChatu8WorkflowVisualEditor = VERSION;

    document.addEventListener('focusin', (event) => {
        rememberComfyVariableTextTarget(event.target);
    }, true);

    document.addEventListener('click', (event) => {
        const codeButton = event.target?.closest?.('button');
        if (codeButton && trimString(codeButton.textContent) === '</>') {
            scheduleComfyPlaceholderMenuAugment();
            return;
        }
        scheduleComfyPlaceholderMenuAugment();
    }, true);

    document.addEventListener('click', (event) => {
        const button = event.target?.closest?.('#worker_import, #edit_worker_import');
        if (!button || button.disabled) {
            return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        openImportPicker(TARGETS[button.id]);
    }, true);

    document.addEventListener('change', (event) => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement)) {
            return;
        }

        if (input.id === 'st_chatu8_workflow_editor_file') {
            const file = input.files?.[0];
            input.value = '';
            importIntoEditor(file).catch((error) => {
                console.error('[st-chatu8] workflow editor import failed:', error);
                notify(`导入失败：${error.message || error}`, 'error');
            });
            return;
        }

        const target = Object.values(TARGETS).find(item => item.inputId === input.id);
        if (!target) {
            return;
        }

        event.stopImmediatePropagation();
        const file = input.files?.[0];
        handleImportFile(file, target)
            .catch((error) => {
                console.error('[st-chatu8] workflow import failed:', error);
                notify(`导入失败：${error.message || error}`, 'error');
            })
            .finally(() => {
                input.value = '';
            });
    }, true);

    document.addEventListener('click', (event) => {
        const visualButton = event.target?.closest?.('#visualize_workflow, #st_chatu8_simple_workflow_visualize, #visualize_edit_workflow');
        if (!visualButton || visualButton.disabled) {
            return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        openEditor(visualButton.id === 'visualize_edit_workflow' ? EDIT_TARGET : MAIN_TARGET);
    }, true);

    document.addEventListener('click', (event) => {
        if (!event.target?.closest?.('#st_chatu8_workflow_modal')) {
            return;
        }
        handleEditorClick(event);
    });

    document.addEventListener('input', handleEditorInput);
    document.addEventListener('change', handleEditorInput);

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && editorState) {
            removeEditor();
        }
    });
}

window.stChatu8NormalizeWorkflowImport = workflowContent;
window.stChatu8NormalizeWorkflowImports = normalizeWorkflowImports;
window.stChatu8OpenWorkflowVisualEditor = () => openEditor(MAIN_TARGET);

bindEvents();
