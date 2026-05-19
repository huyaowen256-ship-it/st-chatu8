const ANCHOR_PROTOCOL_VERSION = '20260519_legacy_image_anchor_ui_v1';

const IMAGE_PREVIEW_FIX_VERSION = '20260519_legacy_image_anchor_ui_v1';
const IMAGE_PREVIEW_FIX_STYLE_ID = 'st-chatu8-image-preview-fix-style';
const IMAGE_PREVIEW_LIGHTBOX_ID = 'st-chatu8-image-lightbox-fallback';
const installedPreviewFixDocuments = new WeakSet();

import(`./comfy_reference_simple.js?v=${ANCHOR_PROTOCOL_VERSION}`).catch((error) => {
    console.error('[st-chatu8] Failed to load simple reference mode:', error);
});

import(`./chatu8_anchor_protocol.js?v=${ANCHOR_PROTOCOL_VERSION}`).catch((error) => {
    console.error('[st-chatu8] Failed to load image anchor protocol:', error);
});

installImagePreviewFix();

function installImagePreviewFix() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    installImagePreviewFixInDocument(document);
    observePreviewFixFrames(document);
}

function installImagePreviewFixInDocument(doc) {
    if (!doc || installedPreviewFixDocuments.has(doc)) return;
    installedPreviewFixDocuments.add(doc);

    const run = () => {
        injectImagePreviewFixStyle(doc);
        markReadablePromptDialogs(doc);
        repairPreviewDialogs(doc);
        installPreviewClickFallback(doc);
        observePromptDialogs(doc);
        observePreviewFixFrames(doc);
    };

    if (doc.readyState === 'loading') {
        doc.addEventListener('DOMContentLoaded', run, { once: true });
    } else {
        run();
    }
}

function injectImagePreviewFixStyle(doc) {
    if (doc.getElementById(IMAGE_PREVIEW_FIX_STYLE_ID)) return;

    const style = doc.createElement('style');
    style.id = IMAGE_PREVIEW_FIX_STYLE_ID;
    style.textContent = `
        .st-chatu8-preview-backdrop {
            background-color: rgba(3, 7, 18, 0.9) !important;
            backdrop-filter: blur(2px) !important;
            -webkit-backdrop-filter: blur(2px) !important;
        }

        .st-chatu8-preview-dialog {
            background: #111827 !important;
            color: #f8fafc !important;
            border: 1px solid rgba(167, 139, 250, 0.5) !important;
            box-shadow: 0 18px 55px rgba(0, 0, 0, 0.58) !important;
        }

        .st-chatu8-preview-image-container {
            background: transparent !important;
        }

        .st-chatu8-preview-large-image,
        .st-chatu8-preview-image-container img {
            display: block !important;
            opacity: 1 !important;
            visibility: visible !important;
            max-width: 100% !important;
            max-height: 100% !important;
            object-fit: contain !important;
            background: transparent !important;
        }

        .st-chatu8-prompt-readable-fixed,
        .st-chatu8-prompt-readable-fixed * {
            color: #f8fafc !important;
            text-shadow: none !important;
            opacity: 1 !important;
        }

        .st-chatu8-prompt-readable-fixed {
            background: #161424 !important;
            border: 1px solid rgba(167, 139, 250, 0.62) !important;
            box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55) !important;
        }

        .st-chatu8-prompt-readable-fixed textarea,
        .st-chatu8-prompt-readable-fixed pre,
        .st-chatu8-prompt-readable-fixed code,
        body > div[style*="position: fixed"] textarea,
        body > div[style*="position:fixed"] textarea {
            background: #0f172a !important;
            color: #f8fafc !important;
            border: 1px solid rgba(167, 139, 250, 0.7) !important;
            caret-color: #f8fafc !important;
            box-shadow: inset 0 0 0 1px rgba(15, 23, 42, 0.45) !important;
            text-shadow: none !important;
            opacity: 1 !important;
        }

        .st-chatu8-prompt-readable-fixed textarea::selection,
        body > div[style*="position: fixed"] textarea::selection,
        body > div[style*="position:fixed"] textarea::selection {
            background: rgba(167, 139, 250, 0.45) !important;
            color: #ffffff !important;
        }

        .st-chatu8-prompt-readable-fixed button,
        body > div[style*="position: fixed"] textarea ~ button,
        body > div[style*="position:fixed"] textarea ~ button {
            background: #312e81 !important;
            color: #ffffff !important;
            border: 1px solid rgba(196, 181, 253, 0.75) !important;
            opacity: 1 !important;
            text-shadow: none !important;
        }

        .st-chatu8-prompt-readable-fixed button:disabled {
            color: #d1d5db !important;
            opacity: 0.58 !important;
        }

        #${IMAGE_PREVIEW_LIGHTBOX_ID} {
            position: fixed !important;
            inset: 0 !important;
            z-index: 2147483600 !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            padding: 24px !important;
            box-sizing: border-box !important;
            background: rgba(3, 7, 18, 0.94) !important;
            cursor: zoom-out !important;
        }

        #${IMAGE_PREVIEW_LIGHTBOX_ID} img,
        #${IMAGE_PREVIEW_LIGHTBOX_ID} video {
            max-width: min(96vw, 1440px) !important;
            max-height: 94vh !important;
            width: auto !important;
            height: auto !important;
            object-fit: contain !important;
            background: #020617 !important;
            border-radius: 6px !important;
            box-shadow: 0 22px 70px rgba(0, 0, 0, 0.68) !important;
            cursor: default !important;
        }

        #${IMAGE_PREVIEW_LIGHTBOX_ID} .st-chatu8-image-lightbox-close {
            position: fixed !important;
            top: 16px !important;
            right: 18px !important;
            width: 38px !important;
            height: 38px !important;
            border-radius: 6px !important;
            border: 1px solid rgba(255, 255, 255, 0.28) !important;
            background: rgba(15, 23, 42, 0.92) !important;
            color: #ffffff !important;
            font-size: 24px !important;
            line-height: 1 !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            cursor: pointer !important;
            opacity: 1 !important;
        }

        .mes_text .st-chatu8-image-container img,
        .mes_text .st-chatu8-generated-image-wrap img,
        .mes_text .st-chatu8-image-result img,
        .mes_text .chatu8-image-result img,
        .mes_text [data-image-request-id] img,
        .mes_text img[src^="data:image"],
        .mes_text img[src^="blob:"] {
            cursor: zoom-in !important;
        }
    `;
    (doc.head || doc.documentElement).appendChild(style);
}

function installPreviewClickFallback(doc) {
    doc.addEventListener('click', (event) => {
        const target = event.target;
        const view = doc.defaultView || window;
        if (!(target instanceof view.Element)) return;
        if (target.closest(`#${IMAGE_PREVIEW_LIGHTBOX_ID}`)) return;
        if (target.closest('#st-chatu8-settings, textarea, input, select, button, .menu_button, .st-chatu8-preview-action-button, .st-chatu8-preview-close')) return;

        const media = findPreviewableMedia(target);
        if (!media) return;

        event.preventDefault();
        event.stopPropagation();
        showFallbackLightbox(doc, media);
    }, true);
}

function findPreviewableMedia(target) {
    const view = target.ownerDocument?.defaultView || window;
    const root = target.closest('.mes_text, .mes, #chat, #chat_display, .st-chatu8-image-container, .st-chatu8-generated-image-wrap, .st-chatu8-image-result, .chatu8-image-result, [data-image-request-id]');
    if (!root) return null;
    if (target.closest('.avatar, .avatar-container, #avatar_div, .ch_name, .mes_buttons')) return null;

    const mediaElement = target.closest('img, video, canvas, [style*="background-image"]') || root.querySelector('img, video, canvas, [style*="background-image"]');
    if (!(mediaElement instanceof view.Element)) return null;

    const rect = mediaElement.getBoundingClientRect();
    const isKnownGeneratedImage = Boolean(mediaElement.closest('.st-chatu8-image-container, .st-chatu8-generated-image-wrap, .st-chatu8-image-result, .chatu8-image-result, [data-image-request-id]'));
    if (!isKnownGeneratedImage && rect.width < 120 && rect.height < 120) return null;

    if (mediaElement instanceof view.HTMLImageElement) {
        const src = mediaElement.currentSrc || mediaElement.src;
        if (!isUsableMediaSrc(src)) return null;
        return { type: 'image', src };
    }

    if (mediaElement instanceof view.HTMLVideoElement) {
        const src = mediaElement.currentSrc || mediaElement.src || mediaElement.querySelector('source')?.src;
        if (!src) return null;
        return { type: 'video', src };
    }

    if (mediaElement instanceof view.HTMLCanvasElement) {
        try {
            return { type: 'image', src: mediaElement.toDataURL('image/png') };
        } catch {
            return null;
        }
    }

    const background = view.getComputedStyle(mediaElement).backgroundImage;
    const backgroundSrc = extractBackgroundImageUrl(background);
    if (!isUsableMediaSrc(backgroundSrc)) return null;
    return { type: 'image', src: backgroundSrc };
}

function isUsableMediaSrc(src) {
    if (!src || typeof src !== 'string') return false;
    if (/^data:image\/svg\+xml/i.test(src)) return false;
    return /^(data:image\/|blob:|https?:|\/)/i.test(src);
}

function extractBackgroundImageUrl(value) {
    if (!value || value === 'none') return '';
    const match = value.match(/url\((["']?)(.*?)\1\)/);
    return match?.[2] || '';
}

function showFallbackLightbox(doc, media) {
    doc.getElementById(IMAGE_PREVIEW_LIGHTBOX_ID)?.remove();

    const overlay = doc.createElement('div');
    overlay.id = IMAGE_PREVIEW_LIGHTBOX_ID;
    overlay.dataset.version = IMAGE_PREVIEW_FIX_VERSION;

    const close = doc.createElement('button');
    close.type = 'button';
    close.className = 'st-chatu8-image-lightbox-close';
    close.textContent = 'x';
    close.setAttribute('aria-label', 'Close preview');

    const node = doc.createElement(media.type === 'video' ? 'video' : 'img');
    if (media.type === 'video') {
        node.controls = true;
        node.autoplay = true;
    } else {
        node.alt = 'image preview';
    }
    node.src = media.src;
    node.addEventListener('click', (event) => event.stopPropagation());

    const cleanup = () => {
        overlay.remove();
        doc.removeEventListener('keydown', onKeyDown, true);
    };

    const onKeyDown = (event) => {
        if (event.key === 'Escape') cleanup();
    };

    close.addEventListener('click', cleanup);
    overlay.addEventListener('click', cleanup);
    overlay.append(close, node);
    doc.body.appendChild(overlay);
    doc.addEventListener('keydown', onKeyDown, true);
}

function observePromptDialogs(doc) {
    const view = doc.defaultView || window;
    const Observer = view.MutationObserver || MutationObserver;
    const observer = new Observer((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node instanceof view.Element) {
                    markReadablePromptDialogs(doc, node);
                    repairPreviewDialogs(doc, node);
                    attachPreviewFixFrames(node);
                }
            }
        }
    });
    observer.observe(doc.documentElement, { childList: true, subtree: true });
}

function markReadablePromptDialogs(doc, root = doc) {
    const view = doc.defaultView || window;
    const candidates = new Set();
    const selector = [
        '.st-chatu8-popup-modal',
        '.st-chatu8-content-modal-dialog',
        '.st-chatu8-modal-content',
        '[role="dialog"]',
        'dialog',
        'body > div'
    ].join(',');

    if (root instanceof view.Element && root.matches(selector)) candidates.add(root);
    root.querySelectorAll?.(selector).forEach((element) => candidates.add(element));

    for (const element of candidates) {
        if (isPromptDialogElement(element)) {
            element.classList.add('st-chatu8-prompt-readable-fixed');
        }
    }
}

function isPromptDialogElement(element) {
    if (!element.querySelector('textarea, pre, code')) return false;
    const text = (element.textContent || '').slice(0, 2500);
    if (!/(prompt|提示词|正面|负面)/i.test(text)) return false;

    const rect = element.getBoundingClientRect();
    if (rect.width < 220 || rect.height < 100) return false;

    const view = element.ownerDocument?.defaultView || window;
    const style = view.getComputedStyle(element);
    return style.position === 'fixed'
        || style.position === 'absolute'
        || element.matches('dialog,[role="dialog"],.st-chatu8-popup-modal,.st-chatu8-content-modal-dialog,.st-chatu8-modal-content');
}

function repairPreviewDialogs(doc, root = doc) {
    const view = doc.defaultView || window;
    const dialogs = [];
    if (root instanceof view.Element && root.matches('.st-chatu8-preview-backdrop')) dialogs.push(root);
    root.querySelectorAll?.('.st-chatu8-preview-backdrop').forEach((element) => dialogs.push(element));

    for (const dialog of dialogs) {
        const large = dialog.querySelector('.st-chatu8-preview-large-image, .st-chatu8-preview-image-container img');
        if (!(large instanceof view.HTMLImageElement)) continue;

        const hasBrokenOrEmptyImage = !large.getAttribute('src') || (large.complete && large.naturalWidth === 0);
        if (!hasBrokenOrEmptyImage) continue;

        const fallback = dialog.querySelector('.st-chatu8-preview-thumbnail.active, .st-chatu8-preview-thumbnail');
        if (fallback instanceof view.HTMLImageElement && isUsableMediaSrc(fallback.currentSrc || fallback.src)) {
            large.src = fallback.currentSrc || fallback.src;
        }
    }
}

function observePreviewFixFrames(doc) {
    doc.querySelectorAll('iframe').forEach(attachPreviewFixFrame);
}

function attachPreviewFixFrames(root) {
    if (root.matches?.('iframe')) attachPreviewFixFrame(root);
    root.querySelectorAll?.('iframe').forEach(attachPreviewFixFrame);
}

function attachPreviewFixFrame(frame) {
    const view = frame.ownerDocument?.defaultView || window;
    if (!(frame instanceof view.HTMLIFrameElement)) return;

    const install = () => {
        try {
            if (frame.contentDocument) installImagePreviewFixInDocument(frame.contentDocument);
        } catch {
            // Cross-origin frames are ignored.
        }
    };

    install();
    if (frame.dataset.stChatu8PreviewFixFrameAttached === '1') return;
    frame.dataset.stChatu8PreviewFixFrameAttached = '1';
    frame.addEventListener('load', install);
}
