/**
 * providers.ts — v2.8 Step 2 (plan WP26): the data providers named in About → "Data sources & thanks".
 *
 * Names in text only (no logos). `uses` is an i18n key saying what the app reads from the provider; `apiDocs` and
 * `terms` are plain links opened in the browser, never fetched (no network host). `credit` is a required attribution
 * that must appear verbatim. Terms links marked "[terms URL not verified]" point at the provider's main terms or
 * legal page and want an owner click-check.
 */
export interface Provider {
  id: string;
  name: string;
  /** i18n key: what this app uses the provider for. */
  uses: string;
  apiDocs: string;
  terms: string;
  credit?: string;
}

export const PROVIDERS: readonly Provider[] = [
  { id: "binance", name: "Binance", uses: "about.uses.exchange",
    apiDocs: "https://developers.binance.com/docs/binance-spot-api-docs",
    terms: "https://www.binance.com/en/terms" /* [terms URL not verified] */ },
  { id: "bybit", name: "Bybit", uses: "about.uses.exchange",
    apiDocs: "https://bybit-exchange.github.io/docs/v5/intro",
    terms: "https://www.bybit.com/en/help-center/article/Terms-of-Service" /* [terms URL not verified] */ },
  { id: "bitget", name: "Bitget", uses: "about.uses.exchange",
    apiDocs: "https://www.bitget.com/api-doc/common/intro",
    terms: "https://www.bitget.com/terms-of-service" /* [terms URL not verified] */ },
  { id: "coinsph", name: "Coins.ph", uses: "about.uses.exchange",
    apiDocs: "https://coins-docs.github.io/rest-api/",
    terms: "https://coins.ph/terms-of-use" /* [terms URL not verified] */ },
  { id: "okx", name: "OKX", uses: "about.uses.exchange",
    apiDocs: "https://www.okx.com/docs-v5/en/",
    terms: "https://www.okx.com/docs-v5/en/" /* the API page states the "OKX API Agreement" */ },
  { id: "coinbase", name: "Coinbase", uses: "about.uses.exchange",
    apiDocs: "https://docs.cdp.coinbase.com/exchange/introduction/welcome",
    terms: "https://www.coinbase.com/legal" /* [terms URL not verified] */ },
  { id: "upbit", name: "Upbit", uses: "about.uses.exchange",
    apiDocs: "https://global-docs.upbit.com/",
    terms: "https://global-docs.upbit.com/" /* [terms URL not verified]; Korean docs: https://docs.upbit.com/kr */ },
  { id: "binance-vision", name: "Binance Vision (archive)", uses: "about.uses.archive",
    apiDocs: "https://data.binance.vision",
    terms: "https://data.binance.vision" /* Terms of Use v1.0, CC BY-NC-SA 4.0 — see docs/measurement.md */ },
  { id: "frankfurter", name: "Frankfurter", uses: "about.uses.rates",
    apiDocs: "https://frankfurter.dev",
    terms: "https://frankfurter.dev" /* [terms URL not verified] */ },
  { id: "ecb", name: "European Central Bank", uses: "about.uses.rates",
    apiDocs: "https://data.ecb.europa.eu/main-figures/ecb-reference-rates",
    terms: "https://www.ecb.europa.eu/services/disclaimer/html/index.en.html" /* [terms URL not verified] */ },
  { id: "erapi", name: "ExchangeRate-API", uses: "about.uses.rates",
    apiDocs: "https://www.exchangerate-api.com",
    terms: "https://www.exchangerate-api.com/terms" /* [terms URL not verified] */,
    credit: "Rates By Exchange Rate API" },
  { id: "fawazahmed0", name: "fawazahmed0 currency-api", uses: "about.uses.rates",
    apiDocs: "https://github.com/fawazahmed0/exchange-api",
    terms: "https://github.com/fawazahmed0/exchange-api" /* licence: see the repository [terms URL not verified] */ },
  { id: "floatrates", name: "FloatRates", uses: "about.uses.rates",
    apiDocs: "https://www.floatrates.com",
    terms: "https://www.floatrates.com" /* [terms URL not verified] */ },
];
