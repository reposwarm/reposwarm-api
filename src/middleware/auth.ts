import { Request, Response, NextFunction } from 'express'
import { CognitoJwtVerifier } from 'aws-jwt-verify'
import { config } from '../config.js'
import { logger } from './logger.js'

let cognitoVerifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null

function getVerifier() {
  if (!cognitoVerifier) {
    cognitoVerifier = CognitoJwtVerifier.create({
      userPoolId: config.cognitoUserPoolId,
      tokenUse: 'id',
      clientId: config.cognitoClientId || null as any
    })
  }
  return cognitoVerifier
}

function getBearerToken(): string {
  return process.env.API_BEARER_TOKEN || config.apiBearerToken || ''
}

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {}
  for (const part of cookieHeader.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k) cookies[k] = v.join('=')
  }
  return cookies
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  let token: string | null = null

  // 1. Check Authorization header
  const authHeader = req.headers.authorization
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7) || null
  }

  // 2. Fallback: check HttpOnly cookie from Lambda@Edge auth
  if (!token && req.headers.cookie) {
    const cookies = parseCookies(req.headers.cookie)
    const cookieName = process.env.AUTH_COOKIE_NAME || 'reposwarm-ui-auth'
    token = cookies[cookieName] || null
  }

  if (!token) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' })
    return
  }

  // Try Cognito JWT first
  try {
    const payload = await getVerifier().verify(token)
    req.user = {
      sub: payload.sub,
      email: payload.email as string | undefined,
      type: 'cognito'
    }
    return next()
  } catch (err) {
    logger.debug({ err: String(err) }, 'Cognito JWT verification failed')
  }

  // Try static bearer token
  const bearerToken = getBearerToken()
  if (bearerToken && token === bearerToken) {
    req.user = { sub: 'api-token', type: 'm2m' }
    return next()
  }

  logger.warn('Authentication failed: invalid token')
  res.status(401).json({ error: 'Invalid or expired token' })
}

export function resetVerifier() {
  cognitoVerifier = null
}
