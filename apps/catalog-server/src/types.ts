export interface Product {
  id: string;
  name: string;
  description: string;
  price: number;
  currency: string;
  category: string;
  stock: number;
  upsellWith: string[];
  rating: number;
  numReviews: number;
  specs: Record<string, string | number | boolean>;
}

export interface Merchant {
  id: string;
  name: string;
  currency: string;
}

export interface Catalog {
  merchant: Merchant;
  products: Product[];
}

export interface CheckoutItem {
  productId: string;
  quantity: number;
}

export interface CheckoutRequestBody {
  actor: string;
  items: CheckoutItem[];
}

export interface UpsellSuggestion {
  product: Product;
  reason: string;
  priceDisplay: string;
}

export type CheckoutResult =
  | { status: "declined"; reasons: string[]; suggestion?: Product }
  | {
      status: "pending_approval";
      approvalId: string;
      reasons: string[];
      amount: number;
      amountDisplay: string;
      currency: string;
    }
  | {
      status: "captured";
      orderId: string;
      paymentId: string;
      amount: number;
      amountDisplay: string;
      currency: string;
      simulated: boolean;
      upsell: UpsellSuggestion[];
    }
  | {
      /** A real payment link was issued; nothing is captured until a human pays it. */
      status: "pending_payment";
      orderId: string;
      paymentLinkId: string;
      paymentUrl: string;
      amount: number;
      amountDisplay: string;
      currency: string;
      reasons: string[];
    }
  | { status: "payment_failed"; orderId: string; reasons: string[] };
