export const VOTING_INDICATORS = [
  { id: "sma", name: "SMA 20/50" }, { id: "ema", name: "EMA 9/21" },
  { id: "macd", name: "MACD 12/26/9" }, { id: "adx", name: "ADX 14" },
  { id: "psar", name: "Parabolic SAR" }, { id: "ichimoku", name: "Ichimoku Cloud" },
  { id: "supertrend", name: "Supertrend 10/3" }, { id: "rsi", name: "RSI 14" },
  { id: "stochastic", name: "Stochastic 14/3" }, { id: "cci", name: "CCI 20" },
  { id: "williams", name: "Williams %R 14" }, { id: "ao", name: "Awesome Osc." },
  { id: "mfi", name: "MFI 14" }, { id: "bollinger", name: "Bollinger 20/2" },
  { id: "keltner", name: "Keltner 20/10" }, { id: "vwap", name: "VWAP" },
  { id: "obv", name: "OBV" }, { id: "cmf", name: "CMF 20" },
] as const;

export type VotingIndicatorId = typeof VOTING_INDICATORS[number]["id"];
export interface ScoringProfile { version: 1; enabled: VotingIndicatorId[] }

export function normalizeScoringProfile(value: unknown): ScoringProfile | null {
  if (value === undefined || value === null) return null;
  const profile = value as Partial<ScoringProfile>;
  if (profile.version !== 1 || !Array.isArray(profile.enabled)) throw new Error("Unsupported scoring profile.");
  const valid = new Set<string>(VOTING_INDICATORS.map((indicator) => indicator.id));
  const unique = new Set(profile.enabled);
  if (unique.size !== profile.enabled.length || profile.enabled.some((id) => !valid.has(id))) {
    throw new Error("Scoring profile contains unknown or duplicate indicator IDs.");
  }
  if (unique.size === valid.size) return null;
  return { version: 1, enabled: [...unique].sort() };
}
