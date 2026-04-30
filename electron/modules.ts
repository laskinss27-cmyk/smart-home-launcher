export type AssetKind = "exe" | "zip";

export interface ModuleDef {
  id: string;
  name: string;
  description: string;
  repo: string;                       // owner/name
  assetPattern: RegExp;               // matches release asset filename (used as fallback when assetTemplate отсутствует)
  /** Имя файла-ассета. Поддерживает плейсхолдеры {tag} и {version}. Если задано — лаунчер
   *  не использует GitHub API и не упирается в rate-limit. */
  assetTemplate?: string;
  assetKind: AssetKind;               // "exe" → run directly; "zip" → extract then run entryAfterExtract
  entryAfterExtract?: string;         // for zip: relative path inside extracted dir to the .exe
  gradient: [string, string];
}

// Raw form parsed from remote modules.json (assetPattern stored as string)
export interface ModuleDefRaw {
  id: string;
  name: string;
  description: string;
  repo: string;
  assetPattern: string;
  assetTemplate?: string;
  assetKind: AssetKind;
  entryAfterExtract?: string;
  gradient: [string, string];
}

export function rawToDef(r: ModuleDefRaw): ModuleDef {
  return { ...r, assetPattern: new RegExp(r.assetPattern, "i") };
}

// URL списка модулей. Лаунчер тянет его при старте, чтобы добавление новых
// модулей не требовало переустановки самого лаунчера.
export const REMOTE_MODULES_URL =
  "https://raw.githubusercontent.com/laskinss27-cmyk/smart-home-launcher/main/modules.json";

// Bundled fallback — используется, если нет сети или удалённый JSON битый.
export const MODULES_FALLBACK: ModuleDef[] = [
  {
    id: "ctv-document-suite",
    name: "КП и Каталоги",
    description: "Генератор коммерческих предложений и каталогов",
    repo: "laskinss27-cmyk/ctv-document-suite",
    assetPattern: /CTV_Document_Suite\.exe$/i,
    assetTemplate: "CTV_Document_Suite.exe",
    assetKind: "exe",
    gradient: ["#7c3aed", "#3b82f6"],
  },
  {
    id: "smartplan",
    name: "SmartPlan",
    description: "Проектирование систем умного дома и видеонаблюдения",
    repo: "laskinss27-cmyk/smartplan",
    assetPattern: /SmartPlan-.*-win\.zip$/i,
    assetTemplate: "SmartPlan-{version}-win.zip",
    assetKind: "zip",
    entryAfterExtract: "SmartPlan.exe",
    gradient: ["#06b6d4", "#3b82f6"],
  },
  {
    id: "price_tags",
    name: "Ценники",
    description: "Печать ценников из базы товаров",
    repo: "laskinss27-cmyk/price_tags",
    assetPattern: /price_tags\.exe$/i,
    assetTemplate: "price_tags.exe",
    assetKind: "exe",
    gradient: ["#f97316", "#ec4899"],
  },
  {
    id: "smart-home-calculator",
    name: "Калькулятор УД",
    description: "Подбор оборудования Shelly / HitePRO под сценарий объекта",
    repo: "laskinss27-cmyk/smart-home-calculator",
    assetPattern: /SmartHomeCalculator-.*-win\.zip$/i,
    assetTemplate: "SmartHomeCalculator-{version}-win.zip",
    assetKind: "zip",
    entryAfterExtract: "SmartHomeCalculator.exe",
    gradient: ["#10b981", "#8b5cf6"],
  },
];
