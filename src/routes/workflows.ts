import { Router } from 'express'
import * as temporal from '../services/temporal.js'

const router = Router()

router.get('/workflows', async (req, res) => {
  const limit = parseInt(req.query.pageSize as string || req.query.limit as string) || 50
  const result = await temporal.listWorkflows(limit)
  res.json({ data: result })
})

router.get('/workflows/status', async (req, res) => {
  const id = req.query.id as string | undefined
  if (!id) { res.status(400).json({ error: 'Missing workflow id query parameter' }); return }
  const runId = req.query.runId as string | undefined
  const workflow = await temporal.getWorkflow(id, runId)
  if (!workflow) { res.status(404).json({ error: 'Workflow not found' }); return }
  res.json({ data: workflow })
})

router.get('/workflows/:id', async (req, res) => {
  const runId = req.query.runId as string | undefined
  const workflow = await temporal.getWorkflow(req.params.id, runId)
  if (!workflow) { res.status(404).json({ error: 'Workflow not found' }); return }
  res.json({ data: workflow })
})

router.get('/workflows/:id/history', async (req, res) => {
  const runId = req.query.runId as string | undefined
  const history = await temporal.getWorkflowHistory(req.params.id, runId)
  res.json({ data: history })
})

router.post('/workflows/:id/terminate', async (req, res) => {
  await temporal.terminateWorkflow(req.params.id, req.body?.reason)
  res.json({ data: { terminated: true } })
})

router.delete('/workflows/:id', async (req, res) => {
  await temporal.deleteWorkflow(req.params.id)
  res.json({ data: { deleted: true } })
})

export default router
