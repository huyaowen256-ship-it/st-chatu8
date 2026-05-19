import { saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { extensionName } from './config.js';

const SIMPLE_VERSION = '20260518_character_reference_workflow_v1';
const SIMPLE_PRESET_NAME = 'Flux2 Klein 一致性 LoRA';
const ONEOBSESSION_PRESET_NAME = 'oneObsession IPAdapter 低权重中文模板';
const DEFAULT_PRESET_NAME = ONEOBSESSION_PRESET_NAME;
const WORKFLOW_ADAPTER = 'flux2-klein-reference';
const CHARACTER_REFERENCE_WORKFLOW_NAME = '角色首参考图生成工作流';
const BUNDLED_WORKFLOW_PRESETS = [
    {
        name: SIMPLE_PRESET_NAME,
        url: `scripts/extensions/third-party/${extensionName}/workflows/flux2_klein_reference.json`,
    },
    {
        name: ONEOBSESSION_PRESET_NAME,
        url: `scripts/extensions/third-party/${extensionName}/workflows/oneobsession_ipadapter_low_weight_cn.json`,
    },
];

const workflowTextPromises = new Map();
let refreshTimer = null;
let editWorkflowVisualBridgeTimer = null;

const WORKFLOW_CONTROL_IDS = [
    'workerid',
    'worker',
    'worker_update_style',
    'worker_save_style',
    'worker_export_current',
    'worker_export_all',
    'worker_import',
    'worker_delete_style',
    'eidtwork',
    'visualize_workflow',
    'visualize_edit_workflow',
    'editWorkerid',
    'editWorker',
    'edit_worker_update_style',
    'edit_worker_save_style',
    'edit_worker_export_current',
    'edit_worker_export_all',
    'edit_worker_import',
    'edit_worker_delete_style',
];

const WORKFLOW_LABEL_FORS = [
    'workerid',
    'worker',
    'editWorkerid',
    'editWorker',
];

function asString(value) {
    return value == null ? '' : String(value).trim();
}

function escapeHtml(value) {
    return asString(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function settings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = {};
    }
    return extension_settings[extensionName];
}

function assign(target, key, value) {
    if (!target || target[key] === value) {
        return false;
    }
    target[key] = value;
    return true;
}

function normalizeComfyUrl(value) {
    return asString(value).replace(/\/+$/, '');
}

function currentComfyUrl() {
    const data = settings();
    const input = typeof document !== 'undefined' ? document.getElementById('comfyuiUrl') : null;
    return normalizeComfyUrl(input?.value || data.comfyuiUrl || data.comfyui_url || '');
}

function fileNameFromPath(value) {
    return asString(value).split(/[\\/]/).filter(Boolean).pop() || '';
}

function getSimpleReferencePath() {
    const data = settings();
    return asString(
        data.comfySimpleReferenceImage ||
        data.comfyManualReferenceImagePath ||
        data.comfyUploadedReferenceImage ||
        data.comfyRefImagePath
    );
}

function bundledPreset(name = DEFAULT_PRESET_NAME) {
    return BUNDLED_WORKFLOW_PRESETS.find((preset) => preset.name === name) || BUNDLED_WORKFLOW_PRESETS[0];
}

function loadBundledWorkflowText(name = DEFAULT_PRESET_NAME) {
    const preset = bundledPreset(name);
    if (!workflowTextPromises.has(preset.name)) {
        workflowTextPromises.set(preset.name, fetch(preset.url)
            .then((response) => {
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                return response.text();
            })
            .then((workflowText) => {
                JSON.parse(workflowText);
                return workflowText;
            }));
    }
    return workflowTextPromises.get(preset.name);
}

function normalizeWorkflowText(workflowText) {
    if (typeof window !== 'undefined' && typeof window.stChatu8NormalizeWorkflowImport === 'function') {
        return window.stChatu8NormalizeWorkflowImport(workflowText);
    }
    const workflow = JSON.parse(asString(workflowText));
    if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
        throw new Error('Workflow JSON must be an object.');
    }
    return JSON.stringify(workflow, null, 2);
}

function workers() {
    const data = settings();
    if (!data.workers || typeof data.workers !== 'object' || Array.isArray(data.workers)) {
        data.workers = {};
    }
    return data.workers;
}

function presetBaseName(fileName) {
    const base = fileNameFromPath(fileName).replace(/\.json$/i, '').trim();
    return base || 'Imported Workflow';
}

function uniquePresetName(baseName) {
    const existing = workers();
    let name = baseName;
    let index = 2;
    while (Object.prototype.hasOwnProperty.call(existing, name)) {
        name = `${baseName} ${index}`;
        index += 1;
    }
    return name;
}

function activePresetName() {
    const data = settings();
    const existing = workers();
    const selected = asString(data.workerid);
    if (selected && asString(existing[selected])) {
        return selected;
    }
    return Object.keys(existing).find((name) => asString(existing[name])) || DEFAULT_PRESET_NAME;
}

function activeWorkflowText() {
    return asString(workers()[activePresetName()]);
}

async function ensureBuiltInWorkflowPreset() {
    const data = settings();
    const existing = workers();
    let changed = false;
    for (const preset of BUNDLED_WORKFLOW_PRESETS) {
        if (!asString(existing[preset.name])) {
            existing[preset.name] = await loadBundledWorkflowText(preset.name);
            changed = true;
        }
    }

    if (data.comfySimpleReferencePreferredPreset !== DEFAULT_PRESET_NAME && asString(existing[DEFAULT_PRESET_NAME])) {
        applyActiveWorkflow(DEFAULT_PRESET_NAME, existing[DEFAULT_PRESET_NAME], false);
        data.comfySimpleReferencePreferredPreset = DEFAULT_PRESET_NAME;
        changed = true;
    }

    if (changed) {
        saveSettingsDebounced();
    }
    return existing[DEFAULT_PRESET_NAME];
}

function workflowSourceText() {
    return `当前工作流预设：${activePresetName()}`;
}

function characterReferenceWorkflowName(fallback = activePresetName()) {
    const data = settings();
    return asString(data.comfyCharacterReferenceWorkerId || data.editWorkerid || fallback);
}

function characterReferenceWorkflowText(fallback = activeWorkflowText()) {
    const data = settings();
    return asString(data.comfyCharacterReferenceWorker || data.editWorker || fallback);
}

function syncCharacterReferenceWorkflowSettingsFromDom(save = true) {
    const data = settings();
    const editSelect = document.getElementById('editWorkerid');
    const editWorker = document.getElementById('editWorker');
    const name = asString(editSelect?.value || data.editWorkerid || data.comfyCharacterReferenceWorkerId || CHARACTER_REFERENCE_WORKFLOW_NAME);
    const workflowText = asString(editWorker?.value || data.editWorker || data.comfyCharacterReferenceWorker);
    let changed = false;

    if (name) {
        changed = assign(data, 'editWorkerid', name) || changed;
        changed = assign(data, 'comfyCharacterReferenceWorkerId', name) || changed;
    }
    if (workflowText) {
        changed = assign(data, 'editWorker', workflowText) || changed;
        changed = assign(data, 'comfyCharacterReferenceWorker', workflowText) || changed;
    }

    if (changed && save) {
        saveSettingsDebounced();
    }
    return changed;
}

function applyActiveWorkflow(name, workflowText, save = true) {
    const data = settings();
    let changed = false;

    changed = assign(data, 'workerid', name) || changed;
    changed = assign(data, 'worker', workflowText) || changed;
    const referenceWorkflowName = characterReferenceWorkflowName(name || CHARACTER_REFERENCE_WORKFLOW_NAME);
    const referenceWorkflowText = characterReferenceWorkflowText(workflowText);
    changed = assign(data, 'comfyCharacterReferenceWorkerId', referenceWorkflowName) || changed;
    changed = assign(data, 'comfyCharacterReferenceWorker', referenceWorkflowText) || changed;
    if (!asString(data.editWorkerid)) {
        changed = assign(data, 'editWorkerid', referenceWorkflowName) || changed;
    }
    if (!asString(data.editWorker)) {
        changed = assign(data, 'editWorker', referenceWorkflowText) || changed;
    }
    changed = assign(data, 'comfyWorkflowAdapter', WORKFLOW_ADAPTER) || changed;
    changed = assign(data, 'comfyFlux2KleinEnabled', true) || changed;
    changed = assign(data, 'comfyPromptOptimizerEnabled', false) || changed;
    changed = assign(data, 'enableChatu8ImageTextAnchors', true) || changed;

    const profile = data.comfyui_profiles?.[data.comfyui_profile_id];
    if (profile && typeof profile === 'object' && !Array.isArray(profile)) {
        changed = assign(profile, 'workerid', name) || changed;
        changed = assign(profile, 'worker', workflowText) || changed;
    }

    if (changed && save) {
        saveSettingsDebounced();
    }

    return changed;
}

function installWorkflowPreset(name, workflowText, makeActive = true) {
    workers()[name] = workflowText;
    if (makeActive) {
        applyActiveWorkflow(name, workflowText);
    } else {
        saveSettingsDebounced();
    }
}

function migrateLegacySingleWorkflowPreset() {
    const data = settings();
    const legacyWorkflowText = asString(data.comfySimpleWorkflowText);
    if (!legacyWorkflowText) {
        return;
    }

    const existing = workers();
    const existingName = Object.keys(existing).find((name) => asString(existing[name]) === legacyWorkflowText);
    const name = existingName || uniquePresetName(presetBaseName(data.comfySimpleWorkflowSourceName || 'Imported Workflow'));
    if (!existingName) {
        existing[name] = legacyWorkflowText;
    }

    delete data.comfySimpleWorkflowText;
    delete data.comfySimpleWorkflowSourceName;
    delete data.comfySimpleWorkflowUpdatedAt;
    applyActiveWorkflow(name, legacyWorkflowText);
}

function addSimpleStyle() {
    if (typeof document === 'undefined' || document.getElementById('st_chatu8_simple_reference_style')) {
        return;
    }

    const style = document.createElement('style');
    style.id = 'st_chatu8_simple_reference_style';
    style.textContent = `
        .st-chatu8-simple-hidden { display: none !important; }
        .st-chatu8-simple-note {
            margin: 8px 0 12px;
            padding: 10px 12px;
            border: 1px solid rgba(132, 148, 156, 0.28);
            border-radius: 8px;
            background: rgba(0, 0, 0, 0.12);
            color: #dce8ee;
            font-size: 12px;
            line-height: 1.45;
        }
        #st_chatu8_simple_ref_status {
            margin-top: 8px;
            color: #b8c7ce;
            font-size: 12px;
            line-height: 1.45;
        }
        #st_chatu8_simple_ref_status[data-kind="error"] { color: #ffb4a8; }
        #st_chatu8_simple_ref_status[data-kind="ok"] { color: #bce8c4; }
        #workerid.st-chatu8-simple-fixed-select {
            pointer-events: none;
            opacity: 0.82;
        }
        .st-chatu8-simple-note-title {
            font-weight: 700;
        }
        .st-chatu8-simple-note-actions {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-top: 10px;
        }
        #workerid {
            max-width: 100%;
        }
        @media (max-width: 600px) {
            .st-chatu8-simple-note-actions .st-chatu8-btn {
                flex: 1 1 100%;
                min-width: 0;
            }
        }
        .st-chatu8-simple-workflow-status {
            margin-top: 8px;
            color: #b8c7ce;
        }
        .st-chatu8-simple-workflow-status[data-kind="error"] { color: #ffb4a8; }
        .st-chatu8-simple-workflow-status[data-kind="ok"] { color: #bce8c4; }
    `;
    document.head.appendChild(style);
}

function closestField(element) {
    return element?.closest?.('.st-chatu8-field, .st-chatu8-field-col, .st-chatu8-settings-section');
}

function hideControl(id) {
    const element = document.getElementById(id) || document.querySelector(`label[for="${id}"]`);
    const target = closestField(element) || element;
    target?.classList?.add('st-chatu8-simple-hidden');
}

function hideElement(id) {
    document.getElementById(id)?.classList?.add('st-chatu8-simple-hidden');
}

function hideSectionContaining(id) {
    document.getElementById(id)?.closest?.('.st-chatu8-settings-section')?.classList?.add('st-chatu8-simple-hidden');
}

function showElement(id) {
    document.getElementById(id)?.classList?.remove('st-chatu8-simple-hidden');
}

function showSectionContaining(id) {
    document.getElementById(id)?.closest?.('.st-chatu8-settings-section')?.classList?.remove('st-chatu8-simple-hidden');
}

function restoreWorkflowUi() {
    if (typeof document === 'undefined') {
        return;
    }

    ['workerid', 'editWorkerid'].forEach(showSectionContaining);
    WORKFLOW_CONTROL_IDS.forEach(showElement);
    WORKFLOW_LABEL_FORS.forEach((id) => {
        document.querySelector(`label[for="${id}"]`)?.classList?.remove('st-chatu8-simple-hidden');
    });

    const worker = document.getElementById('worker');
    if (worker) {
        worker.readOnly = false;
    }

    const editWorker = document.getElementById('editWorker');
    if (editWorker) {
        editWorker.readOnly = false;
    }

    document.getElementById('st_chatu8_simple_workflow_note')?.remove();
}

function hideComplexUi() {
    if (typeof document === 'undefined') {
        return;
    }

    restoreWorkflowUi();

    ['comfyui_profile_id'].forEach(hideSectionContaining);

    [
        'yusheid_comfyui',
        'fixedPrompt_comfyui',
        'fixedPrompt_end_comfyui',
        'negativePrompt_comfyui',
        'ComfyuiLORA',
        'prompt_replace_id_comfyui',
        'AQT_comfyui',
        'UCP_comfyui',
        'MODEL_NAME',
        'comfyui_vae',
        'comfyuiCLIPName',
        'ipa',
        'c_fenwei',
        'c_xijie',
        'c_quanzhong',
        'c_idquanzhong',
    ].forEach(hideControl);

    [
        'st_chatu8_anchor_settings',
        'st_chatu8_comfy_world_style_panel',
    ].forEach(hideElement);

    document.querySelectorAll('[id^="st_chatu8_klein_prompt_optimizer_"]').forEach((element) => {
        const target = closestField(element) || element;
        target.classList.add('st-chatu8-simple-hidden');
    });
}

function syncWorkflowControls(workflowText) {
    restoreWorkflowUi();

    const select = document.getElementById('workerid');
    const referenceWorkflowName = characterReferenceWorkflowName(CHARACTER_REFERENCE_WORKFLOW_NAME);
    const referenceWorkflowText = characterReferenceWorkflowText(workflowText || activeWorkflowText());
    if (select) {
        const existing = workers();
        const names = Object.keys(existing).filter((name) => asString(existing[name]));
        const selected = activePresetName();
        const currentOptions = Array.from(select.options || []).map((option) => option.value);
        if (currentOptions.join('\n') !== names.join('\n')) {
            select.innerHTML = '';
            for (const name of names) {
                select.add(new Option(name, name));
            }
        }
        select.value = selected;
        select.disabled = false;
        select.classList.remove('st-chatu8-simple-fixed-select');
        if (select.dataset.stChatu8SimpleRefBound !== SIMPLE_VERSION) {
            select.addEventListener('change', () => {
                const name = asString(select.value);
                const selectedWorkflowText = asString(workers()[name]);
                if (!name || !selectedWorkflowText) {
                    return;
                }
                applyActiveWorkflow(name, selectedWorkflowText);
                syncWorkflowControls(selectedWorkflowText);
                setWorkflowStatus(`已切换到工作流预设：${name}`, 'ok');
            });
            select.dataset.stChatu8SimpleRefBound = SIMPLE_VERSION;
        }
    }

    const worker = document.getElementById('worker');
    if (worker) {
        worker.value = workflowText || activeWorkflowText();
        worker.readOnly = false;
        worker.classList.remove('st-chatu8-simple-hidden');
        document.querySelector('label[for="worker"]')?.classList.remove('st-chatu8-simple-hidden');
    }

    const editSelect = document.getElementById('editWorkerid');
    if (editSelect) {
        if (referenceWorkflowName && !Array.from(editSelect.options || []).some((option) => option.value === referenceWorkflowName)) {
            editSelect.add(new Option(referenceWorkflowName, referenceWorkflowName));
        }
        if (referenceWorkflowName) {
            editSelect.value = referenceWorkflowName;
        }
        editSelect.disabled = false;
        editSelect.classList.remove('st-chatu8-simple-fixed-select', 'st-chatu8-simple-hidden');
        if (editSelect.dataset.stChatu8CharacterReferenceBound !== SIMPLE_VERSION) {
            editSelect.addEventListener('change', () => syncCharacterReferenceWorkflowSettingsFromDom());
            editSelect.dataset.stChatu8CharacterReferenceBound = SIMPLE_VERSION;
        }
    }

    const editWorker = document.getElementById('editWorker');
    if (editWorker) {
        if (document.activeElement !== editWorker && referenceWorkflowText) {
            editWorker.value = referenceWorkflowText;
        }
        editWorker.readOnly = false;
        editWorker.classList.remove('st-chatu8-simple-hidden');
        document.querySelector('label[for="editWorker"]')?.classList.remove('st-chatu8-simple-hidden');
        if (editWorker.dataset.stChatu8CharacterReferenceBound !== SIMPLE_VERSION) {
            editWorker.addEventListener('input', () => syncCharacterReferenceWorkflowSettingsFromDom());
            editWorker.addEventListener('change', () => syncCharacterReferenceWorkflowSettingsFromDom());
            editWorker.dataset.stChatu8CharacterReferenceBound = SIMPLE_VERSION;
        }
    }

    bindCharacterReferenceWorkflowControls();
}

function renderWorkflowNote(message = '', kind = '') {
    restoreWorkflowUi();
    const note = document.getElementById('st_chatu8_simple_workflow_note');
    if (note) {
        note.remove();
    }
}

function setWorkflowStatus(message, kind = '') {
    const status = document.getElementById('st_chatu8_simple_workflow_status');
    if (!status) {
        renderWorkflowNote(message, kind);
        return;
    }
    status.textContent = message;
    status.dataset.kind = kind;
}

async function importWorkflowFile(file) {
    if (!file) {
        return;
    }

    const workflowText = normalizeWorkflowText(await file.text());
    const name = uniquePresetName(presetBaseName(file.name || 'workflow.json'));
    installWorkflowPreset(name, workflowText, true);
    syncWorkflowControls(workflowText);
    setWorkflowStatus(`已导入工作流预设：${name}`, 'ok');
}

async function resetBundledWorkflow() {
    const workflowText = await loadBundledWorkflowText(DEFAULT_PRESET_NAME);
    installWorkflowPreset(DEFAULT_PRESET_NAME, workflowText, true);
    syncWorkflowControls(workflowText);
    setWorkflowStatus(`已恢复内置工作流预设：${DEFAULT_PRESET_NAME}`, 'ok');
}

function deleteSelectedWorkflow() {
    const existing = workers();
    const names = Object.keys(existing).filter((name) => asString(existing[name]));
    const name = activePresetName();
    if (names.length <= 1) {
        setWorkflowStatus('至少需要保留一个工作流预设。', 'error');
        return;
    }

    delete existing[name];
    const nextName = Object.keys(existing).find((key) => asString(existing[key]));
    if (!nextName) {
        setWorkflowStatus('至少需要保留一个工作流预设。', 'error');
        return;
    }

    const nextWorkflowText = asString(existing[nextName]);
    applyActiveWorkflow(nextName, nextWorkflowText);
    syncWorkflowControls(nextWorkflowText);
    setWorkflowStatus(`已删除工作流预设：${name}`, 'ok');
}

function bindWorkflowImportControls() {
    const importButton = document.getElementById('st_chatu8_simple_workflow_import');
    const resetButton = document.getElementById('st_chatu8_simple_workflow_reset');
    const deleteButton = document.getElementById('st_chatu8_simple_workflow_delete');
    const fileInput = document.getElementById('st_chatu8_simple_workflow_file');

    if (importButton && fileInput && importButton.dataset.stChatu8SimpleRefBound !== SIMPLE_VERSION) {
        importButton.addEventListener('click', () => fileInput.click());
        importButton.dataset.stChatu8SimpleRefBound = SIMPLE_VERSION;
    }

    if (fileInput && fileInput.dataset.stChatu8SimpleRefBound !== SIMPLE_VERSION) {
        fileInput.addEventListener('change', async () => {
            const file = fileInput.files?.[0];
            fileInput.value = '';
            try {
                await importWorkflowFile(file);
            } catch (error) {
                console.warn('[st-chatu8] Workflow import failed:', error);
                setWorkflowStatus(error?.message || String(error), 'error');
            }
        });
        fileInput.dataset.stChatu8SimpleRefBound = SIMPLE_VERSION;
    }

    if (resetButton && resetButton.dataset.stChatu8SimpleRefBound !== SIMPLE_VERSION) {
        resetButton.addEventListener('click', async () => {
            try {
                await resetBundledWorkflow();
            } catch (error) {
                console.warn('[st-chatu8] Workflow reset failed:', error);
                setWorkflowStatus(error?.message || String(error), 'error');
            }
        });
        resetButton.dataset.stChatu8SimpleRefBound = SIMPLE_VERSION;
    }

    if (deleteButton && deleteButton.dataset.stChatu8SimpleRefBound !== SIMPLE_VERSION) {
        deleteButton.addEventListener('click', () => {
            try {
                deleteSelectedWorkflow();
            } catch (error) {
                console.warn('[st-chatu8] Workflow delete failed:', error);
                setWorkflowStatus(error?.message || String(error), 'error');
            }
        });
        deleteButton.dataset.stChatu8SimpleRefBound = SIMPLE_VERSION;
    }
}

function ensureSelectOption(select, name) {
    if (!select || !name) {
        return;
    }
    if (!Array.from(select.options || []).some((option) => option.value === name)) {
        select.add(new Option(name, name));
    }
}

function startEditWorkflowVisualBridge(originalMainWorkflowText) {
    const worker = document.getElementById('worker');
    const editWorker = document.getElementById('editWorker');
    if (!worker || !editWorker) {
        return;
    }

    clearInterval(editWorkflowVisualBridgeTimer);
    let lastCopied = asString(editWorker.value);
    const startedAt = Date.now();
    editWorkflowVisualBridgeTimer = setInterval(() => {
        const nextWorkflowText = asString(worker.value);
        if (nextWorkflowText && nextWorkflowText !== lastCopied && nextWorkflowText !== originalMainWorkflowText) {
            editWorker.value = nextWorkflowText;
            syncCharacterReferenceWorkflowSettingsFromDom();
            lastCopied = nextWorkflowText;
        }
        if (Date.now() - startedAt > 10 * 60 * 1000) {
            clearInterval(editWorkflowVisualBridgeTimer);
            editWorkflowVisualBridgeTimer = null;
        }
    }, 500);
}

function visualizeCharacterReferenceWorkflow() {
    const data = settings();
    const editSelect = document.getElementById('editWorkerid');
    const editWorker = document.getElementById('editWorker');
    const workerSelect = document.getElementById('workerid');
    const worker = document.getElementById('worker');
    const visualizeButton = document.getElementById('visualize_workflow');
    const workflowName = asString(editSelect?.value || data.editWorkerid || data.comfyCharacterReferenceWorkerId || CHARACTER_REFERENCE_WORKFLOW_NAME);
    const workflowText = asString(editWorker?.value || data.editWorker || data.comfyCharacterReferenceWorker);

    if (!visualizeButton || !workflowText) {
        setWorkflowStatus('角色首参考图生成工作流为空，无法打开可视化。', 'error');
        return;
    }

    const original = {
        workerid: data.workerid,
        worker: data.worker,
        workerSelectValue: workerSelect?.value || '',
        workerValue: worker?.value || '',
    };
    const existingWorkers = workers();
    const hadMainPreset = Object.prototype.hasOwnProperty.call(existingWorkers, workflowName);
    const originalMainPreset = existingWorkers[workflowName];

    syncCharacterReferenceWorkflowSettingsFromDom();
    existingWorkers[workflowName] = workflowText;
    ensureSelectOption(workerSelect, workflowName);
    if (workerSelect) {
        workerSelect.value = workflowName;
    }
    if (worker) {
        worker.value = workflowText;
    }
    data.workerid = workflowName;
    data.worker = workflowText;

    visualizeButton.click();
    startEditWorkflowVisualBridge(asString(original.workerValue || original.worker));

    setTimeout(() => {
        if (workerSelect) {
            workerSelect.value = original.workerSelectValue;
        }
        if (worker) {
            worker.value = original.workerValue;
        }
        data.workerid = original.workerid;
        data.worker = original.worker;
        if (hadMainPreset) {
            existingWorkers[workflowName] = originalMainPreset;
        } else {
            delete existingWorkers[workflowName];
        }
    }, 500);
}

function bindCharacterReferenceWorkflowControls() {
    const visualizeButton = document.getElementById('visualize_edit_workflow');
    if (visualizeButton && visualizeButton.dataset.stChatu8CharacterReferenceBound !== SIMPLE_VERSION) {
        visualizeButton.addEventListener('click', visualizeCharacterReferenceWorkflow);
        visualizeButton.dataset.stChatu8CharacterReferenceBound = SIMPLE_VERSION;
    }
}

function ensureReferenceStatus() {
    const controls = document.getElementById('comfyui-select-image-btn')?.closest('.st-chatu8-image-controls');
    if (!controls) {
        return null;
    }

    let status = document.getElementById('st_chatu8_simple_ref_status');
    if (!status) {
        status = document.createElement('div');
        status.id = 'st_chatu8_simple_ref_status';
        controls.insertAdjacentElement('afterend', status);
    }
    return status;
}

function setReferenceStatus(message, kind = '') {
    const status = ensureReferenceStatus();
    if (!status) {
        return;
    }
    status.textContent = message;
    status.dataset.kind = kind;
}

function buildViewUrl(meta) {
    const url = currentComfyUrl();
    if (!url || !meta?.name) {
        return '';
    }
    const params = new URLSearchParams();
    params.set('filename', meta.name);
    params.set('type', meta.type || 'input');
    if (meta.subfolder) {
        params.set('subfolder', meta.subfolder);
    }
    return `${url}/view?${params.toString()}`;
}

function renderReferencePreview() {
    const data = settings();
    const imagePath = getSimpleReferencePath();
    const name = asString(data.comfySimpleReferenceImageName) || fileNameFromPath(imagePath);
    const subfolder = asString(data.comfySimpleReferenceImageSubfolder);
    const type = asString(data.comfySimpleReferenceImageType) || 'input';
    const img = document.getElementById('previewImage2');
    const remove = document.getElementById('comfyui-remove-image-btn');
    const placeholder = document.querySelector('#comfyui-image-preview-container .st-chatu8-image-placeholder');

    if (img) {
        const viewUrl = buildViewUrl({ name, subfolder, type });
        img.src = imagePath && viewUrl ? viewUrl : '';
        img.style.display = imagePath && viewUrl ? 'block' : 'none';
    }
    if (placeholder) {
        placeholder.style.display = imagePath ? 'none' : '';
    }
    if (remove) {
        remove.style.display = imagePath ? '' : 'none';
    }

    if (imagePath) {
        setReferenceStatus(`当前参考图：${imagePath}`, 'ok');
    } else {
        setReferenceStatus('尚未上传参考图。', '');
    }
}

async function uploadReferenceImage(file) {
    if (!file) {
        return;
    }

    const url = currentComfyUrl();
    if (!url) {
        throw new Error('请先填写 ComfyUI API 地址。');
    }

    const form = new FormData();
    form.append('image', file, file.name);
    form.append('type', 'input');
    form.append('overwrite', 'true');

    setReferenceStatus('正在上传参考图...', '');
    const response = await fetch(`${url}/upload/image`, {
        method: 'POST',
        body: form,
    });

    if (!response.ok) {
        throw new Error(`ComfyUI 上传失败：HTTP ${response.status}`);
    }

    let result = {};
    try {
        result = await response.json();
    } catch (_error) {
        result = {};
    }

    const name = asString(result.name || result.filename || file.name);
    const subfolder = asString(result.subfolder);
    const type = asString(result.type) || 'input';
    const imagePath = subfolder ? `${subfolder}/${name}` : name;
    const data = settings();

    data.comfySimpleReferenceImage = imagePath;
    data.comfySimpleReferenceImageName = name;
    data.comfySimpleReferenceImageSubfolder = subfolder;
    data.comfySimpleReferenceImageType = type;
    data.comfyManualReferenceImagePath = imagePath;
    data.comfyUploadedReferenceImage = imagePath;
    data.comfyRefImagePath = imagePath;
    saveSettingsDebounced();
    renderReferencePreview();
    setReferenceStatus(`参考图已上传：${imagePath}`, 'ok');
}

function clearReferenceImage() {
    const data = settings();
    delete data.comfySimpleReferenceImage;
    delete data.comfySimpleReferenceImageName;
    delete data.comfySimpleReferenceImageSubfolder;
    delete data.comfySimpleReferenceImageType;
    delete data.comfyManualReferenceImagePath;
    delete data.comfyUploadedReferenceImage;
    delete data.comfyRefImagePath;
    saveSettingsDebounced();
    renderReferencePreview();
}

function bindReferenceControls() {
    const pick = document.getElementById('comfyui-select-image-btn');
    const input = document.getElementById('imageInput2');
    const remove = document.getElementById('comfyui-remove-image-btn');

    if (pick && input && pick.dataset.stChatu8SimpleRefBound !== SIMPLE_VERSION) {
        pick.addEventListener('click', () => input.click());
        pick.dataset.stChatu8SimpleRefBound = SIMPLE_VERSION;
    }

    if (input && input.dataset.stChatu8SimpleRefBound !== SIMPLE_VERSION) {
        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            input.value = '';
            try {
                await uploadReferenceImage(file);
            } catch (error) {
                console.warn('[st-chatu8] Reference image upload failed:', error);
                setReferenceStatus(error?.message || String(error), 'error');
            }
        });
        input.dataset.stChatu8SimpleRefBound = SIMPLE_VERSION;
    }

    if (remove && remove.dataset.stChatu8SimpleRefBound !== SIMPLE_VERSION) {
        remove.addEventListener('click', clearReferenceImage);
        remove.dataset.stChatu8SimpleRefBound = SIMPLE_VERSION;
    }
}

async function refreshSimpleMode() {
    if (typeof document === 'undefined') {
        return;
    }

    addSimpleStyle();
    hideComplexUi();
    bindReferenceControls();
    renderReferencePreview();

    migrateLegacySingleWorkflowPreset();
    await ensureBuiltInWorkflowPreset();
    const workflowText = activeWorkflowText() || await loadBundledWorkflowText();
    applyActiveWorkflow(activePresetName(), workflowText);
    syncWorkflowControls(workflowText);
    bindCharacterReferenceWorkflowControls();
}

function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
        refreshSimpleMode().catch((error) => {
            console.warn('[st-chatu8] Failed to initialize simple reference mode:', error);
            setReferenceStatus(error?.message || String(error), 'error');
        });
    }, 60);
}

function init() {
    if (typeof document === 'undefined') {
        return;
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', scheduleRefresh, { once: true });
    } else {
        scheduleRefresh();
    }

    const observer = new MutationObserver(scheduleRefresh);
    observer.observe(document.documentElement, { childList: true, subtree: true });

    window.stChatu8SimpleReferenceMode = {
        refresh: scheduleRefresh,
        uploadReferenceImage,
        clearReferenceImage,
        importWorkflowFile,
        resetBundledWorkflow,
        deleteSelectedWorkflow,
        presetName: DEFAULT_PRESET_NAME,
        builtInPresetNames: BUNDLED_WORKFLOW_PRESETS.map((preset) => preset.name),
    };
}

init();
