const IMPORT_INPUTS = {
    worker_import: 'worker_import_file',
    edit_worker_import: 'edit_worker_import_file',
};

function getImportButton(target) {
    return target?.closest?.('#worker_import, #edit_worker_import') || null;
}

function openImportPicker(button) {
    const inputId = IMPORT_INPUTS[button?.id];
    const input = inputId ? document.getElementById(inputId) : null;
    if (!input) {
        return false;
    }
    input.value = '';
    window.setTimeout(() => input.click(), 0);
    return true;
}

function stabilizeWorkflowImportClicks(event) {
    const button = getImportButton(event.target);
    if (!button || button.disabled) {
        return;
    }
    if (!openImportPicker(button)) {
        return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
}

if (typeof document !== 'undefined') {
    document.addEventListener('click', stabilizeWorkflowImportClicks, true);
}
