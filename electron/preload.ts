import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("api", {
  list: () => ipcRenderer.invoke("modules:list"),
  check: () => ipcRenderer.invoke("modules:check"),
  install: (id: string, force?: boolean) => ipcRenderer.invoke("modules:install", id, force),
  launch: (id: string) => ipcRenderer.invoke("modules:launch", id),
  openExternal: (url: string) => ipcRenderer.invoke("app:openExternal", url),
  appVersion: () => ipcRenderer.invoke("app:version"),
  checkSelfUpdate: () => ipcRenderer.invoke("app:checkSelfUpdate"),
  installSelfUpdate: () => ipcRenderer.invoke("app:installSelfUpdate"),
  onLog: (cb: (e: { id: string; msg: string }) => void) => {
    const h = (_: any, p: any) => cb(p);
    ipcRenderer.on("log", h);
    return () => ipcRenderer.removeListener("log", h);
  },
  onChange: (cb: (modules: any[]) => void) => {
    const h = (_: any, p: any) => cb(p);
    ipcRenderer.on("module-changed", h);
    return () => ipcRenderer.removeListener("module-changed", h);
  },
});
