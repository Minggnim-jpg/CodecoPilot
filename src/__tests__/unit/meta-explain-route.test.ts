/**
 * Unit tests for /api/meta-explain route validation and error branches.
 *
 * Run with: npx tsx --test src/__tests__/unit/meta-explain-route.test.ts
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { NextRequest } from 'next/server';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepilot-meta-route-test-'));
process.env.CLAUDE_GUI_DATA_DIR = tmpDir;

const originalEnv = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
};

delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
delete process.env.ANTHROPIC_BASE_URL;

/* eslint-disable @typescript-eslint/no-require-imports */
const { POST } = require('../../app/api/meta-explain/route') as typeof import('../../app/api/meta-explain/route');
const {
  closeDb,
  setSetting,
  getAllProviders,
  deleteProvider,
  createProvider,
  activateProvider,
  deactivateAllProviders,
} = require('../../lib/db') as typeof import('../../lib/db');

function toNextRequest(request: Request): NextRequest {
  return request as unknown as NextRequest;
}

function jsonRequest(body: unknown): NextRequest {
  return toNextRequest(new Request('http://localhost/api/meta-explain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

async function clearProviders(): Promise<void> {
  const providers = getAllProviders();
  for (const provider of providers) {
    deleteProvider(provider.id);
  }
}

describe('POST /api/meta-explain', () => {
  before(() => {
    closeDb();
  });

  beforeEach(async () => {
    deactivateAllProviders();
    await clearProviders();
    setSetting('anthropic_auth_token', '');
    setSetting('anthropic_base_url', '');
  });

  after(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });

    if (originalEnv.ANTHROPIC_API_KEY !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalEnv.ANTHROPIC_API_KEY;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
    if (originalEnv.ANTHROPIC_AUTH_TOKEN !== undefined) {
      process.env.ANTHROPIC_AUTH_TOKEN = originalEnv.ANTHROPIC_AUTH_TOKEN;
    } else {
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    }
    if (originalEnv.ANTHROPIC_BASE_URL !== undefined) {
      process.env.ANTHROPIC_BASE_URL = originalEnv.ANTHROPIC_BASE_URL;
    } else {
      delete process.env.ANTHROPIC_BASE_URL;
    }
  });

  it('returns 400 for invalid JSON body', async () => {
    const req = toNextRequest(new Request('http://localhost/api/meta-explain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"selectedText":',
    }));

    const res = await POST(req);
    const payload = await res.json() as { error?: string };

    assert.equal(res.status, 400);
    assert.equal(payload.error, 'Invalid JSON body');
  });

  it('returns 400 when selectedText is empty', async () => {
    const res = await POST(jsonRequest({
      selectedText: '   ',
      userQuestion: 'Explain this',
    }));
    const payload = await res.json() as { error?: string };

    assert.equal(res.status, 400);
    assert.equal(payload.error, 'selectedText is required');
  });

  it('returns 404 when sessionId does not exist', async () => {
    const res = await POST(jsonRequest({
      selectedText: 'const a = 1;',
      sessionId: 'missing-session-id',
    }));
    const payload = await res.json() as { error?: string };

    assert.equal(res.status, 404);
    assert.equal(payload.error, 'Session not found');
  });

  it('returns 400 when provider is not configured', async () => {
    const res = await POST(jsonRequest({
      selectedText: 'const count = useState(0);',
      userQuestion: 'Explain this',
    }));
    const payload = await res.json() as { error?: string };

    assert.equal(res.status, 400);
    assert.match(payload.error || '', /^PROVIDER_NOT_CONFIGURED:/);
  });

  it('returns 422 for unsupported active provider', async () => {
    const provider = createProvider({
      name: 'Bedrock Test',
      provider_type: 'bedrock',
      base_url: '',
      api_key: '',
      extra_env: '{}',
    });
    const activated = activateProvider(provider.id);
    assert.equal(activated, true);

    const res = await POST(jsonRequest({
      selectedText: 'function sum(a, b) { return a + b; }',
      userQuestion: 'Explain this function',
    }));
    const payload = await res.json() as { error?: string };

    assert.equal(res.status, 422);
    assert.match(payload.error || '', /^PROVIDER_UNSUPPORTED:/);
  });
});
