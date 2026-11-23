#!/bin/sh
# Run after CI's ECR login, if available. No AWS credentials are required for
# the public fallback. Dockerfiles cannot conditionally fall back from FROM.
set -eu

REPOSITORY_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PRIVATE_IMAGE=831059512818.dkr.ecr.ap-south-1.amazonaws.com/wolfi:20261023
PUBLIC_IMAGE=cgr.dev/chainguard/wolfi-base:latest

if docker pull --platform=linux/amd64 "$PRIVATE_IMAGE"; then
    BASE_IMAGE=$PRIVATE_IMAGE
else
    printf '%s\n' 'Internal Wolfi image unavailable; falling back to public Wolfi.' >&2
    BASE_IMAGE=$PUBLIC_IMAGE
fi

printf 'Building backend with Wolfi base: %s\n' "$BASE_IMAGE"
exec docker build \
    --file "$REPOSITORY_ROOT/Dockerfile" \
    --build-arg "BASE_IMAGE=$BASE_IMAGE" \
    "$@" \
    "$REPOSITORY_ROOT"
