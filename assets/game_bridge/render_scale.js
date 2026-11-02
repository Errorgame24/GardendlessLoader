(function () {
  "use strict";
  // Cocos sizes the game canvas by window.devicePixelRatio, so scaling the
  // value it reads shrinks the WebGL back buffer and its GPU memory. Injected
  // after touch_input_adapter.js, which keeps measuring the real ratio.
  const host = window.__gardendlessHost;
  const config = host && host.config ? host.config : {};
  const scale = config.renderScale;
  const isIos = config.platform === "ios";
  if ((typeof scale !== "number" || !(scale > 0)) && !isIos) return;
  const real = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
  if (!real || typeof real.get !== "function") return;
  Object.defineProperty(window, "devicePixelRatio", {
    configurable: true,
    enumerable: real.enumerable,
    get: function () {
      const ratio = real.get.call(window);
      if (!isIos) {
        return ratio * scale;
      }
      if (typeof scale === "number" && scale > 0) {
        if (scale <= 0.5) return Math.min(ratio * scale, 1.25);
        if (scale <= 0.75) return Math.min(ratio * scale, 1.6);
        return Math.min(ratio * scale, 2.0);
      }
      // Launcher 100% (scale === null): 2.0x Retina HD (4x more pixels than 1.0x, 56% less VRAM than 3.0x)
      return Math.min(ratio, 2.0);
    }
  });
})();
