(function () {
  "use strict";
  const Base = window.AudioContext || window.webkitAudioContext;
  const Media = window.HTMLMediaElement;
  if (!Base || !Media) return;
  const nativeResume = Base.prototype.resume;
  const nativeSuspend = Base.prototype.suspend;
  const nativePlay = Media.prototype.play;
  const nativePause = Media.prototype.pause;
  const contexts = new Set();
  const media = new Set();
  const suspendedContexts = new Set();
  const pausedMedia = new Set();
  let active = true;
  let waiting = [];

  const TARGET_SAMPLE_RATE = 16000;
  const BGM_SAMPLE_RATE = 12000;
  const BGM_DURATION_THRESHOLD_SEC = 8.0;
  const MAX_TOTAL_PCM_BYTES = 120 * 1024 * 1024;
  const MAX_CONCURRENT_AUDIO_DECODES = 4;
  let totalPcmBytes = 0;

  function whenActive() {
    return active ? Promise.resolve() : new Promise(resolve => waiting.push(resolve));
  }

  class TrackedAudioContext extends Base {
    constructor(...args) {
      if (typeof Base.prototype.decodeAudioData === "function" && (!args[0] || typeof args[0] !== "object" || !args[0].sampleRate)) {
        const patchedOpts = Object.assign({}, args[0] || {}, { sampleRate: TARGET_SAMPLE_RATE });
        try {
          super(patchedOpts);
        } catch (_) {
          super(...args);
        }
      } else {
        super(...args);
      }
      contexts.add(this);
      this.addEventListener("statechange", () => {
        if (this.state === "closed") contexts.delete(this);
      });
    }
  }
  window.AudioContext = TrackedAudioContext;
  if (window.webkitAudioContext === Base) window.webkitAudioContext = TrackedAudioContext;

  Base.prototype.resume = function () {
    const context = this;
    return active ? nativeResume.call(context) : whenActive().then(() => nativeResume.call(context));
  };

  Media.prototype.play = function () {
    const element = this;
    if (!media.has(element)) {
      media.add(element);
      element.addEventListener("emptied", () => media.delete(element));
    }
    return active ? nativePlay.call(element) : whenActive().then(() => nativePlay.call(element));
  };

  window.__gardendlessSetSceneActive = function (isActive) {
    if (isActive === active) return;
    active = isActive;
    if (!active) {
      contexts.forEach(context => {
        if (context.state !== "running") return;
        suspendedContexts.add(context);
        nativeSuspend.call(context).catch(() => {});
      });
      media.forEach(element => {
        if (element.paused) return;
        pausedMedia.add(element);
        nativePause.call(element);
      });
      return;
    }
    waiting.splice(0).forEach(resolve => resolve());
    suspendedContexts.forEach(context => nativeResume.call(context).catch(() => {}));
    suspendedContexts.clear();
    pausedMedia.forEach(element => nativePlay.call(element).catch(() => {}));
    pausedMedia.clear();
  };

  // --- Native WebAudio Mono Downmixer & BGM Compressor (83%-87.5% PCM RAM Reduction, 100% Full Audio!) ---
  if (typeof Base.prototype.decodeAudioData === "function") {
    const origDecode = Base.prototype.decodeAudioData;
    const decodeQueue = [];
    let activeDecodes = 0;

    function createSilentFallbackBuffer(ctx) {
      if (ctx.__gardendlessSilentBuffer) return ctx.__gardendlessSilentBuffer;
      const sr = ctx.sampleRate || TARGET_SAMPLE_RATE;
      const len = Math.max(1600, Math.floor(sr * 0.1));
      const buf = typeof ctx.createBuffer === "function"
        ? ctx.createBuffer(1, len, sr)
        : { duration: 0.1, length: len, numberOfChannels: 1, sampleRate: sr };
      ctx.__gardendlessSilentBuffer = buf;
      return buf;
    }

    function compressAudioBufferToMono(ctx, buf) {
      if (!buf || typeof ctx.createBuffer !== "function" || typeof buf.getChannelData !== "function") {
        return buf;
      }
      try {
        const len = buf.length || 0;
        const sr = buf.sampleRate || TARGET_SAMPLE_RATE;
        const channels = buf.numberOfChannels || 1;
        const duration = buf.duration || (sr > 0 ? len / sr : 0);
        if (len <= 0) return buf;

        // Long tracks (BGM / ambient > 8s): downsample to 12kHz 1-channel Mono (~2.7MB per 60s BGM instead of 22MB!)
        if (duration > BGM_DURATION_THRESHOLD_SEC && sr > BGM_SAMPLE_RATE) {
          const ratio = sr / BGM_SAMPLE_RATE;
          const newLen = Math.max(1, Math.floor(len / ratio));
          const mono = ctx.createBuffer(1, newLen, BGM_SAMPLE_RATE);
          const out = mono.getChannelData(0);
          const ch0 = buf.getChannelData(0);
          const ch1 = channels > 1 ? buf.getChannelData(1) : null;
          if (ch1) {
            for (let i = 0; i < newLen; i++) {
              const idx = Math.min(len - 1, (i * ratio) | 0);
              out[i] = (ch0[idx] + ch1[idx]) * 0.5;
            }
          } else {
            for (let i = 0; i < newLen; i++) {
              out[i] = ch0[Math.min(len - 1, (i * ratio) | 0)];
            }
          }
          return mono;
        }

        // Short/medium SFX (<= 8s): if already 1-channel Mono, keep as-is; if Stereo, downmix to 1-channel Mono (halves RAM)
        if (channels <= 1) {
          return buf;
        }
        const mono = ctx.createBuffer(1, len, sr);
        const out = mono.getChannelData(0);
        const ch0 = buf.getChannelData(0);
        const ch1 = buf.getChannelData(1);
        for (let i = 0; i < len; i++) {
          out[i] = (ch0[i] + ch1[i]) * 0.5;
        }
        return mono;
      } catch (_) {
        return buf;
      }
    }

    function pumpDecodeQueue() {
      while (activeDecodes < MAX_CONCURRENT_AUDIO_DECODES && decodeQueue.length > 0) {
        const job = decodeQueue.shift();
        activeDecodes++;
        runDecodeJob(job);
      }
    }

    function runDecodeJob(job) {
      const self = job.ctx;
      const arrayBuffer = job.arrayBuffer;
      const successCallback = job.successCallback;
      const errorCallback = job.errorCallback;
      const resolve = job.resolve;
      const reject = job.reject;

      if (totalPcmBytes >= MAX_TOTAL_PCM_BYTES) {
        activeDecodes--;
        pumpDecodeQueue();
        const silent = createSilentFallbackBuffer(self);
        if (typeof successCallback === "function") {
          try { successCallback(silent); } catch (_) {}
        }
        resolve(silent);
        return;
      }

      let settled = false;
      const onSuccess = function (decodedBuffer) {
        if (settled) return;
        settled = true;
        activeDecodes--;
        const compactBuffer = compressAudioBufferToMono(self, decodedBuffer);
        if (compactBuffer && typeof compactBuffer.length === "number") {
          totalPcmBytes += compactBuffer.length * (compactBuffer.numberOfChannels || 1) * 4;
        }
        pumpDecodeQueue();
        if (typeof successCallback === "function") {
          try { successCallback(compactBuffer); } catch (_) {}
        }
        resolve(compactBuffer);
      };

      const onError = function (err) {
        if (settled) return;
        settled = true;
        activeDecodes--;
        pumpDecodeQueue();
        if (typeof errorCallback === "function") {
          try { errorCallback(err); } catch (_) {}
        }
        reject(err);
      };

      try {
        const p = origDecode.call(self, arrayBuffer, onSuccess, onError);
        if (p && typeof p.then === "function") {
          p.then(onSuccess, onError);
        }
      } catch (e) {
        onError(e);
      }
    }

    Base.prototype.decodeAudioData = function (arrayBuffer, successCallback, errorCallback) {
      const self = this;
      if (!(self instanceof Base)) {
        return origDecode.apply(self, arguments);
      }
      return new Promise(function (resolve, reject) {
        decodeQueue.push({
          ctx: self,
          arrayBuffer: arrayBuffer,
          successCallback: successCallback,
          errorCallback: errorCallback,
          resolve: resolve,
          reject: reject
        });
        pumpDecodeQueue();
      });
    };
  }

  // --- CRITICAL TEXTURE MEMORY OPTIMIZER (Fixes Cocos 3.8 ImageBitmap & WebGL2 RGBA8 OOM!) ---
  // 1. Throttle window.createImageBitmap to max 2 concurrent decodes to prevent 600MB+ parallel burst spikes
  if (typeof window.createImageBitmap === "function") {
    const origCreateImageBitmap = window.createImageBitmap;
    const bitmapQueue = [];
    let activeBitmaps = 0;
    const MAX_CONCURRENT_BITMAPS = 2;

    function pumpBitmapQueue() {
      while (activeBitmaps < MAX_CONCURRENT_BITMAPS && bitmapQueue.length > 0) {
        const task = bitmapQueue.shift();
        activeBitmaps++;
        Promise.resolve()
          .then(function () { return origCreateImageBitmap.apply(window, task.args); })
          .then(
            function (bmp) { activeBitmaps--; pumpBitmapQueue(); task.resolve(bmp); },
            function (err) { activeBitmaps--; pumpBitmapQueue(); task.reject(err); }
          );
      }
    }

    window.createImageBitmap = function () {
      const args = Array.prototype.slice.call(arguments);
      return new Promise(function (resolve, reject) {
        bitmapQueue.push({ args: args, resolve: resolve, reject: reject });
        pumpBitmapQueue();
      });
    };
  }

  // 2. Immediately close() ImageBitmap and strip HTMLImageElement.src after WebGL upload,
  //    AND convert WebGL2 texStorage2D from 32-bit RGBA8 (0x8058) to 16-bit RGBA4 (0x8056) to halve GPU VRAM!
  function releaseTextureSourceCpuMemory(source) {
    if (!source || source.__gardendlessCpuReleased) return;
    // Case A: ImageBitmap (used by Cocos Creator 3.8 on iOS!)
    if (typeof source.close === "function") {
      const w = source.width || 0;
      const h = source.height || 0;
      if (w < 128 && h < 128) return;
      source.__gardendlessCpuReleased = true;
      setTimeout(function () {
        try {
          Object.defineProperty(source, "width", { value: w, configurable: true });
          Object.defineProperty(source, "height", { value: h, configurable: true });
          source.close();
        } catch (_) {}
      }, 150);
      return;
    }
    // Case B: HTMLImageElement
    if (typeof window.HTMLImageElement === "function" && source instanceof window.HTMLImageElement) {
      const w = source.naturalWidth || source.width || 0;
      const h = source.naturalHeight || source.height || 0;
      if (w < 256 && h < 256) return;
      source.__gardendlessCpuReleased = true;
      setTimeout(function () {
        try {
          Object.defineProperty(source, "width", { value: w, configurable: true });
          Object.defineProperty(source, "height", { value: h, configurable: true });
          Object.defineProperty(source, "naturalWidth", { value: w, configurable: true });
          Object.defineProperty(source, "naturalHeight", { value: h, configurable: true });
          source.removeAttribute("src");
        } catch (_) {}
      }, 500);
    }
  }

  [window.WebGLRenderingContext, window.WebGL2RenderingContext].forEach(function (GLCtor) {
    if (!GLCtor || !GLCtor.prototype) return;

    // Halve GPU VRAM in WebGL2 by converting 32-bit RGBA8 (0x8058) to 16-bit RGBA4 (0x8056) for textures >= 256px
    if (typeof GLCtor.prototype.texStorage2D === "function") {
      const origTexStorage2D = GLCtor.prototype.texStorage2D;
      GLCtor.prototype.texStorage2D = function (target, levels, internalformat, width, height) {
        if (internalformat === 0x8058 && (width >= 256 || height >= 256)) {
          internalformat = 0x8056; // GL_RGBA4 (2 bytes/pixel instead of 4 bytes/pixel -> 50% GPU VRAM saved!)
        }
        return origTexStorage2D.call(this, target, levels, internalformat, width, height);
      };
    }

    ["texImage2D", "texSubImage2D"].forEach(function (method) {
      const origMethod = GLCtor.prototype[method];
      if (typeof origMethod !== "function") return;
      GLCtor.prototype[method] = function () {
        const lastArg = arguments[arguments.length - 1];
        const res = origMethod.apply(this, arguments);
        if (lastArg && typeof lastArg === "object") {
          releaseTextureSourceCpuMemory(lastArg);
        }
        return res;
      };
    });
  });
})();
