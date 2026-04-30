export interface ModuleInfo {
  id: string;
  name: string;
  description: string;
  repo: string;
  branch: string;
  type: "python" | "electron";
  gradient: [string, string];
  installed: boolean;
  installedSha: string | null;
  running: boolean;
}

export interface UpdateInfo {
  current: string | null;
  latest: string;
  updateAvailable: boolean;
}

declare global {
  interface Window {
    api: {
      list: () => Promise<ModuleInfo[]>;
      check: () => Promise<Record<string, UpdateInfo>>;
      install: (id: string, force?: boolean) => Promise<void>;
      launch: (id: string) => Promise<void>;
      openExternal: (url: string) => Promise<void>;
      onLog: (cb: (e: { id: string; msg: string }) => void) => () => void;
      onChange: (cb: (modules: ModuleInfo[]) => void) => () => void;
    };
  }
}
