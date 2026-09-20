import { EmulatorSession } from "./session";
import { bindShellLayout, isMobileLayout, takeFrameBudget } from "./layout";
import { buildLinkUiState } from "./linkUi";
import { loadLastRom } from "./lastRom";

export function mountApp(root: HTMLElement): void {
  root.innerHTML = `
    <div class="shell">
      <header class="top">
        <h1>Game Boy Color</h1>
        <p class="tagline">Load your own Pokémon Red, Blue, or Crystal ROM</p>
      </header>

      <div class="global-bar">
        <button type="button" id="add-instance">Add second game</button>
        <button type="button" id="remove-instance" hidden>Close second game</button>
        <button type="button" id="link-cable" hidden>Connect link cable</button>
        <span class="link-status" id="link-status" hidden></span>
        <span class="global-hint" id="global-hint">Tap a screen to control it. On phones, tap ⚙ for settings.</span>
      </div>

      <div class="session-tabs" id="session-tabs" hidden role="tablist" aria-label="Games">
        <button type="button" class="session-tab" role="tab" data-index="0" aria-selected="true">Game 1</button>
        <button type="button" class="session-tab" role="tab" data-index="1" aria-selected="false" hidden>Game 2</button>
      </div>

      <div class="sessions" id="sessions"></div>

      <aside class="help">
        <h2>Controls</h2>
        <ul>
          <li><strong>Mobile:</strong> full-screen Game Boy controls · tap <strong>⚙</strong> for settings · rotate for a larger screen</li>
          <li>Tap/click a game panel to focus it (desktop dual view)</li>
          <li><kbd>←</kbd><kbd>→</kbd><kbd>↑</kbd><kbd>↓</kbd> or <kbd>WASD</kbd> — D-pad</li>
          <li><kbd>Z</kbd> / <kbd>K</kbd> — A &nbsp; <kbd>X</kbd> / <kbd>J</kbd> — B</li>
          <li><kbd>Enter</kbd> — Start &nbsp; <kbd>Shift</kbd> — Select</li>
          <li><kbd>F5</kbd> / <kbd>F7</kbd> — save / load state &nbsp; <kbd>1</kbd>–<kbd>9</kbd> — slot</li>
          <li><kbd>Tab</kbd> speed · <kbd>P</kbd> shades · <kbd>F</kbd> fullscreen (desktop) · <kbd>M</kbd> mute</li>
          <li><strong>Options</strong> — download / import battery saves and savestates</li>
          <li><strong>Link cable</strong> — connect both games to trade (works with mobile tabs)</li>
        </ul>
        <p class="legal">Provide legally obtained ROMs only. Nothing is bundled with this app. Battery saves and savestates are stored in this browser (and can be exported from Options). Link trading works best at 1× with both players in the Pokémon Center Cable Club.</p>
      </aside>
    </div>
  `;

  const sessionsHost = root.querySelector<HTMLElement>("#sessions")!;
  const tabsBar = root.querySelector<HTMLElement>("#session-tabs")!;
  const tabButtons = [
    root.querySelector<HTMLButtonElement>('.session-tab[data-index="0"]')!,
    root.querySelector<HTMLButtonElement>('.session-tab[data-index="1"]')!,
  ];
  const addBtn = root.querySelector<HTMLButtonElement>("#add-instance")!;
  const removeBtn = root.querySelector<HTMLButtonElement>("#remove-instance")!;
  const linkBtn = root.querySelector<HTMLButtonElement>("#link-cable")!;
  const linkStatus = root.querySelector<HTMLElement>("#link-status")!;
  const hint = root.querySelector<HTMLElement>("#global-hint")!;
  const shell = root.querySelector<HTMLElement>(".shell")!;

  const sessions: EmulatorSession[] = [];
  let focused: EmulatorSession | null = null;
  let activeTab = 0;
  let linked = false;
  let linkAcc = 0;
  let lastTs = performance.now();
  let linkErrorHint: string | undefined;

  const mobile = () => isMobileLayout();
  const isDual = () => sessions.length === 2;

  function sessionLabel(index: number): string {
    return sessions[index]?.emu.title || `Game ${index + 1}`;
  }

  function updateHint(session: EmulatorSession): void {
    const idx = sessions.indexOf(session);
    hint.textContent = `Controlling: ${sessionLabel(idx >= 0 ? idx : 0)}`;
  }

  function setFocus(session: EmulatorSession): void {
    focused = session;
    for (const s of sessions) s.setFocused(s === session);
    updateHint(session);
  }

  function showTab(index: number): void {
    if (index < 0 || index >= sessions.length) return;
    activeTab = index;
    const useTabs = mobile() && isDual();
    for (let i = 0; i < sessions.length; i++) {
      const on = i === index;
      const el = sessions[i]!.root;
      el.hidden = useTabs && !on;
      el.classList.toggle("tab-hidden", useTabs && !on);
      tabButtons[i]!.setAttribute("aria-selected", on ? "true" : "false");
      tabButtons[i]!.classList.toggle("active", on);
      if (!on) sessions[i]!.closeSettingsSheet();
    }
    setFocus(sessions[index]!);
    const onMobile = mobile();
    requestAnimationFrame(() => {
      sessions[index]?.refreshDisplayLayout(onMobile);
    });
  }

  function focusSession(session: EmulatorSession): void {
    const idx = sessions.indexOf(session);
    if (mobile() && isDual() && idx >= 0) showTab(idx);
    else setFocus(session);
  }

  function applyLinkUi(errorHint?: string): void {
    if (!isDual()) linked = false;
    const state = buildLinkUiState({
      dual: isDual(),
      linked,
      errorHint: isDual() ? errorHint : undefined,
    });
    linkBtn.hidden = !state.dual;
    linkStatus.hidden = !state.dual;
    linkBtn.textContent = state.linkLabel;
    linkStatus.textContent = state.linkHint;
    linkStatus.classList.toggle("on", state.linked);
    for (const s of sessions) s.syncMultiplayerUi(state);
  }

  function refreshTabLabels(): void {
    for (let i = 0; i < sessions.length; i++) {
      tabButtons[i]!.textContent = sessionLabel(i);
      tabButtons[i]!.hidden = false;
    }
  }

  function revealAllSessions(): void {
    for (const s of sessions) {
      s.root.hidden = false;
      s.root.classList.remove("tab-hidden");
    }
  }

  function syncLayout(): void {
    const dual = isDual();
    const onMobile = mobile();
    shell.classList.toggle("dual", !onMobile && dual);
    shell.classList.toggle("mobile-tabs", onMobile && dual);
    tabsBar.hidden = !(onMobile && dual);
    tabButtons[1]!.hidden = !dual;
    addBtn.hidden = dual;
    removeBtn.hidden = !dual;
    refreshTabLabels();

    if (!dual) {
      revealAllSessions();
      activeTab = 0;
    } else if (onMobile) {
      showTab(Math.min(activeTab, sessions.length - 1));
    } else {
      revealAllSessions();
    }

    for (const s of sessions) s.refreshDisplayLayout(onMobile);
    applyLinkUi(linkErrorHint);
  }

  bindShellLayout(shell, (onMobile) => {
    const dual = isDual();
    const wantTabs = onMobile && dual;
    const wantDual = !onMobile && dual;
    if (
      shell.classList.contains("mobile-tabs") !== wantTabs ||
      shell.classList.contains("dual") !== wantDual
    ) {
      syncLayout();
    } else {
      for (const s of sessions) s.refreshDisplayLayout(onMobile);
    }
  });

  function disconnectLink(): void {
    if (!linked) return;
    for (const s of sessions) s.emu.unlink();
    linked = false;
    linkAcc = 0;
    linkErrorHint = undefined;
    applyLinkUi();
  }

  function connectLink(): void {
    if (!isDual()) return;
    const a = sessions[0]!;
    const b = sessions[1]!;
    if (!a.hasRom || !b.hasRom) {
      linkErrorHint = "Load a ROM in both games before connecting the link cable";
      applyLinkUi(linkErrorHint);
      return;
    }
    a.emu.linkWith(b.emu);
    a.refreshSpeedButton();
    b.refreshSpeedButton();
    const now = performance.now();
    a.syncClock(now);
    b.syncClock(now);
    linkAcc = 0;
    linked = true;
    linkErrorHint = undefined;
    applyLinkUi();
  }

  function toggleLink(): void {
    if (linked) disconnectLink();
    else connectLink();
  }

  function removeSecond(): void {
    if (!isDual()) return;
    disconnectLink();
    sessions.pop()!.destroy();
    activeTab = 0;
    setFocus(sessions[0]!);
    syncLayout();
  }

  function ensureSecondSession(): void {
    if (!isDual()) {
      const session = addSession("Game 2");
      void restoreLastRom(session);
    }
  }

  function addSession(label: string): EmulatorSession {
    const session = new EmulatorSession(sessionsHost, label, {
      onFocus: focusSession,
      onRomMetaChanged: refreshTabLabels,
      onAddGame: ensureSecondSession,
      onRemoveGame: removeSecond,
      onToggleLink: toggleLink,
    });
    session.romSlot = sessions.length;
    sessions.push(session);
    if (mobile() && isDual()) showTab(sessions.length - 1);
    else setFocus(session);
    syncLayout();
    return session;
  }

  async function restoreLastRom(session: EmulatorSession): Promise<void> {
    try {
      const saved = await loadLastRom(session.romSlot);
      if (!saved) return;
      await session.loadRomBytes(saved.rom, saved.fileName);
      session.reportStatus(
        `${session.emu.title}${session.emu.isCgb ? " (CGB)" : " (DMG)"} — restored last ROM`,
      );
    } catch (err) {
      console.warn("Failed to restore last ROM:", err);
    }
  }

  addSession("Game 1");
  void restoreLastRom(sessions[0]!);

  for (const btn of tabButtons) {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.index);
      if (Number.isFinite(idx)) showTab(idx);
    });
  }

  addBtn.addEventListener("click", ensureSecondSession);
  removeBtn.addEventListener("click", removeSecond);
  linkBtn.addEventListener("click", toggleLink);

  function loop(now: number): void {
    if (document.hidden) {
      requestAnimationFrame(loop);
      return;
    }

    const dt = now - lastTs;
    lastTs = now;

    if (linked && isDual()) {
      const paced = takeFrameBudget(linkAcc, dt, 1);
      linkAcc = paced.accumulatorMs;
      for (let i = 0; i < paced.frames; i++) {
        sessions[0]!.lockstepFrame();
        sessions[1]!.lockstepFrame();
      }
    } else {
      for (const s of sessions) s.tick(now);
    }

    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      for (const s of sessions) s.pauseForBackground();
      return;
    }
    const now = performance.now();
    lastTs = now;
    linkAcc = 0;
    for (const s of sessions) s.resumeFromBackground(now);
  });

  window.addEventListener("keydown", (e) => focused?.handleKeyDown(e));
  window.addEventListener("keyup", (e) => focused?.handleKeyUp(e));
  window.addEventListener("beforeunload", () => {
    disconnectLink();
    for (const s of sessions) s.flushSave();
  });
}
