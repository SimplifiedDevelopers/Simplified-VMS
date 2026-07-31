import { join } from 'path';
import { app, BrowserWindow, ipcMain, nativeTheme, shell, type Rectangle } from 'electron';
import type { CompanyLinkKind } from '../../shared/types';

export function registerSystemIpcHandlers(): void {
  ipcMain.handle('system:restart', (): void => {
    app.relaunch();
    app.exit(0);
  });

  ipcMain.handle('system:openInBrowser', async (_event, host: string, port: number): Promise<void> => {
    await shell.openExternal(`http://${host}:${port}`);
  });

  // Fixed company resources (website, email, phone, TeamViewer support) for
  // the Home page's logo/company-info links — every URL is hardcoded here,
  // never passed up from the renderer, so this is a constrained lookup
  // rather than a generic renderer-can-open-any-URL primitive.
  const COMPANY_LINKS: Record<CompanyLinkKind, string> = {
    website: 'https://ssmcctv.com',
    email: 'mailto:office@ssmcctv.com',
    phone: 'tel:+15616932624',
    support: 'https://get.teamviewer.com/6hqxaj6',
  };

  ipcMain.handle('system:openCompanyLink', async (_event, kind: CompanyLinkKind): Promise<void> => {
    await shell.openExternal(COMPANY_LINKS[kind]);
  });

  // Every handler below resolves the target window from whichever window
  // actually called it (BrowserWindow.fromWebContents(event.sender)) rather
  // than a single fixed reference — both the main window and any popped-out
  // tab window (see ipc/windows.ts) are frameless and draw their own
  // minimize/maximize/close/fullscreen controls, and each must only ever
  // act on itself.

  // True OS-level fullscreen (edge-to-edge, no title bar), not just
  // maximizing the window — used by Live View's fullscreen toggle to show
  // just the camera grid with nothing else on screen.
  ipcMain.handle('system:setFullScreen', (event, fullScreen: boolean): void => {
    BrowserWindow.fromWebContents(event.sender)?.setFullScreen(fullScreen);
  });

  // Used by AppShell's tab strip to detect a tab being dragged outside the
  // main window's bounds (see AppShell.tsx's onDragEnd) — only ever called
  // from the main window, since only it has a tab strip to drag from.
  ipcMain.handle('system:getWindowBounds', (event): Rectangle => BrowserWindow.fromWebContents(event.sender)!.getBounds());

  ipcMain.handle('system:minimizeWindow', (event): void => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  ipcMain.handle('system:toggleMaximizeWindow', (event): void => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  ipcMain.handle('system:closeWindow', (event): void => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  ipcMain.handle(
    'system:isWindowMaximized',
    (event): boolean => BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false,
  );

  ipcMain.handle('system:getAppVersion', (): string => app.getVersion());

  // Backs the "Automatic" theme option (see theme.ts/AppShell.tsx) —
  // 'auto' isn't a real CSS state, it's resolved to light/dark using
  // whatever the OS itself is currently set to.
  ipcMain.handle('system:getSystemPrefersDark', (): boolean => nativeTheme.shouldUseDarkColors);
  nativeTheme.on('updated', () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('system:systemThemeChanged', nativeTheme.shouldUseDarkColors);
    }
  });

  // Opens the bundled manual.html in the OS's default handler (same
  // resourcesPath-vs-source-tree split as the native addons in
  // electron-builder.yml/adapters — docs/ isn't inside app.asar either).
  // The manual itself is a placeholder today; the button/IPC plumbing is
  // done now so dropping in the real content later needs no code changes.
  ipcMain.handle('system:openManual', async (): Promise<boolean> => {
    const manualPath = app.isPackaged
      ? join(process.resourcesPath, 'docs/manual.html')
      : join(__dirname, '../../docs/manual.html');
    const error = await shell.openPath(manualPath);
    return error === '';
  });
}
