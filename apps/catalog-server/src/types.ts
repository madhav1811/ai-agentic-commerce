export interface Product {
  id: string;
  name: string;
  description: string;
  price: number;
  currency: string;
  category: string;
  stock: number;
  upsellWith: string[];
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

export type CheckoutResult =
  | { status: "declined"; reasons: string[]; suggestion?: Product }
  | { status: "pending_approval"; approvalId: string; reasons: string[]; amount: number; currency: string }
  | {
      status: "captured";
      orderId: string;
      paymentId: string;
      amount: number;
      currency: string;
      simulated: boolean;
    }
  | { status: "payment_failed"; orderId: string; reasons: string[] };
