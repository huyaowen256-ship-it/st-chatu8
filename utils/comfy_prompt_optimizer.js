import { eventSource } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { extensionName } from './config.js';
import { resolveComfyCharacterReferences } from './characterprompt.js';
import { executeTypedLLMRequest } from './settings/llmService.js';

export const KLEIN_PROMPT_OPTIMIZER_REQUEST_TYPE = 'klein_prompt_optimize';

export const DEFAULT_KLEIN_PROMPT_OPTIMIZER_SYSTEM_PROMPT = `You are a FLUX Klein prompt director for ComfyUI.

Rewrite the user scene into a stable natural-language English image prompt, not a tag pile.
Use image 1 as the character identity reference when a reference image is present.
Manual character traits from the character profile are authoritative. Do not override, simplify, or replace them.
Cached vision traits are supplementary only and must not contradict manual traits.
Preserve concrete scene facts from scene_raw, including character names, actions, clothing, mood, location, and composition requests.
Only add FLUX Klein friendly wording for identity consistency, camera, lighting, composition, rendering style, and reference separation.
Return only JSON with this shape:
{
  "image_role_map": { "image_1": "character_identity" },
  "scene_summary_cn": "",
  "positive_prompt_en": "",
  "positive_prompt_cn": "",
  "negative_prompt": "",
  "stability_notes": []
}`;

const OPTIMIZER_EVENT_NAME = 'st-chatu8-klein-prompt-optimizer-response';
const KLEIN_WORKFLOW_ADAPTER = 'flux2-klein-reference';

const REFUSAL_PATTERNS = [
    /\b(i\s+can't|i cannot|cannot assist|can't assist|unable to assist|as an ai|safety policy|content policy)\b/i,
    /(抱歉|对不起).{0,40}(不能|无法|不可以|没法)/,
    /(我不能|我无法|无法协助|不能协助|拒绝提供)/,
];

function safeString(value, fallback = '') {
    if (value === undefined || value === null) {
        return fallback;
    }

    return String(value).trim();
}

function optimizerSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = {};
    }

    const data = extension_settings[extensionName];
    if (!data.comfyPromptOptimizerRequestType) {
        data.comfyPromptOptimizerRequestType = KLEIN_PROMPT_OPTIMIZER_REQUEST_TYPE;
    }
    if (!data.comfyPromptOptimizerMode) {
        data.comfyPromptOptimizerMode = 'append';
    }
    if (!data.comfyPromptOptimizerSystemPrompt) {
        data.comfyPromptOptimizerSystemPrompt = DEFAULT_KLEIN_PROMPT_OPTIMIZER_SYSTEM_PROMPT;
    }
    if (data.comfyPromptOptimizerFallbackToRaw === undefined) {
        data.comfyPromptOptimizerFallbackToRaw = true;
    }
    if (data.comfyPromptOptimizerUseManualTraits === undefined) {
        data.comfyPromptOptimizerUseManualTraits = true;
    }
    if (data.comfyPromptOptimizerUseVisionTraits === undefined) {
        data.comfyPromptOptimizerUseVisionTraits = false;
    }
    if (!data.comfyPromptOptimizerVisionMode) {
        data.comfyPromptOptimizerVisionMode = 'missing_only';
    }

    return data;
}

function normalizeMode(mode, enabled) {
    if (!enabled) {
        return 'off';
    }

    const value = safeString(mode, 'append');
    if (['raw', 'append', 'optimized'].includes(value)) {
        return value;
    }

    return 'append';
}

function normalizeForCompare(text) {
    return safeString(text).replace(/\s+/g, ' ').toLowerCase();
}

function looksLikeRefusal(text) {
    const value = safeString(text);
    if (!value) {
        return false;
    }

    return REFUSAL_PATTERNS.some((pattern) => pattern.test(value));
}

function extractJson(text) {
    const value = safeString(text)
        .replace(/^```(?:json)?/i, '')
        .replace(/```$/i, '')
        .trim();

    if (!value) {
        return null;
    }

    try {
        return JSON.parse(value);
    } catch (_error) {
        const start = value.indexOf('{');
        const end = value.lastIndexOf('}');
        if (start >= 0 && end > start) {
            try {
                return JSON.parse(value.slice(start, end + 1));
            } catch (__error) {
                return null;
            }
        }
    }

    return null;
}

function pickOptimizedPrompt(output) {
    const parsed = extractJson(output);
    if (parsed && typeof parsed === 'object') {
        return {
            prompt: safeString(
                parsed.positive_prompt_en
                || parsed.positivePromptEn
                || parsed.positive_prompt
                || parsed.prompt
                || parsed.result,
            ),
            parsed,
        };
    }

    return {
        prompt: safeString(output)
            .replace(/^```(?:text)?/i, '')
            .replace(/```$/i, '')
            .trim(),
        parsed: null,
    };
}

function promptValidationFailure(rawPrompt, optimizedPrompt) {
    if (!optimizedPrompt) {
        return 'empty optimizer output';
    }

    if (optimizedPrompt.length < 24) {
        return 'optimizer output is too short';
    }

    if (looksLikeRefusal(optimizedPrompt)) {
        return 'optimizer returned a refusal';
    }

    if (normalizeForCompare(rawPrompt) === normalizeForCompare(optimizedPrompt)) {
        return 'optimizer returned the raw prompt unchanged';
    }

    return '';
}

function compactLines(lines) {
    return lines.map((line) => safeString(line)).filter(Boolean).join('\n');
}

function collectTraitContext(rawPrompt, data) {
    let refs = [];
    try {
        refs = resolveComfyCharacterReferences(rawPrompt);
    } catch (error) {
        console.warn('[st-chatu8] Klein prompt optimizer failed to resolve character traits:', error);
    }

    const useManual = data.comfyPromptOptimizerUseManualTraits !== false;
    const useVision = data.comfyPromptOptimizerUseVisionTraits === true;
    const visionMode = safeString(data.comfyPromptOptimizerVisionMode, 'missing_only');
    const manualBlocks = [];
    const visionBlocks = [];

    for (const ref of refs) {
        const label = safeString(ref?.name || ref?.matchedName || ref?.presetId, 'character');
        const preset = ref?.preset || {};
        const manual = useManual ? safeString(
            preset.comfyIdentityPrompt
            || preset.identityPrompt
            || ref?.positivePrompt,
        ) : '';
        const vision = useVision ? safeString(
            preset.comfyVisionTraitsCache
            || preset.comfyVisionPrompt
            || preset.visionTraits
            || preset.comfyVisionTraits,
        ) : '';

        if (manual) {
            manualBlocks.push(`${label}: ${manual}`);
        }

        if (vision && (visionMode !== 'missing_only' || !manual)) {
            visionBlocks.push(`${label}: ${vision}`);
        }
    }

    return {
        refs,
        manualTraits: compactLines(manualBlocks),
        visionTraits: compactLines(visionBlocks),
    };
}

function buildOptimizerPrompt(rawPrompt, data, context) {
    const traits = collectTraitContext(rawPrompt, data);
    const payload = {
        task: 'optimize_sillytavern_image_anchor_for_flux_klein',
        output_language: 'english_prompt_json',
        image_role_map: {
            image_1: 'character_identity_reference',
        },
        identity_source: traits.manualTraits ? 'manual_character_profile' : (traits.visionTraits ? 'cached_vision_traits' : 'scene_raw_only'),
        manual_character_traits: traits.manualTraits,
        cached_vision_traits: traits.visionTraits,
        scene_raw: rawPrompt,
        final_prompt_policy: {
            mode: normalizeMode(data.comfyPromptOptimizerMode, data.comfyPromptOptimizerEnabled === true),
            raw_scene_will_be_kept_by_plugin: true,
            negative_prompt_default: 'empty',
        },
        context: {
            message_id: context?.messageId ?? '',
            anchor_id: context?.anchor?.id ?? '',
        },
    };

    return [
        safeString(data.comfyPromptOptimizerSystemPrompt, DEFAULT_KLEIN_PROMPT_OPTIMIZER_SYSTEM_PROMPT),
        '',
        'Input JSON:',
        '```json',
        JSON.stringify(payload, null, 2),
        '```',
        '',
        'Return only the JSON object. Do not wrap it in Markdown.',
    ].join('\n');
}

async function executeOptimizerLLM(prompt, requestType) {
    const id = `klein_prompt_optimizer_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const eventName = `${OPTIMIZER_EVENT_NAME}:${id}`;
    let latest = '';
    let eventPayload = null;

    const onResponse = (payload) => {
        if (!payload || payload.id !== id) {
            return;
        }

        eventPayload = payload;
        if (payload.result !== undefined) {
            latest = safeString(payload.result);
        }
    };

    eventSource.on(eventName, onResponse);
    try {
        await executeTypedLLMRequest(
            { id, prompt },
            safeString(requestType, KLEIN_PROMPT_OPTIMIZER_REQUEST_TYPE),
            eventName,
            (value) => {
                latest = safeString(value);
            },
        );
    } finally {
        eventSource.removeListener(eventName, onResponse);
    }

    if (eventPayload && eventPayload.success === false) {
        throw new Error(safeString(eventPayload.result || eventPayload.error, 'Prompt optimizer failed'));
    }

    return safeString(eventPayload?.result || latest);
}

function composeFinalPrompt(rawPrompt, optimizedPrompt, mode) {
    if (mode === 'raw' || !optimizedPrompt) {
        return rawPrompt;
    }

    if (mode === 'optimized') {
        return optimizedPrompt;
    }

    return [
        'Original scene:',
        rawPrompt,
        '',
        'Visual prompt refinement:',
        optimizedPrompt,
    ].join('\n');
}

function withOptimizerDebug(request, fields) {
    return {
        ...request,
        debugPromptRaw: safeString(fields.rawPrompt || request.debugPromptRaw || request.prompt),
        debugPromptOptimized: safeString(fields.optimizedPrompt),
        debugPromptFinal: safeString(fields.finalPrompt || request.prompt),
        debugPromptOptimizerStatus: safeString(fields.status),
        debugPromptOptimizerReason: safeString(fields.reason),
        debugPromptOptimizerParsed: fields.parsed || null,
    };
}

function rawFallback(request, rawPrompt, status, reason, throwOnFailure = false) {
    if (throwOnFailure) {
        throw new Error(`Klein prompt optimizer failed: ${reason}`);
    }

    return withOptimizerDebug(
        {
            ...request,
            prompt: rawPrompt,
        },
        {
            rawPrompt,
            finalPrompt: rawPrompt,
            status,
            reason,
        },
    );
}

export async function optimizeKleinPromptIfNeeded(request, context = {}) {
    const data = optimizerSettings();
    const rawPrompt = safeString(request?.debugPromptRaw || request?.prompt);
    const mode = normalizeMode(data.comfyPromptOptimizerMode, data.comfyPromptOptimizerEnabled === true);

    if (!request || request.workflowAdapter !== KLEIN_WORKFLOW_ADAPTER) {
        return request;
    }

    if (!rawPrompt || mode === 'off' || mode === 'raw') {
        return rawFallback(request, rawPrompt, mode === 'raw' ? 'raw' : 'off', mode === 'raw' ? 'raw passthrough selected' : 'optimizer disabled');
    }

    try {
        const optimizerPrompt = buildOptimizerPrompt(rawPrompt, data, context);
        const output = await executeOptimizerLLM(optimizerPrompt, data.comfyPromptOptimizerRequestType);
        const { prompt: optimizedPrompt, parsed } = pickOptimizedPrompt(output);
        const validationFailure = promptValidationFailure(rawPrompt, optimizedPrompt);
        if (validationFailure) {
            return rawFallback(
                request,
                rawPrompt,
                'fallback_raw',
                validationFailure,
                data.comfyPromptOptimizerFallbackToRaw === false,
            );
        }

        const finalPrompt = composeFinalPrompt(rawPrompt, optimizedPrompt, mode);
        return withOptimizerDebug(
            {
                ...request,
                prompt: finalPrompt,
            },
            {
                rawPrompt,
                optimizedPrompt,
                finalPrompt,
                status: mode === 'optimized' ? 'optimized_only' : 'optimized_append',
                reason: 'ok',
                parsed,
            },
        );
    } catch (error) {
        console.warn('[st-chatu8] Klein prompt optimizer failed; using raw prompt.', error);
        return rawFallback(
            request,
            rawPrompt,
            'fallback_raw',
            error?.message || String(error),
            data.comfyPromptOptimizerFallbackToRaw === false,
        );
    }
}
