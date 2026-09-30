import { randomUUID } from "node:crypto";

export function requestIdFrom(request: Request): string {
  const incoming = request.headers.get("x-request-id");
  if (incoming && incoming.trim().length > 0) {
    return incoming.trim();
  }
  return randomUUID();
}

export function logEvent(
  requestId: string,
  fields: Record<string, string | number | boolean | null>
): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      request_id: requestId,
      ...fields,
    })
  );
}
