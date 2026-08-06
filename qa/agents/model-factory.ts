import { createBlockedModelAdapter } from './blocked-adapter.ts';
import type { QaModelAdapter } from './model-adapter.ts';
import { createOpenAiResponsesAdapter } from './openai-responses-adapter.ts';

export interface QaModelRuntimeConfig {
  readonly enabled: boolean;
  readonly provider: string | null | undefined;
  readonly model: string | null | undefined;
  readonly apiKey: string | null | undefined;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxOutputTokens?: number;
  readonly maxResponseBytes?: number;
}

/**
 * Converts already-loaded runner configuration into an adapter. This function intentionally does
 * not read process.env: configuration and secrets stay in the trusted runner and API keys remain
 * closed over by the provider adapter rather than entering role-agent input.
 */
export function createQaModelAdapter(config: QaModelRuntimeConfig): QaModelAdapter {
  if (!config.enabled) {
    return createBlockedModelAdapter('QA agent phase is disabled by configuration');
  }
  const provider = config.provider?.trim().toLowerCase();
  if (!provider) return createBlockedModelAdapter('QA_MODEL_PROVIDER is missing');
  if (provider !== 'openai' && provider !== 'openai-responses') {
    return createBlockedModelAdapter(`Unsupported QA model provider: ${provider}`);
  }
  const model = config.model?.trim();
  if (!model) return createBlockedModelAdapter('QA_MODEL_NAME is missing');
  const apiKey = config.apiKey?.trim();
  if (!apiKey) return createBlockedModelAdapter('QA_MODEL_API_KEY is missing');
  return createOpenAiResponsesAdapter({
    apiKey,
    model,
    fetchImpl: config.fetchImpl,
    timeoutMs: config.timeoutMs,
    maxOutputTokens: config.maxOutputTokens,
    maxResponseBytes: config.maxResponseBytes,
  });
}
