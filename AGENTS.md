# RepoSwarm API Server

## What To Build

A standalone REST API server for RepoSwarm — the backend that the UI, CLI, and agents all talk to.

**Stack:** TypeScript, Express 5, Vitest for tests, ESLint 9 flat config
**Runtime:** Node.js 24+
**Auth:** Dual auth — Cognito JWT validation (for UI) + Bearer token (for CLI/M2M)
**Deploy target:** ECS Fargate (ARM64), Docker

## Architecture

```
src/
├── index.ts                 # Entry point, Express app setup
├── app.ts                   # Express app factory (for testing)
├── config.ts                # Environment config
├── middleware/
│   ├── auth.ts              # Dual auth (Cognito JWT + Bearer token)
│   ├── error-handler.ts     # Global error handler
│   └── logger.ts            # Request logging (pino-http)
├── routes/
│   ├── health.ts            # GET /health (no auth)
│   ├── repos.ts             # CRUD /repos + POST /repos/discover
│   ├── workflows.ts         # /workflows (list, get, history, terminate)
│   ├── investigate.ts       # POST /investigate/single + /investigate/daily
│   ├── wiki.ts              # /wiki (list repos, sections, content)
│   ├── prompts.ts           # /prompts full CRUD + versioning + ordering + types
│   └── config.ts            # GET/PUT /config
├── services/
│   ├── dynamodb.ts          # DynamoDB operations (repos, results, prompts, config)
│   ├── temporal.ts          # Temporal client (HTTP reads + gRPC writes)
│   └── codecommit.ts        # CodeCommit discovery (BatchGetRepositories)
├── types/
│   └── index.ts             # All TypeScript interfaces
└── utils/
    └── helpers.ts           # Shared utilities
```

## Environment Variables

```
PORT=3000
AWS_REGION=us-east-1
DYNAMODB_TABLE=reposwarm-cache
TEMPORAL_SERVER_URL=reposwarm-temporal-nlb-11f3aaedbbea9cf1.elb.us-east-1.amazonaws.com:7233
TEMPORAL_HTTP_URL=http://reposwarm-temporal-nlb-11f3aaedbbea9cf1.elb.us-east-1.amazonaws.com:8233
TEMPORAL_NAMESPACE=default
TEMPORAL_TASK_QUEUE=investigate-task-queue
COGNITO_USER_POOL_ID=us-east-1_XgaUUc0TG
COGNITO_REGION=us-east-1
API_BEARER_TOKEN=<from Secrets Manager>
LOG_LEVEL=info
```

## Dual Authentication Middleware

Accept EITHER of these in the `Authorization` header:

1. **Cognito JWT** — validate against JWKS for pool `us-east-1_XgaUUc0TG` using `aws-jwt-verify`
2. **Static Bearer Token** — compare against `API_BEARER_TOKEN` env var (for CLI/M2M)

**Logic flow:**
```
Extract token from "Authorization: Bearer <token>"
→ Try Cognito JWT validation (aws-jwt-verify)
→ If valid JWT → authenticated (set req.user with JWT claims)
→ If not valid JWT → compare against API_BEARER_TOKEN
→ If matches → authenticated (set req.user = { sub: "api-token", type: "m2m" })
→ If neither → 401 Unauthorized
```

`GET /health` is the ONLY unauthenticated endpoint.

## API Endpoints

### Health (no auth)
`GET /health` → `{ status, temporal: { connected }, dynamodb: { connected }, version }`

### Repos
- `GET /repos` — List all repos. DynamoDB scan where `analysis_timestamp=0`. **MUST paginate** (ExclusiveStartKey loop — table has 174+ items, 1MB scan limit).
- `POST /repos` — Add repo `{ name, url, source?, enabled? }`
- `GET /repos/:name` — Get single repo (DynamoDB GetItem)
- `PUT /repos/:name` — Update repo fields
- `DELETE /repos/:name` — Delete repo
- `POST /repos/discover` — Auto-discover CodeCommit repos using `BatchGetRepositories` (batches of 25)

### Workflows
- `GET /workflows?limit=50` — List from Temporal UI HTTP API (port 8233): `GET /api/v1/namespaces/default/workflows`
- `GET /workflows/:id` — Get workflow detail from Temporal UI
- `GET /workflows/:id/history` — Get event history from Temporal UI
- `POST /workflows/:id/terminate` — Terminate via `@temporalio/client` gRPC (port 7233). Body: `{ reason? }`

### Investigate
- `POST /investigate/single` — `{ repo_name, repo_url?, model?, chunk_size? }`. Lookup repo_url from DynamoDB if not provided. Start `InvestigateSingleRepoWorkflow` via gRPC. **Use snake_case fields** (Pydantic worker).
- `POST /investigate/daily` — Start `InvestigateDailyWorkflow` via gRPC

### Wiki
- `GET /wiki` — Aggregate `_result_*` entries, group by repo, return `[{ name, sectionCount, lastUpdated, highlights }]` sorted by lastUpdated desc. **MUST paginate scans.**
- `GET /wiki/:repo` — List sections for a repo (scan `_result_{repo}_*` entries)
- `GET /wiki/:repo/:section` — Get section markdown content

### Prompts
- `GET /prompts?type=<type>` — List prompts in execution order (base + type-specific if type given)
- `POST /prompts` — Create prompt `{ name, content, description, order?, type?, context? }`. Stores as `_prompt_{name}` with SK=0. Creates version 1.
- `GET /prompts/:name` — Get prompt with content + context deps + current version
- `PUT /prompts/:name` — Update content `{ content, message? }`. Creates new version (SK=version_number).
- `DELETE /prompts/:name` — Delete prompt entry
- `PUT /prompts/:name/order` — `{ position: number }`
- `PUT /prompts/:name/toggle` — `{ enabled: boolean }`
- `PUT /prompts/:name/context` — `{ context: [{ type: "step", val: "step_name" }] }`
- `GET /prompts/:name/versions` — List all versions (query SK > 0, sorted desc)
- `GET /prompts/:name/versions/:version` — Get specific version
- `POST /prompts/:name/rollback` — `{ toVersion: number }`. Copies old version content as new version.
- `GET /prompts/types` — List repo types
- `GET /prompts/types/:type` — Get type config (detection patterns + additional prompts)
- `POST /prompts/export` — Returns full JSON export of all prompts + types
- `POST /prompts/import` — Import from JSON

### Config
- `GET /config` — Current config
- `PUT /config` — Update config fields

## DynamoDB Schema (table: reposwarm-cache)

Keys: `repository_name` (S, HASH) + `analysis_timestamp` (N, RANGE)

| Item | PK | SK | Fields |
|------|----|----|--------|
| Repo | `{name}` | `0` | url, source, enabled, status, lastAnalyzed |
| Result | `_result_{repo}_{step}_{commit}_{ver}` | `{ts}` | step_name, result_content, created_at |
| Prompt | `_prompt_{name}` | `0` | content, order, description, type, context, version, enabled |
| Prompt Version | `_prompt_{name}` | `{ver}` | content, message, createdBy, createdAt |
| Prompt Type | `_prompt_type_{type}` | `0` | extends, additional_prompts, detection_patterns |

## Tests (Vitest + supertest)

Every route needs:
- Happy path
- Auth rejection (no token → 401)
- Auth with Cognito JWT (mock aws-jwt-verify)
- Auth with bearer token
- Validation errors (400)
- Service errors (500)
- For prompts: ordering, versioning, rollback, context dependencies

Mock all AWS SDK calls and Temporal client. Use supertest for HTTP assertions.

**Target: 100+ tests minimum.**

## Docker & Build

Dockerfile: multi-stage, node:24-alpine, non-root user, HEALTHCHECK.

buildspec.yml for CodeBuild:
```yaml
version: 0.2
env:
  variables:
    ECR_REPO: 194908539076.dkr.ecr.us-east-1.amazonaws.com/reposwarm-api
phases:
  install:
    runtime-versions:
      nodejs: 24
  pre_build:
    commands:
      - cd $CODEBUILD_SRC_DIR
      - npm ci
      - npm run lint
      - npm test
      - aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin $ECR_REPO
  build:
    commands:
      - cd $CODEBUILD_SRC_DIR
      - docker build -t $ECR_REPO:$CODEBUILD_RESOLVED_SOURCE_VERSION -t $ECR_REPO:latest .
      - docker push $ECR_REPO:$CODEBUILD_RESOLVED_SOURCE_VERSION
      - docker push $ECR_REPO:latest
  post_build:
    commands:
      - cd $CODEBUILD_SRC_DIR
      - printf '{"ImageURI":"%s"}' $ECR_REPO:$CODEBUILD_RESOLVED_SOURCE_VERSION > imageDetail.json
artifacts:
  files:
    - imageDetail.json
```

## RULES
- Express 5 (not 4)
- ESLint 9 flat config
- All handlers async with try/catch + next(error)
- Response: `{ data }` success, `{ error, details? }` failure
- pino for structured JSON logging
- pino-http for request logging
- Health must be <100ms and unauthenticated
- ALL DynamoDB scans MUST paginate
- Temporal: HTTP GET for reads, gRPC SDK for writes
- Snake_case for Temporal workflow inputs
- No hardcoded secrets
- node:24-alpine Docker, non-root
