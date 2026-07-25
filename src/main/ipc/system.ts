import { app, ipcMain, shell } from 'electron';

export function registerSystemIpcHandlers(): void {
  ipcMain.handle('system:restart', (): void => {
    app.relaunch();
    app.exit(0);
  });

  ipcMain.handle('system:openInBrowser', async (_event, host: string, port: number): Promise<void> => {
    await shell.openExternal(`http://${host}:${port}`);
  });
}
