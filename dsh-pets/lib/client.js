window.__ModuleLoader__.load({
	id: "dsh-pets",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
/* =========================================================================
 * dsh-pets · client bundle 源模板
 *
 * 这不是最终产物。构建脚本 build-client.mjs 会把本文件包进
 * window.__ModuleLoader__.load({ id, factory }) 外壳，生成 lib/client.js。
 *
 * 运行时约定（DSH client module 系统）：
 *   - factory(require) 返回 module.exports；require 命中 boot 图里的模块。
 *   - 导出 apply(ctx)：client root context，用 ctx.slots 注册 UI。
 *   - 导出 inject：本插件依赖的 client 服务名数组。
 *
 * 宠物资源由 host 半区从 ~/.dsh/pets 动态提供（见 lib/index.js）：
 *   - GET /__dsh-pets/list 返回宠物列表；
 *   - GET /__dsh-pets/asset/<id>/<file> 返回精灵图等资源。
 *
 * 逻辑对齐 guga/index.html（移植自 codex-rs/tui/src/pets）。
 * ========================================================================= */

const PETS_LIST_URL = "/__dsh-pets/list";

const react = require("react");
const { useState, useEffect, useRef, useCallback, useMemo, createElement } = react;

/* 统一用 createElement 构造元素，避免 jsx/jsxs 对数组 children 的区分问题。 */
const h = createElement;

/* ---- 精灵图几何（guga: 8 列 x 11 行, 单帧 192x208）---- */
const FRAME_W = 192;
const FRAME_H = 208;
const COLUMNS = 8;
const ROWS = 11;
const FRAME_COUNT = COLUMNS * ROWS;
const RENDER_SCALE = 0.5; // 96 x 104

/* ---- 动画数据结构 ---- */
function idleAnimation() {
  const spec = [[0, 1680], [1, 660], [2, 660], [3, 840], [4, 840], [5, 1920]];
  return {
    frames: spec.map(([spriteIndex, durationMs]) => ({ spriteIndex, durationMs })),
    loopStart: 0,
    fallback: "idle",
  };
}

function appStateAnimation(rowIndex, frameCount, frameDurationMs, finalFrameDurationMs) {
  const primary = [];
  for (let col = 0; col < frameCount; col++) {
    primary.push({
      spriteIndex: rowIndex * COLUMNS + col,
      durationMs: col === frameCount - 1 ? finalFrameDurationMs : frameDurationMs,
    });
  }
  // loopStart=0：核心帧从头无限循环，适配 DSH 联动的持续状态（running 等）。
  return { frames: primary, loopStart: 0, fallback: "idle" };
}

function defaultAnimations() {
  return {
    "idle": idleAnimation(),
    "running-right": appStateAnimation(1, 8, 120, 220),
    "running-left": appStateAnimation(2, 8, 120, 220),
    "waving": appStateAnimation(3, 4, 140, 280),
    "jumping": appStateAnimation(4, 5, 140, 280),
    "failed": appStateAnimation(5, 8, 140, 240),
    "waiting": appStateAnimation(6, 6, 150, 260),
    "running": appStateAnimation(7, 6, 120, 220),
    "review": appStateAnimation(8, 6, 150, 280),
  };
}

const NOTIFICATION_KINDS = {
  Running: { animation: "running", label: "Running", fallbackBody: "Thinking", lifetimeMs: 3 * 60 * 1000 },
  Waiting: { animation: "waiting", label: "Needs input", fallbackBody: "Needs input", lifetimeMs: 24 * 60 * 60 * 1000 },
  Review: { animation: "review", label: "Ready", fallbackBody: "Ready", lifetimeMs: 7 * 24 * 60 * 60 * 1000 },
  Failed: { animation: "failed", label: "Blocked", fallbackBody: "Blocked", lifetimeMs: 60 * 60 * 1000 },
};

/* ---- 动画时序 ---- */
function totalDurationMs(anim) {
  return anim.frames.reduce((s, f) => s + f.durationMs, 0);
}

function frameAtElapsed(anim, elapsedMs) {
  let remaining = elapsedMs;
  for (const f of anim.frames) {
    const dur = Math.max(f.durationMs, 1);
    if (remaining < dur) return { spriteIndex: f.spriteIndex, delayMs: dur - remaining };
    remaining -= dur;
  }
  const last = anim.frames[anim.frames.length - 1];
  return { spriteIndex: last.spriteIndex, delayMs: null };
}

function currentAnimationFrame(anim, elapsedMs) {
  if (anim.frames.length <= 1) return { spriteIndex: anim.frames[0].spriteIndex, delayMs: null };
  const total = totalDurationMs(anim);
  if (anim.loopStart != null && anim.loopStart < anim.frames.length) {
    const prefix = anim.frames.slice(0, anim.loopStart).reduce((s, f) => s + f.durationMs, 0);
    const loop = anim.frames.slice(anim.loopStart).reduce((s, f) => s + f.durationMs, 0);
    let effective = elapsedMs;
    if (elapsedMs >= total && loop > 0) effective = prefix + ((elapsedMs - prefix) % loop);
    return frameAtElapsed(anim, effective);
  } else if (elapsedMs >= total) {
    const last = anim.frames[anim.frames.length - 1];
    return { spriteIndex: last.spriteIndex, delayMs: null };
  }
  return frameAtElapsed(anim, elapsedMs);
}

/* ---- 宠物运行时 ---- */
class AmbientPet {
  constructor(sheet, animations) {
    this.sheet = sheet;
    this.animations = animations;
    this.notification = null;
    this._forcedAnimation = null;
    this.animationStartedAt = performance.now();
  }
  setNotification(kind, body) {
    if (kind === "idle") {
      this.notification = null;
    } else {
      const meta = NOTIFICATION_KINDS[kind];
      this.notification = { kind, body: body || (meta ? meta.fallbackBody : ""), updatedAt: performance.now() };
    }
    this._forcedAnimation = null;
    this.animationStartedAt = performance.now();
  }
  playAnimation(name) {
    this._forcedAnimation = this.animations[name] ? name : null;
    this.notification = null;
    this.animationStartedAt = performance.now();
  }
  visibleNotification(now) {
    if (!this.notification) return null;
    const meta = NOTIFICATION_KINDS[this.notification.kind];
    if (now - this.notification.updatedAt >= meta.lifetimeMs) return null;
    return this.notification;
  }
  currentAnimation() {
    const now = performance.now();
    let name = "idle";
    if (this._forcedAnimation) {
      name = this._forcedAnimation;
    } else {
      const notif = this.visibleNotification(now);
      if (notif) name = NOTIFICATION_KINDS[notif.kind].animation;
    }
    let anim = this.animations[name] || this.animations["idle"];
    if (anim.loopStart == null) {
      const elapsed = now - this.animationStartedAt;
      if (elapsed >= totalDurationMs(anim) && this.animations[anim.fallback]) {
        this._forcedAnimation = null;
        anim = this.animations[anim.fallback];
      }
    }
    return anim;
  }
  currentSpriteIndex() {
    const anim = this.currentAnimation();
    const elapsed = performance.now() - this.animationStartedAt;
    return currentAnimationFrame(anim, elapsed).spriteIndex;
  }
}

function drawSprite(ctx, sheet, spriteIndex) {
  const col = spriteIndex % COLUMNS;
  const row = Math.floor(spriteIndex / COLUMNS);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.drawImage(sheet, col * FRAME_W, row * FRAME_H, FRAME_W, FRAME_H, 0, 0, ctx.canvas.width, ctx.canvas.height);
}

/* ---- 本地持久化 ---- */
const LS_SELECTED = "dsh-pets:selected";
const LS_ENABLED = "dsh-pets:enabled";
const LS_POS = "dsh-pets:pos";
const LS_FOLLOW = "dsh-pets:follow";

function lsGet(key, fallback) {
  try {
    const v = window.localStorage.getItem(key);
    return v == null ? fallback : v;
  } catch { return fallback; }
}
function lsSet(key, value) {
  try { window.localStorage.setItem(key, value); } catch { /* ignore */ }
}

/* 全局状态 store：订阅式单例，宠物窗与设置页共享。
 * pets 从 host /__dsh-pets/list 动态拉取。 */
const petStore = (() => {
  let state = {
    pets: [],                 // [{ id, displayName, description, spritesheetUrl }]
    loading: false,
    error: null,
    loaded: false,
    selectedId: lsGet(LS_SELECTED, ""),
    enabled: lsGet(LS_ENABLED, "1") !== "0",
    follow: lsGet(LS_FOLLOW, "1") !== "0",
  };
  const listeners = new Set();
  const emit = () => { for (const l of listeners) l(); };
  const set = (patch) => { state = { ...state, ...patch }; emit(); };

  async function loadPets() {
    if (state.loading) return;
    set({ loading: true, error: null });
    try {
      const resp = await fetch(PETS_LIST_URL, { headers: { accept: "application/json" } });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      const pets = Array.isArray(data && data.pets) ? data.pets : [];
      // 选中项：优先保留已选且仍存在的；否则取第一个。
      let selectedId = state.selectedId;
      if (!selectedId || !pets.some((p) => p.id === selectedId)) {
        selectedId = pets.length ? pets[0].id : "";
        if (selectedId) lsSet(LS_SELECTED, selectedId);
      }
      set({ pets, loading: false, loaded: true, selectedId });
    } catch (err) {
      set({ loading: false, loaded: true, error: (err && err.message) || String(err) });
    }
  }

  return {
    get: () => state,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    loadPets,
    setSelected: (id) => { set({ selectedId: id }); lsSet(LS_SELECTED, id); },
    setEnabled: (on) => { set({ enabled: on }); lsSet(LS_ENABLED, on ? "1" : "0"); },
    setFollow: (on) => { set({ follow: on }); lsSet(LS_FOLLOW, on ? "1" : "0"); },
  };
})();

function usePetStore() {
  const [snap, setSnap] = useState(petStore.get());
  useEffect(() => petStore.subscribe(() => setSnap(petStore.get())), []);
  return snap;
}

function petById(pets, id) {
  return pets.find((p) => p.id === id) || pets[0] || null;
}

/* ---- 精灵图加载缓存（每个宠物一份 ImageBitmap）---- */
const sheetCache = new Map();
function sheetUrlOf(pet) {
  return pet.spritesheetUrl || ("/__dsh-pets/asset/" + encodeURIComponent(pet.id) + "/spritesheet.webp");
}
function loadSheet(pet) {
  const url = sheetUrlOf(pet);
  if (sheetCache.has(pet.id)) return sheetCache.get(pet.id);
  const task = (async () => {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const blob = await resp.blob();
    if (typeof createImageBitmap === "function") return await createImageBitmap(blob);
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("image load failed"));
      img.src = url;
    });
  })();
  sheetCache.set(pet.id, task);
  return task;
}

/* ---- 宠物 canvas（受控播放 forced/notification 动画）---- */
function applyAnim(pet, forced, notif) {
  if (forced) pet.playAnimation(forced);
  else if (notif) pet.setNotification(notif);
  else pet.setNotification("idle");
}

function PetCanvas({ petMeta, notif, forced, size }) {
  const canvasRef = useRef(null);
  const petObjRef = useRef(null);
  const scale = (size || RENDER_SCALE * FRAME_H) / FRAME_H;
  const w = Math.round(FRAME_W * scale);
  const hh = Math.round(FRAME_H * scale);

  // 保存最新的 forced/notif，供精灵图异步加载完成后补应用（避免
  // forced 在 sheet 就绪前变化时被第二个 effect 跳过）。
  const animRef = useRef({ forced, notif });
  animRef.current = { forced, notif };

  useEffect(() => {
    let raf = 0, disposed = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    loadSheet(petMeta).then((sheet) => {
      if (disposed) return;
      const pet = new AmbientPet(sheet, defaultAnimations());
      petObjRef.current = pet;
      applyAnim(pet, animRef.current.forced, animRef.current.notif);
      const tick = () => {
        if (disposed) return;
        const p = petObjRef.current;
        if (p) drawSprite(ctx, p.sheet, p.currentSpriteIndex());
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    });
    return () => { disposed = true; cancelAnimationFrame(raf); };
  }, [petMeta.id]);

  // 外部驱动：forced 动画 / notification
  useEffect(() => {
    const p = petObjRef.current;
    if (!p) return;
    applyAnim(p, forced, notif);
  }, [forced, notif]);

  return h("canvas", { ref: canvasRef, width: w, height: hh, className: "dshpet-canvas" });
}

/* ---- 把 DSH 会话状态映射为宠物动画名 ---- */
function deriveAnimState(snapshot) {
  if (!snapshot) return "idle";
  if (snapshot.promptError || snapshot.lastAgentError) return "failed";
  if (snapshot.pending && snapshot.pending.length > 0) return "review";
  if (snapshot.running) return "running";
  return "idle";
}

/* ---- 可拖拽悬浮窗宠物 ---- */
function PetFloating(props) {
  const { useSession } = props || {};
  const { pets, selectedId, enabled, loaded, follow } = usePetStore();
  // 首次挂载时确保宠物列表已拉取。
  useEffect(() => { if (!loaded) petStore.loadPets(); }, [loaded]);
  const petMeta = petById(pets, selectedId);

  // 跟随 DSH 运行状态：session-scope slot 注入 useSession（无则静态 idle）。
  const animState = useSession ? useSession(deriveAnimState) : "idle";
  const forced = follow && animState !== "idle" ? animState : null;

  const [pos, setPos] = useState(() => {
    try {
      const raw = lsGet(LS_POS, "");
      if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
    return { right: 24, bottom: 96 };
  });
  const dragRef = useRef(null);

  const onPointerDown = useCallback((e) => {
    const startX = e.clientX, startY = e.clientY;
    const startPos = { ...pos };
    // 若之前用 right/bottom 定位，拖拽时改用 left/top 便于计算。
    const rect = dragRef.current ? dragRef.current.getBoundingClientRect() : { left: 0, top: 0 };
    const base = { left: rect.left, top: rect.top };
    const move = (ev) => {
      const nx = base.left + (ev.clientX - startX);
      const ny = base.top + (ev.clientY - startY);
      const clampedX = Math.max(0, Math.min(window.innerWidth - 60, nx));
      const clampedY = Math.max(0, Math.min(window.innerHeight - 60, ny));
      setPos({ left: clampedX, top: clampedY });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setPos((cur) => { lsSet(LS_POS, JSON.stringify(cur)); return cur; });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    e.preventDefault();
    void startPos;
  }, [pos]);

  if (!enabled || !petMeta) return null;

  const style = pos.left != null
    ? { left: pos.left + "px", top: pos.top + "px" }
    : { right: (pos.right ?? 24) + "px", bottom: (pos.bottom ?? 96) + "px" };

  return h(
    "div",
    {
      ref: dragRef,
      className: "dshpet-float",
      style,
      onPointerDown,
      title: petMeta.displayName + " · 拖拽移动",
    },
    h(PetCanvas, { petMeta, notif: null, forced, size: 104 })
  );
}

/* ---- 设置页：宠物管理 ---- */
function PetSettingsSection() {
  const { pets, selectedId, enabled, follow, loading, error, loaded } = usePetStore();
  const [previewAnim, setPreviewAnim] = useState(null);
  const [previewNotif, setPreviewNotif] = useState(null);
  useEffect(() => { if (!loaded) petStore.loadPets(); }, [loaded]);
  const petMeta = petById(pets, selectedId);
  const animNames = useMemo(() => Object.keys(defaultAnimations()), []);

  // 宠物列表区域：加载中 / 出错 / 空 / 正常。
  let listNode;
  if (loading && !loaded) {
    listNode = h("div", { className: "dshpet-empty" }, "正在加载宠物…");
  } else if (error) {
    listNode = h("div", { className: "dshpet-empty" }, "加载宠物失败：" + error);
  } else if (!pets.length) {
    listNode = h(
      "div",
      { className: "dshpet-empty" },
      h("div", null, "还没有宠物。"),
      h("div", { className: "dshpet-hint" }, "把宠物文件夹放进 ~/.dsh/pets/（每个目录含 pet.json 和精灵图），然后点“刷新”。")
    );
  } else {
    listNode = h(
      "div",
      { className: "dshpet-list" },
      pets.map((p) =>
        h(
          "button",
          {
            key: p.id,
            type: "button",
            className: "dshpet-card" + (p.id === selectedId ? " active" : ""),
            onClick: () => petStore.setSelected(p.id),
          },
          h("div", { className: "dshpet-card-preview" }, h(PetCanvas, { petMeta: p, notif: null, forced: null, size: 104 })),
          h("div", { className: "dshpet-card-name" }, p.displayName),
          p.description ? h("div", { className: "dshpet-card-desc" }, p.description) : null
        )
      )
    );
  }

  const previewNode = petMeta
    ? h("div", { className: "dshpet-preview" }, h(PetCanvas, { petMeta, notif: previewNotif, forced: previewAnim, size: 130 }))
    : null;

  return h(
    "div",
    { className: "dshpet-settings" },
    h("h3", { className: "dshpet-h" }, "桌面宠物"),
    h(
      "label",
      { className: "dshpet-row" },
      h("input", {
        type: "checkbox",
        checked: enabled,
        onChange: (e) => petStore.setEnabled(e.target.checked),
      }),
      h("span", null, "在页面上显示宠物（可拖拽悬浮窗）")
    ),
    h(
      "label",
      { className: "dshpet-row" },
      h("input", {
        type: "checkbox",
        checked: follow,
        onChange: (e) => petStore.setFollow(e.target.checked),
      }),
      h("span", null, "跟随 DSH 运行状态（运行 / 审查 / 失败时切换动画）")
    ),
    h(
      "div",
      { className: "dshpet-listhead" },
      h("span", { className: "dshpet-label" }, "选择宠物"),
      h("button", { type: "button", className: "dshpet-btn small", disabled: loading, onClick: () => petStore.loadPets() }, loading ? "刷新中…" : "刷新")
    ),
    listNode,
    petMeta ? h("div", { className: "dshpet-label" }, "预览（当前选中宠物）") : null,
    previewNode,
    petMeta ? h("div", { className: "dshpet-label" }, "任务状态演示") : null,
    petMeta ? h(
      "div",
      { className: "dshpet-btns" },
      h("button", { type: "button", className: "dshpet-btn", onClick: () => { setPreviewAnim(null); setPreviewNotif(null); } }, "Idle"),
      Object.keys(NOTIFICATION_KINDS).map((k) =>
        h("button", { key: k, type: "button", className: "dshpet-btn", onClick: () => { setPreviewAnim(null); setPreviewNotif(k); } }, k)
      )
    ) : null,
    petMeta ? h("div", { className: "dshpet-label" }, "动画预览") : null,
    petMeta ? h(
      "div",
      { className: "dshpet-btns" },
      animNames.map((n) =>
        h("button", { key: n, type: "button", className: "dshpet-btn small", onClick: () => { setPreviewNotif(null); setPreviewAnim(n); } }, n)
      )
    ) : null,
    h("p", { className: "dshpet-hint" }, "宠物从 ~/.dsh/pets 动态加载：新增宠物只需放入该目录并点“刷新”（或刷新页面）。悬浮窗可用鼠标拖动，位置会被记住。")
  );
}

/* ---- CSS 注入 ---- */
const CSS = `
.dshpet-float{position:fixed;z-index:9999;display:flex;flex-direction:column;align-items:center;cursor:grab;user-select:none;touch-action:none;filter:drop-shadow(0 6px 12px rgba(0,0,0,.35));}
.dshpet-float:active{cursor:grabbing;}
.dshpet-canvas{image-rendering:pixelated;display:block;}
.dshpet-settings{display:flex;flex-direction:column;gap:12px;padding:4px 2px;}
.dshpet-h{margin:0;font-size:15px;font-weight:600;}
.dshpet-row{display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;}
.dshpet-label{font-size:12px;opacity:.7;margin-top:4px;}
.dshpet-listhead{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:4px;}
.dshpet-list{display:flex;flex-wrap:wrap;gap:12px;}
.dshpet-empty{display:flex;flex-direction:column;gap:6px;padding:12px;border:1px dashed var(--dsw-alias-border-l1,#30363d);border-radius:10px;font-size:13px;opacity:.85;}
.dshpet-btn:disabled{opacity:.5;cursor:default;}
.dshpet-card{display:flex;flex-direction:column;align-items:center;gap:6px;width:140px;padding:10px;border:1px solid var(--dsw-alias-border-l1,#30363d);border-radius:10px;background:transparent;cursor:pointer;color:inherit;font:inherit;}
.dshpet-card:hover{border-color:var(--dsw-alias-state-business-primary,#58a6ff);}
.dshpet-card.active{border-color:var(--dsw-alias-state-business-primary,#58a6ff);background:var(--dsw-alias-interactive-bg-hover,rgba(88,166,255,.08));}
.dshpet-card-preview{height:104px;display:flex;align-items:flex-end;}
.dshpet-card-name{font-size:13px;font-weight:500;}
.dshpet-card-desc{font-size:11px;opacity:.6;text-align:center;line-height:1.3;}
.dshpet-preview{height:130px;display:flex;align-items:flex-end;padding:8px 0;}
.dshpet-btns{display:flex;flex-wrap:wrap;gap:6px;}
.dshpet-btn{border:1px solid var(--dsw-alias-border-l1,#30363d);border-radius:6px;padding:5px 11px;font-size:12px;background:transparent;color:inherit;cursor:pointer;}
.dshpet-btn:hover{border-color:var(--dsw-alias-state-business-primary,#58a6ff);}
.dshpet-btn.small{padding:4px 9px;font-size:11px;}
.dshpet-hint{font-size:11px;opacity:.55;line-height:1.4;margin:4px 0 0;}
`;
function injectCss() {
  if (typeof document === "undefined") return;
  const tagId = "dsh-pets/style.css";
  if (document.querySelector('style[data-plugin-css="' + tagId + '"]')) return;
  const tag = document.createElement("style");
  tag.dataset.plugin = "dsh-pets";
  tag.dataset.pluginCss = tagId;
  tag.textContent = CSS;
  document.head.appendChild(tag);
}

/* ---- 插件入口 ---- */
const inject = ["slots"];

function apply(ctx) {
  injectCss();

  // 启动即拉取宠物列表（组件挂载时也会兜底触发）。
  petStore.loadPets();

  // 宠物悬浮窗：挂到对话输入区覆盖层（session 作用域的 list slot）。
  ctx.slots.inject("conversation.input.overlay", () =>
    ctx.slots.register(
      { name: "conversation.input.overlay", id: "dsh-pets-float", order: 50 },
      PetFloating
    )
  );

  // 宠物管理子菜单：挂到设置页 section 列表。
  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      { name: "settings.section", id: "pets", order: 60, label: "桌面宠物" },
      PetSettingsSection
    )
  );
}

module.exports.apply = apply;
module.exports.inject = inject;

		return module.exports;
	}
});
