(function () {
  "use strict";
  const id = "gardendless-native-watermark";
  const panelId = "gardendless-lain-hud";

  function toggleHud() {
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
      bottom: "32px",
      zIndex: "2147483647",
      background: "rgba(12, 16, 22, 0.88)",
      border: "1px solid rgba(120, 220, 255, 0.35)",
      borderRadius: "8px",
      padding: "10px 12px",
      color: "#e0f4ff",
      font: "500 12px -apple-system,BlinkMacSystemFont,sans-serif",
      boxShadow: "0 4px 16px rgba(0,0,0,0.6)",
      backdropFilter: "blur(6px)",
      webkitBackdropFilter: "blur(6px)",
      minWidth: "210px",
      userSelect: "none"
    });

    const state = window.__gardendlessGetRenderState
      ? window.__gardendlessGetRenderState()
      : { percent: 100, fpsCap: 60 };

    const titleRow = document.createElement("div");
    titleRow.style.marginBottom = "6px";
    titleRow.style.display = "flex";
    titleRow.style.justifyContent = "space-between";
    const label = document.createElement("span");
    label.textContent = "渲染分辨率: " + state.percent + "%";
    const closeBtn = document.createElement("span");
    closeBtn.textContent = "✕";
    closeBtn.style.cursor = "pointer";
    closeBtn.style.opacity = "0.7";
    closeBtn.onclick = function () { panel.style.display = "none"; };
    titleRow.appendChild(label);
    titleRow.appendChild(closeBtn);

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "1";
    slider.max = "100";
    slider.step = "1";
    slider.value = String(state.percent);
    slider.style.width = "100%";
    slider.style.margin = "4px 0 8px 0";
    slider.oninput = function () {
      const p = parseInt(slider.value, 10) || 100;
      label.textContent = "渲染分辨率: " + p + "%";
      if (window.__gardendlessSetLiveRenderScale) {
        window.__gardendlessSetLiveRenderScale(p, null);
      }
    };

    const fpsRow = document.createElement("div");
    fpsRow.style.display = "flex";
    fpsRow.style.gap = "6px";
    fpsRow.style.justifyContent = "space-between";
    [30, 48, 60].forEach(function (fps) {
      const btn = document.createElement("button");
      btn.textContent = fps + " FPS";
      Object.assign(btn.style, {
        flex: "1",
        padding: "4px 0",
        background: state.fpsCap === fps ? "rgba(80, 190, 255, 0.35)" : "rgba(255,255,255,0.1)",
        color: "#fff",
        border: "1px solid rgba(255,255,255,0.2)",
        borderRadius: "4px",
        fontSize: "11px"
      });
      btn.onclick = function () {
        Array.from(fpsRow.children).forEach(function (c) {
          c.style.background = "rgba(255,255,255,0.1)";
        });
        btn.style.background = "rgba(80, 190, 255, 0.35)";
        if (window.__gardendlessSetLiveRenderScale) {
          window.__gardendlessSetLiveRenderScale(parseInt(slider.value, 10) || 100, fps);
        }
      };
      fpsRow.appendChild(btn);
    });

    panel.appendChild(titleRow);
    panel.appendChild(slider);
    panel.appendChild(fpsRow);
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
        color: "rgba(255,255,255,.48)",
        font: "600 12px -apple-system,BlinkMacSystemFont,sans-serif",
        textShadow: "0 1px 2px rgba(0,0,0,.7)"
      });
      node.addEventListener("click", function (e) {
        e.stopPropagation();
        toggleHud();
      });
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
