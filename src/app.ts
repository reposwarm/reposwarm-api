import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { httpLogger } from './middleware/logger.js'
import { errorHandler } from './middleware/error-handler.js'
import { authMiddleware } from './middleware/auth.js'
import healthRouter from './routes/health.js'
import reposRouter from './routes/repos.js'
import workflowsRouter from './routes/workflows.js'
import investigateRouter from './routes/investigate.js'
import wikiRouter from './routes/wiki.js'
import promptsRouter from './routes/prompts.js'
import configRouter from './routes/config.js'
import tokensRouter from './routes/tokens.js'
import workersRouter from './routes/workers.js'
import servicesRouter from './routes/services.js'
import askRouter from './routes/ask.js'

export function createApp() {
  const app = express()

  app.use(helmet())
  app.use(cors())
  app.use(express.json())
  app.use(httpLogger)

  // Health at root (no auth, no prefix) — for ALB health checks
  app.use(healthRouter)

  // All API routes under /v1 with auth
  const v1 = express.Router()
  v1.use(healthRouter) // health before auth
  v1.use(authMiddleware)
  v1.use(reposRouter)
  v1.use(workflowsRouter)
  v1.use(investigateRouter)
  v1.use(wikiRouter)
  v1.use(promptsRouter)
  v1.use(configRouter)
  v1.use(tokensRouter)
  v1.use(workersRouter)
  v1.use(servicesRouter)
  v1.use(askRouter)
  app.use('/v1', v1)

  // Also mount at root for backward compat
  const root = express.Router()
  root.use(authMiddleware)
  root.use(reposRouter)
  root.use(workflowsRouter)
  root.use(investigateRouter)
  root.use(wikiRouter)
  root.use(promptsRouter)
  root.use(configRouter)
  root.use(tokensRouter)
  root.use(workersRouter)
  root.use(servicesRouter)
  root.use(askRouter)
  app.use(root)
  app.use(errorHandler)

  return app
}
