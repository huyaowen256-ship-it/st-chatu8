import { chat_metadata, eventSource, getRequestHeaders, saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { getContext } from '../../../../st-context.js';
import { loadWorldInfo, METADATA_KEY as WORLD_INFO_METADATA_KEY, selected_world_info, world_info, world_names } from '../../../../world-info.js';
import { EventType, extensionName } from './config.js';
import { resolveComfyCharacterReferences } from './characterprompt.js';
import { executeTypedLLMRequest } from './settings/llmService.js';
import { extractCharacterAndOutfitTags } from './newline_fix.js';

const BOOTSTRAP_VERSION = '20260522_single_front_reference_v1';
const BOOTSTRAP_REQUEST_TYPE = 'char_design';
const BOOTSTRAP_TRANSLATE_REQUEST_TYPE = 'translation';
const BOOTSTRAP_WORKER_SELECT_ID = 'comfyAutoReferenceBootstrapWorkerId';
const BOOTSTRAP_TIMEOUT_MS = 8 * 60 * 1000;
const AUTO_REFERENCE_DIR = 'D:\\jiuguan\\角色';
const AUTO_REFERENCE_SAVE_ENDPOINT = '/api/plugins/st-chatu8/save-reference-image';
const REFERENCE_BOOTSTRAP_NEGATIVE_PROMPT = [
    'low quality',
    'worst quality',
    'bad anatomy',
    'bad hands',
    'extra fingers',
    'missing fingers',
    'watermark',
    'text',
    'logo',
    'blurry',
    'multiple views',
    'turnaround',
    'character sheet',
    'reference sheet',
    'split screen',
    'grid layout',
    'comic panels',
    'side view',
    'back view',
    'duplicate character',
    'extra body',
].join(', ');

let activeDialogPromise = null;
const bootstrapSessionByCharacter = new Map();

function asString(value, fallback = '') {
    const text = value == null ? '' : String(value).trim();
    return text || fallback;
}

function settings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = {};
    }
    return extension_settings[extensionName];
}

function isAutoReferenceBootstrapExplicitlyDisabled(data = settings()) {
    return data.comfyAutoReferenceBootstrapExplicitlyDisabled === true || data.comfyAutoReferenceBootstrapDisabled === true;
}

function isAutoReferenceBootstrapEnabled(data = settings()) {
    if (isAutoReferenceBootstrapExplicitlyDisabled(data)) {
        return false;
    }
    return data.comfyAutoReferenceBootstrapEnabled === true || data.comfyAutoReferenceBootstrapExplicitlyEnabled === true;
}

function comfyWorkers() {
    const workers = settings().workers;
    return workers && typeof workers === 'object' && !Array.isArray(workers) ? workers : {};
}

function characterReferenceWorkerIdFromSettings() {
    const data = settings();
    const editSelectValue = typeof document !== 'undefined'
        ? asString(document.getElementById('editWorkerid')?.value)
        : '';
    return asString(
        editSelectValue
        || data.editWorkerid
        || data.comfyCharacterReferenceWorkerId
        || data.comfyAutoReferenceBootstrapWorkerId,
    );
}

function setCharacterReferenceWorkerId(workerId) {
    const data = settings();
    data.editWorkerid = workerId;
    data.comfyCharacterReferenceWorkerId = workerId;
    data.comfyAutoReferenceBootstrapWorkerId = workerId;
    const editSelect = typeof document !== 'undefined' ? document.getElementById('editWorkerid') : null;
    if (editSelect && editSelect.value !== workerId) {
        editSelect.value = workerId;
    }
}

function bootstrapWorkerId() {
    const workerId = characterReferenceWorkerIdFromSettings();
    return workerId && Object.prototype.hasOwnProperty.call(comfyWorkers(), workerId) ? workerId : '';
}

function normalizeBootstrapRequestType(value, fallback) {
    const type = asString(value);
    if (!type || type === 'character_reference_bootstrap') {
        return fallback;
    }
    return type;
}

function bootstrapGenerateRequestType() {
    return normalizeBootstrapRequestType(settings().comfyAutoReferenceBootstrapRequestType, BOOTSTRAP_REQUEST_TYPE);
}

function bootstrapTranslateRequestType() {
    return normalizeBootstrapRequestType(
        settings().comfyAutoReferenceBootstrapTranslateRequestType || settings().comfyAutoReferenceBootstrapRequestType,
        BOOTSTRAP_TRANSLATE_REQUEST_TYPE,
    );
}

function characterReferenceSystemPrompt() {
    const data = settings();
    const input = typeof document !== 'undefined'
        ? document.getElementById('st_chatu8_character_reference_system_prompt')
        : null;
    return asString(
        input?.value ||
        data.characterReferenceSystemPrompt ||
        data.comfyCharacterReferenceSystemPrompt ||
        data.comfyAutoReferenceBootstrapSystemPrompt,
    );
}

function selectedBootstrapWorkflowText() {
    const data = settings();
    const workerId = characterReferenceWorkerIdFromSettings();
    return asString(
        data.workers?.[workerId]
        || data.editWorker
        || data.comfyCharacterReferenceWorker
        || '',
    );
}

function collectWorkflowModelHints(value) {
    const hints = [];
    const visit = (item, key = '') => {
        if (item == null || hints.length > 80) {
            return;
        }
        if (typeof item === 'string') {
            if (/^(?:ckpt_name|model_name|unet_name|clip_name|vae_name|ipadapter_file|lora_name)$/i.test(key) || /\.(?:safetensors|ckpt|gguf|pt)$/i.test(item)) {
                hints.push(item);
            }
            return;
        }
        if (Array.isArray(item)) {
            item.forEach((child) => visit(child, key));
            return;
        }
        if (typeof item === 'object') {
            for (const [childKey, child] of Object.entries(item)) {
                visit(child, childKey);
            }
        }
    };
    const text = asString(value);
    try {
        visit(JSON.parse(text));
    } catch {
        for (const match of text.matchAll(/"(?:ckpt_name|model_name|unet_name|clip_name|vae_name|ipadapter_file|lora_name)"\s*:\s*"([^"]+)"/gi)) {
            hints.push(match[1]);
        }
    }
    return uniqueStrings(hints).slice(0, 24);
}

function referencePromptModelProfile() {
    const hints = collectWorkflowModelHints(selectedBootstrapWorkflowText());
    const joined = hints.join(' ').toLowerCase();
    if (/oneobsession|one obsession|illustrious|noob|wai|ponyxl/.test(joined)) {
        return {
            family: 'illustrious',
            name: hints.find((item) => /oneobsession|one obsession/i.test(item)) || hints.find((item) => /illustrious|noob|wai|pony/i.test(item)) || 'Illustrious/NoobAI style SDXL model',
            hints,
            instruction: [
                '当前首参考图工作流是 One Obsession / Illustrious / NoobAI 系模型，不是 Anima。',
                '使用英文 Danbooru tag 为主，允许少量短自然语言补充；不要写长段摄影式自然语言。',
                '正向开头使用：masterpiece, best quality, amazing quality, very awa, very aesthetic, newest, safe, 1girl, solo。',
                '角色首参考图只要单张正面全身立绘：full body, standing, front view, looking at viewer, neutral expression, arms relaxed, plain white background。',
                '不要写 character reference sheet / model sheet / turnaround / multiple views；这些词会诱发三视图、拼图和设定表。',
                '人物、发色、眼睛、体型、服装、材质、颜色、配饰都拆成逗号 tag；不要只写衣服名。',
                '避免 photorealistic/photo/realistic，除非用户明确要半写实；避免剧情场景、床、马车、火炉、暧昧氛围、镜头角度。',
                '末尾可加：absurdres, highres。',
            ].join('\n'),
        };
    }
    if (/anima/.test(joined)) {
        return {
            family: 'anima',
            name: hints.find((item) => /anima/i.test(item)) || 'Anima',
            hints,
            instruction: [
                '当前首参考图工作流是 Anima 系模型。',
                '使用动漫/插画 tag，避免写实/照片级真实感。',
                '正向可使用：masterpiece, best quality, score_7, safe, 1girl, solo。',
            ].join('\n'),
        };
    }
    if (/flux|klein|qwen/.test(joined)) {
        return {
            family: 'natural_language',
            name: hints.find((item) => /flux|klein|qwen/i.test(item)) || 'natural language image model',
            hints,
            instruction: [
                '当前首参考图工作流更偏自然语言模型。',
                '使用简洁英文自然语言描述角色设定图，不要堆 Stable Diffusion 质量 tag。',
                '描述正面全身、站姿、五官、发色、服装、材质、颜色和干净背景。',
            ].join('\n'),
        };
    }
    return {
        family: 'sdxl',
        name: hints[0] || 'unknown SDXL workflow',
        hints,
        instruction: [
            '当前首参考图工作流未识别出明确模型族，默认按 SDXL tag prompt 处理。',
            '使用英文逗号 tag，质量词、主体数量、角色特征、服装、构图依次排列。',
        ].join('\n'),
    };
}

function referencePromptModelProfileText() {
    const profile = referencePromptModelProfile();
    return [
        `当前 ComfyUI 首参考图工作流检测到模型/文件：${profile.name}`,
        profile.hints?.length ? `工作流模型线索：${profile.hints.join(', ')}` : '',
        '如果用户配置的系统提示词与当前工作流模型冲突，必须以当前工作流模型规则为准。',
        profile.instruction,
    ].filter(Boolean).join('\n');
}

function syncBootstrapSystemPromptField() {
    if (typeof document === 'undefined') {
        return;
    }
    const input = document.getElementById('st_chatu8_character_reference_system_prompt');
    if (!input) {
        return;
    }
    const data = settings();
    const stored = asString(data.characterReferenceSystemPrompt || data.comfyCharacterReferenceSystemPrompt || data.comfyAutoReferenceBootstrapSystemPrompt);
    if (!input.value && stored) {
        input.value = stored;
    }
    if (input.value && input.value !== stored) {
        data.characterReferenceSystemPrompt = input.value;
        data.comfyCharacterReferenceSystemPrompt = input.value;
        data.comfyAutoReferenceBootstrapSystemPrompt = input.value;
        saveSettingsDebounced();
    }
    if (input.dataset.stChatu8Bound === '1') {
        return;
    }
    input.dataset.stChatu8Bound = '1';
    input.addEventListener('input', () => {
        data.characterReferenceSystemPrompt = input.value;
        data.comfyCharacterReferenceSystemPrompt = input.value;
        data.comfyAutoReferenceBootstrapSystemPrompt = input.value;
        saveSettingsDebounced();
    });
}

function installBootstrapSettingsObserver() {
    if (typeof document === 'undefined') {
        return;
    }
    const bind = () => syncBootstrapSystemPromptField();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind, { once: true });
    } else {
        bind();
    }
    if (typeof MutationObserver === 'undefined') {
        return;
    }
    const observer = new MutationObserver(() => bind());
    observer.observe(document.documentElement, { childList: true, subtree: true });
}

installBootstrapSettingsObserver();

function syncBootstrapWorkerSelect() {
    if (typeof document === 'undefined') {
        return;
    }
    syncBootstrapSystemPromptField();
    const select = document.getElementById(BOOTSTRAP_WORKER_SELECT_ID);
    if (!select) {
        return;
    }
    const workers = comfyWorkers();
    const options = [['', '跟随当前工作流'], ...Object.keys(workers).map((workerId) => [workerId, workerId])];
    const signature = options.map(([value, label]) => `${value}\t${label}`).join('\n');
    if (select.dataset.stChatu8Options !== signature) {
        select.innerHTML = '';
        for (const [value, label] of options) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            option.title = label;
            select.appendChild(option);
        }
        select.dataset.stChatu8Options = signature;
    }
    select.value = bootstrapWorkerId();
    if (select.dataset.stChatu8Bound === '1') {
        return;
    }
    select.dataset.stChatu8Bound = '1';
    select.addEventListener('change', () => {
        setCharacterReferenceWorkerId(select.value);
        saveSettingsDebounced();
    });
    select.addEventListener('focus', syncBootstrapWorkerSelect);
    select.addEventListener('pointerdown', syncBootstrapWorkerSelect);
}

if (typeof document !== 'undefined') {
    setTimeout(syncBootstrapWorkerSelect, 500);
    setTimeout(syncBootstrapWorkerSelect, 2000);
    setTimeout(() => {
        if (!document.body || typeof MutationObserver === 'undefined') {
            return;
        }
        const observer = new MutationObserver(syncBootstrapWorkerSelect);
        observer.observe(document.body, { childList: true, subtree: true });
    }, 500);
}

function escapeHtml(value) {
    return asString(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function normalizeName(value) {
    return asString(value)
        .toLowerCase()
        .replace(/[【】\[\]{}()（）"'“”‘’`´]/g, ' ')
        .replace(/[_\-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function splitAliases(...values) {
    const result = [];
    const seen = new Set();
    const add = (value) => {
        const text = asString(value);
        if (!text) {
            return;
        }
        for (const item of text.split('|')) {
            const alias = asString(item);
            const key = normalizeName(alias);
            if (alias && key && !seen.has(key)) {
                seen.add(key);
                result.push(alias);
            }
        }
    };
    values.forEach(add);
    return result;
}

function uniqueStrings(values) {
    const result = [];
    const seen = new Set();
    for (const value of values || []) {
        const text = asString(value);
        const key = normalizeName(text);
        if (!text || !key || seen.has(key)) {
            continue;
        }
        seen.add(key);
        result.push(text);
    }
    return result;
}

function containsCjk(value) {
    return /[\u3400-\u9fff\uf900-\ufaff]/.test(asString(value));
}

function isAsciiAlias(value) {
    return /^[A-Za-z0-9 _.'\-]+$/.test(asString(value));
}

function isAsciiWordChar(value) {
    return /^[A-Za-z0-9_]$/.test(value || '');
}

function findAliasIndex(text, alias) {
    const source = asString(text);
    const needle = asString(alias);
    if (!source || !needle) {
        return -1;
    }
    const lowerSource = source.toLowerCase();
    const lowerNeedle = needle.toLowerCase();
    let index = lowerSource.indexOf(lowerNeedle);
    if (index < 0 || !isAsciiAlias(needle)) {
        return index;
    }
    while (index >= 0) {
        const before = lowerSource[index - 1] || '';
        const after = lowerSource[index + lowerNeedle.length] || '';
        if (!isAsciiWordChar(before) && !isAsciiWordChar(after)) {
            return index;
        }
        index = lowerSource.indexOf(lowerNeedle, index + 1);
    }
    return -1;
}

function englishPromptSegments(value) {
    const normalized = asString(value)
        .replace(/[\uFF0C\u3001\uFF1B\u3002]/g, ',')
        .replace(/[{}[\]]/g, ' ');
    if (!normalized) {
        return [];
    }
    return normalized
        .split(/[\n\r,;]+/)
        .map((segment) => segment.replace(/\s+/g, ' ').trim())
        .filter((segment) => {
            if (!segment || containsCjk(segment)) {
                return false;
            }
            if (/^[\d\s.,;:()_-]+$/.test(segment)) {
                return false;
            }
            if (/\b(?:character\s+sheet|reference\s+sheet|model\s+sheet|turnaround|multiple\s+views|multi[-\s]?view|three[-\s]?views?|3[-\s]?views?|split\s+screen|grid\s+layout|comic\s+panels?)\b/i.test(segment)) {
                return false;
            }
            if (/^default reference outfit$/i.test(segment)) {
                return false;
            }
            return !/^(?:type|subject|highlight|angle|character|pose(?:\s*&\s*action)?|action|clothing|extra\s+details|environment|scene|background)\s*:/i.test(segment);
        });
}

function sanitizeEnglishPrompt(value, fallback = '') {
    let segments = englishPromptSegments(value);
    if (!segments.length && fallback) {
        segments = englishPromptSegments(fallback);
    }
    const seen = new Set();
    return segments
        .filter((segment) => {
            const key = segment.toLowerCase();
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        })
        .join(', ');
}

function defaultEnglishReferencePrompt(name = 'the current character') {
    const profile = referencePromptModelProfile();
    if (profile.family === 'illustrious') {
        return [
            'masterpiece, best quality, amazing quality',
            'very awa, very aesthetic, newest',
            'safe',
            '1girl, solo',
            sanitizeEnglishPrompt(name) || 'the current character',
            'full body, standing, front view, looking at viewer',
            'neutral expression, arms relaxed',
            'single character, single view only, centered composition',
            'plain white background, no scenery',
            'detailed face, clear eyes, coherent anatomy',
            'absurdres, highres',
        ].filter(Boolean).join(', ');
    }
    return [
        'sfw',
        'solo character',
        'single full-body character portrait',
        'standing, front view, neutral pose, neutral expression, arms relaxed',
        'one front-facing view only, centered composition',
        'plain white background, soft even lighting, no scenery',
        'detailed face, clear eyes, coherent anatomy',
        sanitizeEnglishPrompt(name) || 'the current character',
    ].filter(Boolean).join(', ');
}

function stripReasoningBlocks(value) {
    return asString(value)
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .trim();
}

function originalDesignLine(label, value) {
    return `${label}: ${asString(value)}`;
}

function normalizeDesignFieldLabel(label) {
    return asString(label)
        .replace(/[\s_\-]+/g, '')
        .replace(/[：:]+$/g, '')
        .toLowerCase();
}

function parseLooseDesignFields(blockText) {
    const fields = new Map();
    let currentKey = '';
    for (const rawLine of asString(blockText).split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) {
            continue;
        }
        const match = line.match(/^([^:：]{1,40})[:：]\s*(.*)$/);
        if (match) {
            currentKey = normalizeDesignFieldLabel(match[1]);
            const value = asString(match[2]);
            if (currentKey) {
                const previous = fields.get(currentKey);
                fields.set(currentKey, previous ? `${previous}, ${value}` : value);
            }
        } else if (currentKey) {
            const previous = fields.get(currentKey);
            fields.set(currentKey, previous ? `${previous}, ${line}` : line);
        }
    }
    return fields;
}

function designField(fields, aliases) {
    for (const alias of aliases) {
        const value = fields.get(normalizeDesignFieldLabel(alias));
        if (asString(value)) {
            return asString(value);
        }
    }
    return '';
}

function joinDesignFields(fields, aliases) {
    const seen = new Set();
    const values = [];
    for (const alias of aliases) {
        const value = designField(fields, [alias]);
        for (const segment of value.split(/[,，;；\n\r]+/).map((item) => item.trim()).filter(Boolean)) {
            const key = segment.toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                values.push(segment);
            }
        }
    }
    return values.join(', ');
}

function isWeakParsedDesignValue(value) {
    const text = asString(value);
    return !text || /^[\d\s,.;:，。；：\-]+$/.test(text);
}

function mergeDesignRecord(primary = {}, supplemental = {}) {
    const result = { ...(supplemental || {}), ...(primary || {}) };
    for (const [key, value] of Object.entries(supplemental || {})) {
        if (key === 'matchedOutfits') {
            continue;
        }
        if (isWeakParsedDesignValue(result[key]) && asString(value)) {
            result[key] = value;
        }
    }
    return result;
}

function matchingDesignRecord(records, target, index = 0) {
    const names = splitAliases(target?.nameCN, target?.nameEN);
    if (names.length) {
        const matched = records.find((record) => {
            const aliases = splitAliases(record?.nameCN, record?.nameEN);
            return aliases.some((alias) => names.some((name) => normalizeName(alias) === normalizeName(name)));
        });
        if (matched) {
            return matched;
        }
    }
    return records[index] || null;
}

function mergeParsedDesigns(legacyParsed, flexibleParsed) {
    const legacyCharacters = Array.isArray(legacyParsed?.characters) ? legacyParsed.characters : [];
    const legacyOutfits = Array.isArray(legacyParsed?.outfits) ? legacyParsed.outfits : [];
    const flexibleCharacters = Array.isArray(flexibleParsed?.characters) ? flexibleParsed.characters : [];
    const flexibleOutfits = Array.isArray(flexibleParsed?.outfits) ? flexibleParsed.outfits : [];
    if (!legacyCharacters.length && !legacyOutfits.length) {
        return flexibleCharacters.length || flexibleOutfits.length ? flexibleParsed : null;
    }
    if (!flexibleCharacters.length && !flexibleOutfits.length) {
        return legacyParsed;
    }

    const outfits = legacyOutfits.length
        ? legacyOutfits.map((outfit, index) => mergeDesignRecord(outfit, matchingDesignRecord(flexibleOutfits, outfit, index) || {}))
        : flexibleOutfits.slice();
    for (const outfit of flexibleOutfits) {
        if (!matchingDesignRecord(outfits, outfit)) {
            outfits.push(outfit);
        }
    }

    const characters = legacyCharacters.length
        ? legacyCharacters.map((character, index) => {
            const merged = mergeDesignRecord(character, matchingDesignRecord(flexibleCharacters, character, index) || {});
            const matchedOutfits = Array.isArray(character?.matchedOutfits) ? character.matchedOutfits : [];
            if (matchedOutfits.length) {
                merged.matchedOutfits = matchedOutfits.map((outfit, outfitIndex) => mergeDesignRecord(outfit, matchingDesignRecord(flexibleOutfits, outfit, outfitIndex) || {}));
            } else if (outfits.length) {
                merged.matchedOutfits = [outfits[0]];
            }
            return merged;
        })
        : flexibleCharacters.slice();
    for (const character of flexibleCharacters) {
        if (!matchingDesignRecord(characters, character)) {
            characters.push(character);
        }
    }
    return { characters, outfits };
}

function parseFlexibleOriginalDesignText(value) {
    const text = asString(value);
    if (!text) {
        return null;
    }
    const characters = [];
    const outfits = [];
    const blockPattern = /<(人物|角色|服装)(?:\s+[^>]*)?>([\s\S]*?)<\/\1>/g;
    let match;
    while ((match = blockPattern.exec(text)) !== null) {
        const type = match[1];
        const fields = parseLooseDesignFields(match[2]);
        if (type === '服装') {
            const frontPrompt = joinDesignFields(fields, [
                '服饰类型', '服装类型', '服装分类', '设计定位', '适合场景',
                '风格', '颜色', '主色调', '辅色调', '色板', '材质', '材质表现', '主料', '辅料', '功能性', '纹理与花纹',
                '正面视角视觉描述', '首层', '中层', '配饰',
                'SFW正面层', '正面层', '上半身', '上半身SFW', '下半身', '下半身SFW',
                'SFW鞋子式样', '鞋子式样', '鞋子', '配饰', 'SFW手套或手部装饰', '手套或手部装饰',
            ]);
            const backPrompt = joinDesignFields(fields, [
                '背面视角视觉描述', '首层背面', '中层背面', '配饰背面',
                'SFW背面层', '背面层', '上半身背面', '上半身SFW背面', '下半身背面', '下半身SFW背面',
            ]);
            outfits.push({
                nameCN: designField(fields, ['中文名称', '服装中文名称', '服装名', '名称']),
                nameEN: designField(fields, ['英文名称', '服装英文名称', 'english name', 'nameEN']),
                owner: designField(fields, ['归属人', '所属角色', '角色', 'owner']),
                style: joinDesignFields(fields, ['风格', '设计定位', '适合性格', '适合场景']),
                color: joinDesignFields(fields, ['颜色', '主色调', '辅色调', '色板']),
                material: joinDesignFields(fields, ['材质', '材质表现', '主料', '辅料', '功能性', '纹理与花纹']),
                upperBody: joinDesignFields(fields, ['SFW正面层', '正面层', '上半身', '上半身SFW', '正面视角视觉描述', '首层', '中层', '服饰类型', '服装类型', '服装分类', '材质', '材质表现', '主料', '辅料', '功能性', '纹理与花纹', '配饰', 'SFW手套或手部装饰']),
                upperBodyBack: joinDesignFields(fields, ['SFW背面层', '背面层', '上半身背面', '上半身SFW背面']),
                fullBody: frontPrompt,
                fullBodyBack: backPrompt,
            });
        } else {
            characters.push({
                nameCN: designField(fields, ['中文名称', '角色中文名称', '角色名', '姓名', '名称']),
                nameEN: designField(fields, ['英文名称', '角色英文名称', 'english name', 'nameEN']),
                characterTraits: designField(fields, ['角色特征', '特征', '气质', '人物特征']),
                facialFeatures: designField(fields, ['五官外貌', '外貌', '面部', '脸部', 'facialFeatures']),
                facialFeaturesBack: designField(fields, ['五官外貌背面', '背面外貌', 'facialFeaturesBack']),
                upperBodySFW: designField(fields, ['上半身SFW', '上半身', '上身SFW', '上身']),
                upperBodySFWBack: designField(fields, ['上半身SFW背面', '上半身背面', '上身背面']),
                fullBodySFW: designField(fields, ['下半身SFW', '下半身', '全身SFW', '全身']),
                fullBodySFWBack: designField(fields, ['下半身SFW背面', '下半身背面', '全身背面']),
                upperBodyNSFW: designField(fields, ['上半身NSFW']),
                upperBodyNSFWBack: designField(fields, ['上半身NSFW背面']),
                fullBodyNSFW: designField(fields, ['下半身NSFW']),
                fullBodyNSFWBack: designField(fields, ['下半身NSFW背面']),
            });
        }
    }
    if (characters.length && outfits.length) {
        characters[0].matchedOutfits = [outfits[0]];
    }
    return characters.length || outfits.length ? { characters, outfits } : null;
}

function buildOriginalCharDesignText(data, meta) {
    const outfit = data?.outfit && typeof data.outfit === 'object' ? data.outfit : {};
    const nameCN = asString(data?.nameCN || meta?.displayName, '当前角色');
    const nameEN = asString(data?.nameEN || englishAliasFromValues([...(meta?.requestNames || []), ...(meta?.currentNames || []), meta?.displayName]), 'Current Character');
    const outfitNameCN = asString(outfit.nameCN, '默认参考服装');
    const outfitNameEN = asString(outfit.nameEN);
    return [
        '<人物>',
        originalDesignLine('中文名称', nameCN),
        originalDesignLine('英文名称', nameEN),
        originalDesignLine('角色特征', data?.characterTraits),
        originalDesignLine('五官外貌', data?.facialFeatures),
        originalDesignLine('五官外貌背面', data?.facialFeaturesBack),
        originalDesignLine('上半身SFW', data?.upperBodySFW),
        originalDesignLine('上半身SFW背面', data?.upperBodySFWBack),
        originalDesignLine('下半身SFW', data?.fullBodySFW),
        originalDesignLine('下半身SFW背面', data?.fullBodySFWBack),
        originalDesignLine('上半身NSFW', data?.upperBodyNSFW),
        originalDesignLine('上半身NSFW背面', data?.upperBodyNSFWBack),
        originalDesignLine('下半身NSFW', data?.fullBodyNSFW),
        originalDesignLine('下半身NSFW背面', data?.fullBodyNSFWBack),
        '</人物>',
        '<服装>',
        originalDesignLine('中文名称', outfitNameCN),
        originalDesignLine('英文名称', outfitNameEN),
        originalDesignLine('归属人', nameCN),
        originalDesignLine('上半身', outfit.upperBody),
        originalDesignLine('上半身背面', outfit.upperBodyBack),
        originalDesignLine('下半身', outfit.fullBody),
        originalDesignLine('下半身背面', outfit.fullBodyBack),
        '</服装>',
    ].join('\n');
}

function parseOriginalCharDesignText(value) {
    const text = stripReasoningBlocks(value);
    if (!text) {
        return null;
    }
    const flexibleParsed = parseFlexibleOriginalDesignText(text);
    let legacyParsed = null;
    try {
        const parsed = extractCharacterAndOutfitTags(text);
        const characters = Array.isArray(parsed?.characters) ? parsed.characters : [];
        const outfits = Array.isArray(parsed?.outfits) ? parsed.outfits : [];
        legacyParsed = characters.length || outfits.length ? { characters, outfits } : null;
    } catch (error) {
        console.warn('[st-chatu8] Failed to parse original character design text:', error);
    }
    return mergeParsedDesigns(legacyParsed, flexibleParsed);
}

function selectParsedCharacter(parsed, meta) {
    const characters = Array.isArray(parsed?.characters) ? parsed.characters : [];
    if (!characters.length) {
        return null;
    }
    const keys = currentCharacterNameKeys(meta);
    if (!keys.length) {
        return characters[0];
    }
    return characters.find((character) => {
        const aliases = splitAliases(character?.nameCN, character?.nameEN);
        return aliases.some((alias) => currentCharacterAliasMatches(keys, alias));
    }) || characters[0];
}

function selectParsedOutfit(parsed, character) {
    const matched = Array.isArray(character?.matchedOutfits) ? character.matchedOutfits : [];
    if (matched.length) {
        return matched[0];
    }
    const outfits = Array.isArray(parsed?.outfits) ? parsed.outfits : [];
    return outfits[0] || {};
}

function promptFromOriginalDesign(data, meta, request, fallback = '') {
    const outfit = data?.outfit && typeof data.outfit === 'object' ? data.outfit : {};
    const englishName = englishAliasFromValues([
        data?.nameEN,
        ...(Array.isArray(meta?.requestNames) ? meta.requestNames : []),
        ...(Array.isArray(meta?.currentNames) ? meta.currentNames : []),
        meta?.displayName,
        request?.referenceCharacterName,
    ]) || 'the current character';
    return sanitizeEnglishPrompt([
        defaultEnglishReferencePrompt(englishName),
        data?.characterTraits,
        data?.facialFeatures,
        data?.upperBodySFW,
        data?.fullBodySFW,
        outfit.nameEN,
        outfit.style,
        outfit.color,
        outfit.material,
        outfit.upperBody,
        outfit.fullBody,
        outfit.extraPrompt,
        outfit.prompt,
    ].map(asString).filter(Boolean).join(', '), fallback || defaultEnglishReferencePrompt(englishName));
}

function originalCharDesignRoleName(meta, request) {
    const hasResolvedRequestName = Array.isArray(meta?.requestNames)
        && meta.requestNames.length > 0
        && meta?.requestCharacterSource !== 'unresolved';
    const candidates = uniqueStrings([
        ...(hasResolvedRequestName ? meta.requestNames : []),
        request?.referenceCharacterName,
        ...(hasResolvedRequestName ? [meta?.displayName] : []),
        ...(hasResolvedRequestName ? (Array.isArray(meta?.currentNames) ? meta.currentNames : []) : []),
    ]);
    for (const candidate of candidates) {
        const cleaned = cleanExtractedCharacterName(candidate) || asString(candidate);
        if (!cleaned || cleaned === '当前角色' || cleaned === 'current character') {
            continue;
        }
        if (isLooseCharacterNameCandidate(cleaned) || findKnownCharacterInCandidate(cleaned, collectKnownCharacterAliasRecords(meta?.context, meta?.character, meta?.currentNames))) {
            return cleaned;
        }
    }
    if (!hasResolvedRequestName && (asString(request?.id).startsWith('chatu8_anchor:') || asString(request?.change).includes('chatu8_anchor'))) {
        return '新角色';
    }
    return asString(meta?.displayName, '当前角色');
}

function originalCharDesignPronoun(meta, request) {
    const source = [
        meta?.displayName,
        ...(Array.isArray(meta?.names) ? meta.names : []),
        request?.debugFramePrompt,
        request?.debugSourceContext,
        request?.prompt,
        meta?.cardText,
    ].map(asString).filter(Boolean).join('\n');
    if (/(?:她|女性|女人|女孩|少女|女童|女主|小姐|姑娘|女仆|公主|母亲|姐姐|妹妹|妻子|女儿)/.test(source)) {
        return '她';
    }
    if (/(?:他|男性|男人|男孩|少年|男童|男主|先生|公子|父亲|哥哥|弟弟|丈夫|儿子)/.test(source)) {
        return '他';
    }
    return '其';
}

function originalCharDesignUserDemand(meta, request) {
    const roleName = originalCharDesignRoleName(meta, request);
    const pronoun = originalCharDesignPronoun(meta, request);
    return `生成${roleName}的形象以及为${pronoun}设计一套初始服装`;
}

function bootstrapDataFromParsedDesign(parsed, meta, request, fallback) {
    const character = selectParsedCharacter(parsed, meta);
    if (!character) {
        return {};
    }
    const outfit = selectParsedOutfit(parsed, character);
    const data = {
        nameCN: asString(character.nameCN, fallback.nameCN || meta?.displayName),
        nameEN: asString(character.nameEN, fallback.nameEN || englishAliasFromValues([meta?.displayName])),
        characterTraits: asString(character.characterTraits, fallback.characterTraits),
        facialFeatures: asString(character.facialFeatures, fallback.facialFeatures),
        facialFeaturesBack: asString(character.facialFeaturesBack, fallback.facialFeaturesBack),
        upperBodySFW: asString(character.upperBodySFW, fallback.upperBodySFW),
        upperBodySFWBack: asString(character.upperBodySFWBack, fallback.upperBodySFWBack),
        fullBodySFW: asString(character.fullBodySFW, fallback.fullBodySFW),
        fullBodySFWBack: asString(character.fullBodySFWBack, fallback.fullBodySFWBack),
        upperBodyNSFW: asString(character.upperBodyNSFW, fallback.upperBodyNSFW),
        upperBodyNSFWBack: asString(character.upperBodyNSFWBack, fallback.upperBodyNSFWBack),
        fullBodyNSFW: asString(character.fullBodyNSFW, fallback.fullBodyNSFW),
        fullBodyNSFWBack: asString(character.fullBodyNSFWBack, fallback.fullBodyNSFWBack),
        outfit: {
            ...fallback.outfit,
            nameCN: asString(outfit.nameCN, fallback.outfit?.nameCN),
            nameEN: asString(outfit.nameEN, fallback.outfit?.nameEN),
            owner: asString(outfit.owner, character.nameCN || fallback.outfit?.owner),
            style: asString(outfit.style, fallback.outfit?.style),
            color: asString(outfit.color, fallback.outfit?.color),
            material: asString(outfit.material, fallback.outfit?.material),
            upperBody: asString(outfit.upperBody, fallback.outfit?.upperBody),
            upperBodyBack: asString(outfit.upperBodyBack, fallback.outfit?.upperBodyBack),
            fullBody: asString(outfit.fullBody, fallback.outfit?.fullBody),
            fullBodyBack: asString(outfit.fullBodyBack, fallback.outfit?.fullBodyBack),
        },
    };
    data.referencePromptEN = promptFromOriginalDesign(data, meta, request, fallback.referencePromptEN);
    return data;
}

function englishAliasFromValues(values) {
    for (const value of values || []) {
        for (const alias of splitAliases(value)) {
            if (alias && !containsCjk(alias) && /^[A-Za-z0-9 _.'\-]+$/.test(alias)) {
                return alias;
            }
        }
    }
    return '';
}

function isActionOrClothingPhrase(value) {
    const text = asString(value);
    const compact = text.replace(/\s+/g, '');
    if (!compact) {
        return false;
    }
    if (/^(?:穿|换|换上|换成|身穿|穿着|拿着|坐|站|躺|看|笑|哭|跑|走|去|在|做|摆)/.test(compact)) {
        return true;
    }
    if (/(?:制服|校服|军服|警服|私服|衣服|服装|套装|上衣|外套|衬衫|卫衣|毛衣|裙|裤|袜|鞋|靴|帽|披风|斗篷|盔甲|铠甲|和服|旗袍|礼服|泳装|睡衣|女仆装|围裙|领带|领结|手套)/.test(compact)) {
        return true;
    }
    return /^(?:wear(?:ing)?|dress(?:ed)?|outfit|clothing|uniform|school uniform|change clothes|put on)\b/i.test(text);
}

function isDescriptiveCharacterFragment(value) {
    const text = asString(value);
    if (!text) {
        return true;
    }
    if (isActionOrClothingPhrase(text)) {
        return true;
    }
    if (/^(?:female|male|woman|women|man|men|girl|girls|boy|boys|subject|character|unknown|none|n\/a)$/i.test(text)) {
        return true;
    }
    return /(?:\d+\s*岁|[一二三四五六七八九十百零〇两]+\s*岁|女童|男童|少女|少年|成年|成人|女子|女性|女人|美女|美人|仙子|修仙者|角色|人物|主体|气质|形象|人设|设定|风格|氛围|外貌|特征|身穿|穿着|服装|衣|裙|袍|衫|赤足|足踝|头发|发色|青丝|长发|短发|黑发|白发|银发|金发|蓝发|眼睛|眼眸|瞳|赤眸|紫眸|肤|身材|身段|曲线|体型|姿势|表情|背景|场景|镜头|水蓝|长裙|湿透|凌空|披散|鳞片|dress|robe|skirt|hair|eyes|body|pose|clothing|background|scene|angle)/i.test(text);
}

function cleanExtractedCharacterName(value) {
    let text = asString(value);
    if (!text) {
        return '';
    }
    text = text.split(/\s+(?:Type|Subject|Highlight|Angle|Character|Pose\s*&\s*Action|Pose|Action|Clothing|Extra\s+Details|Environment|Scene|Background)\s*[:\uFF1A]/i)[0];
    const segments = text.split(/[\uFF0C,;\uFF1B\u3002.\n\r]/)
        .map((segment) => segment.replace(/^(?:subject\s*[:\uFF1A]?\s*)?(?:female|male|woman|man|girl|boy)\b\s*[:\uFF1A\-]?\s*/i, '').trim())
        .filter(Boolean);
    text = segments.find((segment) => containsCjk(segment) && !isDescriptiveCharacterFragment(segment) && segment.length <= 12)
        || segments.find((segment) => !isDescriptiveCharacterFragment(segment))
        || '';
    text = text.replace(/^[\s:\uFF1A\-]+|[\s:\uFF1A\-]+$/g, '');
    if (isDescriptiveCharacterFragment(text)) {
        return '';
    }
    return text.length >= 2 && text.length <= 80 ? text : '';
}

function extractContextCharacterNames(text) {
    const source = asString(text);
    if (!source) {
        return [];
    }
    const names = [];
    const pattern = /(?:^|[\s\n\r])(?:Character|角色|人物|当前角色|主角)\s*[:\uFF1A]\s*([^\n\r]+)/gi;
    for (const match of source.matchAll(pattern)) {
        const name = cleanExtractedCharacterName(match[1]);
        if (name) {
            names.push(name);
        }
    }
    return uniqueStrings(names);
}

function requestCharacterNames(request) {
    const text = [
        request?.debugSourceContext,
        request?.sourceContext,
        request?.context,
        request?.prompt,
        request?.debugPromptRaw,
    ].map(asString).filter(Boolean).join('\n');
    return extractContextCharacterNames(text);
}

function fileSafeName(value) {
    return (asString(value) || 'character')
        .replace(/[\\/:*?"<>|]+/g, '_')
        .replace(/\s+/g, '_')
        .slice(0, 60) || 'character';
}

function getCharacterFromContext(context) {
    const chid = context?.characterId ?? context?.this_chid ?? (typeof window !== 'undefined' ? window.this_chid : undefined);
    const characters = context?.characters || (typeof window !== 'undefined' ? window.characters : null);
    if (!characters || chid == null) {
        return context?.character || context?.currentCharacter || null;
    }
    return Array.isArray(characters) ? characters[Number(chid)] : characters[chid];
}

function hasCurrentCharacter(context, character) {
    const chid = context?.characterId ?? context?.this_chid ?? (typeof window !== 'undefined' ? window.this_chid : undefined);
    const hasValidId = chid !== undefined && chid !== null && String(chid).trim() !== '' && Number(chid) >= 0;
    return hasValidId && Boolean(asString(character?.name || character?.avatar || context?.name2 || context?.characterName));
}

function collectCurrentNames(context, character) {
    const names = new Set();
    const add = (value) => {
        const text = asString(value);
        if (text) {
            names.add(text);
        }
    };
    add(context?.name2);
    add(context?.characterName);
    add(context?.character?.name);
    add(context?.currentCharacter?.name);
    add(character?.name);
    add(asString(character?.avatar).replace(/\.[^/.\\]+$/, ''));
    if (typeof window !== 'undefined') {
        add(window.name2);
    }
    return Array.from(names);
}

function collectKnownCharacterAliasRecords(context, character, currentNames = []) {
    const records = [];
    const seen = new Set();
    const add = (displayName, alias, source, priority) => {
        const text = asString(alias);
        const key = normalizeName(text);
        if (!text || !key || seen.has(`${source}:${key}`)) {
            return;
        }
        seen.add(`${source}:${key}`);
        records.push({
            displayName: asString(displayName) || text,
            alias: text,
            key,
            source,
            priority,
        });
    };

    const currentDisplay = currentNames.find(Boolean);
    for (const name of currentNames) {
        for (const alias of splitAliases(name)) {
            add(currentDisplay || alias, alias, 'current_character', 0);
        }
    }

    const presets = settings().characterPresets || {};
    if (presets && typeof presets === 'object' && !Array.isArray(presets)) {
        for (const [presetId, preset] of Object.entries(presets)) {
            if (!preset) {
                continue;
            }
            const display = splitAliases(preset?.nameCN, preset?.nameEN, presetId)[0] || presetId;
            for (const alias of splitAliases(presetId, preset?.nameCN, preset?.nameEN)) {
                add(display, alias, 'character_preset', 1);
            }
        }
    }

    if (character && typeof character === 'object') {
        const display = asString(character.name || context?.name2 || currentDisplay);
        for (const alias of splitAliases(character.name, character.avatar, character?.data?.name)) {
            add(display || alias, alias.replace(/\.[^/.\\]+$/, ''), 'current_character', 0);
        }
    }

    return records.sort((left, right) => left.priority - right.priority || right.alias.length - left.alias.length);
}

function extractReferenceFieldCandidates(text) {
    const source = asString(text);
    if (!source) {
        return [];
    }
    const candidates = [];
    const pattern = /(?:^|[\s\n\r])(?:Character|\u89d2\u8272|\u4eba\u7269|\u5f53\u524d\u89d2\u8272|\u4e3b\u89d2)\s*[:\uFF1A]\s*([^\n\r]+)/gi;
    for (const match of source.matchAll(pattern)) {
        const candidate = cleanExtractedCharacterName(match[1]);
        if (candidate) {
            candidates.push(candidate);
        }
    }
    return uniqueStrings(candidates);
}

function extractSubjectFieldCandidates(text) {
    const source = asString(text);
    if (!source) {
        return [];
    }
    const candidates = [];
    const pattern = /(?:^|[\s\n\r])(?:Subject|\u4e3b\u4f53)\s*[:\uFF1A]?\s*([^\n\r]+)/gi;
    for (const match of source.matchAll(pattern)) {
        const candidate = cleanExtractedCharacterName(match[1]);
        if (candidate) {
            candidates.push(candidate);
        }
    }
    return uniqueStrings(candidates);
}

function findKnownCharacterInCandidate(candidate, aliases) {
    const clean = cleanExtractedCharacterName(candidate);
    const key = normalizeName(clean);
    if (!clean || !key) {
        return null;
    }
    const exact = aliases.find((record) => record.key === key);
    if (exact) {
        return exact;
    }
    const contained = aliases
        .map((record) => ({ record, index: findAliasIndex(clean, record.alias) }))
        .filter((match) => match.index >= 0)
        .sort((left, right) => left.index - right.index || right.record.alias.length - left.record.alias.length);
    return contained[0]?.record || null;
}

function findKnownCharacterInText(text, aliases) {
    const source = asString(text);
    if (!source) {
        return null;
    }
    const matches = aliases
        .map((record) => ({ record, index: findAliasIndex(source, record.alias) }))
        .filter((match) => match.index >= 0)
        .sort((left, right) => left.index - right.index || left.record.priority - right.record.priority || right.record.alias.length - left.record.alias.length);
    return matches[0]?.record || null;
}

function isLooseCharacterNameCandidate(value) {
    const text = cleanExtractedCharacterName(value);
    if (!text) {
        return false;
    }
    if (isDescriptiveCharacterFragment(text)) {
        return false;
    }
    if (containsCjk(text)) {
        if (text.length > 12 || /\s/.test(text)) {
            return false;
        }
        return !/[\u8eab\u8eaf\u6bdb\u6bef\u8737\u7761\u8eba\u5367\u5750\u7ad9\u770b\u7b11\u54ed\u9886\u53e3\u540e\u9888\u9501\u9aa8\u8170\u81c0\u80f8\u817f\u624b\u6307\u59ff\u52bf\u8868\u60c5\u80cc\u666f\u573a\u666f\u8f66\u53a2\u623f\u95f4]/.test(text);
    }
    return /^[A-Za-z][A-Za-z0-9 .'\-]{1,48}$/.test(text) && text.split(/\s+/).length <= 4;
}

function resolveRequestCharacterNames(request, context, character, currentNames = []) {
    const aliases = collectKnownCharacterAliasRecords(context, character, currentNames);
    const explicitRequestName = asString(
        request?.referenceCharacterName ||
        request?.reference_character_name ||
        request?.characterName ||
        request?.character_name,
    );
    const sourceText = [
        request?.debugFramePrompt,
        request?.debugSourceContext,
        request?.sourceContext,
        request?.context,
        request?.prompt,
        request?.debugPromptRaw,
    ].map(asString).filter(Boolean).join('\n');

    if (explicitRequestName) {
        const known = findKnownCharacterInCandidate(explicitRequestName, aliases);
        if (known) {
            return {
                names: uniqueStrings([known.displayName, explicitRequestName]),
                source: request?.referenceCharacterSource || `${known.source}:request`,
                candidates: [explicitRequestName],
            };
        }
        if (isLooseCharacterNameCandidate(explicitRequestName)) {
            return {
                names: [cleanExtractedCharacterName(explicitRequestName)],
                source: request?.referenceCharacterSource || 'explicit_request',
                candidates: [explicitRequestName],
            };
        }
    }

    const explicitFields = extractReferenceFieldCandidates(sourceText);
    for (const candidate of explicitFields) {
        const known = findKnownCharacterInCandidate(candidate, aliases);
        if (known) {
            return {
                names: uniqueStrings([known.displayName, candidate]),
                source: `${known.source}:character_field`,
                candidates: explicitFields,
            };
        }
    }

    const knownInText = findKnownCharacterInText(sourceText, aliases);
    if (knownInText) {
        return {
            names: uniqueStrings([knownInText.displayName, knownInText.alias]),
            source: `${knownInText.source}:text_match`,
            candidates: explicitFields,
        };
    }

    const subjectFields = extractSubjectFieldCandidates(sourceText);
    for (const candidate of subjectFields) {
        const known = findKnownCharacterInCandidate(candidate, aliases);
        if (known) {
            return {
                names: uniqueStrings([known.displayName, candidate]),
                source: `${known.source}:subject_field`,
                candidates: subjectFields,
            };
        }
    }

    if (!currentNames.length) {
        for (const candidate of explicitFields) {
            if (isLooseCharacterNameCandidate(candidate)) {
                return {
                    names: [cleanExtractedCharacterName(candidate)],
                    source: 'explicit_character_field',
                    candidates: explicitFields,
                };
            }
        }
    }

    return {
        names: [],
        source: 'unresolved',
        candidates: uniqueStrings([...explicitFields, ...subjectFields]),
    };
}

function addWorldBookName(names, value) {
    if (Array.isArray(value)) {
        value.forEach((item) => addWorldBookName(names, item));
        return;
    }
    const text = asString(value);
    if (!text) {
        return;
    }
    try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
            parsed.forEach((item) => addWorldBookName(names, item));
            return;
        }
    } catch (_error) {
        // Plain world names are expected here.
    }
    names.add(text);
}

function characterLoreFileName(context, character) {
    return asString(character?.avatar || context?.character?.avatar || context?.currentCharacter?.avatar).replace(/\.[^/.\\]+$/, '');
}

function collectWorldBookNames(context, character) {
    const names = new Set();
    addWorldBookName(names, selected_world_info);
    addWorldBookName(names, chat_metadata?.[WORLD_INFO_METADATA_KEY]);
    addWorldBookName(names, context?.chat_metadata?.[WORLD_INFO_METADATA_KEY]);
    addWorldBookName(names, context?.chatMetadata?.[WORLD_INFO_METADATA_KEY]);
    addWorldBookName(names, character?.data?.extensions?.world);
    addWorldBookName(names, character?.extensions?.world);

    const fileName = characterLoreFileName(context, character);
    const extraCharLore = Array.isArray(world_info?.charLore)
        ? world_info.charLore.find((item) => asString(item?.name) === fileName || asString(item?.name) === asString(character?.avatar))
        : null;
    addWorldBookName(names, extraCharLore?.extraBooks);

    return Array.from(names)
        .map(asString)
        .filter((name, index, array) => name && array.indexOf(name) === index)
        .filter((name) => !Array.isArray(world_names) || !world_names.length || world_names.includes(name))
        .slice(0, 8);
}

function worldBookEntries(data) {
    const entries = data?.entries;
    if (Array.isArray(entries)) {
        return entries;
    }
    if (entries && typeof entries === 'object') {
        return Object.values(entries);
    }
    return [];
}

function worldBookDataToText(data, limit = 7000) {
    const chunks = [];
    for (const entry of worldBookEntries(data)) {
        if (!entry || entry.disable === true) {
            continue;
        }
        const key = Array.isArray(entry.key) ? entry.key.map(asString).filter(Boolean).join(', ') : asString(entry.key);
        const keySecondary = Array.isArray(entry.keysecondary) ? entry.keysecondary.map(asString).filter(Boolean).join(', ') : asString(entry.keysecondary);
        const comment = asString(entry.comment);
        const content = asString(entry.content).slice(0, 1600);
        const block = [
            comment ? `comment: ${comment}` : '',
            key ? `keys: ${key}` : '',
            keySecondary ? `secondary_keys: ${keySecondary}` : '',
            content,
        ].filter(Boolean).join('\n');
        if (block) {
            chunks.push(block);
        }
        if (chunks.join('\n\n').length >= limit) {
            break;
        }
    }
    return chunks.join('\n\n').slice(0, limit);
}

async function collectWorldBookText(context, character) {
    const names = collectWorldBookNames(context, character);
    if (!names.length) {
        return '';
    }
    const blocks = [];
    for (const name of names) {
        try {
            const data = await loadWorldInfo(name);
            const text = worldBookDataToText(data);
            blocks.push(text ? `## ${name}\n${text}` : `## ${name}`);
        } catch (error) {
            console.warn('[st-chatu8] Failed to load world/lorebook for reference bootstrap:', name, error);
            blocks.push(`## ${name}`);
        }
    }
    return blocks.join('\n\n').slice(0, 12000);
}

async function currentCharacterMeta(request = {}) {
    const context = typeof getContext === 'function' ? getContext() : {};
    const character = getCharacterFromContext(context) || {};
    const currentNames = collectCurrentNames(context, character);
    const requestCharacter = resolveRequestCharacterNames(request, context, character, currentNames);
    const contextNames = requestCharacter.names;
    const stHasCurrentCharacter = hasCurrentCharacter(context, character);
    const hasRequestCharacter = contextNames.length > 0;
    const names = uniqueStrings([...(hasRequestCharacter ? contextNames : (stHasCurrentCharacter ? currentNames : [])), ...currentNames, ...contextNames]);
    const displayName = (hasRequestCharacter ? contextNames[0] : (stHasCurrentCharacter ? currentNames[0] : '')) || names[0] || '当前角色';
    const data = character.data && typeof character.data === 'object' ? character.data : character;
    const textFields = [
        ['name', displayName],
        ['description', data.description],
        ['personality', data.personality],
        ['scenario', data.scenario],
        ['first_mes', data.first_mes],
        ['mes_example', data.mes_example],
        ['creator_notes', data.creator_notes || data.creatorcomment],
        ['system_prompt', data.system_prompt],
        ['post_history_instructions', data.post_history_instructions],
    ];
    const cardText = textFields
        .map(([label, value]) => asString(value) ? `## ${label}\n${asString(value)}` : '')
        .filter(Boolean)
        .join('\n\n')
        .slice(0, 12000);
    const worldBookText = await collectWorldBookText(context, character);
    return {
        context,
        character,
        names,
        requestNames: contextNames,
        requestCharacterSource: requestCharacter.source,
        requestCharacterCandidates: requestCharacter.candidates,
        currentNames,
        displayName,
        cardText,
        worldBookText,
        hasCurrentCharacter: stHasCurrentCharacter || hasRequestCharacter,
    };
}

function presetReferencePath(preset) {
    const raw = preset?.comfyRefImagePath || preset?.comfyRefImagePaths;
    if (Array.isArray(raw)) {
        return raw.map(asString).find(Boolean) || '';
    }
    if (raw && typeof raw === 'object') {
        return asString(raw.path || raw.image || raw.value);
    }
    return asString(raw);
}

function presetAliases(preset, presetId) {
    return splitAliases(presetId, preset?.nameCN, preset?.nameEN);
}

function currentCharacterNameKeys(meta) {
    const preferred = Array.isArray(meta?.requestNames) && meta.requestNames.length ? meta.requestNames : meta?.names;
    return (preferred || []).map(normalizeName).filter((name) => name && name.length >= 2);
}

function currentCharacterAliasMatches(currentNames, alias) {
    const normalized = normalizeName(alias);
    return Boolean(normalized && normalized.length >= 2 && currentNames.includes(normalized));
}

function findCurrentCharacterPreset(meta, requireReference = false) {
    const data = settings();
    const presets = data.characterPresets || {};
    const currentNames = currentCharacterNameKeys(meta);
    if (!currentNames.length) {
        return null;
    }
    for (const [presetId, preset] of Object.entries(presets)) {
        if (!preset) {
            continue;
        }
        const aliases = presetAliases(preset, presetId);
        const matched = aliases.some((alias) => currentCharacterAliasMatches(currentNames, alias));
        if (!matched) {
            continue;
        }
        const path = presetReferencePath(preset);
        if (requireReference && !path) {
            continue;
        }
        return { presetId, preset, path };
    }
    return null;
}

function collectCandidateReferencePaths(request, meta) {
    const promptText = [
        request?.prompt,
        request?.debugPromptRaw,
        request?.debugPromptOptimized,
        request?.debugPromptFinal,
        request?.debugSourceContext,
        meta?.names?.join('\n'),
    ].map(asString).filter(Boolean).join('\n');
    const refs = resolveComfyCharacterReferences(promptText);
    const paths = [];
    for (const ref of Array.isArray(refs) ? refs : []) {
        const path = asString(ref?.path);
        if (path) {
            paths.push(path);
        }
    }
    const current = findCurrentCharacterPreset(meta, true);
    if (current?.path) {
        paths.push(current.path);
    }
    return Array.from(new Set(paths));
}

function comfyInputFileNameFromPath(value) {
    return asString(value).split(/[\\/]/).filter(Boolean).pop() || '';
}

async function comfyInputImageExists(path) {
    const fileName = comfyInputFileNameFromPath(path);
    const url = currentComfyUrl();
    if (!fileName || !url) {
        return false;
    }
    const params = new URLSearchParams();
    params.set('filename', fileName);
    params.set('type', 'input');
    try {
        const response = await fetch(`${url}/view?${params.toString()}`, { method: 'GET' });
        return response.ok;
    } catch (_error) {
        return false;
    }
}

function referenceBootstrapGate(request, meta) {
    const data = settings();
    const adapter = asString(request?.workflowAdapter);
    const explicitDisabled = isAutoReferenceBootstrapExplicitlyDisabled(data);
    const settingEnabled = isAutoReferenceBootstrapEnabled(data);
    const requiredByReferenceWorkflow = adapter === 'flux2-klein-reference';
    const anchorRequest = asString(request?.change).includes('chatu8_anchor') || asString(request?.id).startsWith('chatu8_anchor:');
    const hasCharacter = meta?.hasCurrentCharacter === true;
    return {
        allowed: hasCharacter && !explicitDisabled && (settingEnabled || requiredByReferenceWorkflow),
        adapter,
        anchor_request: anchorRequest,
        required_by_reference_workflow: requiredByReferenceWorkflow,
        setting_enabled: data.comfyAutoReferenceBootstrapEnabled === true,
        explicit_enabled: data.comfyAutoReferenceBootstrapExplicitlyEnabled === true,
        explicit_disabled: explicitDisabled,
        migrated_off_version: asString(data.comfyAutoReferenceBootstrapMigratedOffVersion),
        has_character: hasCharacter,
        character: meta?.displayName || '',
        request_names: Array.isArray(meta?.requestNames) ? meta.requestNames : [],
        request_character_source: meta?.requestCharacterSource || '',
        request_character_candidates: Array.isArray(meta?.requestCharacterCandidates) ? meta.requestCharacterCandidates : [],
        current_names: Array.isArray(meta?.currentNames) ? meta.currentNames : [],
        bootstrap_worker: bootstrapWorkerId(),
    };
}

function referenceBootstrapSkipReason(gate) {
    if (!gate?.has_character) {
        return 'no_character';
    }
    if (gate?.explicit_disabled) {
        return 'explicitly_disabled';
    }
    if (!gate?.setting_enabled && !gate?.explicit_enabled && !gate?.required_by_reference_workflow) {
        return 'setting_disabled';
    }
    return 'not_required';
}

async function getReferenceProblem(request, meta, gate = referenceBootstrapGate(request, meta)) {
    if (!gate?.allowed) {
        return null;
    }
    const currentPreset = findCurrentCharacterPreset(meta, false);
    if (!currentPreset) {
        return { reason: 'new_character_without_reference', paths: [], gate };
    }
    const paths = currentPreset.path ? [currentPreset.path] : [];
    if (!paths.length) {
        return { reason: 'missing', paths: [], preset_id: currentPreset.presetId, gate };
    }
    for (const path of paths) {
        if (await comfyInputImageExists(path)) {
            return null;
        }
    }
    return { reason: 'invalid_or_unavailable', paths, preset_id: currentPreset.presetId, gate };
}

function parseJsonObject(text) {
    const cleaned = asString(text)
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```$/i, '')
        .trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    return JSON.parse(match ? match[0] : cleaned);
}

function localBootstrapData(meta, request, warning = '') {
    const name = originalCharDesignRoleName(meta, request) || meta.displayName || 'current character';
    const englishName = englishAliasFromValues([
        ...(Array.isArray(meta.requestNames) ? meta.requestNames : []),
        ...(Array.isArray(meta.currentNames) ? meta.currentNames : []),
        meta.displayName,
        request?.referenceCharacterName,
    ]) || 'the current character';
    const promptEN = [
        defaultEnglishReferencePrompt(englishName),
    ].filter(Boolean).join(', ');
    const fallback = {
        nameCN: /[\u4e00-\u9fff]/.test(name) ? name : '',
        nameEN: englishName,
        characterTraits: '',
        facialFeatures: '',
        facialFeaturesBack: '',
        upperBodySFW: '',
        upperBodySFWBack: '',
        fullBodySFW: '',
        fullBodySFWBack: '',
        upperBodyNSFW: '',
        upperBodyNSFWBack: '',
        fullBodyNSFW: '',
        fullBodyNSFWBack: '',
        negative: REFERENCE_BOOTSTRAP_NEGATIVE_PROMPT,
        outfit: {
            nameCN: '默认参考服装',
            nameEN: '',
            style: '',
            color: '',
            material: '',
            upperBody: '',
            upperBodyBack: '',
            fullBody: '',
            fullBodyBack: '',
        },
        referencePromptCN: `为 ${name} 生成一张正面全身角色参考图，姿势自然，背景干净。`,
        referencePromptEN: sanitizeEnglishPrompt(promptEN, defaultEnglishReferencePrompt(englishName)),
        warnings: warning
            ? [`LLM 未成功返回可用角色/服装设定，已使用本地兜底提示词：${warning}`]
            : ['LLM 未成功返回可用角色/服装设定，已使用本地兜底提示词。'],
    };
    fallback.stChatu8DesignText = buildOriginalCharDesignText(fallback, meta);
    fallback.referencePromptEN = promptFromOriginalDesign(fallback, meta, request, fallback.referencePromptEN);
    return fallback;
}

function normalizeBootstrapData(value, meta, request) {
    const fallback = localBootstrapData(meta, request);
    const data = value && typeof value === 'object' ? value : {};
    const outfit = data.outfit && typeof data.outfit === 'object' ? data.outfit : {};
    const designText = asString(
        data.stChatu8DesignText ||
        data.originalCharDesignText ||
        data.characterDesignText ||
        data.designText ||
        data.tags ||
        data.raw,
    );
    const parsedDesign = parseOriginalCharDesignText(designText);
    const parsedData = parsedDesign ? bootstrapDataFromParsedDesign(parsedDesign, meta, request, fallback) : {};
    const flatData = Object.fromEntries(Object.entries(data).map(([key, item]) => [key, Array.isArray(item) || typeof item === 'object' ? item : asString(item)]));
    const merged = {
        ...fallback,
        ...flatData,
        ...parsedData,
        outfit: {
            ...fallback.outfit,
            ...Object.fromEntries(Object.entries(outfit).map(([key, item]) => [key, asString(item)])),
            ...(parsedData.outfit || {}),
        },
    };
    const llmPromptEN = asString(data.referencePromptEN || data.reference_prompt_en || data.promptEN || data.prompt_en || parsedData.referencePromptEN);
    merged.referencePromptEN = sanitizeEnglishPrompt(llmPromptEN, fallback.referencePromptEN) || fallback.referencePromptEN;
    merged.referencePromptCN = asString(data.referencePromptCN || data.reference_prompt_cn || data.promptCN || data.prompt_cn) || fallback.referencePromptCN;
    merged.warnings = Array.isArray(data.warnings) ? data.warnings.map(asString).filter(Boolean) : fallback.warnings;
    merged.stChatu8DesignText = designText && parsedDesign ? designText : buildOriginalCharDesignText(merged, meta);
    merged.originalCharDesignParsed = Boolean(parsedDesign);
    return merged;
}

function normalizeBootstrapOutput(raw, meta, request) {
    const text = asString(raw);
    try {
        return normalizeBootstrapData(parseJsonObject(text), meta, request);
    } catch (jsonError) {
        const parsedDesign = parseOriginalCharDesignText(text);
        if (!parsedDesign) {
            throw jsonError;
        }
        return normalizeBootstrapData({ stChatu8DesignText: text }, meta, request);
    }
}

function updateBootstrapDataFromDesignText(bootstrapData, designText, meta, request) {
    const text = asString(designText);
    if (!text) {
        return false;
    }
    const parsedDesign = parseOriginalCharDesignText(text);
    if (!parsedDesign) {
        return false;
    }
    const parsedData = bootstrapDataFromParsedDesign(parsedDesign, meta, request, bootstrapData);
    Object.assign(bootstrapData, parsedData, {
        stChatu8DesignText: text,
        originalCharDesignParsed: true,
    });
    bootstrapData.outfit = {
        ...(bootstrapData.outfit || {}),
        ...(parsedData.outfit || {}),
    };
    bootstrapData.referencePromptEN = promptFromOriginalDesign(bootstrapData, meta, request, bootstrapData.referencePromptEN);
    return true;
}

function buildBootstrapLlmPrompt(meta, request) {
    const configuredSystemPrompt = characterReferenceSystemPrompt();
    const modelProfileText = referencePromptModelProfileText();
    const designRoleName = originalCharDesignRoleName(meta, request);
    const designUserDemand = originalCharDesignUserDemand(meta, request);
    const payload = {
        task: 'run_original_st_chatu8_character_outfit_design_first_step_for_missing_reference_image',
        output: 'strict_json_only',
        required_keys: [
            'stChatu8DesignText',
            'nameCN', 'nameEN', 'characterTraits', 'facialFeatures', 'facialFeaturesBack',
            'upperBodySFW', 'upperBodySFWBack', 'fullBodySFW', 'fullBodySFWBack',
            'upperBodyNSFW', 'upperBodyNSFWBack', 'fullBodyNSFW', 'fullBodyNSFWBack',
            'negative', 'outfit', 'referencePromptCN', 'referencePromptEN', 'warnings',
        ],
        outfit_required_keys: ['nameCN', 'nameEN', 'upperBody', 'upperBodyBack', 'fullBody', 'fullBodyBack'],
        original_st_chatu8_design_text_format: [
            '<人物>',
            '中文名称: ...',
            '英文名称: ...',
            '角色特征: ...',
            '五官外貌: ...',
            '五官外貌背面: ...',
            '上半身SFW: ...',
            '上半身SFW背面: ...',
            '下半身SFW: ...',
            '下半身SFW背面: ...',
            '上半身NSFW: ...',
            '上半身NSFW背面: ...',
            '下半身NSFW: ...',
            '下半身NSFW背面: ...',
            '</人物>',
            '<服装>',
            '中文名称: ...',
            '英文名称: ...',
            '归属人: 人物中文名称',
            '上半身: ...',
            '上半身背面: ...',
            '下半身: ...',
            '下半身背面: ...',
            '</服装>',
        ].join('\n'),
        policy: {
            infer_only_from_card_scene_and_world_book: true,
            do_not_claim_canon_if_unsure: true,
            stChatu8DesignText: 'Must be exactly the original plugin character/outfit design block format above. Use <人物> and <服装>, not <角色>. Use the exact Chinese field labels.',
            nameCN: 'Must be the resolved character identity/name, never Subject, pose, clothing, body description, or scene text.',
            original_char_design_role_name: 'This is the resolved role name. It is the only source of truth for 中文名称/nameCN.',
            original_char_design_user_demand: 'This is the exact sentence that would be typed into the original plugin step-2 popup.',
            image_anchor_prompt: 'Auxiliary visual context only. Never use it as the role name or as the main generation demand.',
            referencePromptEN: 'English-only ComfyUI prompt, comma separated, suitable for a no-reference first image. Do not copy Chinese source text into this field. Do not write reference sheet, model sheet, turnaround, multiple views, split screen, or grid layout.',
            reference_image_goal: 'single sfw solo full-body front-view character portrait, one view only, clean background, stable clothing and facial traits',
        },
        original_char_design_role_name: designRoleName,
        original_char_design_user_demand: designUserDemand,
        current_character_names: meta.names,
        resolved_reference_character_source: meta.requestCharacterSource || '',
        resolved_reference_character_candidates: meta.requestCharacterCandidates || [],
        image_anchor_prompt: request?.prompt || '',
        image_anchor_frame_prompt: request?.debugFramePrompt || '',
        image_anchor_context: request?.debugSourceContext || '',
        character_card_text: meta.cardText || '',
        world_book_text: meta.worldBookText || '',
        current_comfy_reference_model_profile: modelProfileText,
        configured_character_reference_system_prompt: configuredSystemPrompt,
    };
    return [
        configuredSystemPrompt || '你是 SillyTavern 角色/服装设计助手。你必须按原插件“角色/服装设计”第一步的字段格式产出设定，并只输出严格 JSON，不要 Markdown。',
        modelProfileText,
        configuredSystemPrompt ? '如果上面的用户配置系统提示词和当前 ComfyUI 工作流模型规则冲突，以当前 ComfyUI 工作流模型规则为准。' : '',
        configuredSystemPrompt ? '必须遵守上面的用户配置系统提示词；同时只输出严格 JSON，不要 Markdown。' : '',
        '请根据角色卡和当前 image### 提示词，先生成原插件可解析的角色/服装设计块 stChatu8DesignText，再生成一条英文无参考图首图提示词。',
        `原插件第二步“输入生成需求”里应写入的内容是：${designUserDemand}`,
        `其中角色名是：${designRoleName}。角色命名和中文名称必须以这个角色名为准。`,
        'stChatu8DesignText 必须使用 <人物>/<服装> 标签和 Input JSON 里的精确中文字段名；不能使用 <角色>，不能省略中文名称。',
        'image_anchor_prompt / image_anchor_frame_prompt 只可作为外貌或服装参考线索，不能覆盖上面的角色名，也不要把场景、姿势、镜头写进角色名。',
        'referencePromptEN 必须只含英文逗号短语，不要 Type/Subject/Highlight 等中文设定字段名，也不要复制任何中文。',
        'referencePromptEN 必须生成单张正面全身立绘；禁止使用 reference sheet、character sheet、model sheet、turnaround、multiple views、split screen、grid layout、side view、back view 等会诱发三视图/多视角/拼图的词。',
        '如果角色卡没有明确写出外貌，请保守推断，并在 warnings 里说明。',
        '',
        'Input JSON:',
        JSON.stringify(payload, null, 2),
    ].join('\n');
}

async function executeBootstrapLlm(prompt, requestType = BOOTSTRAP_REQUEST_TYPE) {
    const id = `reference_bootstrap_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const eventName = `${requestType || BOOTSTRAP_REQUEST_TYPE}:${id}`;
    let latest = '';
    let eventPayload = null;
    const onResponse = (payload) => {
        if (!payload || payload.id !== id) {
            return;
        }
        eventPayload = payload;
        if (payload.result !== undefined) {
            latest = asString(payload.result);
        }
    };
    eventSource.on(eventName, onResponse);
    try {
        await executeTypedLLMRequest({ id, prompt }, requestType, eventName, (value) => {
            latest = asString(value);
        });
    } finally {
        eventSource.removeListener(eventName, onResponse);
    }
    if (eventPayload && eventPayload.success === false) {
        throw new Error(asString(eventPayload.result || eventPayload.error, '角色设定生成失败'));
    }
    return asString(eventPayload?.result || latest);
}

async function executeBootstrapLlmWithFallback(prompt, requestTypes) {
    const types = uniqueStrings(requestTypes).filter(Boolean);
    let lastError = null;
    for (const type of types.length ? types : [BOOTSTRAP_REQUEST_TYPE]) {
        try {
            return await executeBootstrapLlm(prompt, type);
        } catch (error) {
            lastError = error;
            console.warn('[st-chatu8] Reference bootstrap LLM request failed, trying next type:', type, error);
        }
    }
    throw lastError || new Error('Reference bootstrap LLM request failed.');
}

async function loadOriginalCharDesignFlowModules() {
    const [promptReq, worldbook, llmService, promptProcessor, characterGen] = await Promise.all([
        import('./promptReq.js'),
        import('./settings/worldbook.js'),
        import('./settings/llmService.js'),
        import('./promptProcessor.js'),
        import('./characterGen.js'),
    ]);
    const flow = {
        getElContext: promptReq.getElContext,
        processWorldBooksWithTrigger: promptReq.processWorldBooksWithTrigger,
        generateCharacterListText: worldbook.generateCharacterListText,
        generateOutfitEnableListText: worldbook.generateOutfitEnableListText,
        generateCommonCharacterListText: worldbook.generateCommonCharacterListText,
        buildPromptForRequestType: llmService.buildPromptForRequestType,
        getMergeOptionsForRequestType: llmService.getMergeOptionsForRequestType,
        mergeAdjacentMessages: promptProcessor.mergeAdjacentMessages,
        replaceAllPlaceholders: promptProcessor.replaceAllPlaceholders,
        LLM_CHAR_DESIGN: characterGen.LLM_CHAR_DESIGN,
    };
    const missing = [];
    if (typeof flow.buildPromptForRequestType !== 'function') {
        missing.push('buildPromptForRequestType');
    }
    if (typeof flow.LLM_CHAR_DESIGN !== 'function') {
        missing.push('LLM_CHAR_DESIGN');
    }
    if (missing.length) {
        throw new Error(`Original character design flow missing exports: ${missing.join(', ')}`);
    }
    return flow;
}

function normalizeOriginalPromptMessages(value) {
    if (Array.isArray(value)) {
        return value.filter(Boolean);
    }
    if (typeof value === 'string') {
        return value.trim() ? [{ role: 'user', content: value }] : [];
    }
    if (value && typeof value === 'object') {
        if (Array.isArray(value.messages)) {
            return normalizeOriginalPromptMessages(value.messages);
        }
        if (value.role || value.content) {
            return [value];
        }
        if (value.prompt) {
            return normalizeOriginalPromptMessages(value.prompt);
        }
    }
    return [];
}

async function callOriginalTextFactory(label, factory) {
    try {
        return asString(await factory());
    } catch (error) {
        console.warn(`[st-chatu8] Original character design ${label} failed:`, error);
        return '';
    }
}

function originalCharDesignContext(meta, request, flow) {
    let contextItems = [];
    try {
        const rawContext = typeof flow.getElContext === 'function' ? flow.getElContext() : [];
        contextItems = Array.isArray(rawContext)
            ? rawContext.map(asString).filter(Boolean)
            : [asString(rawContext)].filter(Boolean);
    } catch (error) {
        console.warn('[st-chatu8] Original character design getElContext failed:', error);
    }
    const fallbackBody = asString(request?.debugSourceContext || meta?.cardText || request?.prompt);
    if (!contextItems.length && fallbackBody) {
        contextItems = [fallbackBody];
    }
    const body = contextItems.length ? contextItems[contextItems.length - 1] : fallbackBody;
    const context = contextItems.length > 1 ? contextItems.slice(0, -1).join('\n') : '';
    return { contextItems, context, body };
}

async function buildOriginalCharDesignMessages(meta, request) {
    const flow = await loadOriginalCharDesignFlowModules();
    const roleName = originalCharDesignRoleName(meta, request);
    const demand = originalCharDesignUserDemand(meta, request);
    const { contextItems, context, body } = originalCharDesignContext(meta, request, flow);
    const worldBookContent = await callOriginalTextFactory('world book trigger', async () => {
        if (typeof flow.processWorldBooksWithTrigger !== 'function') {
            return '';
        }
        return await flow.processWorldBooksWithTrigger([...contextItems, demand]);
    });
    const [characterListText, outfitEnableListText, commonCharacterListText] = await Promise.all([
        callOriginalTextFactory('character list', async () => typeof flow.generateCharacterListText === 'function' ? await flow.generateCharacterListText() : ''),
        callOriginalTextFactory('outfit list', async () => typeof flow.generateOutfitEnableListText === 'function' ? await flow.generateOutfitEnableListText() : ''),
        callOriginalTextFactory('common character list', async () => typeof flow.generateCommonCharacterListText === 'function' ? await flow.generateCommonCharacterListText() : ''),
    ]);
    const seed = [demand, body].map(asString).filter(Boolean).join('\n');
    let messages = normalizeOriginalPromptMessages(flow.buildPromptForRequestType(BOOTSTRAP_REQUEST_TYPE, seed));
    if (!messages.length) {
        throw new Error('Original character design prompt builder returned no messages.');
    }
    const mergeOptions = typeof flow.getMergeOptionsForRequestType === 'function'
        ? flow.getMergeOptionsForRequestType(BOOTSTRAP_REQUEST_TYPE)
        : {};
    if (typeof flow.mergeAdjacentMessages === 'function') {
        messages = normalizeOriginalPromptMessages(flow.mergeAdjacentMessages(messages, mergeOptions || {}));
    }
    const variables = {
        context,
        body,
        worldBookContent,
        variables: {},
        userDemand: demand,
        characterListText,
        outfitEnableListText,
        commonCharacterListText,
    };
    if (typeof flow.replaceAllPlaceholders === 'function') {
        const replaced = await flow.replaceAllPlaceholders(messages, variables);
        messages = normalizeOriginalPromptMessages(replaced?.messages || replaced);
    }
    if (!messages.length) {
        throw new Error('Original character design placeholder replacement returned no messages.');
    }
    return { flow, messages, roleName, demand, variables };
}

async function executeOriginalCharDesignFlow(meta, request) {
    const built = await buildOriginalCharDesignMessages(meta, request);
    const response = await built.flow.LLM_CHAR_DESIGN(built.messages, { timeoutMs: 600000 });
    let raw = response;
    if (raw && typeof raw === 'object') {
        raw = raw.result ?? raw.text ?? raw.message ?? raw.content ?? raw.output ?? raw.response ?? raw;
        if (raw && typeof raw === 'object') {
            raw = JSON.stringify(raw);
        }
    }
    raw = asString(raw);
    if (!raw) {
        throw new Error('Original character design flow returned an empty response.');
    }
    return {
        raw,
        roleName: built.roleName,
        demand: built.demand,
        variables: built.variables,
    };
}

async function generateBootstrapData(meta, request) {
    let originalFlowError = null;
    try {
        const original = await executeOriginalCharDesignFlow(meta, request);
        const data = normalizeBootstrapOutput(original.raw, meta, request);
        data.originalCharDesignSubmittedBy = 'original_confirm_flow';
        data.originalCharDesignRoleName = original.roleName;
        data.originalCharDesignUserDemand = original.demand;
        return data;
    } catch (error) {
        originalFlowError = error;
        console.warn('[st-chatu8] Original character design confirm flow failed, using bootstrap prompt fallback:', error);
    }
    try {
        const raw = await executeBootstrapLlmWithFallback(
            buildBootstrapLlmPrompt(meta, request),
            [bootstrapGenerateRequestType(), BOOTSTRAP_REQUEST_TYPE],
        );
        const data = normalizeBootstrapOutput(raw, meta, request);
        data.originalCharDesignSubmittedBy = 'bootstrap_prompt_fallback';
        data.originalCharDesignRoleName = originalCharDesignRoleName(meta, request);
        data.originalCharDesignUserDemand = originalCharDesignUserDemand(meta, request);
        return data;
    } catch (error) {
        console.warn('[st-chatu8] Reference bootstrap LLM failed, using local fallback:', error);
        const reasons = [
            originalFlowError ? `original flow: ${originalFlowError?.message || originalFlowError}` : '',
            `bootstrap fallback: ${error?.message || error}`,
        ].filter(Boolean).join('; ');
        return localBootstrapData(meta, request, reasons);
    }
}

async function translatePromptToEnglish(cnPrompt, meta, request, previousPrompt = '') {
    const localData = localBootstrapData(meta, request);
    updateBootstrapDataFromDesignText(localData, cnPrompt, meta, request);
    const cleanDesignPrompt = stripReasoningBlocks(cnPrompt);
    const structuredFallback = sanitizeEnglishPrompt(localData.referencePromptEN, localBootstrapData(meta, request).referencePromptEN);
    const fallback = sanitizeEnglishPrompt(previousPrompt, structuredFallback);
    const configuredSystemPrompt = characterReferenceSystemPrompt();
    const modelProfileText = referencePromptModelProfileText();
    try {
        const translatePrompt = [
            configuredSystemPrompt ? `用户配置的角色首参考图系统提示词：\n${configuredSystemPrompt}` : '',
            modelProfileText,
            configuredSystemPrompt ? '如果用户配置系统提示词和当前 ComfyUI 工作流模型规则冲突，以当前 ComfyUI 工作流模型规则为准。' : '',
            '把下面的原插件角色/服装设定稿整理成英文 ComfyUI prompt。',
            '必须保留角色身份、外貌、服装和参考图构图规则；不要把中文字段名或中文原文直接复制到英文 prompt。',
            '参考图必须是单张角色正面全身立绘：自然站姿、一个人物、一个正面视角、白底或干净背景、均匀光照；禁止写 reference sheet、character sheet、model sheet、turnaround、multiple views、split screen、grid layout、side view、back view，以及剧情场景、床/马车/火炉等临时环境、暧昧氛围、镜头角度、动作戏、纯数字残片。',
            '只输出 JSON：{"promptEN":"..."}，不要 Markdown。',
            `角色名：${meta.displayName}`,
            `角色/服装设定稿：${cleanDesignPrompt}`,
            `当前英文提示词：${fallback}`,
        ].filter(Boolean).join('\n');
        const raw = await executeBootstrapLlmWithFallback(translatePrompt, [
            bootstrapTranslateRequestType(),
            bootstrapGenerateRequestType(),
            BOOTSTRAP_TRANSLATE_REQUEST_TYPE,
            BOOTSTRAP_REQUEST_TYPE,
        ]);
        const parsed = parseJsonObject(raw);
        const translated = asString(parsed.promptEN || parsed.prompt || parsed.referencePromptEN);
        const safeTranslated = sanitizeEnglishPrompt(translated, fallback);
        if (!safeTranslated || containsCjk(safeTranslated) || translated === asString(cnPrompt)) {
            throw new Error('翻译结果为空或仍为中文原文。');
        }
        return safeTranslated;
    } catch (error) {
        console.warn('[st-chatu8] Reference prompt translation failed:', error);
        if (structuredFallback && !containsCjk(structuredFallback)) {
            return structuredFallback;
        }
        const wrapped = new Error(`翻译/整理失败：${error?.message || String(error)}`);
        wrapped.cause = error;
        wrapped.stChatu8KeepExistingPrompt = true;
        throw wrapped;
    }
}

function normalizeMediaUrl(response) {
    const value = response?.imageData || response?.image || response?.url || '';
    if (!value) {
        return '';
    }
    if (/^(data:|https?:|\/)/i.test(value)) {
        return value;
    }
    const format = asString(response?.format, 'png').replace(/[^a-z0-9.+-]/gi, '') || 'png';
    return `data:image/${format};base64,${value}`;
}

function bootstrapDimensions(request) {
    const explicitWidth = Number(request?.width);
    const explicitHeight = Number(request?.height);
    if (Number.isFinite(explicitWidth) && Number.isFinite(explicitHeight) && explicitWidth > 0 && explicitHeight > 0) {
        return {
            width: Math.floor(explicitWidth),
            height: Math.floor(explicitHeight),
        };
    }

    const requestedWidth = 768;
    const requestedHeight = 1024;
    const maxEdge = Math.max(512, Number(settings().comfyAutoReferenceBootstrapMaxEdge) || 896);
    const longest = Math.max(requestedWidth, requestedHeight);
    const scale = longest > maxEdge ? maxEdge / longest : 1;
    const snap = (value) => Math.max(512, Math.round((value * scale) / 64) * 64);
    return {
        width: snap(requestedWidth),
        height: snap(requestedHeight),
    };
}

function runBootstrapComfyRequest(payload) {
    return new Promise((resolve, reject) => {
        let timeoutId;
        const cleanup = () => {
            clearTimeout(timeoutId);
            eventSource.removeListener(EventType.GENERATE_IMAGE_RESPONSE, onResponse);
        };
        const onResponse = (response) => {
            if (!response || response.id !== payload.id) {
                return;
            }
            cleanup();
            if (response.success) {
                resolve(response);
            } else {
                reject(new Error(response.error || 'ComfyUI reference bootstrap failed'));
            }
        };
        timeoutId = setTimeout(() => {
            cleanup();
            reject(new Error(`参考图首图生成超时：${Math.round(BOOTSTRAP_TIMEOUT_MS / 1000)} 秒`));
        }, BOOTSTRAP_TIMEOUT_MS);
        eventSource.on(EventType.GENERATE_IMAGE_RESPONSE, onResponse);
        Promise.resolve(eventSource.emit(EventType.GENERATE_IMAGE_REQUEST, payload)).catch((error) => {
            cleanup();
            reject(error);
        });
    });
}

async function generateNoReferenceImage(prompt, request) {
    const dimensions = bootstrapDimensions(request);
    const selectedBootstrapWorkerId = bootstrapWorkerId();
    const useCurrentWorkflowNoReference = !selectedBootstrapWorkerId;
    const safePrompt = sanitizeEnglishPrompt(
        prompt,
        defaultEnglishReferencePrompt(englishAliasFromValues([request?.referenceCharacterName]) || 'the current character'),
    );
    if (!safePrompt || containsCjk(safePrompt)) {
        throw new Error('英文生图提示词仍包含中文或为空，请先翻译/整理后再生成。');
    }
    const payload = {
        id: `chatu8_reference_bootstrap:${Date.now()}:${Math.random().toString(36).slice(2)}`,
        prompt: safePrompt,
        width: dimensions.width,
        height: dimensions.height,
        negative_prompt: REFERENCE_BOOTSTRAP_NEGATIVE_PROMPT,
        seed: undefined,
        mode: 'reference_bootstrap',
        change: selectedBootstrapWorkerId ? 'st_chatu8_reference_bootstrap selected_worker_first_image' : 'st_chatu8_reference_bootstrap current_worker_no_reference_first_image',
        workflowAdapter: useCurrentWorkflowNoReference ? 'flux2-klein-no-reference-bootstrap' : undefined,
        stChatu8NoReferenceBootstrap: useCurrentWorkflowNoReference,
        stChatu8BootstrapWorkerId: selectedBootstrapWorkerId,
        debugPromptRaw: request?.debugPromptRaw || request?.prompt || '',
        debugPromptOptimized: safePrompt,
        debugPromptFinal: safePrompt,
    };
    return runBootstrapComfyRequest(payload);
}

function currentComfyUrl() {
    const data = settings();
    const input = typeof document !== 'undefined' ? document.getElementById('comfyuiUrl') : null;
    return asString(input?.value || data.comfyuiUrl || data.comfyui_url).replace(/\/+$/, '');
}

async function responseToBlob(response) {
    const mediaUrl = normalizeMediaUrl(response);
    if (!mediaUrl) {
        throw new Error('没有拿到可绑定的首图数据。');
    }
    if (/^(data:|https?:|\/)/i.test(mediaUrl)) {
        const fetched = await fetch(mediaUrl);
        return fetched.blob();
    }
    const binary = atob(mediaUrl);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: `image/${asString(response?.format) || 'png'}` });
}

function autoReferencePath(meta) {
    const name = fileSafeName(meta?.displayName || meta?.name || 'character') || 'character';
    return `${AUTO_REFERENCE_DIR}\\${name}.png`;
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(asString(reader.result));
        reader.onerror = () => reject(reader.error || new Error('Failed to read generated reference image.'));
        reader.readAsDataURL(blob);
    });
}

async function saveGeneratedReferenceToLocalPath(response, meta) {
    if (response?.isVideo) {
        throw new Error('首图返回的是视频，不能作为角色参考图。');
    }
    const targetPath = autoReferencePath(meta);
    const blob = await responseToBlob(response);
    const image = await blobToDataUrl(blob);

    let localSaveError = null;
    try {
        const result = await fetch(AUTO_REFERENCE_SAVE_ENDPOINT, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ path: targetPath, image }),
        });
        if (!result.ok) {
            const text = await result.text().catch(() => '');
            throw new Error(`HTTP ${result.status}${text ? ` ${text.slice(0, 240)}` : ''}`);
        }
        const data = await result.json().catch(() => ({}));
        return asString(data.path || targetPath);
    } catch (error) {
        localSaveError = error;
        console.warn('[st-chatu8] Local reference save failed; falling back to ComfyUI upload:', error);
    }

    try {
        return await uploadGeneratedReferenceBlob(blob, response, meta);
    } catch (uploadError) {
        throw new Error(`自动参考图保存失败：本地保存接口不可用（${localSaveError?.message || localSaveError}），ComfyUI 上传也失败（${uploadError?.message || uploadError}）。`);
    }
}

async function uploadGeneratedReferenceBlob(blob, response, meta) {
    const url = currentComfyUrl();
    if (!url) {
        throw new Error('请先填写 ComfyUI API 地址。');
    }
    const ext = (blob.type.match(/image\/([a-z0-9.+-]+)/i)?.[1] || asString(response?.format) || 'png').replace('jpeg', 'jpg');
    const fileName = `${fileSafeName(meta.displayName)}_auto_ref_${Date.now()}.${ext}`;
    const file = new File([blob], fileName, { type: blob.type || `image/${ext}` });
    const form = new FormData();
    form.append('image', file, file.name);
    form.append('type', 'input');
    form.append('overwrite', 'false');
    const result = await fetch(`${url}/upload/image`, { method: 'POST', body: form });
    if (!result.ok) {
        throw new Error(`ComfyUI 参考图上传失败：HTTP ${result.status}`);
    }
    const data = await result.json().catch(() => ({}));
    const name = asString(data.name || data.filename || file.name);
    const subfolder = asString(data.subfolder);
    return subfolder ? `${subfolder}/${name}` : name;
}

async function uploadGeneratedReference(response, meta) {
    if (response?.isVideo) {
        throw new Error('首图返回的是视频，不能作为角色参考图。');
    }
    const blob = await responseToBlob(response);
    return uploadGeneratedReferenceBlob(blob, response, meta);
}

function mergeIfEmpty(target, source, keys) {
    for (const key of keys) {
        const value = asString(source?.[key]);
        if (value && !asString(target[key])) {
            target[key] = value;
        }
    }
}

function uniquePresetId(base, collection) {
    const clean = asString(base) || '自动角色';
    if (!collection[clean]) {
        return clean;
    }
    let index = 2;
    while (collection[`${clean} ${index}`]) {
        index += 1;
    }
    return `${clean} ${index}`;
}

function originalDesignScopePrefix(meta) {
    const contextName = asString(meta?.context?.name2 || meta?.context?.characterName);
    return contextName ? `[${contextName}]` : '';
}

function originalDesignPresetBase(name, meta) {
    const clean = asString(name, '自动角色');
    const prefix = originalDesignScopePrefix(meta);
    return prefix && !clean.startsWith(prefix) ? `${prefix}${clean}` : clean;
}

function bindReferencePath(meta, bootstrapData, referencePath, finalPrompt) {
    const data = settings();
    if (!data.characterPresets || typeof data.characterPresets !== 'object' || Array.isArray(data.characterPresets)) {
        data.characterPresets = {};
    }
    if (!data.outfitPresets || typeof data.outfitPresets !== 'object' || Array.isArray(data.outfitPresets)) {
        data.outfitPresets = {};
    }

    const existing = findCurrentCharacterPreset(meta, false);
    const presetBase = originalDesignPresetBase(bootstrapData.nameCN || bootstrapData.nameEN || meta.displayName, meta);
    const presetId = existing?.presetId || uniquePresetId(presetBase, data.characterPresets);
    const preset = existing?.preset || {};
    const safeFinalPrompt = sanitizeEnglishPrompt(finalPrompt, bootstrapData.referencePromptEN || preset.photoPrompt || defaultEnglishReferencePrompt());
    mergeIfEmpty(preset, {
        nameCN: bootstrapData.nameCN || meta.displayName,
        nameEN: bootstrapData.nameEN || meta.displayName,
        characterTraits: bootstrapData.characterTraits,
        facialFeatures: bootstrapData.facialFeatures,
        facialFeaturesBack: bootstrapData.facialFeaturesBack,
        upperBodySFW: bootstrapData.upperBodySFW,
        upperBodySFWBack: bootstrapData.upperBodySFWBack,
        fullBodySFW: bootstrapData.fullBodySFW,
        fullBodySFWBack: bootstrapData.fullBodySFWBack,
        upperBodyNSFW: bootstrapData.upperBodyNSFW,
        upperBodyNSFWBack: bootstrapData.upperBodyNSFWBack,
        fullBodyNSFW: bootstrapData.fullBodyNSFW,
        fullBodyNSFWBack: bootstrapData.fullBodyNSFWBack,
        negative: bootstrapData.negative,
    }, [
        'nameCN', 'nameEN', 'characterTraits', 'facialFeatures', 'facialFeaturesBack',
        'upperBodySFW', 'upperBodySFWBack', 'fullBodySFW', 'fullBodySFWBack',
        'upperBodyNSFW', 'upperBodyNSFWBack', 'fullBodyNSFW', 'fullBodyNSFWBack', 'negative',
    ]);
    preset.comfyRefImagePath = referencePath;
    preset.comfyIdentityPrompt = [
        bootstrapData.characterTraits,
        bootstrapData.facialFeatures,
        bootstrapData.upperBodySFW,
        bootstrapData.fullBodySFW,
    ].map(asString).filter(Boolean).join(', ');
    preset.photoPrompt = safeFinalPrompt || asString(bootstrapData.referencePromptEN || preset.photoPrompt);
    preset.autoReferenceGeneratedAt = new Date().toISOString();
    preset.originalCharDesignText = asString(bootstrapData.stChatu8DesignText || preset.originalCharDesignText);

    const outfit = bootstrapData.outfit || {};
    const outfitBase = originalDesignPresetBase(outfit.nameCN || outfit.nameEN || '默认参考服装', meta);
    const outfitId = Object.keys(data.outfitPresets).find((id) => id === outfitBase) || uniquePresetId(outfitBase, data.outfitPresets);
    const outfitPreset = data.outfitPresets[outfitId] || {};
    mergeIfEmpty(outfitPreset, {
        nameCN: outfit.nameCN || '默认参考服装',
        nameEN: outfit.nameEN || 'default reference outfit',
        owner: outfit.owner || preset.nameCN || preset.nameEN || meta.displayName,
        style: outfit.style,
        color: outfit.color,
        material: outfit.material,
        upperBody: outfit.upperBody,
        upperBodyBack: outfit.upperBodyBack,
        fullBody: outfit.fullBody,
        fullBodyBack: outfit.fullBodyBack,
    }, ['nameCN', 'nameEN', 'owner', 'style', 'color', 'material', 'upperBody', 'upperBodyBack', 'fullBody', 'fullBodyBack']);
    outfitPreset.photoPrompt = safeFinalPrompt || asString(outfitPreset.photoPrompt);
    data.outfitPresets[outfitId] = outfitPreset;

    if (!Array.isArray(preset.outfits)) {
        preset.outfits = [];
    }
    if (!preset.outfits.includes(outfitId)) {
        preset.outfits.push(outfitId);
    }
    data.characterPresets[presetId] = preset;
    data.characterPresetId = presetId;
    data.characterEnablePresetId = presetId;
    data.outfitPresetId = outfitId;
    saveSettingsDebounced();
    return { presetId, outfitId, referencePath, characterName: meta.displayName };
}

function bootstrapSessionKey(meta) {
    return normalizeName(meta?.displayName || meta?.names?.[0] || '');
}

function bootstrapDesignIdentityName(bootstrapData) {
    const candidates = uniqueStrings([
        bootstrapData?.nameCN,
        bootstrapData?.nameEN,
        bootstrapData?.outfit?.owner,
    ]);
    for (const candidate of candidates) {
        const cleaned = cleanExtractedCharacterName(candidate) || asString(candidate);
        if (cleaned && cleaned !== '新角色' && cleaned !== '当前角色' && isLooseCharacterNameCandidate(cleaned)) {
            return cleaned;
        }
    }
    return '';
}

function isWeakBootstrapIdentity(meta) {
    const displayName = asString(meta?.displayName);
    const requestNames = Array.isArray(meta?.requestNames) ? meta.requestNames : [];
    if (!displayName || displayName === '当前角色' || displayName === '新角色') {
        return true;
    }
    if (isDescriptiveCharacterFragment(displayName)) {
        return true;
    }
    if (meta?.requestCharacterSource === 'unresolved' || !requestNames.length) {
        return true;
    }
    return requestNames.every((name) => isDescriptiveCharacterFragment(name));
}

function metaWithBootstrapIdentity(meta, bootstrapData) {
    if (!isWeakBootstrapIdentity(meta)) {
        return meta;
    }
    const identityName = bootstrapDesignIdentityName(bootstrapData);
    if (!identityName) {
        return meta;
    }
    return {
        ...meta,
        displayName: identityName,
        names: uniqueStrings([identityName, bootstrapData?.nameEN, ...(Array.isArray(meta?.names) ? meta.names : [])]),
        requestNames: uniqueStrings([identityName, bootstrapData?.nameEN, ...(Array.isArray(meta?.requestNames) ? meta.requestNames : [])]),
        requestCharacterSource: meta?.requestCharacterSource === 'unresolved' ? 'bootstrap_design' : meta?.requestCharacterSource,
        requestCharacterCandidates: uniqueStrings([identityName, ...(Array.isArray(meta?.requestCharacterCandidates) ? meta.requestCharacterCandidates : [])]),
        hasCurrentCharacter: true,
    };
}

async function currentReadyReferenceResult(meta) {
    const current = findCurrentCharacterPreset(meta, true);
    if (!current?.path || !(await comfyInputImageExists(current.path))) {
        return null;
    }
    const outfits = Array.isArray(current.preset?.outfits) ? current.preset.outfits : [];
    return {
        presetId: current.presetId,
        outfitId: outfits.map(asString).find(Boolean) || '',
        referencePath: current.path,
        source: 'current_character_preset',
    };
}

function applyBootstrapResultToRequest(request, result) {
    if (!result?.referencePath) {
        return request;
    }
    return {
        ...request,
        comfyuicankaotupian: result.referencePath,
        comfyui_reference_image: result.referencePath,
        referenceImage: result.referencePath,
        debugReferenceBootstrap: {
            presetId: result.presetId,
            outfitId: result.outfitId,
            referencePath: result.referencePath,
            source: result.source || '',
            characterName: result.characterName || '',
            version: BOOTSTRAP_VERSION,
        },
    };
}

function addStyle() {
    if (typeof document === 'undefined' || document.getElementById('st_chatu8_reference_bootstrap_style')) {
        return;
    }
    const style = document.createElement('style');
    style.id = 'st_chatu8_reference_bootstrap_style';
    style.textContent = `
        .st-chatu8-refboot-overlay {
            position: fixed;
            inset: 0;
            z-index: 100500;
            display: grid;
            place-items: center;
            padding: 18px;
            background: rgba(8, 10, 14, 0.72);
            overflow: auto;
            box-sizing: border-box;
            width: 100vw;
            min-height: 100vh;
            min-height: 100dvh;
            overscroll-behavior: contain;
            -webkit-overflow-scrolling: touch;
        }
        .st-chatu8-refboot-dialog {
            width: min(980px, 96vw);
            max-height: 92vh;
            max-height: 92dvh;
            display: grid;
            grid-template-rows: auto minmax(0, 1fr) auto;
            overflow: hidden;
            border: 1px solid rgba(160, 180, 190, 0.26);
            border-radius: 8px;
            background: #15191f;
            color: #edf4f7;
            box-shadow: 0 18px 60px rgba(0, 0, 0, 0.45);
        }
        .st-chatu8-refboot-dialog,
        .st-chatu8-refboot-dialog * {
            box-sizing: border-box;
        }
        .st-chatu8-refboot-header,
        .st-chatu8-refboot-footer {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            padding: 14px 16px;
            border-bottom: 1px solid rgba(160, 180, 190, 0.18);
        }
        .st-chatu8-refboot-footer {
            border-top: 1px solid rgba(160, 180, 190, 0.18);
            border-bottom: 0;
            flex-wrap: wrap;
        }
        .st-chatu8-refboot-title {
            min-width: 0;
            font-size: 15px;
            font-weight: 700;
            line-height: 1.35;
            overflow-wrap: anywhere;
        }
        .st-chatu8-refboot-body {
            display: grid;
            grid-template-columns: minmax(0, 1fr) minmax(260px, 340px);
            gap: 14px;
            padding: 16px;
            min-height: 0;
            overflow: auto;
            overscroll-behavior: contain;
            -webkit-overflow-scrolling: touch;
        }
        .st-chatu8-refboot-fields {
            display: grid;
            gap: 10px;
            min-width: 0;
        }
        .st-chatu8-refboot-label {
            display: grid;
            gap: 6px;
            min-width: 0;
            font-size: 13px;
            font-weight: 650;
            color: #f2f7fa;
        }
        .st-chatu8-refboot-textarea {
            width: 100%;
            max-width: 100%;
            min-height: 120px;
            resize: vertical;
            border: 1px solid rgba(160, 180, 190, 0.28);
            border-radius: 6px;
            padding: 10px;
            background: #0f1318;
            color: #eef7fb;
            caret-color: #ffffff;
            font-size: 13px;
            line-height: 1.45;
        }
        .st-chatu8-refboot-preview {
            min-height: 360px;
            display: grid;
            place-items: center;
            border: 1px solid rgba(160, 180, 190, 0.22);
            border-radius: 6px;
            background: #0f1318;
            color: #dceaf0;
            overflow: hidden;
        }
        .st-chatu8-refboot-preview span {
            color: #dceaf0;
            font-size: 13px;
        }
        .st-chatu8-refboot-preview img {
            width: 100%;
            height: 100%;
            object-fit: contain;
        }
        .st-chatu8-refboot-status {
            min-width: 0;
            font-size: 13px;
            color: #dce8ee;
            line-height: 1.45;
            overflow-wrap: anywhere;
        }
        .st-chatu8-refboot-status[data-kind="error"] { color: #ffc2b8; }
        .st-chatu8-refboot-status[data-kind="ok"] { color: #c9f7d4; }
        .st-chatu8-refboot-bottom-status {
            flex: 1 1 260px;
        }
        .st-chatu8-refboot-actions {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-left: auto;
        }
        .st-chatu8-refboot-dialog .st-chatu8-btn {
            min-height: 34px;
            border: 1px solid rgba(190, 215, 225, 0.42);
            border-radius: 6px;
            background: #26313d;
            color: #f4fbff;
            padding: 7px 12px;
            font-size: 13px;
            font-weight: 650;
            cursor: pointer;
            opacity: 1;
        }
        .st-chatu8-refboot-dialog .st-chatu8-btn:hover:not(:disabled) {
            border-color: #8fc7dc;
            background: #324253;
            color: #ffffff;
        }
        .st-chatu8-refboot-dialog .st-chatu8-btn:disabled {
            border-color: rgba(190, 215, 225, 0.28);
            background: #1f2731;
            color: #d3e1e8;
            cursor: not-allowed;
            opacity: 0.8;
        }
        @media (max-width: 760px) {
            .st-chatu8-refboot-overlay {
                align-items: stretch;
                justify-items: center;
                padding: 8px;
                padding: max(8px, env(safe-area-inset-top)) 8px max(8px, env(safe-area-inset-bottom));
            }
            .st-chatu8-refboot-dialog {
                width: calc(100vw - 16px);
                max-width: calc(100vw - 16px);
                height: auto;
                min-height: 0;
                max-height: calc(100vh - 16px);
                max-height: calc(100dvh - 16px);
                grid-template-rows: auto minmax(0, 1fr) auto;
            }
            .st-chatu8-refboot-header,
            .st-chatu8-refboot-footer {
                padding: 10px 12px;
                align-items: flex-start;
            }
            .st-chatu8-refboot-header {
                gap: 8px;
            }
            .st-chatu8-refboot-header .st-chatu8-btn {
                flex: 0 0 auto;
            }
            .st-chatu8-refboot-body {
                grid-template-columns: 1fr;
                gap: 10px;
                padding: 12px;
            }
            .st-chatu8-refboot-textarea {
                min-height: 104px;
            }
            .st-chatu8-refboot-preview {
                min-height: 180px;
                min-height: min(240px, 32vh);
                min-height: min(240px, 32dvh);
            }
            .st-chatu8-refboot-bottom-status {
                flex-basis: 100%;
            }
            .st-chatu8-refboot-actions {
                margin-left: 0;
                width: 100%;
            }
            .st-chatu8-refboot-actions .st-chatu8-btn { flex: 1 1 calc(50% - 8px); }
        }
    `;
    document.head.appendChild(style);
}

function showBootstrapDialog(meta, request, bootstrapData) {
    if (activeDialogPromise) {
        return activeDialogPromise;
    }
    addStyle();
    activeDialogPromise = new Promise((resolve, reject) => {
        let generatedResponse = null;
        let closed = false;
        const overlay = document.createElement('div');
        overlay.className = 'st-chatu8-refboot-overlay';
        overlay.innerHTML = `
            <div class="st-chatu8-refboot-dialog" role="dialog" aria-modal="true">
                <div class="st-chatu8-refboot-header">
                    <div class="st-chatu8-refboot-title">缺少「${escapeHtml(meta.displayName)}」参考图，先生成角色首张参考图</div>
                    <button type="button" class="st-chatu8-btn st-chatu8-refboot-close">取消</button>
                </div>
                <div class="st-chatu8-refboot-body">
                    <div class="st-chatu8-refboot-fields">
                        <label class="st-chatu8-refboot-label">角色/服装设定稿
                            <textarea class="st-chatu8-refboot-textarea st-chatu8-refboot-cn">${escapeHtml(bootstrapData.stChatu8DesignText || bootstrapData.referencePromptCN)}</textarea>
                        </label>
                        <label class="st-chatu8-refboot-label">英文生图提示词
                            <textarea class="st-chatu8-refboot-textarea st-chatu8-refboot-en">${escapeHtml(bootstrapData.referencePromptEN)}</textarea>
                        </label>
                        <div class="st-chatu8-refboot-status">${escapeHtml((bootstrapData.warnings || []).join('；'))}</div>
                    </div>
                    <div class="st-chatu8-refboot-preview"><span>等待生成预览</span></div>
                </div>
                <div class="st-chatu8-refboot-footer">
                    <div class="st-chatu8-refboot-status st-chatu8-refboot-bottom-status"></div>
                    <div class="st-chatu8-refboot-actions">
                        <button type="button" class="st-chatu8-btn st-chatu8-refboot-close">关闭</button>
                        <button type="button" class="st-chatu8-btn st-chatu8-refboot-translate">翻译/整理</button>
                        <button type="button" class="st-chatu8-btn st-chatu8-refboot-generate">生成首图</button>
                        <button type="button" class="st-chatu8-btn st-chatu8-refboot-bind" disabled>满意并绑定</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const cn = overlay.querySelector('.st-chatu8-refboot-cn');
        const en = overlay.querySelector('.st-chatu8-refboot-en');
        const preview = overlay.querySelector('.st-chatu8-refboot-preview');
        const status = overlay.querySelector('.st-chatu8-refboot-bottom-status');
        const generate = overlay.querySelector('.st-chatu8-refboot-generate');
        const translate = overlay.querySelector('.st-chatu8-refboot-translate');
        const bind = overlay.querySelector('.st-chatu8-refboot-bind');
        const closeButtons = overlay.querySelectorAll('.st-chatu8-refboot-close');

        const setStatus = (message, kind = '') => {
            status.textContent = message;
            status.dataset.kind = kind;
        };
        let onKeyDown = null;
        const cleanup = () => {
            if (onKeyDown) {
                document.removeEventListener('keydown', onKeyDown);
                onKeyDown = null;
            }
            closed = true;
            overlay.remove();
            activeDialogPromise = null;
        };
        const setBusy = (busy) => {
            generate.disabled = busy;
            translate.disabled = busy;
            bind.disabled = busy || !generatedResponse;
        };

        const cancel = () => {
            cleanup();
            const error = new Error('reference bootstrap canceled');
            error.name = 'AbortError';
            error.stChatu8Canceled = true;
            reject(error);
        };
        closeButtons.forEach((button) => button.addEventListener('click', cancel));
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) {
                cancel();
            }
        });
        onKeyDown = (event) => {
            if (event.key === 'Escape') {
                cancel();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        translate.addEventListener('click', async () => {
            const previousPrompt = asString(en.value);
            try {
                setBusy(true);
                setStatus('正在翻译并整理提示词...');
                updateBootstrapDataFromDesignText(bootstrapData, cn.value, meta, request);
                const nextPrompt = await translatePromptToEnglish(cn.value, meta, request, previousPrompt);
                if (nextPrompt) {
                    en.value = nextPrompt;
                }
                setStatus('提示词已更新，可以生成首图。', 'ok');
            } catch (error) {
                en.value = sanitizeEnglishPrompt(previousPrompt, bootstrapData.referencePromptEN);
                setStatus(`${error?.message || String(error)}；已保留原英文提示词。`, 'error');
            } finally {
                if (!closed) {
                    setBusy(false);
                }
            }
        });
        generate.addEventListener('click', async () => {
            try {
                setBusy(true);
                setStatus('正在用无参考工作流生成首图...');
                en.value = sanitizeEnglishPrompt(en.value, bootstrapData.referencePromptEN);
                generatedResponse = await generateNoReferenceImage(asString(en.value), request);
                const imageUrl = normalizeMediaUrl(generatedResponse);
                preview.innerHTML = imageUrl ? `<img alt="reference preview" src="${escapeHtml(imageUrl)}">` : '<span>生成完成，但没有预览数据</span>';
                bind.disabled = false;
                setStatus('首图已生成。满意就绑定；不满意可以修改提示词后重新生成。', 'ok');
            } catch (error) {
                generatedResponse = null;
                preview.innerHTML = '<span>生成失败</span>';
                setStatus(error?.message || String(error), 'error');
            } finally {
                if (!closed) {
                    setBusy(false);
                }
            }
        });
        bind.addEventListener('click', async () => {
            if (!generatedResponse) {
                setStatus('请先生成一张首图。', 'error');
                return;
            }
            try {
                setBusy(true);
                setStatus('正在上传并绑定到当前角色...');
                updateBootstrapDataFromDesignText(bootstrapData, cn.value, meta, request);
                const referencePath = await saveGeneratedReferenceToLocalPath(generatedResponse, meta);
                const result = bindReferencePath(meta, bootstrapData, referencePath, asString(en.value));
                cleanup();
                resolve(result);
            } catch (error) {
                setStatus(error?.message || String(error), 'error');
                if (!closed) {
                    setBusy(false);
                }
            }
        });
    });
    return activeDialogPromise;
}

export async function ensureComfyReferenceBootstrap(request, context = {}) {
    if (typeof document === 'undefined') {
        return request;
    }
    syncBootstrapWorkerSelect();
    const meta = await currentCharacterMeta(request);
    const gate = referenceBootstrapGate(request, meta);
    context?.traceEvent?.(context.trace, 'reference_bootstrap:gate', gate, false);
    if (gate?.allowed) {
        const readyReference = await currentReadyReferenceResult(meta);
        if (readyReference?.referencePath) {
            context?.traceEvent?.(context.trace, 'reference_bootstrap:ready_reference', {
                character: meta.displayName,
                preset_id: readyReference.presetId,
                outfit_id: readyReference.outfitId,
                reference_path: readyReference.referencePath,
                source: readyReference.source,
            }, false);
            context?.traceStep?.(context.trace, 'workflow', 'done', {
                reference_bootstrap: 'ready_reference',
                character: meta.displayName,
                preset_id: readyReference.presetId,
                outfit_id: readyReference.outfitId,
                reference_path: readyReference.referencePath,
                gate,
            });
            return applyBootstrapResultToRequest(request, readyReference);
        }
    }
    const referenceProblem = await getReferenceProblem(request, meta, gate);
    if (!referenceProblem) {
        context?.traceEvent?.(context.trace, 'reference_bootstrap:skipped', {
            reason: referenceBootstrapSkipReason(gate),
            ...gate,
        }, false);
        return request;
    }
    context?.traceStep?.(context.trace, 'workflow', 'running', {
        reference_bootstrap: referenceProblem.reason,
        character: meta.displayName,
        reference_paths: referenceProblem.paths,
        preset_id: referenceProblem.preset_id || '',
        gate,
    });

    const sessionKey = bootstrapSessionKey(meta);
    const existingSession = sessionKey ? bootstrapSessionByCharacter.get(sessionKey) : null;
    if (existingSession?.status === 'bound' && existingSession?.result?.referencePath) {
        context?.traceStep?.(context.trace, 'workflow', 'done', {
            reference_bootstrap: 'reused_bound_reference',
            character: existingSession.result.characterName || meta.displayName,
            preset_id: existingSession.result.presetId,
            outfit_id: existingSession.result.outfitId,
            reference_path: existingSession.result.referencePath,
        });
        return applyBootstrapResultToRequest(request, existingSession.result);
    }
    if (existingSession?.promise) {
        context?.traceStep?.(context.trace, 'workflow', 'running', {
            reference_bootstrap: 'waiting_existing_character_dialog',
            character: meta.displayName,
            session_key: sessionKey,
        });
        try {
            const result = await existingSession.promise;
            return applyBootstrapResultToRequest(request, result);
        } catch (error) {
            if (error?.stChatu8Canceled || error?.name === 'AbortError') {
                context?.traceStep?.(context.trace, 'workflow', 'skipped', {
                    reference_bootstrap: 'canceled_existing_character_dialog',
                    character: meta.displayName,
                });
                return request;
            }
            throw error;
        }
    }

    const sessionPromise = (async () => {
        const bootstrapData = await generateBootstrapData(meta, request);
        const dialogMeta = metaWithBootstrapIdentity(meta, bootstrapData);
        if (dialogMeta !== meta) {
            context?.traceEvent?.(context.trace, 'reference_bootstrap:identity_from_design', {
                before: meta.displayName,
                after: dialogMeta.displayName,
                source: dialogMeta.requestCharacterSource || '',
            }, false);
        }
        return showBootstrapDialog(dialogMeta, request, bootstrapData);
    })();
    if (sessionKey) {
        bootstrapSessionByCharacter.set(sessionKey, {
            status: 'dialog_open',
            promise: sessionPromise,
            result: null,
        });
    }

    let result;
    try {
        result = await sessionPromise;
    } catch (error) {
        if (error?.stChatu8Canceled || error?.name === 'AbortError') {
            if (sessionKey) {
                bootstrapSessionByCharacter.set(sessionKey, {
                    status: 'canceled',
                    promise: null,
                    result: null,
                });
            }
            context?.traceStep?.(context.trace, 'workflow', 'skipped', {
                reference_bootstrap: 'canceled',
                character: meta.displayName,
                session_key: sessionKey,
            });
            return request;
        }
        if (sessionKey) {
            bootstrapSessionByCharacter.set(sessionKey, {
                status: 'failed',
                promise: null,
                result: null,
                error: error?.message || String(error),
            });
        }
        throw error;
    }
    if (sessionKey) {
        bootstrapSessionByCharacter.set(sessionKey, {
            status: 'bound',
            promise: null,
            result,
        });
    }
    context?.traceStep?.(context.trace, 'workflow', 'done', {
        reference_bootstrap: 'bound',
        character: result.characterName || meta.displayName,
        preset_id: result.presetId,
        outfit_id: result.outfitId,
        reference_path: result.referencePath,
        session_key: sessionKey,
    });
    return applyBootstrapResultToRequest(request, result);
}
