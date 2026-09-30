const base = process.env.API_BASE_URL ?? "http://localhost:3000";

type HoldResponse = { hold_id?: string; error?: { code: string } };

async function createHold(): Promise<{ status: number; body: HoldResponse }> {
  const response = await fetch(`${base}/events/evt_002/holds`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tier_id: "tier_002_b", quantity: 1 }),
  });
  const body = (await response.json()) as HoldResponse;
  return { status: response.status, body };
}

async function drainToLastTicket(): Promise<void> {
  const eventRes = await fetch(`${base}/events/evt_002`);
  const event = (await eventRes.json()) as {
    tiers: Array<{ id: string; available: number }>;
  };
  const student = event.tiers.find((tier) => tier.id === "tier_002_b");
  if (!student) {
    throw new Error("Student tier missing — seed the Berlin meetup first.");
  }
  const extra = student.available - 1;
  for (let i = 0; i < extra; i += 1) {
    const held = await createHold();
    if (held.status !== 201) {
      throw new Error(`Could not drain Student inventory: ${JSON.stringify(held.body)}`);
    }
  }
}

async function main(): Promise<void> {
  await drainToLastTicket();
  const [first, second] = await Promise.all([createHold(), createHold()]);
  console.log("concurrent A", first.status, first.body);
  console.log("concurrent B", second.status, second.body);
  const statuses = [first.status, second.status].sort();
  if (!(statuses[0] === 201 && statuses[1] === 409)) {
    throw new Error("Scenario C failed: expected one 201 and one 409 OVERSOLD.");
  }
  console.log("Scenario C passed: one Student ticket, one OVERSOLD.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
