import type { ImageAddon } from "@xterm/addon-image";
import { logger } from "../../../lib/logger";

/**
 * Loader for the inline-image addon (Kitty graphics / SIXEL / iTerm IIP).
 *
 * `@xterm/addon-image` instantiates a WebAssembly SIXEL decoder while the package
 * itself is evaluated, so importing it on a runtime without WebAssembly (HarmonyOS
 * ArkWeb V8) throws `ReferenceError: WebAssembly is not defined` before any call
 * site can catch it -- that used to take the whole terminal layer down with it.
 * The addon therefore lives behind a runtime `import()`, gated on WebAssembly being
 * available, and terminals await `loadInlineImageAddon()` before they are created so
 * the addon is still registered right after `term.open()` (it must patch
 * IRenderService.setRenderer before the WebGL renderer exists).
 */
export type InlineImageAddonCtor = typeof ImageAddon;

let imageAddonCtor: InlineImageAddonCtor | null = null;
let loadPromise: Promise<void> | null = null;
let unsupportedLogged = false;

export const isInlineImageAddonSupported = (): boolean =>
  typeof WebAssembly !== "undefined";

export const getInlineImageAddonCtor = (): InlineImageAddonCtor | null => imageAddonCtor;

export const loadInlineImageAddon = (): Promise<void> => {
  if (!isInlineImageAddonSupported()) {
    if (!unsupportedLogged) {
      unsupportedLogged = true;
      logger.warn(
        "[XTerm] Inline image addon disabled: this runtime has no WebAssembly support (SIXEL decoding unavailable)",
      );
    }
    return Promise.resolve();
  }
  if (!loadPromise) {
    loadPromise = import("@xterm/addon-image")
      .then((mod) => {
        imageAddonCtor = mod.ImageAddon;
      })
      .catch((err) => {
        logger.warn("[XTerm] Inline image addon failed to load", err);
      });
  }
  return loadPromise;
};
