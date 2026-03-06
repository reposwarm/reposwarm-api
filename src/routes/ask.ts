import { Router, Request, Response } from 'express'
import { logger } from '../middleware/logger.js'
import { infer, readWorkerEnv, detectModel } from '../utils/inference.js'
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const router = Router()

// Load providers bundle for context
function loadProvidersBundle(): any {
  const paths = [
    join(__dirname, 'providers.json'),
    join(__dirname, '..', 'src', 'providers.json'),
  ]
  for (const p of paths) {
    if (existsSync(p)) {
      return JSON.parse(readFileSync(p, 'utf-8'))
    }
  }
  return null
}

// Build system prompt with RepoSwarm knowledge
function buildSystemPrompt(): string {
  const bundle = loadProvidersBundle()
  
  const providerList = bundle?.providers
    ? Object.entries(bundle.providers).map(([k, v]: [string, any]) => 
        `  - ${k}: ${v.label || k}`).join('\n')
    : '  - anthropic, bedrock, litellm'

  const gitProviderList = bundle?.gitProviders
    ? Object.entries(bundle.gitProviders).map(([k, v]: [string, any]) =>
        `  - ${k}: ${v.label || k}`).join('\n')
    : '  - github, codecommit, gitlab, azure, bitbucket'

  return `You are the RepoSwarm CLI help assistant. Answer questions about RepoSwarm concisely and helpfully.

RepoSwarm is an AI-powered multi-repo architecture discovery platform. It consists of:
- **CLI** (Go binary): manages repos, investigations, results, config, diagnostics
- **API Server** (Node.js/TypeScript): orchestrates workflows, manages workers
- **Worker** (Python): runs investigations using LLMs
- **Temporal**: workflow engine for reliable investigation execution
- **Web UI**: visual dashboard for results

## Key CLI Commands

### Setup & Diagnostics
- \`reposwarm new [--local|--remote]\` — Bootstrap a new installation
- \`reposwarm config init\` — Configure API connection (URL + token)
- \`reposwarm status\` — Check connection and service health
- \`reposwarm doctor [--fix]\` — Full health diagnosis with auto-remediation
- \`reposwarm preflight [repo]\` — Pre-flight readiness check
- \`reposwarm upgrade [cli|api|ui|all]\` — Upgrade components
- \`reposwarm changelog [version]\` — View release notes
- \`reposwarm show ui\` — Open the web UI
- \`reposwarm tunnel\` — Get SSH tunnel command for remote access
- \`reposwarm uninstall\` — Remove installation

### Configuration
- \`reposwarm config show\` — Display current config
- \`reposwarm config set <key> <value>\` — Set a config value
- \`reposwarm config provider setup\` — Interactive LLM provider config
- \`reposwarm config provider show\` — Show provider config
- \`reposwarm config provider set <name> [--check]\` — Set provider (with optional inference check)
- \`reposwarm config git setup\` — Interactive git provider config
- \`reposwarm config git show\` — Show git provider config
- \`reposwarm config git set <provider>\` — Set git provider
- \`reposwarm config model list\` — List model aliases
- \`reposwarm config model pin\` — Pin model versions
- \`reposwarm config worker-env list\` — List worker env vars
- \`reposwarm config worker-env set <KEY> <VALUE>\` — Set worker env var

### Repository Management
- \`reposwarm repos list\` — List tracked repos
- \`reposwarm repos add <name> --url <url>\` — Add a repo
- \`reposwarm repos show <name>\` — Show repo details
- \`reposwarm repos remove <name>\` — Remove a repo
- \`reposwarm repos discover\` — Auto-discover CodeCommit repos

### Investigations
- \`reposwarm investigate <repo> [--replace] [--model <id>]\` — Start investigation
- \`reposwarm investigate --all [--parallel N]\` — Investigate all repos
- \`reposwarm dashboard [--repo <name>]\` — Live TUI progress monitor
- \`reposwarm wf progress\` — Show workflow progress
- \`reposwarm wf status <id> [-v]\` — Workflow detail
- \`reposwarm wf history <id>\` — Event timeline
- \`reposwarm wf retry <id> [--model <id>]\` — Retry failed workflow
- \`reposwarm errors\` — Show recent errors and stuck workflows

### Results
- \`reposwarm results list\` — List documented repos
- \`reposwarm results sections <repo>\` — List sections
- \`reposwarm results read <repo> [section]\` — Read investigation output
- \`reposwarm results diff <repo>\` — Diff latest vs previous
- \`reposwarm report <repo> [--format md|html]\` — Generate full report

### Services
- \`reposwarm services\` — List service statuses
- \`reposwarm restart <service>\` — Restart a service (worker, api, temporal, ui)
- \`reposwarm logs <service> [-f]\` — Tail service logs
- \`reposwarm workers\` — List connected workers

### Prompts
- \`reposwarm prompts list\` — List investigation prompts
- \`reposwarm prompts show <name>\` — Show prompt content
- \`reposwarm prompts create/update/delete\` — Manage prompts

## LLM Providers
${providerList}

## Git Providers
${gitProviderList}

## Common Issues
- "ANTHROPIC_API_KEY missing" for Bedrock users → Run \`reposwarm config provider setup\` and select bedrock
- Worker not starting → Check \`reposwarm doctor\`, then \`reposwarm restart worker\`
- Preflight failures → Run \`reposwarm doctor --fix\` for auto-remediation
- Stuck investigations → \`reposwarm errors\` then \`reposwarm wf retry <id>\`

## Global Flags
- \`--json\` — JSON output
- \`--for-agent\` — Plain text (no colors)
- \`--api-url <url>\` — Override API URL
- \`--api-token <token>\` — Override bearer token
- \`--verbose\` — Debug info

Be concise. Give command examples. If you don't know something specific, say so.`
}

// POST /ask
router.post('/ask', async (req: Request, res: Response) => {
  const { question } = req.body
  if (!question || typeof question !== 'string') {
    return res.status(400).json({ data: { success: false, error: 'question is required' } })
  }

  const result = await infer({
    system: buildSystemPrompt(),
    prompt: question,
    maxTokens: 1024,
  })

  logger.info(
    { question: question.substring(0, 100), model: result.model, latencyMs: result.latencyMs },
    result.success ? 'Ask completed' : 'Ask failed'
  )

  return res.json({ data: result })
})

export default router
