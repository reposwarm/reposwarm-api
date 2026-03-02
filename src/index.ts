import { createApp } from './app.js'
import { config } from './config.js'
import { logger } from './middleware/logger.js'
import { ensureTable } from './services/dynamodb.js'

const app = createApp()

async function start() {
  // Auto-create DynamoDB table when using DynamoDB Local
  try {
    await ensureTable()
  } catch (e) {
    logger.warn({ err: e }, 'DynamoDB table bootstrap failed (non-fatal)')
  }

  app.listen(config.port, () => {
    logger.info({ port: config.port }, 'RepoSwarm API server started')
  })
}

start()
