#!/usr/bin/env bash
# Builds the server image in Azure Container Registry and deploys it to Azure Container Apps.
#
#   infra/deploy.sh <resource-group> [location]
#
# The location is only needed when the resource group does not exist yet. Settings come from environment variables
# (see infra/main.bicepparam), for example:
#
#   MIN_REPLICAS=0 infra/deploy.sh ignite-rg westeurope
#   MCP_API_KEY="$(openssl rand -hex 32)" infra/deploy.sh ignite-rg
#
# Needs the Azure CLI, signed in with `az login`. The template gives the app's identity permission to pull from the
# registry, so the signed in account needs Owner on the resource group (or Contributor plus User Access Administrator).
set -euo pipefail

cd "$(dirname "$0")/.."

RESOURCE_GROUP="${1:-}"
LOCATION="${2:-}"
APP_NAME="${APP_NAME:-ignite-mcp}"

if [ -z "$RESOURCE_GROUP" ]; then
  echo "Usage: infra/deploy.sh <resource-group> [location]" >&2
  exit 2
fi
if ! command -v az >/dev/null 2>&1; then
  echo "The Azure CLI is required: https://aka.ms/installazurecli" >&2
  exit 1
fi

if [ "$(az group exists --name "$RESOURCE_GROUP")" != "true" ]; then
  if [ -z "$LOCATION" ]; then
    echo "Resource group '$RESOURCE_GROUP' does not exist. Pass a location to create it, for example: infra/deploy.sh $RESOURCE_GROUP westeurope" >&2
    exit 2
  fi
  echo "==> Creating resource group $RESOURCE_GROUP in $LOCATION"
  az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none
fi

# Without an image only the registry and the environment are created; the app needs an image to start.
echo "==> Creating the container registry and the Container Apps environment"
REGISTRY="$(IMAGE='' az deployment group create \
  --resource-group "$RESOURCE_GROUP" \
  --name ignite-mcp-infra \
  --parameters infra/main.bicepparam \
  --query properties.outputs.registryName.value \
  --output tsv)"
LOGIN_SERVER="$(az acr show --name "$REGISTRY" --query loginServer --output tsv)"

# A new tag for every build: the app only gets a new revision when its image reference changes.
TAG="$(date -u +%Y%m%d%H%M%S)-$(git rev-parse --short=7 HEAD 2>/dev/null || echo local)"
IMAGE="$LOGIN_SERVER/ignite-mcp:$TAG"

echo "==> Building $IMAGE"
if ! az acr build --registry "$REGISTRY" --image "ignite-mcp:$TAG" --platform linux/amd64 .; then
  echo "az acr build failed (ACR Tasks is not available for every subscription type); trying a local Docker build instead." >&2
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is not installed, so there is no fallback." >&2
    exit 1
  fi
  az acr login --name "$REGISTRY"
  docker build --platform linux/amd64 --tag "$IMAGE" .
  docker push "$IMAGE"
fi

echo "==> Deploying the app"
MCP_URL="$(IMAGE="$IMAGE" az deployment group create \
  --resource-group "$RESOURCE_GROUP" \
  --name ignite-mcp-app \
  --parameters infra/main.bicepparam \
  --query properties.outputs.mcpUrl.value \
  --output tsv)"

HEALTH_URL="${MCP_URL%/mcp}/healthz"
echo "==> Waiting for $HEALTH_URL"
for _ in $(seq 1 30); do
  if HEALTH="$(curl -fsS --max-time 10 "$HEALTH_URL" 2>/dev/null)"; then
    echo "$HEALTH"
    echo
    echo "MCP endpoint: $MCP_URL"
    exit 0
  fi
  sleep 5
done

echo "The app did not become healthy within 2.5 minutes. Look at its logs:" >&2
echo "  az containerapp logs show --name $APP_NAME --resource-group $RESOURCE_GROUP --type system" >&2
echo "  az containerapp logs show --name $APP_NAME --resource-group $RESOURCE_GROUP --follow" >&2
exit 1
