(function () {
  "use strict";
  const id = "gardendless-native-watermark";
  const panelId = "gardendless-lain-scale-panel";
  let lastToggleTime = 0;

  function getScalePercent() {
    if (typeof window.__gardendlessGetRenderScale === "function") {
      return Math.max(1, Math.min(100, Math.round(window.__gardendlessGetRenderScale() * 100)));
    }
    const host = window.__gardendlessHost;
    const s = host && host.config && typeof host.config.renderScale === "number"
      ? host.config.renderScale : 1;
    return Math.max(1, Math.min(100, Math.round(s * 100)));
  }

  function applyScalePercent(pct) {
    const clamped = Math.max(1, Math.min(100, Math.round(Number(pct) || 100)));
    if (typeof window.__gardendlessSetRenderScale === "function") {
      window.__gardendlessSetRenderScale(clamped / 100);
    }
    return clamped;
  }

  function togglePanel() {
    const now = Date.now();
    if (now - lastToggleTime < 350) {
      return;
    }
    lastToggleTime = now;

    let panel = document.getElementById(panelId);
    if (panel) {
      const isHidden = panel.style.display === "none";
      panel.style.display = isHidden ? "block" : "none";
      if (isHidden) {
        const currentScale = getScalePercent();
        const slider = panel.querySelector("input[type=range]");
        if (slider) slider.value = String(currentScale);
        const valLabel = panel.querySelector(".scale-val-label");
        if (valLabel) valLabel.textContent = currentScale + "%";
      }
      return;
    }

    panel = document.createElement("div");
    panel.id = panelId;
    Object.assign(panel.style, {
      display: "block",
      position: "fixed",
      right: "12px",
      bottom: "38px",
      zIndex: "2147483647",
      background: "rgba(12, 16, 14, 0.94)",
      border: "1px solid rgba(130, 210, 150, 0.48)",
      borderRadius: "10px",
      padding: "10px 14px",
      color: "#e8f5e9",
      font: "600 12px -apple-system,BlinkMacSystemFont,monospace,sans-serif",
      boxShadow: "0 6px 24px rgba(0,0,0,0.85)",
      backdropFilter: "blur(10px)",
      webkitBackdropFilter: "blur(10px)",
      userSelect: "none",
      minWidth: "240px",
      pointerEvents: "auto",
      touchAction: "manipulation"
    });

    const stopProp = function (e) {
      if (e) {
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
      }
    };
    ["pointerdown", "pointermove", "pointerup", "touchstart", "touchmove", "touchend", "mousedown", "click"].forEach(function (ev) {
      panel.addEventListener(ev, stopProp, { passive: true });
    });

    const header = document.createElement("div");
    Object.assign(header.style, {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: "6px"
    });
    const title = document.createElement("span");
    title.textContent = "NAVI // RENDER SCALE";
    title.style.color = "#81c784";
    title.style.fontSize = "11px";
    title.style.letterSpacing = "0.5px";

    const headerRight = document.createElement("div");
    Object.assign(headerRight.style, {
      display: "flex",
      alignItems: "center",
      gap: "8px"
    });

    const valLabel = document.createElement("span");
    valLabel.className = "scale-val-label";
    valLabel.textContent = getScalePercent() + "%";
    valLabel.style.color = "#ffffff";
    valLabel.style.fontWeight = "700";

    const closeBtn = document.createElement("span");
    closeBtn.textContent = "✕";
    Object.assign(closeBtn.style, {
      cursor: "pointer",
      color: "rgba(255,255,255,0.6)",
      fontSize: "12px",
      padding: "0 4px"
    });
    closeBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      panel.style.display = "none";
    });
    closeBtn.addEventListener("touchend", function (e) {
      e.stopPropagation();
      panel.style.display = "none";
    });

    headerRight.appendChild(valLabel);
    headerRight.appendChild(closeBtn);
    header.appendChild(title);
    header.appendChild(headerRight);
    panel.appendChild(header);

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "1";
    slider.max = "100";
    slider.step = "1";
    slider.value = String(getScalePercent());
    Object.assign(slider.style, {
      width: "100%",
      accentColor: "#66bb6a",
      margin: "6px 0 8px 0"
    });

    slider.addEventListener("input", function () {
      const pct = applyScalePercent(slider.value);
      valLabel.textContent = pct + "%";
    });
    panel.appendChild(slider);

    const presetsRow = document.createElement("div");
    Object.assign(presetsRow.style, {
      display: "flex",
      gap: "4px",
      justifyContent: "space-between"
    });
    [1, 25, 50, 75, 100].forEach(function (preset) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = preset + "%";
      Object.assign(btn.style, {
        flex: "1",
        padding: "4px 0",
        fontSize: "10px",
        fontWeight: "600",
        color: "#e8f5e9",
        background: "rgba(255,255,255,0.12)",
        border: "1px solid rgba(255,255,255,0.22)",
        borderRadius: "5px",
        cursor: "pointer"
      });
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        slider.value = String(preset);
        const pct = applyScalePercent(preset);
        valLabel.textContent = pct + "%";
      });
      btn.addEventListener("touchend", function (e) {
        e.stopPropagation();
        slider.value = String(preset);
        const pct = applyScalePercent(preset);
        valLabel.textContent = pct + "%";
      });
      presetsRow.appendChild(btn);
    });
    panel.appendChild(presetsRow);

    (document.body || document.documentElement).appendChild(panel);
  }

  function render() {
    let node = document.getElementById(id);
    if (!node) {
      node = document.createElement("div");
      node.id = id;
      node.textContent = "present day, present time";
      Object.assign(node.style, {
        position: "fixed",
        right: "8px",
        bottom: "6px",
        zIndex: "2147483647",
        pointerEvents: "auto",
        cursor: "pointer",
        userSelect: "none",
        color: "rgba(255,255,255,0.72)",
        font: "600 12px -apple-system,BlinkMacSystemFont,monospace,sans-serif",
        letterSpacing: "0.3px",
        textShadow: "0 1px 3px rgba(0,0,0,0.9)",
        padding: "10px 14px",
        touchAction: "manipulation",
        webkitTapHighlightColor: "transparent"
      });
      function onTrigger(e) {
        if (e) {
          e.stopPropagation();
          if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
          if (typeof e.preventDefault === "function" && e.cancelable) e.preventDefault();
        }
        togglePanel();
      }
      node.addEventListener("click", onTrigger);
      node.addEventListener("touchend", onTrigger, { capture: true, passive: false });
      (document.body || document.documentElement).appendChild(node);
    }
    const host = window.__gardendlessHost;
    const config = host ? host.config : (window.__gardendlessHostConfig || {});
    const enabled = config.watermarkEnabled !== false;
    node.style.display = enabled ? "block" : "none";
  }

  // Global capture tap listener: if the user taps anywhere in the bottom-right watermark area,
  // or triple-taps with 3 fingers anywhere on the screen, toggle the resolution HUD!
  if (typeof window.addEventListener === "function") {
    window.addEventListener("touchend", function (e) {
      if (e.touches && e.touches.length === 3) {
        e.stopPropagation();
        if (e.cancelable) e.preventDefault();
        togglePanel();
        return;
      }
      if (e.changedTouches && e.changedTouches.length === 1) {
        const t = e.changedTouches[0];
        const w = window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 1280;
        const h = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 720;
        if (t.clientX >= w - 240 && t.clientY >= h - 70) {
          e.stopPropagation();
          if (e.cancelable) e.preventDefault();
          togglePanel();
        }
      }
    }, { capture: true, passive: false });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render, { once: true });
  } else {
    render();
  }
})();
