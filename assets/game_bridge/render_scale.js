(function () {
  "use strict";
  // Cocos sizes the game canvas by window.devicePixelRatio, so scaling the
  // value it reads shrinks the WebGL back buffer and its GPU memory. Injected
  // after touch_input_adapter.js, which keeps measuring the real ratio.
  const host = window.__gardendlessHost;
  const cfg = host && host.config ? host.config : {};
  const scale = cfg.renderScale;
  const isIOS = cfg.platform === "ios";
  const hasExplicitScale = typeof scale === "number" && scale > 0;
  const real = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");

  let savedScale = null;
  if (typeof window.localStorage !== "undefined") {
    try {
      const raw = Number(window.localStorage.getItem("__ge_render_scale"));
      if (raw >= 0.01 && raw <= 1.0) savedScale = raw;
    } catch (_) {}
  }

  let currentScale = savedScale !== null ? savedScale : (hasExplicitScale ? scale : 1.0);

  if (real && typeof real.get === "function") {
    if (!hasExplicitScale && savedScale === null) {
      // Leave devicePixelRatio untouched when no explicit or saved scale is set.
    } else {
      Object.defineProperty(window, "devicePixelRatio", {
        configurable: true,
        enumerable: real.enumerable,
        get: function () {
          const base = real.get.call(window);
          return base * currentScale;
        }
      });
    }
  }

  // Live 1%–100% resolution controller callable from the in-game watermark HUD.
  window.__gardendlessGetRenderScale = function () {
    return currentScale;
  };

  window.__gardendlessSetRenderScale = function (nextScale) {
    const num = Number(nextScale);
    if (!(num >= 0.01 && num <= 1.0)) return currentScale;
    currentScale = Math.round(num * 100) / 100;
    try {
      if (typeof window.localStorage !== "undefined") {
        window.localStorage.setItem("__ge_render_scale", String(currentScale));
      }
    } catch (_) {}
    if (real && typeof real.get === "function") {
      Object.defineProperty(window, "devicePixelRatio", {
        configurable: true,
        enumerable: real.enumerable,
        get: function () {
          const base = real.get.call(window);
          return base * currentScale;
        }
      });
    }
    try {
      if (typeof window.dispatchEvent === "function" && typeof Event === "function") {
        window.dispatchEvent(new Event("resize"));
      }
    } catch (_) {}
    return currentScale;
  };
})();
