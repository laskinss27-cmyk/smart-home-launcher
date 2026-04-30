import { app, BrowserWindow, ipcMain, shell } from "electron";
import * as path from "path";
import { ModuleManager } from "./moduleManager";

let win: BrowserWindow | null = null;
let manager: ModuleManager;

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0f1115",
    title: "Умный Дом",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.NODE_ENV === "development") {
    win.loadURL("http://localhost:5173");
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

app.whenReady().then(async () => {
  manager = new ModuleManager(() => win);
  createWindow();
  // Подтягиваем актуальный список модулей с GitHub (без блокировки запуска).
  manager.refreshRemoteModules();

  ipcMain.handle("modules:list",     () => manager.list());
  ipcMain.handle("modules:refresh",  () => manager.refreshRemoteModules());
  ipcMain.handle("modules:check",    () => manager.checkUpdates());
  ipcMain.handle("modules:install",  (_e, id: string, force?: boolean) => manager.install(id, !!force));
  ipcMain.handle("modules:launch",   (_e, id: string) => manager.launch(id));
  ipcMain.handle("app:openExternal", (_e, url: string) => shell.openExternal(url));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
