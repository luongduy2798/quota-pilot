.PHONY: setup run upgrade logs

setup:
	docker run --rm -it --user "$$(id -u):$$(id -g)" \
		--mount "type=bind,source=$(CURDIR),target=/app" --workdir /app \
		-e APP_ORIGIN=https://quota.chillix.me \
		-e COMPOSE_PROFILES=tunnel \
		node:24.16-bookworm-slim node scripts/setup.mjs

run:
	docker compose --profile tunnel up --build --wait --wait-timeout 90

upgrade:
	git pull --ff-only
	$(MAKE) run

logs:
	docker compose --profile tunnel logs -f --tail=100
