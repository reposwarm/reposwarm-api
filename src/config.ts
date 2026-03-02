export const config = {
  port: parseInt(process.env.PORT || '3000'),
  region: process.env.AWS_REGION || 'us-east-1',
  dynamoTable: process.env.DYNAMODB_TABLE || 'reposwarm-cache',
  dynamoEndpoint: process.env.DYNAMODB_ENDPOINT || '',
  temporalServerUrl: process.env.TEMPORAL_SERVER_URL || 'localhost:7233',
  temporalHttpUrl: process.env.TEMPORAL_HTTP_URL || 'http://localhost:8233',
  temporalNamespace: process.env.TEMPORAL_NAMESPACE || 'default',
  temporalTaskQueue: process.env.TEMPORAL_TASK_QUEUE || 'investigate-task-queue',
  cognitoUserPoolId: process.env.COGNITO_USER_POOL_ID || '',
  cognitoRegion: process.env.COGNITO_REGION || 'us-east-1',
  cognitoClientId: process.env.COGNITO_CLIENT_ID || '',
  apiBearerToken: process.env.API_BEARER_TOKEN || '',
  logLevel: process.env.LOG_LEVEL || 'info',
  version: process.env.npm_package_version || '1.0.0'
}
