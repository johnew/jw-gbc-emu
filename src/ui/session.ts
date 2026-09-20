import { Emulator } from "../core/emulator";
import {
  DMG_PALETTE_IDS,
  DMG_PALETTE_LABELS,
  dmgLightColor,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  type Button,
  type DmgPaletteId,
} from "../core/types";
import { AudioOutput } from "../audio/output";
import { isMobileLayout, takeFrameBudget } from "./layout";
import type { LinkUiState } from "./linkUi";
import { openOptionsModal } from "./options";
import { errorText } from "./util";

const KEY_MAP: Record<string, Button> = {
  ArrowRight: "right",
  ArrowLeft: "left",
  ArrowUp: "up",
  ArrowDown: "down",
  KeyZ: "a",
  KeyX: "b",
  Enter: "start",
  ShiftRight: "select",
  ShiftLeft: "select",
  KeyA: "left",
  KeyD: "right",
  KeyW: "up",
  KeyS: "down",
  KeyJ: "b",
  KeyK: "a",
};

export interface SessionCallbacks {
  onFocus: (session: EmulatorSession) => void;
  /** ROM title / CGB flag changed — refresh tab labels. */
  onRomMetaChanged: (session: EmulatorSession) => void;
  onAddGame?: () => void;
  onRemoveGame?: () => void;
  onToggleLink?: () => void;
}

let nextSessionId = 1;

export class EmulatorSession {
  readonly id: number;
  readonly root: HTMLElement;
  readonly emu = new Emulator();
  readonly audio = new AudioOutput();

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private imageData: ImageData;
  private pixels: Uint32Array;
  private stage: HTMLElement;
  private statusEl: HTMLElement;
  private speedBtn: HTMLButtonElement;
  private muteBtn: HTMLButtonElement;
  private scaleSelect: HTMLSelectElement;
  private paletteSelect: HTMLSelectElement;
  private slotSelect: HTMLSelectElement;
  private slotHint: HTMLElement;
  private titleEl: HTMLElement;
  private mobileTitleEl: HTMLElement;
  private settingsSheet: HTMLElement;
  private mpAddBtn: HTMLButtonElement;
  private mpRemoveBtn: HTMLButtonElement;
  private mpLinkBtn: HTMLButtonElement;
  private mpLinkStatus: HTMLElement;

  private romLoaded = false;
  private frameAcc = 0;
  private lastTs = performance.now();
  private focused = false;
  private readonly cb: SessionCallbacks;

  constructor(host: HTMLElement, label: string, cb: SessionCallbacks) {
    this.id = nextSessionId++;
    this.cb = cb;

    const paletteOptions = DMG_PALETTE_IDS.map(
      (id) => `<option value="${id}">${DMG_PALETTE_LABELS[id]}</option>`,
    ).join("");
    const slotOptions = Array.from({ length: 9 }, (_, i) => {
      const n = i + 1;
      return `<option value="${n}">Slot ${n}</option>`;
    }).join("");

    this.root = document.createElement("section");
    this.root.className = "session";
    this.root.dataset.sessionId = String(this.id);
    this.root.innerHTML = `
      <div class="session-head">
        <h2 class="session-title">${label}</h2>
        <span class="session-focus-tag">Click to control</span>
      </div>
      <div class="play-deck">
        <p class="mobile-title" data-mobile-title>${label}</p>
        <div class="touch-dpad" role="group" aria-label="D-pad">
          <button type="button" class="touch-btn touch-up" data-btn="up" aria-label="Up">▲</button>
          <button type="button" class="touch-btn touch-left" data-btn="left" aria-label="Left">◀</button>
          <button type="button" class="touch-btn touch-right" data-btn="right" aria-label="Right">▶</button>
          <button type="button" class="touch-btn touch-down" data-btn="down" aria-label="Down">▼</button>
          <span class="touch-dpad-center" aria-hidden="true"></span>
        </div>
        <div class="stage" tabindex="0">
          <canvas width="${SCREEN_WIDTH}" height="${SCREEN_HEIGHT}" aria-label="Game Boy screen"></canvas>
        </div>
        <div class="touch-face" role="group" aria-label="Action buttons">
          <button type="button" class="touch-btn touch-b" data-btn="b" aria-label="B">B</button>
          <button type="button" class="touch-btn touch-a" data-btn="a" aria-label="A">A</button>
        </div>
        <div class="touch-system" role="group" aria-label="System buttons">
          <button type="button" class="touch-btn touch-select" data-btn="select" aria-label="Select">Select</button>
          <button type="button" class="touch-btn touch-start" data-btn="start" aria-label="Start">Start</button>
        </div>
        <button type="button" class="settings-fab" data-settings-open aria-label="Open settings">⚙</button>
      </div>
      <div class="settings-sheet" data-settings-sheet hidden>
        <button type="button" class="settings-backdrop" data-settings-close aria-label="Close settings"></button>
        <div class="settings-sheet-panel" role="dialog" aria-label="Settings">
          <header class="settings-sheet-head">
            <h2>Settings</h2>
            <button type="button" class="settings-sheet-close" data-settings-close aria-label="Close">×</button>
          </header>
          <div class="controls-panel">
            <div class="action-bar" role="toolbar" aria-label="Emulator actions">
              <label class="file-btn">
                Open ROM
                <input type="file" accept=".gb,.gbc,.bin" hidden data-rom />
              </label>
              <button type="button" data-speed>Speed 1x</button>
              <button type="button" data-mute>Mute</button>
              <button type="button" data-save-state>Save</button>
              <button type="button" data-load-state>Load</button>
              <button type="button" data-options>Options</button>
              <button type="button" class="desktop-only" data-fullscreen>Fullscreen</button>
            </div>
            <div class="settings-row">
              <label class="setting-label">
                Shades
                <select data-palette>${paletteOptions}</select>
              </label>
              <label class="setting-label setting-desktop">
                Scale
                <select data-scale>
                  <option value="2">2×</option>
                  <option value="3" selected>3×</option>
                  <option value="4">4×</option>
                  <option value="fit">Fit</option>
                </select>
              </label>
              <label class="setting-label">
                Slot
                <select data-slot>${slotOptions}</select>
              </label>
              <span class="slot-hint" data-slot-hint></span>
            </div>
            <div class="mobile-global-actions">
              <button type="button" data-add-game>Add second game</button>
              <button type="button" data-remove-game hidden>Close second game</button>
              <button type="button" data-toggle-link hidden>Connect link cable</button>
              <span class="link-status" data-session-link-status hidden></span>
            </div>
            <p class="status" data-status>No ROM loaded</p>
          </div>
        </div>
      </div>
    `;
    host.appendChild(this.root);

    this.canvas = this.root.querySelector("canvas")!;
    this.ctx = this.canvas.getContext("2d", { alpha: false })!;
    this.imageData = this.ctx.createImageData(SCREEN_WIDTH, SCREEN_HEIGHT);
    this.pixels = new Uint32Array(this.imageData.data.buffer);
    this.stage = this.root.querySelector(".stage")!;
    this.statusEl = this.root.querySelector("[data-status]")!;
    this.speedBtn = this.root.querySelector("[data-speed]")!;
    this.muteBtn = this.root.querySelector("[data-mute]")!;
    this.scaleSelect = this.root.querySelector("[data-scale]")!;
    this.paletteSelect = this.root.querySelector("[data-palette]")!;
    this.slotSelect = this.root.querySelector("[data-slot]")!;
    this.slotHint = this.root.querySelector("[data-slot-hint]")!;
    this.titleEl = this.root.querySelector(".session-title")!;
    this.mobileTitleEl = this.root.querySelector("[data-mobile-title]")!;
    this.settingsSheet = this.root.querySelector("[data-settings-sheet]")!;
    this.mpAddBtn = this.root.querySelector("[data-add-game]")!;
    this.mpRemoveBtn = this.root.querySelector("[data-remove-game]")!;
    this.mpLinkBtn = this.root.querySelector("[data-toggle-link]")!;
    this.mpLinkStatus = this.root.querySelector("[data-session-link-status]")!;

    this.bindUi();
    this.bindTouchPad();
    this.bindSettingsSheet();
    if (isMobileLayout()) {
      this.scaleSelect.value = "fit";
    } else {
      // Desktop: settings sheet is the normal always-visible controls panel
      this.settingsSheet.hidden = false;
    }
    this.applyScale();
    this.applyPalette("green");
  }

  get hasRom(): boolean {
    return this.romLoaded;
  }

  setFocused(focused: boolean): void {
    this.focused = focused;
    this.root.classList.toggle("focused", focused);
  }

  destroy(): void {
    this.emu.unload();
    void this.audio.close();
    this.root.remove();
  }

  tick(now: number): void {
    const dt = now - this.lastTs;
    this.lastTs = now;
    if (!this.romLoaded) return;
    // When linked, the app drives lockstep frames instead
    if (this.emu.isLinked()) return;

    const paced = takeFrameBudget(this.frameAcc, dt, this.emu.getSpeed());
    this.frameAcc = paced.accumulatorMs;
    for (let i = 0; i < paced.frames; i++) this.advanceOneFrame();
  }

  /** Used for link-cable lockstep: both games advance one frame together. */
  lockstepFrame(): void {
    if (!this.romLoaded) return;
    this.advanceOneFrame();
  }

  syncClock(now: number): void {
    this.lastTs = now;
    this.frameAcc = 0;
  }

  /**
   * Re-apply canvas sizing after mobile/desktop or tab switches.
   * The first session can keep stale inline sizes if it was created before
   * the shell entered mobile mode.
   */
  refreshDisplayLayout(onMobile = isMobileLayout()): void {
    if (onMobile) {
      this.scaleSelect.value = "fit";
      if (this.settingsSheet.dataset.userOpen !== "1") this.settingsSheet.hidden = true;
    } else {
      this.settingsSheet.hidden = false;
    }
    this.applyScale();
    this.paint();
  }

  private advanceOneFrame(): void {
    this.emu.runFrame();
    const samples = this.emu.takeAudioSamples();
    this.audio.pushSamples(samples, this.emu.getSpeed());
    this.paint();
  }

  refreshSpeedButton(): void {
    this.speedBtn.textContent = `Speed ${this.emu.getSpeed()}x`;
  }

  async unlockAudio(): Promise<void> {
    await this.audio.resume();
  }

  handleKeyDown(e: KeyboardEvent): boolean {
    if (!this.focused) return false;
    if (e.code === "F5") {
      e.preventDefault();
      this.doSaveState();
      return true;
    }
    if (e.code === "F7") {
      e.preventDefault();
      this.doLoadState();
      return true;
    }
    if (/^Digit[1-9]$/.test(e.code) && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag !== "INPUT" && tag !== "SELECT" && tag !== "TEXTAREA") {
        this.slotSelect.value = e.code.slice(-1);
        this.refreshSlotHints();
        return true;
      }
    }
    if (e.code === "Tab") {
      e.preventDefault();
      void this.unlockAudio();
      this.emu.cycleSpeed();
      this.refreshSpeedButton();
      this.frameAcc = 0;
      return true;
    }
    if (e.code === "KeyP") {
      e.preventDefault();
      if (this.emu.isCgb) return true;
      const next = this.emu.cycleDmgPalette();
      this.applyPalette(next);
      return true;
    }
    if (e.code === "KeyF") {
      if (isMobileLayout()) return false;
      e.preventDefault();
      void this.toggleFullscreen();
      return true;
    }
    if (e.code === "KeyM") {
      this.toggleMute();
      return true;
    }
    const btn = KEY_MAP[e.code];
    if (btn) {
      e.preventDefault();
      void this.unlockAudio();
      this.emu.setButton(btn, true);
      return true;
    }
    return false;
  }

  handleKeyUp(e: KeyboardEvent): boolean {
    if (!this.focused) return false;
    const btn = KEY_MAP[e.code];
    if (btn) {
      e.preventDefault();
      this.emu.setButton(btn, false);
      return true;
    }
    return false;
  }

  flushSave(): void {
    this.emu.flushSave();
  }

  getSelectedSlot(): number {
    return Number(this.slotSelect.value) || 1;
  }

  /** BackupHost */
  reportStatus(text: string): void {
    this.setStatus(text);
  }

  /** BackupHost */
  refreshSlotHints(): void {
    if (!this.romLoaded) {
      this.slotHint.textContent = "";
      return;
    }
    const occupied = this.emu.occupiedSlots();
    const cur = this.getSelectedSlot();
    const mark = occupied.includes(cur) ? "filled" : "empty";
    this.slotHint.textContent =
      occupied.length === 0
        ? `Slot ${cur} empty`
        : `Slot ${cur} ${mark} · used: ${occupied.join(", ")}`;
  }

  onSavestateApplied(): void {
    this.frameAcc = 0;
    this.paint();
    this.paletteSelect.value = this.emu.getDmgPalette();
    this.refreshSlotHints();
  }

  private setDisplayTitle(name: string): void {
    this.titleEl.textContent = name;
    this.mobileTitleEl.textContent = name;
  }

  private bindUi(): void {
    const focus = () => this.cb.onFocus(this);
    this.root.addEventListener("pointerdown", focus);
    this.stage.addEventListener("focus", focus);

    this.root.querySelector<HTMLInputElement>("[data-rom]")!.addEventListener("change", async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      await this.unlockAudio();
      const buf = new Uint8Array(await file.arrayBuffer());
      this.emu.loadRom(buf);
      this.romLoaded = true;
      this.lastTs = performance.now();
      this.frameAcc = 0;
      this.refreshSlotHints();
      this.setDisplayTitle(this.emu.title || "Game");
      this.syncShadeAvailability();
      this.refreshDisplayLayout();
      this.setStatus(`${this.emu.title}${this.emu.isCgb ? " (CGB)" : " (DMG)"} — playing`);
      this.cb.onRomMetaChanged(this);
      focus();
    });

    this.root.querySelector("[data-fullscreen]")!.addEventListener("click", () => {
      void this.unlockAudio();
      void this.toggleFullscreen();
    });

    this.speedBtn.addEventListener("click", async () => {
      await this.unlockAudio();
      this.emu.cycleSpeed();
      this.refreshSpeedButton();
      this.frameAcc = 0;
      focus();
    });

    this.muteBtn.addEventListener("click", async () => {
      await this.unlockAudio();
      this.toggleMute();
      focus();
    });

    this.root.querySelector("[data-save-state]")!.addEventListener("click", () => {
      this.doSaveState();
      focus();
    });
    this.root.querySelector("[data-load-state]")!.addEventListener("click", () => {
      this.doLoadState();
      focus();
    });
    this.root.querySelector("[data-options]")!.addEventListener("click", () => {
      openOptionsModal(this);
      focus();
    });

    this.slotSelect.addEventListener("change", () => this.refreshSlotHints());
    this.paletteSelect.addEventListener("change", () => {
      this.applyPalette(this.paletteSelect.value as DmgPaletteId);
    });
    this.scaleSelect.addEventListener("change", () => this.applyScale());
  }

  private syncShadeAvailability(): void {
    const cgb = this.emu.isCgb;
    this.paletteSelect.disabled = cgb;
    const label = this.paletteSelect.closest(".setting-label");
    if (label instanceof HTMLElement) {
      label.title = cgb
        ? "Shades apply to Game Boy (DMG) games only — this ROM is Game Boy Color"
        : "DMG LCD shade preset";
    }
  }

  private openSettingsSheet(): void {
    this.settingsSheet.hidden = false;
    this.settingsSheet.dataset.userOpen = "1";
    this.paletteSelect.value = this.emu.getDmgPalette();
    this.syncShadeAvailability();
    this.cb.onFocus(this);
  }

  closeSettingsSheet(): void {
    this.settingsSheet.hidden = true;
    delete this.settingsSheet.dataset.userOpen;
  }

  private bindSettingsSheet(): void {
    this.root.querySelector("[data-settings-open]")!.addEventListener("click", (e) => {
      e.stopPropagation();
      this.openSettingsSheet();
    });
    this.root.querySelectorAll("[data-settings-close]").forEach((el) => {
      el.addEventListener("click", () => this.closeSettingsSheet());
    });

    this.mpAddBtn.addEventListener("click", () => {
      this.cb.onAddGame?.();
      this.closeSettingsSheet();
    });
    this.mpRemoveBtn.addEventListener("click", () => {
      this.cb.onRemoveGame?.();
      this.closeSettingsSheet();
    });
    this.mpLinkBtn.addEventListener("click", () => {
      this.cb.onToggleLink?.();
    });
  }

  /** Keep mobile settings sheet dual-game / link controls in sync with the app. */
  syncMultiplayerUi(state: LinkUiState): void {
    this.mpAddBtn.hidden = state.dual;
    this.mpRemoveBtn.hidden = !state.dual;
    this.mpLinkBtn.hidden = !state.dual;
    this.mpLinkStatus.hidden = !state.dual;
    this.mpLinkBtn.textContent = state.linkLabel;
    this.mpLinkStatus.textContent = state.linkHint;
    this.mpLinkStatus.classList.toggle("on", state.linked);
  }

  private bindTouchPad(): void {
    const pad = this.root.querySelector<HTMLElement>(".play-deck");
    if (!pad) return;

    const active = new Map<number, Button>();

    const press = (pointerId: number, btn: Button, el: HTMLElement) => {
      this.cb.onFocus(this);
      void this.unlockAudio();
      if (active.get(pointerId) === btn) return;
      // Release previous button on this pointer if any
      const prev = active.get(pointerId);
      if (prev) this.emu.setButton(prev, false);
      active.set(pointerId, btn);
      this.emu.setButton(btn, true);
      el.classList.add("pressed");
    };

    const release = (pointerId: number, el?: HTMLElement) => {
      const btn = active.get(pointerId);
      if (!btn) return;
      active.delete(pointerId);
      this.emu.setButton(btn, false);
      el?.classList.remove("pressed");
      // Clear pressed from any button still showing for this id
      pad.querySelectorAll(".touch-btn.pressed").forEach((node) => {
        const b = node as HTMLElement;
        if (b.dataset.btn === btn) b.classList.remove("pressed");
      });
    };

    pad.querySelectorAll<HTMLElement>("[data-btn]").forEach((el) => {
      const name = el.dataset.btn as Button | undefined;
      if (!name) return;

      el.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.setPointerCapture(e.pointerId);
        press(e.pointerId, name, el);
      });
      el.addEventListener("pointerup", (e) => {
        e.preventDefault();
        release(e.pointerId, el);
      });
      el.addEventListener("pointercancel", (e) => {
        release(e.pointerId, el);
      });
      el.addEventListener("lostpointercapture", (e) => {
        release(e.pointerId, el);
      });
      // Block context menu / callout on long-press
      el.addEventListener("contextmenu", (e) => e.preventDefault());
    });
  }

  private applyScale(): void {
    const mode = this.scaleSelect.value;
    const fit = mode === "fit" || isMobileLayout();
    this.stage.classList.toggle("fit", fit);
    if (fit) {
      this.canvas.style.removeProperty("width");
      this.canvas.style.removeProperty("height");
    } else {
      const n = Number(mode);
      const hostW = this.root.clientWidth || window.innerWidth;
      const maxW = Math.min(hostW - 24, SCREEN_WIDTH * n);
      const scale = maxW / SCREEN_WIDTH;
      this.canvas.style.width = `${Math.round(SCREEN_WIDTH * scale)}px`;
      this.canvas.style.height = `${Math.round(SCREEN_HEIGHT * scale)}px`;
    }
  }

  private paint(): void {
    const fb = this.emu.frameBuffer;
    for (let i = 0; i < fb.length; i++) this.pixels[i] = fb[i]!;
    this.ctx.putImageData(this.imageData, 0, 0);
  }

  private setStatus(text: string): void {
    this.statusEl.textContent = text;
  }

  private applyPalette(id: DmgPaletteId): void {
    this.emu.setDmgPalette(id);
    this.paletteSelect.value = id;
    if (this.romLoaded) {
      // Framebuffer stores resolved RGBA — advance one frame so the new
      // shades show immediately (skip when linked to avoid lockstep desync).
      if (!this.emu.isLinked()) this.advanceOneFrame();
    } else {
      this.paintIdlePreview();
    }
  }

  /** Fill the canvas with the current DMG light shade so Shades is visible pre-ROM. */
  private paintIdlePreview(): void {
    this.pixels.fill(dmgLightColor(this.emu.getDmgPalette()));
    this.ctx.putImageData(this.imageData, 0, 0);
  }

  private toggleMute(): void {
    const next = !this.emu.isMuted();
    this.emu.setMuted(next);
    this.audio.setMuted(next);
    this.muteBtn.textContent = next ? "Unmute" : "Mute";
  }

  private async toggleFullscreen(): Promise<void> {
    const el = this.stage as HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void> | void;
      webkitRequestFullScreen?: () => Promise<void> | void;
    };
    try {
      if (!document.fullscreenElement) {
        if (el.requestFullscreen) await el.requestFullscreen();
        else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
        else if (el.webkitRequestFullScreen) await el.webkitRequestFullScreen();
        else {
          // iOS Safari: no element fullscreen — use immersive CSS layout
          document.documentElement.classList.toggle("immersive");
          this.root.classList.toggle("immersive-session");
        }
      } else {
        await document.exitFullscreen();
      }
    } catch {
      document.documentElement.classList.toggle("immersive");
      this.root.classList.toggle("immersive-session");
    }
  }

  private doSaveState(): void {
    if (!this.romLoaded) {
      this.setStatus("Load a ROM before saving a state");
      return;
    }
    try {
      const slot = this.getSelectedSlot();
      this.emu.saveStateToSlot(slot);
      this.refreshSlotHints();
      this.setStatus(`Saved state to slot ${slot}`);
    } catch (err) {
      this.setStatus(`Save state failed: ${errorText(err)}`);
    }
  }

  private doLoadState(): void {
    if (!this.romLoaded) {
      this.setStatus("Load a ROM before loading a state");
      return;
    }
    try {
      const slot = this.getSelectedSlot();
      const ok = this.emu.loadStateFromSlot(slot);
      if (!ok) {
        this.setStatus(`No savestate in slot ${slot}`);
        return;
      }
      this.onSavestateApplied();
      this.setStatus(`Loaded state from slot ${slot}`);
    } catch (err) {
      this.setStatus(`Load state failed: ${errorText(err)}`);
    }
  }
}
