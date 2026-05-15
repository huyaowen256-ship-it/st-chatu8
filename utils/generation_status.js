const currentlyGenerating = new Set();
const recentlyFinished = new Map();

const RECENT_GENERATION_TTL_MS = 120000;

function normalizeGenerationKey(prompt) {
    return String(prompt ?? '').trim();
}

function pruneRecentlyFinished(now = Date.now()) {
    for (const [key, finishedAt] of recentlyFinished.entries()) {
        if (now - finishedAt > RECENT_GENERATION_TTL_MS) {
            recentlyFinished.delete(key);
        }
    }
}

export function isGenerating(prompt) {
    const key = normalizeGenerationKey(prompt);
    if (!key) {
        return false;
    }

    const now = Date.now();
    pruneRecentlyFinished(now);

    if (currentlyGenerating.has(key)) {
        return true;
    }

    const finishedAt = recentlyFinished.get(key);
    return typeof finishedAt === 'number' && now - finishedAt <= RECENT_GENERATION_TTL_MS;
}

export function startGenerating(prompt) {
    const key = normalizeGenerationKey(prompt);
    if (!key) {
        return;
    }

    pruneRecentlyFinished();
    currentlyGenerating.add(key);
}

export function stopGenerating(prompt) {
    const key = normalizeGenerationKey(prompt);
    if (!key) {
        return;
    }

    currentlyGenerating.delete(key);
    recentlyFinished.set(key, Date.now());
    pruneRecentlyFinished();
}
