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
  const trackedGlContexts = new Set();
  let active = true;
  let waiting = [];

  const TARGET_SAMPLE_RATE = 16000;
  const STREAM_AUDIO_OVER_BYTES = 28 * 1024;
  const MAX_TOTAL_PCM_BYTES = 75 * 1024 * 1024;
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

  // --- Track XHR & fetch audio URLs (including synchronous XHR.response getter!) ---
  if (typeof window.XMLHttpRequest === "function") {
    const XHR = window.XMLHttpRequest;
    const origOpen = XHR.prototype.open;
    const respDesc = Object.getOwnPropertyDescriptor(XHR.prototype, "response");

    XHR.prototype.open = function (method, url) {
      this.__gardendlessReqUrl = typeof url === "string" ? url : String(url || "");
      this.addEventListener("readystatechange", function () {
        if (this.readyState === 4) {
          try {
            if ((!this.responseType || this.responseType === "arraybuffer") && this.response instanceof ArrayBuffer && this.__gardendlessReqUrl) {
              this.response.__gardendlessAudioUrl = this.responseURL || this.__gardendlessReqUrl;
            }
          } catch (_) {}
        }
      });
      return origOpen.apply(this, arguments);
    };

    if (respDesc && typeof respDesc.get === "function") {
      Object.defineProperty(XHR.prototype, "response", {
        configurable: true,
        enumerable: respDesc.enumerable,
        get: function () {
          const val = respDesc.get.call(this);
          try {
            if (val instanceof ArrayBuffer && !val.__gardendlessAudioUrl && (this.responseURL || this.__gardendlessReqUrl)) {
              val.__gardendlessAudioUrl = this.responseURL || this.__gardendlessReqUrl;
            }
          } catch (_) {}
          return val;
        }
      });
    }
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

  function sniffAudioMime(arrayBuffer) {
    try {
      const u = new Uint8Array(arrayBuffer, 0, Math.min(16, arrayBuffer.byteLength));
      if (u.length >= 8 && u[4] === 0x66 && u[5] === 0x74 && u[6] === 0x79 && u[7] === 0x70) {
        return "audio/mp4";
      }
      if (u.length >= 4 && u[0] === 0x4F && u[1] === 0x67 && u[2] === 0x67 && u[3] === 0x53) {
        return "audio/ogg";
      }
      if (u.length >= 4 && u[0] === 0x52 && u[1] === 0x49 && u[2] === 0x46 && u[3] === 0x46) {
        return "audio/wav";
      }
      if (u.length >= 2 && u[0] === 0xFF && (u[1] & 0xF6) === 0xF0) {
        return "audio/aac";
      }
    } catch (_) {}
    return "audio/mpeg";
  }

  // --- Protected 16-stream HTML5 <audio> pool (Looping BGM is NEVER evicted by non-looping SFX!) ---
  const streamPool = [];
  const MAX_STREAM_ELEMENTS = 16;
  const blobUrlRing = [];
  const MAX_BLOB_URLS = 8;

  function registerBlobUrl(url) {
    if (!url) return null;
    blobUrlRing.push(url);
    while (blobUrlRing.length > MAX_BLOB_URLS) {
      const old = blobUrlRing.shift();
      try { URL.revokeObjectURL(old); } catch (_) {}
    }
    return url;
  }

  function acquireAudioStream(streamUrl, isLoop, volume) {
    let item = null;
    for (let i = 0; i < streamPool.length; i++) {
      if ((streamPool[i].paused || streamPool[i].ended) && !streamPool[i].__gardendlessPlayPending) {
        item = streamPool[i];
        break;
      }
    }
    if (!item && streamPool.length < MAX_STREAM_ELEMENTS && typeof window.Audio === "function") {
      item = new window.Audio();
      item.preload = "auto";
      streamPool.push(item);
    }
    if (!item && streamPool.length > 0) {
      let victimIdx = -1;
      for (let i = 0; i < streamPool.length; i++) {
        if (!streamPool[i].loop) {
          victimIdx = i;
          break;
        }
      }
      if (victimIdx === -1 && isLoop) {
        victimIdx = 0;
      }
      if (victimIdx !== -1) {
        item = streamPool.splice(victimIdx, 1)[0];
        try { nativePause.call(item); } catch (_) {}
        streamPool.push(item);
      }
    }
    if (!item) return null;
    if (item.__gardendlessVolTimer) {
      clearInterval(item.__gardendlessVolTimer);
      item.__gardendlessVolTimer = null;
    }
    item.src = streamUrl;
    item.loop = !!isLoop;
    item.volume = typeof volume === "number" && Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
    return item;
  }

  // --- Track GainNode chain so fade-ins and BGM volume sliders apply to streamed <audio> ---
  const OrigSourceNode = window.AudioBufferSourceNode;
  const OrigAudioNode = window.AudioNode;

  if (OrigAudioNode && OrigAudioNode.prototype && typeof OrigAudioNode.prototype.connect === "function") {
    const origNodeConnect = OrigAudioNode.prototype.connect;
    OrigAudioNode.prototype.connect = function (dest) {
      try {
        if (dest && dest.gain && typeof dest.gain.value === "number") {
          if (OrigSourceNode && this instanceof OrigSourceNode) {
            this.__gardendlessGainNode = dest;
          } else if (this && this.gain && typeof this.gain.value === "number" && this !== dest) {
            this.__gardendlessNextGain = dest;
          }
        }
      } catch (_) {}
      return origNodeConnect.apply(this, arguments);
    };
  }

  function computeEffectiveVolume(sourceNode) {
    let vol = 1.0;
    let foundGain = false;
    let node = sourceNode && sourceNode.__gardendlessGainNode;
    let depth = 0;
    while (node && depth < 6) {
      if (node.gain && typeof node.gain.value === "number" && Number.isFinite(node.gain.value)) {
        vol *= Math.max(0, Math.min(1, node.gain.value));
        foundGain = true;
      }
      node = node.__gardendlessNextGain;
      depth++;
    }
    return foundGain ? Math.max(0, Math.min(1, vol)) : 1.0;
  }

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
      if (buf && (buf.__gardendlessStreamUrl || buf.__gardendlessBlobBytes)) {
        const self = this;
        let url = buf.__gardendlessStreamUrl;
        if (!url && buf.__gardendlessBlobBytes && typeof Blob !== "undefined" && typeof URL !== "undefined") {
          try {
            const mime = buf.__gardendlessMime || "audio/mp4";
            url = registerBlobUrl(URL.createObjectURL(new Blob([buf.__gardendlessBlobBytes], { type: mime })));
            buf.__gardendlessStreamUrl = url;
          } catch (_) {}
        }
        if (url) {
          let initVol = computeEffectiveVolume(self);
          if (initVol <= 0.0001) initVol = 1.0;
          const audio = acquireAudioStream(url, self.loop, initVol);
          if (audio) {
            self.__gardendlessAudio = audio;
            self.__gardendlessStopRequested = false;
            audio.addEventListener("loadedmetadata", function onMeta() {
              audio.removeEventListener("loadedmetadata", onMeta);
              if (Number.isFinite(audio.duration) && audio.duration > 0) {
                buf.__gardendlessDuration = audio.duration;
              }
            });
            if (typeof offset === "number" && offset > 0) {
              try { audio.currentTime = offset; } catch (_) {}
            }
            const fireEnded = function () {
              if (audio.__gardendlessVolTimer) {
                clearInterval(audio.__gardendlessVolTimer);
                audio.__gardendlessVolTimer = null;
              }
              if (typeof self.onended === "function") {
                try { self.onended(new Event("ended")); } catch (_) {}
              }
              if (typeof self.dispatchEvent === "function") {
                try { self.dispatchEvent(new Event("ended")); } catch (_) {}
              }
            };
            audio.onended = function () {
              if (!self.loop) fireEnded();
            };
            audio.__gardendlessVolTimer = setInterval(function () {
              if (audio.paused || audio.ended || self.__gardendlessAudio !== audio) {
                clearInterval(audio.__gardendlessVolTimer);
                audio.__gardendlessVolTimer = null;
                return;
              }
              audio.loop = !!self.loop;
              const currentVol = computeEffectiveVolume(self);
              if (currentVol > 0.0001) {
                audio.volume = currentVol;
              }
            }, 200);
            audio.__gardendlessPlayPending = true;
            const p = Media.prototype.play.call(audio);
            if (p && typeof p.then === "function") {
              p.then(
                function () {
                  audio.__gardendlessPlayPending = false;
                  if (self.__gardendlessStopRequested && self.__gardendlessAudio === audio) {
                    self.__gardendlessAudio = null;
                    try { nativePause.call(audio); } catch (_) {}
                  }
                },
                function () {
                  audio.__gardendlessPlayPending = false;
                  setTimeout(fireEnded, 50);
                }
              );
            } else {
              audio.__gardendlessPlayPending = false;
            }
            return;
          }
        }
      }
      return origStart.apply(this, arguments);
    };

    OrigSourceNode.prototype.stop = function () {
      if (this.__gardendlessAudio) {
        const audio = this.__gardendlessAudio;
        if (audio.__gardendlessVolTimer) {
          clearInterval(audio.__gardendlessVolTimer);
          audio.__gardendlessVolTimer = null;
        }
        try { audio.onended = null; } catch (_) {}
        if (audio.__gardendlessPlayPending) {
          this.__gardendlessStopRequested = true;
        } else {
          this.__gardendlessAudio = null;
          try { nativePause.call(audio); } catch (_) {}
        }
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

  // --- Intercept decodeAudioData: Offload > 28KB to <audio> (0 PCM RAM!) & 16kHz native decode for <= 28KB SFX (75MB budget) ---
  if (typeof Base.prototype.decodeAudioData === "function") {
    const origDecode = Base.prototype.decodeAudioData;
    const decodeQueue = [];
    let activeDecodes = 0;

    function createPlaceholderBuffer(ctx, streamUrl, blobBytes, mime, byteLen) {
      if (!streamUrl && !blobBytes && ctx.__gardendlessSilentBuffer) {
        return ctx.__gardendlessSilentBuffer;
      }
      const sr = ctx.sampleRate || TARGET_SAMPLE_RATE;
      const len = Math.max(1600, Math.floor(sr * 0.1));
      const estDuration = byteLen > 0 ? Math.max(4.0, Math.round((byteLen / 16000) * 10) / 10) : 0.1;
      const buf = typeof ctx.createBuffer === "function"
        ? ctx.createBuffer(1, len, sr)
        : { duration: estDuration, length: len, numberOfChannels: 1, sampleRate: sr };
      if (streamUrl || blobBytes) {
        buf.__gardendlessStreamUrl = streamUrl || null;
        buf.__gardendlessBlobBytes = blobBytes || null;
        buf.__gardendlessMime = mime || "audio/mp4";
        buf.__gardendlessDuration = estDuration;
        try {
          Object.defineProperty(buf, "duration", {
            configurable: true,
            get: function () { return this.__gardendlessDuration || estDuration; }
          });
        } catch (_) {}
      } else {
        ctx.__gardendlessSilentBuffer = buf;
      }
      return buf;
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
        const silent = createPlaceholderBuffer(self, null, null, null, 0);
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
        if (decodedBuffer && typeof decodedBuffer.length === "number") {
          totalPcmBytes += decodedBuffer.length * (decodedBuffer.numberOfChannels || 1) * 4;
        }
        pumpDecodeQueue();
        if (typeof successCallback === "function") {
          try { successCallback(decodedBuffer); } catch (_) {}
        }
        resolve(decodedBuffer);
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
      const byteLen = arrayBuffer && typeof arrayBuffer.byteLength === "number" ? arrayBuffer.byteLength : 0;

      // Offload all BGM, jingles, and tracks > 28KB to WebKit <audio> streaming (0 PCM RAM!)
      if (byteLen > STREAM_AUDIO_OVER_BYTES) {
        const directUrl = arrayBuffer.__gardendlessAudioUrl || null;
        const mime = sniffAudioMime(arrayBuffer);
        let blobBytes = null;
        if (!directUrl) {
          try {
            blobBytes = arrayBuffer.slice ? arrayBuffer.slice(0) : new Uint8Array(arrayBuffer);
          } catch (_) {}
        }
        const placeholder = createPlaceholderBuffer(self, directUrl, blobBytes, mime, byteLen);
        if (typeof successCallback === "function") {
          setTimeout(function () {
            try { successCallback(placeholder); } catch (_) {}
          }, 0);
        }
        return Promise.resolve(placeholder);
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

  // --- CRITICAL TEXTURE MEMORY OPTIMIZER ---
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

  function releaseTextureSourceCpuMemory(source) {
    if (!source || source.__gardendlessCpuReleased) return;
    if (typeof source.close === "function") {
      const w = source.width || 0;
      const h = source.height || 0;
      if (w < 32 && h < 32) return;
      source.__gardendlessCpuReleased = true;
      setTimeout(function () {
        try {
          Object.defineProperty(source, "width", { value: w, configurable: true });
          Object.defineProperty(source, "height", { value: h, configurable: true });
          source.close();
        } catch (_) {}
      }, 16);
      return;
    }
    if (typeof window.HTMLImageElement === "function" && source instanceof window.HTMLImageElement) {
      const w = source.naturalWidth || source.width || 0;
      const h = source.naturalHeight || source.height || 0;
      if (w < 128 && h < 128) return;
      source.__gardendlessCpuReleased = true;
      setTimeout(function () {
        try {
          Object.defineProperty(source, "width", { value: w, configurable: true });
          Object.defineProperty(source, "height", { value: h, configurable: true });
          Object.defineProperty(source, "naturalWidth", { value: w, configurable: true });
          Object.defineProperty(source, "naturalHeight", { value: h, configurable: true });
          source.removeAttribute("src");
        } catch (_) {}
      }, 200);
    }
  }

  if (typeof window.HTMLCanvasElement === "function" && window.HTMLCanvasElement.prototype) {
    const origGetContext = window.HTMLCanvasElement.prototype.getContext;
    if (typeof origGetContext === "function") {
      window.HTMLCanvasElement.prototype.getContext = function (type) {
        const ctx = origGetContext.apply(this, arguments);
        if (ctx && (type === "webgl2" || type === "webgl" || type === "experimental-webgl")) {
          trackedGlContexts.add(ctx);
        }
        return ctx;
      };
    }
  }

  [window.WebGLRenderingContext, window.WebGL2RenderingContext].forEach(function (GLCtor) {
    if (!GLCtor || !GLCtor.prototype) return;

    if (typeof GLCtor.prototype.texStorage2D === "function") {
      const origTexStorage2D = GLCtor.prototype.texStorage2D;
      GLCtor.prototype.texStorage2D = function (target, levels, internalformat, width, height) {
        if (internalformat === 0x8058 && width >= 256 && height >= 256) {
          internalformat = 0x8056;
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

  if (typeof window.addEventListener === "function") {
    const cleanupOnReload = function () {
      try {
        streamPool.forEach(function (a) {
          try {
            nativePause.call(a);
            a.removeAttribute("src");
            a.load();
          } catch (_) {}
        });
        streamPool.length = 0;
        contexts.forEach(function (ctx) {
          try { if (typeof ctx.close === "function") ctx.close(); } catch (_) {}
        });
        contexts.clear();
        trackedGlContexts.forEach(function (gl) {
          try {
            const ext = typeof gl.getExtension === "function" ? gl.getExtension("WEBGL_lose_context") : null;
            if (ext && typeof ext.loseContext === "function") ext.loseContext();
          } catch (_) {}
        });
        trackedGlContexts.clear();
      } catch (_) {}
    };
    window.addEventListener("beforeunload", cleanupOnReload);
    window.addEventListener("pagehide", cleanupOnReload);
  }
})();
