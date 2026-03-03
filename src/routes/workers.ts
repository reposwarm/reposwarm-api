import { Router, Request, Response } from 'express'
import { config } from '../config.js'
import { logger } from '../middleware/logger.js'
import { WorkerInfo, EnvEntry } from '../types/index.js'
import { execSync, spawn } from 'child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import os from 'os'
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime'

const router = Router()
const INSTALL_DIR = process.env.REPOSWARM_INSTALL_DIR || join(os.homedir(), 'reposwarm')

// ─── Providers Bundle ───────────────────────────────────────────

interface EnvVarDef {
  key: string
  desc: string
  required: boolean
  value?: string
  alts?: string[]
  secret?: boolean
}

interface AuthMethodDef {
  label: string
  envVars: EnvVarDef[]
}

interface ProviderBundle {
  label: string
  envVars: {
    always: EnvVarDef[]
    authMethods?: Record<string, AuthMethodDef>
    defaultAuthMethod?: string
  }
  models: Record<string, string>
  defaultModel: string
  defaultSmallModel: string
  pinVars?: Record<string, string>
}

interface ProvidersFile {
  providers: Record<string, ProviderBundle>
  commonEnvVars: EnvVarDef[]
  knownEnvVars: string[]
}

function loadProvidersBundle(): ProvidersFile {
  // Try external file first (~/.reposwarm/providers.json)
  const extPath = join(os.homedir(), '.reposwarm', 'providers.json')
  if (existsSync(extPath)) {
    try {
      return JSON.parse(readFileSync(extPath, 'utf-8'))
    } catch { /* fall through */ }
  }

  // Fall back to bundled
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const bundledPath = join(__dirname, '..', 'providers.json')
  if (existsSync(bundledPath)) {
    return JSON.parse(readFileSync(bundledPath, 'utf-8'))
  }

  // Hardcoded minimal fallback
  return {
    providers: {},
    commonEnvVars: [],
    knownEnvVars: ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_USE_BEDROCK', 'AWS_REGION']
  }
}

let _providersBundle: ProvidersFile | null = null
function getProvidersBundle(): ProvidersFile {
  if (!_providersBundle) {
    _providersBundle = loadProvidersBundle()
  }
  return _providersBundle
}

// Eagerly load bundle at module init (before any mocks in tests)
try {
  _providersBundle = loadProvidersBundle()
} catch { /* fallback is handled in loadProvidersBundle */ }

// Dynamic required env vars based on provider — driven by providers.json
interface RequiredEnvVar {
  key: string
  desc: string
  alts: string[]
}

function getRequiredEnvVars(envVars: Record<string, string>): RequiredEnvVar[] {
  const bundle = getProvidersBundle()
  const isBedrock = envVars['CLAUDE_CODE_USE_BEDROCK'] === '1'
  const isLiteLLM = !!envVars['ANTHROPIC_BASE_URL'] && !isBedrock
  const providerKey = isBedrock ? 'bedrock' : (isLiteLLM ? 'litellm' : 'anthropic')

  const reqs: RequiredEnvVar[] = []

  // Common env vars
  for (const ev of bundle.commonEnvVars) {
    if (ev.required) {
      reqs.push({ key: ev.key, desc: ev.desc, alts: ev.alts || [] })
    }
  }

  // Provider-specific
  const provider = bundle.providers[providerKey]
  if (provider) {
    for (const ev of provider.envVars.always) {
      if (ev.required) {
        reqs.push({ key: ev.key, desc: ev.desc, alts: ev.alts || [] })
      }
    }

    // Auth-method specific (Bedrock)
    if (provider.envVars.authMethods) {
      // Detect auth method from env
      let authKey = provider.envVars.defaultAuthMethod || 'iam-role'
      if (envVars['AWS_ACCESS_KEY_ID'] || process.env['AWS_ACCESS_KEY_ID']) {
        authKey = 'long-term-keys'
      } else if (envVars['AWS_BEARER_TOKEN_BEDROCK'] || process.env['AWS_BEARER_TOKEN_BEDROCK']) {
        authKey = 'api-key'
      } else if (envVars['AWS_PROFILE'] || process.env['AWS_PROFILE']) {
        authKey = 'profile'
      }
      const authMethod = provider.envVars.authMethods[authKey]
      if (authMethod) {
        for (const ev of authMethod.envVars) {
          if (ev.required) {
            reqs.push({ key: ev.key, desc: ev.desc, alts: ev.alts || [] })
          }
        }
      }
    }
  }

  return reqs
}

function getKnownEnvVars(): string[] {
  const bundle = getProvidersBundle()
  return bundle.knownEnvVars
}

// ─── Helpers ────────────────────────────────────────────────────

function workerEnvPath(): string {
  return join(INSTALL_DIR, 'worker', '.env')
}

function readEnvFile(path: string): Record<string, string> {
  const vars: Record<string, string> = {}
  if (!existsSync(path)) return vars
  const content = readFileSync(path, 'utf-8')
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx > 0) {
      vars[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1).trim()
    }
  }
  return vars
}

function writeEnvFile(path: string, vars: Record<string, string>): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  // Preserve comments and order from existing file
  const lines: string[] = []
  const written = new Set<string>()

  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('#') || !trimmed) {
        lines.push(line)
        continue
      }
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx)
        if (key in vars) {
          lines.push(`${key}=${vars[key]}`)
          written.add(key)
        }
        // else: key was unset, skip it
      }
    }
  }

  // Append new keys
  for (const [key, val] of Object.entries(vars)) {
    if (!written.has(key)) {
      lines.push(`${key}=${val}`)
    }
  }

  // Clean trailing empty lines
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  writeFileSync(path, lines.join('\n') + '\n', { mode: 0o600 })
}

function findPID(service: string): number {
  const patterns: Record<string, string[]> = {
    api: ['node.*reposwarm-api', 'node.*dist/index'],
    worker: ['python.*src.worker', 'python.*worker'],
    temporal: ['temporal-server'],
    ui: ['next-server', 'node.*reposwarm-ui'],
  }
  for (const pattern of (patterns[service] || [])) {
    try {
      const out = execSync(`pgrep -f '${pattern}'`, { encoding: 'utf-8', timeout: 3000 }).trim()
      const pid = parseInt(out.split('\n')[0])
      if (pid > 0) return pid
    } catch { /* not found */ }
  }
  return 0
}

function isProcessRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

function readLogTail(service: string, lines: number): string[] {
  const candidates = [
    join(INSTALL_DIR, 'logs', `${service}.log`),
    join(INSTALL_DIR, service, `${service}.log`),
  ]
  for (const logFile of candidates) {
    if (!existsSync(logFile)) continue
    const content = readFileSync(logFile, 'utf-8')
    const allLines = content.split('\n').filter(l => l.trim())
    return allLines.slice(-lines)
  }
  return []
}

function gatherWorkers(): WorkerInfo[] {
  const envPath = workerEnvPath()
  const envVars = readEnvFile(envPath)
  const hostname = os.hostname()

  // Check env validation using dynamic requirements
  const envErrors: string[] = []
  const requiredEnvVars = getRequiredEnvVars(envVars)
  for (const req of requiredEnvVars) {
    const found = envVars[req.key] || process.env[req.key] ||
      req.alts.some(alt => envVars[alt] || process.env[alt])
    if (!found) envErrors.push(req.key)
  }

  const pid = findPID('worker')
  let status: WorkerInfo['status'] = 'stopped'
  if (pid > 0 && isProcessRunning(pid)) {
    status = envErrors.length > 0 ? 'failed' : 'healthy'
  }

  // Check logs for validation errors
  if (status === 'healthy') {
    const recentLogs = readLogTail('worker', 20)
    const hasValidationError = recentLogs.some(l =>
      l.toLowerCase().includes('validation failed') || l.toLowerCase().includes('critical'))
    if (hasValidationError) status = 'degraded'
  }

  // Detect model
  const model = envVars['ANTHROPIC_MODEL'] || envVars['CLAUDE_MODEL'] || envVars['MODEL_ID'] || ''

  const worker: WorkerInfo = {
    name: 'worker-1',
    identity: 'investigate-worker-1',
    status,
    taskQueue: config.temporalTaskQueue,
    envStatus: envErrors.length > 0 ? `${envErrors.length} errors` : 'OK',
    envErrors,
    pid: pid || undefined,
    host: hostname,
    model,
  }

  return [worker]
}

// ─── Routes ─────────────────────────────────────────────────────

// GET /providers — serve the providers bundle (single source of truth)
router.get('/providers', async (_req: Request, res: Response) => {
  const bundle = getProvidersBundle()
  res.json({ data: bundle })
})

// GET /workers
router.get('/workers', async (_req: Request, res: Response) => {
  const workers = gatherWorkers()
  const healthy = workers.filter(w => w.status === 'healthy').length
  res.json({ data: { workers, total: workers.length, healthy } })
})

// GET /workers/:id
router.get('/workers/:id', async (req: Request, res: Response) => {
  const workers = gatherWorkers()
  const id = req.params.id as string
  const worker = workers.find(w => w.name === id || w.identity === id)
  if (!worker) return res.status(404).json({ error: `Worker '${id}' not found` })
  res.json({ data: worker })
})

// GET /workers/:id/env
router.get('/workers/:id/env', async (req: Request, res: Response) => {
  const reveal = req.query.reveal === 'true'
  const envPath = workerEnvPath()
  const fileVars = readEnvFile(envPath)

  const seen = new Set<string>()
  const entries: EnvEntry[] = []

  const addEntry = (key: string) => {
    if (seen.has(key)) return
    seen.add(key)

    let value = '', source = '—', set = false
    if (fileVars[key]) {
      value = fileVars[key]; source = '.env'; set = true
    } else if (process.env[key]) {
      value = process.env[key]!; source = 'environment'; set = true
    }

    if (!reveal && set && value.length > 8) {
      value = value.slice(0, 4) + '...' + value.slice(-4)
    } else if (!reveal && set) {
      value = '***'
    }
    if (!set) value = '(not set)'

    entries.push({ key, value, source, set })
  }

  for (const k of getKnownEnvVars()) addEntry(k)
  for (const k of Object.keys(fileVars)) addEntry(k)

  res.json({ data: { envFile: envPath, entries } })
})

// PUT /workers/:id/env/:key
router.put('/workers/:id/env/:key', async (req: Request, res: Response) => {
  const key = req.params.key as string
  const { value } = req.body
  if (!value) return res.status(400).json({ error: 'value is required' })

  const envPath = workerEnvPath()
  const vars = readEnvFile(envPath)
  vars[key] = value
  writeEnvFile(envPath, vars)

  const masked = value.length > 8 ? value.slice(0, 4) + '...' + value.slice(-4) : '***'
  logger.info({ key, envPath }, 'Worker env var set')
  res.json({ data: { key, value: masked, envFile: envPath } })
})

// DELETE /workers/:id/env/:key
router.delete('/workers/:id/env/:key', async (req: Request, res: Response) => {
  const key = req.params.key as string
  const envPath = workerEnvPath()
  const vars = readEnvFile(envPath)
  delete vars[key]
  writeEnvFile(envPath, vars)

  logger.info({ key, envPath }, 'Worker env var removed')
  res.json({ data: { key, removed: true, envFile: envPath } })
})

// POST /workers/:id/restart
router.post('/workers/:id/restart', async (req: Request, res: Response) => {
  const pid = findPID('worker')
  if (pid > 0) {
    try { process.kill(pid, 'SIGTERM') } catch { /* already dead */ }
    // Wait for graceful shutdown
    await new Promise(resolve => setTimeout(resolve, 2000))
    if (isProcessRunning(pid)) {
      try { process.kill(pid, 'SIGKILL') } catch { /* */ }
    }
  }

  // Start worker
  const workerDir = join(INSTALL_DIR, 'worker')
  const envVars = readEnvFile(join(workerDir, '.env'))
  const env = { ...process.env, ...envVars }

  try {
    const child = spawn('python3', ['-m', 'src.worker'], {
      cwd: workerDir, env, detached: true, stdio: 'ignore'
    })
    child.unref()

    const newPid = child.pid || 0
    logger.info({ pid: newPid }, 'Worker restarted')
    res.json({ data: { service: 'worker', status: 'restarted', pid: newPid } })
  } catch (err: any) {
    res.status(500).json({ error: `Failed to start worker: ${err.message}` })
  }
})

// POST /workers/:id/inference-check
router.post('/workers/:id/inference-check', async (req: Request, res: Response) => {
  const startTime = Date.now()
  const envPath = workerEnvPath()
  const envVars = readEnvFile(envPath)

  // Detect provider
  const isBedrock = envVars['CLAUDE_CODE_USE_BEDROCK'] === '1'
  const isLiteLLM = !!envVars['ANTHROPIC_BASE_URL'] && !isBedrock
  const provider = isBedrock ? 'bedrock' : (isLiteLLM ? 'litellm' : 'anthropic')

  // Get model
  const model = envVars['ANTHROPIC_MODEL'] || envVars['CLAUDE_MODEL'] || envVars['MODEL_ID'] || ''
  if (!model) {
    return res.json({
      data: {
        success: false,
        provider,
        model: '',
        error: 'No model specified',
        hint: 'Set ANTHROPIC_MODEL or CLAUDE_MODEL env var'
      }
    })
  }

  // Tiny test prompt
  const testPrompt = 'Say OK'
  const maxTokens = 10

  try {
    if (isBedrock) {
      // === Bedrock Provider ===
      const region = envVars['AWS_REGION'] || envVars['AWS_DEFAULT_REGION'] || process.env['AWS_REGION'] || process.env['AWS_DEFAULT_REGION']
      if (!region) {
        return res.json({
          data: {
            success: false,
            provider,
            model,
            authMethod: 'unknown',
            error: 'AWS_REGION not set',
            hint: 'Set AWS_REGION or AWS_DEFAULT_REGION env var'
          }
        })
      }

      // Detect auth method
      let authMethod = 'iam-role'
      if (envVars['AWS_ACCESS_KEY_ID'] || process.env['AWS_ACCESS_KEY_ID']) {
        authMethod = 'long-term-keys'
      } else if (envVars['AWS_PROFILE'] || process.env['AWS_PROFILE']) {
        authMethod = 'profile'
      }

      // Create Bedrock client
      const client = new BedrockRuntimeClient({ region })

      // Build converse command
      const command = new ConverseCommand({
        modelId: model,
        messages: [
          {
            role: 'user',
            content: [{ text: testPrompt }]
          }
        ],
        inferenceConfig: {
          maxTokens: maxTokens
        }
      })

      const response = await client.send(command)
      const content = response.output?.message?.content?.[0]
      const responseText = (content && 'text' in content) ? content.text : ''

      return res.json({
        data: {
          success: true,
          provider,
          model,
          authMethod,
          latencyMs: Date.now() - startTime,
          response: responseText || 'OK'
        }
      })

    } else if (isLiteLLM) {
      // === LiteLLM Provider ===
      const proxyUrl = envVars['ANTHROPIC_BASE_URL']
      const apiKey = envVars['ANTHROPIC_API_KEY'] || process.env['ANTHROPIC_API_KEY']

      const response = await fetch(`${proxyUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          ...(apiKey ? { 'x-api-key': apiKey } : {})
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: testPrompt }],
          max_tokens: maxTokens
        })
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({} as any))
        const errorMsg = (errorData as any).error?.message || (errorData as any).message || `HTTP ${response.status}`
        return res.json({
          data: {
            success: false,
            provider,
            model,
            authMethod: 'api-key',
            error: errorMsg,
            hint: response.status === 401 ? 'Check your LiteLLM proxy API key' :
                  response.status === 404 ? 'Check your ANTHROPIC_BASE_URL proxy endpoint' :
                  'Check LiteLLM proxy configuration and model availability'
          }
        })
      }

      const data = await response.json() as any
      const responseText = data.content?.[0]?.text || ''

      return res.json({
        data: {
          success: true,
          provider,
          model,
          authMethod: 'api-key',
          latencyMs: Date.now() - startTime,
          response: responseText || 'OK'
        }
      })

    } else {
      // === Anthropic Direct Provider ===
      const apiKey = envVars['ANTHROPIC_API_KEY'] || process.env['ANTHROPIC_API_KEY']
      if (!apiKey) {
        return res.json({
          data: {
            success: false,
            provider,
            model,
            authMethod: 'api-key',
            error: 'ANTHROPIC_API_KEY not set',
            hint: 'Set your Anthropic API key in worker env vars'
          }
        })
      }

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: testPrompt }],
          max_tokens: maxTokens
        })
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({} as any))
        const errorMsg = (errorData as any).error?.message || (errorData as any).message || `HTTP ${response.status}`
        return res.json({
          data: {
            success: false,
            provider,
            model,
            authMethod: 'api-key',
            error: errorMsg,
            hint: response.status === 401 ? 'Invalid Anthropic API key' :
                  response.status === 403 ? 'API key lacks permissions for this model' :
                  response.status === 429 ? 'Rate limit exceeded' :
                  'Check your Anthropic API key and model availability'
          }
        })
      }

      const data = await response.json() as any
      const responseText = data.content?.[0]?.text || ''

      return res.json({
        data: {
          success: true,
          provider,
          model,
          authMethod: 'api-key',
          latencyMs: Date.now() - startTime,
          response: responseText || 'OK'
        }
      })
    }

  } catch (error: any) {
    // Map common errors to helpful hints
    let hint = 'Check credentials and network connectivity'

    if (error.name === 'AccessDeniedException' || error.message?.includes('AccessDenied')) {
      hint = 'IAM role/user needs bedrock:InvokeModel permission for the model'
    } else if (error.name === 'ResourceNotFoundException') {
      hint = 'Model ID not found in this region. Check model availability.'
    } else if (error.name === 'ValidationException') {
      hint = 'Invalid model ID format. Bedrock IDs look like us.anthropic.claude-*'
    } else if (error.name === 'ExpiredTokenException' || error.message?.includes('expired')) {
      hint = 'AWS credentials expired. Refresh SSO or rotate keys.'
    } else if (error.message?.includes('ENOTFOUND') || error.message?.includes('ECONNREFUSED')) {
      hint = 'Network error. Check your internet connection and proxy settings.'
    } else if (error.message?.includes('timeout')) {
      hint = 'Request timed out. Check network connectivity and region settings.'
    }

    logger.error({ error: error.message, provider, model }, 'Inference check failed')

    return res.json({
      data: {
        success: false,
        provider,
        model,
        authMethod: isBedrock ? 'unknown' : 'api-key',
        error: error.message || 'Unknown error',
        hint
      }
    })
  }
})

export default router
