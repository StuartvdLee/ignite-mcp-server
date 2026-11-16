// Microsoft Ignite 2026 MCP server on Azure Container Apps.
//
// Creates a container registry, a Log Analytics workspace, a Container Apps environment with only the Consumption
// workload profile (billed per second for the CPU and memory that replicas use, no dedicated hardware) and, once
// `image` is set, the app itself.
//
// It is deployed twice, which is what infra/deploy.sh does: first without `image`, to create the registry, and then
// with the image that was built into that registry. Settings are read from environment variables by main.bicepparam.

targetScope = 'resourceGroup'

@description('Name of the container app, and the prefix of the other resources. Lowercase letters, digits and hyphens.')
@minLength(2)
@maxLength(24)
param appName string = 'ignite-mcp'

@description('Azure region.')
param location string = resourceGroup().location

@description('Image to run, for example myregistry.azurecr.io/ignite-mcp:1.0.0. Leave empty to create only the registry and the environment.')
param image string = ''

@description('Replicas that always run. 1 keeps the server warm. 0 lets it scale to zero when idle: no compute cost, but the first request after a pause waits for a cold start.')
@minValue(0)
@maxValue(10)
param minReplicas int = 1

@description('Most replicas that traffic can scale out to.')
@minValue(1)
@maxValue(10)
param maxReplicas int = 3

@description('vCPU per replica; the memory follows (0.25 gets 0.5 GiB). 0.25 vCPU is the smallest size that Container Apps offers.')
@allowed([
  '0.25'
  '0.5'
  '1'
  '2'
])
param cpu string = '0.25'

@description('Optional. When set, clients must send "Authorization: Bearer <key>" to /mcp. Use a long random value.')
@secure()
param mcpApiKey string = ''

@description('Optional. Comma separated origins (https://host) of browser apps that may call the server.')
param allowedOrigins string = ''

@description('Optional. Comma separated extra Host names the server answers to, for example a custom domain.')
param allowedHosts string = ''

@description('Optional. Address that clients use, for example https://ignite.example.com. Only needed behind a custom domain; the default address is detected.')
param publicBaseUrl string = ''

@description('Optional. Where the session catalog is downloaded from. Empty uses the official Ignite 2026 feed.')
param dataUrl string = ''

@allowed([
  'debug'
  'info'
  'warn'
  'error'
])
param logLevel string = 'info'

var port = 8080
var registryName = 'acr${replace(appName, '-', '')}${uniqueString(resourceGroup().id)}'
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var memoryForCpu = {
  '0.25': '0.5Gi'
  '0.5': '1Gi'
  '1': '2Gi'
  '2': '4Gi'
}

var env = flatten([
  [
    { name: 'PORT', value: string(port) }
    { name: 'LOG_LEVEL', value: logLevel }
  ]
  empty(mcpApiKey) ? [] : [{ name: 'MCP_API_KEY', secretRef: 'mcp-api-key' }]
  empty(allowedOrigins) ? [] : [{ name: 'ALLOWED_ORIGINS', value: allowedOrigins }]
  empty(allowedHosts) ? [] : [{ name: 'ALLOWED_HOSTS', value: allowedHosts }]
  empty(publicBaseUrl) ? [] : [{ name: 'PUBLIC_BASE_URL', value: publicBaseUrl }]
  empty(dataUrl) ? [] : [{ name: 'IGNITE_DATA_URL', value: dataUrl }]
])

// The app pulls its image with this identity, so that the registry needs no admin user or stored password.
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${appName}-id'
  location: location
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
  }
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, identity.id, acrPullRoleId)
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
  }
}

// The daily cap keeps log ingestion inside the free allowance (5 GB a month); logs stop for the rest of the day when it is hit.
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${appName}-logs'
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
    workspaceCapping: {
      dailyQuotaGb: json('0.1')
    }
  }
}

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: '${appName}-env'
  location: location
  properties: {
    // The older 'log-analytics' destination uses the HTTP Data Collector API, which Azure is retiring; 'azure-monitor'
    // sends the logs wherever a diagnostic setting says, as the resource of the next block does.
    appLogsConfiguration: {
      destination: 'azure-monitor'
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    zoneRedundant: false
  }
}

// Console output (the JSON log lines of the server) and platform events end up in ContainerAppConsoleLogs and
// ContainerAppSystemLogs. A new setting can take a while (Azure says up to 90 minutes) before data starts to flow.
resource environmentLogs 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-log-analytics'
  scope: environment
  properties: {
    workspaceId: logs.id
    logs: [
      {
        category: 'ContainerAppConsoleLogs'
        enabled: true
      }
      {
        category: 'ContainerAppSystemLogs'
        enabled: true
      }
    ]
  }
}

resource app 'Microsoft.App/containerApps@2025-01-01' = if (!empty(image)) {
  name: appName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      maxInactiveRevisions: 3
      ingress: {
        external: true
        targetPort: port
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: identity.id
        }
      ]
      secrets: empty(mcpApiKey) ? [] : [
        {
          name: 'mcp-api-key'
          value: mcpApiKey
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'ignite-mcp'
          image: image
          resources: {
            cpu: json(cpu)
            memory: memoryForCpu[cpu]
          }
          env: env
          // /healthz answers 503 until the catalog is loaded and never depends on the live feed being reachable. The
          // liveness and readiness checks are lenient on purpose: a replica that is busy must not be restarted or
          // taken out of rotation, which would only pile its traffic on the others.
          probes: [
            {
              type: 'Startup'
              httpGet: {
                path: '/healthz'
                port: port
              }
              initialDelaySeconds: 1
              periodSeconds: 5
              timeoutSeconds: 3
              failureThreshold: 10
            }
            {
              type: 'Liveness'
              httpGet: {
                path: '/healthz'
                port: port
              }
              periodSeconds: 20
              timeoutSeconds: 5
              failureThreshold: 5
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/healthz'
                port: port
              }
              periodSeconds: 10
              timeoutSeconds: 5
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [
          {
            // One small replica does a few dozen requests a second; scale out well before it is saturated.
            name: 'http'
            http: {
              metadata: {
                concurrentRequests: '20'
              }
            }
          }
        ]
      }
    }
  }
  dependsOn: [
    acrPull
  ]
}

output registryName string = registry.name
output registryLoginServer string = registry.properties.loginServer
output mcpUrl string = empty(image) ? '' : 'https://${appName}.${environment.properties.defaultDomain}/mcp'
