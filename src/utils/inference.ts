/**
 * Shared LLM inference client.
 *
 * All Bedrock / Anthropic / LiteLLM inference goes through here.
 * Fix auth bugs in ONE place.
 */

import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import os from 'os'

// ─── Types ──────────────────────────────────────────────────────

export type AuthMethod = 'api-keys' | 'access-keys' | 'profile' | 'iam-role'
export type Provider = 'bedrock' | 'litellm' | 'anthropic'

export interface InferenceConfig {
  /** System prompt (optional) */
  system?: string
  /** User message */
  prompt: string
  /** Max tokens to generate */
  maxTokens?: number
  /** Override env vars (e.g. from worker .env file) */
  envOverrides?: Record<string, string>
}

export interface InferenceResult {
  success: boolean
  provider: Provider
  model: string
  authMethod: AuthMethod | 'unknown'
  latencyMs: number
  response?: string
  error?: string
  hint?: string
}

// ─── Env Helpers ────────────────────────────────────────────────

const INSTALL_DIR = process.env.REPOSWARM_INSTALL_DIR || join(os.homedir(), 'reposwarm')

/**
 * Read worker .env file. Cached per call — call fresh each request
 * since the file can be edited between requests.
 */
export function readWorkerEnv(): Record<string, string> {
  const envPath = join(INSTALL_DIR, 'worker', '.env')
  if (!existsSync(envPath)) return {}
  const content = readFileSync(envPath, 'utf-8')
  const vars: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq > 0) {
      let val = trimmed.slice(eq + 1).trim()
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      vars[trimmed.slice(0, eq)] = val
    }
  }
  return vars
}

/**
 * Resolve an env var: check overrides first, then process.env.
 */
function env(key: string, overrides: Record<string, string> = {}): string {
  return overrides[key] || process.env[key] || ''
}

// ─── Provider / Auth Detection ──────────────────────────────────

export function detectProvider(envOverrides: Record<string, string> = {}): Provider {
  const isBedrock = env('CLAUDE_CODE_USE_BEDROCK', envOverrides) === '1'
  const hasProxy = !!env('ANTHROPIC_BASE_URL', envOverrides)
  if (isBedrock) return 'bedrock'
  if (hasProxy) return 'litellm'
  return 'anthropic'
}

export function detectAuthMethod(envOverrides: Record<string, string> = {}): AuthMethod {
  if (env('AWS_BEARER_TOKEN_BEDROCK', envOverrides)) return 'api-keys'
  if (env('AWS_ACCESS_KEY_ID', envOverrides)) return 'access-keys'
  if (env('AWS_PROFILE', envOverrides)) return 'profile'
  return 'iam-role'
}

export function detectModel(envOverrides: Record<string, string> = {}): string {
  return env('ANTHROPIC_SMALL_FAST_MODEL', envOverrides) ||
         env('ANTHROPIC_MODEL', envOverrides) ||
         env('CLAUDE_MODEL', envOverrides) ||
         env('MODEL_ID', envOverrides) ||
         ''
}

export function detectRegion(envOverrides: Record<string, string> = {}): string {
  return env('AWS_REGION', envOverrides) ||
         env('AWS_DEFAULT_REGION', envOverrides) ||
         'us-east-1'
}

// ─── Inference ──────────────────────────────────────────────────

/**
 * Run a single inference request against the configured provider.
 * Handles Bedrock (bearer token + SigV4), LiteLLM, and Anthropic.
 */
export async function infer(config: InferenceConfig): Promise<InferenceResult> {
  const startTime = Date.now()
  const envOverrides = config.envOverrides || readWorkerEnv()
  const provider = detectProvider(envOverrides)
  const model = detectModel(envOverrides)
  const maxTokens = config.maxTokens || 1024

  if (!model) {
    return {
      success: false, provider, model: '', authMethod: 'unknown',
      latencyMs: 0, error: 'No model configured',
      hint: 'Run: reposwarm config provider setup',
    }
  }

  try {
    let responseText = ''

    if (provider === 'bedrock') {
      const result = await inferBedrock(envOverrides, model, config.prompt, config.system, maxTokens)
      if (!result.success) {
        return { ...result, provider, model, latencyMs: Date.now() - startTime }
      }
      responseText = result.text
    } else if (provider === 'litellm') {
      responseText = await inferLiteLLM(envOverrides, model, config.prompt, config.system, maxTokens)
    } else {
      responseText = await inferAnthropic(envOverrides, model, config.prompt, config.system, maxTokens)
    }

    return {
      success: true, provider, model,
      authMethod: provider === 'bedrock' ? detectAuthMethod(envOverrides) : 'unknown',
      latencyMs: Date.now() - startTime,
      response: responseText || 'OK',
    }
  } catch (error: any) {
    const authMethod = provider === 'bedrock' ? detectAuthMethod(envOverrides) : 'unknown'
    return {
      success: false, provider, model, authMethod,
      latencyMs: Date.now() - startTime,
      error: error.message || 'Inference failed',
      hint: provider === 'bedrock'
        ? `Check provider config (auth: ${authMethod})`
        : 'Check provider config: reposwarm config provider show',
    }
  }
}

// ─── Provider Implementations ───────────────────────────────────

interface BedrockResult {
  success: boolean
  text: string
  authMethod: AuthMethod
  error?: string
  hint?: string
}

async function inferBedrock(
  envOverrides: Record<string, string>,
  model: string, prompt: string, system: string | undefined, maxTokens: number
): Promise<BedrockResult> {
  const region = detectRegion(envOverrides)
  const authMethod = detectAuthMethod(envOverrides)
  const bearerToken = env('AWS_BEARER_TOKEN_BEDROCK', envOverrides)

  if (bearerToken) {
    // Bearer token auth — raw HTTP (AWS SDK doesn't support bearer tokens)
    const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/invoke`
    const body: any = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }
    if (system) body.system = system

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${bearerToken}`,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({} as any))
      const errorMsg = (errorData as any).message || `HTTP ${response.status}`
      return {
        success: false, text: '', authMethod,
        error: errorMsg,
        hint: response.status === 403
          ? 'Bearer token may be invalid or expired'
          : 'Check AWS_BEARER_TOKEN_BEDROCK and region settings',
      }
    }

    const data = await response.json() as any
    return { success: true, text: data.content?.[0]?.text || '', authMethod }
  }

  // SigV4 auth — AWS SDK (access-keys, profile, iam-role)
  const client = new BedrockRuntimeClient({ region })
  const command = new ConverseCommand({
    modelId: model,
    ...(system ? { system: [{ text: system }] } : {}),
    messages: [{ role: 'user', content: [{ text: prompt }] }],
    inferenceConfig: { maxTokens },
  })

  const response = await client.send(command)
  const content = response.output?.message?.content?.[0]
  const text = (content && 'text' in content) ? content.text || '' : ''
  return { success: true, text, authMethod }
}

async function inferLiteLLM(
  envOverrides: Record<string, string>,
  model: string, prompt: string, system: string | undefined, maxTokens: number
): Promise<string> {
  const proxyUrl = env('ANTHROPIC_BASE_URL', envOverrides)
  const apiKey = env('ANTHROPIC_API_KEY', envOverrides)

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
    },
    body: JSON.stringify({
      model,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
    }),
  })

  if (!response.ok) {
    const err = await response.json().catch(() => ({} as any))
    throw new Error((err as any).error?.message || `HTTP ${response.status}`)
  }

  const data = await response.json() as any
  return data.content?.[0]?.text || ''
}

async function inferAnthropic(
  envOverrides: Record<string, string>,
  model: string, prompt: string, system: string | undefined, maxTokens: number
): Promise<string> {
  const apiKey = env('ANTHROPIC_API_KEY', envOverrides)
  if (!apiKey) {
    throw new Error('No Anthropic API key — set ANTHROPIC_API_KEY')
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
    }),
  })

  if (!response.ok) {
    const err = await response.json().catch(() => ({} as any))
    throw new Error((err as any).error?.message || `HTTP ${response.status}`)
  }

  const data = await response.json() as any
  return data.content?.[0]?.text || ''
}
