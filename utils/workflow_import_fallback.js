import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { extensionName } from './config.js';

const TARGETS = {
    worker_import: {
        inputId: 'worker_import_file',
        selectId: 'workerid',
        textareaId: 'worker',
        activeKey: 'workerid',
        valueKey: 'worker',
    },
    edit_worker_import: {
        inputId: 'edit_worker_import_file',
        selectId: 'editWorkerid',
        textareaId: 'editWorker',
        activeKey: 'editWorkerid',
        valueKey: 'editWorker',
    },
};

const ALL_WORKFLOW_SELECTS = ['workerid', 'editWorkerid'];

function getSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = {};
    }
    const settings = extension_settings[extensionName];
    if (!settings.workers) {
        settings.workers = {};
    }
    return settings;
}

function notify(message, type = 'success') {
    const notifier = window.toastr && window.toastr[type];
    if (typeof notifier === 'function') {
        notifier.call(window.toastr, message);
        return;
    }
    alert(message);
}

function getDefaultName(file) {
    const fileName = file && file.name ? file.name : 'imported_workflow';
    return fileName.replace(/\.json$/i, '').trim() || 'imported_workflow';
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

function workflowContent(value) {
    if (typeof value === 'string') {
        return value;
    }
    if (isApiWorkflow(value)) {
        return JSON.stringify(value, null, 2);
    }
    if (isPlainObject(value)) {
        if (isApiWorkflow(value.prompt)) {
            return JSON.stringify(value.prompt, null, 2);
        }
        if (isApiWorkflow(value.workflow)) {
            return JSON.stringify(value.workflow, null, 2);
        }
        if (isApiWorkflow(value.data)) {
            return JSON.stringify(value.data, null, 2);
        }
        if (typeof value.prompt === 'string') {
            return value.prompt;
        }
        if (typeof value.workflow === 'string') {
            return value.workflow;
        }
        if (typeof value.data === 'string') {
            return value.data;
        }
    }
    return null;
}

function normalizeWorkflowImports(json, defaultName) {
    const directContent = workflowContent(json);
    if (directContent) {
        const namedDirect = isPlainObject(json) && typeof json.name === 'string' && json.name.trim();
        return [{ name: namedDirect || defaultName, content: directContent }];
    }

    if (isUiWorkflow(json) || (json && isUiWorkflow(json.workflow))) {
        throw new Error('这是 ComfyUI 界面完整工作流，请在 ComfyUI 里导出 API 格式 JSON 后再导入。');
    }

    if (!isPlainObject(json)) {
        return [];
    }

    const imports = [];
    for (const [name, value] of Object.entries(json)) {
        const content = workflowContent(value);
        if (!content) {
            continue;
        }
        imports.push({ name: name.trim() || defaultName, content });
    }
    return imports;
}

function ensureOption(selectId, name) {
    const select = document.getElementById(selectId);
    if (!select) {
        return null;
    }
    const exists = Array.from(select.options).some(option => option.value === name);
    if (!exists) {
        const option = new Option(name, name);
        option.title = name;
        select.add(option);
    }
    return select;
}

function activateWorkflow(target, name, content) {
    const settings = getSettings();
    settings.workers[name] = content;
    settings[target.activeKey] = name;
    settings[target.valueKey] = content;

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
    }

    saveSettingsDebounced();
}

async function handleImportFile(file, target) {
    if (!file) {
        return;
    }

    const text = await file.text();
    const json = JSON.parse(text);
    const defaultName = getDefaultName(file);
    const imports = normalizeWorkflowImports(json, defaultName);

    if (!imports.length) {
        throw new Error('没有在文件里找到可用的 ComfyUI API 工作流。');
    }

    if (imports.length === 1) {
        const chosenName = window.prompt('请输入工作流预设名称', imports[0].name);
        if (!chosenName || !chosenName.trim()) {
            return;
        }
        imports[0].name = chosenName.trim();
    }

    const settings = getSettings();
    for (const item of imports) {
        settings.workers[item.name] = item.content;
        for (const selectId of ALL_WORKFLOW_SELECTS) {
            ensureOption(selectId, item.name);
        }
    }

    const active = imports[imports.length - 1];
    activateWorkflow(target, active.name, active.content);

    if (imports.length === 1) {
        notify(`已导入工作流 "${active.name}"`);
    } else {
        notify(`已导入 ${imports.length} 个工作流，当前切换到 "${active.name}"`);
    }
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

function openPicker(buttonId) {
    const target = TARGETS[buttonId];
    if (!target) {
        return;
    }
    const input = getOrCreateInput(target);
    input.value = '';
    input.click();
}

document.addEventListener('click', event => {
    const eventTarget = event.target;
    const button = eventTarget && typeof eventTarget.closest === 'function'
        ? eventTarget.closest('#worker_import, #edit_worker_import')
        : null;
    if (!button || button.disabled) {
        return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    openPicker(button.id);
}, true);

document.addEventListener('change', event => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) {
        return;
    }

    const target = Object.values(TARGETS).find(item => item.inputId === input.id);
    if (!target) {
        return;
    }

    const file = input.files && input.files[0];
    handleImportFile(file, target)
        .catch(error => {
            console.error('[st-chatu8] workflow import failed:', error);
            notify(`导入失败：${error.message || error}`, 'error');
        })
        .finally(() => {
            input.value = '';
        });
});
