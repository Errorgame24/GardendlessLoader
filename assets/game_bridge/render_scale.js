(function () {
  "use strict";
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
      return Math.min(ratio, 2.0);
    }
  });
})();
