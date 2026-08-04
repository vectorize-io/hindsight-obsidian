import type { OperationResponse, RetainOptions, RetainResult } from "./types";

function encodeDocPath(documentId: string): string {
  return documentId.split("/").map(encodeURIComponent).join("/");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Node/fetch transport for the same retain semantics used by the Obsidian plugin. */
export class FetchHindsightClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;

  constructor(
    baseUrl: string,
    token?: string,
    private readonly operationPollIntervalMs = 2_000,
    private readonly operationTimeoutMs = 30 * 60_000,
    private readonly requestTimeoutMs = 30_000
  ) {
    const url = (baseUrl ?? "").trim();
    if (!url) throw new Error("Hindsight API URL is required");
    this.baseUrl = url.replace(/\/+$/, "");
    this.token = token?.trim() || undefined;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  private bankUrl(bankId: string, suffix: string): string {
    return `${this.baseUrl}/v1/default/banks/${encodeURIComponent(bankId)}${suffix}`;
  }

  private async send(method: string, url: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`Hindsight ${method} ${url} → HTTP ${response.status}: ${text.slice(0, 500)}`);
      }
      return text ? (JSON.parse(text) as unknown) : {};
    } finally {
      clearTimeout(timeout);
    }
  }

  async health(): Promise<boolean> {
    try {
      await this.send("GET", `${this.baseUrl}/health`);
      return true;
    } catch {
      return false;
    }
  }

  async retain(
    bankId: string,
    documentId: string,
    content: string,
    options: RetainOptions = {}
  ): Promise<RetainResult> {
    const item: Record<string, unknown> = {
      content,
      document_id: documentId,
      context: options.context ?? "obsidian",
      update_mode: options.updateMode ?? "replace",
    };
    if (options.tags?.length) item.tags = options.tags;
    if (options.metadata && Object.keys(options.metadata).length) item.metadata = options.metadata;
    if (options.timestamp) item.timestamp = options.timestamp;
    if (options.observationScopes?.length) item.observation_scopes = options.observationScopes;

    const response = (await this.send("POST", this.bankUrl(bankId, "/memories"), {
      items: [item],
      async: true,
    })) as { operation_id?: string };
    if (!response.operation_id) {
      throw new Error("Hindsight retain response did not include operation_id");
    }
    const operation = await this.waitForOperation(bankId, response.operation_id);
    return {
      operationId: response.operation_id,
      status: "completed",
      completedAt: operation.updated_at,
    };
  }

  async waitForOperation(bankId: string, operationId: string): Promise<OperationResponse> {
    const started = Date.now();
    while (Date.now() - started <= this.operationTimeoutMs) {
      const operation = (await this.send(
        "GET",
        this.bankUrl(bankId, `/operations/${encodeURIComponent(operationId)}`)
      )) as OperationResponse;
      if (operation.status === "completed") return operation;
      if (operation.status === "failed" || operation.status === "cancelled") {
        const detail = operation.error ? `: ${JSON.stringify(operation.error)}` : "";
        throw new Error(`Hindsight operation ${operationId} ${operation.status}${detail}`);
      }
      await sleep(this.operationPollIntervalMs);
    }
    throw new Error(
      `Hindsight operation ${operationId} did not complete within ${this.operationTimeoutMs}ms`
    );
  }

  async deleteDocument(bankId: string, documentId: string): Promise<void> {
    await this.send("DELETE", this.bankUrl(bankId, `/documents/${encodeDocPath(documentId)}`));
  }

  async listDocuments(bankId: string): Promise<Map<string, string[]>> {
    const documents = new Map<string, string[]>();
    let offset = 0;
    while (true) {
      const response = (await this.send(
        "GET",
        this.bankUrl(bankId, `/documents?limit=100&offset=${offset}`)
      )) as { items?: Array<{ id: string; tags?: string[] }>; total?: number };
      const items = response.items ?? [];
      for (const item of items) documents.set(item.id, item.tags ?? []);
      offset += items.length;
      if (items.length === 0 || offset >= (response.total ?? offset)) break;
    }
    return documents;
  }

  async getDocumentTags(bankId: string, documentId: string): Promise<string[]> {
    const response = (await this.send(
      "GET",
      this.bankUrl(bankId, `/documents/${encodeDocPath(documentId)}`)
    )) as { tags?: string[] };
    return response.tags ?? [];
  }

  async updateDocumentTags(bankId: string, documentId: string, tags: string[]): Promise<void> {
    await this.send("PATCH", this.bankUrl(bankId, `/documents/${encodeDocPath(documentId)}`), {
      tags,
    });
  }
}
