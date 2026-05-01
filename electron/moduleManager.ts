import { app, BrowserWindow } from "electron";
import { spawn, ChildProcess, execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import { pipeline } from "stream/promises";
import { ModuleDef, ModuleDefRaw, MODULES_FALLBACK, REMOTE_MODULES_URL, rawToDef } from "./modules";

const MODULES_DIR = path.join(app.getPath("userData"), "modules");
const STATE_FILE  = path.join(app.getPath("userData"), "state.json");

interface ModuleState {
  tag?: string;            // installed release tag, e.g. "v1.0.0"
  asset?: string;          // installed asset filename
  exePath?: string;        // absolute path to launchable .exe
  versionDir?: string;     // абсолютный путь к папке этой версии (<MODULES_DIR>/<id>/<safeTag>/)
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

function moduleRoot(m: ModuleDef) { return path.join(MODULES_DIR, m.id); }
/** "v1.2.0" → "v1.2.0", любой не-ASCII заменяем на _ для безопасности файловой системы. */
function safeTag(tag: string) { return tag.replace(/[^A-Za-z0-9._-]/g, "_"); }
function versionDirFor(m: ModuleDef, tag: string) {
  return path.join(moduleRoot(m), safeTag(tag));
}

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

/** HEAD по download-URL: 200/302 → existsует, 404 → нет. Без скачивания. */
function headExists(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.request(
      { method: "HEAD", hostname: u.hostname, path: u.pathname + u.search,
        headers: { "User-Agent": "smart-home-launcher" } },
      (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          headExists(res.headers.location).then(resolve);
        } else {
          resolve(code === 200);
        }
      }
    );
    req.on("error", () => resolve(false));
    req.end();
  });
}

/** Без GitHub API: github.com/owner/repo/releases/latest → Location: .../tag/<TAG>.
 *  Дополнительно HEAD-проверяем готовый URL — если репозиторий релизит ассет с
 *  именем, не совпадающим с {version} (бывает при ручных загрузках), сообщаем
 *  об отсутствии, чтобы вызывающий код перешёл на API-поиск по regex. */
async function getLatestReleaseNoApi(m: ModuleDef): Promise<LatestRelease> {
  if (!m.assetTemplate) throw new Error("assetTemplate не задан");
  const loc = await followRedirect(`https://github.com/${m.repo}/releases/latest`);
  const tagMatch = loc.match(/\/tag\/([^/?#]+)/);
  if (!tagMatch) throw new Error(`Не удалось извлечь тег из ${loc}`);
  const tag = decodeURIComponent(tagMatch[1]);
  const version = tag.replace(/^v/, "");
  const name = m.assetTemplate.replace(/\{tag\}/g, tag).replace(/\{version\}/g, version);
  const url = `https://github.com/${m.repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
  if (!(await headExists(url))) {
    throw new Error(`Файл по шаблону не найден: ${name}`);
  }
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
  let rel: LatestRelease;
  try { rel = await getLatestReleaseNoApi(m); }
  catch { rel = await getLatestReleaseApi(m); }
  RELEASE_CACHE.set(m.id, { at: Date.now(), rel });
  return rel;
}

async function extractZip(zipPath: string, outDir: string) {
  fs.mkdirSync(outDir, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const p = spawn("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${outDir.replace(/'/g, "''")}' -Force`,
    ], { windowsHide: true });
    p.on("error", reject);
    p.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Expand-Archive exit ${code}`)));
  });
}

/** Жёстко гасим всё дерево процессов по PID (Windows). Не падаем, если уже мёртв. */
function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      try { process.kill(pid, "SIGKILL"); } catch {}
      return resolve();
    }
    execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], () => resolve());
  });
}

function rmDirSafe(dir: string) {
  if (!fs.existsSync(dir)) return;
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  catch {
    // если не удалось — переименуем, чтобы не мешалось; почистится при следующем старте
    try { fs.renameSync(dir, dir + ".old-" + Date.now()); } catch {}
  }
}

function findExe(dir: string, name: string): string | null {
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
  private running = new Map<string, { proc: ChildProcess; pid: number }>();
  private modules: ModuleDef[] = MODULES_FALLBACK;

  constructor(private getWin: () => BrowserWindow | null) {
    fs.mkdirSync(MODULES_DIR, { recursive: true });
    // На старте чистим осиротевшие папки старых версий — они уже точно никем не открыты.
    this.cleanupOldVersionsOnStartup();
    this.reconcileState();
  }

  /** Сбрасываем записи state для модулей, у которых exe не существует —
   *  иначе UI говорит "установлено", а запуск падает на "модуль не установлен". */
  private reconcileState() {
    let dirty = false;
    for (const id of Object.keys(this.state.modules)) {
      const st = this.state.modules[id];
      if (!st?.exePath || !fs.existsSync(st.exePath)) {
        delete this.state.modules[id];
        dirty = true;
      }
    }
    if (dirty) saveState(this.state);
  }

  private send(channel: string, payload: any) {
    this.getWin()?.webContents.send(channel, payload);
  }

  /** Удаляем всё в <MODULES_DIR>/<id>/, кроме текущей версии из state.
   *  Если versionDir в state не задан — это legacy-установка от старого
   *  лаунчера (плоская раскладка), её не трогаем: иначе снесём и сам exe.
   *  Также игнорируем папку, если внутри неё лежит exePath из state — это
   *  страхует от любых расхождений в имени тега/файловой системы. */
  private cleanupOldVersionsOnStartup() {
    for (const m of MODULES_FALLBACK) {
      const st = this.state.modules[m.id];
      if (!st?.versionDir) continue;       // legacy install — не трогаем
      const root = moduleRoot(m);
      if (!fs.existsSync(root)) continue;
      const keep = path.basename(st.versionDir);
      const exeAbs = st.exePath ? path.resolve(st.exePath) : null;
      let entries: string[] = [];
      try { entries = fs.readdirSync(root); } catch { continue; }
      for (const name of entries) {
        if (name === keep) continue;
        const full = path.join(root, name);
        // Если exe из state лежит внутри этой папки — оставляем (legacy в подпапке).
        if (exeAbs && exeAbs.startsWith(path.resolve(full) + path.sep)) continue;
        rmDirSafe(full);
      }
    }
  }

  /** Загружает свежий список модулей с GitHub. Молча падает на bundled fallback. */
  async refreshRemoteModules() {
    try {
      const r = await httpRequest(REMOTE_MODULES_URL);
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      const raw = JSON.parse(r.body.toString("utf8")) as ModuleDefRaw[];
      if (!Array.isArray(raw) || raw.length === 0) throw new Error("empty list");
      this.modules = raw.map(rawToDef);
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

  /** Если модуль ещё запущен — гасим его дерево процессов и ждём, пока state очистится. */
  private async ensureStopped(id: string, log: (m: string) => void) {
    const r = this.running.get(id);
    if (!r) return;
    log("Закрываю запущенный модуль...");
    await killTree(r.pid);
    // ждём, пока 'exit' хэндлер уберёт запись (taskkill /F работает почти моментально)
    for (let i = 0; i < 50 && this.running.has(id); i++) {
      await new Promise((res) => setTimeout(res, 100));
    }
    this.running.delete(id);
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

    // Если модуль запущен — гасим (даже если "тот же" процесс уже не наш ребёнок,
    // мы хотя бы остановим всё, что мы сами запустили).
    await this.ensureStopped(id, log);

    // Папка новой версии — отдельная. Старая остаётся нетронутой.
    const vdir = versionDirFor(m, release.tag);
    rmDirSafe(vdir);          // на случай битой предыдущей попытки в ту же версию
    fs.mkdirSync(vdir, { recursive: true });

    log(`Скачиваю ${release.asset.name}${release.asset.size ? ` (${(release.asset.size / 1024 / 1024).toFixed(1)} МБ)` : ""}...`);
    const downloadPath = path.join(vdir, release.asset.name);
    await downloadToFile(release.asset.url, downloadPath, (pct) => {
      if (pct % 10 === 0) log(`  ${pct}%`);
    });

    let exePath: string;
    if (m.assetKind === "exe") {
      exePath = downloadPath;
    } else {
      log("Распаковываю...");
      const extractDir = path.join(vdir, "app");
      await extractZip(downloadPath, extractDir);
      try { fs.unlinkSync(downloadPath); } catch {}
      const found = findExe(extractDir, m.entryAfterExtract!);
      if (!found) throw new Error(`Не найден ${m.entryAfterExtract} в архиве`);
      exePath = found;
    }

    // Запоминаем старую версию, чтобы удалить её после атомарного переключения.
    const prevVersionDir = this.state.modules[m.id]?.versionDir;

    this.state.modules[m.id] = {
      tag: release.tag,
      asset: release.asset.name,
      exePath,
      versionDir: vdir,
      installedAt: new Date().toISOString(),
    };
    saveState(this.state);

    // Старую папку чистим best-effort — не падаем, если занята:
    // на следующем старте лаунчера cleanupOldVersionsOnStartup её добьёт.
    if (prevVersionDir && prevVersionDir !== vdir && fs.existsSync(prevVersionDir)) {
      log("Удаляю старую версию...");
      rmDirSafe(prevVersionDir);
    }

    log(`Готово: ${m.name} ${release.tag} установлен.`);
    this.send("module-changed", this.list());
  }

  async launch(id: string) {
    const m = this.modules.find((x) => x.id === id);
    if (!m) throw new Error("unknown module");
    if (this.running.has(id)) throw new Error("уже запущено");
    const st = this.state.modules[id];
    if (!st?.exePath || !fs.existsSync(st.exePath)) throw new Error("модуль не установлен");

    // detached + ignore stdio: лаунчер не держит pipes на дочерний процесс,
    // ОС не считает его виновником при попытке удалить файлы модуля.
    const proc = spawn(st.exePath, [], {
      cwd: path.dirname(st.exePath),
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    proc.unref();

    proc.on("exit", () => {
      this.running.delete(id);
      this.send("module-changed", this.list());
    });
    proc.on("error", (e) => {
      this.running.delete(id);
      this.send("log", { id, msg: `Ошибка запуска: ${e.message}` });
      this.send("module-changed", this.list());
    });

    if (proc.pid) this.running.set(id, { proc, pid: proc.pid });
    this.send("module-changed", this.list());
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Self-update лаунчера: тянем NSIS .exe c релиза и запускаем его, лаунчер
// при этом завершается. NSIS установит поверх и перезапустит.
// ───────────────────────────────────────────────────────────────────────────

const LAUNCHER_REPO = "laskinss27-cmyk/smart-home-launcher";
const LAUNCHER_ASSET_TEMPLATE = "SmartHomeLauncher-Setup-{version}.exe";

export async function checkLauncherUpdate(): Promise<{ current: string; latest: string; updateAvailable: boolean }> {
  const fakeMod: ModuleDef = {
    id: "__launcher__",
    name: "Smart Home Launcher",
    description: "",
    repo: LAUNCHER_REPO,
    assetPattern: /SmartHomeLauncher-Setup-.*\.exe$/i,
    assetTemplate: LAUNCHER_ASSET_TEMPLATE,
    assetKind: "exe",
    gradient: ["#000", "#000"],
  };
  const r = await getLatestRelease(fakeMod);
  const current = "v" + app.getVersion();
  return { current, latest: r.tag, updateAvailable: current !== r.tag };
}

export async function installLauncherUpdate(onLog: (msg: string) => void): Promise<void> {
  const fakeMod: ModuleDef = {
    id: "__launcher__",
    name: "Smart Home Launcher",
    description: "",
    repo: LAUNCHER_REPO,
    assetPattern: /SmartHomeLauncher-Setup-.*\.exe$/i,
    assetTemplate: LAUNCHER_ASSET_TEMPLATE,
    assetKind: "exe",
    gradient: ["#000", "#000"],
  };
  onLog("Получаю информацию о последнем релизе лаунчера...");
  const r = await getLatestRelease(fakeMod);
  const current = "v" + app.getVersion();
  if (current === r.tag) {
    onLog("Уже последняя версия.");
    return;
  }
  const tmpDir = app.getPath("temp");
  const dest = path.join(tmpDir, r.asset.name);
  onLog(`Скачиваю ${r.asset.name}...`);
  await downloadToFile(r.asset.url, dest, (pct) => {
    if (pct % 10 === 0) onLog(`  ${pct}%`);
  });
  onLog("Запускаю установщик. Лаунчер сейчас закроется.");
  // Запускаем установщик отвязанно — он переживёт нас.
  const child = spawn(dest, [], { detached: true, stdio: "ignore" });
  child.unref();
  // Даём установщику стартануть и закрываемся.
  setTimeout(() => app.quit(), 500);
}
