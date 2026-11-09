(function () {
  "use strict";
  const host = window.__gardendlessHost;
  const config = host && host.config ? host.config : {};
  const initialScale = config.renderScale;
  const isIos = config.platform === "ios";
  if ((typeof initialScale !== "number" || !(initialScale > 0)) && !isIos) return;
  const real = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
  if (!real || typeof real.get !== "function") return;

  let liveScale = (typeof initialScale === "number" && initialScale > 0) ? initialScale : 1.0;
  let liveFpsCap = liveScale <= 0.5 ? 30 : (liveScale <= 0.8 ? 48 : 60);

  window.__gardendlessGetRenderState = function () {
    return {
      percent: Math.max(1, Math.min(100, Math.round(liveScale * 100))),
      fpsCap: liveFpsCap
    };
  };

  window.__gardendlessSetLiveRenderScale = function (percent, fpsCap) {
    if (typeof percent === "number" && Number.isFinite(percent)) {
      liveScale = Math.max(0.01, Math.min(1.0, percent / 100));
    }
    if (typeof fpsCap === "number" && fpsCap >= 15) {
      liveFpsCap = fpsCap;
    }
    try {
      window.dispatchEvent(new Event("resize"));
    } catch (_) {}
  };

  Object.defineProperty(window, "devicePixelRatio", {
    configurable: true,
    enumerable: real.enumerable,
    get: function () {
      const ratio = real.get.call(window);
      if (!isIos) {
        return ratio * liveScale;
      }
      const baseRetina = Math.min(ratio, 2.0);
      return Math.max(0.02, baseRetina * liveScale);
    }
  });

  if (isIos && typeof window.requestAnimationFrame === "function") {
    const origRAF = window.requestAnimationFrame;
    let lastFrameTime = 0;
    window.requestAnimationFrame = function (callback) {
      if (typeof callback !== "function") {
        return origRAF.apply(window, arguments);
      }
      return origRAF.call(window, function step(timestamp) {
        const minFrameMs = liveFpsCap <= 30 ? 32.0 : (liveFpsCap <= 48 ? 19.8 : 15.5);
        if (lastFrameTime > 0 && (timestamp - lastFrameTime) < minFrameMs) {
          origRAF.call(window, step);
          return;
        }
        lastFrameTime = timestamp;
        callback(timestamp);
      });
    };
  }
})();
