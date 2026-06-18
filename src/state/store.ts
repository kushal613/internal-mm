import type { QuoteRequestEvent } from "../types.js";

/**
 * In-memory state for open quote requests and our submitted quotes.
 *
 * Keyed by requestId. `quoteId` (server-generated, stable across updates) is what
 * we need to confirm if we win. Phase 1 only populates `request`; quoting/confirm
 * fields are filled in later phases.
 */
export interface QuoteRecord {
  request: QuoteRequestEvent;
  receivedAt: number;
  quoteId?: string;
  quotedPrice?: number;
  quotedSize?: number;
}

export class QuoteStore {
  private readonly byRequest = new Map<string, QuoteRecord>();

  upsertRequest(req: QuoteRequestEvent): QuoteRecord {
    const existing = this.byRequest.get(req.requestId);
    const record: QuoteRecord = existing
      ? { ...existing, request: req }
      : { request: req, receivedAt: Date.now() };
    this.byRequest.set(req.requestId, record);
    return record;
  }

  setQuote(requestId: string, quoteId: string, price: number, size: number): void {
    const rec = this.byRequest.get(requestId);
    if (rec) {
      rec.quoteId = quoteId;
      rec.quotedPrice = price;
      rec.quotedSize = size;
    }
  }

  get(requestId: string): QuoteRecord | undefined {
    return this.byRequest.get(requestId);
  }

  /** Find the requestId we associated with a given server quoteId (for confirms). */
  findByQuoteId(quoteId: string): QuoteRecord | undefined {
    for (const rec of this.byRequest.values()) {
      if (rec.quoteId === quoteId) return rec;
    }
    return undefined;
  }

  remove(requestId: string): void {
    this.byRequest.delete(requestId);
  }

  get openCount(): number {
    return this.byRequest.size;
  }

  list(): QuoteRecord[] {
    return [...this.byRequest.values()];
  }
}
