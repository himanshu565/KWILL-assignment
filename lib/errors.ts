export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function errorBody(error: ApiError): {
  error: { code: string; message: string };
} {
  return { error: { code: error.code, message: error.message } };
}

export function jsonError(error: unknown, requestId: string): Response {
  if (error instanceof ApiError) {
    return Response.json(errorBody(error), {
      status: error.status,
      headers: { "x-request-id": requestId },
    });
  }
  console.error(
    JSON.stringify({
      level: "error",
      request_id: requestId,
      message: error instanceof Error ? error.message : "unknown_error",
    })
  );
  return Response.json(
    {
      error: {
        code: "INTERNAL",
        message: "Something went wrong processing this request.",
      },
    },
    { status: 500, headers: { "x-request-id": requestId } }
  );
}

export function jsonOk(body: unknown, requestId: string, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "x-request-id": requestId },
  });
}
