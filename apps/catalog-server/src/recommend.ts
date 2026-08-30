import type { Product } from "./types.js";

export interface RecommendCriteria {
  category?: string;
  maxPrice?: number;
  mustHave?: string[];
  excludeIds?: string[];
}

export interface RankedProduct {
  product: Product;
  score: number;
  reasons: string[];
}

/**
 * Small models are unreliable at paise→rupee arithmetic, so the reasons text
 * carries a pre-formatted rupee string — the agent only has to quote it, not compute it.
 */
export function formatInr(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function textMatches(product: Product, keyword: string): boolean {
  const haystack = [product.name, product.description, ...Object.entries(product.specs).map(([k, v]) => `${k} ${v}`)]
    .join(" ")
    .toLowerCase();
  return haystack.includes(keyword.toLowerCase());
}

/**
 * Deterministic, explainable ranking — never delegated to the LLM. Score is a
 * transparent weighted sum (rating 60%, budget fit 30%, requested-feature
 * match up to +20%) so every recommendation can be justified with the exact
 * numbers behind it, not a language model's impression of the description.
 */
export function rankProducts(products: Product[], criteria: RecommendCriteria): RankedProduct[] {
  const candidates = products.filter((p) => {
    if (p.stock <= 0) return false;
    if (criteria.excludeIds?.includes(p.id)) return false;
    if (criteria.category && p.category !== criteria.category) return false;
    if (criteria.maxPrice && p.price > criteria.maxPrice) return false;
    return true;
  });

  return candidates
    .map((product) => {
      const ratingWeight = 0.6;
      const priceWeight = 0.3;
      const ratingScore = (product.rating / 5) * ratingWeight;
      const priceScore = criteria.maxPrice
        ? Math.max(0, Math.min(1, (criteria.maxPrice - product.price) / criteria.maxPrice)) * priceWeight
        : 0.5 * priceWeight;

      const matched = (criteria.mustHave ?? []).filter((kw) => textMatches(product, kw));
      const matchBonus = Math.min(0.2, matched.length * 0.1);

      const score = Number((ratingScore + priceScore + matchBonus).toFixed(4));

      const reasons = [
        `rating ${product.rating}/5 from ${product.numReviews} reviews contributes ${ratingScore.toFixed(2)} of the score`,
        criteria.maxPrice
          ? `priced ${formatInr(product.price)} against a ${formatInr(criteria.maxPrice)} budget contributes ${priceScore.toFixed(2)} of the score`
          : `no budget ceiling given, price weighted neutrally (${priceScore.toFixed(2)})`,
      ];
      if (matched.length) {
        reasons.push(`matches requested feature(s) [${matched.join(", ")}] for +${matchBonus.toFixed(2)}`);
      }

      return { product, score, reasons };
    })
    .sort((a, b) => b.score - a.score);
}
