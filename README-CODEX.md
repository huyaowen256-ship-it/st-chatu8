# st-chatu8 ComfyUI Reference Build

This is a personal modified build of `st-chatu8` for SillyTavern.

## Added behavior

- Character presets can store a ComfyUI reference image path.
- Chat text containing a character name can resolve that character preset.
- The resolved path is passed to `%comfyuicankaotupian%`.
- Character identity prompts are injected into the ComfyUI positive prompt.
- Outfit prompts can persist until an explicit outfit change is detected.
- Legacy LLM `<image>` prompt generation is disabled in `comfyui` + `image###` mode.

## Notes

- This repository only contains plugin code.
- SillyTavern user settings, character presets, workflow configuration, API keys, and local image files are not included.
- For a phone client calling a desktop ComfyUI instance, set the ComfyUI URL to the desktop machine address, not `127.0.0.1`.
