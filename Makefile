.DEFAULT_GOAL := up
COMPOSE := docker compose --env-file deploy/compose.env --env-file .env

.PHONY: setup up run upgrade tunnel down restart ps logs build pull

setup:
	@if [ -e .env ] || [ -L .env ]; then printf '%s\n' '.env already exists.'; else \
		docker run --rm -it --user "$$(id -u):$$(id -g)" \
			--mount "type=bind,source=$(CURDIR),target=/app" --workdir /app \
			-e APP_ORIGIN=https://quota.chillix.me \
			-e COMPOSE_PROFILES=tunnel \
			node:24.16-bookworm-slim node scripts/setup.mjs; \
	fi
	sh scripts/start-tunnel.sh quota-pilot --setup-only

up: setup
	$(COMPOSE) up --build --wait --wait-timeout 90 quota-pilot
	@services=$$($(COMPOSE) config --services) && \
		if printf '%s\n' "$$services" | grep -Fxq cloudflared; then $(MAKE) tunnel TUNNEL_RECREATE="$(TUNNEL_RECREATE)"; fi

run: up

upgrade: TUNNEL_RECREATE := --force-recreate
upgrade: up

tunnel:
	sh scripts/start-tunnel.sh quota-pilot "$(TUNNEL_RECREATE)"

down:
	$(COMPOSE) down

restart:
	$(COMPOSE) restart

ps:
	$(COMPOSE) ps

logs:
	$(COMPOSE) logs -f

build:
	$(COMPOSE) build

pull:
	git pull --ff-only
	$(MAKE) upgrade
