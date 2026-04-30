import { app, BrowserWindow } from "electron";
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import { pipeline } from "stream/promises";
import { ModuleDef, ModuleDefRaw, MODULES_FALLBACK, REMOTE_MODULES_URL, rawToDef } from "./modules";

const MODULES_DIR = path.join(app.getPath("userData"), "modules");
const STATE_FILE  = path.join(app.getPath("userData"), "state.json");

interface ModuleState {
  tag?: string;        // installed release tag, e.g. "v1.0.0"
  asset?: string;      // installed asset filename
  exePath?: string;    // absolute path to launchable .exe
  installedAt?: string;
}
interface State { modules: Record<string, ModuleState>; }

function loadState(): State {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return { modules: {} }; }
}
function saveState(s: State) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function moduleDir(m: ModuleDef) { return path.join(MODULES_DIR, m.id); }

function httpRequest(url: string, opts: https.RequestOptions = {}): Promise<{ status: number; headers: any; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { "User-Agent": "smart-home-launcher", Accept: "application/vnd.github+json", ...(opts.headers || {}) },
      ...opts,
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpRequest(res.headers.location, opts).then(resolve, reject);
      }
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
  });
}

async function fetchJson(url: string): Promise<any> {
  const r = await httpRequest(url);
  if (r.status !== 200) throw new Error(`GitHub API ${r.status}: ${r.body.toString("utf8").slice(0, 200)}`);
  return JSON.parse(r.body.toString("utf8"));
}

function downloadToFile(url: string, dest: string, onProgress?: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "smart-home-launcher", Accept: "application/octet-stream" } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadToFile(res.headers.location, dest, onProgress).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const total = parseInt(res.headers["content-length"] || "0", 10);
      let received = 0;
      res.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (total && onProgress) onProgress(Math.round((received / total) * 100));
      });
      const file = fs.createWriteStream(dest);
      pipeline(res, file).then(resolve, reject);
    });
    req.on("error", reject);
  });
}

interface LatestRelease {
  tag: string;
  asset: { name: string; url: string; size: number };
}

/** HEAD-запрос с ручной обработкой редиректов (нужен Location, не сама страница). */
function followRedirect(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { method: "HEAD", hostname: u.hostname, path: u.pathname + u.search,
        headers: { "User-Agent": "smart-home-launcher" } },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          resolve(res.headers.location);
        } else {
          reject(new Error(`HTTP ${res.statusCode} (ожидался редирект)`));
        }
      }
    );
    req.on("error", reject);
    req.end();
  });
}

/** Без GitHub API: github.com/owner/repo/releases/latest → Location: .../tag/<TAG>. */
async function getLatestReleaseNoApi(m: ModuleDef): Promise<LatestRelease> {
  if (!m.assetTemplate) throw new Error("assetTemplate не задан");
  const loc = await followRedirect(`https://github.com/${m.repo}/releases/latest`);
  const tagMatch = loc.match(/\/tag\/([^/?#]+)/);
  if (!tagMatch) throw new Error(`Не удалось извлечь тег из ${loc}`);
  const tag = decodeURIComponent(tagMatch[1]);
  const version = tag.replace(/^v/, "");
  const name = m.assetTemplate.replace(/\{tag\}/g, tag).replace(/\{version\}/g, version);
  const url = `https://github.com/${m.repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
  return { tag, asset: { name, url, size: 0 } };
}

async function getLatestReleaseApi(m: ModuleDef): Promise<LatestRelease> {
  const data = await fetchJson(`https://api.github.com/repos/${m.repo}/releases/latest`);
  if (!data?.tag_name) throw new Error("Релиз не найден");
  const asset = (data.assets || []).find((a: any) => m.assetPattern.test(a.name));
  if (!asset) throw new Error(`В релизе ${data.tag_name} нет подходящего файла`);
  return { tag: data.tag_name, asset: { name: asset.name, url: asset.browser_download_url || asset.url, size: asset.size } };
}

const RELEASE_CACHE = new Map<string, { at: number; rel: LatestRelease }>();
const RELEASE_TTL_MS = 30 * 60 * 1000;

async function getLatestRelease(m: ModuleDef): Promise<LatestRelease> {
  const cached = RELEASE_CACHE.get(m.id);
  if (cached && Date.now() - cached.at < RELEASE_TTL_MS) return cached.rel;
  // Сначала — без API (нет rate-limit), фолбэк — на API.
  let rel: LatestRelease;
  try {
    rel = await getLatestReleaseNoApi(m);
  } catch {
    rel = await getLatestReleaseApi(m);
  }
  RELEASE_CACHE.set(m.id, { at: Date.now(), rel });
  return rel;
}

async function extractZip(zipPath: string, outDir: string) {
  fs.mkdirSync(outDir, { recursive: true });
  // PowerShell Expand-Archive is built into Windows.
  await new Promise<void>((resolve, reject) => {
    const p = spawn("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${outDir.replace(/'/g, "''")}' -Force`,
    ], { windowsHide: true });
    p.on("error", reject);
    p.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Expand-Archive exit ${code}`)));
  });
}

function findExe(dir: string, name: string): string | null {
  // Search up to 3 levels deep for the named exe.
  const stack: { dir: string; depth: number }[] = [{ dir, depth: 0 }];
  while (stack.length) {
    const { dir: d, depth } = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return full;
      if (e.isDirectory() && depth < 3) stack.push({ dir: full, depth: depth + 1 });
    }
  }
  return null;
}

export class ModuleManager {
  private state: State = loadState();
  private running = new Map<string, ChildProcess>();
  private modules: ModuleDef[] = MODULES_FALLBACK;
  private modulesLoaded = false;

  constructor(private getWin: () => BrowserWindow | null) {
    fs.mkdirSync(MODULES_DIR, { recursive: true });
  }

  private send(channel: string, payload: any) {
    this.getWin()?.webContents.send(channel, payload);
  }

  /** Загружает свежий список модулей с GitHub. Молча падает на bundled fallback. */
  async refreshRemoteModules() {
    try {
      const r = await httpRequest(REMOTE_MODULES_URL);
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      const raw = JSON.parse(r.body.toString("utf8")) as ModuleDefRaw[];
      if (!Array.isArray(raw) || raw.length === 0) throw new Error("empty list");
      this.modules = raw.map(rawToDef);
      this.modulesLoaded = true;
      this.send("module-changed", this.list());
    } catch (e: any) {
      this.send("log", { id: "launcher", msg: `Список модулей: использую встроенный (${e.message})` });
    }
  }

  list() {
    return this.modules.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      repo: m.repo,
      gradient: m.gradient,
      installed: !!this.state.modules[m.id]?.tag,
      installedTag: this.state.modules[m.id]?.tag ?? null,
      running: this.running.has(m.id),
    }));
  }

  async checkUpdates() {
    const out: Record<string, { current: string | null; latest: string; updateAvailable: boolean }> = {};
    for (const m of this.modules) {
      try {
        const r = await getLatestRelease(m);
        const current = this.state.modules[m.id]?.tag ?? null;
        out[m.id] = { current, latest: r.tag, updateAvailable: !!current && current !== r.tag };
      } catch (e: any) {
        this.send("log", { id: m.id, msg: `Проверка обновлений: ${e.message}` });
      }
    }
    return out;
  }

  async install(id: string, force = false) {
    const m = this.modules.find((x) => x.id === id);
    if (!m) throw new Error("unknown module");
    const log = (msg: string) => this.send("log", { id, msg });

    log(`Получаю информацию о последнем релизе ${m.name}...`);
    const release = await getLatestRelease(m);

    if (!force && this.state.modules[m.id]?.tag === release.tag) {
      log("Уже установлена последняя версия.");
      return;
    }

    const dir = moduleDir(m);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    log(`Скачиваю ${release.asset.name} (${(release.asset.size / 1024 / 1024).toFixed(1)} МБ)...`);
    const downloadPath = path.join(dir, release.asset.name);
    await downloadToFile(release.asset.url, downloadPath, (pct) => {
      if (pct % 10 === 0) log(`  ${pct}%`);
    });

    let exePath: string;
    if (m.assetKind === "exe") {
      exePath = downloadPath;
    } else {
      log("Распаковываю...");
      const extractDir = path.join(dir, "app");
      await extractZip(downloadPath, extractDir);
      fs.unlinkSync(downloadPath);
      const found = findExe(extractDir, m.entryAfterExtract!);
      if (!found) throw new Error(`Не найден ${m.entryAfterExtract} в архиве`);
      exePath = found;
    }

    this.state.modules[m.id] = {
      tag: release.tag,
      asset: release.asset.name,
      exePath,
      installedAt: new Date().toISOString(),
    };
    saveState(this.state);
    log(`Готово: ${m.name} ${release.tag} установлен.`);
    this.send("module-changed", this.list());
  }

  async launch(id: string) {
    const m = this.modules.find((x) => x.id === id);
    if (!m) throw new Error("unknown module");
    if (this.running.has(id)) throw new Error("уже запущено");
    const st = this.state.modules[id];
    if (!st?.exePath || !fs.existsSync(st.exePath)) throw new Error("модуль не установлен");

    const proc = spawn(st.exePath, [], {
      cwd: path.dirname(st.exePath),
      detached: false,
      windowsHide: false,
    });

    proc.on("exit", () => {
      this.running.delete(id);
      this.send("module-changed", this.list());
    });
    proc.on("error", (e) => this.send("log", { id, msg: `Ошибка запуска: ${e.message}` }));

    this.running.set(id, proc);
    this.send("module-changed", this.list());
  }
}
