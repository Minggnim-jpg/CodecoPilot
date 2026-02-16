import { NextRequest } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { getActiveProvider, getSession, getSetting } from '@/lib/db';
import { isRootPath } from '@/lib/files';
import type { MetaExplainRequest, SSEEvent, TokenUsage } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_SELECTED_TEXT = 8_000;
const MAX_QUESTION = 1_000;
const MAX_CONTEXT_LINES = 4_000;
const UPSTREAM_TIMEOUT_MS = 60_000;
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const IGNORED_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage']);

interface ProviderConfig {
  apiKey: string;
  baseUrl: string;
  includeBearer: boolean;
}

function formatSSE(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function makeJsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function safeTrim(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function limitText(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function resolveModelName(modelValue: string | undefined): string {
  const raw = (modelValue || 'sonnet').trim();
  const mapping: Record<string, string> = {
    sonnet: 'claude-sonnet-4-5',
    opus: 'claude-opus-4-6',
    haiku: 'claude-haiku-4-5',
  };
  return mapping[raw] || raw;
}

function buildMessagesUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  if (normalized.endsWith('/v1/messages')) return normalized;
  if (normalized.endsWith('/v1')) return `${normalized}/messages`;
  return `${normalized}/v1/messages`;
}

function parseExtraEnv(extraEnv: string): Record<string, string> {
  try {
    const parsed = JSON.parse(extraEnv || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const output: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') {
        output[key] = value;
      }
    }
    return output;
  } catch {
    return {};
  }
}

function getProviderConfig(): ProviderConfig | { error: string; status: number } {
  const activeProvider = getActiveProvider();
  const fallbackBase = safeTrim(getSetting('anthropic_base_url')) || safeTrim(process.env.ANTHROPIC_BASE_URL) || DEFAULT_BASE_URL;
  const fallbackToken = safeTrim(getSetting('anthropic_auth_token')) || safeTrim(process.env.ANTHROPIC_AUTH_TOKEN) || safeTrim(process.env.ANTHROPIC_API_KEY);

  if (!activeProvider) {
    if (!fallbackToken) {
      return {
        error: 'PROVIDER_NOT_CONFIGURED: Please configure API Provider in Settings.',
        status: 400,
      };
    }
    return {
      apiKey: fallbackToken,
      baseUrl: fallbackBase,
      includeBearer: true,
    };
  }

  if (activeProvider.provider_type === 'bedrock' || activeProvider.provider_type === 'vertex') {
    return {
      error: `PROVIDER_UNSUPPORTED: Active provider "${activeProvider.provider_type}" is not supported in Meta Channel V1.`,
      status: 422,
    };
  }

  const extraEnv = parseExtraEnv(activeProvider.extra_env || '{}');
  const providerBase = safeTrim(activeProvider.base_url) || safeTrim(extraEnv.ANTHROPIC_BASE_URL) || fallbackBase;
  const providerKey = safeTrim(activeProvider.api_key) || safeTrim(extraEnv.ANTHROPIC_AUTH_TOKEN) || safeTrim(extraEnv.ANTHROPIC_API_KEY) || fallbackToken;

  if (!providerKey) {
    return {
      error: 'PROVIDER_NOT_CONFIGURED: Active provider has no API key.',
      status: 400,
    };
  }

  const includeBearer = activeProvider.provider_type !== 'anthropic'
    || extraEnv.ANTHROPIC_API_KEY === ''
    || Boolean(safeTrim(extraEnv.ANTHROPIC_AUTH_TOKEN));

  return {
    apiKey: providerKey,
    baseUrl: providerBase || DEFAULT_BASE_URL,
    includeBearer,
  };
}

async function resolveWorkingDirectory(requestBody: MetaExplainRequest): Promise<string | undefined> {
  if (requestBody.sessionId) {
    const session = getSession(requestBody.sessionId);
    if (!session) {
      throw new Error('SESSION_NOT_FOUND');
    }
    if (session.working_directory) {
      return path.resolve(session.working_directory);
    }
  }

  if (requestBody.workingDirectory) {
    return path.resolve(requestBody.workingDirectory);
  }

  return undefined;
}

function inferTechStackFromPackageJson(pkg: Record<string, unknown>): string[] {
  const deps = {
    ...(typeof pkg.dependencies === 'object' && pkg.dependencies ? pkg.dependencies as Record<string, unknown> : {}),
    ...(typeof pkg.devDependencies === 'object' && pkg.devDependencies ? pkg.devDependencies as Record<string, unknown> : {}),
  };
  const names = Object.keys(deps);
  const detected: string[] = [];
  if (names.some((name) => name === 'next')) detected.push('Next.js');
  if (names.some((name) => name === 'react')) detected.push('React');
  if (names.some((name) => name === 'typescript')) detected.push('TypeScript');
  if (names.some((name) => name === 'vue')) detected.push('Vue');
  if (names.some((name) => name === 'svelte')) detected.push('Svelte');
  if (names.some((name) => name === 'express')) detected.push('Express');
  if (names.some((name) => name === 'nestjs')) detected.push('NestJS');
  if (names.some((name) => name === 'fastify')) detected.push('Fastify');
  return detected;
}

async function collectProjectMetadata(workingDirectory?: string): Promise<{
  projectPath?: string;
  packageName?: string;
  techStack?: string[];
  topLevelEntries?: string[];
  dependencyHints?: string[];
}> {
  if (!workingDirectory) return {};

  const resolved = path.resolve(workingDirectory);
  if (isRootPath(resolved)) {
    throw new Error('ROOT_WORKDIR_NOT_ALLOWED');
  }
  await fs.access(resolved);

  const packageJsonPath = path.join(resolved, 'package.json');
  let packageName: string | undefined;
  let techStack: string[] | undefined;
  let dependencyHints: string[] | undefined;

  try {
    const raw = await fs.readFile(packageJsonPath, 'utf-8');
    if (raw.length <= 500_000) {
      const pkg = JSON.parse(raw) as Record<string, unknown>;
      if (typeof pkg.name === 'string') {
        packageName = pkg.name;
      }
      const stack = inferTechStackFromPackageJson(pkg);
      if (stack.length > 0) {
        techStack = stack;
      }
      const deps = {
        ...(typeof pkg.dependencies === 'object' && pkg.dependencies ? pkg.dependencies as Record<string, unknown> : {}),
        ...(typeof pkg.devDependencies === 'object' && pkg.devDependencies ? pkg.devDependencies as Record<string, unknown> : {}),
      };
      const depNames = Object.keys(deps).sort().slice(0, 20);
      if (depNames.length > 0) {
        dependencyHints = depNames;
      }
    }
  } catch {
    // package.json missing or unreadable: ignore
  }

  let topLevelEntries: string[] | undefined;
  try {
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    topLevelEntries = entries
      .filter((entry) => !entry.name.startsWith('.') && !IGNORED_DIRS.has(entry.name))
      .slice(0, 40)
      .map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.name);
  } catch {
    // best effort
  }

  return {
    projectPath: resolved,
    packageName,
    techStack,
    topLevelEntries,
    dependencyHints,
  };
}

function buildPrompt(params: {
  selectedText: string;
  userQuestion: string;
  languageHint?: string;
  contextLines?: string;
  metadata: Awaited<ReturnType<typeof collectProjectMetadata>>;
}): { system: string; user: string } {
  const { selectedText, userQuestion, languageHint, contextLines, metadata } = params;
  const languageLabel = safeTrim(languageHint);
  const selectionFence = languageLabel || 'text';

  const contextParts: string[] = [];
  if (metadata.projectPath) contextParts.push(`- Project Path: ${metadata.projectPath}`);
  if (metadata.packageName) contextParts.push(`- Package: ${metadata.packageName}`);
  if (metadata.techStack?.length) contextParts.push(`- Tech Stack: ${metadata.techStack.join(', ')}`);
  if (metadata.topLevelEntries?.length) contextParts.push(`- Top-level Entries: ${metadata.topLevelEntries.join(', ')}`);
  if (metadata.dependencyHints?.length) contextParts.push(`- Dependency Hints: ${metadata.dependencyHints.join(', ')}`);
  if (contextLines) contextParts.push(`- Nearby Context:\n${contextLines}`);

  const contextBlock = contextParts.length > 0 ? contextParts.join('\n') : '- No project context available';
  const user = [
    'Context:',
    contextBlock,
    '',
    'User Selection:',
    `\`\`\`${selectionFence}`,
    selectedText,
    '```',
    '',
    `User Question: ${userQuestion}`,
    '',
    'Response Guidelines:',
    '- Be concise and practical.',
    '- Focus on why/how.',
    '- If context is missing, state assumptions clearly.',
  ].join('\n');

  const system = [
    'You are an expert code explainer embedded in a coding tool.',
    'Answer in concise, practical language.',
    'Do not use tools. You only explain and suggest fixes.',
  ].join(' ');

  return { system, user };
}

function normalizeUsage(usage: unknown): TokenUsage | null {
  if (!usage || typeof usage !== 'object') return null;
  const obj = usage as Record<string, unknown>;
  const input = typeof obj.input_tokens === 'number' ? obj.input_tokens : 0;
  const output = typeof obj.output_tokens === 'number' ? obj.output_tokens : 0;
  const cacheRead = typeof obj.cache_read_input_tokens === 'number' ? obj.cache_read_input_tokens : 0;
  const cacheCreate = typeof obj.cache_creation_input_tokens === 'number' ? obj.cache_creation_input_tokens : 0;

  if (input === 0 && output === 0 && cacheRead === 0 && cacheCreate === 0) {
    return null;
  }

  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreate,
  };
}

function handleUpstreamPayload(
  payload: Record<string, unknown>,
  emit: (event: SSEEvent) => void,
  usageRef: { current: TokenUsage | null },
): void {
  if (typeof payload.type === 'string') {
    switch (payload.type) {
      case 'message_start': {
        const message = payload.message as Record<string, unknown> | undefined;
        const model = message && typeof message.model === 'string' ? message.model : 'claude';
        emit({ type: 'status', data: `Connected (${model})` });
        if (message?.usage) {
          usageRef.current = normalizeUsage(message.usage) || usageRef.current;
        }
        return;
      }
      case 'content_block_delta': {
        const delta = payload.delta as Record<string, unknown> | undefined;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          emit({ type: 'text', data: delta.text });
        }
        return;
      }
      case 'message_delta': {
        if (payload.usage) {
          usageRef.current = normalizeUsage(payload.usage) || usageRef.current;
        }
        return;
      }
      case 'error': {
        const err = payload.error as Record<string, unknown> | undefined;
        const message = typeof err?.message === 'string'
          ? err.message
          : 'Upstream stream error';
        emit({ type: 'error', data: message });
        return;
      }
      default:
        break;
    }
  }

  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  if (choices.length > 0) {
    const choice = choices[0] as Record<string, unknown>;
    const delta = choice.delta as Record<string, unknown> | undefined;
    if (delta && typeof delta.content === 'string' && delta.content.length > 0) {
      emit({ type: 'text', data: delta.content });
      return;
    }
  }

  if (typeof payload.output_text === 'string' && payload.output_text.length > 0) {
    emit({ type: 'text', data: payload.output_text });
  }
}

export async function POST(request: NextRequest) {
  let body: MetaExplainRequest;
  try {
    body = await request.json();
  } catch {
    return makeJsonError('Invalid JSON body', 400);
  }

  const selectedRaw = typeof body.selectedText === 'string' ? body.selectedText : '';
  const selectedText = limitText(selectedRaw, MAX_SELECTED_TEXT);
  const userQuestion = limitText(safeTrim(body.userQuestion) || 'Explain this', MAX_QUESTION);
  const contextLines = limitText(safeTrim(body.contextLines), MAX_CONTEXT_LINES);
  const languageHint = safeTrim(body.languageHint);

  if (!selectedText.trim()) {
    return makeJsonError('selectedText is required', 400);
  }

  let workingDirectory: string | undefined;
  try {
    workingDirectory = await resolveWorkingDirectory(body);
  } catch (error) {
    if (error instanceof Error && error.message === 'SESSION_NOT_FOUND') {
      return makeJsonError('Session not found', 404);
    }
    return makeJsonError('Failed to resolve context', 400);
  }

  let metadata: Awaited<ReturnType<typeof collectProjectMetadata>>;
  try {
    metadata = await collectProjectMetadata(workingDirectory);
  } catch (error) {
    if (error instanceof Error && error.message === 'ROOT_WORKDIR_NOT_ALLOWED') {
      return makeJsonError('Working directory cannot be filesystem root', 400);
    }
    metadata = {};
  }

  const providerConfig = getProviderConfig();
  if ('error' in providerConfig) {
    return makeJsonError(providerConfig.error, providerConfig.status);
  }

  const { system, user } = buildPrompt({
    selectedText,
    userQuestion,
    languageHint,
    contextLines: contextLines || undefined,
    metadata,
  });

  const model = resolveModelName(getSetting('default_model'));
  const upstreamUrl = buildMessagesUrl(providerConfig.baseUrl || DEFAULT_BASE_URL);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'x-api-key': providerConfig.apiKey,
  };
  if (providerConfig.includeBearer) {
    headers.Authorization = `Bearer ${providerConfig.apiKey}`;
  }

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), UPSTREAM_TIMEOUT_MS);
  const onClientAbort = () => timeoutController.abort();
  request.signal.addEventListener('abort', onClientAbort);

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        max_tokens: 1400,
        stream: true,
        system,
        messages: [
          { role: 'user', content: user },
        ],
      }),
      signal: timeoutController.signal,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    request.signal.removeEventListener('abort', onClientAbort);
    const message = timeoutController.signal.aborted
      ? 'Meta explain request timed out'
      : (error instanceof Error ? error.message : 'Failed to reach upstream model service');
    return makeJsonError(message, 502);
  }

  if (!upstream.ok || !upstream.body) {
    clearTimeout(timeoutId);
    request.signal.removeEventListener('abort', onClientAbort);
    const details = await upstream.text().catch(() => '');
    const message = details || `Upstream request failed (${upstream.status})`;
    return makeJsonError(message, 502);
  }

  const stream = new ReadableStream<string>({
    async start(controller) {
      const reader = upstream.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const usageRef: { current: TokenUsage | null } = { current: null };
      let pendingEvent = 'message';
      let pendingData: string[] = [];

      const emit = (event: SSEEvent) => {
        controller.enqueue(formatSSE(event));
      };

      const flushEvent = () => {
        if (pendingData.length === 0) return;
        const dataBlob = pendingData.join('\n').trim();
        pendingData = [];
        if (!dataBlob || dataBlob === '[DONE]') return;
        try {
          const payload = JSON.parse(dataBlob) as Record<string, unknown>;
          handleUpstreamPayload(payload, emit, usageRef);
        } catch {
          if (pendingEvent === 'error') {
            emit({ type: 'error', data: dataBlob });
          }
        }
      };

      emit({ type: 'status', data: 'Starting meta explanation...' });

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const rawLine of lines) {
            const line = rawLine.replace(/\r$/, '');
            if (!line) {
              flushEvent();
              pendingEvent = 'message';
              continue;
            }
            if (line.startsWith(':')) {
              continue;
            }
            if (line.startsWith('event:')) {
              pendingEvent = line.slice(6).trim();
              continue;
            }
            if (line.startsWith('data:')) {
              pendingData.push(line.slice(5).trimStart());
            }
          }
        }

        flushEvent();

        if (usageRef.current) {
          emit({ type: 'result', data: JSON.stringify({ usage: usageRef.current }) });
        } else {
          emit({ type: 'result', data: JSON.stringify({ usage: null }) });
        }
      } catch (error) {
        const message = timeoutController.signal.aborted
          ? 'Meta explain request timed out'
          : (error instanceof Error ? error.message : 'Failed to read stream');
        emit({ type: 'error', data: message });
      } finally {
        clearTimeout(timeoutId);
        request.signal.removeEventListener('abort', onClientAbort);
        try {
          reader.releaseLock();
        } catch {
          // ignore
        }
        emit({ type: 'done', data: '' });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
