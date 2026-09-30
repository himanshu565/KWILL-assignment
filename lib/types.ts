export type HoldStatus = "active" | "expired" | "converted";
export type OrderStatus = "paid" | "refunded" | "partially_refunded";

export type EventRow = {
  id: string;
  title: string;
  venue: string;
  starts_at: Date;
};

export type TierInventoryRow = {
  id: string;
  name: string;
  price: number;
  currency: string;
  total_inventory: number;
  held: number;
  sold: number;
  available: number;
};

export type HoldRow = {
  id: string;
  tier_id: string;
  quantity: number;
  expires_at: Date;
  status: HoldStatus;
  converted_order_id: string | null;
};

export type OrderRow = {
  id: string;
  tier_id: string;
  quantity: number;
  status: OrderStatus;
  amount_total: number;
  amount_refunded: number;
  currency: string;
};

export type OrderPaidWebhook = {
  event_id: string;
  type: "order.paid";
  order_id: string;
  tier_id: string;
  quantity: number;
  amount_total: number;
  currency: string;
  occurred_at: string;
  hold_id?: string;
};

export type OrderRefundedWebhook = {
  event_id: string;
  type: "order.refunded";
  order_id: string;
  amount_refunded: number;
  currency: string;
  occurred_at: string;
};

export type PaymentWebhook = OrderPaidWebhook | OrderRefundedWebhook;
