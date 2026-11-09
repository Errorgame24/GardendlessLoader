(function () {
  "use strict";
  // When the app goes to the background, iOS interrupts the web view's audio
  // session and WebKit does not reactivate it on return. A resume() or media
  // play() before the scene is active again is refused, and WebKit, which has
  // already marked the session active, never retries: the page stays silent.
  // Audio is suspended when the host reports the scene inactive, while the app
  // is still in the foreground, so WebKit deactivates the session itself;
  // resume()/play() calls wait while it is inactive, and everything resumes
  // once it is active, when WebKit activates the session again.
  const Base = window.AudioContext || window.webkitAudioContext;
  const Media = window.HTMLMediaElement;
  if (!Base || !Media) return;
  const nativeResume = Base.prototype.resume;
  const nativeSuspend = Base.prototype.suspend;
  const nativeDecode = Base.prototype.decodeAudioData;
  const nativePlay = Media.prototype.play;
  const nativePause = Media.prototype.pause;
  const contexts = new Set();
  const media = new Set();
  const suspendedContexts = new Set();
  const pausedMedia = new Set();
  let active = true;
  let waiting = [];

  const host = window.__gardendlessHost;
  const isIOS = Boolean(host && host.config && host.config.platform === "ios");

  // Track ArrayBuffers fetched from audio URLs so we can key the LRU decoded
  // AudioBuffer cache by URL (eliminating repeat CPU re-decoding across levels)
  // and route large BGM (> 56 KB) to streaming <audio>.
  const bufferUrlMap = typeof WeakMap !== "undefined" ? new WeakMap() : null;
  const streamThresholdBytes = 56 * 1024;
  const maxSfxCacheBytes = 34 * 1024 * 1024; // 34 MB bounded LRU cache
  const sfxCache = new Map(); // key -> { buffer, bytes }
  let sfxCacheBytes = 0;

  function trimSfxCache(limitBytes) {
    while (sfxCacheBytes > limitBytes && sfxCache.size > 0) {
      const oldestKey = sfxCache.keys().next().value;
      const entry = sfxCache.get(oldestKey);
      sfxCache.delete(oldestKey);
      if (entry) sfxCacheBytes = Math.max(0, sfxCacheBytes - entry.bytes);
    }
  }

  function getCachedSfx(key) {
    if (!key || !sfxCache.has(key)) return null;
    const entry = sfxCache.get(key);
    sfxCache.delete(key);
    sfxCache.set(key, entry);
    return entry.buffer;
  }

  function putCachedSfx(key, audioBuf) {
    if (!key || !audioBuf) return;
    const pcmBytes = (audioBuf.length || 0) * (audioBuf.numberOfChannels || 1) * 4;
    if (pcmBytes <= 0 || pcmBytes > 8 * 1024 * 1024) return;
    if (sfxCache.has(key)) {
      const prev = sfxCache.get(key);
      sfxCache.delete(key);
      if (prev) sfxCacheBytes = Math.max(0, sfxCacheBytes - prev.bytes);
    }
    trimSfxCache(maxSfxCacheBytes - pcmBytes);
    sfxCache.set(key, { buffer: audioBuf, bytes: pcmBytes });
    sfxCacheBytes += pcmBytes;
  }

  if (isIOS && bufferUrlMap) {
    if (typeof window.fetch === "function") {
      const origFetch = window.fetch.bind(window);
      window.fetch = function (input, init) {
        const url = typeof input === "string" ? input : (input && input.url ? input.url : "");
        return origFetch(input, init).then(function (resp) {
          if (url && /\.(ogg|mp3|wav|m4a)(\?|$)/i.test(url) && typeof resp.arrayBuffer === "function") {
            const origAb = resp.arrayBuffer.bind(resp);
            resp.arrayBuffer = function () {
              return origAb().then(function (buf) {
                if (buf && typeof buf === "object") {
                  try { bufferUrlMap.set(buf, url); } catch (_) {}
                }
                return buf;
              });
            };
          }
          return resp;
        });
      };
    }

    if (typeof window.XMLHttpRequest === "function") {
      const XHRProto = window.XMLHttpRequest.prototype;
      const origOpen = XHRProto.open;
      const origSend = XHRProto.send;
      XHRProto.open = function (method, url) {
        this.__gardendlessUrl = typeof url === "string" ? url : "";
        return origOpen.apply(this, arguments);
      };
      XHRProto.send = function () {
        this.addEventListener("load", function () {
          try {
            if (this.responseType === "arraybuffer" && this.response && this.__gardendlessUrl) {
              bufferUrlMap.set(this.response, this.__gardendlessUrl);
            }
          } catch (_) {}
        });
        return origSend.apply(this, arguments);
      };
    }
  }

  function whenActive() {
    return active ? Promise.resolve() : new Promise(resolve => waiting.push(resolve));
  }

  class TrackedAudioContext extends Base {
    constructor(...args) {
      let opts = args[0];
      if (isIOS) {
        if (!opts || typeof opts !== "object") {
          opts = { sampleRate: 24000, latencyHint: "interactive" };
          args[0] = opts;
        } else if (!opts.sampleRate) {
          opts = Object.assign({}, opts, { sampleRate: 24000 });
          args[0] = opts;
        }
      }
      super(...args);
      contexts.add(this);
      this.addEventListener("statechange", () => {
        if (this.state === "closed") contexts.delete(this);
      });
    }
  }
  window.AudioContext = TrackedAudioContext;
  if (window.webkitAudioContext === Base) window.webkitAudioContext = TrackedAudioContext;

  if (typeof window.addEventListener === "function") {
    const closeAllContexts = function () {
      sfxCache.clear();
      sfxCacheBytes = 0;
      contexts.forEach(function (ctx) {
        try {
          if (typeof ctx.close === "function" && ctx.state !== "closed") {
            ctx.close().catch(function () {});
          }
        } catch (_) {}
      });
      contexts.clear();
    };
    window.addEventListener("pagehide", closeAllContexts);
    window.addEventListener("beforeunload", closeAllContexts);
  }

  if (isIOS && typeof nativeDecode === "function") {
    Base.prototype.decodeAudioData = function (audioData, successCallback, errorCallback) {
      const ctx = this;
      const byteLen = audioData ? (audioData.byteLength || 0) : 0;
      const taggedUrl = (bufferUrlMap && audioData) ? bufferUrlMap.get(audioData) : null;

      // Stream BGM / long audio (> 56 KB) via <audio> instead of decoding into 20 MB of Float32 PCM RAM.
      if (byteLen > streamThresholdBytes && typeof ctx.createBuffer === "function") {
        try {
          const proxyBuffer = ctx.createBuffer(1, 24000, ctx.sampleRate || 24000);
          if (taggedUrl) {
            proxyBuffer.__gardendlessStreamUrl = taggedUrl;
          } else if (typeof Blob !== "undefined" && typeof URL !== "undefined" && URL.createObjectURL) {
            proxyBuffer.__gardendlessStreamUrl = URL.createObjectURL(new Blob([audioData]));
          }
          if (typeof successCallback === "function") {
            Promise.resolve(proxyBuffer).then(successCallback);
          }
          return Promise.resolve(proxyBuffer);
        } catch (_) {}
      }

      // Check LRU decoded SFX cache first so repeated zombie/plant sounds cost 0 CPU & 0 extra RAM.
      const cacheKey = taggedUrl ? ("url:" + taggedUrl) : null;
      const cached = getCachedSfx(cacheKey);
      if (cached) {
        if (typeof successCallback === "function") {
          Promise.resolve(cached).then(successCallback);
        }
        return Promise.resolve(cached);
      }

      const promise = nativeDecode.call(ctx, audioData, function (decoded) {
        if (cacheKey && decoded) putCachedSfx(cacheKey, decoded);
        if (typeof successCallback === "function") successCallback(decoded);
      }, errorCallback);

      if (promise && typeof promise.then === "function") {
        return promise.then(function (decoded) {
          if (cacheKey && decoded) putCachedSfx(cacheKey, decoded);
          return decoded;
        });
      }
      return promise;
    };

    const origCreateBufferSource = Base.prototype.createBufferSource;
    if (typeof origCreateBufferSource === "function" && typeof Audio !== "undefined") {
      const activeStreams = [];
      const maxStreams = 12;

      function acquireStreamElement(url, shouldLoop) {
        for (let i = 0; i < activeStreams.length; i++) {
          const item = activeStreams[i];
          if (item.paused && item.__geUrl === url) {
            activeStreams.splice(i, 1);
            activeStreams.push(item);
            return item;
          }
        }
        for (let i = 0; i < activeStreams.length; i++) {
          const item = activeStreams[i];
          if (item.paused) {
            activeStreams.splice(i, 1);
            item.__geUrl = url;
            item.src = url;
            activeStreams.push(item);
            return item;
          }
        }
        if (activeStreams.length >= maxStreams) {
          // Never evict a currently playing looping BGM track for a one-shot stream!
          let victimIdx = activeStreams.findIndex(function (el) { return !el.loop; });
          if (victimIdx === -1 && shouldLoop) victimIdx = 0;
          if (victimIdx !== -1) {
            const oldest = activeStreams.splice(victimIdx, 1)[0];
            try { nativePause.call(oldest); } catch (_) {}
            oldest.__geUrl = url;
            oldest.src = url;
            activeStreams.push(oldest);
            return oldest;
          }
        }
        const el = new Audio();
        el.preload = "auto";
        el.__geUrl = url;
        el.src = url;
        activeStreams.push(el);
        return el;
      }

      Base.prototype.createBufferSource = function () {
        const sourceNode = origCreateBufferSource.apply(this, arguments);
        let streamEl = null;
        const origStart = sourceNode.start.bind(sourceNode);
        const origStop = sourceNode.stop.bind(sourceNode);

        sourceNode.start = function (when, offset) {
          const buf = sourceNode.buffer;
          if (buf && buf.__gardendlessStreamUrl) {
            try {
              streamEl = acquireStreamElement(buf.__gardendlessStreamUrl, Boolean(sourceNode.loop));
              streamEl.loop = Boolean(sourceNode.loop);
              if (typeof offset === "number" && offset > 0) {
                try { streamEl.currentTime = offset; } catch (_) {}
              } else {
                try { streamEl.currentTime = 0; } catch (_) {}
              }
              streamEl.onended = function () {
                if (typeof sourceNode.onended === "function") {
                  try { sourceNode.onended(new Event("ended")); } catch (_) {}
                }
                try { sourceNode.dispatchEvent(new Event("ended")); } catch (_) {}
              };
              streamEl.play().catch(function () {});
              return;
            } catch (_) {}
          }
          return origStart.apply(this, arguments);
        };

        sourceNode.stop = function () {
          if (streamEl) {
            try {
              nativePause.call(streamEl);
              streamEl.onended = null;
            } catch (_) {}
            streamEl = null;
            return;
          }
          return origStop.apply(this, arguments);
        };

        return sourceNode;
      };
    }
  }

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
      // Trim cached SFX buffers to 18 MB when backgrounded so iOS Jetsam never reaps the app.
      trimSfxCache(18 * 1024 * 1024);
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
})();
