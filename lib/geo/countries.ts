/**
 * Country-name → ISO 3166-1 alpha-2 lookup for the countries Mayim is likely
 * to analyse. Used to bias Exa searches (`userLocation`) and to pick the
 * country partner list. Geocoders spell names differently, so aliases are
 * matched case- and accent-insensitively.
 */

const ISO2_BY_NAME: Record<string, string> = {
  algeria: "DZ",
  angola: "AO",
  benin: "BJ",
  botswana: "BW",
  "burkina faso": "BF",
  burundi: "BI",
  cameroon: "CM",
  "cabo verde": "CV",
  "cape verde": "CV",
  "central african republic": "CF",
  chad: "TD",
  comoros: "KM",
  congo: "CG",
  "republic of the congo": "CG",
  "democratic republic of the congo": "CD",
  "dr congo": "CD",
  drc: "CD",
  "cote d'ivoire": "CI",
  "ivory coast": "CI",
  djibouti: "DJ",
  egypt: "EG",
  "equatorial guinea": "GQ",
  eritrea: "ER",
  eswatini: "SZ",
  swaziland: "SZ",
  ethiopia: "ET",
  gabon: "GA",
  gambia: "GM",
  "the gambia": "GM",
  ghana: "GH",
  guinea: "GN",
  "guinea-bissau": "GW",
  kenya: "KE",
  lesotho: "LS",
  liberia: "LR",
  libya: "LY",
  madagascar: "MG",
  malawi: "MW",
  mali: "ML",
  mauritania: "MR",
  mauritius: "MU",
  morocco: "MA",
  mozambique: "MZ",
  namibia: "NA",
  niger: "NE",
  nigeria: "NG",
  rwanda: "RW",
  senegal: "SN",
  "sierra leone": "SL",
  somalia: "SO",
  "south africa": "ZA",
  "south sudan": "SS",
  sudan: "SD",
  tanzania: "TZ",
  "united republic of tanzania": "TZ",
  togo: "TG",
  tunisia: "TN",
  uganda: "UG",
  zambia: "ZM",
  zimbabwe: "ZW",
  // Frequently searched outside Africa.
  bangladesh: "BD",
  haiti: "HT",
  india: "IN",
  nepal: "NP",
  pakistan: "PK",
};

function normalise(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, " ");
}

/** "Kenya" → "KE". Undefined when the name is unknown or missing. */
export function countryIso2(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const key = normalise(name);
  if (/^[a-z]{2}$/.test(key)) return key.toUpperCase();
  return ISO2_BY_NAME[key];
}

/** ISO alpha-3 for every country in ISO2_BY_NAME — WPdx keys countries this way. */
const ISO3_BY_ISO2: Record<string, string> = {
  DZ: "DZA", AO: "AGO", BJ: "BEN", BW: "BWA", BF: "BFA", BI: "BDI", CM: "CMR", CV: "CPV",
  CF: "CAF", TD: "TCD", KM: "COM", CG: "COG", CD: "COD", CI: "CIV", DJ: "DJI", EG: "EGY",
  GQ: "GNQ", ER: "ERI", SZ: "SWZ", ET: "ETH", GA: "GAB", GM: "GMB", GH: "GHA", GN: "GIN",
  GW: "GNB", KE: "KEN", LS: "LSO", LR: "LBR", LY: "LBY", MG: "MDG", MW: "MWI", ML: "MLI",
  MR: "MRT", MU: "MUS", MA: "MAR", MZ: "MOZ", NA: "NAM", NE: "NER", NG: "NGA", RW: "RWA",
  SN: "SEN", SL: "SLE", SO: "SOM", ZA: "ZAF", SS: "SSD", SD: "SDN", TZ: "TZA", TG: "TGO",
  TN: "TUN", UG: "UGA", ZM: "ZMB", ZW: "ZWE", BD: "BGD", HT: "HTI", IN: "IND", NP: "NPL",
  PK: "PAK",
};

/** "Uganda" / "UG" / "UGA" → "UGA". Undefined when unknown. */
export function countryIso3(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const key = normalise(name).toUpperCase();
  if (/^[A-Z]{3}$/.test(key) && Object.values(ISO3_BY_ISO2).includes(key)) return key;
  const iso2 = countryIso2(name);
  return iso2 ? ISO3_BY_ISO2[iso2] : undefined;
}
