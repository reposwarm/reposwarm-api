import { DynamoDBClient, CreateTableCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, DeleteCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { config } from '../config.js'
import { Repository, Prompt, PromptVersion, WikiRepoSummary, WikiSection, RepoSwarmConfig } from '../types/index.js'
import { logger } from '../middleware/logger.js'

const clientConfig: any = { region: config.region }
if (config.dynamoEndpoint) {
  clientConfig.endpoint = config.dynamoEndpoint
}
const client = new DynamoDBClient(clientConfig)
const docClient = DynamoDBDocumentClient.from(client)
const TABLE = config.dynamoTable

async function paginatedScan(params: any): Promise<Record<string, any>[]> {
  let items: Record<string, any>[] = []
  let lastKey: Record<string, any> | undefined
  do {
    const command = new ScanCommand({ ...params, ...(lastKey ? { ExclusiveStartKey: lastKey } : {}) })
    const response = await docClient.send(command)
    items = items.concat(response.Items || [])
    lastKey = response.LastEvaluatedKey
  } while (lastKey)
  return items
}

// === Repos ===

export async function listRepos(): Promise<Repository[]> {
  const items = await paginatedScan({
    TableName: TABLE,
    FilterExpression: '#sk = :zero',
    ExpressionAttributeNames: { '#sk': 'analysis_timestamp' },
    ExpressionAttributeValues: { ':zero': 0 }
  })
  return items
    .filter(i => !i.repository_name.startsWith('_'))
    .map(mapRepo)
}

export async function getRepo(name: string): Promise<Repository | null> {
  const res = await docClient.send(new GetCommand({
    TableName: TABLE, Key: { repository_name: name, analysis_timestamp: 0 }
  }))
  return res.Item ? mapRepo(res.Item) : null
}

export async function putRepo(repo: Partial<Repository> & { name: string }): Promise<void> {
  await docClient.send(new PutCommand({
    TableName: TABLE,
    Item: {
      repository_name: repo.name,
      analysis_timestamp: 0,
      url: repo.url || '',
      source: repo.source || 'GitHub',
      enabled: repo.enabled !== false,
      status: repo.status || 'active',
      ...(repo.lastAnalyzed && { lastAnalyzed: repo.lastAnalyzed })
    }
  }))
}

export async function updateRepo(name: string, updates: Record<string, any>): Promise<void> {
  const expressions: string[] = []
  const names: Record<string, string> = {}
  const values: Record<string, any> = {}
  for (const [key, val] of Object.entries(updates)) {
    const attr = `#${key}`
    const valKey = `:${key}`
    expressions.push(`${attr} = ${valKey}`)
    names[attr] = key
    values[valKey] = val
  }
  if (expressions.length === 0) return
  await docClient.send(new UpdateCommand({
    TableName: TABLE,
    Key: { repository_name: name, analysis_timestamp: 0 },
    UpdateExpression: `SET ${expressions.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values
  }))
}

export async function deleteRepo(name: string): Promise<void> {
  await docClient.send(new DeleteCommand({
    TableName: TABLE, Key: { repository_name: name, analysis_timestamp: 0 }
  }))
}

function mapRepo(item: Record<string, any>): Repository {
  return {
    name: item.repository_name || '',
    url: item.url || '',
    source: item.source || 'GitHub',
    enabled: item.enabled !== false,
    status: item.status || 'active',
    lastAnalyzed: item.lastAnalyzed,
    lastCommit: item.lastCommit
  }
}

// === Wiki ===

export async function listWikiRepos(knownRepos?: string[]): Promise<WikiRepoSummary[]> {
  const items = await paginatedScan({
    TableName: TABLE,
    FilterExpression: 'begins_with(repository_name, :prefix)',
    ExpressionAttributeValues: { ':prefix': '_result_' },
    ProjectionExpression: 'repository_name, analysis_timestamp, created_at, step_name'
  })

  if (!knownRepos) {
    const repos = await listRepos()
    knownRepos = repos.map(r => r.name)
  }

  const repoMap = new Map<string, { sections: Set<string>; lastUpdated: string }>()
  for (const item of items) {
    const fullKey = item.repository_name as string
    let matched: string | null = null
    for (const name of knownRepos) {
      if (fullKey.startsWith(`_result_${name}_`)) { matched = name; break }
    }
    if (!matched) continue
    if (!repoMap.has(matched)) repoMap.set(matched, { sections: new Set(), lastUpdated: '' })
    const entry = repoMap.get(matched)!
    entry.sections.add(item.step_name || '')
    const createdAt = item.created_at as string || ''
    if (createdAt > entry.lastUpdated) entry.lastUpdated = createdAt
  }

  const HIGHLIGHT_SECTIONS = ['hl_overview', 'security_check', 'DBs', 'APIs', 'deployment', 'dependencies']
  return Array.from(repoMap.entries())
    .map(([name, data]) => ({
      name,
      sectionCount: data.sections.size,
      lastUpdated: data.lastUpdated,
      highlights: HIGHLIGHT_SECTIONS.filter(s => data.sections.has(s))
        .map(s => s.replace('hl_', '').replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase()))
        .slice(0, 4)
    }))
    .sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated))
}

const SECTION_LABELS: Record<string, string> = {
  hl_overview: 'Overview', core_entities: 'Core Entities', APIs: 'APIs',
  api_surface: 'API Surface', internals: 'Internals', module_deep_dive: 'Module Deep Dive',
  data_mapping: 'Data Mapping', DBs: 'Databases', authentication: 'Authentication',
  authorization: 'Authorization', security_check: 'Security',
  prompt_security_check: 'Prompt Security', dependencies: 'Dependencies',
  service_dependencies: 'Service Dependencies', deployment: 'Deployment',
  monitoring: 'Monitoring', events: 'Events', feature_flags: 'Feature Flags',
  ml_services: 'ML Services'
}

export async function listWikiSections(repo: string): Promise<WikiSection[]> {
  const items = await paginatedScan({
    TableName: TABLE,
    FilterExpression: 'begins_with(repository_name, :prefix)',
    ExpressionAttributeValues: { ':prefix': `_result_${repo}_` },
    ProjectionExpression: 'repository_name, analysis_timestamp, step_name, created_at'
  })
  return items.map(i => {
    const stepName = i.step_name || ''
    return {
      id: stepName,
      stepName,
      label: SECTION_LABELS[stepName] || stepName.replace(/_/g, ' '),
      createdAt: i.created_at || '',
      hasContent: true
    }
  })
}

export async function getWikiSection(repo: string, section: string): Promise<string | null> {
  const items = await paginatedScan({
    TableName: TABLE,
    FilterExpression: 'begins_with(repository_name, :prefix) AND step_name = :step',
    ExpressionAttributeValues: { ':prefix': `_result_${repo}_`, ':step': section }
  })
  if (items.length === 0) return null
  const sorted = items.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
  return sorted[0].result_content || null
}

// === Prompts ===

export async function listPrompts(type?: string): Promise<Prompt[]> {
  const items = await paginatedScan({
    TableName: TABLE,
    FilterExpression: 'begins_with(repository_name, :prefix) AND analysis_timestamp = :zero',
    ExpressionAttributeValues: { ':prefix': '_prompt_', ':zero': 0 }
  })
  let prompts = items
    .filter(i => !i.repository_name.startsWith('_prompt_type_'))
    .map(mapPrompt)
  if (type) {
    prompts = prompts.filter(p => p.type === 'shared' || p.type === type)
  }
  return prompts.sort((a, b) => a.order - b.order)
}

export async function getPrompt(name: string): Promise<Prompt | null> {
  const res = await docClient.send(new GetCommand({
    TableName: TABLE, Key: { repository_name: `_prompt_${name}`, analysis_timestamp: 0 }
  }))
  return res.Item ? mapPrompt(res.Item) : null
}

export async function putPrompt(prompt: Partial<Prompt> & { name: string }): Promise<void> {
  const now = new Date().toISOString()
  await docClient.send(new PutCommand({
    TableName: TABLE,
    Item: {
      repository_name: `_prompt_${prompt.name}`,
      analysis_timestamp: 0,
      content: prompt.content || '',
      description: prompt.description || '',
      display_name: prompt.displayName || prompt.name,
      order_num: prompt.order ?? 999,
      enabled: prompt.enabled !== false,
      prompt_type: prompt.type || 'shared',
      context: prompt.context ? JSON.stringify(prompt.context) : undefined,
      version: prompt.version || 1,
      created_at: prompt.createdAt || now,
      updated_at: now,
      created_by: prompt.createdBy || 'api'
    }
  }))
}

export async function deletePrompt(name: string): Promise<void> {
  await docClient.send(new DeleteCommand({
    TableName: TABLE, Key: { repository_name: `_prompt_${name}`, analysis_timestamp: 0 }
  }))
}

export async function listPromptVersions(name: string): Promise<PromptVersion[]> {
  const res = await docClient.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'repository_name = :pk AND analysis_timestamp > :zero',
    ExpressionAttributeValues: { ':pk': `_prompt_${name}`, ':zero': 0 },
    ScanIndexForward: false
  }))
  return (res.Items || []).map(i => ({
    name,
    version: i.analysis_timestamp as number,
    content: i.content || '',
    message: i.message,
    createdBy: i.created_by || '',
    createdAt: i.created_at || ''
  }))
}

export async function getPromptVersion(name: string, version: number): Promise<PromptVersion | null> {
  const res = await docClient.send(new GetCommand({
    TableName: TABLE, Key: { repository_name: `_prompt_${name}`, analysis_timestamp: version }
  }))
  if (!res.Item) return null
  return {
    name, version,
    content: res.Item.content || '',
    message: res.Item.message,
    createdBy: res.Item.created_by || '',
    createdAt: res.Item.created_at || ''
  }
}

export async function putPromptVersion(name: string, version: number, content: string, message?: string, createdBy?: string): Promise<void> {
  await docClient.send(new PutCommand({
    TableName: TABLE,
    Item: {
      repository_name: `_prompt_${name}`,
      analysis_timestamp: version,
      content,
      message: message || '',
      created_by: createdBy || 'api',
      created_at: new Date().toISOString()
    }
  }))
}

function mapPrompt(item: Record<string, any>): Prompt {
  const name = (item.repository_name as string).replace('_prompt_', '')
  let context: any[] | undefined
  try { context = item.context ? JSON.parse(item.context) : undefined } catch { context = undefined }
  return {
    name,
    displayName: item.display_name || name,
    description: item.description || '',
    content: item.content || '',
    order: item.order_num ?? 999,
    enabled: item.enabled !== false,
    type: item.prompt_type || 'shared',
    context,
    version: item.version || 1,
    createdAt: item.created_at || '',
    updatedAt: item.updated_at || '',
    createdBy: item.created_by
  }
}

// === Prompt Types ===

export async function listPromptTypes(): Promise<any[]> {
  const items = await paginatedScan({
    TableName: TABLE,
    FilterExpression: 'begins_with(repository_name, :prefix) AND analysis_timestamp = :zero',
    ExpressionAttributeValues: { ':prefix': '_prompt_type_', ':zero': 0 }
  })
  return items.map(i => ({
    type: (i.repository_name as string).replace('_prompt_type_', ''),
    description: i.description || '',
    additionalPrompts: i.additional_prompts ? JSON.parse(i.additional_prompts) : [],
    detectionPatterns: i.detection_patterns ? JSON.parse(i.detection_patterns) : {}
  }))
}

export async function getPromptType(type: string): Promise<any> {
  const res = await docClient.send(new GetCommand({
    TableName: TABLE, Key: { repository_name: `_prompt_type_${type}`, analysis_timestamp: 0 }
  }))
  if (!res.Item) return null
  return {
    type,
    description: res.Item.description || '',
    additionalPrompts: res.Item.additional_prompts ? JSON.parse(res.Item.additional_prompts) : [],
    detectionPatterns: res.Item.detection_patterns ? JSON.parse(res.Item.detection_patterns) : {}
  }
}

// === Config ===

export async function getConfig(): Promise<RepoSwarmConfig> {
  const res = await docClient.send(new GetCommand({
    TableName: TABLE, Key: { repository_name: '_config', analysis_timestamp: 0 }
  }))
  if (!res.Item) {
    return {
      defaultModel: 'us.anthropic.claude-sonnet-4-6',
      chunkSize: 10, sleepDuration: 2000, parallelLimit: 3, tokenLimit: 200000,
      scheduleExpression: 'rate(6 hours)'
    }
  }
  return res.Item as unknown as RepoSwarmConfig
}

export async function putConfig(cfg: Partial<RepoSwarmConfig>): Promise<void> {
  const current = await getConfig()
  await docClient.send(new PutCommand({
    TableName: TABLE,
    Item: { repository_name: '_config', analysis_timestamp: 0, ...current, ...cfg }
  }))
}

// === Table Bootstrap (for DynamoDB Local) ===
export async function ensureTable(): Promise<void> {
  if (!config.dynamoEndpoint) return // Only for local DynamoDB
  try {
    await client.send(new DescribeTableCommand({ TableName: TABLE }))
    logger.info({ table: TABLE }, 'DynamoDB Local table exists')
  } catch (e: any) {
    if (e.name === 'ResourceNotFoundException') {
      logger.info({ table: TABLE }, 'Creating DynamoDB Local table...')
      await client.send(new CreateTableCommand({
        TableName: TABLE,
        KeySchema: [
          { AttributeName: 'repository_name', KeyType: 'HASH' },
          { AttributeName: 'analysis_timestamp', KeyType: 'RANGE' },
        ],
        AttributeDefinitions: [
          { AttributeName: 'repository_name', AttributeType: 'S' },
          { AttributeName: 'analysis_timestamp', AttributeType: 'N' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }))
      logger.info({ table: TABLE }, 'DynamoDB Local table created')
    } else {
      throw e
    }
  }
}

// === Health ===
export async function healthCheck(): Promise<boolean> {
  try {
    await docClient.send(new ScanCommand({ TableName: TABLE, Limit: 1 }))
    return true
  } catch (e) {
    logger.error({ err: e }, 'DynamoDB health check failed')
    return false
  }
}

// === API Tokens ===

export interface ApiToken {
  id: string
  prefix: string
  tokenHash: string
  label: string
  createdAt: string
  createdBy: string
}

export async function createApiToken(token: ApiToken): Promise<void> {
  await docClient.send(new PutCommand({
    TableName: TABLE,
    Item: {
      repository_name: `_api_token_${token.id}`,
      analysis_timestamp: 0,
      token_id: token.id,
      token_prefix: token.prefix,
      token_hash: token.tokenHash,
      token_label: token.label,
      created_at: token.createdAt,
      created_by: token.createdBy
    }
  }))
}

export async function listApiTokens(): Promise<Omit<ApiToken, 'tokenHash'>[]> {
  const items = await paginatedScan({
    TableName: TABLE,
    FilterExpression: 'begins_with(repository_name, :prefix)',
    ExpressionAttributeValues: { ':prefix': '_api_token_' }
  })
  return items.map(i => ({
    id: i.token_id || '',
    prefix: i.token_prefix || '',
    label: i.token_label || '',
    createdAt: i.created_at || '',
    createdBy: i.created_by || ''
  }))
}

export async function getApiTokenByHash(hash: string): Promise<ApiToken | null> {
  const items = await paginatedScan({
    TableName: TABLE,
    FilterExpression: 'begins_with(repository_name, :prefix) AND token_hash = :hash',
    ExpressionAttributeValues: { ':prefix': '_api_token_', ':hash': hash }
  })
  if (items.length === 0) return null
  const i = items[0]
  return {
    id: i.token_id, prefix: i.token_prefix, tokenHash: i.token_hash,
    label: i.token_label, createdAt: i.created_at, createdBy: i.created_by
  }
}

export async function deleteApiToken(id: string): Promise<void> {
  await docClient.send(new DeleteCommand({
    TableName: TABLE,
    Key: { repository_name: `_api_token_${id}`, analysis_timestamp: 0 }
  }))
}
