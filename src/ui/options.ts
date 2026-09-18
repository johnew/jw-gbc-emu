import type { BackupHost } from "./backup";
import {
  downloadBatteryJson,
  downloadBatterySav,
  downloadFullBackup,
  downloadLiveSavestate,
  downloadStoredSavestate,
  importSaveFile,
} from "./backup";

function runAction(status: HTMLElement, action: () => void, okMessage: string): void {
  try {
    action();
    status.textContent = okMessage;
  } catch (err) {
    status.textContent = err instanceof Error ? err.message : String(err);
  }
}

export function openOptionsModal(host: BackupHost): void {
  document.querySelector(".options-overlay")?.remove();

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

  const actions: Array<[string, () => void, string]> = [
    ["[data-dl-sav]", () => downloadBatterySav(host), "Battery .sav download started"],
    ["[data-dl-battery-json]", () => downloadBatteryJson(host), "Battery JSON download started"],
    ["[data-dl-live-state]", () => downloadLiveSavestate(host), "Savestate download started"],
    ["[data-dl-slot-state]", () => downloadStoredSavestate(host), "Stored slot download attempted"],
    ["[data-dl-backup]", () => downloadFullBackup(host), "Full backup download started"],
  ];
  for (const [sel, action, msg] of actions) {
    overlay.querySelector(sel)!.addEventListener("click", () => runAction(status, action, msg));
  }

  overlay.querySelector<HTMLInputElement>("[data-import]")!.addEventListener("change", async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      await importSaveFile(host, file);
      status.textContent = `Imported ${file.name}`;
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : String(err);
    }
    input.value = "";
  });
}
