(function () {
  "use strict";
  // Cocos sizes the game canvas by window.devicePixelRatio, so scaling the
  // value it reads shrinks the WebGL back buffer and its GPU memory. Injected
  // after touch_input_adapter.js, which keeps measuring the real ratio.
  const host = window.__gardendlessHost;
  const config = host && host.config ? host.config : {};
  const scale = config.renderScale;
  const isIosDefault = (typeof scale !== "number" || !(scale > 0)) && config.platform === "ios";
  if ((typeof scale !== "number" || !(scale > 0)) && !isIosDefault) return;
  const real = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
  if (!real || typeof real.get !== "function") return;
  Object.defineProperty(window, "devicePixelRatio", {
    configurable: true,
    enumerable: real.enumerable,
    get: function () {
      const ratio = real.get.call(window);
      if (typeof scale === "number" && scale > 0) {
        return ratio * scale;
      }
      return Math.min(ratio, 1.5);
    }
  });
})();
