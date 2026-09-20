import type { Emulator } from "../core/emulator";
import { base64ToUint8, uint8ToBase64 } from "../core/encoding";
import { buildBackupBundle, parseBackupBundle, saveSavestate } from "../core/saves";
import type { CartridgeHeader, EmulatorSavestate, SaveState } from "../core/types";
import { downloadBlob, downloadJson, safeFilename } from "./download";

/** Minimal session surface needed for export / import. */
export interface BackupHost {
  readonly emu: Emulator;
  getSelectedSlot(): number;
  reportStatus(text: string): void;
  refreshSlotHints(): void;
  /** After applying a savestate: resync UI clock, frame, palette. */
  onSavestateApplied(): void;
}

function requireHeader(host: BackupHost): CartridgeHeader | null {
  const header = host.emu.getHeader();
  if (!header) {
    host.reportStatus("Load a ROM first");
    return null;
  }
  return header;
}

function gameBaseName(host: BackupHost, header?: CartridgeHeader | null): string {
  return safeFilename(header?.title || host.emu.title || "game");
}

export function downloadBatterySav(host: BackupHost): void {
  const bytes = host.emu.exportBatterySavBytes();
  if (!bytes) {
    host.reportStatus("No battery save to download");
    return;
  }
  const name = gameBaseName(host);
  downloadBlob(
    `${name}.sav`,
    new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }),
  );
  host.reportStatus(`Downloaded ${name}.sav`);
}

export function downloadBatteryJson(host: BackupHost): void {
  const data = host.emu.exportBatterySave();
  if (!data) {
    host.reportStatus("No battery save to download");
    return;
  }
  const name = gameBaseName(host);
  downloadJson(`${name}.battery.json`, {
    version: 1,
    kind: "gbc-battery",
    title: host.emu.title,
    checksum: host.emu.getHeader()?.checksum,
    sram: uint8ToBase64(data.sram),
    rtc: data.rtc ?? null,
  });
  host.reportStatus(`Downloaded ${name}.battery.json`);
}

export function downloadLiveSavestate(host: BackupHost): void {
  const header = requireHeader(host);
  if (!header) return;
  const slot = host.getSelectedSlot();
  const name = gameBaseName(host, header);
  downloadJson(`${name}.slot${slot}.gbcstate.json`, host.emu.createSavestate());
  host.reportStatus(`Downloaded live savestate as slot ${slot} file`);
}

export function downloadStoredSavestate(host: BackupHost): void {
  const header = requireHeader(host);
  if (!header) return;
  const slot = host.getSelectedSlot();
  const state = host.emu.getSavestateFromSlot(slot);
  if (!state) {
    host.reportStatus(`No stored savestate in slot ${slot}`);
    return;
  }
  const name = gameBaseName(host, header);
  downloadJson(`${name}.slot${slot}.gbcstate.json`, state);
  host.reportStatus(`Downloaded slot ${slot} savestate`);
}

export function downloadFullBackup(host: BackupHost): void {
  const header = requireHeader(host);
  if (!header) return;
  host.emu.flushSave();
  const bundle = buildBackupBundle(header, host.emu.exportBatterySave());
  const name = gameBaseName(host, header);
  downloadJson(`${name}.gbcbackup.json`, bundle);
  host.reportStatus(`Downloaded full backup (${Object.keys(bundle.savestates).length} states)`);
}

export async function importSaveFile(host: BackupHost, file: File): Promise<void> {
  const header = host.emu.getHeader();
  if (!header) throw new Error("Load a ROM before importing");

  const lower = file.name.toLowerCase();
  if (lower.endsWith(".sav")) {
    host.emu.importBatterySavBytes(new Uint8Array(await file.arrayBuffer()));
    host.reportStatus(`Imported battery save from ${file.name}`);
    return;
  }

  let json: unknown;
  try {
    json = JSON.parse(await file.text());
  } catch {
    throw new Error("File is not valid JSON (use .sav for raw battery saves)");
  }

  const obj = json as Record<string, unknown>;

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
      host.emu.importBatterySave(battery);
    }
    for (const [slotStr, state] of Object.entries(bundle.savestates)) {
      const slot = Number(slotStr);
      if (slot >= 1 && slot <= 9) saveSavestate(header, slot, state);
    }
    host.refreshSlotHints();
    host.reportStatus(`Imported backup (${Object.keys(bundle.savestates).length} states)`);
    return;
  }

  if (obj.kind === "gbc-battery" && typeof obj.sram === "string") {
    if (typeof obj.checksum === "number" && obj.checksum !== header.checksum) {
      throw new Error("Battery save does not match the loaded ROM");
    }
    const battery: SaveState = {
      sram: base64ToUint8(obj.sram),
      rtc: (obj.rtc as SaveState["rtc"]) ?? undefined,
    };
    host.emu.importBatterySave(battery);
    host.reportStatus(`Imported battery JSON from ${file.name}`);
    return;
  }

  if (obj.version === 1 && typeof obj.checksum === "number" && obj.cpu && obj.mmu) {
    const state = obj as unknown as EmulatorSavestate;
    if (state.checksum !== header.checksum) {
      throw new Error("Savestate does not match the loaded ROM");
    }
    const slot = host.getSelectedSlot();
    host.emu.importSavestateToSlot(slot, state);
    host.emu.applySavestate(state);
    host.onSavestateApplied();
    host.reportStatus(`Imported savestate into slot ${slot} and loaded it`);
    return;
  }

  throw new Error("Unrecognized save file format");
}
