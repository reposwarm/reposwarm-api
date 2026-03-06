import { Router } from 'express'
import * as temporal from '../services/temporal.js'
import * as dynamodb from '../services/dynamodb.js'

const router = Router()

router.post('/investigate/single', async (req, res) => {
  const { repo_name, repo_url, model, chunk_size } = req.body
  if (!repo_name) { res.status(400).json({ error: 'repo_name is required' }); return }

  let url = repo_url
  if (!url) {
    // If repo_name looks like a URL, use it directly
    if (repo_name.startsWith('http://') || repo_name.startsWith('https://') || repo_name.startsWith('git@')) {
      url = repo_name
    } else {
      const repo = await dynamodb.getRepo(repo_name)
      if (repo) url = repo.url
    }
  }

  const workflowId = `investigate-single-${repo_name}-${Date.now()}`
  await temporal.startWorkflow('InvestigateSingleRepoWorkflow', workflowId, [{
    repo_name,
    repo_url: url || '',
    model: model || 'us.anthropic.claude-sonnet-4-6',
    chunk_size: chunk_size || 10
  }])
  res.status(202).json({ data: { workflowId, status: 'started' } })
})

router.post('/investigate/daily', async (req, res) => {
  const {
    sleep_hours = 24,
    chunk_size = 10,
    model,
    max_tokens,
    force = false,
  } = req.body || {}

  const workflowId = `investigate-daily-${Date.now()}`

  // InvestigateReposRequest Pydantic model fields:
  //   force, claude_model, max_tokens, sleep_hours, chunk_size, iteration_count
  const workflowInput: Record<string, unknown> = {
    force: Boolean(force),
    sleep_hours: Number(sleep_hours),
    chunk_size: Number(chunk_size),
    iteration_count: 0,
  }
  if (model) workflowInput.claude_model = model
  if (max_tokens) workflowInput.max_tokens = Number(max_tokens)

  await temporal.startWorkflow('InvestigateReposWorkflow', workflowId, [workflowInput])
  res.status(202).json({
    data: {
      workflowId,
      status: 'started',
      sleepHours: sleep_hours,
      chunkSize: chunk_size,
      force,
    }
  })
})

export default router
