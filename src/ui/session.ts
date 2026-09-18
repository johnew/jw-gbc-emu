import { Emulator, type Button } from "../core/emulator";
import {
  DMG_PALETTE_IDS,
  DMG_PALETTE_LABELS,
  FRAME_DURATION_MS,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  type DmgPaletteId,
} from "../core/types";
import { AudioOutput } from "../audio/output";
import {
  buildBackupBundle,
  downloadBlob,
  parseBackupBundle,
  safeFilename,
  saveSavestate,
  uint8ToBase64,
  base64ToUint8,
} from "../core/saves";
import type { EmulatorSavestate, SaveState } from "../core/types";

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

export { KEY_MAP };

export interface SessionCallbacks {
  onFocus: (session: EmulatorSession) => void;
  onStatus: (session: EmulatorSession, text: string) => void;
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
      <div class="stage" tabindex="0">
        <canvas width="${SCREEN_WIDTH}" height="${SCREEN_HEIGHT}" aria-label="Game Boy screen"></canvas>
      </div>
      <div class="toolbar">
        <label class="file-btn">
          Open ROM
          <input type="file" accept=".gb,.gbc,.bin" hidden data-rom />
        </label>
        <button type="button" data-fullscreen>Fullscreen</button>
        <button type="button" data-speed>Speed 1x</button>
        <button type="button" data-mute>Mute</button>
        <label class="scale-label">
          Shades
          <select data-palette>${paletteOptions}</select>
        </label>
        <label class="scale-label">
          Scale
          <select data-scale>
            <option value="2">2×</option>
            <option value="3" selected>3×</option>
            <option value="4">4×</option>
            <option value="fit">Fit</option>
          </select>
        </label>
      </div>
      <div class="toolbar savestate-bar">
        <label class="scale-label">
          State
          <select data-slot>${slotOptions}</select>
        </label>
        <button type="button" data-save-state>Save State</button>
        <button type="button" data-load-state>Load State</button>
        <button type="button" data-options>Options</button>
        <span class="slot-hint" data-slot-hint></span>
      </div>
      <p class="status" data-status>No ROM loaded</p>
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

    this.bindUi();
    this.applyScale();
    this.applyPalette("green");
    this.paint();
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
    const dt = Math.min(now - this.lastTs, 50);
    this.lastTs = now;
    if (!this.romLoaded) return;
    // When linked, the app drives lockstep frames instead
    if (this.emu.isLinked()) return;

    const speed = this.emu.getSpeed();
    this.frameAcc += dt * speed;
    let frames = 0;
    const maxCatchUp = 6 * speed;
    while (this.frameAcc >= FRAME_DURATION_MS && frames < maxCatchUp) {
      this.frameAcc -= FRAME_DURATION_MS;
      this.advanceOneFrame();
      frames++;
    }
    if (this.frameAcc > FRAME_DURATION_MS * 2) this.frameAcc = 0;
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
        this.refreshSlotHint();
        return true;
      }
    }
    if (e.code === "Tab") {
      e.preventDefault();
      void this.unlockAudio();
      const s = this.emu.cycleSpeed();
      this.speedBtn.textContent = `Speed ${s}x`;
      this.frameAcc = 0;
      return true;
    }
    if (e.code === "KeyP") {
      e.preventDefault();
      const next = this.emu.cycleDmgPalette();
      this.paletteSelect.value = next;
      return true;
    }
    if (e.code === "KeyF") {
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

  openOptions(): void {
    openOptionsModal(this);
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
      this.refreshSlotHint();
      this.titleEl.textContent = this.emu.title || "Game";
      this.setStatus(`${this.emu.title}${this.emu.isCgb ? " (CGB)" : " (DMG)"} — playing`);
      focus();
    });

    this.root.querySelector("[data-fullscreen]")!.addEventListener("click", () => {
      void this.unlockAudio();
      void this.toggleFullscreen();
    });

    this.speedBtn.addEventListener("click", async () => {
      await this.unlockAudio();
      const s = this.emu.cycleSpeed();
      this.speedBtn.textContent = `Speed ${s}x`;
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
      this.openOptions();
      focus();
    });

    this.slotSelect.addEventListener("change", () => this.refreshSlotHint());
    this.paletteSelect.addEventListener("change", () => {
      this.applyPalette(this.paletteSelect.value as DmgPaletteId);
    });
    this.scaleSelect.addEventListener("change", () => this.applyScale());
  }

  private currentSlot(): number {
    return Number(this.slotSelect.value) || 1;
  }

  private refreshSlotHint(): void {
    if (!this.romLoaded) {
      this.slotHint.textContent = "";
      return;
    }
    const occupied = this.emu.occupiedSlots();
    const cur = this.currentSlot();
    const mark = occupied.includes(cur) ? "filled" : "empty";
    this.slotHint.textContent =
      occupied.length === 0
        ? `Slot ${cur} empty`
        : `Slot ${cur} ${mark} · used: ${occupied.join(", ")}`;
  }

  private applyScale(): void {
    const mode = this.scaleSelect.value;
    this.stage.classList.toggle("fit", mode === "fit");
    if (mode === "fit") {
      this.canvas.style.width = "";
      this.canvas.style.height = "";
    } else {
      const n = Number(mode);
      this.canvas.style.width = `${SCREEN_WIDTH * n}px`;
      this.canvas.style.height = `${SCREEN_HEIGHT * n}px`;
    }
  }

  private paint(): void {
    const fb = this.emu.frameBuffer;
    for (let i = 0; i < fb.length; i++) this.pixels[i] = fb[i]!;
    this.ctx.putImageData(this.imageData, 0, 0);
  }

  private setStatus(text: string): void {
    this.statusEl.textContent = text;
    this.cb.onStatus(this, text);
  }

  private applyPalette(id: DmgPaletteId): void {
    this.emu.setDmgPalette(id);
    this.paletteSelect.value = id;
  }

  private toggleMute(): void {
    const next = !this.emu.isMuted();
    this.emu.setMuted(next);
    this.audio.setMuted(next);
    this.muteBtn.textContent = next ? "Unmute" : "Mute";
  }

  private async toggleFullscreen(): Promise<void> {
    if (!document.fullscreenElement) await this.stage.requestFullscreen();
    else await document.exitFullscreen();
  }

  private doSaveState(): void {
    if (!this.romLoaded) {
      this.setStatus("Load a ROM before saving a state");
      return;
    }
    try {
      const slot = this.currentSlot();
      this.emu.saveStateToSlot(slot);
      this.refreshSlotHint();
      this.setStatus(`Saved state to slot ${slot}`);
    } catch (err) {
      this.setStatus(`Save state failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private doLoadState(): void {
    if (!this.romLoaded) {
      this.setStatus("Load a ROM before loading a state");
      return;
    }
    try {
      const slot = this.currentSlot();
      const ok = this.emu.loadStateFromSlot(slot);
      if (!ok) {
        this.setStatus(`No savestate in slot ${slot}`);
        return;
      }
      this.frameAcc = 0;
      this.paint();
      this.paletteSelect.value = this.emu.getDmgPalette();
      this.refreshSlotHint();
      this.setStatus(`Loaded state from slot ${slot}`);
    } catch (err) {
      this.setStatus(`Load state failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // —— Export / import used by Options modal ——

  downloadBatterySav(): void {
    const bytes = this.emu.exportBatterySavBytes();
    if (!bytes) {
      this.setStatus("No battery save to download");
      return;
    }
    const name = safeFilename(this.emu.title || "game");
    const copy = new Uint8Array(bytes);
    downloadBlob(`${name}.sav`, new Blob([copy], { type: "application/octet-stream" }));
    this.setStatus(`Downloaded ${name}.sav`);
  }

  downloadBatteryJson(): void {
    const data = this.emu.exportBatterySave();
    if (!data) {
      this.setStatus("No battery save to download");
      return;
    }
    const name = safeFilename(this.emu.title || "game");
    const payload = {
      version: 1,
      kind: "gbc-battery",
      title: this.emu.title,
      checksum: this.emu.getHeader()?.checksum,
      sram: uint8ToBase64(data.sram),
      rtc: data.rtc ?? null,
    };
    downloadBlob(
      `${name}.battery.json`,
      new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }),
    );
    this.setStatus(`Downloaded ${name}.battery.json`);
  }

  downloadCurrentSavestate(): void {
    const header = this.emu.getHeader();
    if (!header) {
      this.setStatus("Load a ROM first");
      return;
    }
    const slot = this.currentSlot();
    // Ensure latest in-memory state is what we export if user wants "current play"
    // Export stored slot; also offer live snapshot into that download
    const live = this.emu.createSavestate();
    const name = safeFilename(header.title);
    downloadBlob(
      `${name}.slot${slot}.gbcstate.json`,
      new Blob([JSON.stringify(live, null, 2)], { type: "application/json" }),
    );
    this.setStatus(`Downloaded live savestate as slot ${slot} file`);
  }

  downloadStoredSavestate(): void {
    const header = this.emu.getHeader();
    if (!header) {
      this.setStatus("Load a ROM first");
      return;
    }
    const slot = this.currentSlot();
    const state = this.emu.getSavestateFromSlot(slot);
    if (!state) {
      this.setStatus(`No stored savestate in slot ${slot}`);
      return;
    }
    const name = safeFilename(header.title);
    downloadBlob(
      `${name}.slot${slot}.gbcstate.json`,
      new Blob([JSON.stringify(state, null, 2)], { type: "application/json" }),
    );
    this.setStatus(`Downloaded slot ${slot} savestate`);
  }

  downloadFullBackup(): void {
    const header = this.emu.getHeader();
    if (!header) {
      this.setStatus("Load a ROM first");
      return;
    }
    this.emu.flushSave();
    const battery = this.emu.exportBatterySave();
    const bundle = buildBackupBundle(header, battery);
    // Also include a fresh live snapshot as slot "live" metadata? Keep slots only.
    const name = safeFilename(header.title);
    downloadBlob(
      `${name}.gbcbackup.json`,
      new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }),
    );
    this.setStatus(`Downloaded full backup (${Object.keys(bundle.savestates).length} states)`);
  }

  async importFile(file: File): Promise<void> {
    const header = this.emu.getHeader();
    if (!header) throw new Error("Load a ROM before importing");

    const lower = file.name.toLowerCase();
    if (lower.endsWith(".sav")) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      this.emu.importBatterySavBytes(bytes);
      this.setStatus(`Imported battery save from ${file.name}`);
      return;
    }

    const text = await file.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("File is not valid JSON (use .sav for raw battery saves)");
    }

    const obj = json as Record<string, unknown>;

    // Full backup
    const bundle = parseBackupBundle(json);
    if (bundle) {
      if (bundle.checksum !== header.checksum) {
        throw new Error("Backup does not match the loaded ROM");
      }
      if (bundle.battery) {
        const battery: SaveState = {
          sram: base64ToUint8(bundle.battery.sram),
          rtc: bundle.battery.rtc ?? undefined,
        };
        this.emu.importBatterySave(battery);
      }
      for (const [slotStr, state] of Object.entries(bundle.savestates)) {
        const slot = Number(slotStr);
        if (slot >= 1 && slot <= 9) {
          saveSavestate(header, slot, state);
        }
      }
      this.refreshSlotHint();
      this.setStatus(`Imported backup (${Object.keys(bundle.savestates).length} states)`);
      return;
    }

    // Battery JSON
    if (obj.kind === "gbc-battery" && typeof obj.sram === "string") {
      if (typeof obj.checksum === "number" && obj.checksum !== header.checksum) {
        throw new Error("Battery save does not match the loaded ROM");
      }
      const battery: SaveState = {
        sram: base64ToUint8(obj.sram),
        rtc: (obj.rtc as SaveState["rtc"]) ?? undefined,
      };
      this.emu.importBatterySave(battery);
      this.setStatus(`Imported battery JSON from ${file.name}`);
      return;
    }

    // Savestate
    if (obj.version === 1 && typeof obj.checksum === "number" && obj.cpu && obj.mmu) {
      const state = obj as unknown as EmulatorSavestate;
      if (state.checksum !== header.checksum) {
        throw new Error("Savestate does not match the loaded ROM");
      }
      const slot = this.currentSlot();
      this.emu.importSavestateToSlot(slot, state);
      this.emu.applySavestate(state);
      this.frameAcc = 0;
      this.paint();
      this.paletteSelect.value = this.emu.getDmgPalette();
      this.refreshSlotHint();
      this.setStatus(`Imported savestate into slot ${slot} and loaded it`);
      return;
    }

    throw new Error("Unrecognized save file format");
  }
}

function openOptionsModal(session: EmulatorSession): void {
  const existing = document.querySelector(".options-overlay");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.className = "options-overlay";
  overlay.innerHTML = `
    <div class="options-panel" role="dialog" aria-label="Options">
      <header class="options-header">
        <h2>Options</h2>
        <button type="button" class="options-close" aria-label="Close">×</button>
      </header>
      <p class="options-lead">Export or import battery saves and savestates for the focused game. Files can be backed up outside the browser.</p>

      <section class="options-section">
        <h3>Download</h3>
        <div class="options-actions">
          <button type="button" data-dl-sav>Battery save (.sav)</button>
          <button type="button" data-dl-battery-json>Battery save (.json + RTC)</button>
          <button type="button" data-dl-live-state>Current play → savestate file</button>
          <button type="button" data-dl-slot-state>Stored slot savestate</button>
          <button type="button" data-dl-backup>Full backup (all slots + battery)</button>
        </div>
      </section>

      <section class="options-section">
        <h3>Import</h3>
        <p class="options-note">Accepts <code>.sav</code>, <code>.battery.json</code>, <code>.gbcstate.json</code>, or <code>.gbcbackup.json</code>. ROM must already be loaded and match.</p>
        <label class="file-btn">
          Choose file to import
          <input type="file" accept=".sav,.json,.gbcstate.json,.gbcbackup.json,.battery.json" hidden data-import />
        </label>
      </section>

      <p class="options-status" data-opt-status></p>
    </div>
  `;
  document.body.appendChild(overlay);

  const status = overlay.querySelector<HTMLElement>("[data-opt-status]")!;
  const close = () => overlay.remove();

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector(".options-close")!.addEventListener("click", close);

  overlay.querySelector("[data-dl-sav]")!.addEventListener("click", () => {
    try {
      session.downloadBatterySav();
      status.textContent = "Battery .sav download started";
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : String(err);
    }
  });
  overlay.querySelector("[data-dl-battery-json]")!.addEventListener("click", () => {
    try {
      session.downloadBatteryJson();
      status.textContent = "Battery JSON download started";
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : String(err);
    }
  });
  overlay.querySelector("[data-dl-live-state]")!.addEventListener("click", () => {
    try {
      session.downloadCurrentSavestate();
      status.textContent = "Savestate download started";
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : String(err);
    }
  });
  overlay.querySelector("[data-dl-slot-state]")!.addEventListener("click", () => {
    try {
      session.downloadStoredSavestate();
      status.textContent = "Stored slot download attempted";
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : String(err);
    }
  });
  overlay.querySelector("[data-dl-backup]")!.addEventListener("click", () => {
    try {
      session.downloadFullBackup();
      status.textContent = "Full backup download started";
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : String(err);
    }
  });

  overlay.querySelector<HTMLInputElement>("[data-import]")!.addEventListener("change", async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      await session.importFile(file);
      status.textContent = `Imported ${file.name}`;
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : String(err);
    }
    (e.target as HTMLInputElement).value = "";
  });
}
