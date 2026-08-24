# syntax=docker/dockerfile:1
#
# ArcaneLayer deploy image: dittofeed-lite v0.23.0 plus the Resend tag
# encoding fix (upstream issue #1849, PR branch fix/resend-tag-encoding).
#
# The published dittofeed-lite image ships unminified per-file tsc output, and
# this tree reproduces that output byte for byte: at the v0.23.0 tag, every
# compiled file under packages/backend-lib/dist/src is identical to the
# published image's copy. So instead of rebuilding the whole monorepo -- which
# means the Next.js dashboard, two architectures and a ~20 minute CI job for a
# two-file change -- this recompiles backend-lib and lays the patched modules
# over the release image.
#
# That shortcut is only sound while the reproducibility holds, so the runner
# stage checks it rather than assuming it: untouched modules compiled here must
# match the base image bit for bit, and the two patched modules must not. If
# either check fails the build stops instead of shipping a subtly different
# backend-lib.
#
#   docker build -f deploy/overlay-lite.Dockerfile -t ghcr.io/queso/dittofeed-lite:v0.23.0-resend-tags .

ARG BASE_IMAGE=dittofeed/dittofeed-lite:v0.23.0

FROM node:20.19.5-bullseye AS builder

WORKDIR /service

COPY *.json yarn.lock .yarnrc.yml ./
COPY .yarn .yarn
COPY ./packages/lite/*.json ./packages/lite/
COPY ./packages/api/*.json ./packages/api/
COPY ./packages/dashboard/*.json ./packages/dashboard/
COPY ./packages/worker/*.json ./packages/worker/
COPY ./packages/admin-cli/*.json ./packages/admin-cli/
COPY ./packages/backend-lib/*.json ./packages/backend-lib/
COPY ./packages/isomorphic-lib/*.json ./packages/isomorphic-lib/
COPY ./packages/emailo/*.json ./packages/emailo/

RUN yarn set version 4.1.1
RUN yarn workspaces focus api backend-lib emailo isomorphic-lib

COPY ./packages/backend-lib/ ./packages/backend-lib
COPY ./packages/isomorphic-lib/ ./packages/isomorphic-lib
COPY ./packages/emailo/ ./packages/emailo
COPY ./packages/api/ ./packages/api

# emailo before isomorphic-lib before backend-lib -- isomorphic-lib's build
# fails outright if emailo has not been built yet.
RUN yarn workspace emailo build && \
    yarn workspace isomorphic-lib build && \
    yarn workspace backend-lib build && \
    yarn workspace api build

FROM ${BASE_IMAGE} AS runner

ARG APP_VERSION=v0.23.0-resend-tags

COPY --from=builder /service/packages/backend-lib/dist/src /tmp/rebuilt
COPY --from=builder /service/packages/api/dist/src /tmp/rebuilt-api

RUN set -eu; \
    dist=/service/packages/backend-lib/dist/src; \
    apidist=/service/packages/api/dist/src; \
    for f in constants.js types.js destinations/sendgrid.js destinations/postmark.js destinations/amazonses.js; do \
      cmp -s "/tmp/rebuilt/$f" "$dist/$f" || { \
        echo "overlay aborted: rebuilt backend-lib/$f differs from the base image, so this tree no longer reproduces the release build" >&2; \
        exit 1; \
      }; \
    done; \
    for f in buildApp/router.js controllers/contentController.js controllers/settingsController.js; do \
      cmp -s "/tmp/rebuilt-api/$f" "$apidist/$f" || { \
        echo "overlay aborted: rebuilt api/$f differs from the base image, so this tree no longer reproduces the release build" >&2; \
        exit 1; \
      }; \
    done; \
    for f in messaging.js destinations/resend.js; do \
      if cmp -s "/tmp/rebuilt/$f" "$dist/$f"; then \
        echo "overlay aborted: rebuilt backend-lib/$f is identical to the base image, so the fix is not in this build" >&2; \
        exit 1; \
      fi; \
      cp "/tmp/rebuilt/$f" "$dist/$f"; \
      cp "/tmp/rebuilt/$f.map" "$dist/$f.map"; \
    done; \
    if cmp -s /tmp/rebuilt-api/controllers/webhooksController.js "$apidist/controllers/webhooksController.js"; then \
      echo "overlay aborted: rebuilt api/controllers/webhooksController.js is identical to the base image, so the fix is not in this build" >&2; \
      exit 1; \
    fi; \
    cp /tmp/rebuilt-api/controllers/webhooksController.js "$apidist/controllers/webhooksController.js"; \
    cp /tmp/rebuilt-api/controllers/webhooksController.js.map "$apidist/controllers/webhooksController.js.map"; \
    cp /tmp/rebuilt/destinations/resend.d.ts "$dist/destinations/resend.d.ts"; \
    grep -q encodeResendTags "$dist/destinations/resend.js"; \
    grep -q encodeResendTags "$dist/messaging.js"; \
    grep -q "not on this instance" "$apidist/controllers/webhooksController.js"; \
    rm -rf /tmp/rebuilt /tmp/rebuilt-api

ENV APP_VERSION=${APP_VERSION}
