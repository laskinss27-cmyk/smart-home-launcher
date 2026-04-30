export type AssetKind = "exe" | "zip";

export interface ModuleDef {
  id: string;
  name: string;
  description: string;
  repo: string;                       // owner/name
  assetPattern: RegExp;               // matches release asset filename
  assetKind: AssetKind;               // "exe" → run directly; "zip" → extract then run entryAfterExtract
  entryAfterExtract?: string;         // for zip: relative path inside extracted dir to the .exe
  gradient: [string, string];
}

export const MODULES: ModuleDef[] = [
  {
    id: "ctv-document-suite",
    name: "КП и Каталоги",
    description: "Генератор коммерческих предложений и каталогов",
    repo: "laskinss27-cmyk/ctv-document-suite",
    assetPattern: /CTV_Document_Suite\.exe$/i,
    assetKind: "exe",
    gradient: ["#7c3aed", "#3b82f6"],
  },
  {
    id: "smartplan",
    name: "SmartPlan",
    description: "Проектирование систем умного дома и видеонаблюдения",
    repo: "laskinss27-cmyk/smartplan",
    assetPattern: /SmartPlan-.*-win\.zip$/i,
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
    assetKind: "exe",
    gradient: ["#f97316", "#ec4899"],
  },
  {
    id: "smart-home-calculator",
    name: "Калькулятор УД",
    description: "Подбор оборудования Shelly / HitePRO под сценарий объекта",
    repo: "laskinss27-cmyk/smart-home-calculator",
    assetPattern: /SmartHomeCalculator-.*-win\.zip$/i,
    assetKind: "zip",
    entryAfterExtract: "SmartHomeCalculator.exe",
    gradient: ["#10b981", "#8b5cf6"],
  },
];
