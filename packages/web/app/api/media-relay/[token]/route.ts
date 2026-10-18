// GET /api/media-relay/[token] — one-shot provider-facing stream, never persisted.

import type { NextRequest } from 'next/server';
import { takeMediaRelay } from '@web/lib/media-relay';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  // 32-byte hex tokens are unguessable and single-use; provider requests cannot carry user cookies.
  if (!/^[a-f0-9]{32}$/i.test(token)) return new Response('Not found', { status: 404 });
  const relay = takeMediaRelay(token);
  if (!relay) return new Response('Expired or already consumed', { status: 410 });
  return new Response(relay.stream, {
    headers: {
      'Content-Type': relay.contentType,
      'Cache-Control': 'no-store, private',
      'X-Content-Type-Options': 'nosniff',
      // nginx honours this response header for provider-facing GET streams.
      // Upload-side buffering is separately disabled by the production nginx snippet.
      'X-Accel-Buffering': 'no',
    },
  });
}
