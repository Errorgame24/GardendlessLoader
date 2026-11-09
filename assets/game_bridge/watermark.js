(function () {
  "use strict";
  const id = "gardendless-native-watermark";
  const panelId = "gardendless-lain-scale-panel";

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
    let panel = document.getElementById(panelId);
    if (panel) {
      panel.style.display = panel.style.display === "none" ? "block" : "none";
      return;
    }
    panel = document.createElement("div");
    panel.id = panelId;
    Object.assign(panel.style, {
      position: "fixed",
      right: "12px",
      bottom: "34px",
      zIndex: "2147483647",
      background: "rgba(12, 16, 14, 0.90)",
      border: "1px solid rgba(130, 210, 150, 0.42)",
      borderRadius: "10px",
      padding: "10px 12px",
      color: "#e8f5e9",
      font: "600 12px -apple-system,BlinkMacSystemFont,monospace,sans-serif",
      boxShadow: "0 6px 20px rgba(0,0,0,0.65)",
      backdropFilter: "blur(8px)",
      webkitBackdropFilter: "blur(8px)",
      userSelect: "none",
      minWidth: "225px"
    });

    const stopProp = function (e) { e.stopPropagation(); };
    ["pointerdown", "pointermove", "pointerup", "touchstart", "touchmove", "touchend", "mousedown", "click"].forEach(function (ev) {
      panel.addEventListener(ev, stopProp, { passive: false });
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

    const valLabel = document.createElement("span");
    valLabel.textContent = getScalePercent() + "%";
    valLabel.style.color = "#ffffff";
    valLabel.style.fontWeight = "700";

    header.appendChild(title);
    header.appendChild(valLabel);
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
      margin: "4px 0 8px 0"
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
    [1, 25, 50, 75, 85, 100].forEach(function (preset) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = preset + "%";
      Object.assign(btn.style, {
        flex: "1",
        padding: "3px 0",
        fontSize: "10px",
        fontWeight: "600",
        color: "#e8f5e9",
        background: "rgba(255,255,255,0.1)",
        border: "1px solid rgba(255,255,255,0.18)",
        borderRadius: "5px",
        cursor: "pointer"
      });
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        slider.value = String(preset);
        const pct = applyScalePercent(preset);
        valLabel.textContent = pct + "%";
      });
      presetsRow.appendChild(btn);
    });
    panel.appendChild(presetsRow);

    if (typeof window.__gardendlessGetTargetFps === "function") {
      const fpsHeader = document.createElement("div");
      Object.assign(fpsHeader.style, {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginTop: "8px",
        marginBottom: "4px"
      });
      const fpsTitle = document.createElement("span");
      fpsTitle.textContent = "FRAME CAP (COOLING)";
      fpsTitle.style.color = "#81c784";
      fpsTitle.style.fontSize = "10px";
      const fpsVal = document.createElement("span");
      fpsVal.textContent = window.__gardendlessGetTargetFps() + " FPS";
      fpsVal.style.color = "#ffffff";
      fpsVal.style.fontSize = "11px";
      fpsHeader.appendChild(fpsTitle);
      fpsHeader.appendChild(fpsVal);
      panel.appendChild(fpsHeader);

      const fpsRow = document.createElement("div");
      Object.assign(fpsRow.style, {
        display: "flex",
        gap: "4px",
        justifyContent: "space-between"
      });
      [30, 45, 60].forEach(function (fps) {
        const fBtn = document.createElement("button");
        fBtn.type = "button";
        fBtn.textContent = fps + " FPS";
        Object.assign(fBtn.style, {
          flex: "1",
          padding: "3px 0",
          fontSize: "10px",
          fontWeight: "600",
          color: "#e8f5e9",
          background: "rgba(255,255,255,0.1)",
          border: "1px solid rgba(255,255,255,0.18)",
          borderRadius: "5px",
          cursor: "pointer"
        });
        fBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          if (typeof window.__gardendlessSetTargetFps === "function") {
            const next = window.__gardendlessSetTargetFps(fps);
            fpsVal.textContent = next + " FPS";
          }
        });
        fpsRow.appendChild(fBtn);
      });
      panel.appendChild(fpsRow);
    }

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
        right: "12px",
        bottom: "10px",
        zIndex: "2147483646",
        pointerEvents: "auto",
        cursor: "pointer",
        userSelect: "none",
        color: "rgba(255,255,255,.52)",
        font: "600 12px -apple-system,BlinkMacSystemFont,monospace,sans-serif",
        letterSpacing: "0.3px",
        textShadow: "0 1px 2px rgba(0,0,0,.75)",
        padding: "2px 4px"
      });
      node.addEventListener("click", function (e) {
        e.stopPropagation();
        togglePanel();
      });
      node.addEventListener("touchend", function (e) {
        e.stopPropagation();
        e.preventDefault();
        togglePanel();
      }, { passive: false });
      (document.body || document.documentElement).appendChild(node);
    }
    const enabled = window.__gardendlessHost &&
      window.__gardendlessHost.config.watermarkEnabled !== false;
    node.style.display = enabled ? "block" : "none";
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render, { once: true });
  } else {
    render();
  }
})();
