const BASE_URL = process.env.CATALOG_SERVER_URL ?? "http://localhost:4000";

export async function listProducts() {
  const res = await fetch(`${BASE_URL}/catalog`);
  if (!res.ok) throw new Error(`GET /catalog failed: ${res.status}`);
  return res.json();
}

export async function recommendProducts(criteria: {
  category?: string;
  maxPrice?: number;
  mustHave?: string[];
  excludeIds?: string[];
}) {
  const res = await fetch(`${BASE_URL}/recommend`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(criteria),
  });
  return res.json();
}

export async function requestCheckout(actor: string, items: { productId: string; quantity: number }[]) {
  const res = await fetch(`${BASE_URL}/checkout`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actor, items }),
  });
  return res.json();
}

/**
 * Only the operator flow (never the LLM) holds this token — the buyer agent
 * has no tool that can call these endpoints, so it cannot approve its own
 * gated checkout no matter what it decides to output.
 */
export async function operatorApprove(approvalId: string, approvedBy: string) {
  const res = await fetch(`${BASE_URL}/checkout/${approvalId}/approve`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-approval-token": process.env.APPROVAL_TOKEN ?? "demo-approver-token",
    },
    body: JSON.stringify({ approvedBy }),
  });
  return res.json();
}

export async function operatorDeny(approvalId: string, deniedBy: string, reason: string) {
  const res = await fetch(`${BASE_URL}/checkout/${approvalId}/deny`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-approval-token": process.env.APPROVAL_TOKEN ?? "demo-approver-token",
    },
    body: JSON.stringify({ deniedBy, reason }),
  });
  return res.json();
}

export async function fetchAuditLog() {
  const res = await fetch(`${BASE_URL}/audit-log`);
  return res.json();
}

export async function verifyAuditChain() {
  const res = await fetch(`${BASE_URL}/audit-log/verify`);
  return res.json();
}
