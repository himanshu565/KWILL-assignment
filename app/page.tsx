"use client";

import { useEffect, useState } from "react";

type Tier = {
  id: string;
  name: string;
  price: number;
  currency: string;
  total_inventory: number;
  available: number;
  held: number;
  sold: number;
};

type EventData = {
  id: string;
  title: string;
  venue: string;
  starts_at: string;
  tiers: Tier[];
};

type LogEntry = {
  id: string;
  timestamp: string;
  title: string;
  status: "success" | "error" | "info";
  details: unknown;
};

export default function Home() {
  const [events, setEvents] = useState<EventData[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const addLog = (title: string, status: "success" | "error" | "info", details: unknown) => {
    setLogs((prev) => [
      {
        id: Math.random().toString(36).substring(2, 9),
        timestamp: new Date().toLocaleTimeString(),
        title,
        status,
        details,
      },
      ...prev.slice(0, 19),
    ]);
  };

  const fetchEvents = async () => {
    try {
      const [res1, res2] = await Promise.all([
        fetch("/events/evt_001"),
        fetch("/events/evt_002"),
      ]);
      const data1 = (await res1.json()) as EventData;
      const data2 = (await res2.json()) as EventData;
      setEvents([data1, data2]);
    } catch (err) {
      console.error("Failed to fetch events", err);
    }
  };

  useEffect(() => {
    let ignore = false;
    const load = async () => {
      try {
        const [res1, res2] = await Promise.all([
          fetch("/events/evt_001"),
          fetch("/events/evt_002"),
        ]);
        const data1 = (await res1.json()) as EventData;
        const data2 = (await res2.json()) as EventData;
        if (!ignore) {
          setEvents([data1, data2]);
        }
      } catch (err) {
        console.error("Failed to fetch events", err);
      }
    };
    void load();
    const interval = setInterval(load, 3000);
    return () => {
      ignore = true;
      clearInterval(interval);
    };
  }, []);

  const runScenarioA = async () => {
    setLoading(true);
    addLog("Scenario A started", "info", "Creating hold for 2 tickets on General Standing (evt_001)...");
    try {
      const holdRes = await fetch("/events/evt_001/holds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier_id: "tier_001_b", quantity: 2 }),
      });
      const holdData = await holdRes.json();
      if (!holdRes.ok) throw new Error(JSON.stringify(holdData));
      addLog("Scenario A: Hold Created", "success", holdData);

      const orderId = `ord_ui_${Date.now()}`;
      const webhookRes = await fetch("/webhooks/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_id: `evt_wh_ui_${Date.now()}`,
          type: "order.paid",
          order_id: orderId,
          tier_id: "tier_001_b",
          quantity: 2,
          amount_total: 9000,
          currency: "EUR",
          occurred_at: new Date().toISOString(),
          hold_id: holdData.hold_id,
        }),
      });
      const webhookData = await webhookRes.json();
      addLog("Scenario A: Webhook order.paid Processed", "success", webhookData);
      await fetchEvents();
    } catch (err) {
      addLog("Scenario A Failed", "error", String(err));
    } finally {
      setLoading(false);
    }
  };

  const runScenarioB = async () => {
    setLoading(true);
    const orderId = `ord_dup_${Date.now()}`;
    const eventId = `evt_wh_dup_${Date.now()}`;
    const payload = {
      event_id: eventId,
      type: "order.paid",
      order_id: orderId,
      tier_id: "tier_001_c",
      quantity: 1,
      amount_total: 3000,
      currency: "EUR",
      occurred_at: new Date().toISOString(),
    };

    try {
      addLog("Scenario B: 1st Webhook Delivery", "info", payload);
      const res1 = await fetch("/webhooks/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data1 = await res1.json();
      addLog("Scenario B: 1st Delivery Result", "success", data1);

      addLog("Scenario B: Sending DUPLICATE Webhook...", "info", payload);
      const res2 = await fetch("/webhooks/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data2 = await res2.json();
      addLog("Scenario B: 2nd Delivery (Idempotent ACK)", data2.duplicate ? "success" : "error", data2);
      await fetchEvents();
    } catch (err) {
      addLog("Scenario B Failed", "error", String(err));
    } finally {
      setLoading(false);
    }
  };

  const runScenarioC = async () => {
    setLoading(true);
    addLog("Scenario C: Concurrency Battle", "info", "Firing 2 concurrent requests for Student tier...");
    try {
      const [resA, resB] = await Promise.all([
        fetch("/events/evt_002/holds", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tier_id: "tier_002_b", quantity: 1 }),
        }),
        fetch("/events/evt_002/holds", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tier_id: "tier_002_b", quantity: 1 }),
        }),
      ]);
      const dataA = await resA.json();
      const dataB = await resB.json();

      addLog(`Request A: HTTP ${resA.status}`, resA.ok ? "success" : "error", dataA);
      addLog(`Request B: HTTP ${resB.status}`, resB.ok ? "success" : "error", dataB);
      await fetchEvents();
    } catch (err) {
      addLog("Scenario C Failed", "error", String(err));
    } finally {
      setLoading(false);
    }
  };

  const runOutOfOrder = async () => {
    setLoading(true);
    const orderId = `ord_ooo_${Date.now()}`;
    const refundEventId = `evt_wh_ref_${Date.now()}`;
    const paidEventId = `evt_wh_paid_${Date.now()}`;

    try {
      addLog("Out-of-Order: Step 1 - Sending order.refunded FIRST", "info", { order_id: orderId });
      const refRes = await fetch("/webhooks/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_id: refundEventId,
          type: "order.refunded",
          order_id: orderId,
          amount_refunded: 8500,
          currency: "EUR",
          occurred_at: new Date().toISOString(),
        }),
      });
      const refData = await refRes.json();
      addLog("Refund result (deferred)", "success", refData);

      addLog("Out-of-Order: Step 2 - Sending delayed order.paid SECOND", "info", { order_id: orderId });
      const paidRes = await fetch("/webhooks/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_id: paidEventId,
          type: "order.paid",
          order_id: orderId,
          tier_id: "tier_001_a",
          quantity: 1,
          amount_total: 8500,
          currency: "EUR",
          occurred_at: new Date().toISOString(),
        }),
      });
      const paidData = await paidRes.json();
      addLog("Paid result (automatically reconciled as refunded)", "success", paidData);
      await fetchEvents();
    } catch (err) {
      addLog("Out-of-order failed", "error", String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "32px 20px", fontFamily: "system-ui, sans-serif", color: "#e2e8f0", backgroundColor: "#0f172a", minHeight: "100vh" }}>
      <header style={{ marginBottom: 32, borderBottom: "1px solid #334155", paddingBottom: 20, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: "1.75rem", fontWeight: 700, color: "#f8fafc" }}>Encore Tickets — Inventory Control Plane</h1>
          <p style={{ margin: "6px 0 0", color: "#94a3b8", fontSize: "0.95rem" }}>
            Real-time ticket inventory with safe checkout holds, row-level pessimistic locking, and idempotent webhooks.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <span style={{ padding: "4px 10px", borderRadius: 999, background: "#1e293b", color: "#38bdf8", fontSize: "0.8rem", border: "1px solid #38bdf844" }}>
            PostgreSQL 17 (Locked)
          </span>
          <span style={{ padding: "4px 10px", borderRadius: 999, background: "#1e293b", color: "#4ade80", fontSize: "0.8rem", border: "1px solid #4ade8044" }}>
            Active TTL: 10m
          </span>
        </div>
      </header>

      {/* Control Actions Bar */}
      <section style={{ background: "#1e293b", padding: 20, borderRadius: 12, marginBottom: 28, border: "1px solid #334155" }}>
        <h2 style={{ fontSize: "1.05rem", margin: "0 0 14px", color: "#f1f5f9" }}>Interactive Scenario Verification (1-Click Demo)</h2>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          <button
            onClick={runScenarioA}
            disabled={loading}
            style={{ background: "#2563eb", color: "#fff", border: "none", padding: "10px 16px", borderRadius: 8, cursor: "pointer", fontWeight: 600, fontSize: "0.9rem" }}
          >
            🚀 Run Scenario A (Happy Path)
          </button>
          <button
            onClick={runScenarioB}
            disabled={loading}
            style={{ background: "#0891b2", color: "#fff", border: "none", padding: "10px 16px", borderRadius: 8, cursor: "pointer", fontWeight: 600, fontSize: "0.9rem" }}
          >
            🔄 Run Scenario B (Idempotency)
          </button>
          <button
            onClick={runScenarioC}
            disabled={loading}
            style={{ background: "#d97706", color: "#fff", border: "none", padding: "10px 16px", borderRadius: 8, cursor: "pointer", fontWeight: 600, fontSize: "0.9rem" }}
          >
            ⚔️ Run Scenario C (Concurrency Race)
          </button>
          <button
            onClick={runOutOfOrder}
            disabled={loading}
            style={{ background: "#9333ea", color: "#fff", border: "none", padding: "10px 16px", borderRadius: 8, cursor: "pointer", fontWeight: 600, fontSize: "0.9rem" }}
          >
            🔀 Out-of-Order Webhook (Refund Before Paid)
          </button>
          <button
            onClick={fetchEvents}
            style={{ background: "#475569", color: "#fff", border: "none", padding: "10px 16px", borderRadius: 8, cursor: "pointer", fontWeight: 600, fontSize: "0.9rem" }}
          >
            ↻ Refresh Inventory
          </button>
        </div>
      </section>

      {/* Events & Live Inventory Grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(480px, 1fr))", gap: 24, marginBottom: 32 }}>
        {events.map((ev) => (
          <div key={ev.id} style={{ background: "#1e293b", padding: 22, borderRadius: 12, border: "1px solid #334155" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
              <h3 style={{ margin: 0, fontSize: "1.15rem", color: "#f8fafc" }}>{ev.title}</h3>
              <span style={{ fontSize: "0.8rem", color: "#94a3b8" }}>{ev.id}</span>
            </div>
            <p style={{ margin: "0 0 16px", fontSize: "0.85rem", color: "#94a3b8" }}>📍 {ev.venue}</p>

            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #334155", color: "#94a3b8", textAlign: "left" }}>
                  <th style={{ padding: "8px 4px" }}>Tier</th>
                  <th style={{ padding: "8px 4px" }}>Price</th>
                  <th style={{ padding: "8px 4px", textAlign: "right" }}>Total</th>
                  <th style={{ padding: "8px 4px", textAlign: "right" }}>Held</th>
                  <th style={{ padding: "8px 4px", textAlign: "right" }}>Sold</th>
                  <th style={{ padding: "8px 4px", textAlign: "right", color: "#38bdf8" }}>Available</th>
                </tr>
              </thead>
              <tbody>
                {ev.tiers.map((t) => (
                  <tr key={t.id} style={{ borderBottom: "1px solid #1e293b88" }}>
                    <td style={{ padding: "10px 4px", fontWeight: 500 }}>{t.name}</td>
                    <td style={{ padding: "10px 4px", color: "#94a3b8" }}>{(t.price / 100).toFixed(2)} {t.currency}</td>
                    <td style={{ padding: "10px 4px", textAlign: "right", color: "#cbd5e1" }}>{t.total_inventory}</td>
                    <td style={{ padding: "10px 4px", textAlign: "right", color: t.held > 0 ? "#fbbf24" : "#64748b" }}>{t.held}</td>
                    <td style={{ padding: "10px 4px", textAlign: "right", color: t.sold > 0 ? "#4ade80" : "#64748b" }}>{t.sold}</td>
                    <td style={{ padding: "10px 4px", textAlign: "right", fontWeight: 700, color: t.available > 0 ? "#38bdf8" : "#ef4444" }}>
                      {t.available}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>

      {/* Live Event & Audit Log Console */}
      <section style={{ background: "#0b1120", padding: 20, borderRadius: 12, border: "1px solid #1e293b" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ fontSize: "1rem", margin: 0, color: "#cbd5e1" }}>Live API Execution & Webhook Audit Stream</h2>
          <span style={{ fontSize: "0.8rem", color: "#64748b" }}>Showing recent interactions</span>
        </div>
        {logs.length === 0 ? (
          <p style={{ color: "#64748b", margin: 0, fontSize: "0.85rem", fontStyle: "italic" }}>
            Click any scenario button above to trigger live API actions and watch the real-time state machine in action.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 380, overflowY: "auto" }}>
            {logs.map((log) => (
              <div
                key={log.id}
                style={{
                  padding: "10px 14px",
                  borderRadius: 8,
                  fontSize: "0.825rem",
                  background: log.status === "error" ? "#450a0a" : log.status === "success" ? "#064e3b" : "#1e293b",
                  borderLeft: `4px solid ${log.status === "error" ? "#ef4444" : log.status === "success" ? "#10b981" : "#3b82f6"}`,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <strong style={{ color: "#f8fafc" }}>{log.title}</strong>
                  <span style={{ color: "#94a3b8", fontSize: "0.75rem" }}>{log.timestamp}</span>
                </div>
                <pre style={{ margin: 0, fontSize: "0.75rem", color: "#cbd5e1", overflowX: "auto" }}>
                  {typeof log.details === "string" ? log.details : JSON.stringify(log.details, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
