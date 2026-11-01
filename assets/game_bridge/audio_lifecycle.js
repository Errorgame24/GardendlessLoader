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
  const OFFLOAD_AUDIO_OVER_BYTES = 32 * 1024;
  const MAX_TOTAL_PCM_BYTES = 30 * 1024 * 1024;
  let totalPcmBytes = 0;

  const nativeAudioHandler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.gardendlessNativeAudio;
  const nativeCallbacks = new Map();
  let nextNativeStreamId = 1;

  window.__gardendlessOnNativeAudioEnded = function (streamId) {
    const cb = nativeCallbacks.get(streamId);
    if (cb) {
      nativeCallbacks.delete(streamId);
      try { cb(); } catch (_) {}
    }
  };

  function postNativeAudio(payload) {
    if (!nativeAudioHandler || typeof nativeAudioHandler.postMessage !== "function") return false;
    try {
      nativeAudioHandler.postMessage(payload);
      return true;
    } catch (_) {
      return false;
    }
  }

  function extractRelativePath(urlStr) {
    if (!urlStr || typeof urlStr !== "string") return "";
    try {
      const u = new URL(urlStr, window.location ? window.location.href : "gardendless-game://localhost/");
      if (u.protocol === "gardendless-game:") {
        return decodeURIComponent(u.pathname.replace(/^\/+/, ""));
      }
    } catch (_) {}
    return "";
  }

  function isNativeSupportedExt(relPath) {
    if (!relPath) return false;
    const lower = relPath.toLowerCase();
    return lower.endsWith(".m4a") || lower.endsWith(".mp3") || lower.endsWith(".wav") || lower.endsWith(".aac") || lower.endsWith(".caf");
  }

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

  // --- Track XHR / fetch audio URLs ---
  if (typeof window.XMLHttpRequest === "function") {
    const XHR = window.XMLHttpRequest;
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      this.__gardendlessReqUrl = typeof url === "string" ? url : "";
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      this.addEventListener("load", function () {
        try {
          if (this.responseType === "arraybuffer" && this.response instanceof ArrayBuffer && this.__gardendlessReqUrl) {
            this.response.__gardendlessAudioUrl = this.responseURL || this.__gardendlessReqUrl;
          }
        } catch (_) {}
      });
      return origSend.apply(this, arguments);
    };
  }

  if (typeof window.fetch === "function") {
    const origFetch = window.fetch;
    window.fetch = function (input) {
      const reqUrl = typeof input === "string" ? input : (input && input.url ? input.url : "");
      return origFetch.apply(this, arguments).then(function (response) {
        if (reqUrl && response && typeof response.arrayBuffer === "function") {
          const origAb = response.arrayBuffer;
          response.arrayBuffer = function () {
            return origAb.apply(this, arguments).then(function (ab) {
              if (ab instanceof ArrayBuffer) {
                ab.__gardendlessAudioUrl = response.url || reqUrl;
              }
              return ab;
            });
          };
        }
        return response;
      });
    };
  }

  // --- Bounded HTML5 <audio> fallback pool ---
  const bgmPool = [];
  const MAX_BGM_STREAMS = 3;
  const blobUrlRing = [];
  const MAX_BLOB_URLS = 4;

  function registerBlobUrl(url) {
    if (!url) return null;
    blobUrlRing.push(url);
    while (blobUrlRing.length > MAX_BLOB_URLS) {
      const old = blobUrlRing.shift();
      try { URL.revokeObjectURL(old); } catch (_) {}
    }
    return url;
  }

  function acquireBgmStream(streamUrl, loop, volume) {
    let item = null;
    for (let i = 0; i < bgmPool.length; i++) {
      if (bgmPool[i].paused || bgmPool[i].ended) {
        item = bgmPool[i];
        break;
      }
    }
    if (!item) {
      if (bgmPool.length < MAX_BGM_STREAMS && typeof window.Audio === "function") {
        item = new window.Audio();
        item.preload = "auto";
        bgmPool.push(item);
      } else if (bgmPool.length > 0) {
        item = bgmPool.shift();
        try { nativePause.call(item); } catch (_) {}
        bgmPool.push(item);
      }
    }
    if (!item) return null;
    item.src = streamUrl;
    item.loop = !!loop;
    item.volume = typeof volume === "number" && Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
    return item;
  }

  const OrigSourceNode = window.AudioBufferSourceNode;
  if (OrigSourceNode && OrigSourceNode.prototype) {
    const origConnect = OrigSourceNode.prototype.connect;
    const origStart = OrigSourceNode.prototype.start;
    const origStop = OrigSourceNode.prototype.stop;

    OrigSourceNode.prototype.connect = function (dest) {
      if (dest && dest.gain && typeof dest.gain.value === "number") {
        this.__gardendlessGainNode = dest;
      }
      return origConnect.apply(this, arguments);
    };

    OrigSourceNode.prototype.start = function (when, offset) {
      const buf = this.buffer;
      if (buf && (buf.__gardendlessNativePath || buf.__gardendlessStreamUrl || buf.__gardendlessBlobBytes)) {
        const self = this;
        const vol = (self.__gardendlessGainNode && self.__gardendlessGainNode.gain)
          ? self.__gardendlessGainNode.gain.value : 1;
        const fireEnded = function () {
          if (typeof self.onended === "function") {
            try { self.onended(new Event("ended")); } catch (_) {}
          }
          if (typeof self.dispatchEvent === "function") {
            try { self.dispatchEvent(new Event("ended")); } catch (_) {}
          }
        };

        if (buf.__gardendlessNativePath && nativeAudioHandler) {
          const streamId = nextNativeStreamId++;
          self.__gardendlessNativeStreamId = streamId;
          if (!self.loop) {
            nativeCallbacks.set(streamId, fireEnded);
          }
          if (postNativeAudio({
            action: "play",
            id: streamId,
            path: buf.__gardendlessNativePath,
            loop: !!self.loop,
            volume: vol,
            offset: typeof offset === "number" && offset > 0 ? offset : 0
          })) {
            return;
          }
          nativeCallbacks.delete(streamId);
        }

        let url = buf.__gardendlessStreamUrl;
        if (!url && buf.__gardendlessBlobBytes && typeof Blob !== "undefined" && typeof URL !== "undefined") {
          try {
            url = registerBlobUrl(URL.createObjectURL(new Blob([buf.__gardendlessBlobBytes])));
            buf.__gardendlessBlobBytes = null;
            buf.__gardendlessStreamUrl = url;
          } catch (_) {}
        }
        if (url) {
          const audio = acquireBgmStream(url, self.loop, vol);
          if (audio) {
            self.__gardendlessAudio = audio;
            if (typeof offset === "number" && offset > 0) {
              try { audio.currentTime = offset; } catch (_) {}
            }
            audio.onended = function () {
              if (!self.loop) fireEnded();
            };
            const p = Media.prototype.play.call(audio);
            if (p && typeof p.catch === "function") {
              p.catch(function () { setTimeout(fireEnded, 100); });
            }
            return;
          }
        }
      }
      return origStart.apply(this, arguments);
    };

    OrigSourceNode.prototype.stop = function () {
      if (this.__gardendlessNativeStreamId) {
        const streamId = this.__gardendlessNativeStreamId;
        this.__gardendlessNativeStreamId = null;
        nativeCallbacks.delete(streamId);
        postNativeAudio({ action: "stop", id: streamId });
        if (typeof this.onended === "function") {
          try { this.onended(new Event("ended")); } catch (_) {}
        }
        if (typeof this.dispatchEvent === "function") {
          try { this.dispatchEvent(new Event("ended")); } catch (_) {}
        }
        return;
      }
      if (this.__gardendlessAudio) {
        const audio = this.__gardendlessAudio;
        this.__gardendlessAudio = null;
        try {
          audio.onended = null;
          nativePause.call(audio);
        } catch (_) {}
        if (typeof this.onended === "function") {
          try { this.onended(new Event("ended")); } catch (_) {}
        }
        if (typeof this.dispatchEvent === "function") {
          try { this.dispatchEvent(new Event("ended")); } catch (_) {}
        }
        return;
      }
      return origStop.apply(this, arguments);
    };
  }

  // --- Intercept decodeAudioData ---
  if (typeof Base.prototype.decodeAudioData === "function") {
    const origDecode = Base.prototype.decodeAudioData;

    function createPlaceholderBuffer(ctx, nativePath, streamUrl, blobBytes) {
      if (!nativePath && !streamUrl && !blobBytes && ctx.__gardendlessSilentBuffer) {
        return ctx.__gardendlessSilentBuffer;
      }
      const sr = ctx.sampleRate || TARGET_SAMPLE_RATE;
      const len = Math.max(1600, Math.floor(sr * 0.1));
      const buf = typeof ctx.createBuffer === "function"
        ? ctx.createBuffer(1, len, sr)
        : { duration: 0.1, length: len, numberOfChannels: 1, sampleRate: sr };
      if (nativePath || streamUrl || blobBytes) {
        buf.__gardendlessNativePath = nativePath || null;
        buf.__gardendlessStreamUrl = streamUrl || null;
        buf.__gardendlessBlobBytes = blobBytes || null;
      } else {
        ctx.__gardendlessSilentBuffer = buf;
      }
      return buf;
    }

    Base.prototype.decodeAudioData = function (arrayBuffer, successCallback, errorCallback) {
      const self = this;
      if (!(self instanceof Base)) {
        return origDecode.apply(self, arguments);
      }
      const byteLen = arrayBuffer && typeof arrayBuffer.byteLength === "number" ? arrayBuffer.byteLength : 0;

      if (byteLen > OFFLOAD_AUDIO_OVER_BYTES) {
        const directUrl = arrayBuffer.__gardendlessAudioUrl || null;
        const relPath = extractRelativePath(directUrl);
        const nativePath = (nativeAudioHandler && isNativeSupportedExt(relPath)) ? relPath : null;
        let blobBytes = null;
        if (!directUrl && !nativePath) {
          try {
            blobBytes = arrayBuffer.slice ? arrayBuffer.slice(0) : new Uint8Array(arrayBuffer);
          } catch (_) {}
        }
        const placeholder = createPlaceholderBuffer(self, nativePath, directUrl, blobBytes);
        if (typeof successCallback === "function") {
          setTimeout(function () { successCallback(placeholder); }, 0);
        }
        return Promise.resolve(placeholder);
      }

      if (totalPcmBytes >= MAX_TOTAL_PCM_BYTES) {
        const silent = createPlaceholderBuffer(self, null, null, null);
        if (typeof successCallback === "function") {
          setTimeout(function () { successCallback(silent); }, 0);
        }
        return Promise.resolve(silent);
      }

      return new Promise(function (resolve, reject) {
        let settled = false;
        const onSuccess = function (decodedBuffer) {
          if (settled) return;
          settled = true;
          if (decodedBuffer && typeof decodedBuffer.length === "number") {
            totalPcmBytes += decodedBuffer.length * (decodedBuffer.numberOfChannels || 1) * 4;
          }
          if (typeof successCallback === "function") successCallback(decodedBuffer);
          resolve(decodedBuffer);
        };
        const onError = function (err) {
          if (settled) return;
          settled = true;
          if (typeof errorCallback === "function") errorCallback(err);
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
