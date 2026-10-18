// One-shot in-memory media relay used while a provider fetches a client upload stream.
// The relay never buffers or persists media: producer and consumer are connected by backpressure.

export interface MediaRelayEntry {
  stream: ReadableStream<Uint8Array>;
  contentType: string;
  expiresAt: number;
}

type RelayGlobal = typeof globalThis & {
  __dramaforgeMediaRelays?: Map<string, MediaRelayEntry>;
};

const RELAY_TTL_MS = 2 * 60 * 1000;

function relayMap(): Map<string, MediaRelayEntry> {
  const globalState = globalThis as RelayGlobal;
  if (!globalState.__dramaforgeMediaRelays) globalState.__dramaforgeMediaRelays = new Map();
  return globalState.__dramaforgeMediaRelays;
}

/** Wrap a stream with a hard byte limit while preserving streaming backpressure. */
function limitStream(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let received = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await reader.read();
      if (chunk.done) {
        controller.close();
        return;
      }
      received += chunk.value.byteLength;
      if (received > maxBytes) {
        await reader.cancel('media relay size limit exceeded').catch(() => undefined);
        controller.error(new Error(`媒体流超过 ${maxBytes} 字节限制`));
        return;
      }
      controller.enqueue(chunk.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** Register a single-consumer stream and return an unguessable token. */
export function registerMediaRelay(input: {
  stream: ReadableStream<Uint8Array>;
  contentType: string;
  maxBytes: number;
}): string {
  const map = relayMap();
  const now = Date.now();
  // Opportunistic cleanup keeps abandoned requests bounded without a timer.
  for (const [token, entry] of map) {
    if (entry.expiresAt <= now) map.delete(token);
  }
  const token = crypto.randomUUID().replace(/-/g, '');
  map.set(token, {
    stream: limitStream(input.stream, input.maxBytes),
    contentType: input.contentType,
    expiresAt: now + RELAY_TTL_MS,
  });
  return token;
}

/** Claim and delete a relay entry so a token can never replay the client stream. */
export function takeMediaRelay(token: string): MediaRelayEntry | null {
  const map = relayMap();
  const entry = map.get(token);
  map.delete(token);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry;
}

/** Remove an unclaimed relay after provider failure or request cancellation. */
export function releaseMediaRelay(token: string): void {
  relayMap().delete(token);
}
