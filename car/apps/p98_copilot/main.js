/* generated from car/src — do not edit */
"use strict";

// src/safe.ts
var SAFE_LOG_INTERVAL_MS = 6e4;
var MAX_LABELS = 64;
var lastLogged = /* @__PURE__ */ Object.create(null);
var labelCount = 0;
function describe(error) {
  try {
    if (error instanceof Error) return error.stack || error.message || error.name;
    return String(error);
  } catch (e) {
    return "unprintable error";
  }
}
function report(log, label, error) {
  try {
    const now = Date.now();
    const last = lastLogged[label];
    if (last !== void 0 && now >= last && now - last < SAFE_LOG_INTERVAL_MS) return;
    if (last === void 0) {
      if (labelCount >= MAX_LABELS) {
        lastLogged = /* @__PURE__ */ Object.create(null);
        labelCount = 0;
      }
      labelCount++;
    }
    lastLogged[label] = now;
    log.error(label + ": " + describe(error));
  } catch (e) {
  }
}
function isThenable(value) {
  return value !== null && (typeof value === "object" || typeof value === "function") && typeof value.then === "function";
}
function safe(log, label, fn) {
  return (...args) => {
    try {
      const result = fn(...args);
      if (isThenable(result)) {
        result.then(void 0, (error) => report(log, label, error));
      }
    } catch (error) {
      report(log, label, error);
    }
  };
}

// src/main.ts
var mgu = require("./kit/mgu");
var MAIN = "MAIN";
var MAIN_GFX = "MAIN_GFX";
var WIDTH = 1600;
var HEIGHT = 520;
var GROUND = "#05070a";
var INK = "#f2f5f8";
function drawShell(ctx) {
  const cv = ctx.canvas(WIDTH, HEIGHT).clear(GROUND);
  cv.text("Copilot", WIDTH / 2, HEIGHT / 2 + 18, 48, INK, { align: "center", font: "light" });
  return ctx.ui.image(MAIN_GFX, cv);
}
var app = {
  async start(ctx) {
    let drawn = false;
    const frame = safe(ctx.log, "frame", () => {
      if (drawn) return void 0;
      drawn = true;
      return drawShell(ctx);
    });
    ctx.ui.onVisible(safe(ctx.log, "visible", (name, on) => {
      if (name === MAIN && !on) drawn = false;
    }));
    ctx.onLayout(safe(ctx.log, "layout", () => {
      drawn = false;
    }));
    ctx.loop(MAIN, 1, frame);
  }
};
safe(mgu.log, "run", () => mgu.run(app))();
