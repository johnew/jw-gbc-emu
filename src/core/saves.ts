import { base64ToUint8, uint8ToBase64 } from "./encoding";
import type { CartridgeHeader, EmulatorSavestate, SaveState } from "./types";

function batteryKey(header: CartridgeHeader): string {
  return `gbc-save:${header.title}:${header.checksum.toString(16)}`;
}

function savestateKey(header: CartridgeHeader, slot: number): string {
  return `gbc-savestate:${header.title}:${header.checksum.toString(16)}:slot${slot}`;
}

function encodeBattery(data: SaveState): string {
  return JSON.stringify({
    sram: uint8ToBase64(data.sram),
    rtc: data.rtc ?? null,
  });
}

function decodeBattery(raw: string): SaveState | null {
  try {
    const obj = JSON.parse(raw) as { sram: string; rtc?: SaveState["rtc"] };
    return {
      sram: base64ToUint8(obj.sram),
      rtc: obj.rtc ?? undefined,
    };
  } catch {
    return null;
  }
}

export function loadSave(header: CartridgeHeader): SaveState | null {
  try {
    const raw = localStorage.getItem(batteryKey(header));
    if (!raw) return null;
    return decodeBattery(raw);
  } catch {
    return null;
  }
}

export function saveSave(header: CartridgeHeader, data: SaveState): void {
  try {
    localStorage.setItem(batteryKey(header), encodeBattery(data));
  } catch (e) {
    console.warn("Failed to persist battery save:", e);
  }
}

export function saveSavestate(header: CartridgeHeader, slot: number, state: EmulatorSavestate): void {
  try {
    localStorage.setItem(savestateKey(header, slot), JSON.stringify(state));
  } catch (e) {
    console.warn("Failed to persist savestate:", e);
    throw e;
  }
}

export function loadSavestate(header: CartridgeHeader, slot: number): EmulatorSavestate | null {
  try {
    const raw = localStorage.getItem(savestateKey(header, slot));
    if (!raw) return null;
    const state = JSON.parse(raw) as EmulatorSavestate;
    if (state.version !== 1) return null;
    if (state.checksum !== header.checksum) return null;
    return state;
  } catch {
    return null;
  }
}

export function hasSavestate(header: CartridgeHeader, slot: number): boolean {
  try {
    return localStorage.getItem(savestateKey(header, slot)) !== null;
  } catch {
    return false;
  }
}

export function listSavestateSlots(header: CartridgeHeader, maxSlot = 9): number[] {
  const slots: number[] = [];
  for (let i = 1; i <= maxSlot; i++) {
    if (hasSavestate(header, i)) slots.push(i);
  }
  return slots;
}

export interface BackupBundle {
  version: 1;
  kind: "gbc-backup";
  title: string;
  checksum: number;
  exportedAt: number;
  battery: { sram: string; rtc?: SaveState["rtc"] } | null;
  savestates: Record<string, EmulatorSavestate>;
}

export function buildBackupBundle(
  header: CartridgeHeader,
  battery: SaveState | null,
): BackupBundle {
  const savestates: Record<string, EmulatorSavestate> = {};
  for (const slot of listSavestateSlots(header)) {
    const st = loadSavestate(header, slot);
    if (st) savestates[String(slot)] = st;
  }
  return {
    version: 1,
    kind: "gbc-backup",
    title: header.title,
    checksum: header.checksum,
    exportedAt: Date.now(),
    battery: battery
      ? { sram: uint8ToBase64(battery.sram), rtc: battery.rtc }
      : null,
    savestates,
  };
}

export function parseBackupBundle(raw: unknown): BackupBundle | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Partial<BackupBundle>;
  if (obj.version !== 1 || obj.kind !== "gbc-backup") return null;
  if (typeof obj.title !== "string" || typeof obj.checksum !== "number") return null;
  return obj as BackupBundle;
}
