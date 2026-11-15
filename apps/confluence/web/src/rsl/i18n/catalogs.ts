/** All 18 catalogs in rsL order. en = source (APPROVED), ar = tier 1, the rest DRAFT until reviewed. */
import en from "./en.json";
import ar from "./ar.json";
import ja from "./ja.json";
import fil from "./fil.json";
import bn from "./bn.json";
import ur from "./ur.json";
import ru from "./ru.json";
import hi from "./hi.json";
import zh from "./zh.json";
import ko from "./ko.json";
import id from "./id.json";
import ms from "./ms.json";
import tr from "./tr.json";
import fr from "./fr.json";
import de from "./de.json";
import es from "./es.json";
import pt from "./pt.json";
import it from "./it.json";

type Catalog = Record<string, string>;
const asCatalog = (c: Record<string, unknown>): Catalog =>
  Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v === null ? "" : String(v)]));

/** Final review I-1: tier-1 keys whose text is a machine draft awaiting native-speaker review (About shows the count). */
export const PENDING_REVIEW: Record<string, readonly string[]> = Object.fromEntries(
  Object.entries({ en, ar }).map(([k, v]) => {
    const list = (v as Record<string, unknown>)["@pendingReview"];
    return [k, Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []];
  }),
);

export const CATALOGS: Record<string, Catalog> = Object.fromEntries(
  Object.entries({ en, ar, ja, fil, bn, ur, ru, hi, zh, ko, id, ms, tr, fr, de, es, pt, it }).map(([k, v]) => [k, asCatalog(v)]),
);
