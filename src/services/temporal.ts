import { Connection, Client } from '@temporalio/client'
import { config } from '../config.js'
import { logger } from '../middleware/logger.js'
import { WorkflowExecution, WorkflowHistory } from '../types/index.js'
import { formatStartedAgo, isWorkflowStale } from '../utils/helpers.js'

let grpcClient: Client | null = null

async function getGrpcClient(): Promise<Client> {
  if (!grpcClient) {
    const connection = await Connection.connect({ address: config.temporalServerUrl })
    grpcClient = new Client({ connection, namespace: config.temporalNamespace })
  }
  return grpcClient
}

function normalizeStatus(raw: string): string {
  return raw
    .replace('WORKFLOW_EXECUTION_STATUS_', '')
    .toLowerCase()
    .replace(/^\w/, c => c.toUpperCase())
}

// === HTTP reads (Temporal UI proxy) ===

async function temporalGet(path: string): Promise<any> {
  const url = `${config.temporalHttpUrl}/api/v1/namespaces/${config.temporalNamespace}${path}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Temporal HTTP ${res.status}: ${await res.text()}`)
  return res.json()
}

export async function listWorkflows(limit = 50): Promise<{ executions: WorkflowExecution[] }> {
  const data = await temporalGet(`/workflows?maximumPageSize=${limit}`)
  const executions = (data.executions || []).map((exec: any) => {
    const startTime = exec.startTime || ''
    const status = normalizeStatus(exec.status || 'Running')
    return {
      workflowId: exec.execution?.workflowId || '',
      runId: exec.execution?.runId || '',
      type: exec.type?.name || '',
      status,
      startTime,
      closeTime: exec.closeTime,
      taskQueueName: exec.taskQueue || config.temporalTaskQueue,
      stale: isWorkflowStale(status, startTime),
      startedAgo: formatStartedAgo(startTime)
    }
  })
  return { executions }
}

function extractFailureMessage(failure: any): { message: string; source?: string; stackTrace?: string; cause?: any } | undefined {
  if (!failure) return undefined

  let message = failure.message || 'Unknown error'
  let source = failure.source
  let stackTrace = failure.stackTrace
  const cause = failure.cause

  // Extract nested activity failure details
  if (failure.cause?.activityFailureInfo) {
    const activityInfo = failure.cause.activityFailureInfo
    source = `Activity: ${activityInfo.activityType?.name || 'unknown'}`

    // Drill down to the actual error message
    if (activityInfo.failure) {
      message = activityInfo.failure.message || message
      stackTrace = activityInfo.failure.stackTrace || stackTrace

      // Check for nested application failure with more specific details
      if (activityInfo.failure.cause?.applicationFailureInfo) {
        const appFailure = activityInfo.failure.cause.applicationFailureInfo
        const appMessage = appFailure.details?.message || appFailure.type
        if (appMessage) {
          message = appFailure.nonRetryable ? `[Non-retryable] ${appMessage}` : appMessage
        }
      }
    }
  }

  // Extract application failure info (top-level)
  if (failure.applicationFailureInfo && !failure.cause?.activityFailureInfo) {
    const appInfo = failure.applicationFailureInfo
    message = appInfo.details?.message || appInfo.type || message
    if (appInfo.nonRetryable) {
      message = `[Non-retryable] ${message}`
    }
  }

  return { message, source, stackTrace, cause }
}

export async function getWorkflow(workflowId: string, runId?: string): Promise<WorkflowExecution | null> {
  try {
    const encodedId = encodeURIComponent(workflowId)
    const path = runId ? `/workflows/${encodedId}?runId=${runId}` : `/workflows/${encodedId}`
    const data = await temporalGet(path)
    const info = data.workflowExecutionInfo || data
    const startTime = info.startTime || ''
    const status = normalizeStatus(info.status || 'Running')

    const execution: WorkflowExecution = {
      workflowId: info.execution?.workflowId || workflowId,
      runId: info.execution?.runId || runId || '',
      type: info.type?.name || '',
      status,
      startTime,
      closeTime: info.closeTime,
      taskQueueName: info.taskQueue || config.temporalTaskQueue,
      input: data.input,
      result: data.result,
      memo: data.memo,
      stale: isWorkflowStale(status, startTime),
      startedAgo: formatStartedAgo(startTime)
    }

    // Extract failure information if workflow failed
    if (info.failure) {
      execution.failure = extractFailureMessage(info.failure)
    }

    return execution
  } catch (e) {
    logger.error({ err: e, workflowId }, 'Failed to get workflow')
    return null
  }
}

export async function getWorkflowHistory(workflowId: string, runId?: string): Promise<WorkflowHistory> {
  const encodedId = encodeURIComponent(workflowId)
  const params = runId ? `?runId=${runId}` : ''
  const data = await temporalGet(`/workflows/${encodedId}/history${params}`)
  return {
    events: (data.history?.events || []).map((e: any) => ({
      eventId: e.eventId || '',
      eventTime: e.eventTime || '',
      eventType: e.eventType || '',
      details: e.attributes || e.details
    }))
  }
}

// === gRPC writes ===

export async function startWorkflow(workflowType: string, workflowId: string, args: any[]): Promise<string> {
  const client = await getGrpcClient()
  const handle = await client.workflow.start(workflowType, {
    taskQueue: config.temporalTaskQueue,
    workflowId,
    args,
  })
  return handle.workflowId
}

export async function terminateWorkflow(workflowId: string, reason?: string): Promise<void> {
  const client = await getGrpcClient()
  const handle = client.workflow.getHandle(workflowId)
  await handle.terminate(reason || 'Terminated via API')
}

export async function deleteWorkflow(workflowId: string): Promise<void> {
  const client = await getGrpcClient()
  await client.workflowService.deleteWorkflowExecution({
    namespace: config.temporalNamespace,
    workflowExecution: { workflowId },
  })
}

export async function healthCheck(): Promise<boolean> {
  try {
    await temporalGet('/workflows?maximumPageSize=1')
    return true
  } catch (e) {
    logger.error({ err: e }, 'Temporal health check failed')
    return false
  }
}

export function resetClient() { grpcClient = null }
