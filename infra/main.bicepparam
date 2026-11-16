using './main.bicep'

// Settings come from environment variables, so that a secret never appears on a command line.
// Everything is optional; see main.bicep for what each one does.

param appName = readEnvironmentVariable('APP_NAME', 'ignite-mcp')
param image = readEnvironmentVariable('IMAGE', '')
param minReplicas = int(readEnvironmentVariable('MIN_REPLICAS', '1'))
param maxReplicas = int(readEnvironmentVariable('MAX_REPLICAS', '3'))
param cpu = readEnvironmentVariable('REPLICA_CPU', '0.25')
param mcpApiKey = readEnvironmentVariable('MCP_API_KEY', '')
param allowedOrigins = readEnvironmentVariable('ALLOWED_ORIGINS', '')
param allowedHosts = readEnvironmentVariable('ALLOWED_HOSTS', '')
param publicBaseUrl = readEnvironmentVariable('PUBLIC_BASE_URL', '')
param dataUrl = readEnvironmentVariable('IGNITE_DATA_URL', '')
param logLevel = readEnvironmentVariable('LOG_LEVEL', 'info')
