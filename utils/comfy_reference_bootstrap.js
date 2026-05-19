import { chat_metadata, eventSource, getRequestHeaders, saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { getContext } from '../../../../st-context.js';
import { loadWorldInfo, METADATA_KEY as WORLD_INFO_METADATA_KEY, selected_world_info, world_info, world_names } from '../../../../world-info.js';
import { EventType, extensionName } from './config.js';
import { resolveComfyCharacterReferences } from './characterprompt.js';
import { executeTypedLLMRequest } from './settings/llmService.js';

const BOOTSTRAP_VERSION = '20260519_mobile_reference_bootstrap_guard_v1';
const BOOTSTRAP_REQUEST_TYPE = 'character_reference_bootstrap';
const BOOTSTRAP_WORKER_SELECT_ID = 'comfyAutoReferenceBootstrapWorkerId';
const BOOTSTRAP_TIMEOUT_MS = 8 * 60 * 1000;
const AUTO_REFERENCE_DIR = 'D:\\jiuguan\\角色';
const AUTO_REFERENCE_SAVE_ENDPOINT = '/api/plugins/st-chatu8/save-reference-image';

let activeDialogPromise = null;

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

function isAutoReferenceBootstrapEnabled(data = settings()) {
    if (data.comfyAutoReferenceBootstrapEnabled !== true) {
        return false;
    }
    if (data.comfyAutoReferenceBootstrapExplicitlyEnabled === true) {
        return true;
    }
    if (data.comfyAutoReferenceBootstrapMigratedOffVersion !== BOOTSTRAP_VERSION) {
        data.comfyAutoReferenceBootstrapEnabled = false;
        data.comfyAutoReferenceBootstrapMigratedOffVersion = BOOTSTRAP_VERSION;
        saveSettingsDebounced();
    }
    return false;
}

function comfyWorkers() {
    const workers = settings().workers;
    return workers && typeof workers === 'object' && !Array.isArray(workers) ? workers : {};
}

function bootstrapWorkerId() {
    const workerId = asString(settings().comfyAutoReferenceBootstrapWorkerId);
    return workerId && Object.prototype.hasOwnProperty.call(comfyWorkers(), workerId) ? workerId : '';
}

function syncBootstrapWorkerSelect() {
    if (typeof document === 'undefined') {
        return;
    }
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
        settings().comfyAutoReferenceBootstrapWorkerId = select.value;
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

function cleanExtractedCharacterName(value) {
    let text = asString(value);
    if (!text) {
        return '';
    }
    text = text.split(/\s+(?:Type|Subject|Highlight|Angle|Character|Pose\s*&\s*Action|Pose|Action|Clothing|Extra\s+Details|Environment|Scene|Background)\s*[:\uFF1A]/i)[0];
    text = text.split(/[\uFF0C,;\uFF1B\u3002.\n\r]/)[0];
    text = text.replace(/^[\s:\uFF1A\-]+|[\s:\uFF1A\-]+$/g, '');
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
    const contextNames = requestCharacterNames(request);
    const currentNames = collectCurrentNames(context, character);
    const stHasCurrentCharacter = hasCurrentCharacter(context, character);
    const names = uniqueStrings([...(stHasCurrentCharacter ? currentNames : []), ...contextNames, ...currentNames]);
    const displayName = (stHasCurrentCharacter ? currentNames[0] : contextNames[0]) || names[0] || '当前角色';
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
    return { context, character, names, displayName, cardText, worldBookText, hasCurrentCharacter: stHasCurrentCharacter || contextNames.length > 0 };
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
    return (meta?.names || []).map(normalizeName).filter((name) => name && name.length >= 2);
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

async function getReferenceProblem(request, meta) {
    const data = settings();
    if (!isAutoReferenceBootstrapEnabled(data) || !meta?.hasCurrentCharacter) {
        return null;
    }
    const adapter = asString(request?.workflowAdapter);
    const looksLikeKleinAnchor = adapter === 'flux2-klein-reference' || asString(request?.change).includes('chatu8_anchor');
    if (!looksLikeKleinAnchor) {
        return null;
    }
    const currentPreset = findCurrentCharacterPreset(meta, false);
    if (!currentPreset) {
        return { reason: 'new_character_without_reference', paths: [] };
    }
    const paths = currentPreset.path ? [currentPreset.path] : [];
    if (!paths.length) {
        return { reason: 'missing', paths: [] };
    }
    for (const path of paths) {
        if (await comfyInputImageExists(path)) {
            return null;
        }
    }
    return { reason: 'invalid_or_unavailable', paths };
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
    const name = meta.displayName || 'current character';
    const rawPrompt = asString(request?.prompt || request?.debugSourceContext);
    const promptEN = [
        'sfw',
        'solo character',
        'full body character reference image',
        'standing, front view, neutral pose',
        'clean simple background',
        'detailed face, clear eyes, coherent anatomy',
        name,
        rawPrompt,
    ].filter(Boolean).join(', ');
    return {
        nameCN: /[\u4e00-\u9fff]/.test(name) ? name : '',
        nameEN: /[\u4e00-\u9fff]/.test(name) ? name : name,
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
        negative: 'low quality, worst quality, bad anatomy, extra fingers, missing fingers, watermark, text, logo, blurry',
        outfit: {
            nameCN: '默认参考服装',
            nameEN: 'default reference outfit',
            upperBody: '',
            upperBodyBack: '',
            fullBody: '',
            fullBodyBack: '',
        },
        referencePromptCN: `为 ${name} 生成一张正面全身角色参考图，姿势自然，背景干净。`,
        referencePromptEN: promptEN,
        warnings: warning ? [warning] : ['未能调用 LLM，已使用本地兜底提示词。'],
    };
}

function normalizeBootstrapData(value, meta, request) {
    const fallback = localBootstrapData(meta, request);
    const data = value && typeof value === 'object' ? value : {};
    const outfit = data.outfit && typeof data.outfit === 'object' ? data.outfit : {};
    return {
        ...fallback,
        ...Object.fromEntries(Object.entries(data).map(([key, item]) => [key, Array.isArray(item) || typeof item === 'object' ? item : asString(item)])),
        outfit: {
            ...fallback.outfit,
            ...Object.fromEntries(Object.entries(outfit).map(([key, item]) => [key, asString(item)])),
        },
        referencePromptEN: asString(data.referencePromptEN || data.reference_prompt_en || data.promptEN || data.prompt_en) || fallback.referencePromptEN,
        referencePromptCN: asString(data.referencePromptCN || data.reference_prompt_cn || data.promptCN || data.prompt_cn) || fallback.referencePromptCN,
        warnings: Array.isArray(data.warnings) ? data.warnings.map(asString).filter(Boolean) : fallback.warnings,
    };
}

function buildBootstrapLlmPrompt(meta, request) {
    const payload = {
        task: 'create_missing_sillytavern_character_visual_profile_and_first_reference_prompt',
        output: 'strict_json_only',
        required_keys: [
            'nameCN', 'nameEN', 'characterTraits', 'facialFeatures', 'facialFeaturesBack',
            'upperBodySFW', 'upperBodySFWBack', 'fullBodySFW', 'fullBodySFWBack',
            'upperBodyNSFW', 'upperBodyNSFWBack', 'fullBodyNSFW', 'fullBodyNSFWBack',
            'negative', 'outfit', 'referencePromptCN', 'referencePromptEN', 'warnings',
        ],
        outfit_required_keys: ['nameCN', 'nameEN', 'upperBody', 'upperBodyBack', 'fullBody', 'fullBodyBack'],
        policy: {
            infer_only_from_card_scene_and_world_book: true,
            do_not_claim_canon_if_unsure: true,
            referencePromptEN: 'English ComfyUI prompt, comma separated, suitable for a no-reference first image.',
            reference_image_goal: 'sfw solo full-body front-view character reference image, clean background, stable clothing and facial traits',
        },
        current_character_names: meta.names,
        image_anchor_prompt: request?.prompt || '',
        image_anchor_context: request?.debugSourceContext || '',
        character_card_text: meta.cardText || '',
        world_book_text: meta.worldBookText || '',
    };
    return [
        '你是 SillyTavern 角色设定和 ComfyUI 立绘提示词助手。只输出严格 JSON，不要 Markdown。',
        '请根据角色卡和当前 image### 提示词，生成角色设定、服装设定，以及一条英文无参考图首图提示词。',
        '如果角色卡没有明确写出外貌，请保守推断，并在 warnings 里说明。',
        '',
        'Input JSON:',
        JSON.stringify(payload, null, 2),
    ].join('\n');
}

async function executeBootstrapLlm(prompt, requestType = BOOTSTRAP_REQUEST_TYPE) {
    const id = `reference_bootstrap_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const eventName = `${BOOTSTRAP_REQUEST_TYPE}:${id}`;
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

async function generateBootstrapData(meta, request) {
    try {
        const raw = await executeBootstrapLlm(
            buildBootstrapLlmPrompt(meta, request),
            asString(settings().comfyAutoReferenceBootstrapRequestType) || BOOTSTRAP_REQUEST_TYPE,
        );
        return normalizeBootstrapData(parseJsonObject(raw), meta, request);
    } catch (error) {
        console.warn('[st-chatu8] Reference bootstrap LLM failed, using local fallback:', error);
        return localBootstrapData(meta, request, error?.message || String(error));
    }
}

async function translatePromptToEnglish(cnPrompt, meta, request) {
    const fallback = asString(cnPrompt) || localBootstrapData(meta, request).referencePromptEN;
    try {
        const raw = await executeBootstrapLlm([
            '把下面的中文角色参考图提示词翻译并整理成英文 ComfyUI prompt。',
            '只输出 JSON：{"promptEN":"..."}，不要 Markdown。',
            `角色名：${meta.displayName}`,
            `中文提示词：${fallback}`,
        ].join('\n'), asString(settings().comfyAutoReferenceBootstrapRequestType) || BOOTSTRAP_REQUEST_TYPE);
        const parsed = parseJsonObject(raw);
        return asString(parsed.promptEN || parsed.prompt || parsed.referencePromptEN) || fallback;
    } catch (error) {
        console.warn('[st-chatu8] Reference prompt translation failed:', error);
        return fallback;
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
    const payload = {
        id: `chatu8_reference_bootstrap:${Date.now()}:${Math.random().toString(36).slice(2)}`,
        prompt,
        width: dimensions.width,
        height: dimensions.height,
        negative_prompt: 'low quality, worst quality, bad anatomy, bad hands, extra fingers, missing fingers, watermark, text, logo, blurry',
        seed: undefined,
        mode: 'reference_bootstrap',
        change: selectedBootstrapWorkerId ? 'st_chatu8_reference_bootstrap selected_worker_first_image' : 'st_chatu8_reference_bootstrap current_worker_first_image',
        workflowAdapter: undefined,
        stChatu8NoReferenceBootstrap: false,
        stChatu8BootstrapWorkerId: selectedBootstrapWorkerId,
        debugPromptRaw: request?.debugPromptRaw || request?.prompt || '',
        debugPromptOptimized: prompt,
        debugPromptFinal: prompt,
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
    const result = await fetch(AUTO_REFERENCE_SAVE_ENDPOINT, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ path: targetPath, image }),
    });
    if (!result.ok) {
        const text = await result.text().catch(() => '');
        throw new Error(`自动参考图保存失败：HTTP ${result.status}${text ? ` ${text}` : ''}`);
    }
    const data = await result.json().catch(() => ({}));
    return asString(data.path || targetPath);
}

async function uploadGeneratedReference(response, meta) {
    if (response?.isVideo) {
        throw new Error('首图返回的是视频，不能作为角色参考图。');
    }
    const url = currentComfyUrl();
    if (!url) {
        throw new Error('请先填写 ComfyUI API 地址。');
    }
    const blob = await responseToBlob(response);
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

function bindReferencePath(meta, bootstrapData, referencePath, finalPrompt) {
    const data = settings();
    if (!data.characterPresets || typeof data.characterPresets !== 'object' || Array.isArray(data.characterPresets)) {
        data.characterPresets = {};
    }
    if (!data.outfitPresets || typeof data.outfitPresets !== 'object' || Array.isArray(data.outfitPresets)) {
        data.outfitPresets = {};
    }

    const existing = findCurrentCharacterPreset(meta, false);
    const presetId = existing?.presetId || uniquePresetId(meta.displayName, data.characterPresets);
    const preset = existing?.preset || {};
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
    preset.photoPrompt = asString(finalPrompt || bootstrapData.referencePromptEN || preset.photoPrompt);
    preset.autoReferenceGeneratedAt = new Date().toISOString();

    const outfit = bootstrapData.outfit || {};
    const outfitBase = `${presetId}${asString(outfit.nameCN || outfit.nameEN || '默认参考服装')}`;
    const outfitId = Object.keys(data.outfitPresets).find((id) => id === outfitBase) || uniquePresetId(outfitBase, data.outfitPresets);
    const outfitPreset = data.outfitPresets[outfitId] || {};
    mergeIfEmpty(outfitPreset, {
        nameCN: outfit.nameCN || '默认参考服装',
        nameEN: outfit.nameEN || 'default reference outfit',
        owner: preset.nameEN || preset.nameCN || meta.displayName,
        upperBody: outfit.upperBody,
        upperBodyBack: outfit.upperBodyBack,
        fullBody: outfit.fullBody,
        fullBodyBack: outfit.fullBodyBack,
    }, ['nameCN', 'nameEN', 'owner', 'upperBody', 'upperBodyBack', 'fullBody', 'fullBodyBack']);
    outfitPreset.photoPrompt = asString(finalPrompt || outfitPreset.photoPrompt);
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
    return { presetId, outfitId, referencePath };
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
            z-index: 10050;
            display: grid;
            place-items: center;
            padding: 18px;
            background: rgba(8, 10, 14, 0.72);
            overflow: auto;
            box-sizing: border-box;
        }
        .st-chatu8-refboot-dialog {
            width: min(980px, 96vw);
            max-height: min(92vh, 92dvh);
            display: grid;
            grid-template-rows: auto minmax(0, 1fr) auto;
            overflow: hidden;
            border: 1px solid rgba(160, 180, 190, 0.26);
            border-radius: 8px;
            background: #15191f;
            color: #edf4f7;
            box-shadow: 0 18px 60px rgba(0, 0, 0, 0.45);
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
            font-size: 15px;
            font-weight: 700;
        }
        .st-chatu8-refboot-body {
            display: grid;
            grid-template-columns: minmax(0, 1fr) minmax(260px, 340px);
            gap: 14px;
            padding: 16px;
            min-height: 0;
            overflow: auto;
        }
        .st-chatu8-refboot-fields {
            display: grid;
            gap: 10px;
        }
        .st-chatu8-refboot-label {
            display: grid;
            gap: 6px;
            font-size: 13px;
            font-weight: 650;
            color: #f2f7fa;
        }
        .st-chatu8-refboot-textarea {
            width: 100%;
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
            font-size: 13px;
            color: #dce8ee;
            line-height: 1.45;
        }
        .st-chatu8-refboot-status[data-kind="error"] { color: #ffc2b8; }
        .st-chatu8-refboot-status[data-kind="ok"] { color: #c9f7d4; }
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
                padding: max(8px, env(safe-area-inset-top)) 8px max(8px, env(safe-area-inset-bottom));
            }
            .st-chatu8-refboot-dialog {
                width: calc(100vw - 16px);
                max-height: calc(100dvh - 16px);
            }
            .st-chatu8-refboot-header,
            .st-chatu8-refboot-footer {
                padding: 10px 12px;
            }
            .st-chatu8-refboot-body { grid-template-columns: 1fr; }
            .st-chatu8-refboot-preview { min-height: min(260px, 34dvh); }
            .st-chatu8-refboot-actions { margin-left: 0; width: 100%; }
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
                        <label class="st-chatu8-refboot-label">中文设定稿
                            <textarea class="st-chatu8-refboot-textarea st-chatu8-refboot-cn">${escapeHtml(bootstrapData.referencePromptCN)}</textarea>
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
            try {
                setBusy(true);
                setStatus('正在翻译并整理提示词...');
                en.value = await translatePromptToEnglish(cn.value, meta, request);
                setStatus('提示词已更新，可以生成首图。', 'ok');
            } catch (error) {
                setStatus(error?.message || String(error), 'error');
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
    const referenceProblem = await getReferenceProblem(request, meta);
    if (!referenceProblem) {
        return request;
    }
    context?.traceStep?.(context.trace, 'workflow', 'running', {
        reference_bootstrap: referenceProblem.reason,
        character: meta.displayName,
        reference_paths: referenceProblem.paths,
    });
    const bootstrapData = await generateBootstrapData(meta, request);
    let result;
    try {
        result = await showBootstrapDialog(meta, request, bootstrapData);
    } catch (error) {
        if (error?.stChatu8Canceled || error?.name === 'AbortError') {
            context?.traceStep?.(context.trace, 'workflow', 'skipped', {
                reference_bootstrap: 'canceled',
                character: meta.displayName,
            });
            return request;
        }
        throw error;
    }
    context?.traceStep?.(context.trace, 'workflow', 'done', {
        reference_bootstrap: 'bound',
        character: meta.displayName,
        preset_id: result.presetId,
        outfit_id: result.outfitId,
        reference_path: result.referencePath,
    });
    return {
        ...request,
        debugReferenceBootstrap: {
            presetId: result.presetId,
            outfitId: result.outfitId,
            referencePath: result.referencePath,
            version: BOOTSTRAP_VERSION,
        },
    };
}
