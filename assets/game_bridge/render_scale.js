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
  if (isIOS && typeof window.localStorage !== "undefined") {
    try {
      const raw = Number(window.localStorage.getItem("__ge_render_scale"));
      if (raw >= 0.01 && raw <= 1.0) savedScale = raw;
    } catch (_) {}
  }

  let currentScale = savedScale !== null ? savedScale : (hasExplicitScale ? scale : 1.0);

  if (real && typeof real.get === "function") {
    if (!hasExplicitScale && !isIOS) {
      // Leave devicePixelRatio untouched on non-iOS when no explicit scale is set.
    } else {
      Object.defineProperty(window, "devicePixelRatio", {
        configurable: true,
        enumerable: real.enumerable,
        get: function () {
          const base = real.get.call(window);
          if (hasExplicitScale && savedScale === null) {
            return base * currentScale;
          }
          // On iOS, cap default native DPR at 2.0x Retina (saves 56% WebGL backbuffer
          // RAM vs 3.0x Super Retina while keeping text crisp) and multiply by currentScale.
          const cappedBase = isIOS ? Math.min(base, 2.0) : base;
          return Math.max(0.02, cappedBase * currentScale);
        }
      });
    }
  }

  // Live 1%–100% resolution controller callable from the in-game Lain watermark HUD.
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
    try {
      if (typeof window.dispatchEvent === "function" && typeof Event === "function") {
        window.dispatchEvent(new Event("resize"));
      }
    } catch (_) {}
    return currentScale;
  };

  if (!isIOS) return;

  // 1. ProMotion 120Hz Thermal Frame Pacer (defaults to 60 FPS, configurable 30/45/60 FPS).
  let targetFps = 60;
  try {
    if (typeof window.localStorage !== "undefined") {
      const savedFps = Number(window.localStorage.getItem("__ge_target_fps"));
      if (savedFps === 30 || savedFps === 45 || savedFps === 60) targetFps = savedFps;
    }
  } catch (_) {}

  window.__gardendlessGetTargetFps = function () {
    return targetFps;
  };

  window.__gardendlessSetTargetFps = function (fps) {
    const n = Number(fps);
    if (n === 30 || n === 45 || n === 60) {
      targetFps = n;
      try {
        if (typeof window.localStorage !== "undefined") {
          window.localStorage.setItem("__ge_target_fps", String(n));
        }
      } catch (_) {}
    }
    return targetFps;
  };

  if (typeof window.requestAnimationFrame === "function") {
    const nativeRaf = window.requestAnimationFrame.bind(window);
    let lastFrameTime = 0;
    window.requestAnimationFrame = function (callback) {
      return nativeRaf(function step(timestamp) {
        const minInterval = targetFps === 30 ? 31.5 : (targetFps === 45 ? 20.5 : 14.2);
        if (timestamp - lastFrameTime < minInterval) {
          nativeRaf(step);
          return;
        }
        lastFrameTime = timestamp;
        callback(timestamp);
      });
    };
  }

  // 2. Limit concurrent createImageBitmap decodes to 2 to prevent decode memory spikes.
  if (typeof window.createImageBitmap === "function") {
    const nativeCreateImageBitmap = window.createImageBitmap.bind(window);
    let activeDecodes = 0;
    const decodeQueue = [];
    const maxConcurrentDecodes = 2;

    function pumpDecodeQueue() {
      while (activeDecodes < maxConcurrentDecodes && decodeQueue.length > 0) {
        const job = decodeQueue.shift();
        activeDecodes++;
        nativeCreateImageBitmap.apply(window, job.args).then(
          function (bitmap) {
            activeDecodes--;
            pumpDecodeQueue();
            job.resolve(bitmap);
          },
          function (err) {
            activeDecodes--;
            pumpDecodeQueue();
            job.reject(err);
          }
        );
      }
    }

    window.createImageBitmap = function () {
      const args = Array.prototype.slice.call(arguments);
      return new Promise(function (resolve, reject) {
        decodeQueue.push({ args: args, resolve: resolve, reject: reject });
        pumpDecodeQueue();
      });
    };
  }

  // 3. Release CPU-side ImageBitmap backing store 16ms after WebGL upload, and convert
  // large sprite sheets (>= 256x256) to 16-bit RGBA4 (0x8056) to save 50% VRAM while
  // keeping smaller text/UI labels (< 256px height) at lossless 32-bit RGBA8.
  function patchWebGLPrototype(proto) {
    if (!proto || proto.__gardendlessPatched) return;
    proto.__gardendlessPatched = true;

    const origTexImage2D = proto.texImage2D;
    if (typeof origTexImage2D === "function") {
      proto.texImage2D = function () {
        const args = Array.prototype.slice.call(arguments);
        const source = args.length === 6 ? args[5] : (args.length >= 9 ? args[8] : null);
        if (source && typeof source.width === "number" && typeof source.height === "number") {
          const isLargeSpriteSheet = source.width >= 256 && source.height >= 256;
          if (isLargeSpriteSheet && args[3] === 0x1908 && args[4] === 0x1401) {
            if (args[2] === 0x1908 || args[2] === 0x8058) {
              args[2] = 0x8056; // RGBA4 (16-bit) for large atlases
            }
          }
        }
        const result = origTexImage2D.apply(this, args);
        if (source && typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap) {
          setTimeout(function () {
            try { source.close(); } catch (_) {}
          }, 16);
        }
        return result;
      };
    }

    const origTexSubImage2D = proto.texSubImage2D;
    if (typeof origTexSubImage2D === "function") {
      proto.texSubImage2D = function () {
        const result = origTexSubImage2D.apply(this, arguments);
        const source = arguments.length === 7 ? arguments[6] : null;
        if (source && typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap) {
          setTimeout(function () {
            try { source.close(); } catch (_) {}
          }, 16);
        }
        return result;
      };
    }
  }

  if (typeof WebGLRenderingContext !== "undefined") {
    patchWebGLPrototype(WebGLRenderingContext.prototype);
  }
  if (typeof WebGL2RenderingContext !== "undefined") {
    patchWebGLPrototype(WebGL2RenderingContext.prototype);
  }

  // 4. Deduplicate repetitive Cocos console.warn/error messages to avoid IPC bridging overhead.
  if (typeof window.console === "object" && window.console) {
    ["warn", "error"].forEach(function (method) {
      const orig = window.console[method];
      if (typeof orig !== "function") return;
      let lastMsg = "";
      let repeatCount = 0;
      window.console[method] = function () {
        const first = arguments.length > 0 ? String(arguments[0]) : "";
        if (first && first === lastMsg) {
          repeatCount++;
          if (repeatCount > 2) return;
        } else {
          lastMsg = first;
          repeatCount = 0;
        }
        return orig.apply(this, arguments);
      };
    });
  }

  // 5. Explicitly release WebGL contexts on pagehide/beforeunload so restarts never stack VRAM.
  if (typeof HTMLCanvasElement !== "undefined" && HTMLCanvasElement.prototype.getContext) {
    const trackedGlContexts = new Set();
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type) {
      const ctx = origGetContext.apply(this, arguments);
      if (ctx && (type === "webgl" || type === "webgl2" || type === "experimental-webgl")) {
        trackedGlContexts.add(ctx);
      }
      return ctx;
    };
    const releaseAllGl = function () {
      trackedGlContexts.forEach(function (ctx) {
        try {
          const ext = ctx.getExtension("WEBGL_lose_context");
          if (ext) ext.loseContext();
        } catch (_) {}
      });
      trackedGlContexts.clear();
    };
    if (typeof window.addEventListener === "function") {
      window.addEventListener("pagehide", releaseAllGl);
      window.addEventListener("beforeunload", releaseAllGl);
    }
  }
})();
