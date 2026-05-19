import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { extensionName } from './config.js';

export const CHARACTER_REFERENCE_SYSTEM_PROMPT_KEY = 'characterReferenceSystemPrompt';

const FIELD_ID = 'st_chatu8_character_reference_system_prompt';
let boundField = null;
let observerStarted = false;

function getSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    return extension_settings[extensionName];
}

function normalizePrompt(value) {
    return typeof value === 'string' ? value.trim() : '';
}

export function getCharacterReferenceSystemPrompt() {
    return normalizePrompt(getSettings()[CHARACTER_REFERENCE_SYSTEM_PROMPT_KEY]);
}

export function applyCharacterReferenceSystemPrompt(messages) {
    const prompt = getCharacterReferenceSystemPrompt();
    if (!prompt || !Array.isArray(messages)) {
        return messages;
    }

    const nextMessages = messages.map((message) => {
        if (!message || typeof message !== 'object') {
            return message;
        }
        return { ...message };
    });
    const firstMessage = nextMessages[0];

    if (firstMessage && firstMessage.role === 'system') {
        if (typeof firstMessage.content === 'string') {
            const currentContent = firstMessage.content.trim();
            firstMessage.content = currentContent ? `${prompt}\n\n${currentContent}` : prompt;
            return nextMessages;
        }
        return [{ role: 'system', content: prompt }, ...nextMessages];
    }

    return [{ role: 'system', content: prompt }, ...nextMessages];
}

function bindField() {
    if (typeof document === 'undefined') {
        return;
    }

    const field = document.getElementById(FIELD_ID);
    if (!field || field === boundField) {
        return;
    }

    boundField = field;
    field.value = getSettings()[CHARACTER_REFERENCE_SYSTEM_PROMPT_KEY] || '';

    const savePrompt = () => {
        getSettings()[CHARACTER_REFERENCE_SYSTEM_PROMPT_KEY] = field.value || '';
        saveSettingsDebounced();
    };

    field.addEventListener('input', savePrompt);
    field.addEventListener('change', savePrompt);
}

function startBinding() {
    if (typeof document === 'undefined') {
        return;
    }

    bindField();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindField, { once: true });
    }

    if (!observerStarted) {
        observerStarted = true;
        const startObserver = () => {
            if (!document.body) {
                setTimeout(startObserver, 250);
                return;
            }
            new MutationObserver(bindField).observe(document.body, { childList: true, subtree: true });
        };
        startObserver();
    }
}

startBinding();
