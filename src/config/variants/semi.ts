// Semi variant - semiconductor & chip supply-chain intelligence
// NOTE: This file is a structured canonical description for reference. The runtime
// wiring lives in src/config/panels.ts (SEMI_PANELS, SEMI_MAP_LAYERS,
// SEMI_MOBILE_MAP_LAYERS) — modify both if the variant shape changes. Parallel
// to energy.ts / commodity.ts / finance.ts / tech.ts / happy.ts / full.ts orphans.
//
// Served from semi.worldmonitor.app by the shared web deploy and buildable
// standalone with VITE_VARIANT=semi (npm run dev:semi / build:semi).
// docs/semiconductor-variant.mdx documents the wiring and the one
// out-of-repo step (DNS + Vercel domain assignment).
import type { PanelConfig, MapLayers } from '@/types';
import type { VariantConfig } from './base';

// Re-export base config
export * from './base';

// ─────────────────────────────────────────────────────────────────────────────
// PANEL CONFIGURATION — Semiconductor-focused panels
// Chip-specific news categories (semiconductors / fab-capex / export-controls /
// chip-materials) are new and defined in SEMI_FEEDS; every other key is reused
// from the tech / commodity / full presets so no new panel component is needed.
// ─────────────────────────────────────────────────────────────────────────────
export const DEFAULT_PANELS: Record<string, PanelConfig> = {
  // Core
  map: { name: 'Semiconductor & Supply Chain Map', enabled: true, priority: 1 },
  'live-news': { name: 'Chip Industry Headlines', enabled: true, priority: 1 },
  insights: { name: 'AI Supply Chain Insights', enabled: true, priority: 1 },
  // Chip-specific news
  semiconductors: { name: 'Semiconductor News', enabled: true, priority: 1 },
  'fab-capex': { name: 'Fabs & Capex', enabled: true, priority: 1 },
  'export-controls': { name: 'Export Controls & Chip Policy', enabled: true, priority: 1 },
  'chip-materials': { name: 'Materials, Substrates & HBM', enabled: true, priority: 1 },
  // Adjacent news (resolved from CANONICAL_FEEDS, not SEMI_FEEDS)
  hardware: { name: 'Hardware & Devices', enabled: true, priority: 2 },
  ai: { name: 'AI & Compute Demand', enabled: true, priority: 2 },
  'critical-minerals': { name: 'Critical Minerals', enabled: true, priority: 2 },
  security: { name: 'Cyber & OT Security', enabled: true, priority: 2 },
  policy: { name: 'Tech Policy', enabled: true, priority: 2 },
  layoffs: { name: 'Layoffs & Restructuring', enabled: true, priority: 3 },
  // Supply chain & trade
  'supply-chain': { name: 'Supply Chain & Logistics', enabled: true, priority: 1 },
  'trade-policy': { name: 'Trade Policy', enabled: true, priority: 1 },
  'global-procurement': { name: 'Global Procurement', enabled: true, priority: 2 },
  'sanctions-pressure': { name: 'Sanctions Pressure', enabled: true, priority: 2 },
  // Markets
  markets: { name: 'Chip & Equipment Markets', enabled: true, priority: 1 },
  commodities: { name: 'Materials & Commodities', enabled: true, priority: 2 },
  heatmap: { name: 'Sector Heatmap', enabled: true, priority: 2 },
  'macro-signals': { name: 'Market Radar', enabled: true, priority: 2 },
  economic: { name: 'Macro Stress', enabled: true, priority: 2 },
  polymarket: { name: 'Tech & Trade Predictions', enabled: true, priority: 3 },
  // Tracking
  monitors: { name: 'My Monitors', enabled: true, priority: 3 },
  'world-clock': { name: 'World Clock', enabled: true, priority: 3 },
  'latest-brief': { name: 'Latest Brief', enabled: true, priority: 1, premium: 'locked' as const },
};

// ─────────────────────────────────────────────────────────────────────────────
// MAP LAYERS — Semiconductor-focused
// Only chip-relevant layers enabled; all others explicitly false.
// ─────────────────────────────────────────────────────────────────────────────
export const DEFAULT_MAP_LAYERS: MapLayers = {
  // ── Fab / compute footprint (ENABLED) ─────────────────────────────────────
  datacenters: true,
  cloudRegions: true,
  techHQs: true,
  cables: true,
  // ── Materials & logistics ─────────────────────────────────────────────────
  minerals: true,
  commodityPorts: true,
  tradeRoutes: true,
  waterways: true,
  miningSites: false,
  processingPlants: false,
  ais: false,
  // ── Policy & operating risk ───────────────────────────────────────────────
  sanctions: true,
  economic: true,
  outages: true,
  natural: true,
  weather: false,
  fires: false,
  climate: false,
  cyberThreats: false,
  resilienceScore: false,
  dayNight: false,

  // ── Not applicable (DISABLED) ─────────────────────────────────────────────
  gpsJamming: false,
  satellites: false,
  conflicts: false,
  bases: false,
  pipelines: false,
  hotspots: false,
  nuclear: false,
  irradiators: false,
  protests: false,
  flights: false,
  military: false,
  spaceports: false,
  ucdpEvents: false,
  displacement: false,
  startupHubs: false,
  accelerators: false,
  techEvents: false,
  stockExchanges: false,
  financialCenters: false,
  centralBanks: false,
  commodityHubs: false,
  gulfInvestments: false,
  positiveEvents: false,
  kindness: false,
  happiness: false,
  speciesRecovery: false,
  renewableInstallations: false,
  iranAttacks: false,
  ciiChoropleth: false,
  webcams: false,
  diseaseOutbreaks: false,
  storageFacilities: false,
  fuelShortages: false,
  liveTankers: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// MOBILE MAP LAYERS — Minimal set for semi mobile view
// ─────────────────────────────────────────────────────────────────────────────
export const MOBILE_DEFAULT_MAP_LAYERS: MapLayers = {
  ...DEFAULT_MAP_LAYERS,
  cables: false,
  cloudRegions: false,
  tradeRoutes: false,
  waterways: false,
  sanctions: false,
  economic: false,
  outages: false,
};

export const VARIANT_CONFIG: VariantConfig = {
  name: 'semi',
  description: 'Semiconductor & chip supply-chain intelligence — fabs, capex, packaging, materials, export controls',
  panels: DEFAULT_PANELS,
  mapLayers: DEFAULT_MAP_LAYERS,
  mobileMapLayers: MOBILE_DEFAULT_MAP_LAYERS,
};
