import { Router } from 'express'
import * as dynamodb from '../services/dynamodb.js'
import * as codecommit from '../services/codecommit.js'
import * as github from '../services/github.js'
import * as gitlab from '../services/gitlab.js'
import * as azure from '../services/azure.js'
import * as bitbucket from '../services/bitbucket.js'

const router = Router()

router.get('/repos', async (_req, res) => {
  const repos = await dynamodb.listRepos()
  res.json({ data: repos })
})

router.post('/repos', async (req, res) => {
  const { name, url, source, enabled } = req.body
  if (!name || !url) {
    res.status(400).json({ error: 'name and url are required' })
    return
  }
  await dynamodb.putRepo({ name, url, source, enabled })
  res.status(201).json({ data: { name, url, source: source || 'GitHub', enabled: enabled !== false } })
})

router.get('/repos/:name', async (req, res) => {
  const repo = await dynamodb.getRepo(req.params.name)
  if (!repo) { res.status(404).json({ error: 'Repository not found' }); return }
  res.json({ data: repo })
})

router.put('/repos/:name', async (req, res) => {
  const repo = await dynamodb.getRepo(req.params.name)
  if (!repo) { res.status(404).json({ error: 'Repository not found' }); return }
  await dynamodb.updateRepo(req.params.name, req.body)
  res.json({ data: { ...repo, ...req.body } })
})

router.delete('/repos/:name', async (req, res) => {
  await dynamodb.deleteRepo(req.params.name)
  res.json({ data: { deleted: true } })
})

router.post('/repos/discover', async (req, res) => {
  let source = (req.body?.source as string | undefined)?.toLowerCase()
  const org = req.body?.org as string | undefined

  // Auto-detect provider from available credentials when source not specified
  if (!source) {
    if (process.env.GITHUB_TOKEN) source = 'github'
    else if (process.env.GITLAB_TOKEN) source = 'gitlab'
    else if (process.env.AZURE_DEVOPS_PAT) source = 'azure'
    else if (process.env.BITBUCKET_APP_PASSWORD) source = 'bitbucket'
    else source = 'codecommit'
  }

  let discovered: { name: string; url: string; source: string }[]

  try {
    switch (source) {
      case 'github':
        discovered = await github.discoverRepos(org)
        break
      case 'gitlab':
        discovered = await gitlab.discoverRepos()
        break
      case 'azure':
      case 'azuredevops':
        discovered = await azure.discoverRepos()
        break
      case 'bitbucket':
        discovered = await bitbucket.discoverRepos()
        break
      case 'codecommit':
      default:
        discovered = await codecommit.discoverRepos()
        break
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
    return
  }

  const existing = await dynamodb.listRepos()
  const existingNames = new Set(existing.map(r => r.name))
  let added = 0
  for (const repo of discovered) {
    if (!existingNames.has(repo.name)) {
      await dynamodb.putRepo({ name: repo.name, url: repo.url, source: repo.source, enabled: true })
      added++
    }
  }
  res.json({ data: { discovered: discovered.length, added, skipped: discovered.length - added } })
})

export default router
